/**
 * Unit conversion utilities for spatial operations.
 *
 * All operations work internally in degrees (DuckDB spatial lacks GEOGRAPHY type).
 * This module provides:
 * - Unit ↔ meters conversion (km, feet, miles)
 * - Meters ↔ degrees conversion (latitude-adjusted approximation)
 * - Unit suffix mapping for dynamic property names (e.g. dist_km)
 */

/** Supported distance units */
export type DistanceUnit = 'meters' | 'km' | 'feet' | 'miles';

/** Valid unit values for runtime validation (mirrors DistanceUnit) */
export const VALID_DISTANCE_UNITS: DistanceUnit[] = ['meters', 'km', 'feet', 'miles'];

/** Conversion factors: unit → meters */
const TO_METERS: Record<DistanceUnit, number> = {
	meters: 1,
	km: 1000,
	feet: 0.3048,
	miles: 1609.344,
};

/** Short suffixes for property name construction (e.g. dist_km, dist_ft) */
const UNIT_SUFFIX: Record<DistanceUnit, string> = {
	meters: 'm',
	km: 'km',
	feet: 'ft',
	miles: 'mi',
};

/** Convert a value from any supported unit to meters. */
export function toMeters(value: number, unit: DistanceUnit): number {
	return value * TO_METERS[unit];
}

/** Convert a value from meters to any supported unit. */
export function fromMeters(meters: number, unit: DistanceUnit): number {
	return meters / TO_METERS[unit];
}

/** Get the short suffix for a unit (e.g. 'km' → 'km', 'miles' → 'mi'). */
export function unitSuffix(unit: DistanceUnit): string {
	return UNIT_SUFFIX[unit];
}

/**
 * Convert meters to approximate degrees at a given latitude.
 * At equator: 1 degree ≈ 111,320 meters.
 * Averages lat/lon degree lengths to account for longitude compression.
 */
export function metersToDegreesAtLatitude(meters: number, latitude: number): number {
	const METERS_PER_DEGREE_LAT = 111320;
	const latRadians = (latitude * Math.PI) / 180;
	const metersPerDegreeLon = METERS_PER_DEGREE_LAT * Math.cos(latRadians);
	const avgMetersPerDegree = (METERS_PER_DEGREE_LAT + metersPerDegreeLon) / 2;
	return meters / avgMetersPerDegree;
}

/**
 * Convert degrees back to approximate meters at a given latitude.
 * Inverse of metersToDegreesAtLatitude.
 */
export function degreesToMetersAtLatitude(degrees: number, latitude: number): number {
	const METERS_PER_DEGREE_LAT = 111320;
	const latRadians = (latitude * Math.PI) / 180;
	const metersPerDegreeLon = METERS_PER_DEGREE_LAT * Math.cos(latRadians);
	const avgMetersPerDegree = (METERS_PER_DEGREE_LAT + metersPerDegreeLon) / 2;
	return degrees * avgMetersPerDegree;
}
