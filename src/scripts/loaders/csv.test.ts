/**
 * Unit tests for csv.ts
 * Tests delimiter detection, CSV parsing, WKT and GeoJSON geometry support.
 */

import { describe, it, expect } from 'vitest';
import { detectDelimiter, parseCSV, isWktValue, isGeoJsonGeometryValue, isGeometryValue, detectGeometryColumn, parseWkt, parseGeoJsonGeometry, csvLoader } from './csv';

describe('detectDelimiter', () => {
	it('comma-separated header', () => {
		expect(detectDelimiter('name,lat,lng')).toBe(',');
	});

	it('semicolon-separated header', () => {
		expect(detectDelimiter('name;lat;lng')).toBe(';');
	});

	it('tab-separated header', () => {
		expect(detectDelimiter('name\tlat\tlng')).toBe('\t');
	});

	it('pipe-separated header', () => {
		expect(detectDelimiter('name|lat|lng')).toBe('|');
	});

	it('ignores delimiters inside quoted fields', () => {
		// The commas inside quotes should not be counted
		expect(detectDelimiter('"name,with,commas";lat;lng')).toBe(';');
	});

	it('falls back to comma when no delimiters found', () => {
		expect(detectDelimiter('singlecolumn')).toBe(',');
	});

	it('picks the most frequent delimiter', () => {
		// 3 semicolons vs 1 comma inside a value
		expect(detectDelimiter('a;b;c;d')).toBe(';');
	});
});

describe('parseCSV', () => {
	it('basic comma-separated rows', () => {
		const csv = 'name,value\nalpha,1\nbeta,2';
		const rows = parseCSV(csv);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toEqual({ name: 'alpha', value: '1' });
		expect(rows[1]).toEqual({ name: 'beta', value: '2' });
	});

	it('semicolon-separated rows', () => {
		const csv = 'name;value\nalpha;1\nbeta;2';
		const rows = parseCSV(csv);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toEqual({ name: 'alpha', value: '1' });
	});

	it('quoted fields with embedded commas', () => {
		const csv = 'name,desc\nalpha,"has, comma"\nbeta,plain';
		const rows = parseCSV(csv);
		expect(rows[0].desc).toBe('has, comma');
	});

	it('escaped quotes (double-quote)', () => {
		const csv = 'name,desc\nalpha,"says ""hello"""\nbeta,plain';
		const rows = parseCSV(csv);
		expect(rows[0].desc).toBe('says "hello"');
	});

	it('multi-line quoted fields', () => {
		const csv = 'name,desc\nalpha,"line1\nline2"\nbeta,plain';
		const rows = parseCSV(csv);
		expect(rows).toHaveLength(2);
		expect(rows[0].desc).toBe('line1\nline2');
	});

	it('CRLF line endings', () => {
		const csv = 'name,value\r\nalpha,1\r\nbeta,2';
		const rows = parseCSV(csv);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toEqual({ name: 'alpha', value: '1' });
	});

	it('empty rows are skipped', () => {
		const csv = 'name,value\nalpha,1\n\nbeta,2\n';
		const rows = parseCSV(csv);
		expect(rows).toHaveLength(2);
	});

	it('missing values filled as empty string', () => {
		const csv = 'a,b,c\n1,2';
		const rows = parseCSV(csv);
		expect(rows[0]).toEqual({ a: '1', b: '2', c: '' });
	});

	it('empty input returns empty array', () => {
		expect(parseCSV('')).toEqual([]);
	});

	it('header only with no data rows returns empty array', () => {
		expect(parseCSV('name,value')).toEqual([]);
	});

	it('trailing newline handled', () => {
		const csv = 'name,value\nalpha,1\n';
		const rows = parseCSV(csv);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toEqual({ name: 'alpha', value: '1' });
	});

	it('tab-separated data parsed correctly', () => {
		const csv = 'name\tvalue\nalpha\t1';
		const rows = parseCSV(csv);
		expect(rows[0]).toEqual({ name: 'alpha', value: '1' });
	});
});

describe('isWktValue', () => {
	it('recognizes POINT', () => {
		expect(isWktValue('POINT (1 2)')).toBe(true);
	});

	it('recognizes LINESTRING', () => {
		expect(isWktValue('LINESTRING (0 0, 1 1)')).toBe(true);
	});

	it('recognizes POLYGON', () => {
		expect(isWktValue('POLYGON ((0 0, 1 0, 1 1, 0 0))')).toBe(true);
	});

	it('recognizes MULTIPOLYGON', () => {
		expect(isWktValue('MULTIPOLYGON (((0 0, 1 0, 1 1, 0 0)))')).toBe(true);
	});

	it('recognizes GEOMETRYCOLLECTION', () => {
		expect(isWktValue('GEOMETRYCOLLECTION (POINT (0 0))')).toBe(true);
	});

	it('case-insensitive', () => {
		expect(isWktValue('point (1 2)')).toBe(true);
		expect(isWktValue('Polygon ((0 0, 1 0, 1 1, 0 0))')).toBe(true);
	});

	it('handles Z suffix', () => {
		expect(isWktValue('POINT Z (1 2 3)')).toBe(true);
	});

	it('handles EMPTY', () => {
		expect(isWktValue('POINT EMPTY')).toBe(true);
	});

	it('rejects plain text', () => {
		expect(isWktValue('Some location')).toBe(false);
	});

	it('rejects numbers', () => {
		expect(isWktValue('123.45')).toBe(false);
	});

	it('rejects empty string', () => {
		expect(isWktValue('')).toBe(false);
	});
});

describe('isGeoJsonGeometryValue', () => {
	it('recognizes LineString', () => {
		expect(isGeoJsonGeometryValue('{"type": "LineString", "coordinates": [[0, 0], [1, 1]]}')).toBe(true);
	});

	it('recognizes Polygon', () => {
		expect(isGeoJsonGeometryValue('{"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 0]]]}')).toBe(true);
	});

	it('recognizes Feature wrapper', () => {
		expect(isGeoJsonGeometryValue('{"type": "Feature", "geometry": {"type": "Point", "coordinates": [0, 0]}, "properties": {}}')).toBe(true);
	});

	it('rejects plain text', () => {
		expect(isGeoJsonGeometryValue('not json')).toBe(false);
	});

	it('rejects non-geometry JSON', () => {
		expect(isGeoJsonGeometryValue('{"name": "test"}')).toBe(false);
	});
});

describe('isGeometryValue', () => {
	it('matches WKT', () => {
		expect(isGeometryValue('POINT (1 2)')).toBe(true);
	});

	it('matches GeoJSON string', () => {
		expect(isGeometryValue('{"type": "Point", "coordinates": [1, 2]}')).toBe(true);
	});

	it('rejects non-geometry', () => {
		expect(isGeometryValue('hello world')).toBe(false);
	});
});

describe('parseGeoJsonGeometry', () => {
	it('parses raw geometry', () => {
		expect(parseGeoJsonGeometry('{"type": "LineString", "coordinates": [[0, 0], [1, 1]]}')).toEqual({
			type: 'LineString',
			coordinates: [[0, 0], [1, 1]],
		});
	});

	it('extracts geometry from Feature wrapper', () => {
		const input = '{"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [[[0,0],[1,0],[1,1],[0,0]]]}, "properties": {}}';
		expect(parseGeoJsonGeometry(input)).toEqual({
			type: 'Polygon',
			coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]],
		});
	});

	it('returns null for invalid JSON', () => {
		expect(parseGeoJsonGeometry('not json')).toBeNull();
	});

	it('returns null for non-geometry JSON', () => {
		expect(parseGeoJsonGeometry('{"name": "test"}')).toBeNull();
	});
});

describe('detectGeometryColumn', () => {
	it('detects WKT column named "geometry"', () => {
		const headers = ['name', 'geometry'];
		const firstRow = { name: 'Park', geometry: 'POLYGON ((0 0, 1 0, 1 1, 0 0))' };
		expect(detectGeometryColumn(headers, firstRow)).toBe('geometry');
	});

	it('detects WKT column named "geom"', () => {
		const headers = ['id', 'geom'];
		const firstRow = { id: '1', geom: 'POINT (1 2)' };
		expect(detectGeometryColumn(headers, firstRow)).toBe('geom');
	});

	it('detects WKT column named "wkt"', () => {
		const headers = ['name', 'wkt'];
		const firstRow = { name: 'Trail', wkt: 'LINESTRING (0 0, 1 1)' };
		expect(detectGeometryColumn(headers, firstRow)).toBe('wkt');
	});

	it('case-insensitive header matching', () => {
		const headers = ['name', 'Geometry'];
		const firstRow = { name: 'Park', Geometry: 'POLYGON ((0 0, 1 0, 1 1, 0 0))' };
		expect(detectGeometryColumn(headers, firstRow)).toBe('Geometry');
	});

	it('falls back to scanning all columns', () => {
		const headers = ['name', 'spatial_data'];
		const firstRow = { name: 'Park', spatial_data: 'POLYGON ((0 0, 1 0, 1 1, 0 0))' };
		expect(detectGeometryColumn(headers, firstRow)).toBe('spatial_data');
	});

	it('returns null when no geometry column exists', () => {
		const headers = ['name', 'lat', 'lng'];
		const firstRow = { name: 'Place', lat: '49.25', lng: '-123.1' };
		expect(detectGeometryColumn(headers, firstRow)).toBeNull();
	});

	it('returns null when alias column has non-geometry value', () => {
		const headers = ['name', 'geometry'];
		const firstRow = { name: 'Park', geometry: 'complex shape' };
		expect(detectGeometryColumn(headers, firstRow)).toBeNull();
	});

	it('detects GeoJSON geometry string column', () => {
		const headers = ['name', 'Geom'];
		const firstRow = { name: 'Road', Geom: '{"type": "LineString", "coordinates": [[-123.0, 49.2], [-123.1, 49.3]]}' };
		expect(detectGeometryColumn(headers, firstRow)).toBe('Geom');
	});

	it('detects GeoJSON geometry in non-alias column via fallback scan', () => {
		const headers = ['name', 'spatial'];
		const firstRow = { name: 'Road', spatial: '{"type": "LineString", "coordinates": [[0, 0], [1, 1]]}' };
		expect(detectGeometryColumn(headers, firstRow)).toBe('spatial');
	});
});

describe('parseWkt', () => {
	it('POINT', () => {
		expect(parseWkt('POINT (1.5 2.5)')).toEqual({
			type: 'Point',
			coordinates: [1.5, 2.5],
		});
	});

	it('LINESTRING', () => {
		expect(parseWkt('LINESTRING (0 0, 1 1, 2 2)')).toEqual({
			type: 'LineString',
			coordinates: [[0, 0], [1, 1], [2, 2]],
		});
	});

	it('POLYGON single ring', () => {
		expect(parseWkt('POLYGON ((0 0, 1 0, 1 1, 0 1, 0 0))')).toEqual({
			type: 'Polygon',
			coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
		});
	});

	it('POLYGON with hole', () => {
		const result = parseWkt('POLYGON ((0 0, 10 0, 10 10, 0 10, 0 0), (2 2, 8 2, 8 8, 2 2))');
		expect(result).toEqual({
			type: 'Polygon',
			coordinates: [
				[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
				[[2, 2], [8, 2], [8, 8], [2, 2]],
			],
		});
	});

	it('MULTIPOINT with parens', () => {
		expect(parseWkt('MULTIPOINT ((0 0), (1 1))')).toEqual({
			type: 'MultiPoint',
			coordinates: [[0, 0], [1, 1]],
		});
	});

	it('MULTIPOINT without parens', () => {
		expect(parseWkt('MULTIPOINT (0 0, 1 1)')).toEqual({
			type: 'MultiPoint',
			coordinates: [[0, 0], [1, 1]],
		});
	});

	it('MULTILINESTRING', () => {
		expect(parseWkt('MULTILINESTRING ((0 0, 1 1), (2 2, 3 3))')).toEqual({
			type: 'MultiLineString',
			coordinates: [[[0, 0], [1, 1]], [[2, 2], [3, 3]]],
		});
	});

	it('MULTIPOLYGON', () => {
		const result = parseWkt('MULTIPOLYGON (((0 0, 1 0, 1 1, 0 0)), ((2 2, 3 2, 3 3, 2 2)))');
		expect(result).toEqual({
			type: 'MultiPolygon',
			coordinates: [
				[[[0, 0], [1, 0], [1, 1], [0, 0]]],
				[[[2, 2], [3, 2], [3, 3], [2, 2]]],
			],
		});
	});

	it('GEOMETRYCOLLECTION', () => {
		const result = parseWkt('GEOMETRYCOLLECTION (POINT (0 0), LINESTRING (0 0, 1 1))');
		expect(result).toEqual({
			type: 'GeometryCollection',
			geometries: [
				{ type: 'Point', coordinates: [0, 0] },
				{ type: 'LineString', coordinates: [[0, 0], [1, 1]] },
			],
		});
	});

	it('case-insensitive type', () => {
		expect(parseWkt('point (1 2)')).toEqual({
			type: 'Point',
			coordinates: [1, 2],
		});
	});

	it('Z coordinates (drops Z)', () => {
		expect(parseWkt('POINT Z (1 2 3)')).toEqual({
			type: 'Point',
			coordinates: [1, 2],
		});
	});

	it('returns null for empty string', () => {
		expect(parseWkt('')).toBeNull();
	});

	it('returns null for EMPTY geometry', () => {
		expect(parseWkt('POINT EMPTY')).toBeNull();
	});

	it('returns null for invalid WKT', () => {
		expect(parseWkt('NOT_A_TYPE (1 2)')).toBeNull();
	});

	it('handles negative coordinates', () => {
		expect(parseWkt('POINT (-123.1 49.25)')).toEqual({
			type: 'Point',
			coordinates: [-123.1, 49.25],
		});
	});
});

describe('csvLoader geometry integration', () => {
	it('loads CSV with WKT geometry column', async () => {
		const csv = [
			'geometry,name,area',
			'"POLYGON ((0 0, 1 0, 1 1, 0 1, 0 0))",Park,500',
			'"POLYGON ((2 2, 3 2, 3 3, 2 3, 2 2))",Plaza,300',
		].join('\n');

		const result = await csvLoader.load(csv);
		expect(result.data.features).toHaveLength(2);
		expect(result.data.features[0].geometry.type).toBe('Polygon');
		expect(result.data.features[0].properties).toEqual({ name: 'Park', area: 500 });
		expect(result.data.features[1].properties).toEqual({ name: 'Plaza', area: 300 });
	});

	it('loads CSV with WKT linestrings', async () => {
		const csv = [
			'geometry,road_name',
			'"LINESTRING (0 0, 1 1, 2 2)",Main St',
		].join('\n');

		const result = await csvLoader.load(csv);
		expect(result.data.features).toHaveLength(1);
		expect(result.data.features[0].geometry.type).toBe('LineString');
		expect(result.data.features[0].properties).toEqual({ road_name: 'Main St' });
	});

	it('WKT column takes priority over lat/lng columns', async () => {
		const csv = [
			'geometry,name,lat,lng',
			'"POLYGON ((0 0, 1 0, 1 1, 0 0))",Park,49.25,-123.1',
		].join('\n');

		const result = await csvLoader.load(csv);
		expect(result.data.features[0].geometry.type).toBe('Polygon');
	});

	it('falls back to lat/lng when no WKT column', async () => {
		const csv = 'name,lat,lng\nPlace,49.25,-123.1';
		const result = await csvLoader.load(csv);
		expect(result.data.features[0].geometry.type).toBe('Point');
	});

	it('round-trip: app export format', async () => {
		// Mimics the format produced by exportAsCSV (ST_AsText + flattened properties)
		const csv = [
			'geometry,name,population',
			'"POLYGON ((-123.1 49.2, -123.0 49.2, -123.0 49.3, -123.1 49.3, -123.1 49.2))",Downtown,50000',
			'"POLYGON ((-123.2 49.1, -123.1 49.1, -123.1 49.2, -123.2 49.2, -123.2 49.1))",Suburbs,30000',
		].join('\n');

		const result = await csvLoader.load(csv);
		expect(result.data.features).toHaveLength(2);

		const f0 = result.data.features[0];
		expect(f0.geometry.type).toBe('Polygon');
		expect((f0.geometry as GeoJSON.Polygon).coordinates[0]).toHaveLength(5);
		expect(f0.properties).toEqual({ name: 'Downtown', population: 50000 });
	});

	it('treats column with all invalid values as non-spatial', async () => {
		const csv = [
			'geometry,name',
			'INVALID,Park',
			'BROKEN,Plaza',
		].join('\n');

		// No geometry detected (isGeometryValue fails), falls through to non-spatial
		const result = await csvLoader.load(csv);
		expect(result.nonSpatial).toBe(true);
		expect(result.data.features).toHaveLength(2);
		expect(result.data.features[0].geometry).toBeNull();
		expect(result.data.features[0].properties).toEqual({ geometry: 'INVALID', name: 'Park' });
	});

	it('loads CSV with GeoJSON geometry strings (Vancouver open data style)', async () => {
		// CSV inner quotes must be escaped as "" per RFC 4180
		const csv = [
			'name,Geom',
			'Road A,"{""coordinates"": [[-123.029, 49.212], [-123.030, 49.213], [-123.031, 49.214]], ""type"": ""LineString""}"',
			'Road B,"{""coordinates"": [[-123.040, 49.220], [-123.041, 49.221]], ""type"": ""LineString""}"',
		].join('\n');

		const result = await csvLoader.load(csv);
		expect(result.data.features).toHaveLength(2);
		expect(result.data.features[0].geometry.type).toBe('LineString');
		expect(result.data.features[0].properties).toEqual({ name: 'Road A' });
		expect((result.data.features[0].geometry as GeoJSON.LineString).coordinates).toHaveLength(3);
	});

	it('loads CSV with GeoJSON polygon geometry strings', async () => {
		const csv = [
			'name,Geom',
			'Park,"{""type"": ""Polygon"", ""coordinates"": [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]]}"',
		].join('\n');

		const result = await csvLoader.load(csv);
		expect(result.data.features).toHaveLength(1);
		expect(result.data.features[0].geometry.type).toBe('Polygon');
	});

	it('loads CSV with GeoJSON Feature wrapper geometry', async () => {
		const csv = [
			'name,geom',
			'Park,"{""type"": ""Feature"", ""geometry"": {""type"": ""Polygon"", ""coordinates"": [[[0, 0], [1, 0], [1, 1], [0, 0]]]}, ""properties"": {}}"',
		].join('\n');

		const result = await csvLoader.load(csv);
		expect(result.data.features).toHaveLength(1);
		expect(result.data.features[0].geometry.type).toBe('Polygon');
	});

	it('GeoJSON geometry column takes priority over lat/lng', async () => {
		const csv = [
			'Geom,name,lat,lng',
			'"{""type"": ""LineString"", ""coordinates"": [[0, 0], [1, 1]]}",Trail,49.25,-123.1',
		].join('\n');

		const result = await csvLoader.load(csv);
		expect(result.data.features[0].geometry.type).toBe('LineString');
	});
});
