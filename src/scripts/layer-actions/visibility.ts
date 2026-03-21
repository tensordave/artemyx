import maplibregl from 'maplibre-gl';
import { getLayersForDataset } from '../layers';

/**
 * Toggle visibility for all layers associated with a dataset.
 * Finds layers dynamically, supporting both default and explicit config layers.
 * For PMTiles sub-layer entries, scopes to that sub-layer's MapLibre layers only.
 */
export function toggleLayerVisibility(map: maplibregl.Map, datasetId: string, visible: boolean): void {
	const layers = getLayersForDataset(map, datasetId);
	const visibility = visible ? 'visible' : 'none';

	for (const layer of layers) {
		if (map.getLayer(layer.id)) {
			map.setLayoutProperty(layer.id, 'visibility', visibility);
		}
	}

	console.log(`[LayerVisibility] Dataset ${datasetId} (${layers.length} layers): ${visibility}`);
}
