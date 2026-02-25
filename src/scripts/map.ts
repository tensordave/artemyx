import maplibregl from 'maplibre-gl';
import { LayerToggleControl } from './layer-control';
import { ProgressControl } from './progress-control';
import { GeoJSONControl } from './geojson-control';
import { StorageControl } from './storage-control';
import { BasemapControl } from './basemap-control';
import { getBasemap, getDefaultBasemap } from './basemaps';
import { loadConfig, getDefaultMapSettings } from './config/parser';
import { loadDatasetsFromConfig } from './geojson-actions/load';
import { createExecutionPlan } from './config/operations-graph';
import { executeOperations } from './config/executor';
import { executeLayersFromConfig } from './layers';
import { attachFeatureClickHandlers } from './popup';
import { toggleLayerVisibility } from './layer-actions/visibility';
import { startInit, ensureInit, getStorageMode, getFallbackReason, hasExistingOPFSData } from './db/core';
import { getDatasets, getFeaturesAsGeoJSON } from './db';
import { addOperationResultToMap } from './config/operations/buffer';
import { DEFAULT_STYLE } from './db/datasets';
import type { MapConfig, MapSettings } from './config/types';

// Catch uncaught OOM and other fatal errors so the UI doesn't silently stall
let _progressControlRef: ProgressControl | null = null;

function handleFatalError(message: string) {
	console.error('[Fatal]', message);
	_progressControlRef?.updateProgress('fatal', 'error', message);
}

window.addEventListener('error', (e) => {
	const msg = e.message?.toLowerCase() ?? '';
	if (msg.includes('out of memory') || msg.includes('oom')) {
		handleFatalError('Out of memory - too many features loaded. Try clearing the session.');
	}
});

window.addEventListener('unhandledrejection', (e) => {
	const msg = String(e.reason).toLowerCase();
	if (msg.includes('out of memory') || msg.includes('oom')) {
		handleFatalError('Out of memory - too many features loaded. Try clearing the session.');
	}
});

// Track loaded datasets on the map
const loadedDatasets = new Set<string>();

// Read map element attributes (config path, persistence flag)
const mapEl = document.getElementById('map') as HTMLElement | null;
const useOPFS = mapEl?.dataset.persistence !== 'false';

// Kick off DB initialization early (OPFS or in-memory based on attribute)
startInit(useOPFS);

// Load config from YAML (falls back to defaults on error)
let mapConfig: MapConfig | null = null;
let mapSettings: MapSettings;
try {
	const configPath = mapEl?.dataset.config;
	mapConfig = await loadConfig(configPath);
	mapSettings = mapConfig.map;
	console.log('Loaded map config:', mapSettings);
} catch (error) {
	console.warn('Failed to load config, using defaults:', error);
	mapSettings = getDefaultMapSettings();
}

// Get basemap configuration (from config or default)
const basemap = getBasemap(mapSettings.basemap) ?? getDefaultBasemap();

// Initialize the map with config settings
const map = new maplibregl.Map({
	container: 'map',
	style: {
		version: 8,
		sources: {
			basemap: basemap.source
		},
		layers: [basemap.layer]
	},
	center: mapSettings.center,
	zoom: mapSettings.zoom
});

// Add controls to the map
const layerToggleControl = new LayerToggleControl();
const progressControl = new ProgressControl();
const storageControl = new StorageControl({
	onPanelOpen: () => layerToggleControl.closePanel()
});
layerToggleControl.setOnPanelOpen(() => storageControl.closePanel());
_progressControlRef = progressControl;
const geoJSONControl = new GeoJSONControl({
	map,
	progressControl,
	layerToggleControl,
	loadedDatasets
});
map.addControl(geoJSONControl, 'top-right');
map.addControl(layerToggleControl, 'top-left');
map.addControl(storageControl, 'top-left');
map.addControl(progressControl, 'bottom-left');
map.addControl(new BasemapControl(), 'bottom-right');

/**
 * Restore manually-loaded datasets from OPFS that aren't covered by config.
 * These are datasets the user loaded via the GeoJSON control in a previous session.
 */
async function restoreManualDatasets(): Promise<void> {
	const allDatasets = await getDatasets();
	if (allDatasets.length === 0) return;

	// Build set of IDs that config will handle (datasets + operation outputs)
	const configIds = new Set<string>();
	if (mapConfig?.datasets) {
		for (const d of mapConfig.datasets) configIds.add(d.id);
	}
	if (mapConfig?.operations) {
		for (const op of mapConfig.operations) configIds.add(op.output);
	}

	// Restore datasets not covered by config
	const manualDatasets = allDatasets.filter((d: any) => !configIds.has(d.id));
	if (manualDatasets.length === 0) return;

	console.log(`[OPFS] Restoring ${manualDatasets.length} manual dataset(s) from previous session`);

	for (const dataset of manualDatasets) {
		try {
			const geoJsonData = await getFeaturesAsGeoJSON(dataset.id);
			if (!geoJsonData.features || geoJsonData.features.length === 0) continue;

			const color = dataset.color || '#3388ff';
			const style = dataset.style ? JSON.parse(dataset.style) : { ...DEFAULT_STYLE };

			const layerIds = addOperationResultToMap(map, dataset.id, color, style, geoJsonData);
			loadedDatasets.add(dataset.id);

			// Apply stored visibility state (layers are created visible by default)
			// DuckDB-WASM Arrow returns booleans as 0/1, so use falsy check
			if (!dataset.visible) {
				toggleLayerVisibility(map, dataset.id, false);
			}

			if (layerIds.length > 0) {
				attachFeatureClickHandlers(map, layerIds);
			}

			progressControl.updateProgress(
				dataset.name || dataset.id,
				'success',
				`Restored from session (${geoJsonData.features.length} features)`
			);
		} catch (e) {
			console.warn(`[OPFS] Failed to restore manual dataset ${dataset.id}:`, e);
		}
	}

	layerToggleControl.refreshPanel();
}

// Await DB init and show early progress if restoring from OPFS
await ensureInit();
if (hasExistingOPFSData()) {
	progressControl.updateProgress('session', 'processing', 'Restoring session from storage...');
}

// Restore manual datasets from OPFS, then load config pipeline
await restoreManualDatasets();

// DB is now initialized — update storage icon to reflect actual state
storageControl.updateIconColor();

// Warn before navigating away when data is in-memory (would be lost on refresh)
window.addEventListener('beforeunload', (e) => {
	const reason = getFallbackReason();
	if (getStorageMode() === 'memory' && reason !== 'none' && reason !== 'disabled') {
		e.preventDefault();
	}
});

// Load datasets from config, then execute operations and layers
if (mapConfig?.datasets && mapConfig.datasets.length > 0) {
	console.log(`Loading ${mapConfig.datasets.length} dataset(s) from config...`);
	loadDatasetsFromConfig(mapConfig.datasets, {
		map,
		progressControl,
		layerToggleControl,
		loadedDatasets,
		layers: mapConfig.layers
	}).then(async (result) => {
		if (result.failed > 0) {
			console.warn('Some datasets failed to load:', result.errors);
		}

		// Execute operations after datasets are loaded
		if (mapConfig?.operations && mapConfig.operations.length > 0) {
			console.log(`Executing ${mapConfig.operations.length} operation(s) from config...`);

			// Get dataset IDs for dependency graph
			const datasetIds = mapConfig.datasets?.map((d) => d.id) ?? [];

			// Build execution plan (validates deps, topological sort)
			const plan = createExecutionPlan(datasetIds, mapConfig.operations);

			if (!plan.valid) {
				console.error('Invalid operation plan:', plan.errors);
				progressControl.updateProgress('operations', 'error', plan.errors.join('; '));
				return;
			}

			// Execute operations in order
			const opResult = await executeOperations(plan, {
				map,
				progressControl,
				layerToggleControl,
				loadedDatasets,
				layers: mapConfig.layers
			});

			if (opResult.failed > 0) {
				console.warn('Some operations failed:', opResult.errors);
			}
		}

		// Execute explicit layers after datasets and operations are ready
		if (mapConfig?.layers && mapConfig.layers.length > 0) {
			console.log(`Creating ${mapConfig.layers.length} layer(s) from config...`);
			progressControl.updateProgress('layers', 'processing', `Creating ${mapConfig.layers.length} layer(s)...`);

			const layerResult = executeLayersFromConfig(map, mapConfig.layers);

			if (layerResult.failed > 0) {
				console.warn('Some layers failed to create:', layerResult.errors);
				progressControl.updateProgress('layers', 'error', `${layerResult.created} created, ${layerResult.failed} failed`);
			} else {
				progressControl.updateProgress('layers', 'success', `${layerResult.created} layer(s) created`);
			}

			// Attach popup handlers to created layers
			if (layerResult.layerIds.length > 0) {
				attachFeatureClickHandlers(map, layerResult.layerIds);
			}
		}

		// Apply stored visibility state for all datasets
		// Must happen after executeLayersFromConfig() so layers actually exist
		try {
			const allDatasets = await getDatasets();
			for (const ds of allDatasets) {
				if (!ds.visible) {
					toggleLayerVisibility(map, ds.id, false);
				}
			}
			layerToggleControl.refreshPanel();
		} catch (e) {
			console.warn('[Visibility] Failed to restore visibility state:', e);
		}

		// All pipeline work done — schedule idle after the final status has been visible
		progressControl.scheduleIdle(3000);
	});
}

export { map, layerToggleControl, progressControl };
