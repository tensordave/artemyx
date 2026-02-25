/**
 * MapLibre source management.
 * Handles adding/removing GeoJSON sources, decoupled from layer creation.
 */

import type maplibregl from 'maplibre-gl';

/**
 * Generate the standard source ID for a dataset.
 * Convention: `dataset-{datasetId}`
 */
export function getSourceId(datasetId: string): string {
	return `dataset-${datasetId}`;
}

/**
 * Add a GeoJSON source to the map.
 * Removes existing source with same ID first (for reloading).
 */
export function addSource(
	map: maplibregl.Map,
	sourceId: string,
	data: GeoJSON.FeatureCollection
): void {
	// Remove existing source if present (must remove layers first)
	if (map.getSource(sourceId)) {
		map.removeSource(sourceId);
	}

	map.addSource(sourceId, {
		type: 'geojson',
		data
	});
}

/**
 * Remove a source from the map.
 * No-op if source doesn't exist.
 */
export function removeSource(map: maplibregl.Map, sourceId: string): void {
	if (map.getSource(sourceId)) {
		map.removeSource(sourceId);
	}
}

/**
 * Update data for an existing GeoJSON source.
 * Throws if source doesn't exist.
 */
export function updateSourceData(
	map: maplibregl.Map,
	sourceId: string,
	data: GeoJSON.FeatureCollection
): void {
	const source = map.getSource(sourceId);
	if (!source) {
		throw new Error(`Source '${sourceId}' not found`);
	}
	if (source.type !== 'geojson') {
		throw new Error(`Source '${sourceId}' is not a GeoJSON source`);
	}
	(source as maplibregl.GeoJSONSource).setData(data);
}
