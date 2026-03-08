import maplibregl from 'maplibre-gl';
import { updateDatasetColor } from '../db';
import { ProgressControl } from '../controls/progress-control';
import { getLayersBySource, type SourceLayerInfo } from '../layers/layers';
import { getSourceId } from '../layers/sources';

/**
 * Maps layer types to their primary color paint property.
 * Same pattern as STYLE_PROPERTY_MAP in style.ts.
 */
const COLOR_PROPERTY_MAP: Record<SourceLayerInfo['type'], string> = {
	fill: 'fill-color',
	line: 'line-color',
	circle: 'circle-color',
	symbol: 'text-color',
	heatmap: 'heatmap-color',
	'fill-extrusion': 'fill-extrusion-color'
};

/**
 * Check if a paint property value is a MapLibre expression (array).
 * Expressions like ["match", ...] or ["coalesce", ...] can't be replaced with a simple color.
 */
function isExpression(value: unknown): boolean {
	return Array.isArray(value);
}

/**
 * Check if the color picker should be enabled for a dataset.
 * Returns true if at least one layer has a simple (non-expression) color value.
 * Mirrors getEditableProperties() logic in style.ts.
 */
export function isColorPickerEnabled(map: maplibregl.Map, datasetId: string): boolean {
	const sourceId = getSourceId(datasetId);
	const layers = getLayersBySource(map, sourceId);

	for (const layer of layers) {
		const colorProp = COLOR_PROPERTY_MAP[layer.type];
		if (!colorProp) continue;

		const currentValue = layer.paint[colorProp];
		if (currentValue !== undefined && !isExpression(currentValue)) {
			return true;
		}
	}

	return false;
}

/**
 * Read the current display color from MapLibre paint properties.
 * Checks fill layers first (most visually dominant), then line, then circle.
 * Returns the fallback if no simple color value is found.
 */
export function getDisplayColor(
	map: maplibregl.Map,
	datasetId: string,
	fallback: string
): string {
	const sourceId = getSourceId(datasetId);
	const layers = getLayersBySource(map, sourceId);

	// Priority order: fill is the most visually prominent
	const typePriority: SourceLayerInfo['type'][] = ['fill', 'line', 'circle'];

	for (const targetType of typePriority) {
		for (const layer of layers) {
			if (layer.type !== targetType) continue;

			const colorProp = COLOR_PROPERTY_MAP[layer.type];
			const value = layer.paint[colorProp];

			if (typeof value === 'string') {
				return value;
			}
		}
	}

	return fallback;
}

/**
 * Update the color of all layers associated with a dataset.
 * Discovers layers dynamically by source and skips expression-based colors.
 */
export async function updateLayerColor(
	map: maplibregl.Map,
	datasetId: string,
	datasetName: string,
	newColor: string,
	progressControl: ProgressControl
): Promise<void> {
	console.log(`[LayerColor] Changing dataset ${datasetId} color to ${newColor}`);

	progressControl.updateProgress(datasetName, 'processing', 'Updating color');

	await updateDatasetColor(datasetId, newColor);

	// Find all layers for this dataset dynamically (works with both default and config layers)
	const sourceId = getSourceId(datasetId);
	const layers = getLayersBySource(map, sourceId);

	let appliedCount = 0;

	for (const layer of layers) {
		const colorProp = COLOR_PROPERTY_MAP[layer.type];
		if (!colorProp) continue;

		const currentValue = layer.paint[colorProp];
		if (isExpression(currentValue)) {
			console.log(`[LayerColor] Skipping ${layer.id}.${colorProp}: uses expression`);
			continue;
		}

		map.setPaintProperty(layer.id, colorProp, newColor);
		appliedCount++;
	}

	console.log(`[LayerColor] Updated ${appliedCount}/${layers.length} layers for dataset ${datasetId}`);

	progressControl.updateProgress(datasetName, 'success', 'Color updated');
	progressControl.scheduleIdle(2000);
}
