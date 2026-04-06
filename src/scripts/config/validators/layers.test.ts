import { describe, it, expect, vi } from 'vitest';
import { validateLayer, validateLayers } from './layers';

describe('validateLayer', () => {
	const valid = { id: 'my-layer', source: 'parks', type: 'fill' };

	// --- Valid cases ---

	it('accepts a valid layer', () => {
		const errors = validateLayer(valid, 0);
		expect(errors).toEqual([]);
	});

	it('accepts a valid layer with all optional fields', () => {
		const errors = validateLayer({
			...valid,
			name: 'My Layer',
			minzoom: 5,
			maxzoom: 18,
			'source-layer': 'buildings',
			filter: ['==', ['geometry-type'], 'Polygon'],
			paint: { 'fill-color': '#ff0000' },
			layout: { visibility: 'visible' },
			tooltip: ['name', 'area'],
		}, 0);
		expect(errors).toEqual([]);
	});

	// --- Required fields ---

	it('rejects non-object', () => {
		const errors = validateLayer('not-an-object', 0);
		expect(errors).toEqual(['layers[0]: must be an object']);
	});

	it('rejects null', () => {
		const errors = validateLayer(null, 0);
		expect(errors).toEqual(['layers[0]: must be an object']);
	});

	it('rejects missing id', () => {
		const errors = validateLayer({ source: 'parks', type: 'fill' }, 0);
		expect(errors).toContainEqual(expect.stringContaining("missing required 'id'"));
	});

	it('rejects empty id', () => {
		const errors = validateLayer({ id: '  ', source: 'parks', type: 'fill' }, 0);
		expect(errors).toContainEqual(expect.stringContaining('id: must be a non-empty string'));
	});

	it('rejects missing source', () => {
		const errors = validateLayer({ id: 'a', type: 'fill' }, 0);
		expect(errors).toContainEqual(expect.stringContaining("missing required 'source'"));
	});

	it('rejects empty source', () => {
		const errors = validateLayer({ id: 'a', source: '', type: 'fill' }, 0);
		expect(errors).toContainEqual(expect.stringContaining('source: must be a non-empty string'));
	});

	it('rejects missing type', () => {
		const errors = validateLayer({ id: 'a', source: 's' }, 0);
		expect(errors).toContainEqual(expect.stringContaining("missing required 'type'"));
	});

	it('rejects invalid type', () => {
		const errors = validateLayer({ id: 'a', source: 's', type: 'raster' }, 0);
		expect(errors).toContainEqual(expect.stringContaining("invalid layer type 'raster'"));
	});

	// --- Optional field validation ---

	it('rejects non-number minzoom', () => {
		const errors = validateLayer({ ...valid, minzoom: 'high' }, 0);
		expect(errors).toContainEqual(expect.stringContaining('minzoom: must be a number'));
	});

	it('rejects out-of-range minzoom', () => {
		const errors = validateLayer({ ...valid, minzoom: 25 }, 0);
		expect(errors).toContainEqual(expect.stringContaining('minzoom: must be between 0 and 24'));
	});

	it('rejects non-number maxzoom', () => {
		const errors = validateLayer({ ...valid, maxzoom: 'low' }, 0);
		expect(errors).toContainEqual(expect.stringContaining('maxzoom: must be a number'));
	});

	it('rejects out-of-range maxzoom', () => {
		const errors = validateLayer({ ...valid, maxzoom: -1 }, 0);
		expect(errors).toContainEqual(expect.stringContaining('maxzoom: must be between 0 and 24'));
	});

	it('rejects non-string source-layer', () => {
		const errors = validateLayer({ ...valid, 'source-layer': 42 }, 0);
		expect(errors).toContainEqual(expect.stringContaining('source-layer: must be a non-empty string'));
	});

	it('rejects empty source-layer', () => {
		const errors = validateLayer({ ...valid, 'source-layer': '  ' }, 0);
		expect(errors).toContainEqual(expect.stringContaining('source-layer: must be a non-empty string'));
	});

	it('rejects non-array filter', () => {
		const errors = validateLayer({ ...valid, filter: 'bad' }, 0);
		expect(errors).toContainEqual(expect.stringContaining('filter: must be an array'));
	});

	it('rejects non-object paint', () => {
		const errors = validateLayer({ ...valid, paint: [1, 2] }, 0);
		expect(errors).toContainEqual(expect.stringContaining('paint: must be an object'));
	});

	it('rejects non-object layout', () => {
		const errors = validateLayer({ ...valid, layout: 'bad' }, 0);
		expect(errors).toContainEqual(expect.stringContaining('layout: must be an object'));
	});

	it('rejects non-string/non-array tooltip', () => {
		const errors = validateLayer({ ...valid, tooltip: 42 }, 0);
		expect(errors).toContainEqual(expect.stringContaining('tooltip: must be a string or array of strings'));
	});

	it('rejects empty tooltip string', () => {
		const errors = validateLayer({ ...valid, tooltip: '  ' }, 0);
		expect(errors).toContainEqual(expect.stringContaining('tooltip: must be a non-empty string'));
	});

	it('rejects empty tooltip array', () => {
		const errors = validateLayer({ ...valid, tooltip: [] }, 0);
		expect(errors).toContainEqual(expect.stringContaining('tooltip: array must not be empty'));
	});

	it('uses correct index in error prefix', () => {
		const errors = validateLayer({ type: 'fill' }, 3);
		expect(errors[0]).toContain('layers[3]');
	});

	// --- renderer ---

	it('accepts renderer: maplibre', () => {
		const errors = validateLayer({ ...valid, renderer: 'maplibre' }, 0);
		expect(errors).toEqual([]);
	});

	it('accepts renderer: deckgl', () => {
		const errors = validateLayer({ ...valid, renderer: 'deckgl' }, 0);
		expect(errors).toEqual([]);
	});

	it('accepts omitted renderer', () => {
		const errors = validateLayer(valid, 0);
		expect(errors).toEqual([]);
	});

	it('rejects invalid renderer value', () => {
		const errors = validateLayer({ ...valid, renderer: 'webgl' }, 0);
		expect(errors).toContainEqual(expect.stringContaining("invalid renderer 'webgl'"));
		expect(errors).toContainEqual(expect.stringContaining('maplibre, deckgl'));
	});

	it('rejects non-string renderer', () => {
		const errors = validateLayer({ ...valid, renderer: 42 }, 0);
		expect(errors).toContainEqual(expect.stringContaining('renderer: must be a string'));
	});

	// --- deckProps ---

	it('accepts deckProps with renderer: deckgl', () => {
		const errors = validateLayer({ ...valid, renderer: 'deckgl', deckProps: { getRadius: 100 } }, 0);
		expect(errors).toEqual([]);
	});

	it('accepts empty deckProps object with renderer: deckgl', () => {
		const errors = validateLayer({ ...valid, renderer: 'deckgl', deckProps: {} }, 0);
		expect(errors).toEqual([]);
	});

	it('rejects non-object deckProps (string)', () => {
		const errors = validateLayer({ ...valid, renderer: 'deckgl', deckProps: 'invalid' }, 0);
		expect(errors).toContainEqual(expect.stringContaining('deckProps: must be an object'));
	});

	it('rejects null deckProps', () => {
		const errors = validateLayer({ ...valid, renderer: 'deckgl', deckProps: null }, 0);
		expect(errors).toContainEqual(expect.stringContaining('deckProps: must be an object'));
	});

	it('rejects array deckProps', () => {
		const errors = validateLayer({ ...valid, renderer: 'deckgl', deckProps: [1, 2] }, 0);
		expect(errors).toContainEqual(expect.stringContaining('deckProps: must be an object'));
	});

	it('warns on deckProps without renderer', () => {
		const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const errors = validateLayer({ ...valid, deckProps: { getRadius: 100 } }, 0);
		expect(errors).toEqual([]);
		expect(spy).toHaveBeenCalledWith(
			expect.stringContaining("deckProps has no effect without renderer: 'deckgl'")
		);
		spy.mockRestore();
	});

	it('warns on deckProps with renderer: maplibre', () => {
		const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const errors = validateLayer({ ...valid, renderer: 'maplibre', deckProps: { getRadius: 100 } }, 0);
		expect(errors).toEqual([]);
		expect(spy).toHaveBeenCalledWith(
			expect.stringContaining("deckProps has no effect without renderer: 'deckgl'")
		);
		spy.mockRestore();
	});
});

describe('validateLayers', () => {
	const validSources = new Set(['parks', 'roads', 'buffered']);

	it('accepts valid layers array', () => {
		const layers = [
			{ id: 'parks-fill', source: 'parks', type: 'fill' },
			{ id: 'roads-line', source: 'roads', type: 'line' },
		];
		const errors = validateLayers(layers, validSources);
		expect(errors).toEqual([]);
	});

	it('accepts empty array', () => {
		const errors = validateLayers([], validSources);
		expect(errors).toEqual([]);
	});

	it('rejects non-array', () => {
		const errors = validateLayers('not-array', validSources);
		expect(errors).toEqual(["'layers' must be an array"]);
	});

	it('rejects duplicate layer IDs', () => {
		const layers = [
			{ id: 'same', source: 'parks', type: 'fill' },
			{ id: 'same', source: 'roads', type: 'line' },
		];
		const errors = validateLayers(layers, validSources);
		expect(errors).toContainEqual(expect.stringContaining("duplicate layer ID 'same'"));
	});

	it('rejects unknown source ID', () => {
		const layers = [{ id: 'a', source: 'nonexistent', type: 'fill' }];
		const errors = validateLayers(layers, validSources);
		expect(errors).toContainEqual(expect.stringContaining("does not reference a valid dataset or operation output"));
	});

	it('accepts valid source references', () => {
		const layers = [
			{ id: 'a', source: 'parks', type: 'fill' },
			{ id: 'b', source: 'buffered', type: 'line' },
		];
		const errors = validateLayers(layers, validSources);
		expect(errors).toEqual([]);
	});

	it('collects errors from multiple invalid layers', () => {
		const layers = [
			{ source: 'parks', type: 'fill' },   // missing id
			{ id: 'a', type: 'fill' },            // missing source
		];
		const errors = validateLayers(layers, validSources);
		expect(errors.length).toBeGreaterThanOrEqual(2);
	});
});
