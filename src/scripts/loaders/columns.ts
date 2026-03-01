/**
 * Coordinate column detection heuristics.
 * Shared by CSV and JSON array loaders.
 */

import type { LoaderOptions } from './types';

/** Common aliases for latitude columns (matched case-insensitively) */
const LAT_ALIASES = ['lat', 'latitude', 'y', 'lat_y', 'point_y', 'ylat', 'coordy'];

/** Common aliases for longitude columns (matched case-insensitively) */
const LNG_ALIASES = ['lng', 'lon', 'long', 'longitude', 'x', 'lng_x', 'lon_x', 'point_x', 'xlong', 'coordx'];

/**
 * Detect latitude and longitude columns from a list of header names.
 * Uses explicit overrides if provided, otherwise matches against common aliases.
 *
 * @throws Error if coordinate columns cannot be identified
 */
export function detectCoordinateColumns(
	headers: string[],
	options?: LoaderOptions
): { latColumn: string; lngColumn: string } {
	// Use explicit overrides if both are provided
	if (options?.latColumn && options?.lngColumn) {
		const latMatch = headers.find(h => h === options.latColumn);
		const lngMatch = headers.find(h => h === options.lngColumn);
		if (!latMatch) throw new Error(`Specified latColumn '${options.latColumn}' not found in headers`);
		if (!lngMatch) throw new Error(`Specified lngColumn '${options.lngColumn}' not found in headers`);
		return { latColumn: latMatch, lngColumn: lngMatch };
	}

	// Build a lowercase-to-original-name map
	const lcMap = new Map<string, string>();
	for (const h of headers) {
		lcMap.set(h.toLowerCase(), h);
	}

	// Find lat column
	let latColumn: string | undefined;
	for (const alias of LAT_ALIASES) {
		const match = lcMap.get(alias);
		if (match) { latColumn = match; break; }
	}

	// Find lng column
	let lngColumn: string | undefined;
	for (const alias of LNG_ALIASES) {
		const match = lcMap.get(alias);
		if (match) { lngColumn = match; break; }
	}

	if (!latColumn || !lngColumn) {
		const found = [latColumn && 'lat', lngColumn && 'lng'].filter(Boolean).join(', ');
		const hint = found ? ` (found ${found} only)` : '';
		throw new Error(
			`Could not auto-detect coordinate columns${hint}. ` +
			`Headers: ${headers.join(', ')}`
		);
	}

	return { latColumn, lngColumn };
}
