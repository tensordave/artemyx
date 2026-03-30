import maplibregl from 'maplibre-gl';
import { Protocol as PMTilesProtocol } from 'pmtiles';
import {
	LayerToggleControl, ProgressControl, DataControl, UploadControl,
	StorageControl, BasemapControl, GeocodingControl, ScaleBarControl,
	ConfigControl, OutputsControl, LegendControl, OperationBuilderControl,
	LabelToggleControl,
	attachFeatureClickHandlers, attachFeatureHoverHandlers,
} from './controls';
import { getBasemap, getDefaultBasemap } from './basemaps';
import { loadConfig, parseConfig, getDefaultMapSettings } from './config/parser';
import { loadDatasetsFromConfig } from './data-actions/load';
import { fitMapToBounds } from './data-actions/shared';
import { createExecutionPlan } from './config/operations-graph';
import { executeOperations } from './config/executor';
import { executeLayersFromConfig, resyncLayerOrder, restoreLabelIfConfigured, restoreStoredPaint } from './layers';
import { toggleLayerVisibility } from './layer-actions/visibility';
import { getDisplayColor } from './layer-actions/color';
import { BrowserLogger } from './logger';
import { startInit, ensureInit, getStorageMode, getFallbackReason, hasExistingOPFSData, getDatasets, getDatasetBounds, getFeaturesAsGeoJSON, setLayerOrders, saveViewport, getCachedViewport, setEventHandler, terminateWorker, saveConfig, getSavedConfig, deleteSavedConfig, updateDatasetColor, updateDatasetStyle } from './db';
import { addOperationResultToMap } from './config/operations/render';
import { initShortcuts } from './shortcuts';
import { resolveSubLayerStyle } from './data-actions/load-pmtiles';
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

// Register PMTiles protocol handler before map creation.
// Must precede any source addition that uses pmtiles:// URLs.
export const pmtilesProtocol = new PMTilesProtocol();
maplibregl.addProtocol('pmtiles', pmtilesProtocol.tile);

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

// Accessibility: give the focusable canvas a role and label for screen readers
const canvas = map.getCanvas();
canvas.setAttribute('role', 'application');
canvas.setAttribute('aria-label', 'Interactive map');

// Attribution in bottom-right, below scale bar (added after scale bar below)
const attributionControl = new maplibregl.AttributionControl({
	compact: true,
	customAttribution: '<a href="https://artemyx.org">Artemyx</a> | <a href="https://maplibre.org">MapLibre</a> | <a href="https://protomaps.com">Protomaps</a>'
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
layerToggleControl.setLoadedDatasets(loadedDatasets);
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
	getBasemapId: () => basemapControl.getCurrentBasemapId(),
	onRun: async (yamlText?: string) => {
		outputsControl.clearResults();
		await teardownAll({ map, progressControl, layerToggleControl, loadedDatasets, preserveFileUploads: true });

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

		// Re-render file-uploaded datasets that survived selective teardown
		await restoreNonConfigDatasets(configToRun);
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

const operationBuilderControl = new OperationBuilderControl({
	map,
	logger,
	layerToggleControl,
	loadedDatasets,
});

layerToggleControl.setOperationBuilderControl(operationBuilderControl);

const outputsControl = new OutputsControl({
	getYaml: () => configControl.getYaml(),
	getBasemapId: () => basemapControl.getCurrentBasemapId(),
	openConfigEditor: () => configControl.togglePanel(),
	updateYaml: (yaml: string) => configControl.updateConfig(yaml),
});

// Right-hand controls: only one panel open at a time
dataControl.setOnPanelOpen(() => { uploadControl.closePanel(); operationBuilderControl.closePanel(); configControl.closePanel(); outputsControl.closePanel(); storageControl.closePanel(); });
uploadControl.setOnPanelOpen(() => { dataControl.closePanel(); operationBuilderControl.closePanel(); configControl.closePanel(); outputsControl.closePanel(); storageControl.closePanel(); });
operationBuilderControl.setOnPanelOpen(() => { dataControl.closePanel(); uploadControl.closePanel(); configControl.closePanel(); outputsControl.closePanel(); storageControl.closePanel(); });
storageControl.setOnPanelOpen(() => { dataControl.closePanel(); uploadControl.closePanel(); operationBuilderControl.closePanel(); configControl.closePanel(); outputsControl.closePanel(); });

// ── Side-by-side panel coordinator ──────────────────────────────
// When both Config Editor (680px) and Outputs (380px) are open,
// auto-position them side by side if neither has been user-dragged.
const CONFIG_WIDTH = 680;
const OUTPUTS_WIDTH = 380;
const PANEL_GAP = 24;
const SIDE_BY_SIDE_MIN_VP = CONFIG_WIDTH + OUTPUTS_WIDTH + PANEL_GAP + 40;

let panelsHaveBeenArranged = false;

function arrangePanels(): void {
	if (window.innerWidth < 768) return;

	const bothOpen = configControl.getIsOpen() && outputsControl.getIsOpen();
	const configDragged = configControl.getHasBeenDragged();
	const outputsDragged = outputsControl.getHasBeenDragged();

	if (bothOpen && window.innerWidth >= SIDE_BY_SIDE_MIN_VP) {
		// Side by side: Config | gap | Outputs, aligned tops
		const totalW = CONFIG_WIDTH + PANEL_GAP + OUTPUTS_WIDTH;
		const startX = (window.innerWidth - totalW) / 2;
		const topY = Math.max(20, window.innerHeight * 0.2);

		if (!configDragged) configControl.setPosition(startX, topY);
		if (!outputsDragged) outputsControl.setPosition(startX + CONFIG_WIDTH + PANEL_GAP, topY);
		panelsHaveBeenArranged = true;
	} else if (!panelsHaveBeenArranged) {
		// Only re-center if panels haven't been arranged side-by-side yet
		if (configControl.getIsOpen() && !configDragged) configControl.resetPosition();
		if (outputsControl.getIsOpen() && !outputsDragged) outputsControl.resetPosition();
	}
}

configControl.setOnPanelOpen(() => {
	dataControl.closePanel(); uploadControl.closePanel(); operationBuilderControl.closePanel(); storageControl.closePanel();
	arrangePanels();
});
configControl.setOnPanelClose(() => arrangePanels());
outputsControl.setOnPanelOpen(() => {
	dataControl.closePanel(); uploadControl.closePanel(); operationBuilderControl.closePanel(); storageControl.closePanel();
	arrangePanels();
});
outputsControl.setOnPanelClose(() => arrangePanels());

map.addControl(dataControl, 'top-right');
map.addControl(uploadControl, 'top-right');
map.addControl(operationBuilderControl, 'top-right');
map.addControl(configControl, 'top-right');
map.addControl(outputsControl, 'top-right');
map.addControl(storageControl, 'top-right');
map.addControl(layerToggleControl, 'top-left');
map.addControl(basemapControl, 'top-left');
map.addControl(geocodingControl, 'top-left');
const legendControl = new LegendControl();
map.addControl(legendControl, 'bottom-right');
layerToggleControl.setLegendControl(legendControl);
map.addControl(new ScaleBarControl(), 'bottom-right');
map.addControl(attributionControl, 'bottom-right');
map.addControl(progressControl, 'bottom-left');
const labelToggleControl = new LabelToggleControl();
map.addControl(labelToggleControl, 'top-left');
labelToggleControl.restoreLabels();

// Keyboard shortcuts for panel toggles, WASD pan, R/F zoom
initShortcuts({
	map,
	bindings: [
		{ key: 'l', action: () => layerToggleControl.togglePanel() },
		{ key: 'p', action: () => progressControl.togglePanel() },
		{ key: 'i', action: () => dataControl.togglePanel() },
		{ key: 'u', action: () => uploadControl.togglePanel() },
		{ key: 'c', action: () => configControl.togglePanel() },
		{ key: 't', action: () => storageControl.togglePanel() },
		{ key: '/', action: () => geocodingControl.togglePanel() },
		{ key: 'o', action: () => operationBuilderControl.togglePanel() },
		{ key: 'x', action: () => outputsControl.togglePanel() },
		{ key: 'b', action: () => basemapControl.togglePanel() },
		{ key: 'e', action: () => legendControl.togglePanel() },
		{ key: 'n', action: () => labelToggleControl.toggle() },
	],
	closers: [
		() => layerToggleControl.closePanel(),
		() => dataControl.closePanel(),
		() => uploadControl.closePanel(),
		() => configControl.closePanel(),
		() => operationBuilderControl.closePanel(),
		() => outputsControl.closePanel(),
		() => storageControl.closePanel(),
		() => basemapControl.closePanel(),
		() => geocodingControl.closePanel(),
	],
});

// Surface any config error now that the progress control is in the DOM
if (configError) {
	progressControl.updateProgress('config', 'error', configError);
}

/**
 * Re-render datasets in DuckDB that aren't covered by the given config.
 * Used both for OPFS session restore and to re-render file-uploaded datasets
 * that survived a selective teardown during config re-run.
 */
async function restoreNonConfigDatasets(config: MapConfig | null): Promise<void> {
	const allDatasets = await getDatasets();
	if (allDatasets.length === 0) return;

	// Build set of IDs that config will handle (datasets + operation outputs)
	const configIds = new Set<string>();
	if (config?.datasets) {
		for (const d of config.datasets) configIds.add(d.id);
	}
	if (config?.operations) {
		for (const op of config.operations) configIds.add(op.output);
	}

	// Restore datasets not covered by config.
	// Sub-layer entries (parentId/layer) are skipped if their parent is in config
	// (the config pipeline's loadPMTilesDataset will recreate them).
	const manualDatasets = allDatasets.filter((d: any) => {
		if (configIds.has(d.id)) return false;
		const slashIdx = d.id.lastIndexOf('/');
		if (slashIdx >= 0 && configIds.has(d.id.substring(0, slashIdx))) return false;
		return true;
	});
	if (manualDatasets.length === 0) return;

	console.log(`[Restore] Restoring ${manualDatasets.length} non-config dataset(s)`);

	for (const dataset of manualDatasets) {
		try {
			// PMTiles datasets: re-add vector source from persisted metadata
			if (dataset.format === 'pmtiles' && dataset.source_url) {
				const { getSourceId, addVectorSource, addDefaultVectorLayers } = await import('./layers');
				const sourceId = getSourceId(dataset.id);

				// Sub-layer entries share a source; only create it once
				if (!map.getSource(sourceId)) {
					addVectorSource(map, sourceId, dataset.source_url);
				}

				if (!dataset.hidden && dataset.source_layer) {
					const color = dataset.color || '#3388ff';
					const style = dataset.style ? JSON.parse(dataset.style) : { ...DEFAULT_STYLE };

					// For sub-layer entries ({parentId}/{layer}), use parent ID for layer naming
					const slashIdx = dataset.id.lastIndexOf('/');
					const parentId = slashIdx >= 0 ? dataset.id.substring(0, slashIdx) : dataset.id;
					const layerSuffix = slashIdx >= 0 ? dataset.source_layer : undefined;

					const layerIds = addDefaultVectorLayers(map, sourceId, parentId, color, style, dataset.source_layer, layerSuffix);
					if (layerIds.length > 0) {
						attachFeatureHoverHandlers(map, layerIds, { label: dataset.name || dataset.id });
						attachFeatureClickHandlers(map, layerIds);
					}

					if (!dataset.visible) {
						toggleLayerVisibility(map, dataset.id, false);
					}
				}
				loadedDatasets.add(dataset.id);
				progressControl.updateProgress(dataset.name || dataset.id, 'success', 'Restored PMTiles from session');
				continue;
			}

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
				attachFeatureHoverHandlers(map, layerIds, {
					label: dataset.name || dataset.id
				});
				attachFeatureClickHandlers(map, layerIds);
			}

			progressControl.updateProgress(
				dataset.name || dataset.id,
				'success',
				`Restored from session (${geoJsonData.features.length} features)`
			);
		} catch (e) {
			console.warn(`[Restore] Failed to restore dataset ${dataset.id}:`, e);
			progressControl.updateProgress(dataset.name || dataset.id, 'error', 'Failed to restore from session');
		}
	}

	layerToggleControl.refreshPanel();
}

// Await DB init — progress steps are logged inside the worker's initDB()
// and replayed via the onInitLog callback when the RPC response arrives.
await ensureInit();

if (hasExistingOPFSData()) {
	progressControl.updateProgress('session', 'processing', 'Restoring session from storage...');
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
await restoreNonConfigDatasets(mapConfig);

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

		// Exclude PMTiles datasets from operation inputs (no feature data in DuckDB)
		const datasetIds = config.datasets
			.filter((d) => d.format !== 'pmtiles' && !(!d.format && d.url?.endsWith('.pmtiles')))
			.map((d) => d.id);
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

		// Recompute layer_order so it matches the config's visual intent.
		// For PMTiles sub-entries, index by {source}/{source-layer} so each
		// sub-entry gets its correct position from the config layer order.
		const datasetTopIndex = new Map<string, number>();
		for (let i = 0; i < config.layers.length; i++) {
			const lc = config.layers[i];
			if (lc['source-layer']) {
				datasetTopIndex.set(`${lc.source}/${lc['source-layer']}`, i);
			}
			if (!datasetTopIndex.has(lc.source)) {
				datasetTopIndex.set(lc.source, i);
			}
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

				attachFeatureHoverHandlers(map, [layerId], {
					label,
					fields: tooltipFields
				});
				attachFeatureClickHandlers(map, [layerId]);
			}
		}
	}

	// Sync config layer paint colors back to DuckDB for datasets still at the default color.
	// Without this, restoreStoredPaint() overwrites config-defined paint with #3388ff.
	// Same pattern as resolveSubLayerColor() in load-pmtiles.ts for PMTiles datasets.
	if (config.layers && config.layers.length > 0) {
		try {
			const allDs = await getDatasets();
			const configSources = new Set(config.layers.map(l => l.source));
			for (const ds of allDs) {
				if (!configSources.has(ds.id)) continue;
				if (ds.color && ds.color !== '#3388ff') continue;
				const mapColor = getDisplayColor(map, ds.id, '#3388ff');
				if (mapColor !== '#3388ff') {
					await updateDatasetColor(ds.id, mapColor);
				}
			}
		} catch (e) {
			console.warn('Failed to sync config layer colors to DB:', e);
		}

		// Sync config layer style (opacity, width, radius) back to DuckDB.
		// Without this, restoreStoredPaint() overwrites config paint with DEFAULT_STYLE.
		// Same pattern as resolveSubLayerStyle() used for PMTiles.
		try {
			const allDsStyle = await getDatasets();
			const configSourcesStyle = new Set(config.layers!.map(l => l.source));
			for (const ds of allDsStyle) {
				if (!configSourcesStyle.has(ds.id)) continue;
				const styleOverrides = resolveSubLayerStyle(config.layers, ds.id);
				if (Object.keys(styleOverrides).length > 0) {
					const currentStyle = ds.style ? { ...DEFAULT_STYLE, ...JSON.parse(ds.style) } : { ...DEFAULT_STYLE };
					const merged = { ...currentStyle, ...styleOverrides };
					await updateDatasetStyle(ds.id, merged);
				}
			}
		} catch (e) {
			console.warn('Failed to sync config layer styles to DB:', e);
		}
	}

	// Apply stored visibility state, paint overrides, and labels for all datasets.
	// Must happen after executeLayersFromConfig() so layers actually exist.
	try {
		const currentDatasets = await getDatasets();

		// Restore OPFS-stored color and style overrides on top of config-defined layers.
		// Skips expression-driven paint properties (user can't override those via GUI).
		for (const ds of currentDatasets) {
			const parsedStyle = ds.style ? { ...DEFAULT_STYLE, ...JSON.parse(ds.style) } : { ...DEFAULT_STYLE };
			restoreStoredPaint(map, ds.id, ds.color || '#3388ff', parsedStyle);
		}

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
