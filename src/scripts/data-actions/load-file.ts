/**
 * Local file loading - reads File to ArrayBuffer, transfers to the DuckDB Web Worker
 * for parsing and insertion, then handles MapLibre rendering on the main thread.
 */

import { loadFromBuffer } from '../db';
import { attachFeatureClickHandlers, attachFeatureHoverHandlers } from '../controls/popup';
import { showErrorDialog } from '../ui/error-dialog';
import { loadPMTilesDataset } from './load-pmtiles';
import { PMTiles, FileSource } from 'pmtiles';
import { pmtilesProtocol } from '../map';
import {
	type LoadDataOptions,
	formatBytes,
	checkQuota,
	addDatasetToMap,
	addDatasetToMapDeckGL,
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

	const MAX_SIZE_MB = 2048;
	const MAX_SIZE_BYTES = MAX_SIZE_MB * 1024 * 1024;
	if (file.size > MAX_SIZE_BYTES) {
		if (!options.skipErrorDialog) {
			await showErrorDialog('File Too Large', `File exceeds the ${MAX_SIZE_MB}MB limit (${formatBytes(file.size)}).`);
		}
		return false;
	}

	if (!await checkQuota()) {
		return false;
	}

	// Use config override name if available, otherwise strip extension for display name
	const displayName = options.configOverrides?.name
		?? (file.name.lastIndexOf('.') !== -1 ? file.name.slice(0, file.name.lastIndexOf('.')) : file.name);

	try {
		logger.progress(displayName, 'loading');

		// PMTiles files bypass DuckDB - load as vector tile source via FileSource.
		// Uses FileSource (File.slice) instead of blob URLs because browsers
		// don't reliably support Range requests on blob:// URLs.
		// The protocol key must match FileSource.getKey() which returns file.name.
		if (file.name.endsWith('.pmtiles')) {
			const pm = new PMTiles(new FileSource(file));
			pmtilesProtocol.add(pm);
			const success = await loadPMTilesDataset(
				{ id: displayName, url: file.name, name: displayName, format: 'pmtiles' },
				{ map, logger, layerToggleControl, loadedDatasets, pmtilesInstance: pm }
			);
			if (success) logger.scheduleIdle(3000);
			return success;
		}

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
			configOverrides: { name: displayName, ...options.configOverrides },
		});

		// Hidden datasets: stored in DuckDB but not rendered
		if (options.hidden) {
			loadedDatasets.add(result.datasetId);
			logger.progress(displayName, 'success', `Loaded (hidden)`);
			return true;
		}

		// Render on main thread
		const resolvedRenderer = options.renderer === 'deckgl' ? 'deckgl' : 'maplibre';
		let layerIds: string[];
		if (resolvedRenderer === 'deckgl') {
			layerIds = await addDatasetToMapDeckGL(map, result.datasetId, result.color, result.style, displayName);
			result.geoJson = null as any;
		} else {
			layerIds = addDatasetToMap(map, result.datasetId, result.color, result.style, result.geoJson);
			result.geoJson = null as any;
		}

		loadedDatasets.add(result.datasetId);
		if (resolvedRenderer !== 'deckgl') {
			attachFeatureHoverHandlers(map, layerIds, { label: displayName });
			attachFeatureClickHandlers(map, layerIds);
		}

		if (result.bounds && !options.skipFitBounds) fitMapToBounds(map, result.bounds);
		layerToggleControl.refreshPanel();

		logger.scheduleIdle(3000);

		return true;
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : 'Unknown error';
		logger.progress(displayName, 'error', errorMsg);
		if (!options.skipErrorDialog) {
			await showErrorDialog('Failed to Load File', errorMsg);
		}
		logger.scheduleIdle(5000);
		return false;
	}
}
