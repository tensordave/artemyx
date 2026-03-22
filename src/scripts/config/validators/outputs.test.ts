import { describe, it, expect } from 'vitest';
import { validateOutput, validateOutputs } from './outputs';

describe('validateOutput', () => {
	it('accepts a valid output', () => {
		const errors = validateOutput({ source: 'parks', format: 'geojson' }, 0);
		expect(errors).toEqual([]);
	});

	it('accepts a valid output with filename', () => {
		const errors = validateOutput({ source: 'parks', format: 'csv', filename: 'my-parks' }, 0);
		expect(errors).toEqual([]);
	});

	it('accepts all valid formats', () => {
		for (const format of ['geojson', 'csv', 'parquet']) {
			const errors = validateOutput({ source: 'data', format }, 0);
			expect(errors).toEqual([]);
		}
	});

	it('rejects non-object', () => {
		const errors = validateOutput('not-an-object', 0);
		expect(errors).toEqual(['outputs[0]: must be an object']);
	});

	it('rejects null', () => {
		const errors = validateOutput(null, 0);
		expect(errors).toEqual(['outputs[0]: must be an object']);
	});

	it('rejects missing source', () => {
		const errors = validateOutput({ format: 'geojson' }, 0);
		expect(errors).toContainEqual(expect.stringContaining("missing required 'source'"));
	});

	it('rejects empty source', () => {
		const errors = validateOutput({ source: '', format: 'geojson' }, 0);
		expect(errors).toContainEqual(expect.stringContaining('must be a non-empty string'));
	});

	it('rejects missing format', () => {
		const errors = validateOutput({ source: 'parks' }, 0);
		expect(errors).toContainEqual(expect.stringContaining("missing required 'format'"));
	});

	it('rejects invalid format', () => {
		const errors = validateOutput({ source: 'parks', format: 'shapefile' }, 0);
		expect(errors).toContainEqual(expect.stringContaining("invalid output format 'shapefile'"));
	});

	it('rejects non-string format', () => {
		const errors = validateOutput({ source: 'parks', format: 42 }, 0);
		expect(errors).toContainEqual(expect.stringContaining('format: must be a string'));
	});

	it('rejects empty filename', () => {
		const errors = validateOutput({ source: 'parks', format: 'geojson', filename: '' }, 0);
		expect(errors).toContainEqual(expect.stringContaining('filename: must be a non-empty string'));
	});

	it('uses correct index in error prefix', () => {
		const errors = validateOutput({ format: 'geojson' }, 3);
		expect(errors[0]).toContain('outputs[3]');
	});
});

describe('validateOutputs', () => {
	const validSources = new Set(['parks', 'roads', 'buffered']);
	const pmtilesSources = new Set(['basemap']);

	it('accepts valid outputs array', () => {
		const outputs = [
			{ source: 'parks', format: 'geojson' },
			{ source: 'roads', format: 'csv' },
		];
		const errors = validateOutputs(outputs, validSources, pmtilesSources);
		expect(errors).toEqual([]);
	});

	it('accepts empty array', () => {
		const errors = validateOutputs([], validSources, pmtilesSources);
		expect(errors).toEqual([]);
	});

	it('rejects non-array', () => {
		const errors = validateOutputs('not-array', validSources, pmtilesSources);
		expect(errors).toEqual(["'outputs' must be an array"]);
	});

	it('rejects unknown source ID', () => {
		const outputs = [{ source: 'nonexistent', format: 'geojson' }];
		const errors = validateOutputs(outputs, validSources, pmtilesSources);
		expect(errors).toContainEqual(expect.stringContaining("does not reference a valid dataset"));
	});

	it('rejects PMTiles source', () => {
		const outputs = [{ source: 'basemap', format: 'geojson' }];
		const allSources = new Set([...validSources, 'basemap']);
		const errors = validateOutputs(outputs, allSources, pmtilesSources);
		expect(errors).toContainEqual(expect.stringContaining("is a PMTiles dataset"));
	});

	it('catches duplicate filenames with explicit names', () => {
		const outputs = [
			{ source: 'parks', format: 'geojson', filename: 'output' },
			{ source: 'roads', format: 'geojson', filename: 'output' },
		];
		const errors = validateOutputs(outputs, validSources, pmtilesSources);
		expect(errors).toContainEqual(expect.stringContaining("duplicate filename 'output.geojson'"));
	});

	it('catches duplicate filenames after default resolution', () => {
		const outputs = [
			{ source: 'parks', format: 'geojson' },
			{ source: 'parks', format: 'geojson' },
		];
		const errors = validateOutputs(outputs, validSources, pmtilesSources);
		expect(errors).toContainEqual(expect.stringContaining("duplicate filename 'parks.geojson'"));
	});

	it('allows same source with different formats', () => {
		const outputs = [
			{ source: 'parks', format: 'geojson' },
			{ source: 'parks', format: 'csv' },
		];
		const errors = validateOutputs(outputs, validSources, pmtilesSources);
		expect(errors).toEqual([]);
	});

	it('allows different sources with same format', () => {
		const outputs = [
			{ source: 'parks', format: 'geojson' },
			{ source: 'roads', format: 'geojson' },
		];
		const errors = validateOutputs(outputs, validSources, pmtilesSources);
		expect(errors).toEqual([]);
	});

	it('collects errors from multiple invalid outputs', () => {
		const outputs = [
			{ format: 'geojson' },          // missing source
			{ source: 'parks' },             // missing format
		];
		const errors = validateOutputs(outputs, validSources, pmtilesSources);
		expect(errors.length).toBeGreaterThanOrEqual(2);
	});
});
