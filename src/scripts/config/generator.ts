/**
 * Generate a YAML config from the current map session state.
 * Reads datasets from DuckDB, map viewport from MapLibre, and
 * serializes to a YAML string suitable for the config editor.
 */

import type { Map } from 'maplibre-gl';
import yaml from 'js-yaml';
import { getDatasets, getOperations } from '../db';
import { DEFAULT_STYLE, DEFAULT_COLOR } from '../db/constants';
import type { StyleConfig } from '../db/constants';
import type { StyleConfigPartial, OutputConfig } from './types';
import { UNARY_OPERATIONS } from './parser';
import { getTooltipFields } from '../controls/popup';

/** Marker for datasets whose URL line needs a post-process comment. */
interface PlaceholderInfo {
	datasetId: string;
	comment: string;
}

/** Generated layer config entry (mirrors LayerConfig shape). */
interface GeneratedLayerConfig {
	id: string;
	source: string;
	name?: string;
	type: string;
	'source-layer'?: string;
	paint?: Record<string, unknown>;
	layout?: Record<string, unknown>;
	filter?: unknown[];
	minzoom?: number;
	maxzoom?: number;
	tooltip?: string | string[];
}

/** Result of layer extraction including which datasets are covered. */
export interface LayerExtractionResult {
	layers: GeneratedLayerConfig[];
	/** Dataset IDs fully covered by explicit layers (style: key should be omitted). */
	coveredDatasetIds: Set<string>;
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Parse the stored style JSON string into a full StyleConfig,
 * filling in defaults for any missing fields.
 */
export function parseStyleJson(styleJson: string | null | undefined): StyleConfig {
	if (!styleJson) return { ...DEFAULT_STYLE };
	try {
		const parsed = JSON.parse(styleJson);
		return { ...DEFAULT_STYLE, ...parsed };
	} catch {
		return { ...DEFAULT_STYLE };
	}
}

/**
 * Diff a dataset's style against DEFAULT_STYLE.
 * Returns only the fields that differ, or undefined if all are defaults.
 */
export function diffStyle(style: StyleConfig): StyleConfigPartial | undefined {
	const partial: Record<string, unknown> = {};
	for (const key of Object.keys(DEFAULT_STYLE) as (keyof StyleConfig)[]) {
		if (style[key] !== DEFAULT_STYLE[key]) {
			partial[key] = style[key];
		}
	}
	return Object.keys(partial).length > 0 ? (partial as StyleConfigPartial) : undefined;
}

/**
 * Round a number to the given number of decimal places.
 */
export function round(value: number, decimals: number): number {
	const factor = Math.pow(10, decimals);
	return Math.round(value * factor) / factor;
}

/**
 * Check if a paint/layout property value is a MapLibre expression (array).
 */
function isExpression(value: unknown): boolean {
	return Array.isArray(value);
}

/** Default layer ID pattern: dataset-{id}-(fill|line|point) */
const DEFAULT_LAYER_RE = /^dataset-(.+)-(fill|line|point)$/;

/** Label layer ID pattern: dataset-{id}-label */
const LABEL_LAYER_RE = /^dataset-(.+)-label$/;

/**
 * Check if a layer ID is a default auto-generated layer.
 * Returns the dataset ID and geometry type if it matches, null otherwise.
 */
function parseDefaultLayerId(layerId: string): { datasetId: string; geoType: string } | null {
	const match = layerId.match(DEFAULT_LAYER_RE);
	if (!match) return null;
	return { datasetId: match[1], geoType: match[2] };
}

/**
 * Check if any value in a paint or layout object is an expression.
 */
function hasAnyExpression(obj?: Record<string, unknown>): boolean {
	if (!obj) return false;
	return Object.values(obj).some(isExpression);
}

/**
 * Deep-compare two values for structural equality.
 * Used for filter comparison against known defaults.
 */
function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return false;
		return a.every((val, i) => deepEqual(val, b[i]));
	}
	return false;
}

/** Known default geometry-type filters created by addDefaultLayers(). */
const DEFAULT_FILTERS: Record<string, unknown[]> = {
	fill: ['==', ['geometry-type'], 'Polygon'],
	line: ['in', ['geometry-type'], ['literal', ['LineString', 'Polygon']]],
	point: ['==', ['geometry-type'], 'Point'],
};

/**
 * Check if a filter is one of the auto-generated default geometry-type filters.
 */
function isDefaultFilter(filter: unknown[] | undefined, geoType: string): boolean {
	if (!filter) return true; // no filter = default behavior
	const defaultFilter = DEFAULT_FILTERS[geoType];
	if (!defaultFilter) return false;
	return deepEqual(filter, defaultFilter);
}

/**
 * Remove undefined values and default layout properties (visibility: 'visible').
 * Returns undefined if the result is empty.
 */
function cleanLayout(layout?: Record<string, unknown>): Record<string, unknown> | undefined {
	if (!layout) return undefined;
	const cleaned: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(layout)) {
		if (value === undefined) continue;
		// visibility: 'visible' is the MapLibre default
		if (key === 'visibility' && value === 'visible') continue;
		cleaned[key] = value;
	}
	return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

/**
 * Remove undefined values from a paint object.
 * Returns undefined if the result is empty.
 */
function cleanPaint(paint?: Record<string, unknown>): Record<string, unknown> | undefined {
	if (!paint) return undefined;
	const cleaned: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(paint)) {
		if (value === undefined) continue;
		cleaned[key] = value;
	}
	return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

// ── Layer extraction ─────────────────────────────────────────────────

/**
 * Extract layer configs from MapLibre's current style state.
 * Identifies non-default layers (custom IDs or expression-valued properties)
 * and builds LayerConfig-shaped objects for YAML serialization.
 *
 * Default layers (dataset-{id}-fill/line/point) with only flat paint values
 * are skipped since they're covered by the dataset's style: key.
 */
export function extractLayerConfigs(map: Map): LayerExtractionResult {
	const result: GeneratedLayerConfig[] = [];
	const coveredDatasetIds = new Set<string>();
	// Track which default layers exist per dataset and which are emitted as explicit
	const defaultLayersByDataset: Record<string, Set<string>> = {};
	const emittedDefaultLayersByDataset: Record<string, Set<string>> = {};

	const style = map.getStyle();
	if (!style?.layers) return { layers: result, coveredDatasetIds };

	for (const layer of style.layers) {
		// Skip layers without a source (background, etc.)
		if (!('source' in layer) || typeof layer.source !== 'string') continue;

		// Only process dataset-sourced layers
		if (!layer.source.startsWith('dataset-')) continue;

		// Skip label layers (managed by dataset style.labelField)
		if (LABEL_LAYER_RE.test(layer.id)) continue;

		// Reverse source ID: dataset-{id} -> {id}
		const logicalSource = layer.source.slice('dataset-'.length);

		// Read source-layer (used by PMTiles vector tile layers)
		const sourceLayer = ('source-layer' in layer)
			? (layer as Record<string, unknown>)['source-layer'] as string | undefined
			: undefined;

		const paint = cleanPaint(layer.paint as Record<string, unknown> | undefined);
		const layout = cleanLayout(layer.layout as Record<string, unknown> | undefined);

		// Check if this is a default layer
		const defaultInfo = parseDefaultLayerId(layer.id);
		if (defaultInfo) {
			// For PMTiles layers, parseDefaultLayerId extracts a wrong datasetId
			// (e.g. "protomaps-water" from "dataset-protomaps-water-fill").
			// Use logicalSource (the parent) for coverage tracking when source-layer is present.
			const trackingId = sourceLayer ? logicalSource : defaultInfo.datasetId;

			// Track this default layer
			if (!defaultLayersByDataset[trackingId]) {
				defaultLayersByDataset[trackingId] = new Set();
			}
			defaultLayersByDataset[trackingId].add(defaultInfo.geoType);

			// Default layer with only flat paint values and no source-layer - skip (covered by style:)
			// PMTiles layers with source-layer must always be emitted as explicit layer configs.
			if (!hasAnyExpression(paint) && !hasAnyExpression(layout) && !sourceLayer) {
				continue;
			}

			// Default layer being emitted (has expressions or source-layer)
			if (!emittedDefaultLayersByDataset[trackingId]) {
				emittedDefaultLayersByDataset[trackingId] = new Set();
			}
			emittedDefaultLayersByDataset[trackingId].add(defaultInfo.geoType);
		}

		// Build the layer config entry
		const entry: GeneratedLayerConfig = {
			id: layer.id,
			source: logicalSource,
			type: layer.type,
		};

		// Add source-layer for PMTiles vector tile layers
		if (sourceLayer) {
			entry['source-layer'] = sourceLayer;
			// Clean up auto-generated layer IDs: dataset-protomaps-water-fill -> water-fill
			const prefix = `dataset-${logicalSource}-`;
			if (entry.id.startsWith(prefix)) {
				entry.id = entry.id.slice(prefix.length);
			}
		}

		// Add tooltip if configured
		const tooltip = getTooltipFields(layer.id);
		if (tooltip && tooltip.length > 0) {
			entry.tooltip = tooltip.length === 1 ? tooltip[0] : tooltip;
		}

		if (paint) entry.paint = paint;
		if (layout) entry.layout = layout;

		// Only include filter if it's not a default geometry-type filter
		const filter = layer.filter as unknown[] | undefined;
		if (defaultInfo) {
			if (!isDefaultFilter(filter, defaultInfo.geoType)) {
				entry.filter = filter;
			}
		} else if (filter) {
			entry.filter = filter;
		}

		// minzoom/maxzoom: only include non-default values
		if (layer.minzoom !== undefined && layer.minzoom > 0) {
			entry.minzoom = layer.minzoom;
		}
		if (layer.maxzoom !== undefined && layer.maxzoom < 24) {
			entry.maxzoom = layer.maxzoom;
		}

		result.push(entry);
	}

	// Determine which datasets are fully covered by explicit layers.
	// A dataset is "covered" if all its default layers were emitted as explicit entries,
	// OR if it has no default layers (only custom/explicit layers).
	// For non-default layers, track the source datasets that have explicit layers.
	const datasetsWithExplicitLayers = new Set<string>();
	for (const entry of result) {
		datasetsWithExplicitLayers.add(entry.source);
	}

	for (const datasetId of datasetsWithExplicitLayers) {
		const defaultLayers = defaultLayersByDataset[datasetId];
		if (!defaultLayers) {
			// No default layers exist for this dataset - it's fully covered by explicit layers
			coveredDatasetIds.add(datasetId);
			continue;
		}
		const emitted = emittedDefaultLayersByDataset[datasetId];
		if (emitted && emitted.size === defaultLayers.size) {
			// All default layers for this dataset were emitted (had expressions)
			coveredDatasetIds.add(datasetId);
		}
	}

	return { layers: result, coveredDatasetIds };
}

// ── Main generator ───────────────────────────────────────────────────

/**
 * Generate a YAML config string from the current map session state.
 *
 * @param map - MapLibre map instance (for center/zoom)
 * @param basemapId - Current basemap ID from BasemapControl
 * @param currentOutputs - Optional outputs from current config to round-trip
 * @returns YAML string ready for the config editor
 */
export async function generateConfigYaml(map: Map, basemapId: string, currentOutputs?: OutputConfig[]): Promise<string> {
	const center = map.getCenter();
	const zoom = map.getZoom();

	const datasets = await getDatasets();
	const operations = await getOperations();
	const operationOutputIds = new Set(operations.map(op => op.output_id));

	// Extract layers before building config so we know which datasets are covered
	const { layers: layerConfigs, coveredDatasetIds } = extractLayerConfigs(map);

	// Map of PMTiles parent IDs to their display names (for layer name resolution)
	const pmtilesParentNames: Record<string, string> = {};

	// Build the config object
	const config: Record<string, unknown> = {
		map: {
			center: [round(center.lng, 4), round(center.lat, 4)],
			zoom: round(zoom, 1),
			basemap: basemapId,
		},
	};

	// Track datasets needing URL comments
	const placeholders: PlaceholderInfo[] = [];

	if (datasets.length > 0) {
		// Sort by layer_order ASC (bottom-first = first in YAML, matching config convention)
		// getDatasets() returns DESC, so reverse
		const sorted = [...datasets].reverse();

		// Collapse PMTiles sub-datasets (protomaps/water, protomaps/roads, etc.)
		// into a single parent dataset entry (protomaps).
		const pmtilesSubIds = new Set<string>();
		const pmtilesParents: Record<string, { url: string; name: string }> = {};

		for (const ds of sorted) {
			if (ds.format === 'pmtiles' && ds.id.includes('/')) {
				const parentId = ds.id.substring(0, ds.id.lastIndexOf('/'));
				pmtilesSubIds.add(ds.id);
				if (!(parentId in pmtilesParents)) {
					// Derive parent name by stripping " - sourceLayer" suffix
					const sourceLayer = ds.id.substring(ds.id.lastIndexOf('/') + 1);
					const suffix = ` - ${sourceLayer}`;
					const parentName = ds.name?.endsWith(suffix)
						? ds.name.slice(0, -suffix.length)
						: parentId;
					pmtilesParents[parentId] = {
						url: ds.source_url ?? '',
						name: parentName,
					};
					pmtilesParentNames[parentId] = parentName;
				}
			}
		}

		const datasetEntries: Record<string, unknown>[] = [];
		const emittedParentIds = new Set<string>();

		for (const ds of sorted) {
			// Skip operation outputs - they go in the operations: section
			if (operationOutputIds.has(ds.id)) continue;
			// Skip PMTiles sub-datasets - collapsed into parent entry
			if (pmtilesSubIds.has(ds.id)) continue;

			const entry: Record<string, unknown> = { id: ds.id };

			// Determine URL and track placeholders
			const sourceUrl: string | null = ds.source_url;
			if (sourceUrl && sourceUrl.startsWith('file://')) {
				const filename = sourceUrl.slice(7); // strip "file://"
				entry.url = '';
				entry.sourceFile = filename;
				placeholders.push({ datasetId: ds.id, comment: `# uploaded from: ${filename}` });
			} else if (!sourceUrl) {
				entry.url = '';
				placeholders.push({ datasetId: ds.id, comment: '# no source URL' });
			} else {
				entry.url = sourceUrl;
			}

			// Only include non-default/non-obvious fields
			if (ds.name && ds.name !== ds.id) {
				entry.name = ds.name;
			}
			if (ds.color && ds.color !== DEFAULT_COLOR) {
				entry.color = ds.color;
			}
			if (ds.hidden) {
				entry.hidden = true;
			}
			if (!ds.visible) {
				entry.visible = false;
			}
			if (ds.source_crs) {
				entry.crs = ds.source_crs;
			}
			if (ds.format) {
				entry.format = ds.format;
			}
			// Don't emit sourceLayer for parent PMTiles entries (layers handle this)
			if (ds.source_layer && !(ds.format === 'pmtiles' && ds.id in pmtilesParents)) {
				entry.sourceLayer = ds.source_layer;
			}

			// Omit style: when this dataset is fully covered by explicit layers
			if (!coveredDatasetIds.has(ds.id)) {
				const styleDiff = diffStyle(parseStyleJson(ds.style));
				if (styleDiff) {
					entry.style = styleDiff;
				}
			}

			datasetEntries.push(entry);
			if (ds.id in pmtilesParents) {
				emittedParentIds.add(ds.id);
			}
		}

		// Emit synthetic parent entries for PMTiles archives that have no standalone DuckDB row
		for (const parentId of Object.keys(pmtilesParents)) {
			if (emittedParentIds.has(parentId)) continue;

			const info = pmtilesParents[parentId];
			const entry: Record<string, unknown> = {
				id: parentId,
				url: info.url,
				format: 'pmtiles',
			};
			if (info.name !== parentId) {
				entry.name = info.name;
			}
			datasetEntries.push(entry);
		}

		if (datasetEntries.length > 0) {
			config.datasets = datasetEntries;
		}
	}

	// Build operations section from persisted metadata
	if (operations.length > 0) {
		const unaryTypes = new Set<string>(UNARY_OPERATIONS);

		const operationEntries = operations.map(op => {
			const inputs: string[] = JSON.parse(op.inputs_json);
			const entry: Record<string, unknown> = { type: op.type };

			// Unary vs binary input key
			if (unaryTypes.has(op.type)) {
				entry.input = inputs[0];
			} else {
				entry.inputs = inputs;
			}

			entry.output = op.output_id;

			// Params (skip if null/empty)
			if (op.params_json) {
				try {
					const params = JSON.parse(op.params_json);
					if (Object.keys(params).length > 0) {
						entry.params = params;
					}
				} catch { /* skip malformed */ }
			}

			// Read name/color/style from datasets table (reflects runtime changes)
			const ds = datasets.find(d => d.id === op.output_id);
			if (ds) {
				if (ds.name && ds.name !== op.output_id) {
					entry.name = ds.name;
				}
				if (ds.color && ds.color !== DEFAULT_COLOR) {
					entry.color = ds.color;
				}
				if (!ds.visible) {
					entry.visible = false;
				}
				if (!coveredDatasetIds.has(ds.id)) {
					const styleDiff = diffStyle(parseStyleJson(ds.style));
					if (styleDiff) {
						entry.style = styleDiff;
					}
				}
			}

			return entry;
		});

		config.operations = operationEntries;
	}

	// Enrich layer configs with display names from DuckDB sub-entries.
	// For PMTiles layers with source-layer, look up the sub-dataset name and
	// emit it if the user renamed it from the default "{parent} - {sourceLayer}".
	if (layerConfigs.length > 0) {
		for (const lc of layerConfigs) {
			if (!lc['source-layer']) continue;
			const subId = `${lc.source}/${lc['source-layer']}`;
			const subDs = datasets.find(d => d.id === subId);
			if (!subDs?.name) continue;

			// Derive the default name pattern to detect user renames
			const parentName = datasets.find(d => d.id === lc.source)?.name
				|| pmtilesParentNames[lc.source]
				|| lc.source;
			const defaultName = `${parentName} - ${lc['source-layer']}`;
			if (subDs.name !== defaultName) {
				lc.name = subDs.name;
			}
		}
		config.layers = layerConfigs;
	}

	// Round-trip outputs from current config (outputs have no DuckDB state)
	if (currentOutputs && currentOutputs.length > 0) {
		config.outputs = currentOutputs.map((o) => {
			const entry: Record<string, unknown> = {
				source: o.source,
				format: o.format,
			};
			if (o.filename && o.filename !== o.source) {
				entry.filename = o.filename;
			}
			return entry;
		});
	}

	// Serialize to YAML
	let yamlStr = yaml.dump(config, {
		lineWidth: -1,
		noRefs: true,
		quotingType: '"',
	});

	// Post-process: add comments for placeholder URLs.
	// Walk lines to find each dataset's `url: ""` and append the comment.
	// Line-based approach is robust against property ordering and quoting.
	if (placeholders.length > 0) {
		const commentByDatasetId: Record<string, string> = {};
		for (const p of placeholders) commentByDatasetId[p.datasetId] = p.comment;
		const lines = yamlStr.split('\n');
		let currentDatasetId: string | null = null;

		for (let i = 0; i < lines.length; i++) {
			// Detect dataset id lines: `  - id: "value"` or `  - id: value`
			const idMatch = lines[i].match(/^\s+-\s+id:\s+"?([^"]+)"?\s*$/);
			if (idMatch) {
				currentDatasetId = idMatch[1];
				continue;
			}
			// Within a dataset block, find the url: "" line
			if (currentDatasetId && currentDatasetId in commentByDatasetId) {
				const urlMatch = lines[i].match(/^(\s+url:\s*""\s*)$/);
				if (urlMatch) {
					lines[i] = urlMatch[1].trimEnd() + '  ' + commentByDatasetId[currentDatasetId];
					currentDatasetId = null;
				}
			}
		}

		yamlStr = lines.join('\n');
	}

	return yamlStr;
}
