/**
 * Unit tests for crs.ts
 * Tests CRS parsing, WGS84 detection, projected coordinate detection, and resolution.
 */

import { describe, it, expect } from 'vitest';
import { parseCrsAuthority, isWgs84, hasProjectedCoordinates, resolveSourceCrs } from './crs';

describe('parseCrsAuthority', () => {
	it('URN format: urn:ogc:def:crs:EPSG::27700', () => {
		expect(parseCrsAuthority('urn:ogc:def:crs:EPSG::27700')).toBe('EPSG:27700');
	});

	it('URN with version: urn:ogc:def:crs:EPSG:9.9.1:4326', () => {
		expect(parseCrsAuthority('urn:ogc:def:crs:EPSG:9.9.1:4326')).toBe('EPSG:4326');
	});

	it('OGC CRS84 URN normalizes to EPSG:4326', () => {
		expect(parseCrsAuthority('urn:ogc:def:crs:OGC:1.3:CRS84')).toBe('EPSG:4326');
	});

	it('bare authority:code passthrough', () => {
		expect(parseCrsAuthority('EPSG:27700')).toBe('EPSG:27700');
	});

	it('bare ESRI authority passthrough', () => {
		expect(parseCrsAuthority('ESRI:102001')).toBe('ESRI:102001');
	});

	it('PROJJSON object with id.authority and id.code', () => {
		expect(parseCrsAuthority({ id: { authority: 'EPSG', code: 27700 } })).toBe('EPSG:27700');
	});

	it('null input returns null', () => {
		expect(parseCrsAuthority(null)).toBeNull();
	});

	it('undefined input returns null', () => {
		expect(parseCrsAuthority(undefined)).toBeNull();
	});

	it('non-string non-object input returns null', () => {
		expect(parseCrsAuthority(42)).toBeNull();
		expect(parseCrsAuthority(true)).toBeNull();
	});

	it('empty string returns null', () => {
		expect(parseCrsAuthority('')).toBeNull();
		expect(parseCrsAuthority('  ')).toBeNull();
	});

	it('malformed URN matches bare authority:code pattern', () => {
		// 'urn:invalid' matches the /^[A-Za-z]+:\S+$/ regex as bare authority:code
		expect(parseCrsAuthority('urn:invalid')).toBe('urn:invalid');
	});

	it('string with no colon returns null', () => {
		expect(parseCrsAuthority('notaformat')).toBeNull();
	});

	it('object without id returns null', () => {
		expect(parseCrsAuthority({ name: 'WGS 84' })).toBeNull();
	});
});

describe('isWgs84', () => {
	it('EPSG:4326 is WGS84', () => {
		expect(isWgs84('EPSG:4326')).toBe(true);
	});

	it('CRS:84 is WGS84', () => {
		expect(isWgs84('CRS:84')).toBe(true);
	});

	it('EPSG:4979 is WGS84', () => {
		expect(isWgs84('EPSG:4979')).toBe(true);
	});

	it('EPSG:4269 (NAD83) is treated as WGS84', () => {
		expect(isWgs84('EPSG:4269')).toBe(true);
	});

	it('case insensitive', () => {
		expect(isWgs84('epsg:4326')).toBe(true);
	});

	it('EPSG:27700 is not WGS84', () => {
		expect(isWgs84('EPSG:27700')).toBe(false);
	});

	it('EPSG:32610 (UTM) is not WGS84', () => {
		expect(isWgs84('EPSG:32610')).toBe(false);
	});
});

describe('hasProjectedCoordinates', () => {
	function fc(coordinates: number[][]): GeoJSON.FeatureCollection {
		return {
			type: 'FeatureCollection',
			features: coordinates.map(c => ({
				type: 'Feature' as const,
				geometry: { type: 'Point' as const, coordinates: c },
				properties: {},
			})),
		};
	}

	it('WGS84 coordinates return false', () => {
		expect(hasProjectedCoordinates(fc([[-123.1, 49.25], [-122.9, 49.3]]))).toBe(false);
	});

	it('UTM coordinates (large numbers) return true', () => {
		expect(hasProjectedCoordinates(fc([[491000, 5459000]]))).toBe(true);
	});

	it('empty FeatureCollection returns false', () => {
		expect(hasProjectedCoordinates({ type: 'FeatureCollection', features: [] })).toBe(false);
	});

	it('coordinates at exact WGS84 bounds return false', () => {
		expect(hasProjectedCoordinates(fc([[180, 90]]))).toBe(false);
		expect(hasProjectedCoordinates(fc([[-180, -90]]))).toBe(false);
	});

	it('coordinates just outside WGS84 bounds return true', () => {
		expect(hasProjectedCoordinates(fc([[180.1, 49]]))).toBe(true);
		expect(hasProjectedCoordinates(fc([[0, 90.1]]))).toBe(true);
	});
});

describe('resolveSourceCrs', () => {
	it('config CRS overrides detected', () => {
		expect(resolveSourceCrs('EPSG:27700', 'EPSG:32610', undefined)).toBe('EPSG:27700');
	});

	it('detected CRS used when no config', () => {
		expect(resolveSourceCrs(undefined, 'EPSG:27700', undefined)).toBe('EPSG:27700');
	});

	it('map CRS used when no config or detected', () => {
		expect(resolveSourceCrs(undefined, undefined, 'EPSG:27700')).toBe('EPSG:27700');
	});

	it('WGS84 returns null (no reprojection needed)', () => {
		expect(resolveSourceCrs('EPSG:4326', undefined, undefined)).toBeNull();
	});

	it('all undefined defaults to null (EPSG:4326 default)', () => {
		expect(resolveSourceCrs(undefined, undefined, undefined)).toBeNull();
	});
});
