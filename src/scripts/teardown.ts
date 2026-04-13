/**
 * Clean teardown: remove all datasets, sources, and layers from DuckDB and MapLibre.
 * Leaves the map in a blank-slate state (basemap + controls, no data).
 */

import type { Map } from 'maplibre-gl';
import { getDatasets, deleteAllDatasets, deleteDataset, checkpoint, vacuum } from './db';
import { getLayersBySource, getSourceId } from './layers';
import { clearAllFeatureHandlers } from './controls/popup';
import type { ProgressControl } from './controls/progress-control';
import type { LayerToggleControl } from './controls/layer-control';

export interface TeardownOptions {
	map: Map;
	progressControl: ProgressControl;
	layerToggleControl: LayerToggleControl;
	loadedDatasets: Set<string>;
	/** When true, file-uploaded datasets (file:// source) are kept in DuckDB. */
	preserveFileUploads?: boolean;
}

export async function teardownAll(options: TeardownOptions): Promise<void> {
	const { map, progressControl, layerToggleControl, loadedDatasets, preserveFileUploads } = options;

	progressControl.updateProgress('teardown', 'processing', 'Clearing all data...');

	// 1. Get all datasets before deleting from DB
	const datasets = await getDatasets();

	// 2. Remove all MapLibre layers and sources for every dataset (clean visual slate)
	for (const dataset of datasets) {
		const sourceId = getSourceId(dataset.id);
		const layers = getLayersBySource(map, sourceId);
		for (const layer of layers) {
			map.removeLayer(layer.id);
		}
		if (map.getSource(sourceId)) {
			map.removeSource(sourceId);
		}
	}

	// 3. Clear all hover/click handler registrations
	clearAllFeatureHandlers();

	// 3b. Tear down deck.gl overlay and registry
	const { isInitialized, destroy } = await import('./deckgl/manager');
	if (isInitialized()) {
		destroy();
	}
	const { clearRegistry } = await import('./deckgl/registry');
	clearRegistry();

	// 4. Delete datasets from DuckDB
	if (preserveFileUploads) {
		// Selectively delete only non-file datasets; file uploads stay in DB.
		// skipMaintenance=true defers checkpoint+vacuum to after the loop.
		for (const dataset of datasets) {
			const src: string | null = dataset.source_url;
			if (!src || !src.startsWith('file://')) {
				await deleteDataset(dataset.id, true);
			}
		}
		await checkpoint();
		await vacuum();
	} else {
		await deleteAllDatasets();
	}

	// 5. Clear the loadedDatasets tracking set (preserved uploads re-added during restore)
	loadedDatasets.clear();

	// 6. Refresh layer panel to show empty state
	layerToggleControl.refreshPanel();

	progressControl.updateProgress('teardown', 'success', 'All data cleared');
}
