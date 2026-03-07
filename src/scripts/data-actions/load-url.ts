import { loadGeoJSON, appendFeatures, updateFeatureCount, getFeaturesAsGeoJSON, getDatasets } from '../db';
import type { LoadGeoJSONOptions as DBLoadOptions } from '../db/datasets';
import { getSourceId, updateSourceData } from '../layers';
import { attachFeatureClickHandlers, attachFeatureHoverHandlers } from '../popup';
import { showErrorDialog } from '../ui/error-dialog';
import { detectFormat, normalizeGeoJSON, tryLoadJsonArray, dispatch as loaderDispatch } from '../loaders';
import type { LoaderOptions } from '../loaders';
import { resolveSourceCrs, hasProjectedCoordinates } from '../loaders/crs';
import { fetchWithPagination } from '../loaders/paginator';
import type { PaginationOptions } from '../loaders/paginator';
import { showCrsPromptDialog } from '../ui/error-dialog';
import {
	type LoadDataOptions,
	parseDatasetStyle,
	validateUrl,
	checkQuota,
	addDatasetToMap,
	fitMapToFeatures,
} from './shared';

/**
 * Normalize a parsed JSON page into a GeoJSON FeatureCollection.
 * Tries GeoJSON normalization first, then json-array fallback.
 */
function normalizePage(data: any, loaderOptions?: LoaderOptions): GeoJSON.FeatureCollection {
	const normalized = normalizeGeoJSON(data);
	if (normalized) return normalized;

	const arrayResult = tryLoadJsonArray(data, loaderOptions);
	if (arrayResult) return arrayResult.data;

	throw new Error('Page data is not valid GeoJSON or recognizable coordinate array');
}

/**
 * Build PaginationOptions from the paginate config field.
 */
function buildPaginationOptions(paginate?: boolean | { maxPages?: number }): PaginationOptions | undefined {
	if (paginate === undefined) return undefined;
	if (paginate === false) return undefined; // caller handles disabling
	if (paginate === true) return { force: true };
	return { maxPages: paginate.maxPages };
}

/**
 * Load data from a URL into DuckDB and display on map.
 * Supports GeoJSON, CSV, GeoParquet, and JSON array formats via loader dispatch.
 * Automatically detects and handles paginated API responses (ArcGIS, OGC, Socrata).
 * Returns true on success, false on failure.
 */
export async function loadDataFromUrl(
	url: string,
	options: LoadDataOptions
): Promise<boolean> {
	const { map, logger, layerToggleControl, loadedDatasets, configOverrides, displayName, skipFitBounds, skipErrorDialog, skipLayers, hidden, latColumn, lngColumn, geoColumn, paginate, crs } = options;

	// Validate URL
	const parsedUrl = await validateUrl(url);
	if (!parsedUrl) {
		return false;
	}

	// Quota preflight - warn if OPFS storage is near capacity
	if (!await checkQuota()) {
		return false;
	}

	// Use caller-supplied label, or fall back to URL hostname
	const datasetName = displayName || parsedUrl.hostname;

	const loaderOptions: LoaderOptions = {};
	if (latColumn) loaderOptions.latColumn = latColumn;
	if (lngColumn) loaderOptions.lngColumn = lngColumn;
	if (geoColumn) loaderOptions.geoColumn = geoColumn;
	if (crs) loaderOptions.crs = crs;

	try {
		logger.info('Data', `Fetching from ${url}`);
		logger.progress(datasetName, 'loading');

		// Pagination disabled explicitly - use direct fetch path
		if (paginate === false) {
			return await loadSingleFetch(url, datasetName, loaderOptions, options);
		}

		// Fetch with pagination detection
		const paginationOpts = buildPaginationOptions(paginate);
		const paginationResult = await fetchWithPagination(url, paginationOpts);

		// Non-JSON response (parquet, etc.) - the paginator returns the raw Response
		if (!paginationResult.paginated && paginationResult.firstPage instanceof Response) {
			return await loadFromResponse(paginationResult.firstPage, url, datasetName, loaderOptions, options);
		}

		// Non-paginated JSON response - normalize and load normally
		if (!paginationResult.paginated) {
			const { extractGeoJsonCrs } = await import('../loaders/geojson');
			const nonPagDetectedCrs = extractGeoJsonCrs(paginationResult.firstPage);
			const data = normalizePage(paginationResult.firstPage, loaderOptions);
			return await loadFeatureCollection(data, url, datasetName, options, nonPagDetectedCrs);
		}

		// ── Paginated response ──────────────────────────────────────
		const { firstPage, pages, apiType } = paginationResult;
		logger.info('Data', `Paginated ${apiType} response detected`);

		// Normalize and load first page
		logger.progress(datasetName, 'loading', `Loading ${datasetName} (page 1)...`);
		const { extractGeoJsonCrs: extractCrs } = await import('../loaders/geojson');
		const pagDetectedCrs = extractCrs(firstPage);
		const pagSourceCrs = resolveSourceCrs(crs, pagDetectedCrs, options.mapCrs);
		const firstData = normalizePage(firstPage, loaderOptions);
		const firstPageCount = firstData.features.length;

		const pagDbOptions: DBLoadOptions = { ...configOverrides, sourceCrs: pagSourceCrs };
		const loaded = await loadGeoJSON(firstData, url, pagDbOptions);
		if (!loaded) {
			throw new Error('Failed to load first page into DuckDB');
		}

		// Get dataset metadata from the just-inserted first page
		const datasets = await getDatasets();
		if (!datasets || datasets.length === 0) {
			throw new Error('No datasets found after loading first page');
		}
		const dataset = datasets[0];
		const datasetId = dataset.id;
		const datasetColor = dataset.color || '#3388ff';
		const datasetStyle = parseDatasetStyle(dataset.style);

		// Render first page immediately for responsive UX (unless hidden)
		let layerIds: string[] = [];
		if (!hidden) {
			const geoJsonFromDB = await getFeaturesAsGeoJSON(datasetId);
			layerIds = addDatasetToMap(map, datasetId, datasetColor, datasetStyle, geoJsonFromDB, skipLayers);
			loadedDatasets.add(datasetId);

			if (layerIds.length > 0) {
				const hoverPopup = attachFeatureHoverHandlers(map, layerIds, { label: datasetName });
				attachFeatureClickHandlers(map, layerIds, hoverPopup);
			}

			if (!skipFitBounds) {
				fitMapToFeatures(map, geoJsonFromDB);
			}

			layerToggleControl.refreshPanel();
		} else {
			loadedDatasets.add(datasetId);
		}

		// Fetch and append subsequent pages
		let totalFeatures = firstPageCount;
		let pageNum = 2;

		if (pages) {
			for await (const pageData of pages) {
				logger.progress(datasetName, 'loading', `Loading ${datasetName} (page ${pageNum}, ${totalFeatures} features)...`);

				const pageFeatures = normalizePage(pageData, loaderOptions);
				const appendedCount = await appendFeatures(datasetId, pageFeatures, url, pagSourceCrs);
				totalFeatures += appendedCount;
				pageNum++;
			}
		}

		// Update final feature count in metadata
		const finalCount = await updateFeatureCount(datasetId);
		logger.info('Data', `Pagination complete: ${finalCount} total features across ${pageNum - 1} pages`);

		// Re-query full dataset and update MapLibre source with all features
		if (!hidden) {
			const fullGeoJson = await getFeaturesAsGeoJSON(datasetId);
			const sourceId = getSourceId(datasetId);
			updateSourceData(map, sourceId, fullGeoJson);

			if (!skipFitBounds) {
				fitMapToFeatures(map, fullGeoJson);
			}
		}

		logger.progress(datasetName, 'success', `Loaded ${finalCount} features (${pageNum - 1} pages)`);
		if (!skipFitBounds) {
			logger.scheduleIdle(3000);
		}

		return true;

	} catch (error) {
		const isCORS = error instanceof TypeError && !navigator.onLine === false;
		const errorMsg = isCORS
			? 'This server does not allow cross-origin requests from the browser. Download the file and use the upload button to load it locally.'
			: error instanceof Error ? error.message : 'Unknown error';
		const errorTitle = isCORS ? 'Cross-Origin Request Blocked' : 'Failed to Load Data';

		logger.progress(datasetName, 'error', isCORS ? 'CORS blocked' : errorMsg);
		if (!skipErrorDialog) {
			await showErrorDialog(errorTitle, errorMsg);
		}

		// Only schedule idle for standalone loads - batch loads are managed by the caller
		if (!skipErrorDialog) {
			logger.scheduleIdle(5000);
		}

		return false;
	}
}

/**
 * Load from a single fetch Response (non-paginated path, or when pagination is disabled).
 * Handles format detection, loader dispatch, and the full load pipeline.
 */
async function loadSingleFetch(
	url: string,
	datasetName: string,
	loaderOptions: LoaderOptions,
	options: LoadDataOptions
): Promise<boolean> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`HTTP error! status: ${response.status}`);
	}

	return await loadFromResponse(response, url, datasetName, loaderOptions, options);
}

/**
 * Load from a fetch Response object through format detection and loader dispatch.
 */
async function loadFromResponse(
	response: Response,
	url: string,
	datasetName: string,
	loaderOptions: LoaderOptions,
	options: LoadDataOptions
): Promise<boolean> {
	const { logger, format } = options;

	// Check Content-Length before parsing (50MB limit)
	const MAX_SIZE_MB = 100;
	const MAX_SIZE_BYTES = MAX_SIZE_MB * 1024 * 1024;
	const contentLength = response.headers.get('Content-Length');
	if (contentLength && parseInt(contentLength, 10) > MAX_SIZE_BYTES) {
		throw new Error(`File too large (>${MAX_SIZE_MB}MB). Content-Length: ${contentLength} bytes`);
	}

	const contentType = response.headers.get('Content-Type');
	const contentDisposition = response.headers.get('Content-Disposition');
	const detectedFormat = detectFormat(response.url, contentType, format, contentDisposition);

	logger.progress(datasetName, 'processing');
	const { data, detectedCrs, crsHandled } = await loaderDispatch(response, detectedFormat, loaderOptions);

	return await loadFeatureCollection(data, url, datasetName, options, detectedCrs, crsHandled);
}

/**
 * Load a FeatureCollection into DuckDB and render on the map.
 * Shared by both paginated (first page only) and non-paginated paths.
 */
async function loadFeatureCollection(
	data: GeoJSON.FeatureCollection,
	url: string,
	datasetName: string,
	options: LoadDataOptions,
	detectedCrs?: string,
	crsHandled?: boolean
): Promise<boolean> {
	const { map, logger, layerToggleControl, loadedDatasets, configOverrides, skipFitBounds, skipLayers, hidden } = options;

	logger.progress(datasetName, 'processing');

	// If the loader already reprojected to WGS84 (e.g. geoparquet), skip CRS resolution
	let sourceCrs = crsHandled ? undefined : resolveSourceCrs(options.crs, detectedCrs, options.mapCrs);

	// Guard: detect projected coordinates that would crash MapLibre
	if (!sourceCrs && hasProjectedCoordinates(data)) {
		if (options.skipErrorDialog) {
			throw new Error('Data appears to use a projected coordinate system. Specify crs on the dataset config.');
		}
		const userCrs = await showCrsPromptDialog();
		if (!userCrs) {
			throw new Error('Projected coordinate system detected but no CRS provided. Add crs to the dataset config or enter the CRS when prompted.');
		}
		sourceCrs = userCrs;
	}

	const dbOptions: DBLoadOptions = { ...configOverrides, sourceCrs };

	const loaded = await loadGeoJSON(data, url, dbOptions);
	if (!loaded) {
		throw new Error('Failed to load into DuckDB');
	}

	// Get dataset metadata
	const datasets = await getDatasets();
	if (!datasets || datasets.length === 0) {
		throw new Error('No datasets found after loading');
	}

	const dataset = datasets[0];
	const datasetId = dataset.id;
	const datasetColor = dataset.color || '#3388ff';
	const datasetStyle = parseDatasetStyle(dataset.style);

	logger.info('Data', `Loading dataset ${datasetId} with color ${datasetColor} (sourceCrs: ${sourceCrs || 'none'})`);

	const geoJsonFromDB = await getFeaturesAsGeoJSON(datasetId);

	if (!geoJsonFromDB.features || geoJsonFromDB.features.length === 0) {
		throw new Error('No valid features returned from DuckDB');
	}

	const featureCount = geoJsonFromDB.features.length;

	// Hidden datasets: DuckDB-only, no map rendering or panel entry
	if (hidden) {
		loadedDatasets.add(datasetId);
		logger.info('Data', `Hidden dataset ${datasetId}: ${featureCount} features loaded (source-only)`);
		logger.progress(datasetName, 'success', `Loaded ${featureCount} features (hidden)`);
		if (!skipFitBounds) {
			logger.scheduleIdle(3000);
		}
		return true;
	}

	logger.info('Data', `Displaying ${featureCount} features for dataset ${datasetId}`);

	const layerIds = addDatasetToMap(map, datasetId, datasetColor, datasetStyle, geoJsonFromDB, skipLayers);
	loadedDatasets.add(datasetId);

	if (layerIds.length > 0) {
		const hoverPopup = attachFeatureHoverHandlers(map, layerIds, { label: datasetName });
		attachFeatureClickHandlers(map, layerIds, hoverPopup);
	}

	if (!skipFitBounds) {
		// Debug: log first feature's coordinates to verify CRS reprojection
		const firstGeom = geoJsonFromDB.features[0]?.geometry;
		if (firstGeom && 'coordinates' in firstGeom) {
			const coords = (firstGeom as any).coordinates;
			const sample = Array.isArray(coords?.[0]?.[0]) ? coords[0][0] : Array.isArray(coords?.[0]) ? coords[0] : coords;
			logger.info('Data', `First coordinate sample (expect WGS84 lon/lat):`, sample);
		}
		fitMapToFeatures(map, geoJsonFromDB);
	}

	layerToggleControl.refreshPanel();
	logger.progress(datasetName, 'success', `Loaded ${featureCount} features`);

	if (!skipFitBounds) {
		logger.scheduleIdle(3000);
	}

	return true;
}
