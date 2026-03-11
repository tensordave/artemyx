/**
 * Feature query operations
 */

import { getConnection } from './core';

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
