/**
 * MapLibre source management.
 * Handles adding/removing GeoJSON sources, decoupled from layer creation.
 */

import type maplibregl from 'maplibre-gl';

/**
 * Generate the standard source ID for a dataset.
 * Convention: `dataset-{datasetId}`
 *
 * For PMTiles sub-layer entries (ID format: `parentId/sourceLayer`),
 * extracts the parent ID so all sub-layers resolve to the shared source.
 * e.g. `protomaps/roads` → `dataset-protomaps`
 */
export function getSourceId(datasetId: string): string {
	const slashIdx = datasetId.lastIndexOf('/');
	const baseId = slashIdx >= 0 ? datasetId.substring(0, slashIdx) : datasetId;
	return `dataset-${baseId}`;
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
		data,
		// Reduce MapLibre's internal vector tile cache footprint:
		// - tolerance: simplification during tiling (default 0.375) - slightly higher reduces tile geometry
		// - buffer: tile edge overlap in pixels (default 128) - lower means fewer duplicated features at edges
		tolerance: 0.5,
		buffer: 64,
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
 * Add a vector tile source (PMTiles) to the map.
 * Uses the pmtiles:// protocol handler registered at map init.
 */
export function addVectorSource(
	map: maplibregl.Map,
	sourceId: string,
	pmtilesUrl: string
): void {
	if (map.getSource(sourceId)) {
		map.removeSource(sourceId);
	}

	map.addSource(sourceId, {
		type: 'vector',
		url: `pmtiles://${pmtilesUrl}`,
	});
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
