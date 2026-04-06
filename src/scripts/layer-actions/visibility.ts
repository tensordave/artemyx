import maplibregl from 'maplibre-gl';
import { getLayersForDataset } from '../layers';
import { getLayersByDataset } from '../deckgl/registry';

/**
 * Toggle visibility for all layers associated with a dataset.
 * Dispatches to MapLibre style API or deck.gl manager based on the renderer registry.
 * For PMTiles sub-layer entries, scopes to that sub-layer's MapLibre layers only.
 */
export function toggleLayerVisibility(map: maplibregl.Map, datasetId: string, visible: boolean): void {
	// MapLibre layers
	const layers = getLayersForDataset(map, datasetId);
	const visibility = visible ? 'visible' : 'none';

	for (const layer of layers) {
		if (map.getLayer(layer.id)) {
			map.setLayoutProperty(layer.id, 'visibility', visibility);
		}
	}

	// deck.gl layers (not in MapLibre's style -- registry is authoritative)
	const deckLayerIds = getLayersByDataset(datasetId, 'deckgl');
	if (deckLayerIds.length > 0) {
		void import('../deckgl/manager').then(({ setLayerVisibility }) => {
			for (const id of deckLayerIds) {
				setLayerVisibility(id, visible);
			}
		});
	}

	console.log(`[LayerVisibility] Dataset ${datasetId} (${layers.length + deckLayerIds.length} layers): ${visibility}`);
}
