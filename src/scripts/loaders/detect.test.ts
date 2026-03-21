/**
 * Unit tests for detect.ts
 * Tests format detection priority chain and File-based detection.
 */

import { describe, it, expect } from 'vitest';
import { detectFormat, detectFormatFromFile } from './detect';

describe('detectFormat', () => {
	// 1. Config format override
	it('config format override wins over all other signals', () => {
		expect(detectFormat(
			'https://example.com/data.csv',
			'application/json',
			'geoparquet'
		)).toBe('geoparquet');
	});

	// 2. Content-Disposition filename
	it('Content-Disposition quoted filename with .geojson extension', () => {
		expect(detectFormat(
			'https://example.com/download',
			null,
			undefined,
			'attachment; filename="parks.geojson"'
		)).toBe('geojson');
	});

	it('Content-Disposition unquoted filename with .parquet extension', () => {
		expect(detectFormat(
			'https://example.com/download',
			null,
			undefined,
			'attachment; filename=data.parquet'
		)).toBe('geoparquet');
	});

	it('Content-Disposition RFC 5987 encoded filename', () => {
		expect(detectFormat(
			'https://example.com/download',
			null,
			undefined,
			"attachment; filename*=UTF-8''bikeways.csv"
		)).toBe('csv');
	});

	it('Content-Disposition with no filename falls through', () => {
		expect(detectFormat(
			'https://example.com/data.geojson',
			null,
			undefined,
			'attachment'
		)).toBe('geojson'); // falls through to URL extension
	});

	// 3. URL extension
	it('URL with .geojson extension', () => {
		expect(detectFormat('https://example.com/parks.geojson', null)).toBe('geojson');
	});

	it('URL with .json extension -> geojson', () => {
		expect(detectFormat('https://example.com/data.json', null)).toBe('geojson');
	});

	it('URL with .csv extension', () => {
		expect(detectFormat('https://example.com/data.csv', null)).toBe('csv');
	});

	it('URL with .tsv extension -> csv', () => {
		expect(detectFormat('https://example.com/data.tsv', null)).toBe('csv');
	});

	it('URL with .parquet extension -> geoparquet', () => {
		expect(detectFormat('https://example.com/data.parquet', null)).toBe('geoparquet');
	});

	it('URL with .pmtiles extension -> pmtiles', () => {
		expect(detectFormat('https://demo-bucket.protomaps.com/v4.pmtiles', null)).toBe('pmtiles');
	});

	it('URL extension parsed ignoring query params', () => {
		expect(detectFormat('https://example.com/data.csv?token=abc&v=2', null)).toBe('csv');
	});

	it('URL extension parsed ignoring fragment', () => {
		expect(detectFormat('https://example.com/data.geojson#section', null)).toBe('geojson');
	});

	// 4. Path segment keywords (OpenDataSoft pattern)
	it('extensionless URL with /exports/parquet segment', () => {
		expect(detectFormat(
			'https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets/bikeways/exports/parquet',
			null
		)).toBe('geoparquet');
	});

	it('extensionless URL with /exports/csv segment', () => {
		expect(detectFormat(
			'https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets/bikeways/exports/csv',
			null
		)).toBe('csv');
	});

	it('extensionless URL with /exports/geojson segment', () => {
		expect(detectFormat(
			'https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets/bikeways/exports/geojson',
			null
		)).toBe('geojson');
	});

	// 5. Content-Type header
	it('Content-Type application/geo+json -> geojson', () => {
		expect(detectFormat('https://example.com/api/data', 'application/geo+json')).toBe('geojson');
	});

	it('Content-Type text/csv -> csv', () => {
		expect(detectFormat('https://example.com/api/data', 'text/csv')).toBe('csv');
	});

	it('Content-Type with charset parameter (split on semicolon)', () => {
		expect(detectFormat('https://example.com/api/data', 'text/csv; charset=utf-8')).toBe('csv');
	});

	it('Content-Type application/json -> geojson', () => {
		expect(detectFormat('https://example.com/api/data', 'application/json')).toBe('geojson');
	});

	// 6. Default fallback
	it('no signals at all defaults to geojson', () => {
		expect(detectFormat('https://example.com/api/data', null)).toBe('geojson');
	});

	it('invalid URL defaults to geojson', () => {
		expect(detectFormat('not-a-url', null)).toBe('geojson');
	});
});

describe('detectFormatFromFile', () => {
	function fakeFile(name: string, type = ''): File {
		return new File([''], name, { type });
	}

	it('File with .csv extension', () => {
		expect(detectFormatFromFile(fakeFile('data.csv'))).toBe('csv');
	});

	it('File with .geojson extension', () => {
		expect(detectFormatFromFile(fakeFile('parks.geojson'))).toBe('geojson');
	});

	it('File with .parquet extension', () => {
		expect(detectFormatFromFile(fakeFile('data.parquet'))).toBe('geoparquet');
	});

	it('File with no extension but text/csv MIME type', () => {
		expect(detectFormatFromFile(fakeFile('data', 'text/csv'))).toBe('csv');
	});

	it('File with no signals defaults to geojson', () => {
		expect(detectFormatFromFile(fakeFile('data'))).toBe('geojson');
	});
});
