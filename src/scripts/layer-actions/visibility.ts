import maplibregl from 'maplibre-gl';
import { getSourceId } from '../layers';

/**
 * Get all layer IDs that use a given source.
 * Works with both default layers and explicit config layers.
 */
function getLayersBySource(map: maplibregl.Map, sourceId: string): string[] {
	const style = map.getStyle();
	if (!style?.layers) return [];

	return style.layers
		.filter((layer) => 'source' in layer && layer.source === sourceId)
		.map((layer) => layer.id);
}

/**
 * Toggle visibility for all layers associated with a dataset.
 * Finds layers dynamically by source ID, supporting both default
 * and explicit config layers.
 */
export function toggleLayerVisibility(map: maplibregl.Map, datasetId: string, visible: boolean): void {
	const sourceId = getSourceId(datasetId);
	const layerIds = getLayersBySource(map, sourceId);
	const visibility = visible ? 'visible' : 'none';

	for (const layerId of layerIds) {
		if (map.getLayer(layerId)) {
			map.setLayoutProperty(layerId, 'visibility', visibility);
		}
	}

	console.log(`[LayerVisibility] Dataset ${datasetId} (${layerIds.length} layers): ${visibility}`);
}
