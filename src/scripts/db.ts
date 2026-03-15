/**
 * DuckDB-WASM database module
 *
 * Re-exports all public API from the worker RPC client.
 * Import from this file to maintain stable import paths.
 * All calls are transparently routed to the DuckDB Web Worker.
 */

// Core operations (via worker RPC)
export { startInit, ensureInit, getStorageMode, getFallbackReason, setFallbackReason, hasExistingOPFSData, clearOPFS, exportOPFS, importOPFS, getInitLog, terminateWorker, saveConfig, getSavedConfig, deleteSavedConfig } from './db/client';
export type { FallbackReason } from './db/core';

// Dataset CRUD operations (via worker RPC)
export { loadGeoJSON, appendFeatures, updateFeatureCount, getDatasets, getDatasetById, datasetExists, updateDatasetColor, updateDatasetName, updateDatasetVisible, deleteDataset, deleteAllDatasets, swapLayerOrder, setLayerOrders, getNextLayerOrder, getDatasetStyle, updateDatasetStyle, checkpoint, vacuum } from './db/client';

// Feature query operations (via worker RPC)
export { getFeaturesAsGeoJSON, getDatasetBounds, getPropertyKeys, getDistinctGeometryTypes } from './db/client';

// Full pipeline operations (worker-side fetch + parse + insert)
export { loadFromUrl, loadFromBuffer, executeOperationInWorker, getOperations, clearOperations, saveOperationMetadata } from './db/client';

// Event handler for progress/info/warn forwarding from worker
export { setEventHandler } from './db/client';
export type { WorkerEventHandler } from './db/client';

// Utility functions (pure, no DB access - stay on main thread)
export { generateDatasetId, extractDatasetName } from './db/utils';

// Viewport persistence (localStorage, main-thread only)
export { saveViewport, getCachedViewport, clearCachedViewport } from './db/constants';
