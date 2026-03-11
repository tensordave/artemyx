/**
 * JSON array loader.
 * Handles plain JSON arrays of objects with coordinate properties.
 * Reuses coordinate column detection from the CSV loader.
 */

import type { FormatLoader, LoaderData, LoaderOptions, LoaderResult } from './types';
import { normalizeGeoJSON } from './geojson';
import { detectCoordinateColumns } from './columns';

const GEO_GEOMETRY_TYPES = new Set([
	'Point', 'MultiPoint', 'LineString', 'MultiLineString',
	'Polygon', 'MultiPolygon', 'GeometryCollection',
]);

/**
 * Return value as a GeoJSON Geometry if it is one (object or JSON string), else null.
 * Handles both native geometry objects and stringified geometry (some portals serialize them).
 */
function parseGeoShape(value: unknown): GeoJSON.Geometry | null {
	const candidate = typeof value === 'string' ? tryParse(value) : value;
	if (typeof candidate !== 'object' || candidate === null) return null;

	const obj = candidate as Record<string, unknown>;

	// Raw geometry object (e.g. {"type": "Polygon", "coordinates": [...]})
	if (
		typeof obj.type === 'string' &&
		GEO_GEOMETRY_TYPES.has(obj.type) &&
		'coordinates' in obj
	) {
		return candidate as GeoJSON.Geometry;
	}

	// Feature wrapper (e.g. {"type": "Feature", "geometry": {...}}) - extract inner geometry
	if (obj.type === 'Feature' && typeof obj.geometry === 'object' && obj.geometry !== null) {
		const geom = obj.geometry as Record<string, unknown>;
		if (typeof geom.type === 'string' && GEO_GEOMETRY_TYPES.has(geom.type) && 'coordinates' in geom) {
			return obj.geometry as GeoJSON.Geometry;
		}
	}

	return null;
}

function tryParse(s: string): unknown {
	try { return JSON.parse(s); } catch { return null; }
}

/**
 * Find the first property in an object that contains a GeoJSON geometry.
 * Returns the property name or null if none found.
 */
function findGeoShapeColumn(item: Record<string, unknown>): string | null {
	for (const [key, value] of Object.entries(item)) {
		if (parseGeoShape(value)) return key;
	}
	return null;
}

/**
 * Build a FeatureCollection from an array of objects where one property
 * contains a GeoJSON geometry (object or JSON string).
 */
function arrayFromGeoShape(
	items: Record<string, unknown>[],
	geoCol: string
): GeoJSON.FeatureCollection {
	const features: GeoJSON.Feature[] = [];
	for (const item of items) {
		const geometry = parseGeoShape(item[geoCol]);
		if (!geometry) continue;
		const properties: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(item)) {
			if (key === geoCol) continue;
			properties[key] = value;
		}
		features.push({ type: 'Feature', geometry, properties });
	}
	return { type: 'FeatureCollection', features };
}

/**
 * Parse a combined "lat, lng" or "lat,lng" string value into separate numbers.
 * Returns null if the value cannot be parsed as a coordinate pair.
 */
function parseGeoPoint(value: unknown): { lat: number; lng: number } | null {
	if (typeof value !== 'string') return null;
	const parts = value.split(',');
	if (parts.length !== 2) return null;

	const lat = parseFloat(parts[0].trim());
	const lng = parseFloat(parts[1].trim());
	if (isNaN(lat) || isNaN(lng)) return null;

	return { lat, lng };
}

/**
 * Convert an array of objects to a GeoJSON Point FeatureCollection
 * using a single combined coordinate column.
 */
function arrayFromGeoColumn(
	items: Record<string, unknown>[],
	geoCol: string
): GeoJSON.FeatureCollection {
	const features: GeoJSON.Feature[] = [];

	for (const item of items) {
		const coords = parseGeoPoint(item[geoCol]);
		if (!coords) continue;

		const properties: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(item)) {
			if (key === geoCol) continue;
			properties[key] = value;
		}

		features.push({
			type: 'Feature',
			geometry: { type: 'Point', coordinates: [coords.lng, coords.lat] },
			properties,
		});
	}

	return { type: 'FeatureCollection', features };
}

/**
 * Convert an array of objects to a GeoJSON Point FeatureCollection
 * using separate lat/lng columns.
 * Rows with invalid/missing coordinates are skipped.
 */
function arrayToFeatureCollection(
	items: Record<string, unknown>[],
	latCol: string,
	lngCol: string
): GeoJSON.FeatureCollection {
	const features: GeoJSON.Feature[] = [];

	for (const item of items) {
		const lat = Number(item[latCol]);
		const lng = Number(item[lngCol]);
		if (isNaN(lat) || isNaN(lng)) continue;

		const properties: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(item)) {
			if (key === latCol || key === lngCol) continue;
			properties[key] = value;
		}

		features.push({
			type: 'Feature',
			geometry: { type: 'Point', coordinates: [lng, lat] },
			properties,
		});
	}

	return { type: 'FeatureCollection', features };
}

/**
 * Try to load a parsed JSON value as either GeoJSON or a coordinate array.
 * Called when format detection said 'geojson' but the parsed JSON might
 * actually be a plain array of objects with coordinate fields.
 *
 * Returns null if the data is neither valid GeoJSON nor a coordinate array.
 */
export function tryLoadJsonArray(
	data: unknown,
	options?: LoaderOptions
): LoaderResult | null {
	// Must be a non-empty array of objects
	if (!Array.isArray(data) || data.length === 0) return null;
	if (typeof data[0] !== 'object' || data[0] === null) return null;

	// If it looks like a Feature array, let the GeoJSON normalizer handle it
	if (data[0].type === 'Feature') return null;

	const items = data as Record<string, unknown>[];
	const headers = Object.keys(data[0]);

	// Combined coordinate column mode
	if (options?.geoColumn) {
		if (!headers.includes(options.geoColumn)) return null;
		const fc = arrayFromGeoColumn(items, options.geoColumn);
		if (fc.features.length === 0) return null;
		return { data: fc };
	}

	// Separate lat/lng columns mode
	try {
		const { latColumn, lngColumn } = detectCoordinateColumns(headers, options);
		const fc = arrayToFeatureCollection(items, latColumn, lngColumn);
		if (fc.features.length > 0) return { data: fc };
	} catch { /* no lat/lng columns found, fall through */ }

	// GeoJSON geometry column mode (e.g. OpenDataSoft geo_shape for polygon/line datasets)
	const geoShapeCol = findGeoShapeColumn(items[0]);
	if (geoShapeCol) {
		const fc = arrayFromGeoShape(items, geoShapeCol);
		if (fc.features.length > 0) return { data: fc };
	}

	return null;
}

export const jsonArrayLoader: FormatLoader = {
	async load(data: LoaderData, options?: LoaderOptions): Promise<LoaderResult> {
		// Try GeoJSON first (a JSON array of Features is valid GeoJSON)
		const geoJson = normalizeGeoJSON(data);
		if (geoJson) return { data: geoJson };

		// Try as coordinate array
		const result = tryLoadJsonArray(data, options);
		if (result) return result;

		throw new Error('JSON data is not a valid GeoJSON or coordinate array');
	},
};
