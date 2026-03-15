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
 * Parse filename from a Content-Disposition header value.
 * Handles quoted, unquoted, and RFC 5987 extended (filename*=) notations.
 * Returns null if no filename is found.
 */
function parseContentDispositionFilename(header: string): string | null {
	// Try filename*= first (RFC 5987 extended notation, e.g. UTF-8''data.geojson)
	const extMatch = header.match(/filename\*\s*=\s*(?:UTF-8''|utf-8'')([^;\s]+)/i);
	if (extMatch) {
		try { return decodeURIComponent(extMatch[1]); } catch { /* fall through */ }
	}

	// Try filename= with quotes
	const quotedMatch = header.match(/filename\s*=\s*"([^"]+)"/i);
	if (quotedMatch) return quotedMatch[1];

	// Try filename= without quotes
	const unquotedMatch = header.match(/filename\s*=\s*([^;\s]+)/i);
	if (unquotedMatch) return unquotedMatch[1];

	return null;
}

/**
 * Extract lowercase file extension (including dot) from a filename string.
 */
function getFilenameExtension(filename: string): string {
	const dotIndex = filename.lastIndexOf('.');
	if (dotIndex === -1) return '';
	return filename.slice(dotIndex).toLowerCase();
}

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
 * Detect data format from a filename string (extension-based).
 * Falls back to 'geojson' if no extension matches.
 */
export function detectFormatFromFilename(filename: string): DetectedFormat {
	const ext = getFilenameExtension(filename);
	if (ext && ext in EXTENSION_MAP) {
		return EXTENSION_MAP[ext];
	}
	return 'geojson';
}

/**
 * Detect data format from a local File object.
 * Uses filename extension first, then MIME type from file.type.
 * Falls back to 'geojson' if neither matches.
 */
export function detectFormatFromFile(file: File): DetectedFormat {
	const fromName = detectFormatFromFilename(file.name);
	if (fromName !== 'geojson') return fromName;

	if (file.type) {
		const mimeType = file.type.toLowerCase().split(';')[0].trim();
		for (const [prefix, format] of CONTENT_TYPE_MAP) {
			if (mimeType.startsWith(prefix)) {
				return format;
			}
		}
	}

	return 'geojson';
}

/**
 * Detect data format from response metadata.
 *
 * Priority:
 * 1. Explicit config format (if provided)
 * 2. Content-Disposition filename extension (download endpoints)
 * 3. URL file extension (use response.url for post-redirect accuracy)
 * 4. URL path segment keyword (e.g. /exports/parquet)
 * 5. Content-Type header
 * 6. Falls back to 'geojson' (existing behavior)
 *
 * Note: 'json-array' is never returned by detection - it's resolved
 * at parse time when a JSON response turns out to be a plain array
 * instead of GeoJSON.
 */
export function detectFormat(
	url: string,
	contentType: string | null,
	configFormat?: ConfigFormat,
	contentDisposition?: string | null
): DetectedFormat {
	// Explicit config override wins
	if (configFormat) {
		return configFormat;
	}

	// Try Content-Disposition filename (download endpoints)
	if (contentDisposition) {
		const filename = parseContentDispositionFilename(contentDisposition);
		if (filename) {
			const ext = getFilenameExtension(filename);
			if (ext && ext in EXTENSION_MAP) {
				return EXTENSION_MAP[ext];
			}
		}
	}

	// Try URL extension (callers should pass response.url for post-redirect accuracy)
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
