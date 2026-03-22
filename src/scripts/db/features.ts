/**
 * Feature query operations
 */

import { getConnection, getDB } from './core';

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
