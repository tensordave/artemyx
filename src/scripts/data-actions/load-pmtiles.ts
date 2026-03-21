/**
 * PMTiles dataset loading.
 * Bypasses the DuckDB/loader pipeline entirely.
 * Adds a MapLibre vector source + metadata-only DuckDB entry.
 *
 * Multi-layer archives create one DuckDB dataset entry per source layer,
 * using the `{parentId}/{sourceLayer}` ID convention. All sub-entries
 * share a single MapLibre vector source.
 */

import type maplibregl from 'maplibre-gl';
import type { DatasetConfig, LayerConfig } from '../config/types';
import type { LayerToggleControl } from '../controls/layer-control';
import type { Logger } from '../logger';
import { DEFAULT_STYLE, type StyleConfig } from '../db/constants';
import { createMetadataDataset, deleteSubDatasets, getDatasetById } from '../db';
import { getSourceId, addVectorSource, addDefaultVectorLayers } from '../layers';
import { attachFeatureClickHandlers, attachFeatureHoverHandlers } from '../controls/popup';
import { getPMTilesMetadata } from '../loaders/pmtiles';
import { fitMapToBounds } from './shared';

/** Distinct colors for multi-layer PMTiles sub-entries. */
const MULTI_LAYER_PALETTE = [
	'#3388ff', '#ef4444', '#22c55e', '#f59e0b', '#8b5cf6',
	'#ec4899', '#06b6d4', '#84cc16', '#f97316',
];

/** Color paint properties in priority order (fill is most visually dominant). */
const COLOR_PAINT_KEYS = ['fill-color', 'line-color', 'circle-color', 'text-color'] as const;

/** Maps MapLibre paint properties to StyleConfig keys. Only simple numeric values are extracted. */
export const PAINT_TO_STYLE: Record<string, keyof StyleConfig> = {
	'fill-opacity': 'fillOpacity',
	'line-opacity': 'lineOpacity',
	'circle-opacity': 'pointOpacity',
	'line-width': 'lineWidth',
	'circle-radius': 'pointRadius',
};

/**
 * Extract the primary color from a config layer's paint for a specific source-layer.
 * Returns null if no config layer matches or the color uses an expression.
 */
function resolveSubLayerColor(
	layers: LayerConfig[] | undefined,
	parentId: string,
	sourceLayerName: string
): string | null {
	if (!layers) return null;

	// Find config layers matching this parent source and source-layer
	const matching = layers.filter(
		l => l.source === parentId && l['source-layer'] === sourceLayerName
	);
	if (matching.length === 0) return null;

	// Extract first simple (non-expression) color value
	for (const layer of matching) {
		if (!layer.paint) continue;
		for (const key of COLOR_PAINT_KEYS) {
			const value = layer.paint[key];
			if (typeof value === 'string') return value;
		}
	}

	return null;
}

/**
 * Extract simple (non-expression) paint values from config layers for a specific source-layer.
 * Returns a partial StyleConfig that can be spread over the base style.
 * Multiple config layers may match (e.g., a fill layer + a line layer) — all are checked.
 */
export function resolveSubLayerStyle(
	layers: LayerConfig[] | undefined,
	parentId: string,
	sourceLayerName?: string
): Partial<StyleConfig> {
	if (!layers) return {};

	const matching = layers.filter(l => {
		if (l.source !== parentId) return false;
		if (sourceLayerName) return l['source-layer'] === sourceLayerName;
		return true;
	});
	if (matching.length === 0) return {};

	const result: Partial<StyleConfig> = {};

	for (const layer of matching) {
		if (!layer.paint) continue;
		for (const [paintKey, styleKey] of Object.entries(PAINT_TO_STYLE)) {
			if (result[styleKey] !== undefined) continue;
			const value = layer.paint[paintKey];
			if (typeof value === 'number') {
				(result as Record<string, number>)[styleKey] = value;
			}
		}
	}

	return result;
}

interface PMTilesLoadOptions {
	map: maplibregl.Map;
	logger: Logger;
	layerToggleControl: LayerToggleControl;
	loadedDatasets: Set<string>;
	layers?: LayerConfig[];
}

/**
 * Load a PMTiles dataset: read metadata, add vector source, create DB entry.
 * Returns true on success, false on failure (errors logged to progress control).
 */
export async function loadPMTilesDataset(
	dataset: DatasetConfig,
	options: PMTilesLoadOptions
): Promise<boolean> {
	const { map, logger, layerToggleControl, loadedDatasets, layers } = options;
	const displayName = dataset.name || dataset.id;
	const isHidden = !!dataset.hidden;

	logger.progress(displayName, 'loading', 'Reading PMTiles metadata...');

	// 1. Read PMTiles header
	const metadata = await getPMTilesMetadata(dataset.url);

	// 2. Validate tile type
	if (metadata.tileType === 'raster') {
		logger.progress(displayName, 'error', 'Raster PMTiles not supported. Only vector (MVT) tiles are supported.');
		return false;
	}
	if (metadata.tileType === 'unknown') {
		logger.warn(displayName, 'Unknown PMTiles tile type, attempting to load as vector tiles');
	}

	// 3. Resolve source layer(s)
	let sourceLayers: string[];
	if (dataset.sourceLayer) {
		// Explicit sourceLayer from config - validate it exists
		if (metadata.layers.length > 0 && !metadata.layers.includes(dataset.sourceLayer)) {
			logger.progress(displayName, 'error',
				`Source layer '${dataset.sourceLayer}' not found. Available layers: ${metadata.layers.join(', ')}`);
			return false;
		}
		sourceLayers = [dataset.sourceLayer];
	} else if (metadata.layers.length > 0) {
		// Auto-use all available layers
		sourceLayers = metadata.layers;
	} else {
		// No layer metadata - use empty string (some PMTiles archives omit vector_layers)
		logger.warn(displayName, 'No vector layer metadata found in PMTiles header. Layer name may need to be specified via sourceLayer config.');
		sourceLayers = [''];
	}

	// 4. Add vector source (skip if already exists — sub-layer entries share one source)
	const sourceId = getSourceId(dataset.id);
	if (!map.getSource(sourceId)) {
		addVectorSource(map, sourceId, dataset.url);
	}

	const baseColor = dataset.color || '#3388ff';
	const style: StyleConfig = { ...DEFAULT_STYLE, ...dataset.style };
	const coveredByConfig = layers?.some(l => l.source === dataset.id);
	const isMultiLayer = sourceLayers.length > 1 && sourceLayers[0] !== '';

	// 5. Create dataset entries + layers
	// Multi-layer archives always create per-layer DB entries (for panel visibility),
	// but only auto-create MapLibre layers when not covered by explicit config layers.
	// Config-defined layers are created separately by executeLayersFromConfig().
	if (isMultiLayer && !isHidden) {
		// ── Multi-layer: one DuckDB entry per source layer ──────────────

		// Preserve user-modified names/colors/styles from existing sublayer entries
		// before deleting. On OPFS session restore the config pipeline re-runs,
		// and without this the user's renames and color changes would be lost.
		const existingSubs = new Map<string, { name: string; color: string; style: string | null }>();
		for (const sl of sourceLayers) {
			if (!sl) continue;
			const subId = `${dataset.id}/${sl}`;
			const existing = await getDatasetById(subId);
			if (existing) {
				existingSubs.set(sl, {
					name: existing.name,
					color: existing.color,
					style: existing.style,
				});
			}
		}

		await deleteSubDatasets(dataset.id);

		for (let i = 0; i < sourceLayers.length; i++) {
			const sl = sourceLayers[i];
			if (!sl) continue;

			const subId = `${dataset.id}/${sl}`;
			const existing = existingSubs.get(sl);
			// Name priority: existing user override > config layer name > default
			const configLayerName = layers?.find(
				l => l.source === dataset.id && l['source-layer'] === sl && l.name
			)?.name;
			const defaultName = `${displayName} - ${sl}`;
			const subName = existing?.name || configLayerName || defaultName;

			// Resolve color: existing user override > config layer paint > dataset color > palette
			const defaultColor = resolveSubLayerColor(layers, dataset.id, sl)
				|| dataset.color
				|| MULTI_LAYER_PALETTE[i % MULTI_LAYER_PALETTE.length];
			const subColor = existing?.color || defaultColor;

			// Merge config layer paint values into style so the panel shows correct values.
			// Existing user style overrides take precedence.
			const defaultStyle = { ...style, ...resolveSubLayerStyle(layers, dataset.id, sl) };
			const subStyle = existing?.style
				? { ...defaultStyle, ...JSON.parse(existing.style) }
				: defaultStyle;

			await createMetadataDataset(
				subId, dataset.url, subName, subColor,
				subStyle, false, 'pmtiles', sl
			);

			// Only auto-create MapLibre layers when not covered by config
			if (!coveredByConfig) {
				const layerIds = addDefaultVectorLayers(
					map, sourceId, dataset.id, subColor, subStyle, sl, sl
				);

				if (layerIds.length > 0) {
					const hoverPopup = attachFeatureHoverHandlers(map, layerIds, { label: subName });
					attachFeatureClickHandlers(map, layerIds, hoverPopup);
				}
			}

			loadedDatasets.add(subId);
		}
	} else {
		// ── Single-layer or hidden: one entry ──────
		const resolvedStyle = { ...style, ...resolveSubLayerStyle(layers, dataset.id, sourceLayers[0] || undefined) };

		await createMetadataDataset(
			dataset.id, dataset.url, displayName, baseColor,
			resolvedStyle, isHidden, 'pmtiles', sourceLayers[0] || undefined
		);

		let layerIds: string[] = [];
		if (!isHidden && !coveredByConfig) {
			const useMultiSuffix = sourceLayers.length > 1;
			for (const sl of sourceLayers) {
				if (sl) {
					layerIds.push(...addDefaultVectorLayers(
						map, sourceId, dataset.id, baseColor, resolvedStyle, sl,
						useMultiSuffix ? sl : undefined
					));
				}
			}
		}

		if (layerIds.length > 0) {
			const hoverPopup = attachFeatureHoverHandlers(map, layerIds, { label: displayName });
			attachFeatureClickHandlers(map, layerIds, hoverPopup);
		}

		loadedDatasets.add(dataset.id);
	}

	// 6. Fit bounds from metadata
	if (metadata.bounds && dataset.fitBounds !== false) {
		fitMapToBounds(map, metadata.bounds);
	}

	layerToggleControl.refreshPanel();

	const layerInfo = sourceLayers.length > 0 && sourceLayers[0] ? ` (${sourceLayers.length} layer${sourceLayers.length > 1 ? 's' : ''})` : '';
	logger.progress(displayName, 'success', `PMTiles loaded${layerInfo}`);

	return true;
}
