/**
 * MapLibre layer creation.
 * Provides both individual layer helpers and default layer generation.
 */

import type maplibregl from 'maplibre-gl';
import type { StyleConfig } from '../db/constants';
import type { LayerConfig } from '../config/types';
import { getSourceId } from './sources';
import { getDistinctGeometryTypes } from '../db';

/**
 * Layer info returned by getLayersBySource.
 * Contains the layer ID, type, and current paint properties.
 */
export interface SourceLayerInfo {
	id: string;
	type: 'fill' | 'line' | 'circle' | 'symbol' | 'heatmap' | 'fill-extrusion';
	paint: Record<string, unknown>;
}

/**
 * Generate standard layer IDs for a dataset.
 * Convention: `dataset-{datasetId}-{type}`
 */
export function getLayerIds(datasetId: string): {
	fill: string;
	line: string;
	point: string;
} {
	return {
		fill: `dataset-${datasetId}-fill`,
		line: `dataset-${datasetId}-line`,
		point: `dataset-${datasetId}-point`
	};
}

/**
 * Find all layers that use a specific source.
 * Queries MapLibre's style to discover layers dynamically.
 * Works with both default layers and explicit config-defined layers.
 *
 * @param map - MapLibre map instance
 * @param sourceId - The MapLibre source ID (e.g., 'dataset-streets')
 * @returns Array of layer info objects with id, type, and paint properties
 */
export function getLayersBySource(map: maplibregl.Map, sourceId: string): SourceLayerInfo[] {
	const style = map.getStyle();
	if (!style || !style.layers) {
		return [];
	}

	const result: SourceLayerInfo[] = [];

	for (const layer of style.layers) {
		// Skip layers without a source (e.g., background)
		if (!('source' in layer) || layer.source !== sourceId) {
			continue;
		}

		// Only include layer types we can style
		const validTypes = ['fill', 'line', 'circle', 'symbol', 'heatmap', 'fill-extrusion'];
		if (!validTypes.includes(layer.type)) {
			continue;
		}

		result.push({
			id: layer.id,
			type: layer.type as SourceLayerInfo['type'],
			paint: (layer.paint as Record<string, unknown>) || {}
		});
	}

	return result;
}

/**
 * Remove a layer from the map.
 * No-op if layer doesn't exist.
 */
export function removeLayer(map: maplibregl.Map, layerId: string): void {
	if (map.getLayer(layerId)) {
		map.removeLayer(layerId);
	}
}

/**
 * Remove default layers (fill, line, point) for a dataset.
 * Call before removing the source.
 */
export function removeDefaultLayers(map: maplibregl.Map, datasetId: string): void {
	const ids = getLayerIds(datasetId);
	removeLayer(map, ids.point);
	removeLayer(map, ids.line);
	removeLayer(map, ids.fill);
}

/**
 * Add a fill layer for polygon geometries.
 */
export function addFillLayer(
	map: maplibregl.Map,
	layerId: string,
	sourceId: string,
	color: string,
	opacity: number
): void {
	map.addLayer({
		id: layerId,
		type: 'fill',
		source: sourceId,
		filter: ['==', ['geometry-type'], 'Polygon'],
		paint: {
			'fill-color': color,
			'fill-opacity': opacity
		}
	});
}

/**
 * Add a line layer for linestrings and polygon outlines.
 */
export function addLineLayer(
	map: maplibregl.Map,
	layerId: string,
	sourceId: string,
	color: string,
	width: number,
	opacity: number = 0.6
): void {
	map.addLayer({
		id: layerId,
		type: 'line',
		source: sourceId,
		filter: ['in', ['geometry-type'], ['literal', ['LineString', 'Polygon']]],
		paint: {
			'line-color': color,
			'line-width': width,
			'line-opacity': opacity
		}
	});
}

/**
 * Add a circle layer for point geometries.
 */
export function addCircleLayer(
	map: maplibregl.Map,
	layerId: string,
	sourceId: string,
	color: string,
	radius: number,
	opacity: number = 0.6
): void {
	map.addLayer({
		id: layerId,
		type: 'circle',
		source: sourceId,
		filter: ['==', ['geometry-type'], 'Point'],
		paint: {
			'circle-radius': radius,
			'circle-color': color,
			'circle-opacity': opacity
		}
	});
}

/**
 * Add default layers (fill, line, point) for a dataset.
 * This is the standard three-layer rendering for mixed geometry GeoJSON.
 * Returns the layer IDs for use with popup handlers.
 */
export function addDefaultLayers(
	map: maplibregl.Map,
	sourceId: string,
	datasetId: string,
	color: string,
	style: StyleConfig
): string[] {
	const ids = getLayerIds(datasetId);

	addFillLayer(map, ids.fill, sourceId, color, style.fillOpacity);
	addLineLayer(map, ids.line, sourceId, color, style.lineWidth, style.lineOpacity);
	addCircleLayer(map, ids.point, sourceId, color, style.pointRadius, style.pointOpacity);

	// Apply zoom range if configured (non-default values)
	const layerIds = [ids.fill, ids.line, ids.point];
	if (style.minzoom > 0 || style.maxzoom < 24) {
		for (const id of layerIds) {
			map.setLayerZoomRange(id, style.minzoom, style.maxzoom);
		}
	}

	return layerIds;
}

/**
 * Add a layer from explicit LayerConfig.
 * Translates config source ID to MapLibre source ID and creates the layer.
 *
 * @param map - MapLibre map instance
 * @param config - Layer configuration from YAML
 * @throws Error if source doesn't exist on the map
 */
export function addLayerFromConfig(map: maplibregl.Map, config: LayerConfig): void {
	// Translate config source (dataset/operation ID) to MapLibre source ID
	const sourceId = getSourceId(config.source);

	// Verify source exists
	if (!map.getSource(sourceId)) {
		throw new Error(`Source '${config.source}' (${sourceId}) not found on map`);
	}

	// Build the layer specification
	// Using Record type since our LayerConfig excludes 'background' type,
	// so filter/paint/layout are always valid. MapLibre validates at runtime.
	const layerSpec: Record<string, unknown> = {
		id: config.id,
		type: config.type,
		source: sourceId
	};

	// Add optional properties
	if (config.filter) {
		layerSpec.filter = config.filter;
	}
	if (config.paint) {
		layerSpec.paint = config.paint;
	}
	if (config.layout) {
		layerSpec.layout = config.layout;
	}
	if (config.minzoom !== undefined) {
		layerSpec.minzoom = config.minzoom;
	}
	if (config.maxzoom !== undefined) {
		layerSpec.maxzoom = config.maxzoom;
	}

	map.addLayer(layerSpec as maplibregl.LayerSpecification);
}

/**
 * Reorder MapLibre layers to match the given dataset order.
 * Processes from lowest order (bottom of map) to highest (top), moving each
 * dataset's layers to the top of the stack. After the loop the highest-order
 * dataset's layers sit on top, matching the panel order.
 *
 * @param map - MapLibre map instance
 * @param orderedDatasetIds - Dataset IDs sorted by layer_order DESC (top of panel first)
 */
export function resyncLayerOrder(map: maplibregl.Map, orderedDatasetIds: string[]): void {
	// Iterate in reverse: lowest order first (bottom of map) → moved to top first
	for (let i = orderedDatasetIds.length - 1; i >= 0; i--) {
		const sourceId = getSourceId(orderedDatasetIds[i]);
		const layers = getLayersBySource(map, sourceId);
		for (const layer of layers) {
			if (map.getLayer(layer.id)) {
				map.moveLayer(layer.id);
			}
		}
	}
}

/** Result of executing layers from config */
export interface LayerExecutionResult {
	/** Number of layers successfully created */
	created: number;
	/** Number of layers that failed */
	failed: number;
	/** Layer IDs that were created (for popup handlers) */
	layerIds: string[];
	/** Error messages for failed layers */
	errors: string[];
}

/**
 * Execute all layers from config.
 * Creates MapLibre layers in config order (first = bottom, last = top).
 * Continues on errors to create as many layers as possible.
 *
 * @param map - MapLibre map instance
 * @param layers - Layer configurations from YAML
 * @returns Result with created layer IDs and any errors
 */
export function executeLayersFromConfig(
	map: maplibregl.Map,
	layers: LayerConfig[]
): LayerExecutionResult {
	const result: LayerExecutionResult = {
		created: 0,
		failed: 0,
		layerIds: [],
		errors: []
	};

	if (!layers || layers.length === 0) {
		return result;
	}

	for (const layerConfig of layers) {
		try {
			addLayerFromConfig(map, layerConfig);
			result.layerIds.push(layerConfig.id);
			result.created++;
			console.log(`[Layers] Created layer '${layerConfig.id}' (type: ${layerConfig.type}, source: ${layerConfig.source})`);
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : 'Unknown error';
			result.errors.push(`${layerConfig.id}: ${errorMsg}`);
			result.failed++;
			console.error(`[Layers] Failed to create layer '${layerConfig.id}':`, errorMsg);
		}
	}

	return result;
}

// ── Label layer management ──────────────────────────────────────────

/**
 * Get the label layer ID for a dataset.
 */
export function getLabelLayerId(datasetId: string): string {
	return `dataset-${datasetId}-label`;
}

/**
 * Determine symbol placement based on dataset geometry types.
 * LineString datasets get 'line-center', everything else gets 'point'.
 */
function getSymbolPlacement(geometryTypes: Set<string>): 'point' | 'line-center' {
	const hasLines = geometryTypes.has('LINESTRING') || geometryTypes.has('MULTILINESTRING');
	const hasPolygons = geometryTypes.has('POLYGON') || geometryTypes.has('MULTIPOLYGON');
	const hasPoints = geometryTypes.has('POINT') || geometryTypes.has('MULTIPOINT');

	// Use line-center only when lines are the dominant geometry (no polygons or points)
	if (hasLines && !hasPolygons && !hasPoints) {
		return 'line-center';
	}
	return 'point';
}

/**
 * Add a label (symbol) layer for a dataset.
 * Uses the same source as the data layers.
 */
export function addLabelLayer(
	map: maplibregl.Map,
	datasetId: string,
	style: StyleConfig,
	geometryTypes: Set<string>
): void {
	const labelLayerId = getLabelLayerId(datasetId);
	const sourceId = getSourceId(datasetId);

	if (!style.labelField || !map.getSource(sourceId)) return;

	// Remove existing label layer if present
	if (map.getLayer(labelLayerId)) {
		map.removeLayer(labelLayerId);
	}

	const placement = getSymbolPlacement(geometryTypes);

	const layerSpec: Record<string, unknown> = {
		id: labelLayerId,
		type: 'symbol',
		source: sourceId,
		layout: {
			'text-field': ['get', style.labelField],
			'text-size': style.labelSize,
			'text-font': ['Open Sans Regular'],
			'text-allow-overlap': false,
			'text-padding': 2,
			'text-max-width': 10,
			'symbol-placement': placement
		},
		paint: {
			'text-color': style.labelColor,
			'text-halo-color': style.labelHaloColor,
			'text-halo-width': style.labelHaloWidth
		}
	};

	if (style.labelMinzoom > 0) layerSpec.minzoom = style.labelMinzoom;
	if (style.labelMaxzoom < 24) layerSpec.maxzoom = style.labelMaxzoom;

	map.addLayer(layerSpec as maplibregl.LayerSpecification);
}

/**
 * Remove the label layer for a dataset if it exists.
 */
export function removeLabelLayer(map: maplibregl.Map, datasetId: string): void {
	const labelLayerId = getLabelLayerId(datasetId);
	if (map.getLayer(labelLayerId)) {
		map.removeLayer(labelLayerId);
	}
}

/**
 * Update a single property on the label layer.
 * @param kind - 'paint' or 'layout'
 */
export function updateLabelProperty(
	map: maplibregl.Map,
	datasetId: string,
	kind: 'paint' | 'layout',
	property: string,
	value: unknown
): void {
	const labelLayerId = getLabelLayerId(datasetId);
	if (!map.getLayer(labelLayerId)) return;

	if (kind === 'paint') {
		map.setPaintProperty(labelLayerId, property, value);
	} else {
		map.setLayoutProperty(labelLayerId, property, value);
	}
}

/**
 * Restore a label layer for a dataset if its style has a labelField configured.
 * Called during session restore and config pipeline.
 */
export async function restoreLabelIfConfigured(
	map: maplibregl.Map,
	datasetId: string,
	style: StyleConfig
): Promise<void> {
	if (!style.labelField) return;

	const geometryTypes = await getDistinctGeometryTypes(datasetId);
	addLabelLayer(map, datasetId, style, geometryTypes);
}

/**
 * Apply a zoom range to all layers (fill, line, circle, label) for a dataset.
 * Uses MapLibre's setLayerZoomRange for runtime updates.
 */
export function applyZoomRange(
	map: maplibregl.Map,
	datasetId: string,
	minzoom: number,
	maxzoom: number
): void {
	const sourceId = getSourceId(datasetId);
	const layers = getLayersBySource(map, sourceId);
	for (const layer of layers) {
		map.setLayerZoomRange(layer.id, minzoom, maxzoom);
	}
}

// ── OPFS style restoration ──────────────────────────────────────────

/** Maps layer types to their primary color paint property. */
const COLOR_PROP: Record<string, string> = {
	fill: 'fill-color',
	line: 'line-color',
	circle: 'circle-color',
	symbol: 'text-color',
	heatmap: 'heatmap-color',
	'fill-extrusion': 'fill-extrusion-color'
};

/** Maps style config keys to their target layer type and paint property. */
const STYLE_PROP: Record<string, { layerType: string; paintProperty: string }> = {
	fillOpacity: { layerType: 'fill', paintProperty: 'fill-opacity' },
	lineOpacity: { layerType: 'line', paintProperty: 'line-opacity' },
	pointOpacity: { layerType: 'circle', paintProperty: 'circle-opacity' },
	lineWidth: { layerType: 'line', paintProperty: 'line-width' },
	pointRadius: { layerType: 'circle', paintProperty: 'circle-radius' }
};

/**
 * Re-apply OPFS-stored color and style to all layers for a dataset.
 * Skips expression-driven paint properties (user can't override those via GUI).
 * Called after executeLayersFromConfig() so explicit layers reflect runtime changes.
 */
export function restoreStoredPaint(
	map: maplibregl.Map,
	datasetId: string,
	color: string,
	style: import('../db/constants').StyleConfig
): void {
	const sourceId = getSourceId(datasetId);
	const layers = getLayersBySource(map, sourceId);

	for (const layer of layers) {
		// Color
		const colorProp = COLOR_PROP[layer.type];
		if (colorProp) {
			const current = layer.paint[colorProp];
			if (current !== undefined && !Array.isArray(current) && current !== color) {
				map.setPaintProperty(layer.id, colorProp, color);
			}
		}

		// Style properties (opacity, width, radius)
		for (const [key, mapping] of Object.entries(STYLE_PROP)) {
			if (layer.type !== mapping.layerType) continue;
			const current = layer.paint[mapping.paintProperty];
			if (current !== undefined && !Array.isArray(current)) {
				const stored = style[key as keyof typeof style] as number;
				if (current !== stored) {
					map.setPaintProperty(layer.id, mapping.paintProperty, stored);
				}
			}
		}

		// Zoom range
		if (style.minzoom > 0 || style.maxzoom < 24) {
			map.setLayerZoomRange(layer.id, style.minzoom, style.maxzoom);
		}
	}
}
