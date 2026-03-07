/**
 * Unit conversion utilities for spatial operations.
 *
 * DuckDB spatial lacks a GEOGRAPHY type, so geometry is stored in WGS84 degrees.
 * For geodetic accuracy, operations reproject to a local UTM CRS (meters) via
 * ST_Transform, run the operation, then reproject back to WGS84.
 *
 * This module provides:
 * - Unit ↔ meters conversion (km, feet, miles)
 * - UTM zone derivation from centroid coordinates
 * - Meters ↔ degrees fallback for polar regions outside UTM coverage
 * - Unit suffix mapping for dynamic property names (e.g. dist_km)
 */

import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import type { Logger } from '../../logger';

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

/** Result of projected CRS lookup for a dataset. */
export interface ProjectedCrs {
	epsg: string | null;
	fallback: boolean;
	latitude: number;
}

/**
 * Derive the UTM EPSG code for a given lat/lng coordinate.
 * Returns null if the coordinate is outside UTM coverage (>84°N or <80°S).
 */
export function getUtmEpsg(lat: number, lng: number): string | null {
	if (lat > 84 || lat < -80) return null;
	const zone = Math.floor((lng + 180) / 6) + 1;
	const prefix = lat >= 0 ? 326 : 327;
	return `EPSG:${prefix}${String(zone).padStart(2, '0')}`;
}

/**
 * Compute the centroid of a dataset's features and derive the best projected CRS.
 * Uses UTM zone from the centroid; falls back for polar regions.
 */
export async function getProjectedCrs(
	conn: AsyncDuckDBConnection,
	datasetId: string,
	logger?: Logger
): Promise<ProjectedCrs> {
	const stmt = await conn.prepare(`
		SELECT
			AVG(ST_X(ST_Centroid(geometry))) as avg_lng,
			AVG(ST_Y(ST_Centroid(geometry))) as avg_lat
		FROM features
		WHERE dataset_id = ?
		AND geometry IS NOT NULL
	`);
	const result = await stmt.query(datasetId);
	await stmt.close();
	const row = result.toArray()[0];
	const lat = Number(row?.avg_lat) || 49;
	const lng = Number(row?.avg_lng) || -123;

	const epsg = getUtmEpsg(lat, lng);
	if (!epsg) {
		if (logger) {
			logger.warn('CRS', `Dataset ${datasetId} centroid at ${lat.toFixed(2)}°N is outside UTM coverage, using degree approximation`);
		} else {
			console.warn(`[CRS] Dataset ${datasetId} centroid at ${lat.toFixed(2)}°N is outside UTM coverage, using degree approximation`);
		}
		return { epsg: null, fallback: true, latitude: lat };
	}

	if (logger) {
		logger.info('CRS', `Dataset ${datasetId} centroid at ${lat.toFixed(2)}°N, ${lng.toFixed(2)}°E → ${epsg}`);
	} else {
		console.log(`[CRS] Dataset ${datasetId} centroid at ${lat.toFixed(2)}°N, ${lng.toFixed(2)}°E → ${epsg}`);
	}
	return { epsg, fallback: false, latitude: lat };
}
