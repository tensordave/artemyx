/**
 * CRS detection and resolution utilities.
 * Parses CRS authority strings from various formats (URN, PROJJSON, bare authority)
 * and resolves the effective source CRS for reprojection.
 */

/** CRS identifiers that are equivalent to WGS84 lon/lat */
const WGS84_CODES = new Set(['EPSG:4326', 'EPSG:4979', 'EPSG:4269', 'CRS:84', 'CRS84', 'OGC:CRS84']);

/**
 * Parse a CRS authority string from various input formats.
 * Returns a normalized authority:code string (e.g. 'EPSG:27700') or null if unrecognized.
 *
 * Supported inputs:
 * - URN: "urn:ogc:def:crs:EPSG::27700"
 * - OGC CRS84: "urn:ogc:def:crs:OGC:1.3:CRS84" -> "EPSG:4326"
 * - Bare authority: "EPSG:27700" (pass-through)
 * - PROJJSON object: { "id": { "authority": "EPSG", "code": 27700 } }
 */
export function parseCrsAuthority(input: unknown): string | null {
	if (input === null || input === undefined) return null;

	// PROJJSON object with id.authority and id.code
	if (typeof input === 'object') {
		const obj = input as Record<string, unknown>;
		const id = obj.id as Record<string, unknown> | undefined;
		if (id?.authority && id?.code !== undefined) {
			return `${id.authority}:${id.code}`;
		}
		return null;
	}

	if (typeof input !== 'string') return null;
	const str = input.trim();
	if (!str) return null;

	// URN format: urn:ogc:def:crs:AUTHORITY:VERSION:CODE
	const urnMatch = str.match(/^urn:ogc:def:crs:([^:]+):[^:]*:(.+)$/i);
	if (urnMatch) {
		const authority = urnMatch[1].toUpperCase();
		const code = urnMatch[2];

		// OGC CRS84 is WGS84 lon/lat
		if (authority === 'OGC' && code.toUpperCase() === 'CRS84') {
			return 'EPSG:4326';
		}
		return `${authority}:${code}`;
	}

	// Bare authority:code format (e.g. "EPSG:27700", "ESRI:102001")
	if (/^[A-Za-z]+:\S+$/.test(str)) {
		return str;
	}

	return null;
}

/**
 * Check whether a CRS string represents WGS84 (no reprojection needed).
 */
export function isWgs84(crs: string): boolean {
	return WGS84_CODES.has(crs.toUpperCase());
}

/**
 * Resolve the effective source CRS using the priority chain:
 * 1. Explicit config crs (dataset.crs) - highest priority
 * 2. Detected from file metadata (GeoJSON crs member, GeoParquet geo metadata)
 * 3. Map-level fallback (map.crs) - for formats without metadata (CSV, JSON array)
 * 4. EPSG:4326 default - implicit WGS84, no reprojection
 *
 * Returns the CRS string to use with ST_Transform, or null if already WGS84.
 */
/**
 * Check if a FeatureCollection contains coordinates outside WGS84 range,
 * indicating the data is in a projected CRS (e.g. UTM with meter values).
 * Samples up to 5 features for performance.
 */
export function hasProjectedCoordinates(data: GeoJSON.FeatureCollection): boolean {
	const sample = data.features.slice(0, 5);

	for (const feature of sample) {
		const coords = feature.geometry && 'coordinates' in feature.geometry
			? (feature.geometry as any).coordinates
			: undefined;
		if (!coords || !Array.isArray(coords)) continue;

		const check = (c: any): boolean => {
			if (Array.isArray(c) && c.length >= 2 && typeof c[0] === 'number') {
				return Math.abs(c[0]) > 180 || Math.abs(c[1]) > 90;
			}
			return false;
		};

		const walkCoords = (c: any): boolean => {
			if (check(c)) return true;
			if (Array.isArray(c)) {
				for (const inner of c) {
					if (walkCoords(inner)) return true;
				}
			}
			return false;
		};

		if (walkCoords(coords)) return true;
	}

	return false;
}

export function resolveSourceCrs(
	configCrs: string | undefined,
	detectedCrs: string | undefined,
	mapCrs: string | undefined,
): string | null {
	const effective = configCrs ?? detectedCrs ?? mapCrs ?? 'EPSG:4326';
	return isWgs84(effective) ? null : effective;
}
