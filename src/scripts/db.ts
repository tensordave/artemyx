/**
 * DuckDB-WASM database module
 *
 * Re-exports all public API from submodules.
 * Import from this file to maintain stable import paths.
 */

// Core database operations
export { getDB, getConnection, query, startInit, ensureInit, getStorageMode, getFallbackReason, setFallbackReason, hasExistingOPFSData, clearOPFS } from './db/core';
export type { FallbackReason } from './db/core';

// Dataset CRUD operations
export { loadGeoJSON, getDatasets, datasetExists, updateDatasetColor, updateDatasetName, updateDatasetVisible, deleteDataset } from './db/datasets';

// Feature query operations
export { getFeaturesAsGeoJSON } from './db/features';

// Utility functions (exported for potential external use)
export { generateDatasetId, extractDatasetName } from './db/utils';
