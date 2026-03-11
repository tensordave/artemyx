/**
 * CSV format loader.
 * Parses CSV text, auto-detects delimiter and lat/lng columns,
 * builds GeoJSON Point FeatureCollection.
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

		// Try separate lat/lng columns first
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

		// Nothing worked - throw with helpful message
		throw new Error(
			`Could not detect coordinate columns. ` +
			`No separate lat/lng columns or combined "lat, lng" columns found. ` +
			`Headers: ${headers.join(', ')}`
		);
	},
};
