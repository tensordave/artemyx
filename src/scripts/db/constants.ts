/**
 * Pure constants, types, and localStorage helpers from the DB layer.
 * This file must NOT import from core.ts or any module that touches DuckDB,
 * so that main-thread code can import it without pulling in a second DB instance.
 */

/**
 * Style configuration for dataset rendering
 */
export interface StyleConfig {
	fillOpacity: number;
	lineOpacity: number;
	pointOpacity: number;
	lineWidth: number;
	pointRadius: number;
	labelField: string | null;
	labelSize: number;
	labelColor: string;
	labelHaloColor: string;
	labelHaloWidth: number;
	labelMinzoom: number;
	labelMaxzoom: number;
	minzoom: number;
	maxzoom: number;
}

/**
 * Default style values applied to new datasets
 */
export const DEFAULT_STYLE: StyleConfig = {
	fillOpacity: 0.2,
	lineOpacity: 0.6,
	pointOpacity: 0.6,
	lineWidth: 2,
	pointRadius: 6,
	labelField: null,
	labelSize: 12,
	labelColor: '#ffffff',
	labelHaloColor: '#000000',
	labelHaloWidth: 1,
	labelMinzoom: 0,
	labelMaxzoom: 24,
	minzoom: 0,
	maxzoom: 24
};

/** Default color for new datasets */
export const DEFAULT_COLOR = '#3388ff';

/**
 * Options for loading GeoJSON with config overrides
 */
export interface LoadGeoJSONOptions {
	/** Override the auto-generated dataset ID (use config ID instead of URL hash) */
	id?: string;
	/** Override the auto-generated dataset name */
	name?: string;
	/** Override the default color */
	color?: string;
	/** Override default style values */
	style?: Partial<StyleConfig>;
	/** When true, dataset is source-only (not rendered or shown in layer panel) */
	hidden?: boolean;
	/**
	 * Source CRS for reprojection. When set, ST_Transform is applied during INSERT
	 * to convert from this CRS to WGS84 (EPSG:4326). Null or undefined = already WGS84.
	 * Resolved via resolveSourceCrs() before calling this function.
	 */
	sourceCrs?: string | null;
}

// ── Viewport persistence (localStorage, no DB) ─────────────────────────────

const VIEWPORT_STORAGE_KEY = 'artemyx-viewport';

/**
 * Save the current map viewport (center + zoom) to localStorage.
 */
export function saveViewport(center: [number, number], zoom: number): void {
	try { localStorage.setItem(VIEWPORT_STORAGE_KEY, JSON.stringify({ center, zoom })); } catch { /* quota or private mode */ }
}

/**
 * Synchronously read the cached viewport from localStorage.
 */
export function getCachedViewport(): { center: [number, number]; zoom: number } | null {
	try {
		const raw = localStorage.getItem(VIEWPORT_STORAGE_KEY);
		if (!raw) return null;
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

/**
 * Clear the saved viewport from localStorage.
 */
export function clearCachedViewport(): void {
	try { localStorage.removeItem(VIEWPORT_STORAGE_KEY); } catch { /* private mode */ }
}
