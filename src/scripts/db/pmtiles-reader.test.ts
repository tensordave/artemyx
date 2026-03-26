import { describe, it, expect } from 'vitest';
import { computeCentroid, computeDedupKey } from './pmtiles-reader';

describe('computeCentroid', () => {
	it('returns point coordinates directly', () => {
		const geom: GeoJSON.Point = { type: 'Point', coordinates: [-123.1, 49.2] };
		expect(computeCentroid(geom)).toEqual([-123.1, 49.2]);
	});

	it('computes average for LineString', () => {
		const geom: GeoJSON.LineString = {
			type: 'LineString',
			coordinates: [[0, 0], [10, 10]],
		};
		expect(computeCentroid(geom)).toEqual([5, 5]);
	});

	it('computes average for MultiPoint', () => {
		const geom: GeoJSON.MultiPoint = {
			type: 'MultiPoint',
			coordinates: [[0, 0], [4, 4], [8, 8]],
		};
		expect(computeCentroid(geom)).toEqual([4, 4]);
	});

	it('computes centroid of outer ring for Polygon', () => {
		const geom: GeoJSON.Polygon = {
			type: 'Polygon',
			coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]],
		};
		const [lon, lat] = computeCentroid(geom);
		expect(lon).toBeCloseTo(4, 0); // avg of 0,10,10,0,0
		expect(lat).toBeCloseTo(4, 0);
	});

	it('uses first polygon for MultiPolygon', () => {
		const geom: GeoJSON.MultiPolygon = {
			type: 'MultiPolygon',
			coordinates: [
				[[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]],
				[[[100, 100], [102, 100], [102, 102], [100, 102], [100, 100]]],
			],
		};
		const [lon, lat] = computeCentroid(geom);
		// Should use first polygon's outer ring only
		expect(lon).toBeCloseTo(0.8, 0);
		expect(lat).toBeCloseTo(0.8, 0);
	});

	it('handles MultiLineString using first line', () => {
		const geom: GeoJSON.MultiLineString = {
			type: 'MultiLineString',
			coordinates: [
				[[0, 0], [10, 10]],
				[[100, 100], [200, 200]],
			],
		};
		const [lon, lat] = computeCentroid(geom);
		expect(lon).toBeCloseTo(5, 0);
		expect(lat).toBeCloseTo(5, 0);
	});

	it('handles GeometryCollection using first geometry', () => {
		const geom: GeoJSON.GeometryCollection = {
			type: 'GeometryCollection',
			geometries: [
				{ type: 'Point', coordinates: [42, 24] },
				{ type: 'Point', coordinates: [100, 200] },
			],
		};
		expect(computeCentroid(geom)).toEqual([42, 24]);
	});

	it('returns [0, 0] for empty GeometryCollection', () => {
		const geom: GeoJSON.GeometryCollection = {
			type: 'GeometryCollection',
			geometries: [],
		};
		expect(computeCentroid(geom)).toEqual([0, 0]);
	});
});

describe('computeDedupKey', () => {
	it('produces consistent keys for the same feature', () => {
		const feature: GeoJSON.Feature = {
			type: 'Feature',
			geometry: { type: 'Point', coordinates: [-123.12345, 49.28765] },
			properties: { name: 'Test', value: 42 },
		};
		const key1 = computeDedupKey(feature);
		const key2 = computeDedupKey(feature);
		expect(key1).toBe(key2);
	});

	it('produces different keys for different locations', () => {
		const f1: GeoJSON.Feature = {
			type: 'Feature',
			geometry: { type: 'Point', coordinates: [0, 0] },
			properties: { name: 'A' },
		};
		const f2: GeoJSON.Feature = {
			type: 'Feature',
			geometry: { type: 'Point', coordinates: [1, 1] },
			properties: { name: 'A' },
		};
		expect(computeDedupKey(f1)).not.toBe(computeDedupKey(f2));
	});

	it('produces different keys for same location with different properties', () => {
		const f1: GeoJSON.Feature = {
			type: 'Feature',
			geometry: { type: 'Point', coordinates: [0, 0] },
			properties: { name: 'A' },
		};
		const f2: GeoJSON.Feature = {
			type: 'Feature',
			geometry: { type: 'Point', coordinates: [0, 0] },
			properties: { name: 'B' },
		};
		expect(computeDedupKey(f1)).not.toBe(computeDedupKey(f2));
	});

	it('rounds coordinates to absorb floating-point differences', () => {
		const f1: GeoJSON.Feature = {
			type: 'Feature',
			geometry: { type: 'Point', coordinates: [-123.123452, 49.287652] },
			properties: { id: 1 },
		};
		// Coordinates differing by <5e-6 round to same 1e-5 bucket
		const f2: GeoJSON.Feature = {
			type: 'Feature',
			geometry: { type: 'Point', coordinates: [-123.123454, 49.287654] },
			properties: { id: 1 },
		};
		expect(computeDedupKey(f1)).toBe(computeDedupKey(f2));
	});

	it('handles null properties', () => {
		const feature: GeoJSON.Feature = {
			type: 'Feature',
			geometry: { type: 'Point', coordinates: [0, 0] },
			properties: null,
		};
		const key = computeDedupKey(feature);
		expect(key).toBeTruthy();
		expect(key).toContain('{}');
	});

	it('works with polygon features using centroid', () => {
		const feature: GeoJSON.Feature = {
			type: 'Feature',
			geometry: {
				type: 'Polygon',
				coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]],
			},
			properties: { area: 100 },
		};
		const key = computeDedupKey(feature);
		expect(key).toBeTruthy();
		// Centroid of this square is at ~(4, 4)
		expect(key).toContain('400000:400000:');
	});
});
