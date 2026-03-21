/**
 * Layer management module.
 * Re-exports source and layer utilities for map rendering.
 */

export { getSourceId, addSource, addVectorSource, removeSource, updateSourceData } from './sources';

export {
	getLayerIds,
	getLayersBySource,
	getLayersForDataset,
	removeLayer,
	removeDefaultLayers,
	addFillLayer,
	addLineLayer,
	addCircleLayer,
	addDefaultLayers,
	addDefaultVectorLayers,
	addLayerFromConfig,
	executeLayersFromConfig,
	resyncLayerOrder,
	getLabelLayerId,
	addLabelLayer,
	removeLabelLayer,
	updateLabelProperty,
	restoreLabelIfConfigured,
	restoreStoredPaint
} from './layers';

export type { LayerExecutionResult } from './layers';
