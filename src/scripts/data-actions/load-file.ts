/**
 * Local file loading - reads File to ArrayBuffer, transfers to the DuckDB Web Worker
 * for parsing and insertion, then handles MapLibre rendering on the main thread.
 */

import { loadFromBuffer } from '../db';
import { attachFeatureClickHandlers, attachFeatureHoverHandlers } from '../controls/popup';
import { showErrorDialog } from '../ui/error-dialog';
import {
	type LoadDataOptions,
	formatBytes,
	checkQuota,
	addDatasetToMap,
	fitMapToBounds,
} from './shared';

/**
 * Load a local File into DuckDB and display on map.
 * The file is read to ArrayBuffer and transferred to the worker (zero-copy).
 * Returns true on success, false on failure.
 */
export async function loadDataFromFile(
	file: File,
	options: LoadDataOptions
): Promise<boolean> {
	const { map, logger, layerToggleControl, loadedDatasets } = options;

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

	try {
		logger.progress(displayName, 'loading');

		// Read file to ArrayBuffer for zero-copy transfer to worker
		const buffer = await file.arrayBuffer();

		// Delegate entire pipeline to worker
		const result = await loadFromBuffer(buffer, {
			fileName: file.name,
			format: options.format,
			latColumn: options.latColumn,
			lngColumn: options.lngColumn,
			geoColumn: options.geoColumn,
			crs: options.crs,
			configOverrides: options.configOverrides,
		});

		// Render on main thread
		const layerIds = addDatasetToMap(map, result.datasetId, result.color, result.style, result.geoJson);

		// Release GeoJSON reference early - MapLibre owns the data now
		result.geoJson = null as any;

		loadedDatasets.add(result.datasetId);
		const hoverPopup = attachFeatureHoverHandlers(map, layerIds, { label: displayName });
		attachFeatureClickHandlers(map, layerIds, hoverPopup);

		if (result.bounds) fitMapToBounds(map, result.bounds);
		layerToggleControl.refreshPanel();

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
