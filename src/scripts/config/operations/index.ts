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
import type { LayerToggleControl } from '../../layer-control';
import type { Logger } from '../../logger';
import type { LayerConfig, StyleConfigPartial } from '../types';
import type { StyleConfig } from '../../db/datasets';
import { DEFAULT_STYLE } from '../../db/datasets';

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
		lineWidth: style?.lineWidth ?? DEFAULT_STYLE.lineWidth,
		pointRadius: style?.pointRadius ?? DEFAULT_STYLE.pointRadius
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

// Re-export operations
export { executeBuffer } from './buffer';
export { executeIntersection } from './intersection';
export { executeUnion } from './union';
export { executeDifference } from './difference';
export { executeContains } from './contains';
export { executeDistance } from './distance';
export { executeCentroid } from './centroid';
export { executeAttribute } from './attribute';
