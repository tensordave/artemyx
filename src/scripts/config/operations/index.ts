/**
 * Spatial operations module.
 * Each operation is implemented in its own file and exported here.
 *
 * Operations follow a common pattern:
 * 1. Validate params
 * 2. Execute SQL against DuckDB spatial
 * 3. Register output as new dataset
 * 4. Add source/layers to map
 */

import type maplibregl from 'maplibre-gl';
import type { LayerToggleControl } from '../../controls/layer-control';
import type { Logger } from '../../logger';
import type { LayerConfig, StyleConfigPartial } from '../types';
import type { StyleConfig } from '../../db/datasets';
import { DEFAULT_STYLE } from '../../db/datasets';

/** Result from a pure compute function (no MapLibre dependency) */
export interface ComputeResult {
	outputId: string;
	displayName: string;
	featureCount: number;
	color: string;
	style: StyleConfig;
}

/** Progress callbacks for compute functions (replaces Logger dependency) */
export interface ComputeCallbacks {
	onProgress?: (message: string) => void;
	onInfo?: (tag: string, message: string) => void;
	onWarn?: (tag: string, message: string) => void;
}

/**
 * Create a minimal Logger-compatible object from ComputeCallbacks.
 * Used to bridge compute callbacks to functions that expect Logger (e.g. getProjectedCrs).
 */
export function callbacksToLogger(callbacks?: ComputeCallbacks): Logger {
	return {
		info: (prefix, message) => callbacks?.onInfo?.(prefix, message),
		warn: (prefix, message) => callbacks?.onWarn?.(prefix, message),
		error: (prefix, message) => callbacks?.onWarn?.(prefix, message),
		progress: () => {},
		scheduleIdle: () => {},
	};
}

/** Context passed to all operation executors */
export interface OperationContext {
	map: maplibregl.Map;
	logger: Logger;
	layerToggleControl: LayerToggleControl;
	loadedDatasets: Set<string>;
	/**
	 * Explicit layer configs from YAML.
	 * When defined, skip auto-generating default layers for operation outputs.
	 */
	layers?: LayerConfig[];
	/**
	 * Callback for popup/hover handler attachment.
	 * Called by operations after default layers are created.
	 * Executor provides the implementation that wires both click and hover handlers.
	 */
	onLayersCreated?: (layerIds: string[], label: string) => void;
}

/**
 * Parse style config partial into full StyleConfig with defaults.
 * Shared by all operations.
 */
export function parseStyleConfig(style?: StyleConfigPartial): StyleConfig {
	return {
		fillOpacity: style?.fillOpacity ?? DEFAULT_STYLE.fillOpacity,
		lineOpacity: style?.lineOpacity ?? DEFAULT_STYLE.lineOpacity,
		pointOpacity: style?.pointOpacity ?? DEFAULT_STYLE.pointOpacity,
		lineWidth: style?.lineWidth ?? DEFAULT_STYLE.lineWidth,
		pointRadius: style?.pointRadius ?? DEFAULT_STYLE.pointRadius,
		labelField: style?.labelField ?? DEFAULT_STYLE.labelField,
		labelSize: style?.labelSize ?? DEFAULT_STYLE.labelSize,
		labelColor: style?.labelColor ?? DEFAULT_STYLE.labelColor,
		labelHaloColor: style?.labelHaloColor ?? DEFAULT_STYLE.labelHaloColor,
		labelHaloWidth: style?.labelHaloWidth ?? DEFAULT_STYLE.labelHaloWidth,
		labelMinzoom: style?.labelMinzoom ?? DEFAULT_STYLE.labelMinzoom,
		labelMaxzoom: style?.labelMaxzoom ?? DEFAULT_STYLE.labelMaxzoom,
		minzoom: style?.minzoom ?? DEFAULT_STYLE.minzoom,
		maxzoom: style?.maxzoom ?? DEFAULT_STYLE.maxzoom
	};
}

/**
 * Check whether auto-generated default layers should be skipped for a given output.
 * Returns true only when a `layers` config exists AND at least one layer entry
 * explicitly references this output as its source. Outputs not covered by any
 * layer entry get fallback default layers so they remain visible and interactable.
 */
export function shouldSkipAutoLayers(outputId: string, layers?: LayerConfig[]): boolean {
	return !!layers && layers.some(l => l.source === outputId);
}

// Re-export render utility
export { addOperationResultToMap } from './render';

// Re-export execute wrappers (compute + render)
export { executeBuffer } from './buffer';
export { executeIntersection } from './intersection';
export { executeUnion } from './union';
export { executeDifference } from './difference';
export { executeContains } from './contains';
export { executeDistance } from './distance';
export { executeCentroid } from './centroid';
export { executeAttribute } from './attribute';

// Re-export compute functions (pure SQL, no MapLibre)
export { computeBuffer } from './buffer';
export { computeIntersection } from './intersection';
export { computeUnion } from './union';
export { computeDifference } from './difference';
export { computeContains } from './contains';
export { computeDistance } from './distance';
export { computeCentroid } from './centroid';
export { computeAttribute } from './attribute';
