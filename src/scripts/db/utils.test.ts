/**
 * Unit tests for utils.ts
 * Tests dataset ID generation and name extraction.
 */

import { describe, it, expect } from 'vitest';
import { generateDatasetId, extractDatasetName } from './utils';

describe('generateDatasetId', () => {
	it('returns consistent ID for same URL', () => {
		const url = 'https://example.com/data.geojson';
		expect(generateDatasetId(url)).toBe(generateDatasetId(url));
	});

	it('different URLs produce different IDs', () => {
		const id1 = generateDatasetId('https://example.com/parks.geojson');
		const id2 = generateDatasetId('https://example.com/bikeways.geojson');
		expect(id1).not.toBe(id2);
	});

	it('prefixed with dataset_', () => {
		expect(generateDatasetId('https://example.com/data.geojson')).toMatch(/^dataset_/);
	});

	it('output is hex string after prefix', () => {
		const id = generateDatasetId('https://example.com/data.geojson');
		const hex = id.replace('dataset_', '');
		expect(hex).toMatch(/^[0-9a-f]+$/);
	});

	it('handles empty string input', () => {
		const id = generateDatasetId('');
		expect(id).toBe('dataset_0');
	});

	it('handles very long URLs', () => {
		const url = 'https://example.com/' + 'a'.repeat(10000);
		const id = generateDatasetId(url);
		expect(id).toMatch(/^dataset_[0-9a-f]+$/);
	});

	it('handles URLs with unicode characters', () => {
		const id = generateDatasetId('https://example.com/données.geojson');
		expect(id).toMatch(/^dataset_[0-9a-f]+$/);
	});

	it('handles URLs with query params', () => {
		const withParams = generateDatasetId('https://example.com/data?token=abc');
		const without = generateDatasetId('https://example.com/data');
		expect(withParams).not.toBe(without);
	});
});

describe('extractDatasetName', () => {
	it('extracts filename from path and strips extension', () => {
		expect(extractDatasetName('https://example.com/parks.geojson')).toBe('parks');
	});

	it('returns last path segment when no extension', () => {
		expect(extractDatasetName('https://example.com/api/bikeways')).toBe('bikeways');
	});

	it('returns hostname when path is empty', () => {
		expect(extractDatasetName('https://example.com')).toBe('example.com');
	});

	it('returns hostname when path is just /', () => {
		expect(extractDatasetName('https://example.com/')).toBe('example.com');
	});

	it('returns substring for invalid URLs', () => {
		expect(extractDatasetName('not-a-valid-url')).toBe('not-a-valid-url');
	});

	it('handles URLs with multiple path segments', () => {
		expect(extractDatasetName('https://example.com/api/v2/datasets/parks.csv')).toBe('parks');
	});

	it('truncates long invalid URL strings to 30 chars', () => {
		const longString = 'a'.repeat(50);
		expect(extractDatasetName(longString)).toBe('a'.repeat(30));
	});
});
