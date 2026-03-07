/**
 * Unit tests for unit-conversion.ts
 * Tests distance unit conversions, degree/meter approximations, and UTM zone derivation.
 */

import { describe, it, expect } from 'vitest';
import {
	toMeters,
	fromMeters,
	unitSuffix,
	metersToDegreesAtLatitude,
	degreesToMetersAtLatitude,
	getUtmEpsg,
} from './unit-conversion';

describe('toMeters', () => {
	it('meters passthrough', () => {
		expect(toMeters(100, 'meters')).toBe(100);
	});

	it('km to meters', () => {
		expect(toMeters(1, 'km')).toBe(1000);
	});

	it('feet to meters', () => {
		expect(toMeters(1, 'feet')).toBeCloseTo(0.3048, 4);
	});

	it('miles to meters', () => {
		expect(toMeters(1, 'miles')).toBeCloseTo(1609.344, 3);
	});
});

describe('fromMeters', () => {
	it('meters to km', () => {
		expect(fromMeters(1000, 'km')).toBe(1);
	});

	it('meters to feet', () => {
		expect(fromMeters(0.3048, 'feet')).toBeCloseTo(1, 4);
	});

	it('meters to miles', () => {
		expect(fromMeters(1609.344, 'miles')).toBeCloseTo(1, 4);
	});

	it('roundtrip: toMeters then fromMeters returns original', () => {
		const original = 42;
		for (const unit of ['km', 'feet', 'miles', 'meters'] as const) {
			expect(fromMeters(toMeters(original, unit), unit)).toBeCloseTo(original, 10);
		}
	});
});

describe('unitSuffix', () => {
	it('meters -> m', () => {
		expect(unitSuffix('meters')).toBe('m');
	});

	it('km -> km', () => {
		expect(unitSuffix('km')).toBe('km');
	});

	it('feet -> ft', () => {
		expect(unitSuffix('feet')).toBe('ft');
	});

	it('miles -> mi', () => {
		expect(unitSuffix('miles')).toBe('mi');
	});
});

describe('metersToDegreesAtLatitude / degreesToMetersAtLatitude', () => {
	it('equator: ~111320 meters per degree', () => {
		const degrees = metersToDegreesAtLatitude(111320, 0);
		// At equator, lat and lon degrees are both ~111320m, so avg is 111320
		expect(degrees).toBeCloseTo(1, 1);
	});

	it('higher latitude produces larger degree value (longitude compressed)', () => {
		const degreesEquator = metersToDegreesAtLatitude(1000, 0);
		const degrees49N = metersToDegreesAtLatitude(1000, 49);
		// At higher lat, fewer meters per degree of longitude, so same meters = more degrees
		expect(degrees49N).toBeGreaterThan(degreesEquator);
	});

	it('roundtrip: meters -> degrees -> meters returns approximately original', () => {
		const meters = 5000;
		const lat = 49;
		const degrees = metersToDegreesAtLatitude(meters, lat);
		const back = degreesToMetersAtLatitude(degrees, lat);
		expect(back).toBeCloseTo(meters, 1);
	});

	it('near-pole latitude still returns a finite value', () => {
		const degrees = metersToDegreesAtLatitude(1000, 89);
		expect(Number.isFinite(degrees)).toBe(true);
		expect(degrees).toBeGreaterThan(0);
	});
});

describe('getUtmEpsg', () => {
	it('Vancouver (49N, -123W) -> EPSG:32610 (zone 10N)', () => {
		expect(getUtmEpsg(49, -123)).toBe('EPSG:32610');
	});

	it('London (51.5N, -0.1W) -> EPSG:32630 (zone 30N)', () => {
		expect(getUtmEpsg(51.5, -0.1)).toBe('EPSG:32630');
	});

	it('southern hemisphere -> 327xx prefix', () => {
		// Sydney: ~-33.9S, 151.2E -> zone 56S
		const result = getUtmEpsg(-33.9, 151.2);
		expect(result).toMatch(/^EPSG:327/);
	});

	it('polar region >84N returns null', () => {
		expect(getUtmEpsg(85, 0)).toBeNull();
	});

	it('polar region <-80S returns null', () => {
		expect(getUtmEpsg(-81, 0)).toBeNull();
	});

	it('zone boundary: lng=-180 -> zone 1', () => {
		expect(getUtmEpsg(0, -180)).toBe('EPSG:32601');
	});

	it('zone pads to two digits', () => {
		// Zone 1 should be 01
		expect(getUtmEpsg(0, -177)).toBe('EPSG:32601');
	});
});
