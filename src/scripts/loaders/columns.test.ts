/**
 * Unit tests for columns.ts
 * Tests coordinate column auto-detection heuristics.
 */

import { describe, it, expect } from 'vitest';
import { detectCoordinateColumns } from './columns';

describe('detectCoordinateColumns', () => {
	it('explicit override latColumn/lngColumn', () => {
		const result = detectCoordinateColumns(
			['name', 'my_lat', 'my_lng'],
			{ latColumn: 'my_lat', lngColumn: 'my_lng' }
		);
		expect(result).toEqual({ latColumn: 'my_lat', lngColumn: 'my_lng' });
	});

	it('explicit override with wrong column name throws', () => {
		expect(() => detectCoordinateColumns(
			['name', 'lat', 'lng'],
			{ latColumn: 'nope', lngColumn: 'lng' }
		)).toThrow("latColumn 'nope' not found");
	});

	it('auto-detect lat/lng columns', () => {
		const result = detectCoordinateColumns(['name', 'lat', 'lng']);
		expect(result).toEqual({ latColumn: 'lat', lngColumn: 'lng' });
	});

	it('auto-detect latitude/longitude columns', () => {
		const result = detectCoordinateColumns(['id', 'latitude', 'longitude']);
		expect(result).toEqual({ latColumn: 'latitude', lngColumn: 'longitude' });
	});

	it('auto-detect y/x columns', () => {
		const result = detectCoordinateColumns(['id', 'y', 'x']);
		expect(result).toEqual({ latColumn: 'y', lngColumn: 'x' });
	});

	it('case-insensitive matching', () => {
		const result = detectCoordinateColumns(['Name', 'LAT', 'LNG']);
		expect(result).toEqual({ latColumn: 'LAT', lngColumn: 'LNG' });
	});

	it('mixed case headers', () => {
		const result = detectCoordinateColumns(['ID', 'Latitude', 'Longitude', 'Value']);
		expect(result).toEqual({ latColumn: 'Latitude', lngColumn: 'Longitude' });
	});

	it('no coordinate columns throws with helpful message', () => {
		expect(() => detectCoordinateColumns(['name', 'value', 'desc']))
			.toThrow('Could not auto-detect coordinate columns');
	});

	it('only lat found throws with partial hint', () => {
		expect(() => detectCoordinateColumns(['name', 'lat', 'value']))
			.toThrow('found lat only');
	});

	it('only lng found throws with partial hint', () => {
		expect(() => detectCoordinateColumns(['name', 'lng', 'value']))
			.toThrow('found lng only');
	});

	it('handles extra unrelated headers', () => {
		const result = detectCoordinateColumns(['id', 'name', 'lat', 'lng', 'type', 'area']);
		expect(result).toEqual({ latColumn: 'lat', lngColumn: 'lng' });
	});

	it('prefers lat over y when both present', () => {
		const result = detectCoordinateColumns(['lat', 'lng', 'y', 'x']);
		expect(result.latColumn).toBe('lat');
		expect(result.lngColumn).toBe('lng');
	});
});
