/**
 * Layer management module.
 * Re-exports source and layer utilities for map rendering.
 */

export { getSourceId, addSource, removeSource, updateSourceData } from './sources';

export {
	getLayerIds,
	getLayersBySource,
	removeLayer,
	removeDefaultLayers,
	addFillLayer,
	addLineLayer,
	addCircleLayer,
	addDefaultLayers,
	addLayerFromConfig,
	executeLayersFromConfig
} from './layers';

export type { LayerExecutionResult } from './layers';
