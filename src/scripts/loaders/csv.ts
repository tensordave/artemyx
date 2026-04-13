/**
 * CSV format loader.
 * Parses CSV text, auto-detects delimiter, lat/lng columns, and WKT geometry columns.
 * Builds GeoJSON FeatureCollection (Point from lat/lng, any geometry from WKT).
 */

import type { FormatLoader, LoaderData, LoaderOptions, LoaderResult } from './types';
import { detectCoordinateColumns } from './columns';

/** Candidate delimiters in preference order */
const CANDIDATE_DELIMITERS = [',', ';', '\t', '|'];

/**
 * Detect the delimiter used in a CSV header line.
 * Counts occurrences of each candidate outside quoted fields
 * and returns the one with the highest count.
 * Falls back to comma when no candidate is found.
 */
export function detectDelimiter(headerLine: string): string {
	let bestDelim = ',';
	let bestCount = 0;

	for (const delim of CANDIDATE_DELIMITERS) {
		let count = 0;
		let inQuotes = false;
		for (const ch of headerLine) {
			if (ch === '"') inQuotes = !inQuotes;
			else if (ch === delim && !inQuotes) count++;
		}
		if (count > bestCount) {
			bestCount = count;
			bestDelim = delim;
		}
	}

	return bestDelim;
}

/**
 * Parse CSV text into an array of objects keyed by header names.
 * Auto-detects delimiter from the header row.
 * Handles quoted fields, embedded delimiters, and CRLF/LF line endings.
 */
export function parseCSV(text: string): Record<string, string>[] {
	const rows: Record<string, string>[] = [];
	const lines = splitCSVLines(text);
	if (lines.length < 2) return rows;

	const delimiter = detectDelimiter(lines[0]);
	const headers = parseCSVRow(lines[0], delimiter);

	for (let i = 1; i < lines.length; i++) {
		const line = lines[i].trim();
		if (line === '') continue;

		const values = parseCSVRow(line, delimiter);
		const row: Record<string, string> = {};
		for (let j = 0; j < headers.length; j++) {
			row[headers[j]] = values[j] ?? '';
		}
		rows.push(row);
	}

	return rows;
}

/**
 * Split CSV text into logical lines, respecting quoted fields that span newlines.
 */
function splitCSVLines(text: string): string[] {
	const lines: string[] = [];
	let current = '';
	let inQuotes = false;

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === '"') {
			inQuotes = !inQuotes;
			current += ch;
		} else if ((ch === '\n' || ch === '\r') && !inQuotes) {
			lines.push(current);
			current = '';
			// Skip \r\n as single line break
			if (ch === '\r' && text[i + 1] === '\n') i++;
		} else {
			current += ch;
		}
	}
	if (current) lines.push(current);

	return lines;
}

/**
 * Parse a single CSV row into field values, handling quoted fields.
 */
function parseCSVRow(line: string, delimiter: string): string[] {
	const fields: string[] = [];
	let current = '';
	let inQuotes = false;

	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === '"') {
			if (inQuotes && line[i + 1] === '"') {
				current += '"';
				i++; // skip escaped quote
			} else {
				inQuotes = !inQuotes;
			}
		} else if (ch === delimiter && !inQuotes) {
			fields.push(current.trim());
			current = '';
		} else {
			current += ch;
		}
	}
	fields.push(current.trim());

	return fields;
}

/**
 * Parse a combined "lat, lng" or "lat,lng" value into separate numbers.
 * Returns null if the value cannot be parsed as a coordinate pair.
 */
function parseGeoPoint(value: string): { lat: number; lng: number } | null {
	const parts = value.split(',');
	if (parts.length !== 2) return null;

	const lat = parseFloat(parts[0].trim());
	const lng = parseFloat(parts[1].trim());
	if (isNaN(lat) || isNaN(lng)) return null;

	return { lat, lng };
}

/**
 * Convert parsed CSV rows to a GeoJSON Point FeatureCollection
 * using a single combined coordinate column (e.g. "49.25, -123.11").
 * Rows with invalid/missing coordinates are skipped.
 */
function rowsFromGeoColumn(
	rows: Record<string, string>[],
	geoCol: string
): GeoJSON.FeatureCollection {
	const features: GeoJSON.Feature[] = [];

	for (const row of rows) {
		const raw = row[geoCol];
		if (!raw) continue;

		const coords = parseGeoPoint(raw);
		if (!coords) continue;

		// Build properties from all columns except the geo column
		const properties: Record<string, string | number> = {};
		for (const [key, value] of Object.entries(row)) {
			if (key === geoCol) continue;
			const num = Number(value);
			properties[key] = value !== '' && !isNaN(num) ? num : value;
		}

		features.push({
			type: 'Feature',
			geometry: {
				type: 'Point',
				coordinates: [coords.lng, coords.lat],
			},
			properties,
		});
	}

	return { type: 'FeatureCollection', features };
}

/**
 * Convert parsed CSV rows to a GeoJSON Point FeatureCollection
 * using separate lat/lng columns.
 * Rows with invalid/missing coordinates are skipped.
 */
function rowsToFeatureCollection(
	rows: Record<string, string>[],
	latCol: string,
	lngCol: string
): GeoJSON.FeatureCollection {
	const features: GeoJSON.Feature[] = [];

	for (const row of rows) {
		const lat = parseFloat(row[latCol]);
		const lng = parseFloat(row[lngCol]);
		if (isNaN(lat) || isNaN(lng)) continue;

		// Build properties from all columns except lat/lng
		const properties: Record<string, string | number> = {};
		for (const [key, value] of Object.entries(row)) {
			if (key === latCol || key === lngCol) continue;
			// Try to parse numbers, keep strings otherwise
			const num = Number(value);
			properties[key] = value !== '' && !isNaN(num) ? num : value;
		}

		features.push({
			type: 'Feature',
			geometry: {
				type: 'Point',
				coordinates: [lng, lat],
			},
			properties,
		});
	}

	return { type: 'FeatureCollection', features };
}

/** Common aliases for combined coordinate columns (matched case-insensitively) */
const GEO_COLUMN_ALIASES = [
	'googlemapdest', 'geo_point_2d', 'latlng', 'lat_lng', 'latlong',
	'coordinates', 'location', 'geolocation', 'geo_point', 'point',
];

/**
 * Auto-detect a combined "lat, lng" coordinate column.
 * Checks known aliases first, then scans all columns for a value
 * that parses as a "lat, lng" pair.
 *
 * @returns The original-case column name, or null if none found.
 */
function detectGeoColumn(
	headers: string[],
	firstRow: Record<string, string>
): string | null {
	const lcMap = new Map<string, string>();
	for (const h of headers) lcMap.set(h.toLowerCase(), h);

	// Check known combined-column aliases
	for (const alias of GEO_COLUMN_ALIASES) {
		const match = lcMap.get(alias);
		if (match && firstRow[match] && parseGeoPoint(firstRow[match])) return match;
	}

	// Fallback: scan all columns for a value matching "lat, lng" pattern
	for (const h of headers) {
		if (firstRow[h] && parseGeoPoint(firstRow[h])) return h;
	}

	return null;
}

// ── Geometry string support (WKT and GeoJSON) ───────────────────────────────

/** WKT geometry type prefixes (uppercased for matching) */
const WKT_PREFIXES = [
	'POINT', 'LINESTRING', 'POLYGON',
	'MULTIPOINT', 'MULTILINESTRING', 'MULTIPOLYGON',
	'GEOMETRYCOLLECTION',
];

/** GeoJSON geometry type names */
const GEOJSON_GEOMETRY_TYPES = new Set([
	'Point', 'MultiPoint', 'LineString', 'MultiLineString',
	'Polygon', 'MultiPolygon', 'GeometryCollection',
]);

/** Common column names for geometry columns (matched case-insensitively) */
const GEOMETRY_COLUMN_ALIASES = ['geometry', 'geom', 'wkt', 'the_geom', 'shape'];

/**
 * Check whether a string value looks like WKT geometry.
 * Matches type prefix followed by space, '(', or 'EMPTY'.
 */
export function isWktValue(value: string): boolean {
	const upper = value.trim().toUpperCase();
	for (const prefix of WKT_PREFIXES) {
		if (!upper.startsWith(prefix)) continue;
		const rest = upper.slice(prefix.length);
		// Allow optional Z/M/ZM suffix before the opening paren or EMPTY
		const afterType = rest.replace(/^\s*(Z|M|ZM)\b/, '').trimStart();
		if (afterType.startsWith('(') || afterType === 'EMPTY') return true;
	}
	return false;
}

/**
 * Parse a JSON string as a GeoJSON Geometry.
 * Handles raw geometry objects and Feature wrappers.
 */
export function parseGeoJsonGeometry(value: string): GeoJSON.Geometry | null {
	let parsed: unknown;
	try { parsed = JSON.parse(value); } catch { return null; }
	if (typeof parsed !== 'object' || parsed === null) return null;

	const obj = parsed as Record<string, unknown>;

	// Raw geometry: {"type": "LineString", "coordinates": [...]}
	if (typeof obj.type === 'string' && GEOJSON_GEOMETRY_TYPES.has(obj.type) && 'coordinates' in obj) {
		return parsed as GeoJSON.Geometry;
	}

	// Feature wrapper: {"type": "Feature", "geometry": {...}}
	if (obj.type === 'Feature' && typeof obj.geometry === 'object' && obj.geometry !== null) {
		const geom = obj.geometry as Record<string, unknown>;
		if (typeof geom.type === 'string' && GEOJSON_GEOMETRY_TYPES.has(geom.type) && 'coordinates' in geom) {
			return obj.geometry as GeoJSON.Geometry;
		}
	}

	return null;
}

/**
 * Check whether a string value looks like a GeoJSON geometry JSON string.
 * Quick check: must start with '{' and contain a known geometry type.
 */
export function isGeoJsonGeometryValue(value: string): boolean {
	const trimmed = value.trim();
	if (!trimmed.startsWith('{')) return false;
	return parseGeoJsonGeometry(trimmed) !== null;
}

/**
 * Check whether a string value contains geometry in any supported format (WKT or GeoJSON).
 */
export function isGeometryValue(value: string): boolean {
	return isWktValue(value) || isGeoJsonGeometryValue(value);
}

/**
 * Auto-detect a column containing geometry strings (WKT or GeoJSON).
 * Checks known column name aliases first, then scans all columns.
 */
export function detectGeometryColumn(
	headers: string[],
	firstRow: Record<string, string>
): string | null {
	const lcMap = new Map<string, string>();
	for (const h of headers) lcMap.set(h.toLowerCase(), h);

	// Check known geometry column aliases
	for (const alias of GEOMETRY_COLUMN_ALIASES) {
		const match = lcMap.get(alias);
		if (match && firstRow[match] && isGeometryValue(firstRow[match])) return match;
	}

	// Fallback: scan all columns for a geometry value
	for (const h of headers) {
		if (firstRow[h] && isGeometryValue(firstRow[h])) return h;
	}

	return null;
}

/** @deprecated Use detectGeometryColumn instead */
export const detectWktColumn = detectGeometryColumn;

/** Parse a "x y" or "x y z" coordinate string into [x, y] */
function parseCoordPair(s: string): [number, number] | null {
	const parts = s.trim().split(/\s+/);
	if (parts.length < 2) return null;
	const x = parseFloat(parts[0]);
	const y = parseFloat(parts[1]);
	if (isNaN(x) || isNaN(y)) return null;
	return [x, y];
}

/** Parse a comma-separated list of coordinate pairs */
function parseCoordList(s: string): [number, number][] | null {
	const pairs = s.split(',');
	const coords: [number, number][] = [];
	for (const p of pairs) {
		const trimmed = p.trim();
		if (!trimmed) continue;
		const coord = parseCoordPair(trimmed);
		if (!coord) return null;
		coords.push(coord);
	}
	return coords.length > 0 ? coords : null;
}

/**
 * Split a string at top-level commas (depth-0 relative to parentheses).
 * Used to split multi-geometry bodies without breaking nested coordinate lists.
 */
function splitTopLevel(s: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let current = '';
	for (const ch of s) {
		if (ch === '(') { depth++; current += ch; }
		else if (ch === ')') { depth--; current += ch; }
		else if (ch === ',' && depth === 0) {
			parts.push(current.trim());
			current = '';
		} else {
			current += ch;
		}
	}
	if (current.trim()) parts.push(current.trim());
	return parts;
}

/** Strip one layer of outer parentheses: "(content)" -> "content" */
function stripOuter(s: string): string {
	const t = s.trim();
	if (t.startsWith('(') && t.endsWith(')')) return t.slice(1, -1).trim();
	return t;
}

/**
 * Parse a WKT string into a GeoJSON Geometry, or null if invalid.
 * Supports: Point, LineString, Polygon, Multi variants, GeometryCollection.
 * WKT coordinate order (X Y = lng lat) matches GeoJSON order.
 */
export function parseWkt(wkt: string): GeoJSON.Geometry | null {
	const trimmed = wkt.trim();
	if (!trimmed) return null;

	// Extract type name and body
	const parenIdx = trimmed.indexOf('(');
	if (parenIdx === -1) {
		// Could be "TYPE EMPTY"
		if (/EMPTY$/i.test(trimmed)) return null;
		return null;
	}

	const typePart = trimmed.slice(0, parenIdx).trim().toUpperCase();
	// Strip optional Z/M/ZM suffix
	const typeClean = typePart.replace(/\s+(Z|M|ZM)$/, '');
	const body = trimmed.slice(parenIdx + 1, trimmed.lastIndexOf(')')).trim();

	switch (typeClean) {
		case 'POINT': {
			const coord = parseCoordPair(body);
			return coord ? { type: 'Point', coordinates: coord } : null;
		}
		case 'LINESTRING': {
			const coords = parseCoordList(body);
			return coords ? { type: 'LineString', coordinates: coords } : null;
		}
		case 'POLYGON': {
			const rings = splitTopLevel(body).map(r => parseCoordList(stripOuter(r)));
			if (rings.some(r => r === null)) return null;
			return { type: 'Polygon', coordinates: rings as [number, number][][] };
		}
		case 'MULTIPOINT': {
			// MULTIPOINT ((x y), (x y)) or MULTIPOINT (x y, x y)
			const inner = body.trim();
			let points: [number, number][];
			if (inner.includes('(')) {
				const parsed = splitTopLevel(inner).map(p => parseCoordPair(stripOuter(p)));
				if (parsed.some(p => p === null)) return null;
				points = parsed as [number, number][];
			} else {
				const parsed = parseCoordList(inner);
				if (!parsed) return null;
				points = parsed;
			}
			return { type: 'MultiPoint', coordinates: points };
		}
		case 'MULTILINESTRING': {
			const lines = splitTopLevel(body).map(l => parseCoordList(stripOuter(l)));
			if (lines.some(l => l === null)) return null;
			return { type: 'MultiLineString', coordinates: lines as [number, number][][] };
		}
		case 'MULTIPOLYGON': {
			const polygons = splitTopLevel(body).map(p => {
				const rings = splitTopLevel(stripOuter(p)).map(r => parseCoordList(stripOuter(r)));
				if (rings.some(r => r === null)) return null;
				return rings as [number, number][][];
			});
			if (polygons.some(p => p === null)) return null;
			return { type: 'MultiPolygon', coordinates: polygons as [number, number][][][] };
		}
		case 'GEOMETRYCOLLECTION': {
			const geoms = splitTopLevel(body).map(g => parseWkt(g));
			if (geoms.some(g => g === null)) return null;
			return { type: 'GeometryCollection', geometries: geoms as GeoJSON.Geometry[] };
		}
		default:
			return null;
	}
}

/**
 * Parse a geometry string value in any supported format (WKT or GeoJSON).
 */
function parseGeometryValue(value: string): GeoJSON.Geometry | null {
	return parseWkt(value) ?? parseGeoJsonGeometry(value);
}

/**
 * Convert parsed CSV rows to a GeoJSON FeatureCollection using a geometry column
 * containing WKT or GeoJSON strings. Rows with invalid/missing geometry are skipped.
 */
function rowsFromGeometryColumn(
	rows: Record<string, string>[],
	geomCol: string
): GeoJSON.FeatureCollection {
	const features: GeoJSON.Feature[] = [];

	for (const row of rows) {
		const raw = row[geomCol];
		if (!raw) continue;

		const geometry = parseGeometryValue(raw);
		if (!geometry) continue;

		const properties: Record<string, string | number> = {};
		for (const [key, value] of Object.entries(row)) {
			if (key === geomCol) continue;
			const num = Number(value);
			properties[key] = value !== '' && !isNaN(num) ? num : value;
		}

		features.push({ type: 'Feature', geometry, properties });
	}

	return { type: 'FeatureCollection', features };
}

export const csvLoader: FormatLoader = {
	async load(data: LoaderData, options?: LoaderOptions): Promise<LoaderResult> {
		const text = data as string;
		const rows = parseCSV(text);

		if (rows.length === 0) {
			throw new Error('CSV file is empty or has no data rows');
		}

		const headers = Object.keys(rows[0]);

		// Explicit combined coordinate column from config
		if (options?.geoColumn) {
			if (!headers.includes(options.geoColumn)) {
				throw new Error(`Specified geoColumn '${options.geoColumn}' not found in headers: ${headers.join(', ')}`);
			}
			const data = rowsFromGeoColumn(rows, options.geoColumn);
			if (data.features.length === 0) {
				throw new Error(`No valid coordinate pairs found in column '${options.geoColumn}'`);
			}
			return { data };
		}

		// Try geometry column detection (WKT or GeoJSON strings)
		const geomCol = detectGeometryColumn(headers, rows[0]);
		if (geomCol) {
			const data = rowsFromGeometryColumn(rows, geomCol);
			if (data.features.length === 0) {
				throw new Error(`No valid geometries found in column '${geomCol}'`);
			}
			return { data };
		}

		// Try separate lat/lng columns
		try {
			const { latColumn, lngColumn } = detectCoordinateColumns(headers, options);
			const data = rowsToFeatureCollection(rows, latColumn, lngColumn);
			if (data.features.length === 0) {
				throw new Error(`No valid coordinates found in columns '${latColumn}' and '${lngColumn}'`);
			}
			return { data };
		} catch (latLngError) {
			// Fall through to combined geo column detection
		}

		// Try auto-detecting a combined "lat, lng" column
		const geoCol = detectGeoColumn(headers, rows[0]);
		if (geoCol) {
			const data = rowsFromGeoColumn(rows, geoCol);
			if (data.features.length > 0) return { data };
		}

		// No geometry detected — load as non-spatial (table-only) dataset
		const features = rows.map(row => {
			const properties: Record<string, string | number> = {};
			for (const [key, value] of Object.entries(row)) {
				const num = Number(value);
				properties[key] = value !== '' && !isNaN(num) ? num : value;
			}
			return { type: 'Feature' as const, geometry: null as unknown as GeoJSON.Geometry, properties };
		});
		return { data: { type: 'FeatureCollection', features }, nonSpatial: true };
	},
};
