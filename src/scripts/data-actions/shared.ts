import maplibregl from 'maplibre-gl';
import { getStorageMode } from '../db';
import { DEFAULT_STYLE, type StyleConfig, type LoadGeoJSONOptions as DBLoadOptions } from '../db/constants';
import { getSourceId, addSource, removeDefaultLayers, addDefaultLayers } from '../layers';
import { showErrorDialog, showConfirmDialog } from '../ui/error-dialog';
import type { ConfigFormat } from '../loaders';
import type { RendererType } from '../config/types';
import type { LayerToggleControl } from '../controls/layer-control';
import type { Logger } from '../logger';

/**
 * Parse style JSON from dataset, returning defaults if invalid
 */
export function parseDatasetStyle(styleJson: string | null | undefined): StyleConfig {
	if (!styleJson) {
		return { ...DEFAULT_STYLE };
	}
	try {
		const parsed = JSON.parse(styleJson);
		return {
			fillOpacity: parsed.fillOpacity ?? DEFAULT_STYLE.fillOpacity,
			lineOpacity: parsed.lineOpacity ?? DEFAULT_STYLE.lineOpacity,
			pointOpacity: parsed.pointOpacity ?? DEFAULT_STYLE.pointOpacity,
			lineWidth: parsed.lineWidth ?? DEFAULT_STYLE.lineWidth,
			pointRadius: parsed.pointRadius ?? DEFAULT_STYLE.pointRadius,
			labelField: parsed.labelField ?? DEFAULT_STYLE.labelField,
			labelSize: parsed.labelSize ?? DEFAULT_STYLE.labelSize,
			labelColor: parsed.labelColor ?? DEFAULT_STYLE.labelColor,
			labelHaloColor: parsed.labelHaloColor ?? DEFAULT_STYLE.labelHaloColor,
			labelHaloWidth: parsed.labelHaloWidth ?? DEFAULT_STYLE.labelHaloWidth,
		labelMinzoom: parsed.labelMinzoom ?? DEFAULT_STYLE.labelMinzoom,
		labelMaxzoom: parsed.labelMaxzoom ?? DEFAULT_STYLE.labelMaxzoom,
		minzoom: parsed.minzoom ?? DEFAULT_STYLE.minzoom,
		maxzoom: parsed.maxzoom ?? DEFAULT_STYLE.maxzoom
		};
	} catch {
		return { ...DEFAULT_STYLE };
	}
}

const QUOTA_WARN_THRESHOLD = 0.80;

/**
 * Format bytes as a human-readable string (e.g. "45.2 MB").
 */
export function formatBytes(bytes: number): string {
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
export async function checkQuota(): Promise<boolean> {
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

export interface LoadDataOptions {
	map: maplibregl.Map;
	logger: Logger;
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
	 * Skip auto-generating default layers for this dataset.
	 * True when this dataset has explicit layer entries in config.
	 */
	skipLayers?: boolean;
	/**
	 * When true, dataset is loaded into DuckDB only (source-only for operations).
	 * No MapLibre source/layer created, no layer panel entry.
	 */
	hidden?: boolean;
	/** Explicit format override (from config) */
	format?: ConfigFormat;
	/** Latitude column name override (CSV and JSON array formats) */
	latColumn?: string;
	/** Longitude column name override (CSV and JSON array formats) */
	lngColumn?: string;
	/** Combined coordinate column containing "lat, lng" values (CSV and JSON array formats) */
	geoColumn?: string;
	/** Pagination control: true to force, false to disable, object for options, omit for auto-detect */
	paginate?: boolean | { maxPages?: number };
	/** Explicit CRS override from dataset config (e.g. 'EPSG:3005') */
	crs?: string;
	/** Fallback CRS from map-level config (for formats without file metadata) */
	mapCrs?: string;
	/** Renderer override: 'maplibre', 'deckgl', or undefined (auto — defaults to maplibre for now) */
	renderer?: RendererType;
	/** When true, skip geometry detection and load as table-only (non-spatial) dataset */
	tableOnly?: boolean;
}

/**
 * Validate a URL for data loading.
 * Returns the parsed URL if valid, or null with error dialog shown.
 */
export async function validateUrl(url: string): Promise<URL | null> {
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
 * Add data to map as source, optionally with default layers.
 * Removes existing source/layers first (for reloading).
 *
 * @param skipLayers - When true, only add source (explicit layers defined in config).
 *                     When false, auto-generate fill/line/circle layers.
 * @returns Layer IDs if layers were created, empty array otherwise.
 */
export function addDatasetToMap(
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
 * Add a dataset to the map via deck.gl.
 * Fetches data from DuckDB (binary preferred, GeoJSON fallback) and creates
 * a single GeoJsonLayer that handles all geometry types natively.
 * All deck.gl imports are dynamic to preserve lazy-loading.
 *
 * @returns Layer IDs created (single deck.gl layer).
 */
export async function addDatasetToMapDeckGL(
	map: maplibregl.Map,
	datasetId: string,
	datasetColor: string,
	style: StyleConfig,
	displayName: string
): Promise<string[]> {
	const layerId = `dataset-${datasetId}-deckgl`;

	// Fetch data from DuckDB — binary path for zero-copy typed arrays, GeoJSON fallback
	let data: unknown;
	let globalProps: Record<string, unknown>[] | undefined;
	try {
		const { getFeaturesAsBinary } = await import('../db');
		const binary = await getFeaturesAsBinary(datasetId);
		data = binary;
		const { buildGlobalProperties } = await import('../controls/popup');
		globalProps = buildGlobalProperties(binary);
		console.log(`[DeckGL] Using binary data path for '${layerId}'`);
	} catch (err) {
		console.warn(`[DeckGL] Binary path failed for '${layerId}', falling back to GeoJSON:`, err);
		const { getFeaturesAsGeoJSON } = await import('../db');
		data = await getFeaturesAsGeoJSON(datasetId);
	}

	// Build color + style props
	const { buildDeckColorProps } = await import('../deckgl/color');
	const colorProps = buildDeckColorProps(datasetColor, style.fillOpacity, style.lineOpacity, style.pointOpacity);

	// Hover/click callbacks for popup parity
	const { buildDeckHoverCallback, buildDeckClickCallback } = await import('../controls/popup');

	const props: Record<string, unknown> = {
		data,
		...colorProps,
		lineWidthMinPixels: style.lineWidth,
		getPointRadius: style.pointRadius,
		pointRadiusMinPixels: 3,
		onHover: buildDeckHoverCallback(map, layerId, { label: displayName }, globalProps),
		onClick: buildDeckClickCallback(map, layerId, globalProps),
	};

	// Create layer via deck.gl manager
	const { addLayer } = await import('../deckgl/manager');
	await addLayer(map, layerId, props);

	// Register in renderer registry for action routing (visibility, color, delete, style)
	const { registerLayer } = await import('../deckgl/registry');
	registerLayer(layerId, 'deckgl', datasetId);

	return [layerId];
}

/**
 * Fit map bounds to a precomputed bounding box [west, south, east, north].
 * Bounds are computed in DuckDB via ST_Extent (see db/features.ts getDatasetBounds).
 */
export function fitMapToBounds(map: maplibregl.Map, bbox: [number, number, number, number]): void {
	try {
		const bounds = new maplibregl.LngLatBounds();
		bounds.extend([bbox[0], bbox[1]]);
		bounds.extend([bbox[2], bbox[3]]);
		if (!bounds.isEmpty()) {
			map.fitBounds(bounds, { padding: 50, maxZoom: 17 });
		}
	} catch (error) {
		console.error('Failed to fit bounds:', error);
	}
}
