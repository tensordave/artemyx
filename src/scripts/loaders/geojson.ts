/**
 * GeoJSON format loader.
 * Normalizes raw Feature, raw geometry objects, plain feature arrays,
 * and standard FeatureCollections into a consistent FeatureCollection.
 */

import type { FormatLoader, LoaderData } from './types';
import { parseCrsAuthority } from './crs';

/** GeoJSON geometry type names */
const GEOMETRY_TYPES = new Set([
	'Point', 'MultiPoint',
	'LineString', 'MultiLineString',
	'Polygon', 'MultiPolygon',
	'GeometryCollection',
]);

/**
 * Normalize arbitrary GeoJSON-like data into a FeatureCollection.
 * Handles:
 * - Standard FeatureCollection (pass-through)
 * - Single Feature (wrapped in FeatureCollection)
 * - Raw geometry object (wrapped in Feature then FeatureCollection)
 * - Array of Features (wrapped in FeatureCollection)
 *
 * Returns null if the data cannot be recognized as GeoJSON.
 */
export function normalizeGeoJSON(data: unknown): GeoJSON.FeatureCollection | null {
	if (typeof data !== 'object' || data === null) {
		return null;
	}

	// Standard FeatureCollection
	if ('type' in data && (data as any).type === 'FeatureCollection' && Array.isArray((data as any).features)) {
		return data as GeoJSON.FeatureCollection;
	}

	// Single Feature
	if ('type' in data && (data as any).type === 'Feature' && 'geometry' in data) {
		return {
			type: 'FeatureCollection',
			features: [data as GeoJSON.Feature],
		};
	}

	// Raw geometry object
	if ('type' in data && GEOMETRY_TYPES.has((data as any).type) && 'coordinates' in data) {
		return {
			type: 'FeatureCollection',
			features: [{
				type: 'Feature',
				geometry: data as GeoJSON.Geometry,
				properties: {},
			}],
		};
	}

	// Array of Features
	if (Array.isArray(data) && data.length > 0 && data[0]?.type === 'Feature') {
		return {
			type: 'FeatureCollection',
			features: data as GeoJSON.Feature[],
		};
	}

	return null;
}

/**
 * Extract a CRS authority string from a legacy GeoJSON crs member.
 * RFC 7946 deprecated the crs field, but older exports (ArcGIS, QGIS) still emit it.
 * Example: { "type": "name", "properties": { "name": "urn:ogc:def:crs:EPSG::27700" } }
 */
export function extractGeoJsonCrs(data: unknown): string | undefined {
	if (typeof data !== 'object' || data === null) return undefined;
	const crsObj = (data as Record<string, unknown>).crs;
	if (typeof crsObj !== 'object' || crsObj === null) return undefined;
	const props = (crsObj as Record<string, unknown>).properties;
	if (typeof props !== 'object' || props === null) return undefined;
	const name = (props as Record<string, unknown>).name;
	if (typeof name !== 'string') return undefined;
	return parseCrsAuthority(name) ?? undefined;
}

export const geojsonLoader: FormatLoader = {
	async load(data: LoaderData) {
		const detectedCrs = extractGeoJsonCrs(data);
		const normalized = normalizeGeoJSON(data);
		if (!normalized) {
			throw new Error('Response is not valid GeoJSON (expected FeatureCollection, Feature, geometry, or Feature array)');
		}
		return { data: normalized, detectedCrs };
	},
};
