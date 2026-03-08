import { loadGeoJSON, getFeaturesAsGeoJSON, getDatasets } from '../db';
import { attachFeatureClickHandlers, attachFeatureHoverHandlers } from '../controls/popup';
import { showErrorDialog } from '../ui/error-dialog';
import { detectFormatFromFile, dispatch as loaderDispatch } from '../loaders';
import type { LoaderOptions } from '../loaders';
import { resolveSourceCrs } from '../loaders/crs';
import {
	type LoadDataOptions,
	parseDatasetStyle,
	formatBytes,
	checkQuota,
	addDatasetToMap,
	fitMapToFeatures,
} from './shared';

/**
 * Load a local File into DuckDB and display on map.
 * Supports GeoJSON, CSV, and GeoParquet via the same loader dispatch as URL loading.
 * Returns true on success, false on failure.
 */
export async function loadDataFromFile(
	file: File,
	options: LoadDataOptions
): Promise<boolean> {
	const { map, logger, layerToggleControl, loadedDatasets, format, latColumn, lngColumn, geoColumn, crs } = options;

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
		logger.progress(displayName, 'loading');

		const detectedFormat = format || detectFormatFromFile(file);

		// Wrap File (a Blob) in a Response so loaders can call .text()/.arrayBuffer()/.json()
		const response = new Response(file);

		logger.progress(displayName, 'processing');
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

		logger.progress(displayName, 'success', `Loaded ${featureCount} features`);
		logger.scheduleIdle(3000);

		return true;
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : 'Unknown error';
		logger.progress(displayName, 'error', errorMsg);
		await showErrorDialog('Failed to Load File', errorMsg);
		logger.scheduleIdle(5000);
		return false;
	}
}
