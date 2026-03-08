import maplibregl from 'maplibre-gl';
import { getStorageMode } from '../db/core';
import { DEFAULT_STYLE, type StyleConfig } from '../db/datasets';
import { getSourceId, addSource, removeDefaultLayers, addDefaultLayers } from '../layers';
import { showErrorDialog, showConfirmDialog } from '../ui/error-dialog';
import type { ConfigFormat } from '../loaders';
import type { LayerToggleControl } from '../controls/layer-control';
import type { Logger } from '../logger';
import type { LoadGeoJSONOptions as DBLoadOptions } from '../db/datasets';

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
 * Fit map bounds to GeoJSON features
 */
export function fitMapToFeatures(map: maplibregl.Map, geoJsonData: GeoJSON.FeatureCollection): void {
	try {
		const bounds = new maplibregl.LngLatBounds();
		const features = geoJsonData.features;

		features.forEach((feature: any) => {
			const coords = feature.geometry?.coordinates;
			if (!coords || !Array.isArray(coords)) return;

			const extendBounds = (c: any) => {
				if (Array.isArray(c) && c.length >= 2 && typeof c[0] === 'number') {
					bounds.extend(c as [number, number]);
				}
			};

			switch (feature.geometry.type) {
				case 'Point':
					extendBounds(coords);
					break;
				case 'LineString':
				case 'MultiPoint':
					coords.forEach(extendBounds);
					break;
				case 'Polygon':
				case 'MultiLineString':
					coords.forEach((ring: any[]) => ring?.forEach(extendBounds));
					break;
				case 'MultiPolygon':
					coords.forEach((polygon: any[]) => polygon?.[0]?.forEach(extendBounds));
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
