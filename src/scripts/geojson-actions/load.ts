import maplibregl from 'maplibre-gl';
import { loadGeoJSON, getFeaturesAsGeoJSON, getDatasets, datasetExists } from '../db';
import { DEFAULT_STYLE, type StyleConfig, type LoadGeoJSONOptions as DBLoadOptions } from '../db/datasets';
import { getStorageMode } from '../db/core';
import { getSourceId, addSource, removeDefaultLayers, addDefaultLayers } from '../layers';
import { attachFeatureClickHandlers } from '../popup';
import { showErrorDialog, showConfirmDialog } from '../ui/error-dialog';
import type { LayerToggleControl } from '../layer-control';
import type { ProgressControl } from '../progress-control';
import type { DatasetConfig, LayerConfig } from '../config/types';

/**
 * Parse style JSON from dataset, returning defaults if invalid
 */
function parseDatasetStyle(styleJson: string | null | undefined): StyleConfig {
	if (!styleJson) {
		return { ...DEFAULT_STYLE };
	}
	try {
		const parsed = JSON.parse(styleJson);
		return {
			fillOpacity: parsed.fillOpacity ?? DEFAULT_STYLE.fillOpacity,
			lineWidth: parsed.lineWidth ?? DEFAULT_STYLE.lineWidth,
			pointRadius: parsed.pointRadius ?? DEFAULT_STYLE.pointRadius
		};
	} catch {
		return { ...DEFAULT_STYLE };
	}
}

const QUOTA_WARN_THRESHOLD = 0.80;

/**
 * Format bytes as a human-readable string (e.g. "45.2 MB").
 */
function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Check OPFS storage quota and warn if usage exceeds threshold.
 * Returns true if the load should proceed, false if the user cancelled.
 * Always returns true when OPFS is not active (nothing to protect).
 */
async function checkQuota(): Promise<boolean> {
	if (getStorageMode() !== 'opfs') return true;
	if (!navigator.storage?.estimate) return true;

	try {
		const { usage = 0, quota = 0 } = await navigator.storage.estimate();
		if (quota === 0) return true;

		const usageRatio = usage / quota;
		if (usageRatio >= QUOTA_WARN_THRESHOLD) {
			const pct = Math.round(usageRatio * 100);
			const msg = `Storage is ${pct}% full (${formatBytes(usage)} of ${formatBytes(quota)} used). Loading large datasets may fail or affect stored data. Continue?`;
			return showConfirmDialog('Storage Warning', msg);
		}
	} catch (e) {
		console.warn('[Quota] Failed to check storage estimate:', e);
	}

	return true;
}

interface LoadGeoJSONOptions {
	map: maplibregl.Map;
	progressControl: ProgressControl;
	layerToggleControl: LayerToggleControl;
	loadedDatasets: Set<string>;
	/** Config overrides for name, color, style */
	configOverrides?: DBLoadOptions;
	/** Human-readable label for progress messages (falls back to URL hostname) */
	displayName?: string;
	/** Skip fitting map bounds (used when loading multiple datasets) */
	skipFitBounds?: boolean;
	/** Skip showing error dialog (used when loading from config) */
	skipErrorDialog?: boolean;
	/**
	 * Explicit layer configs from YAML.
	 * When defined, skip auto-generating default layers.
	 */
	layers?: LayerConfig[];
}

/**
 * Validate a URL for GeoJSON loading
 * Returns the parsed URL if valid, or null with error dialog shown
 */
async function validateUrl(url: string): Promise<URL | null> {
	let parsedUrl: URL;
	try {
		parsedUrl = new URL(url);
	} catch {
		await showErrorDialog('Invalid URL', 'The URL format is not valid. Please enter a complete URL starting with https://');
		return null;
	}

	if (parsedUrl.protocol !== 'https:') {
		await showErrorDialog('HTTPS Required', 'Only HTTPS URLs are supported for security reasons.');
		return null;
	}

	return parsedUrl;
}

/**
 * Add GeoJSON data to map as source, optionally with default layers.
 * Removes existing source/layers first (for reloading).
 *
 * @param skipLayers - When true, only add source (explicit layers defined in config).
 *                     When false, auto-generate fill/line/circle layers.
 * @returns Layer IDs if layers were created, empty array otherwise.
 */
function addDatasetToMap(
	map: maplibregl.Map,
	datasetId: string,
	datasetColor: string,
	style: StyleConfig,
	geoJsonData: GeoJSON.FeatureCollection,
	skipLayers: boolean = false
): string[] {
	const sourceId = getSourceId(datasetId);

	// Remove existing layers and source for this dataset if reloading
	removeDefaultLayers(map, datasetId);

	// Add source
	addSource(map, sourceId, geoJsonData);

	// Add default layers only if no explicit layers config
	if (!skipLayers) {
		return addDefaultLayers(map, sourceId, datasetId, datasetColor, style);
	}

	return [];
}

/**
 * Fit map bounds to GeoJSON features
 */
function fitMapToFeatures(map: maplibregl.Map, geoJsonData: GeoJSON.FeatureCollection): void {
	try {
		const bounds = new maplibregl.LngLatBounds();
		const features = geoJsonData.features;

		features.forEach((feature: any) => {
			if (!feature.geometry || !feature.geometry.coordinates) return;

			const extendBounds = (coords: any) => {
				if (Array.isArray(coords) && coords.length >= 2 && typeof coords[0] === 'number') {
					bounds.extend(coords as [number, number]);
				}
			};

			switch (feature.geometry.type) {
				case 'Point':
					extendBounds(feature.geometry.coordinates);
					break;
				case 'LineString':
					feature.geometry.coordinates.forEach(extendBounds);
					break;
				case 'Polygon':
					feature.geometry.coordinates[0].forEach(extendBounds);
					break;
				case 'MultiPoint':
					feature.geometry.coordinates.forEach(extendBounds);
					break;
				case 'MultiLineString':
					feature.geometry.coordinates.forEach((line: any[]) => line.forEach(extendBounds));
					break;
				case 'MultiPolygon':
					feature.geometry.coordinates.forEach((polygon: any[]) => polygon[0].forEach(extendBounds));
					break;
			}
		});

		if (!bounds.isEmpty()) {
			map.fitBounds(bounds, { padding: 50 });
		}
	} catch (boundsError) {
		console.error('Failed to fit bounds:', boundsError);
	}
}

/**
 * Load GeoJSON from a URL into DuckDB and display on map
 * Returns true on success, false on failure
 */
export async function loadGeoJSONFromUrl(
	url: string,
	options: LoadGeoJSONOptions
): Promise<boolean> {
	const { map, progressControl, layerToggleControl, loadedDatasets, configOverrides, displayName, skipFitBounds, skipErrorDialog, layers } = options;
	const hasExplicitLayers = layers !== undefined;

	// Validate URL
	const parsedUrl = await validateUrl(url);
	if (!parsedUrl) {
		return false;
	}

	// Quota preflight — warn if OPFS storage is near capacity
	if (!await checkQuota()) {
		return false;
	}

	// Use caller-supplied label, or fall back to URL hostname
	const datasetName = displayName || parsedUrl.hostname;

	try {
		// Fetch GeoJSON
		console.log(`[GeoJSON] Fetching from ${url}`);
		progressControl.updateProgress(datasetName, 'loading');
		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`HTTP error! status: ${response.status}`);
		}

		// Check Content-Length before parsing (50MB limit)
		const MAX_SIZE_MB = 50;
		const MAX_SIZE_BYTES = MAX_SIZE_MB * 1024 * 1024;
		const contentLength = response.headers.get('Content-Length');
		if (contentLength && parseInt(contentLength, 10) > MAX_SIZE_BYTES) {
			throw new Error(`File too large (>${MAX_SIZE_MB}MB). Content-Length: ${contentLength} bytes`);
		}

		const data = await response.json();

		// Load into DuckDB with optional config overrides
		progressControl.updateProgress(datasetName, 'processing');
		const loaded = await loadGeoJSON(data, url, configOverrides);
		if (!loaded) {
			throw new Error('Failed to load into DuckDB');
		}

		// Get dataset metadata
		const datasets = await getDatasets();
		if (!datasets || datasets.length === 0) {
			throw new Error('No datasets found after loading');
		}

		// Get the most recently loaded dataset
		const dataset = datasets[0];
		const datasetId = dataset.id;
		const datasetColor = dataset.color || '#3388ff';
		const datasetStyle = parseDatasetStyle(dataset.style);

		console.log(`[GeoJSON] Loading dataset ${datasetId} with color ${datasetColor}`);

		// Query data for this specific dataset
		const geoJsonFromDB = await getFeaturesAsGeoJSON(datasetId);

		if (!geoJsonFromDB.features || geoJsonFromDB.features.length === 0) {
			throw new Error('No valid features returned from DuckDB');
		}
		console.log(`[GeoJSON] Displaying ${geoJsonFromDB.features.length} features for dataset ${datasetId}`);

		// Add source and layers to map (skip layers if explicit config exists)
		const layerIds = addDatasetToMap(map, datasetId, datasetColor, datasetStyle, geoJsonFromDB, hasExplicitLayers);

		// Track this dataset
		loadedDatasets.add(datasetId);

		// Attach popup click handlers (only if default layers were created)
		if (layerIds.length > 0) {
			attachFeatureClickHandlers(map, layerIds);
		}

		// Fit map to bounds (unless skipped for batch loading)
		if (!skipFitBounds) {
			fitMapToFeatures(map, geoJsonFromDB);
		}

		// Refresh layer toggle panel
		layerToggleControl.refreshPanel();

		// Show success message
		const featureCount = geoJsonFromDB.features.length;
		progressControl.updateProgress(datasetName, 'success', `Loaded ${featureCount} features`);

		// Only schedule idle for standalone loads — batch loads are managed by the caller
		if (!skipFitBounds) {
			progressControl.scheduleIdle(3000);
		}

		return true;
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : 'Unknown error';
		progressControl.updateProgress(datasetName, 'error', errorMsg);
		if (!skipErrorDialog) {
			await showErrorDialog('Failed to Load GeoJSON', errorMsg);
		}

		// Only schedule idle for standalone loads — batch loads are managed by the caller
		if (!skipErrorDialog) {
			progressControl.scheduleIdle(5000);
		}

		return false;
	}
}

/** Options for loading datasets from config */
interface ConfigLoadOptions {
	map: maplibregl.Map;
	progressControl: ProgressControl;
	layerToggleControl: LayerToggleControl;
	loadedDatasets: Set<string>;
	/**
	 * Explicit layer configs from YAML (Phase 5+).
	 * When defined, skip auto-generating default layers (5e will create them).
	 * When undefined, auto-generate fill/line/circle layers per dataset.
	 */
	layers?: LayerConfig[];
}

/** Result of loading datasets from config */
export interface ConfigLoadResult {
	/** Number of datasets successfully loaded */
	loaded: number;
	/** Number of datasets skipped (already loaded) */
	skipped: number;
	/** Number of datasets that failed to load */
	failed: number;
	/** Error messages for failed datasets */
	errors: string[];
}

/**
 * Load multiple datasets from YAML config.
 * Continues on errors, skips duplicates, fits bounds once at end.
 */
export async function loadDatasetsFromConfig(
	datasets: DatasetConfig[],
	options: ConfigLoadOptions
): Promise<ConfigLoadResult> {
	const { map, progressControl, layerToggleControl, loadedDatasets, layers } = options;
	const result: ConfigLoadResult = {
		loaded: 0,
		skipped: 0,
		failed: 0,
		errors: []
	};

	if (!datasets || datasets.length === 0) {
		return result;
	}

	progressControl.updateProgress('config', 'loading', `Loading ${datasets.length} dataset(s) from config...`);

	const hasExplicitLayers = layers !== undefined;

	for (const dataset of datasets) {
		const displayName = dataset.name || dataset.id;

		// Check for duplicate (by config ID)
		if (loadedDatasets.has(dataset.id)) {
			progressControl.updateProgress(dataset.id, 'success', `Skipped (already loaded)`);
			result.skipped++;
			continue;
		}

		// OPFS restore: if dataset already exists in DuckDB, render from persisted data
		if (await datasetExists(dataset.id)) {
			try {
				const geoJsonData = await getFeaturesAsGeoJSON(dataset.id);
				if (geoJsonData.features && geoJsonData.features.length > 0) {
					const allDatasets = await getDatasets();
					const meta = allDatasets.find((d: any) => d.id === dataset.id);
					const color = meta?.color || dataset.color || '#3388ff';
					const style = parseDatasetStyle(meta?.style);

					addDatasetToMap(map, dataset.id, color, style, geoJsonData, hasExplicitLayers);
					loadedDatasets.add(dataset.id);

					layerToggleControl.refreshPanel();

					progressControl.updateProgress(displayName, 'success', `Restored from session (${geoJsonData.features.length} features)`);
					result.loaded++;
					continue;
				}
			} catch (e) {
				console.warn(`[OPFS] Failed to restore ${dataset.id}, will re-fetch:`, e);
			}
		}

		// Build config overrides from dataset config
		// Use config ID as dataset_id so operations can reference it
		const configOverrides: DBLoadOptions = {
			id: dataset.id,
			name: displayName,
			color: dataset.color,
			style: dataset.style
		};

		// Load dataset with overrides
		const success = await loadGeoJSONFromUrl(dataset.url, {
			map,
			progressControl,
			layerToggleControl,
			loadedDatasets,
			configOverrides,
			displayName,
			skipFitBounds: true,
			skipErrorDialog: true,
			layers
		});

		if (success) {
			result.loaded++;
		} else {
			result.failed++;
			result.errors.push(`${dataset.id}: Failed to load from ${dataset.url}`);
		}
	}

	// Fit bounds to all loaded datasets at end
	if (result.loaded > 0) {
		try {
			const allFeatures = await getFeaturesAsGeoJSON();
			if (allFeatures.features && allFeatures.features.length > 0) {
				fitMapToFeatures(map, allFeatures);
			}
		} catch (e) {
			console.error('Failed to fit bounds after config load:', e);
		}
	}

	// Show summary
	const summaryParts: string[] = [];
	if (result.loaded > 0) summaryParts.push(`${result.loaded} loaded`);
	if (result.skipped > 0) summaryParts.push(`${result.skipped} skipped`);
	if (result.failed > 0) summaryParts.push(`${result.failed} failed`);

	const status = result.failed > 0 ? 'error' : 'success';
	progressControl.updateProgress('config', status, summaryParts.join(', '));

	// Schedule idle — will be auto-cancelled if operations start via updateProgress()
	progressControl.scheduleIdle(result.failed > 0 ? 5000 : 3000);

	return result;
}
