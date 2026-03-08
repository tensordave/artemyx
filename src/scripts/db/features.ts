/**
 * Feature query operations
 */

import { getConnection } from './core';

/**
 * Get features from DuckDB as GeoJSON
 * @param datasetId Optional dataset ID to filter by. If not provided, returns all features.
 */
export async function getFeaturesAsGeoJSON(datasetId?: string): Promise<any> {
	try {
		const connection = await getConnection();

		let result;
		if (datasetId) {
			const stmt = await connection.prepare(`
				SELECT
					dataset_id,
					ST_AsGeoJSON(geometry) as geometry,
					properties
				FROM features
				WHERE geometry IS NOT NULL AND dataset_id = ?
			`);
			result = await stmt.query(datasetId);
			await stmt.close();
		} else {
			result = await connection.query(`
				SELECT
					dataset_id,
					ST_AsGeoJSON(geometry) as geometry,
					properties
				FROM features
				WHERE geometry IS NOT NULL
			`);
		}

		const rows = result.toArray();

		// Debug: log raw query results for troubleshooting
		if (rows.length > 0 && datasetId) {
			console.log(`[DuckDB] getFeaturesAsGeoJSON(${datasetId}): ${rows.length} rows, first geometry type:`,
				typeof rows[0].geometry === 'string' ? JSON.parse(rows[0].geometry)?.type : rows[0].geometry?.type);
		}

		const features = rows
			.map((row: any) => {
				try {
					const geometry = typeof row.geometry === 'string' ? JSON.parse(row.geometry) : row.geometry;
					const properties = typeof row.properties === 'string' ? JSON.parse(row.properties) : row.properties;

					// Validate geometry - must have type and non-empty coordinates (or geometries for GeometryCollection)
					if (!geometry || !geometry.type) {
						return null;
					}
					const hasCoords = Array.isArray(geometry.coordinates) && geometry.coordinates.length > 0;
					if (!hasCoords && !geometry.geometries) {
						return null;
					}

					return {
						type: 'Feature',
						geometry: geometry,
						properties: {
							...properties,
							_dataset_id: row.dataset_id // Add dataset ID to properties for debugging
						}
					};
				} catch (e) {
					return null;
				}
			})
			.filter((f: any) => f !== null);

		const featureCollection = {
			type: 'FeatureCollection',
			features: features
		};

		return featureCollection;
	} catch (error) {
		console.error('Failed to query features from DuckDB:', error);
		return { type: 'FeatureCollection', features: [] };
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
