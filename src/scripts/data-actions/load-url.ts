/**
 * URL data loading - delegates the full fetch/parse/insert pipeline to the
 * DuckDB Web Worker and handles MapLibre rendering on the main thread.
 */

import { loadFromUrl } from '../db';
import { attachFeatureClickHandlers, attachFeatureHoverHandlers } from '../controls/popup';
import { showErrorDialog } from '../ui/error-dialog';
import type { WorkerLoadUrlOptions } from '../db/worker-types';
import {
	type LoadDataOptions,
	validateUrl,
	checkQuota,
	addDatasetToMap,
	addDatasetToMapDeckGL,
	fitMapToBounds,
} from './shared';
import { loadPMTilesDataset } from './load-pmtiles';
import { extractDatasetName } from '../db/utils';

/**
 * Load data from a URL into DuckDB and display on map.
 * The full data pipeline (fetch, format detection, parsing, DuckDB insert, GeoJSON query)
 * runs in the Web Worker. This function handles pre-flight checks and MapLibre rendering.
 *
 * PMTiles URLs are intercepted early and routed to the vector source pipeline
 * (no DuckDB involvement, no fetch/size check).
 */
export async function loadDataFromUrl(
	url: string,
	options: LoadDataOptions
): Promise<boolean> {
	const { map, logger, layerToggleControl, loadedDatasets, skipFitBounds, skipErrorDialog, skipLayers } = options;

	// Validate URL (main thread - uses DOM)
	const parsedUrl = await validateUrl(url);
	if (!parsedUrl) {
		return false;
	}

	// PMTiles: bypass the worker pipeline entirely (no fetch, no size check, no DuckDB)
	const isPMTiles = options.format === 'pmtiles' || url.endsWith('.pmtiles');
	if (isPMTiles) {
		try {
			return await loadPMTilesDataset({
				id: options.configOverrides?.id || extractDatasetName(url),
				url,
				name: options.displayName,
				color: options.configOverrides?.color,
				style: options.configOverrides?.style,
				hidden: options.hidden,
				format: 'pmtiles',
			}, { map, logger, layerToggleControl, loadedDatasets });
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : 'Unknown error';
			logger.progress(options.displayName || 'PMTiles', 'error', errorMsg);
			if (!skipErrorDialog) {
				await showErrorDialog('Failed to Load PMTiles', errorMsg);
			}
			return false;
		}
	}

	// Quota preflight (main thread - uses navigator.storage)
	if (!await checkQuota()) {
		return false;
	}

	const datasetName = options.displayName || parsedUrl.hostname;

	try {
		// Build worker options (no MapLibre/DOM refs)
		const workerOptions: WorkerLoadUrlOptions = {
			configOverrides: options.configOverrides,
			displayName: datasetName,
			format: options.format,
			latColumn: options.latColumn,
			lngColumn: options.lngColumn,
			geoColumn: options.geoColumn,
			paginate: options.paginate,
			crs: options.crs,
			mapCrs: options.mapCrs,
			hidden: options.hidden,
			skipCrsPrompt: options.skipErrorDialog,
		};

		// Delegate entire pipeline to worker
		// Progress events are forwarded to BrowserLogger via the worker event handler
		// CRS prompts are handled via the worker event handler (shows dialog on main thread)
		const result = await loadFromUrl(url, workerOptions);

		// Render on main thread
		if (!result.hidden) {
			const resolvedRenderer = options.renderer === 'deckgl' ? 'deckgl' : 'maplibre';
			let layerIds: string[];
			if (resolvedRenderer === 'deckgl') {
				layerIds = await addDatasetToMapDeckGL(map, result.datasetId, result.color, result.style, datasetName);
				result.geoJson = null as any;
			} else {
				layerIds = addDatasetToMap(map, result.datasetId, result.color, result.style, result.geoJson, skipLayers);
				result.geoJson = null as any;
			}

			if (!skipFitBounds && result.bounds) {
				fitMapToBounds(map, result.bounds);
			}

			loadedDatasets.add(result.datasetId);

			if (layerIds.length > 0 && resolvedRenderer !== 'deckgl') {
				attachFeatureHoverHandlers(map, layerIds, { label: datasetName });
				attachFeatureClickHandlers(map, layerIds);
			}

			layerToggleControl.refreshPanel();
		} else {
			loadedDatasets.add(result.datasetId);
		}

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

		if (!skipErrorDialog) {
			logger.scheduleIdle(5000);
		}

		return false;
	}
}
