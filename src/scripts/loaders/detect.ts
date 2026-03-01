/**
 * Format detection via URL extension and Content-Type heuristics.
 */

import type { DetectedFormat, ConfigFormat } from './types';

/** Extension-to-format mapping */
const EXTENSION_MAP: Record<string, DetectedFormat> = {
	'.geojson': 'geojson',
	'.json': 'geojson',
	'.csv': 'csv',
	'.tsv': 'csv',
	'.parquet': 'geoparquet',
	'.geoparquet': 'geoparquet',
};

/**
 * Path segment keyword mapping for extensionless URLs where the last segment
 * is the format name (e.g. /exports/parquet, /exports/csv, /exports/geojson).
 */
const SEGMENT_MAP: Record<string, DetectedFormat> = {
	'parquet': 'geoparquet',
	'geoparquet': 'geoparquet',
	'geojson': 'geojson',
	'json': 'geojson',
	'csv': 'csv',
};

/** Content-Type prefix-to-format mapping (checked with startsWith) */
const CONTENT_TYPE_MAP: [string, DetectedFormat][] = [
	['application/geo+json', 'geojson'],
	['application/json', 'geojson'],
	['text/csv', 'csv'],
	['text/tab-separated-values', 'csv'],
	['application/vnd.apache.parquet', 'geoparquet'],
	['application/x-parquet', 'geoparquet'],
	['application/octet-stream', 'geoparquet'], // common for parquet downloads
];

/**
 * Extract file extension from a URL path, ignoring query params and fragments.
 * Returns lowercase extension including the dot, or empty string if none found.
 */
function getUrlExtension(url: string): string {
	try {
		const pathname = new URL(url).pathname;
		const lastSegment = pathname.split('/').pop() || '';
		const dotIndex = lastSegment.lastIndexOf('.');
		if (dotIndex === -1) return '';
		return lastSegment.slice(dotIndex).toLowerCase();
	} catch {
		return '';
	}
}

/**
 * Detect data format from URL extension and response Content-Type.
 *
 * Priority:
 * 1. Explicit config format (if provided)
 * 2. URL file extension
 * 3. Content-Type header
 * 4. Falls back to 'geojson' (existing behavior)
 *
 * Note: 'json-array' is never returned by detection - it's resolved
 * at parse time when a JSON response turns out to be a plain array
 * instead of GeoJSON.
 */
export function detectFormat(
	url: string,
	contentType: string | null,
	configFormat?: ConfigFormat
): DetectedFormat {
	// Explicit config override wins
	if (configFormat) {
		return configFormat;
	}

	// Try URL extension
	const ext = getUrlExtension(url);
	if (ext && ext in EXTENSION_MAP) {
		return EXTENSION_MAP[ext];
	}

	// Try last path segment as a format keyword (e.g. /exports/parquet, /exports/csv)
	try {
		const pathname = new URL(url).pathname;
		const segment = (pathname.split('/').pop() || '').toLowerCase();
		if (segment in SEGMENT_MAP) {
			return SEGMENT_MAP[segment];
		}
	} catch { /* invalid URL, ignore */ }

	// Try Content-Type header
	if (contentType) {
		const ct = contentType.toLowerCase().split(';')[0].trim();
		for (const [prefix, format] of CONTENT_TYPE_MAP) {
			if (ct.startsWith(prefix)) {
				return format;
			}
		}
	}

	// Default to geojson (matches existing behavior)
	return 'geojson';
}
