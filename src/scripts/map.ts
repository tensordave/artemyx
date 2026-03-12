import maplibregl from 'maplibre-gl';
import {
	LayerToggleControl, ProgressControl, DataControl, UploadControl,
	StorageControl, BasemapControl, GeocodingControl, ScaleBarControl,
	ConfigControl, LegendControl, attachFeatureClickHandlers, attachFeatureHoverHandlers,
} from './controls';
import { getBasemap, getDefaultBasemap } from './basemaps';
import { loadConfig, parseConfig, getDefaultMapSettings } from './config/parser';
import { loadDatasetsFromConfig } from './data-actions/load';
import { fitMapToBounds } from './data-actions/shared';
import { createExecutionPlan } from './config/operations-graph';
import { executeOperations } from './config/executor';
import { executeLayersFromConfig, resyncLayerOrder, restoreLabelIfConfigured } from './layers';
import { toggleLayerVisibility } from './layer-actions/visibility';
import { BrowserLogger } from './logger';
import { databaseIcon } from './icons';
import { startInit, ensureInit, getStorageMode, getFallbackReason, hasExistingOPFSData, getDatasets, getDatasetBounds, getFeaturesAsGeoJSON, setLayerOrders, saveViewport, getCachedViewport, setEventHandler, terminateWorker, saveConfig, getSavedConfig, deleteSavedConfig } from './db';
import { addOperationResultToMap } from './config/operations/render';
import { DEFAULT_STYLE } from './db/constants';
import { isSafari } from './utils/safari-detect';
import { showSafariBanner } from './ui/safari-banner';
import { teardownAll } from './teardown';
import type { MapConfig, MapSettings } from './config/types';

// ── Safari gate ──────────────────────────────────────────────────────────────
// DuckDB-WASM + workers exceed Safari's per-tab memory limits.
// On Safari: render basemap with basic controls + warning banner, skip DB entirely.

const safariGated = isSafari();

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
// Skipped on Safari — worker would crash due to per-tab memory limits
if (!safariGated) {
	startInit(useOPFS);
}

// Load config from YAML (needed for map center/zoom even on Safari)
let configError: string | null = null;
let mapConfig: MapConfig | null = null;
let mapSettings: MapSettings;
try {
	const configPath = mapEl?.dataset.config;
	mapConfig = await loadConfig(configPath);
	mapSettings = mapConfig.map;
	console.log('Loaded map config:', mapSettings);
} catch (error) {
	console.warn('Failed to load config, using defaults:', error);
	configError = error instanceof Error ? error.message : 'Failed to load config';
	mapSettings = getDefaultMapSettings();
}

// Restore saved viewport from localStorage (synchronous, no DB wait).
// Only on OPFS-enabled maps — demo/example pages always use config defaults.
if (useOPFS && !safariGated) {
	const cached = getCachedViewport();
	if (cached) {
		mapSettings.center = cached.center;
		mapSettings.zoom = cached.zoom;
	}
}

// Get basemap configuration (from config or default)
const basemap = getBasemap(mapSettings.basemap) ?? getDefaultBasemap();

// Initialize the map with config settings
const map = new maplibregl.Map({
	container: 'map',
	style: {
		version: 8,
		glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
		sources: {
			basemap: basemap.source
		},
		layers: [basemap.layer]
	},
	center: mapSettings.center,
	zoom: mapSettings.zoom,
	attributionControl: false
});

// Attribution in bottom-right, below scale bar (added after scale bar below)
const attributionControl = new maplibregl.AttributionControl({
	compact: true,
	customAttribution: '<a href="https://artemyx.org">Artemyx</a>'
});

// Attribution starts expanded by default (compact: true still opens on init).
// Collapse immediately on load so it shows as a small "i" button.
map.once('load', () => {
	const btn = document.querySelector<HTMLButtonElement>('.maplibregl-ctrl-attrib-button');
	if (btn) btn.click();
});

// ── Safari-gated path: basemap + basic controls + warning banner ─────────────

let layerToggleControl: LayerToggleControl;
let progressControl: ProgressControl;

if (safariGated) {
	layerToggleControl = new LayerToggleControl();
	progressControl = new ProgressControl();
	const basemapControl = new BasemapControl();
	const geocodingControl = new GeocodingControl();

	map.addControl(basemapControl, 'top-left');
	map.addControl(geocodingControl, 'top-left');
	map.addControl(new ScaleBarControl(), 'bottom-right');
	map.addControl(attributionControl, 'bottom-right');

	showSafariBanner(map.getContainer());
} else {

// ── Full path: DuckDB + all controls + config pipeline ───────────────────────

layerToggleControl = new LayerToggleControl();
progressControl = new ProgressControl();
const basemapControl = new BasemapControl();
const geocodingControl = new GeocodingControl();
const storageControl = new StorageControl();
layerToggleControl.setOnPanelOpen(() => { basemapControl.closePanel(); geocodingControl.closePanel(); });
basemapControl.setOnPanelOpen(() => { layerToggleControl.closePanel(); geocodingControl.closePanel(); });
geocodingControl.setOnPanelOpen(() => { layerToggleControl.closePanel(); basemapControl.closePanel(); });
_progressControlRef = progressControl;
const logger = new BrowserLogger(progressControl);

// Wire worker event handler to forward progress/info/warn from worker to UI
setEventHandler({
	onProgress: (op, status, msg) => logger.progress(op, status, msg),
	onInfo: (tag, msg) => logger.info(tag, msg),
	onWarn: (tag, msg) => logger.warn(tag, msg),
	onInitLog: (entries) => progressControl.injectHistory(entries),
});
const dataControl = new DataControl({
	map,
	logger,
	layerToggleControl,
	loadedDatasets
});
const uploadControl = new UploadControl({
	map,
	logger,
	layerToggleControl,
	loadedDatasets
});
const configControl = new ConfigControl({
	onRun: async (yamlText?: string) => {
		await teardownAll({ map, progressControl, layerToggleControl, loadedDatasets });

		let configToRun = mapConfig;
		if (yamlText !== undefined) {
			try {
				configToRun = parseConfig(yamlText);
				mapConfig = configToRun;
			} catch (e) {
				const msg = e instanceof Error ? e.message : 'Invalid config';
				progressControl.updateProgress('config', 'error', msg);
				progressControl.scheduleIdle(5000);
				return;
			}

			// Persist edited config to OPFS (fire-and-forget)
			if (useOPFS) {
				const configPath = mapEl?.dataset.config ?? '/app-config.yaml';
				saveConfig(configPath, yamlText).catch(e =>
					console.warn('[OPFS] Failed to save config:', e)
				);
			}
		}

		if (configToRun) {
			await runConfigPipeline(configToRun);
		}
	},
	onClear: async () => {
		await teardownAll({ map, progressControl, layerToggleControl, loadedDatasets });

		// Remove saved config from OPFS (fire-and-forget)
		if (useOPFS) {
			const configPath = mapEl?.dataset.config ?? '/app-config.yaml';
			deleteSavedConfig(configPath).catch(e =>
				console.warn('[OPFS] Failed to delete saved config:', e)
			);
		}

		progressControl.scheduleIdle(3000);
	},
});

// Right-hand controls: only one panel open at a time
dataControl.setOnPanelOpen(() => { uploadControl.closePanel(); configControl.closePanel(); storageControl.closePanel(); });
uploadControl.setOnPanelOpen(() => { dataControl.closePanel(); configControl.closePanel(); storageControl.closePanel(); });
configControl.setOnPanelOpen(() => { dataControl.closePanel(); uploadControl.closePanel(); storageControl.closePanel(); });
storageControl.setOnPanelOpen(() => { dataControl.closePanel(); uploadControl.closePanel(); configControl.closePanel(); });

map.addControl(dataControl, 'top-right');
map.addControl(uploadControl, 'top-right');
map.addControl(configControl, 'top-right');
map.addControl(storageControl, 'top-right');
map.addControl(layerToggleControl, 'top-left');
map.addControl(basemapControl, 'top-left');
map.addControl(geocodingControl, 'top-left');
map.addControl(new LegendControl(), 'bottom-right');
map.addControl(new ScaleBarControl(), 'bottom-right');
map.addControl(attributionControl, 'bottom-right');
map.addControl(progressControl, 'bottom-left');

// Surface any config error now that the progress control is in the DOM
if (configError) {
	progressControl.updateProgress('config', 'error', configError);
}

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

			// Restore labels if configured in saved style
			await restoreLabelIfConfigured(map, dataset.id, style);

			// Apply stored visibility state (layers are created visible by default)
			// DuckDB-WASM Arrow returns booleans as 0/1, so use falsy check
			if (!dataset.visible) {
				toggleLayerVisibility(map, dataset.id, false);
			}

			if (layerIds.length > 0) {
				const hoverPopup = attachFeatureHoverHandlers(map, layerIds, {
					label: dataset.name || dataset.id
				});
				attachFeatureClickHandlers(map, layerIds, hoverPopup);
			}

			progressControl.updateProgress(
				dataset.name || dataset.id,
				'success',
				`Restored from session (${geoJsonData.features.length} features)`
			);
		} catch (e) {
			console.warn(`[OPFS] Failed to restore manual dataset ${dataset.id}:`, e);
			progressControl.updateProgress(dataset.name || dataset.id, 'error', 'Failed to restore from session');
		}
	}

	layerToggleControl.refreshPanel();
}

// Await DB init and show early progress
progressControl.updateProgress('database', 'processing', 'Initializing database...', databaseIcon);
await ensureInit();

// Init log is replayed via the worker event handler (onInitLog callback)
// which fires when the init RPC response arrives with the log entries.

if (hasExistingOPFSData()) {
	progressControl.updateProgress('session', 'processing', 'Restoring session from storage...');
} else {
	progressControl.updateProgress('database', 'success', 'Database ready');
}

// Restore saved config from OPFS (if user edited + ran in a prior session)
if (useOPFS && mapConfig) {
	const configPath = mapEl?.dataset.config ?? '/app-config.yaml';
	const savedYaml = await getSavedConfig(configPath);
	if (savedYaml) {
		try {
			mapConfig = parseConfig(savedYaml);
			configControl.updateConfig(savedYaml);
			console.log('[OPFS] Restored saved config');
		} catch (e) {
			console.warn('[OPFS] Saved config invalid, using default:', e);
			await deleteSavedConfig(configPath);
		}
	}
}

// Restore manual datasets from OPFS, then sync layer order
await restoreManualDatasets();

// Ensure MapLibre layer stack matches stored layer_order after restore
const restoredDatasets = await getDatasets();
if (restoredDatasets.length > 0) {
	resyncLayerOrder(map, restoredDatasets.filter((d: any) => !d.hidden).map((d: any) => d.id));
}

// DB is now initialized — update storage icon to reflect actual state
storageControl.updateIconColor();

// Warn before navigating away when data is in-memory (would be lost on refresh)
window.addEventListener('beforeunload', (e) => {
	const reason = getFallbackReason();
	if (getStorageMode() === 'memory' && reason !== 'none' && reason !== 'disabled') {
		e.preventDefault();
	}
});

// Clean up resources on page navigation to prevent memory bloat.
// WASM ArrayBuffers are slow to GC — explicit teardown ensures prompt release.
window.addEventListener('pagehide', () => {
	map.remove();          // WebGL context, tile caches, DOM, control onRemove()
	terminateWorker();     // Kill DuckDB worker + sub-workers, release WASM heap
});

// ── Config pipeline (reusable for Run button) ────────────────────────────────

async function runConfigPipeline(config: MapConfig): Promise<void> {
	// Apply map settings (center, zoom, basemap) from config
	const ms = config.map;
	if (ms.basemap) {
		const basemapConfig = getBasemap(ms.basemap);
		if (basemapConfig) basemapControl.setBasemap(basemapConfig);
	}

	if (!config.datasets || config.datasets.length === 0) return;

	console.log(`Loading ${config.datasets.length} dataset(s) from config...`);
	const result = await loadDatasetsFromConfig(config.datasets, {
		map,
		logger,
		layerToggleControl,
		loadedDatasets,
		layers: config.layers,
		mapCrs: config.map.crs,
	});

	if (result.failed > 0) {
		console.warn('Some datasets failed to load:', result.errors);
	}

	// Execute operations after datasets are loaded
	if (config.operations && config.operations.length > 0) {
		console.log(`Executing ${config.operations.length} operation(s) from config...`);

		const datasetIds = config.datasets.map((d) => d.id);
		const plan = createExecutionPlan(datasetIds, config.operations);

		if (!plan.valid) {
			console.error('Invalid operation plan:', plan.errors);
			progressControl.updateProgress('operations', 'error', plan.errors.join('; '));
			return;
		}

		const opResult = await executeOperations(plan, {
			map,
			logger,
			layerToggleControl,
			loadedDatasets,
			layers: config.layers
		});

		if (opResult.failed > 0) {
			console.warn('Some operations failed:', opResult.errors);
		}
	}

	// Fetch all dataset metadata once for layer ordering + visibility restoration below
	const allDatasets = await getDatasets();

	// Execute explicit layers after datasets and operations are ready
	if (config.layers && config.layers.length > 0) {
		console.log(`Creating ${config.layers.length} layer(s) from config...`);
		progressControl.updateProgress('layers', 'processing', `Creating ${config.layers.length} layer(s)...`);

		const layerResult = executeLayersFromConfig(map, config.layers);

		// Recompute layer_order so it matches the config's visual intent
		const datasetTopIndex = new Map<string, number>();
		for (let i = 0; i < config.layers.length; i++) {
			datasetTopIndex.set(config.layers[i].source, i);
		}
		const visible = allDatasets.filter((d: any) => !d.hidden);
		const referenced = visible.filter((d: any) => datasetTopIndex.has(d.id));
		const unreferenced = visible.filter((d: any) => !datasetTopIndex.has(d.id));
		referenced.sort((a: any, b: any) => datasetTopIndex.get(a.id)! - datasetTopIndex.get(b.id)!);
		const finalOrder = [...unreferenced.map((d: any) => d.id), ...referenced.map((d: any) => d.id)];
		await setLayerOrders(finalOrder);

		if (layerResult.failed > 0) {
			console.warn('Some layers failed to create:', layerResult.errors);
			progressControl.updateProgress('layers', 'error', `${layerResult.created} created, ${layerResult.failed} failed`);
		} else {
			progressControl.updateProgress('layers', 'success', `${layerResult.created} layer(s) created`);
		}

		// Attach popup and hover handlers to created layers
		if (layerResult.layerIds.length > 0) {
			const layerConfigMap = new Map(config.layers.map(lc => [lc.id, lc]));
			const sourceNameMap = new Map<string, string>();
			for (const d of config.datasets ?? []) {
				sourceNameMap.set(d.id, d.name || d.id);
			}
			for (const op of config.operations ?? []) {
				sourceNameMap.set(op.output, op.name || op.output);
			}

			for (const layerId of layerResult.layerIds) {
				const lc = layerConfigMap.get(layerId);
				const tooltipFields = lc?.tooltip
					? (Array.isArray(lc.tooltip) ? lc.tooltip : [lc.tooltip])
					: undefined;
				const label = sourceNameMap.get(lc?.source ?? '') || lc?.source || layerId;

				const hoverPopup = attachFeatureHoverHandlers(map, [layerId], {
					label,
					fields: tooltipFields
				});
				attachFeatureClickHandlers(map, [layerId], hoverPopup);
			}
		}
	}

	// Apply stored visibility state and restore labels for all datasets
	// Must happen after executeLayersFromConfig() so layers actually exist
	try {
		const currentDatasets = await getDatasets();

		await Promise.all(currentDatasets.map(async (ds: any) => {
			if (ds.style) {
				const parsedStyle = JSON.parse(ds.style);
				await restoreLabelIfConfigured(map, ds.id, { ...DEFAULT_STYLE, ...parsedStyle });
			}
		}));

		for (const ds of currentDatasets) {
			if (!ds.visible) {
				toggleLayerVisibility(map, ds.id, false);
			}
		}

		resyncLayerOrder(map, currentDatasets.filter((d: any) => !d.hidden).map((d: any) => d.id));
		layerToggleControl.refreshPanel();
	} catch (e) {
		console.warn('[Visibility] Failed to restore visibility state:', e);
	}

	// Fit bounds to all visible data (datasets + operation outputs)
	try {
		const boundsDatasets = config.datasets?.filter(d => d.fitBounds !== false) ?? [];
		const boundsIds = new Set(boundsDatasets.map(d => d.id));
		if (config.operations) {
			for (const op of config.operations) boundsIds.add(op.output);
		}

		const idsToQuery = [...boundsIds].filter(id => loadedDatasets.has(id));
		const bboxResults = await Promise.all(idsToQuery.map(id => getDatasetBounds(id)));

		let merged: [number, number, number, number] | null = null;
		for (const bbox of bboxResults) {
			if (bbox) {
				if (!merged) {
					merged = [...bbox];
				} else {
					merged[0] = Math.min(merged[0], bbox[0]);
					merged[1] = Math.min(merged[1], bbox[1]);
					merged[2] = Math.max(merged[2], bbox[2]);
					merged[3] = Math.max(merged[3], bbox[3]);
				}
			}
		}
		if (merged) {
			fitMapToBounds(map, merged);
		}
	} catch (e) {
		console.warn('[Config] Failed to fit bounds after pipeline:', e);
	}

	progressControl.scheduleIdle(3000);
}

// Run config pipeline on startup
if (mapConfig?.datasets && mapConfig.datasets.length > 0) {
	runConfigPipeline(mapConfig);
} else {
	progressControl.scheduleIdle(3000);
}

// Persist viewport on OPFS-enabled maps (debounced to avoid excessive writes)
if (useOPFS) {
	let moveTimer: ReturnType<typeof setTimeout> | null = null;
	map.on('moveend', () => {
		if (moveTimer) clearTimeout(moveTimer);
		moveTimer = setTimeout(() => {
			const center = map.getCenter();
			saveViewport([center.lng, center.lat], map.getZoom());
		}, 1000);
	});
}

} // end of !safariGated branch

export { map, layerToggleControl, progressControl };
