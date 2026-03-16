/**
 * Dataset rename orchestrator.
 * Renames a dataset's ID (slug) across DuckDB and MapLibre,
 * preserving all layer state (paint, layout, filters, zoom, handlers).
 */

import maplibregl from 'maplibre-gl';
import { renameDatasetId, updateDatasetName, datasetExists } from '../db';
import { slugifyDatasetId } from '../db/utils';
import { getSourceId, addSource, removeSource } from '../layers/sources';
import { getLayersBySource } from '../layers/layers';
import { removeFeatureHandlers, attachFeatureHoverHandlers, attachFeatureClickHandlers, getHoverOptions } from '../controls/popup';
import type { ProgressControl } from '../controls/progress-control';

interface CapturedLayer {
	id: string;
	type: string;
	paint: Record<string, unknown>;
	layout: Record<string, unknown>;
	filter: unknown;
	minzoom: number | undefined;
	maxzoom: number | undefined;
}

/**
 * Remap a layer ID from old dataset prefix to new.
 */
function remapLayerId(oldLayerId: string, oldDatasetId: string, newDatasetId: string): string {
	const oldPrefix = `dataset-${oldDatasetId}`;
	const newPrefix = `dataset-${newDatasetId}`;
	if (oldLayerId.startsWith(oldPrefix)) {
		return newPrefix + oldLayerId.slice(oldPrefix.length);
	}
	return oldLayerId;
}

/**
 * Rename a dataset: update its ID to a slugified version of the new name.
 * Cascades through DuckDB tables and rebuilds MapLibre sources/layers.
 */
export async function renameDataset(
	map: maplibregl.Map,
	oldId: string,
	newName: string,
	progressControl: ProgressControl
): Promise<{ success: boolean; newId: string }> {
	let newId = slugifyDatasetId(newName);

	// No-op if slug matches current ID — just update display name
	if (newId === oldId) {
		const ok = await updateDatasetName(oldId, newName);
		return { success: ok, newId: oldId };
	}

	// Conflict resolution: append numeric suffix
	if (await datasetExists(newId)) {
		let resolved = false;
		for (let i = 2; i <= 10; i++) {
			const candidate = `${newId}_${i}`;
			if (!(await datasetExists(candidate))) {
				newId = candidate;
				resolved = true;
				break;
			}
		}
		if (!resolved) {
			progressControl.updateProgress('ID conflict — too many datasets with similar names', 'error');
			return { success: false, newId: oldId };
		}
	}

	// 1. Capture MapLibre layer state before teardown
	const oldSourceId = getSourceId(oldId);
	const layers = getLayersBySource(map, oldSourceId);
	const styleLayers = map.getStyle()?.layers || [];

	const captured: CapturedLayer[] = [];
	const hoverOptions = new Map<string, { label: string; fields?: string[] }>();

	for (const layer of layers) {
		// Find full layer spec from style
		const spec = styleLayers.find(l => l.id === layer.id) as any;
		captured.push({
			id: layer.id,
			type: layer.type,
			paint: spec?.paint || {},
			layout: spec?.layout || {},
			filter: spec?.filter,
			minzoom: spec?.minzoom,
			maxzoom: spec?.maxzoom,
		});

		// Capture hover options
		const opts = getHoverOptions(layer.id);
		if (opts) {
			hoverOptions.set(layer.id, opts);
		}
	}

	// Capture source GeoJSON data
	const source = map.getSource(oldSourceId) as maplibregl.GeoJSONSource | undefined;
	let geoJsonData: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
	if (source) {
		// serialize() returns the source spec including data
		const serialized = source.serialize();
		if (serialized?.data && typeof serialized.data === 'object') {
			geoJsonData = serialized.data as GeoJSON.FeatureCollection;
		}
	}

	// 2. DB rename (atomic across tables) — do this before touching MapLibre
	const dbOk = await renameDatasetId(oldId, newId, newName);
	if (!dbOk) {
		progressControl.updateProgress('Failed to rename in database', 'error');
		return { success: false, newId: oldId };
	}

	// 3. Add new source + layers BEFORE removing old ones (flicker-free swap).
	//    Insert each new layer directly before its old counterpart so it occupies
	//    the same z-position. Both sets coexist for one frame.
	const newSourceId = getSourceId(newId);
	addSource(map, newSourceId, geoJsonData);

	const newLayerIds = addLayersBefore(map, captured, newSourceId, oldId, newId);

	// 4. Remove old layers and source (new layers already visible)
	const oldLayerIds = captured.map(l => l.id);
	removeFeatureHandlers(oldLayerIds);
	for (const layer of captured) {
		if (map.getLayer(layer.id)) {
			map.removeLayer(layer.id);
		}
	}
	removeSource(map, oldSourceId);

	// 5. Re-register hover/click handlers on new layer IDs
	registerHandlers(map, newLayerIds, hoverOptions, newName);

	return { success: true, newId };
}

/**
 * Add new layers positioned directly before their old counterparts.
 * Both old and new layers coexist for one frame, preventing flicker.
 */
function addLayersBefore(
	map: maplibregl.Map,
	captured: CapturedLayer[],
	sourceId: string,
	oldDatasetId: string,
	newDatasetId: string
): string[] {
	const newLayerIds: string[] = [];

	for (const layer of captured) {
		const newLayerId = remapLayerId(layer.id, oldDatasetId, newDatasetId);

		const spec: Record<string, unknown> = {
			id: newLayerId,
			type: layer.type,
			source: sourceId,
		};

		if (layer.paint && Object.keys(layer.paint).length > 0) spec.paint = layer.paint;
		if (layer.layout && Object.keys(layer.layout).length > 0) spec.layout = layer.layout;
		if (layer.filter) spec.filter = layer.filter;
		if (layer.minzoom !== undefined) spec.minzoom = layer.minzoom;
		if (layer.maxzoom !== undefined) spec.maxzoom = layer.maxzoom;

		// Insert directly before the old layer so it sits at the same z-position
		map.addLayer(spec as maplibregl.LayerSpecification, layer.id);
		newLayerIds.push(newLayerId);
	}

	return newLayerIds;
}

/**
 * Re-register hover/click handlers on new layer IDs.
 */
function registerHandlers(
	map: maplibregl.Map,
	newLayerIds: string[],
	hoverOptions: Map<string, { label: string; fields?: string[] }>,
	newName?: string
): void {
	if (newLayerIds.length === 0) return;

	// Use the first captured hover options (all layers share the same dataset tooltip)
	let opts: { label: string; fields?: string[] } | undefined;
	for (const [, v] of hoverOptions) {
		opts = v;
		break;
	}

	if (opts) {
		const label = newName ?? opts.label;
		const hoverPopup = attachFeatureHoverHandlers(map, newLayerIds, { label, fields: opts.fields });
		attachFeatureClickHandlers(map, newLayerIds, hoverPopup);
	}
}
