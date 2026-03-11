/**
 * Operation rendering - adds computed operation results to the MapLibre map.
 * Extracted from buffer.ts to decouple rendering from computation,
 * enabling compute functions to run in a Web Worker or headless CLI.
 */

import type maplibregl from 'maplibre-gl';
import type { StyleConfig } from '../../db/datasets';
import { getSourceId, addSource, removeDefaultLayers, addDefaultLayers } from '../../layers';

/**
 * Add GeoJSON data to map as source, optionally with default layers.
 * Removes existing source/layers first (for re-running operations).
 *
 * @param skipLayers - When true, only add source (explicit layers defined in config).
 * @returns Layer IDs if layers were created, empty array otherwise.
 */
export function addOperationResultToMap(
	map: maplibregl.Map,
	datasetId: string,
	datasetColor: string,
	style: StyleConfig,
	geoJsonData: GeoJSON.FeatureCollection,
	skipLayers: boolean = false
): string[] {
	const sourceId = getSourceId(datasetId);

	// Remove existing layers and source if present
	removeDefaultLayers(map, datasetId);

	// Add source
	addSource(map, sourceId, geoJsonData);

	// Add default layers only if no explicit layers config
	if (!skipLayers) {
		return addDefaultLayers(map, sourceId, datasetId, datasetColor, style);
	}

	return [];
}
