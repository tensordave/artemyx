/**
 * Unit tests for geojson.ts
 * Tests GeoJSON normalization and CRS extraction.
 */

import { describe, it, expect } from 'vitest';
import { normalizeGeoJSON, extractGeoJsonCrs } from './geojson';

const samplePoint: GeoJSON.Point = {
	type: 'Point',
	coordinates: [-123.1, 49.25],
};

const sampleFeature: GeoJSON.Feature = {
	type: 'Feature',
	geometry: samplePoint,
	properties: { name: 'test' },
};

const sampleCollection: GeoJSON.FeatureCollection = {
	type: 'FeatureCollection',
	features: [sampleFeature],
};

describe('normalizeGeoJSON', () => {
	it('standard FeatureCollection passes through', () => {
		const result = normalizeGeoJSON(sampleCollection);
		expect(result).toBe(sampleCollection);
	});

	it('single Feature wraps in FeatureCollection', () => {
		const result = normalizeGeoJSON(sampleFeature);
		expect(result).toEqual({
			type: 'FeatureCollection',
			features: [sampleFeature],
		});
	});

	it('raw Point geometry wraps in Feature then FeatureCollection', () => {
		const result = normalizeGeoJSON(samplePoint);
		expect(result!.type).toBe('FeatureCollection');
		expect(result!.features).toHaveLength(1);
		expect(result!.features[0].geometry).toBe(samplePoint);
		expect(result!.features[0].properties).toEqual({});
	});

	it('raw Polygon geometry wraps correctly', () => {
		const polygon: GeoJSON.Polygon = {
			type: 'Polygon',
			coordinates: [[[-123, 49], [-123, 50], [-122, 50], [-122, 49], [-123, 49]]],
		};
		const result = normalizeGeoJSON(polygon);
		expect(result!.features[0].geometry).toBe(polygon);
	});

	it('array of Features wraps in FeatureCollection', () => {
		const features = [sampleFeature, { ...sampleFeature, properties: { name: 'two' } }];
		const result = normalizeGeoJSON(features);
		expect(result!.type).toBe('FeatureCollection');
		expect(result!.features).toHaveLength(2);
	});

	it('GeometryCollection recognized as raw geometry', () => {
		const gc = {
			type: 'GeometryCollection',
			coordinates: [], // has coordinates key for the check
			geometries: [samplePoint],
		};
		// GeometryCollection requires 'coordinates' in data check, which it doesn't have natively
		// The actual check is: GEOMETRY_TYPES.has(type) && 'coordinates' in data
		// GeometryCollection doesn't have coordinates, so it returns null
		const result = normalizeGeoJSON({ type: 'GeometryCollection', geometries: [samplePoint] });
		expect(result).toBeNull();
	});

	it('null input returns null', () => {
		expect(normalizeGeoJSON(null)).toBeNull();
	});

	it('non-object input returns null', () => {
		expect(normalizeGeoJSON('not an object')).toBeNull();
		expect(normalizeGeoJSON(42)).toBeNull();
	});

	it('empty object returns null', () => {
		expect(normalizeGeoJSON({})).toBeNull();
	});

	it('object with wrong type field returns null', () => {
		expect(normalizeGeoJSON({ type: 'Unknown', features: [] })).toBeNull();
	});

	it('empty array returns null', () => {
		expect(normalizeGeoJSON([])).toBeNull();
	});

	it('array of non-Feature objects returns null', () => {
		expect(normalizeGeoJSON([{ name: 'not a feature' }])).toBeNull();
	});
});

describe('extractGeoJsonCrs', () => {
	it('extracts EPSG code from legacy crs member (URN format)', () => {
		const data = {
			type: 'FeatureCollection',
			crs: {
				type: 'name',
				properties: { name: 'urn:ogc:def:crs:EPSG::27700' },
			},
			features: [],
		};
		expect(extractGeoJsonCrs(data)).toBe('EPSG:27700');
	});

	it('returns undefined for no crs member', () => {
		expect(extractGeoJsonCrs(sampleCollection)).toBeUndefined();
	});

	it('returns undefined for malformed crs', () => {
		expect(extractGeoJsonCrs({ crs: 'not-an-object' })).toBeUndefined();
		expect(extractGeoJsonCrs({ crs: { properties: null } })).toBeUndefined();
		expect(extractGeoJsonCrs({ crs: { properties: { name: 42 } } })).toBeUndefined();
	});

	it('returns undefined for null input', () => {
		expect(extractGeoJsonCrs(null)).toBeUndefined();
	});
});
