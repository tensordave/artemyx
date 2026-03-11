/**
 * Loader registry and dispatch.
 * Routes a fetch Response to the appropriate format loader based on detection.
 */

export type { DetectedFormat, ConfigFormat, LoaderData, LoaderOptions, LoaderResult, FormatLoader } from './types';
export { detectFormat, detectFormatFromFile } from './detect';
export { normalizeGeoJSON } from './geojson';
export { detectCoordinateColumns } from './columns';
export { tryLoadJsonArray } from './json-array';

import type { DetectedFormat, LoaderData, LoaderOptions, LoaderResult } from './types';
import { extractGeoJsonCrs } from './geojson';
import { tryLoadJsonArray } from './json-array';
import { csvLoader } from './csv';
import { geoparquetLoader } from './geoparquet';

/**
 * Dispatch pre-unwrapped data to the appropriate loader based on detected format.
 *
 * For 'geojson' format, also attempts json-array fallback if the data
 * is a plain array of objects with coordinate fields rather than GeoJSON.
 *
 * Callers (data-actions) are responsible for unwrapping Response/File into raw data
 * before calling this function: string for CSV, ArrayBuffer for GeoParquet,
 * parsed object for GeoJSON/JSON array.
 *
 * @param data - Pre-unwrapped data (string, parsed object, or ArrayBuffer)
 * @param format - Detected or configured format
 * @param options - Loader options (latColumn/lngColumn overrides)
 * @returns Parsed GeoJSON FeatureCollection
 */
export async function dispatch(
	data: LoaderData,
	format: DetectedFormat,
	options?: LoaderOptions
): Promise<LoaderResult> {
	switch (format) {
		case 'csv':
			return csvLoader.load(data, options);

		case 'geoparquet':
			return geoparquetLoader.load(data, options);

		case 'json-array':
			// Explicit json-array: try coordinate detection
			return jsonArrayFallback(data, options);

		case 'geojson':
		default:
			// Try GeoJSON first, then json-array fallback
			return geojsonWithFallback(data, options);
	}
}

/**
 * Load as GeoJSON with automatic json-array fallback.
 * When the JSON is a plain array of objects (not Features), tries coordinate detection.
 */
async function geojsonWithFallback(
	data: LoaderData,
	options?: LoaderOptions
): Promise<LoaderResult> {
	// Try GeoJSON normalization first
	const { normalizeGeoJSON } = await import('./geojson');
	const normalized = normalizeGeoJSON(data);
	if (normalized) {
		const detectedCrs = extractGeoJsonCrs(data);
		return { data: normalized, detectedCrs };
	}

	// Try json-array fallback (no CRS metadata available)
	const arrayResult = tryLoadJsonArray(data, options);
	if (arrayResult) return arrayResult;

	throw new Error(
		'Response is not valid GeoJSON or a recognizable coordinate array'
	);
}

/**
 * Explicit json-array loading (when format is set to 'json-array').
 */
async function jsonArrayFallback(
	data: LoaderData,
	options?: LoaderOptions
): Promise<LoaderResult> {
	const result = tryLoadJsonArray(data, options);
	if (result) return result;

	throw new Error('JSON data is not a valid coordinate array');
}
