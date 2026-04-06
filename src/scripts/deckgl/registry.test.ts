import { describe, it, expect, beforeEach } from 'vitest';
import {
	registerLayer,
	unregisterLayer,
	getRenderer,
	isDeckGL,
	getLayersByDataset,
	clearRegistry
} from './registry';

describe('renderer registry', () => {
	beforeEach(() => {
		clearRegistry();
	});

	it('returns maplibre for unregistered layer IDs', () => {
		expect(getRenderer('unknown-layer')).toBe('maplibre');
	});

	it('registers and retrieves a maplibre layer', () => {
		registerLayer('my-fill', 'maplibre', 'parks');
		expect(getRenderer('my-fill')).toBe('maplibre');
		expect(isDeckGL('my-fill')).toBe(false);
	});

	it('registers and retrieves a deckgl layer', () => {
		registerLayer('my-deck', 'deckgl', 'parks');
		expect(getRenderer('my-deck')).toBe('deckgl');
		expect(isDeckGL('my-deck')).toBe(true);
	});

	it('unregisters a layer', () => {
		registerLayer('temp', 'deckgl', 'data');
		unregisterLayer('temp');
		expect(getRenderer('temp')).toBe('maplibre');
		expect(isDeckGL('temp')).toBe(false);
	});

	it('unregister is a no-op for unknown IDs', () => {
		unregisterLayer('nonexistent');
	});

	describe('getLayersByDataset', () => {
		beforeEach(() => {
			registerLayer('parks-fill', 'maplibre', 'parks');
			registerLayer('parks-line', 'maplibre', 'parks');
			registerLayer('parks-deck', 'deckgl', 'parks');
			registerLayer('roads-fill', 'maplibre', 'roads');
		});

		it('returns all layers for a dataset', () => {
			const result = getLayersByDataset('parks');
			expect(result).toHaveLength(3);
			expect(result).toContain('parks-fill');
			expect(result).toContain('parks-line');
			expect(result).toContain('parks-deck');
		});

		it('filters by renderer', () => {
			expect(getLayersByDataset('parks', 'deckgl')).toEqual(['parks-deck']);
			expect(getLayersByDataset('parks', 'maplibre')).toEqual(['parks-fill', 'parks-line']);
		});

		it('returns empty for unknown dataset', () => {
			expect(getLayersByDataset('buildings')).toEqual([]);
		});

		it('returns empty when no layers match the renderer filter', () => {
			expect(getLayersByDataset('roads', 'deckgl')).toEqual([]);
		});
	});

	it('clearRegistry removes all entries', () => {
		registerLayer('a', 'deckgl', 'ds1');
		registerLayer('b', 'maplibre', 'ds2');
		clearRegistry();
		expect(getLayersByDataset('ds1')).toEqual([]);
		expect(getLayersByDataset('ds2')).toEqual([]);
		expect(getRenderer('a')).toBe('maplibre');
	});
});
