import maplibregl from 'maplibre-gl';
import { loadGeoJSON, appendFeatures, updateFeatureCount, getFeaturesAsGeoJSON, getDatasets, datasetExists } from '../db';
import { DEFAULT_STYLE, type StyleConfig, type LoadGeoJSONOptions as DBLoadOptions } from '../db/datasets';
import { getStorageMode } from '../db/core';
import { getSourceId, addSource, removeDefaultLayers, addDefaultLayers, updateSourceData } from '../layers';
import { attachFeatureClickHandlers, attachFeatureHoverHandlers } from '../popup';
import { showErrorDialog, showConfirmDialog, showCrsPromptDialog } from '../ui/error-dialog';
import { detectFormat, detectFormatFromFile, dispatch as loaderDispatch, normalizeGeoJSON, tryLoadJsonArray } from '../loaders';
import type { ConfigFormat, LoaderOptions } from '../loaders';
import { resolveSourceCrs, hasProjectedCoordinates } from '../loaders/crs';
import { fetchWithPagination } from '../loaders/paginator';
import type { PaginationOptions } from '../loaders/paginator';
import type { LayerToggleControl } from '../layer-control';
import type { ProgressControl } from '../progress-control';
import type { DatasetConfig, LayerConfig } from '../config/types';

/**
 * Parse style JSON from dataset, returning defaults if invalid
 */
function parseDatasetStyle(styleJson: string | null | undefined): StyleConfig {
	if (!styleJson) {
		return { ...DEFAULT_STYLE };
	}
	try {
		const parsed = JSON.parse(styleJson);
		return {
			fillOpacity: parsed.fillOpacity ?? DEFAULT_STYLE.fillOpacity,
			lineWidth: parsed.lineWidth ?? DEFAULT_STYLE.lineWidth,
			pointRadius: parsed.pointRadius ?? DEFAULT_STYLE.pointRadius
		};
	} catch {
		return { ...DEFAULT_STYLE };
	}
}

const QUOTA_WARN_THRESHOLD = 0.80;

/**
 * Format bytes as a human-readable string (e.g. "45.2 MB").
 */
function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Check OPFS storage quota and warn if usage exceeds threshold.
 * Returns true if the load should proceed, false if the user cancelled.
 * Always returns true when OPFS is not active (nothing to protect).
 */
async function checkQuota(): Promise<boolean> {
	if (getStorageMode() !== 'opfs') return true;
	if (!navigator.storage?.estimate) return true;

	try {
		const { usage = 0, quota = 0 } = await navigator.storage.estimate();
		if (quota === 0) return true;

		const usageRatio = usage / quota;
		if (usageRatio >= QUOTA_WARN_THRESHOLD) {
			const pct = Math.round(usageRatio * 100);
			const msg = `Storage is ${pct}% full (${formatBytes(usage)} of ${formatBytes(quota)} used). Loading large datasets may fail or affect stored data. Continue?`;
			return showConfirmDialog('Storage Warning', msg);
		}
	} catch (e) {
		console.warn('[Quota] Failed to check storage estimate:', e);
	}

	return true;
}

interface LoadDataOptions {
	map: maplibregl.Map;
	progressControl: ProgressControl;
	layerToggleControl: LayerToggleControl;
	loadedDatasets: Set<string>;
	/** Config overrides for name, color, style */
	configOverrides?: DBLoadOptions;
	/** Human-readable label for progress messages (falls back to URL hostname) */
	displayName?: string;
	/** Skip fitting map bounds (used when loading multiple datasets) */
	skipFitBounds?: boolean;
	/** Skip showing error dialog (used when loading from config) */
	skipErrorDialog?: boolean;
	/**
	 * Skip auto-generating default layers for this dataset.
	 * True when this dataset has explicit layer entries in config.
	 */
	skipLayers?: boolean;
	/**
	 * When true, dataset is loaded into DuckDB only (source-only for operations).
	 * No MapLibre source/layer created, no layer panel entry.
	 */
	hidden?: boolean;
	/** Explicit format override (from config) */
	format?: ConfigFormat;
	/** Latitude column name override (CSV and JSON array formats) */
	latColumn?: string;
	/** Longitude column name override (CSV and JSON array formats) */
	lngColumn?: string;
	/** Combined coordinate column containing "lat, lng" values (CSV and JSON array formats) */
	geoColumn?: string;
	/** Pagination control: true to force, false to disable, object for options, omit for auto-detect */
	paginate?: boolean | { maxPages?: number };
	/** Explicit CRS override from dataset config (e.g. 'EPSG:3005') */
	crs?: string;
	/** Fallback CRS from map-level config (for formats without file metadata) */
	mapCrs?: string;
}

/**
 * Validate a URL for data loading.
 * Returns the parsed URL if valid, or null with error dialog shown.
 */
async function validateUrl(url: string): Promise<URL | null> {
	let parsedUrl: URL;
	try {
		parsedUrl = new URL(url);
	} catch {
		await showErrorDialog('Invalid URL', 'The URL format is not valid. Please enter a complete URL starting with https://');
		return null;
	}

	if (parsedUrl.protocol !== 'https:') {
		await showErrorDialog('HTTPS Required', 'Only HTTPS URLs are supported for security reasons.');
		return null;
	}

	return parsedUrl;
}

/**
 * Add data to map as source, optionally with default layers.
 * Removes existing source/layers first (for reloading).
 *
 * @param skipLayers - When true, only add source (explicit layers defined in config).
 *                     When false, auto-generate fill/line/circle layers.
 * @returns Layer IDs if layers were created, empty array otherwise.
 */
function addDatasetToMap(
	map: maplibregl.Map,
	datasetId: string,
	datasetColor: string,
	style: StyleConfig,
	geoJsonData: GeoJSON.FeatureCollection,
	skipLayers: boolean = false
): string[] {
	const sourceId = getSourceId(datasetId);

	// Remove existing layers and source for this dataset if reloading
	removeDefaultLayers(map, datasetId);

	// Add source
	addSource(map, sourceId, geoJsonData);

	// Add default layers only if no explicit layers config
	if (!skipLayers) {
		return addDefaultLayers(map, sourceId, datasetId, datasetColor, style);
	}

	return [];
}

/**
 * Fit map bounds to GeoJSON features
 */
function fitMapToFeatures(map: maplibregl.Map, geoJsonData: GeoJSON.FeatureCollection): void {
	try {
		const bounds = new maplibregl.LngLatBounds();
		const features = geoJsonData.features;

		features.forEach((feature: any) => {
			const coords = feature.geometry?.coordinates;
			if (!coords || !Array.isArray(coords)) return;

			const extendBounds = (c: any) => {
				if (Array.isArray(c) && c.length >= 2 && typeof c[0] === 'number') {
					bounds.extend(c as [number, number]);
				}
			};

			switch (feature.geometry.type) {
				case 'Point':
					extendBounds(coords);
					break;
				case 'LineString':
				case 'MultiPoint':
					coords.forEach(extendBounds);
					break;
				case 'Polygon':
				case 'MultiLineString':
					coords.forEach((ring: any[]) => ring?.forEach(extendBounds));
					break;
				case 'MultiPolygon':
					coords.forEach((polygon: any[]) => polygon?.[0]?.forEach(extendBounds));
					break;
			}
		});

		if (!bounds.isEmpty()) {
			map.fitBounds(bounds, { padding: 50 });
		}
	} catch (boundsError) {
		console.error('Failed to fit bounds:', boundsError);
	}
}

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
	const { map, progressControl, layerToggleControl, loadedDatasets, configOverrides, displayName, skipFitBounds, skipErrorDialog, skipLayers, hidden, latColumn, lngColumn, geoColumn, paginate, crs } = options;

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
		console.log(`[Data] Fetching from ${url}`);
		progressControl.updateProgress(datasetName, 'loading');

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
		console.log(`[Data] Paginated ${apiType} response detected`);

		// Normalize and load first page
		progressControl.updateProgress(datasetName, 'loading', `Loading ${datasetName} (page 1)...`);
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
				progressControl.updateProgress(datasetName, 'loading', `Loading ${datasetName} (page ${pageNum}, ${totalFeatures} features)...`);

				const pageFeatures = normalizePage(pageData, loaderOptions);
				const appendedCount = await appendFeatures(datasetId, pageFeatures, url, pagSourceCrs);
				totalFeatures += appendedCount;
				pageNum++;
			}
		}

		// Update final feature count in metadata
		const finalCount = await updateFeatureCount(datasetId);
		console.log(`[Data] Pagination complete: ${finalCount} total features across ${pageNum - 1} pages`);

		// Re-query full dataset and update MapLibre source with all features
		if (!hidden) {
			const fullGeoJson = await getFeaturesAsGeoJSON(datasetId);
			const sourceId = getSourceId(datasetId);
			updateSourceData(map, sourceId, fullGeoJson);

			if (!skipFitBounds) {
				fitMapToFeatures(map, fullGeoJson);
			}
		}

		progressControl.updateProgress(datasetName, 'success', `Loaded ${finalCount} features (${pageNum - 1} pages)`);
		if (!skipFitBounds) {
			progressControl.scheduleIdle(3000);
		}

		return true;

	} catch (error) {
		const isCORS = error instanceof TypeError && !navigator.onLine === false;
		const errorMsg = isCORS
			? 'This server does not allow cross-origin requests from the browser. Download the file and use the upload button to load it locally.'
			: error instanceof Error ? error.message : 'Unknown error';
		const errorTitle = isCORS ? 'Cross-Origin Request Blocked' : 'Failed to Load Data';

		progressControl.updateProgress(datasetName, 'error', isCORS ? 'CORS blocked' : errorMsg);
		if (!skipErrorDialog) {
			await showErrorDialog(errorTitle, errorMsg);
		}

		// Only schedule idle for standalone loads - batch loads are managed by the caller
		if (!skipErrorDialog) {
			progressControl.scheduleIdle(5000);
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
	const { progressControl, format } = options;

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

	progressControl.updateProgress(datasetName, 'processing');
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
	const { map, progressControl, layerToggleControl, loadedDatasets, configOverrides, skipFitBounds, skipLayers, hidden } = options;

	progressControl.updateProgress(datasetName, 'processing');

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

	console.log(`[Data] Loading dataset ${datasetId} with color ${datasetColor} (sourceCrs: ${sourceCrs || 'none'})`);

	const geoJsonFromDB = await getFeaturesAsGeoJSON(datasetId);

	if (!geoJsonFromDB.features || geoJsonFromDB.features.length === 0) {
		throw new Error('No valid features returned from DuckDB');
	}

	const featureCount = geoJsonFromDB.features.length;

	// Hidden datasets: DuckDB-only, no map rendering or panel entry
	if (hidden) {
		loadedDatasets.add(datasetId);
		console.log(`[Data] Hidden dataset ${datasetId}: ${featureCount} features loaded (source-only)`);
		progressControl.updateProgress(datasetName, 'success', `Loaded ${featureCount} features (hidden)`);
		if (!skipFitBounds) {
			progressControl.scheduleIdle(3000);
		}
		return true;
	}

	console.log(`[Data] Displaying ${featureCount} features for dataset ${datasetId}`);

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
			console.log(`[Data] First coordinate sample (expect WGS84 lon/lat):`, sample);
		}
		fitMapToFeatures(map, geoJsonFromDB);
	}

	layerToggleControl.refreshPanel();
	progressControl.updateProgress(datasetName, 'success', `Loaded ${featureCount} features`);

	if (!skipFitBounds) {
		progressControl.scheduleIdle(3000);
	}

	return true;
}

/**
 * Load a local File into DuckDB and display on map.
 * Supports GeoJSON, CSV, and GeoParquet via the same loader dispatch as URL loading.
 * Returns true on success, false on failure.
 */
export async function loadDataFromFile(
	file: File,
	options: LoadDataOptions
): Promise<boolean> {
	const { map, progressControl, layerToggleControl, loadedDatasets, format, latColumn, lngColumn, geoColumn, crs } = options;

	const MAX_SIZE_MB = 100;
	const MAX_SIZE_BYTES = MAX_SIZE_MB * 1024 * 1024;
	if (file.size > MAX_SIZE_BYTES) {
		await showErrorDialog('File Too Large', `File exceeds the ${MAX_SIZE_MB}MB limit (${formatBytes(file.size)}).`);
		return false;
	}

	if (!await checkQuota()) {
		return false;
	}

	// Strip extension for display name
	const dotIndex = file.name.lastIndexOf('.');
	const displayName = dotIndex !== -1 ? file.name.slice(0, dotIndex) : file.name;

	const loaderOptions: LoaderOptions = {};
	if (latColumn) loaderOptions.latColumn = latColumn;
	if (lngColumn) loaderOptions.lngColumn = lngColumn;
	if (geoColumn) loaderOptions.geoColumn = geoColumn;
	if (crs) loaderOptions.crs = crs;

	try {
		progressControl.updateProgress(displayName, 'loading');

		const detectedFormat = format || detectFormatFromFile(file);

		// Wrap File (a Blob) in a Response so loaders can call .text()/.arrayBuffer()/.json()
		const response = new Response(file);

		progressControl.updateProgress(displayName, 'processing');
		const { data, detectedCrs, crsHandled } = await loaderDispatch(response, detectedFormat, loaderOptions);

		// Use file.name as the source identifier for dataset ID generation
		// If the loader already reprojected (e.g. geoparquet), skip CRS resolution
		const sourceCrs = crsHandled ? undefined : resolveSourceCrs(crs, detectedCrs, undefined);
		const loaded = await loadGeoJSON(data, file.name, { ...options.configOverrides, sourceCrs });
		if (!loaded) {
			throw new Error('Failed to load into DuckDB');
		}

		const datasets = await getDatasets();
		if (!datasets || datasets.length === 0) {
			throw new Error('No datasets found after loading');
		}

		const dataset = datasets[0];
		const datasetId = dataset.id;
		const datasetColor = dataset.color || '#3388ff';
		const datasetStyle = parseDatasetStyle(dataset.style);

		const geoJsonFromDB = await getFeaturesAsGeoJSON(datasetId);
		if (!geoJsonFromDB.features || geoJsonFromDB.features.length === 0) {
			throw new Error('No valid features returned from DuckDB');
		}

		const featureCount = geoJsonFromDB.features.length;

		const layerIds = addDatasetToMap(map, datasetId, datasetColor, datasetStyle, geoJsonFromDB);
		loadedDatasets.add(datasetId);
		const hoverPopup = attachFeatureHoverHandlers(map, layerIds, { label: displayName });
		attachFeatureClickHandlers(map, layerIds, hoverPopup);

		fitMapToFeatures(map, geoJsonFromDB);
		layerToggleControl.refreshPanel();

		progressControl.updateProgress(displayName, 'success', `Loaded ${featureCount} features`);
		progressControl.scheduleIdle(3000);

		return true;
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : 'Unknown error';
		progressControl.updateProgress(displayName, 'error', errorMsg);
		await showErrorDialog('Failed to Load File', errorMsg);
		progressControl.scheduleIdle(5000);
		return false;
	}
}

/** Options for loading datasets from config */
interface ConfigLoadOptions {
	map: maplibregl.Map;
	progressControl: ProgressControl;
	layerToggleControl: LayerToggleControl;
	loadedDatasets: Set<string>;
	/**
	 * Explicit layer configs from YAML.
	 * When defined, skip auto-generating default layers (the layer config handles them).
	 * When undefined, auto-generate fill/line/circle layers per dataset.
	 */
	layers?: LayerConfig[];
	/** Fallback CRS from map-level config (for formats without file metadata) */
	mapCrs?: string;
}

/** Result of loading datasets from config */
export interface ConfigLoadResult {
	/** Number of datasets successfully loaded */
	loaded: number;
	/** Number of datasets skipped (already loaded) */
	skipped: number;
	/** Number of datasets that failed to load */
	failed: number;
	/** Error messages for failed datasets */
	errors: string[];
}

/**
 * Load multiple datasets from YAML config.
 * Continues on errors, skips duplicates, fits bounds once at end.
 */
export async function loadDatasetsFromConfig(
	datasets: DatasetConfig[],
	options: ConfigLoadOptions
): Promise<ConfigLoadResult> {
	const { map, progressControl, layerToggleControl, loadedDatasets, layers } = options;
	const result: ConfigLoadResult = {
		loaded: 0,
		skipped: 0,
		failed: 0,
		errors: []
	};

	if (!datasets || datasets.length === 0) {
		return result;
	}

	progressControl.updateProgress('config', 'loading', `Loading ${datasets.length} dataset(s) from config...`);

	// Build set of source IDs that have explicit layer entries in config.
	// Datasets covered by an explicit layer skip auto-layer creation (the layer config handles them).
	// Datasets NOT covered get fallback default layers so they're visible and interactable.
	const coveredSources = new Set(layers?.map(l => l.source) ?? []);

	for (const dataset of datasets) {
		const displayName = dataset.name || dataset.id;
		const isHidden = !!dataset.hidden;
		const skipLayers = !!layers && coveredSources.has(dataset.id);

		// Check for duplicate (by config ID)
		if (loadedDatasets.has(dataset.id)) {
			progressControl.updateProgress(dataset.id, 'success', `Skipped (already loaded)`);
			result.skipped++;
			continue;
		}

		// OPFS restore: if dataset already exists in DuckDB, render from persisted data
		if (await datasetExists(dataset.id)) {
			try {
				const geoJsonData = await getFeaturesAsGeoJSON(dataset.id);
				if (geoJsonData.features && geoJsonData.features.length > 0) {
					// Hidden datasets: mark loaded but skip map rendering
					if (isHidden) {
						loadedDatasets.add(dataset.id);
						progressControl.updateProgress(displayName, 'success', `Restored from session (${geoJsonData.features.length} features, hidden)`);
						result.loaded++;
						continue;
					}

					const allDatasets = await getDatasets();
					const meta = allDatasets.find((d: any) => d.id === dataset.id);
					const color = meta?.color || dataset.color || '#3388ff';
					const style = parseDatasetStyle(meta?.style);

					addDatasetToMap(map, dataset.id, color, style, geoJsonData, skipLayers);
					loadedDatasets.add(dataset.id);

					layerToggleControl.refreshPanel();

					progressControl.updateProgress(displayName, 'success', `Restored from session (${geoJsonData.features.length} features)`);
					result.loaded++;
					continue;
				}
			} catch (e) {
				console.warn(`[OPFS] Failed to restore ${dataset.id}, will re-fetch:`, e);
			}
		}

		// Build config overrides from dataset config
		// Use config ID as dataset_id so operations can reference it
		const configOverrides: DBLoadOptions = {
			id: dataset.id,
			name: displayName,
			color: dataset.color,
			style: dataset.style,
			hidden: isHidden
		};

		// Load dataset with overrides, passing format and column options from config
		const success = await loadDataFromUrl(dataset.url, {
			map,
			progressControl,
			layerToggleControl,
			loadedDatasets,
			configOverrides,
			displayName,
			skipFitBounds: true,
			skipErrorDialog: true,
			skipLayers,
			hidden: isHidden,
			format: dataset.format,
			latColumn: dataset.latColumn,
			lngColumn: dataset.lngColumn,
			geoColumn: dataset.geoColumn,
			paginate: dataset.paginate,
			crs: dataset.crs,
			mapCrs: options.mapCrs,
		});

		if (success) {
			result.loaded++;
		} else {
			result.failed++;
			result.errors.push(`${dataset.id}: Failed to load from ${dataset.url}`);
		}
	}

	// Fit bounds to datasets that haven't opted out (fitBounds defaults to true)
	const boundsDatasets = datasets.filter(d => d.fitBounds !== false && loadedDatasets.has(d.id));
	if (boundsDatasets.length > 0) {
		try {
			const allFeatures: GeoJSON.Feature[] = [];
			for (const d of boundsDatasets) {
				const fc = await getFeaturesAsGeoJSON(d.id);
				if (fc.features) allFeatures.push(...fc.features);
			}
			if (allFeatures.length > 0) {
				fitMapToFeatures(map, { type: 'FeatureCollection', features: allFeatures });
			}
		} catch (e) {
			console.error('Failed to fit bounds after config load:', e);
		}
	}

	// Show summary
	const summaryParts: string[] = [];
	if (result.loaded > 0) summaryParts.push(`${result.loaded} loaded`);
	if (result.skipped > 0) summaryParts.push(`${result.skipped} skipped`);
	if (result.failed > 0) summaryParts.push(`${result.failed} failed`);

	const status = result.failed > 0 ? 'error' : 'success';
	progressControl.updateProgress('config', status, summaryParts.join(', '));

	// Schedule idle - will be auto-cancelled if operations start via updateProgress()
	progressControl.scheduleIdle(result.failed > 0 ? 5000 : 3000);

	return result;
}
