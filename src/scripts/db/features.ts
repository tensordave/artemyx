/**
 * Feature query operations
 */

import { getConnection, getDB } from './core';
import { parseWKB } from './wkb';
import type { GeometryType } from './wkb';

/**
 * Get features from DuckDB as a GeoJSON string.
 * Builds the entire FeatureCollection JSON inside DuckDB via string_agg,
 * avoiding per-row JSON.parse in JS and enabling zero-copy Transferable
 * when sent across the worker boundary.
 *
 * @param datasetId Optional dataset ID to filter by. If not provided, returns all features.
 * @returns GeoJSON FeatureCollection as a JSON string
 */
export async function getFeaturesAsGeoJSONString(datasetId?: string): Promise<string> {
	const EMPTY_FC = '{"type":"FeatureCollection","features":[]}';

	try {
		const connection = await getConnection();

		// Build entire FeatureCollection as a single JSON string inside DuckDB.
		// string_agg concatenates per-feature JSON fragments; COALESCE handles
		// the empty-result case (no features → empty array).
		const sql = `
			SELECT '{"type":"FeatureCollection","features":['
				|| COALESCE(string_agg(
					'{"type":"Feature","geometry":'
					|| ST_AsGeoJSON(geometry)
					|| ',"properties":'
					|| COALESCE(properties, '{}')
					|| '}',
					','
				), '')
				|| ']}' as geojson_str
			FROM features
			WHERE geometry IS NOT NULL${datasetId ? ' AND dataset_id = ?' : ''}
		`;

		let result;
		if (datasetId) {
			const stmt = await connection.prepare(sql);
			result = await stmt.query(datasetId);
			await stmt.close();
		} else {
			result = await connection.query(sql);
		}

		const rows = result.toArray();
		if (rows.length === 0 || !rows[0].geojson_str) {
			return EMPTY_FC;
		}

		return rows[0].geojson_str as string;
	} catch (error) {
		console.error('Failed to query features from DuckDB:', error);
		return EMPTY_FC;
	}
}

/**
 * Get features from DuckDB as a GeoJSON object.
 * Convenience wrapper around getFeaturesAsGeoJSONString() for callers
 * that need an in-process object (e.g. within the worker itself).
 */
export async function getFeaturesAsGeoJSON(datasetId?: string): Promise<GeoJSON.FeatureCollection> {
	const str = await getFeaturesAsGeoJSONString(datasetId);
	return JSON.parse(str) as GeoJSON.FeatureCollection;
}

/**
 * Get the bounding box of a dataset's geometry via ST_Extent.
 * Returns [xmin, ymin, xmax, ymax] or null if dataset has no features.
 * Much cheaper than getFeaturesAsGeoJSON when only bounds are needed.
 */
export async function getDatasetBounds(datasetId: string): Promise<[number, number, number, number] | null> {
	try {
		const connection = await getConnection();
		const stmt = await connection.prepare(`
			SELECT
				MIN(ST_XMin(geometry)) as xmin,
				MIN(ST_YMin(geometry)) as ymin,
				MAX(ST_XMax(geometry)) as xmax,
				MAX(ST_YMax(geometry)) as ymax
			FROM features
			WHERE dataset_id = ? AND geometry IS NOT NULL
		`);
		const result = await stmt.query(datasetId);
		await stmt.close();
		const rows = result.toArray();
		if (rows.length === 0 || rows[0].xmin === null) return null;
		return [Number(rows[0].xmin), Number(rows[0].ymin), Number(rows[0].xmax), Number(rows[0].ymax)];
	} catch (error) {
		console.error('Failed to get dataset bounds:', error);
		return null;
	}
}

/**
 * Get distinct property keys for a dataset.
 * Queries one representative feature row and extracts keys from its properties JSON.
 * Filters out internal keys (prefixed with '_').
 */
export async function getPropertyKeys(datasetId: string): Promise<string[]> {
	try {
		const connection = await getConnection();
		const stmt = await connection.prepare(
			'SELECT properties FROM features WHERE dataset_id = ? AND properties IS NOT NULL LIMIT 1'
		);
		const result = await stmt.query(datasetId);
		await stmt.close();

		const rows = result.toArray();
		if (rows.length === 0 || !rows[0].properties) return [];

		const parsed = typeof rows[0].properties === 'string'
			? JSON.parse(rows[0].properties)
			: rows[0].properties;
		return Object.keys(parsed).filter(k => !k.startsWith('_'));
	} catch (error) {
		console.error('Failed to get property keys:', error);
		return [];
	}
}

/**
 * Get distinct geometry types for a dataset.
 * Returns type strings like 'POINT', 'LINESTRING', 'POLYGON',
 * 'MULTIPOINT', 'MULTILINESTRING', 'MULTIPOLYGON'.
 */
export async function getDistinctGeometryTypes(datasetId: string): Promise<Set<string>> {
	const connection = await getConnection();
	const stmt = await connection.prepare(`
		SELECT DISTINCT ST_GeometryType(geometry) as geom_type
		FROM features
		WHERE dataset_id = ? AND geometry IS NOT NULL
	`);
	const result = await stmt.query(datasetId);
	await stmt.close();

	const types = new Set<string>();
	for (const row of result.toArray()) {
		if (row.geom_type) types.add(row.geom_type as string);
	}
	return types;
}

// ── Export functions ─────────────────────────────────────────────────────────

const textEncoder = new TextEncoder();

/**
 * Get all distinct property keys across every feature in a dataset.
 * Unlike getPropertyKeys() which samples one row, this scans all features
 * so no columns are missed in flattened exports.
 */
async function getAllPropertyKeys(datasetId: string): Promise<string[]> {
	const connection = await getConnection();
	const stmt = await connection.prepare(`
		SELECT DISTINCT unnest(json_keys(properties)) as key
		FROM features
		WHERE dataset_id = ? AND properties IS NOT NULL
	`);
	const result = await stmt.query(datasetId);
	await stmt.close();

	const keys: string[] = [];
	for (const row of result.toArray()) {
		const key = row.key as string;
		if (key && !key.startsWith('_')) keys.push(key);
	}
	return keys.sort();
}

/** Escape a property key for use in a DuckDB JSON path expression ('$."key"'). */
function jsonPath(key: string): string {
	const escaped = key.replace(/'/g, "''");
	return `'$."${escaped}"'`;
}

/** Escape a property key for use as a SQL column alias ("key"). */
function sqlAlias(key: string): string {
	return `"${key.replace(/"/g, '""')}"`;
}

/**
 * Build a SELECT expression list that flattens properties JSON into columns.
 * Returns the geometry expression + one column per property key.
 */
function buildFlattenedSelect(keys: string[], geometryExpr: string): string {
	const cols = [geometryExpr];
	for (const key of keys) {
		cols.push(`json_extract_string(properties, ${jsonPath(key)}) AS ${sqlAlias(key)}`);
	}
	return cols.join(', ');
}

/**
 * Export a dataset as a GeoJSON FeatureCollection buffer.
 * Reuses getFeaturesAsGeoJSONString() and encodes to Uint8Array.
 */
export async function exportAsGeoJSON(datasetId: string): Promise<Uint8Array> {
	const str = await getFeaturesAsGeoJSONString(datasetId);
	return textEncoder.encode(str);
}

/**
 * Export a dataset as CSV with flattened property columns.
 * Geometry is serialized as WKT via ST_AsText.
 * Uses DuckDB COPY TO for correct CSV escaping and quoting.
 */
export async function exportAsCSV(datasetId: string): Promise<Uint8Array> {
	const connection = await getConnection();
	const db = await getDB();
	const filename = `_export_${Date.now()}.csv`;

	try {
		// Step 1: Create temp table with parameterized filter
		const createStmt = await connection.prepare(
			'CREATE TEMP TABLE _export_tmp AS SELECT geometry, properties FROM features WHERE dataset_id = ? AND geometry IS NOT NULL'
		);
		await createStmt.query(datasetId);
		await createStmt.close();

		// Step 2: Get all property keys from the temp table
		const keys = await getAllPropertyKeys(datasetId);

		// Step 3: Build and execute COPY TO with flattened columns
		const selectExpr = buildFlattenedSelect(keys, 'ST_AsText(geometry) AS geometry');
		await connection.query(
			`COPY (SELECT ${selectExpr} FROM _export_tmp) TO '${filename}' (FORMAT CSV, HEADER)`
		);

		// Step 4: Read the file buffer
		const buffer = await db.copyFileToBuffer(filename);
		return buffer;
	} finally {
		// Clean up temp table and virtual file
		await connection.query('DROP TABLE IF EXISTS _export_tmp').catch(() => {});
		await db.dropFile(filename).catch(() => {});
	}
}

/**
 * Export a dataset as GeoParquet-compatible Parquet.
 * Geometry is serialized as WKB via ST_AsWKB for GeoParquet compatibility.
 * Properties are flattened to individual columns.
 */
export async function exportAsParquet(datasetId: string): Promise<Uint8Array> {
	const connection = await getConnection();
	const db = await getDB();
	const filename = `_export_${Date.now()}.parquet`;

	try {
		// Step 1: Create temp table with parameterized filter
		const createStmt = await connection.prepare(
			'CREATE TEMP TABLE _export_tmp AS SELECT geometry, properties FROM features WHERE dataset_id = ? AND geometry IS NOT NULL'
		);
		await createStmt.query(datasetId);
		await createStmt.close();

		// Step 2: Get all property keys
		const keys = await getAllPropertyKeys(datasetId);

		// Step 3: Build and execute COPY TO with WKB geometry
		const selectExpr = buildFlattenedSelect(keys, 'ST_AsWKB(geometry) AS geometry');
		await connection.query(
			`COPY (SELECT ${selectExpr} FROM _export_tmp) TO '${filename}' (FORMAT PARQUET)`
		);

		// Step 4: Read the file buffer
		const buffer = await db.copyFileToBuffer(filename);
		return buffer;
	} finally {
		await connection.query('DROP TABLE IF EXISTS _export_tmp').catch(() => {});
		await db.dropFile(filename).catch(() => {});
	}
}

// ── Binary feature collection (deck.gl) ────────────────────────────────────

/**
 * Binary attribute: typed array + component size.
 * Matches @loaders.gl/schema BinaryAttribute shape.
 */
interface BinaryAttribute {
	value: Float64Array | Uint32Array;
	size: number;
}

interface BinaryPointFeature {
	type: 'Point';
	positions: BinaryAttribute;
	featureIds: BinaryAttribute;
	globalFeatureIds: BinaryAttribute;
	numericProps: Record<string, BinaryAttribute>;
	properties: object[];
}

interface BinaryLineFeature {
	type: 'LineString';
	positions: BinaryAttribute;
	pathIndices: BinaryAttribute;
	featureIds: BinaryAttribute;
	globalFeatureIds: BinaryAttribute;
	numericProps: Record<string, BinaryAttribute>;
	properties: object[];
}

interface BinaryPolygonFeature {
	type: 'Polygon';
	positions: BinaryAttribute;
	polygonIndices: BinaryAttribute;
	primitivePolygonIndices: BinaryAttribute;
	featureIds: BinaryAttribute;
	globalFeatureIds: BinaryAttribute;
	numericProps: Record<string, BinaryAttribute>;
	properties: object[];
}

export interface BinaryFeatureCollection {
	shape: 'binary-feature-collection';
	points: BinaryPointFeature;
	lines: BinaryLineFeature;
	polygons: BinaryPolygonFeature;
}

/** Accumulator for building typed arrays incrementally. */
interface GeomAccumulator {
	coords: number[];
	featureIds: number[];
	globalFeatureIds: number[];
	/** Start indices for lines (pathIndices) or polygon rings (primitivePolygonIndices) */
	startIndices: number[];
	/** Polygon-level start indices (polygonIndices) -- polygons only */
	polygonIndices?: number[];
	properties: object[];
	numericValues: Map<string, number[]>;
	featureCount: number;
}

function createAccumulator(withPolygonIndices: boolean): GeomAccumulator {
	const acc: GeomAccumulator = {
		coords: [],
		featureIds: [],
		globalFeatureIds: [],
		startIndices: [0],
		properties: [],
		numericValues: new Map(),
		featureCount: 0
	};
	if (withPolygonIndices) acc.polygonIndices = [0];
	return acc;
}

/**
 * Get features from DuckDB as a BinaryFeatureCollection for deck.gl.
 * Bypasses GeoJSON string serialization -- queries WKB geometry and flattened
 * properties, then builds flat typed arrays that deck.gl GeoJsonLayer
 * consumes directly in binary mode.
 *
 * @returns The binary collection and an array of ArrayBuffers for Transferable zero-copy.
 */
export async function getFeaturesAsBinaryCollection(
	datasetId: string
): Promise<{ binary: BinaryFeatureCollection; transfers: ArrayBuffer[] }> {
	const connection = await getConnection();

	// Get all property keys for flattened column access
	const keys = await getAllPropertyKeys(datasetId);

	// Build query with WKB geometry + flattened properties
	const selectExpr = buildFlattenedSelect(keys, 'ST_AsWKB(geometry) as geom_wkb');
	const sql = `SELECT ${selectExpr} FROM features WHERE dataset_id = ? AND geometry IS NOT NULL`;
	const stmt = await connection.prepare(sql);
	const result = await stmt.query(datasetId);
	await stmt.close();

	const rows = result.toArray();

	// Detect which property keys are numeric across all rows
	const numericKeys = new Set<string>();
	const nonNumericKeys = new Set<string>();
	if (rows.length > 0 && keys.length > 0) {
		// Sample up to 100 rows to detect types
		const sampleSize = Math.min(rows.length, 100);
		for (let i = 0; i < sampleSize; i++) {
			for (const key of keys) {
				if (nonNumericKeys.has(key)) continue;
				const val = rows[i][key];
				if (val === null || val === undefined) continue;
				const num = Number(val);
				if (Number.isFinite(num)) {
					numericKeys.add(key);
				} else {
					numericKeys.delete(key);
					nonNumericKeys.add(key);
				}
			}
		}
	}

	// Build accumulators for each geometry type
	const points = createAccumulator(false);
	const lines = createAccumulator(false);
	const polygons = createAccumulator(true);

	// Initialize numeric property arrays in each accumulator
	for (const key of numericKeys) {
		points.numericValues.set(key, []);
		lines.numericValues.set(key, []);
		polygons.numericValues.set(key, []);
	}

	let globalFeatureId = 0;

	for (const row of rows) {
		// Extract WKB buffer from the Arrow result
		const wkbRaw = row.geom_wkb;
		if (!wkbRaw) continue;
		const wkb = wkbRaw instanceof Uint8Array ? wkbRaw : new Uint8Array(wkbRaw);

		// Build properties object for this feature (all keys, including numeric).
		// Numeric columns are duplicated into numericProps as typed arrays for
		// rendering performance, but the properties array must be complete so
		// deck.gl picking callbacks can display all fields in tooltips/popups.
		const props: Record<string, unknown> = {};
		for (const key of keys) {
			props[key] = row[key] ?? null;
		}

		// Parse WKB into one or more geometries (Multi* -> multiple entries)
		const geometries = parseWKB(wkb);

		for (const geom of geometries) {
			let acc: GeomAccumulator;
			if (geom.type === 'Point') acc = points;
			else if (geom.type === 'LineString') acc = lines;
			else acc = polygons;

			const coordStart = acc.coords.length / 2;
			const numCoords = geom.flatCoords.length / 2;

			// Append coordinates
			for (let i = 0; i < geom.flatCoords.length; i++) {
				acc.coords.push(geom.flatCoords[i]);
			}

			if (geom.type === 'Point') {
				// Points: one featureId per vertex (1:1)
				acc.featureIds.push(acc.featureCount);
				acc.globalFeatureIds.push(globalFeatureId);
			} else if (geom.type === 'LineString') {
				// Lines: featureId per vertex, pathIndices marks line starts
				for (let i = 0; i < numCoords; i++) {
					acc.featureIds.push(acc.featureCount);
					acc.globalFeatureIds.push(globalFeatureId);
				}
				acc.startIndices.push(coordStart + numCoords);
			} else {
				// Polygon: featureId per vertex, ring and polygon indices
				for (let i = 0; i < numCoords; i++) {
					acc.featureIds.push(acc.featureCount);
					acc.globalFeatureIds.push(globalFeatureId);
				}
				// primitivePolygonIndices: each ring boundary
				if (geom.ringOffsets) {
					for (let r = 1; r < geom.ringOffsets.length; r++) {
						acc.startIndices.push(coordStart + geom.ringOffsets[r]);
					}
				} else {
					acc.startIndices.push(coordStart + numCoords);
				}
				// polygonIndices: each polygon boundary (one polygon per parsed geometry)
				acc.polygonIndices!.push(acc.startIndices.length - 1);
			}

			// Properties and numeric props: one entry per feature in this accumulator
			acc.properties.push(props);
			for (const key of numericKeys) {
				const val = row[key];
				acc.numericValues.get(key)!.push(val === null || val === undefined ? NaN : Number(val));
			}
			acc.featureCount++;
		}

		globalFeatureId++;
	}

	// Build the final typed arrays
	const transfers: ArrayBuffer[] = [];

	function buildNumericProps(acc: GeomAccumulator): Record<string, BinaryAttribute> {
		const result: Record<string, BinaryAttribute> = {};
		for (const [key, values] of acc.numericValues) {
			const arr = new Float64Array(values);
			result[key] = { value: arr, size: 1 };
			transfers.push(arr.buffer as ArrayBuffer);
		}
		return result;
	}

	function makeAttr(arr: Float64Array | Uint32Array, size: number): BinaryAttribute {
		transfers.push(arr.buffer as ArrayBuffer);
		return { value: arr, size };
	}

	const binary: BinaryFeatureCollection = {
		shape: 'binary-feature-collection',
		points: {
			type: 'Point',
			positions: makeAttr(new Float64Array(points.coords), 2),
			featureIds: makeAttr(new Uint32Array(points.featureIds), 1),
			globalFeatureIds: makeAttr(new Uint32Array(points.globalFeatureIds), 1),
			numericProps: buildNumericProps(points),
			properties: points.properties
		},
		lines: {
			type: 'LineString',
			positions: makeAttr(new Float64Array(lines.coords), 2),
			pathIndices: makeAttr(new Uint32Array(lines.startIndices), 1),
			featureIds: makeAttr(new Uint32Array(lines.featureIds), 1),
			globalFeatureIds: makeAttr(new Uint32Array(lines.globalFeatureIds), 1),
			numericProps: buildNumericProps(lines),
			properties: lines.properties
		},
		polygons: {
			type: 'Polygon',
			positions: makeAttr(new Float64Array(polygons.coords), 2),
			polygonIndices: makeAttr(new Uint32Array(polygons.polygonIndices!), 1),
			primitivePolygonIndices: makeAttr(new Uint32Array(polygons.startIndices), 1),
			featureIds: makeAttr(new Uint32Array(polygons.featureIds), 1),
			globalFeatureIds: makeAttr(new Uint32Array(polygons.globalFeatureIds), 1),
			numericProps: buildNumericProps(polygons),
			properties: polygons.properties
		}
	};

	return { binary, transfers };
}
