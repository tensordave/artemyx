/**
 * Clean teardown: remove all datasets, sources, and layers from DuckDB and MapLibre.
 * Leaves the map in a blank-slate state (basemap + controls, no data).
 */

import type { Map } from 'maplibre-gl';
import { getDatasets, deleteAllDatasets } from './db';
import { getLayersBySource, getSourceId } from './layers';
import { clearAllFeatureHandlers } from './controls/popup';
import type { ProgressControl } from './controls/progress-control';
import type { LayerToggleControl } from './controls/layer-control';

export interface TeardownOptions {
	map: Map;
	progressControl: ProgressControl;
	layerToggleControl: LayerToggleControl;
	loadedDatasets: Set<string>;
}

export async function teardownAll(options: TeardownOptions): Promise<void> {
	const { map, progressControl, layerToggleControl, loadedDatasets } = options;

	progressControl.updateProgress('teardown', 'processing', 'Clearing all data...');

	// 1. Get all datasets before deleting from DB
	const datasets = await getDatasets();

	// 2. Remove all MapLibre layers and sources for each dataset
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

	// 4. Delete all data from DuckDB (single bulk operation)
	await deleteAllDatasets();

	// 5. Clear the loadedDatasets tracking set
	loadedDatasets.clear();

	// 6. Refresh layer panel to show empty state
	layerToggleControl.refreshPanel();

	progressControl.updateProgress('teardown', 'success', 'All data cleared');
}
