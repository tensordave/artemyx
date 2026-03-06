/**
 * Loader registry and dispatch.
 * Routes a fetch Response to the appropriate format loader based on detection.
 */

export type { DetectedFormat, ConfigFormat, LoaderOptions, LoaderResult, FormatLoader } from './types';
export { detectFormat, detectFormatFromFile } from './detect';
export { normalizeGeoJSON } from './geojson';
export { detectCoordinateColumns } from './columns';
export { tryLoadJsonArray } from './json-array';

import type { DetectedFormat, LoaderOptions, LoaderResult } from './types';
import { extractGeoJsonCrs } from './geojson';
import { tryLoadJsonArray } from './json-array';
import { csvLoader } from './csv';
import { geoparquetLoader } from './geoparquet';

/**
 * Dispatch a fetch Response to the appropriate loader based on detected format.
 *
 * For 'geojson' format, also attempts json-array fallback if the response
 * is a plain array of objects with coordinate fields rather than GeoJSON.
 *
 * @param response - The fetch Response (consumed by this call)
 * @param format - Detected or configured format
 * @param options - Loader options (latColumn/lngColumn overrides)
 * @returns Parsed GeoJSON FeatureCollection
 */
export async function dispatch(
	response: Response,
	format: DetectedFormat,
	options?: LoaderOptions
): Promise<LoaderResult> {
	switch (format) {
		case 'csv':
			return csvLoader.load(response, options);

		case 'geoparquet':
			return geoparquetLoader.load(response, options);

		case 'json-array':
			// Explicit json-array: parse JSON and try coordinate detection
			return jsonArrayFallback(response, options);

		case 'geojson':
		default:
			// Parse as JSON, try GeoJSON first, then json-array fallback
			return geojsonWithFallback(response, options);
	}
}

/**
 * Load as GeoJSON with automatic json-array fallback.
 * When the JSON is a plain array of objects (not Features), tries coordinate detection.
 */
async function geojsonWithFallback(
	response: Response,
	options?: LoaderOptions
): Promise<LoaderResult> {
	const data = await response.json();

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
	response: Response,
	options?: LoaderOptions
): Promise<LoaderResult> {
	const data = await response.json();
	const result = tryLoadJsonArray(data, options);
	if (result) return result;

	throw new Error('JSON data is not a valid coordinate array');
}
