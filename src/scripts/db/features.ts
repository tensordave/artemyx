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

					// Validate geometry - must have type and either coordinates or geometries (for GeometryCollection)
					if (!geometry || !geometry.type) {
						return null;
					}
					if (!geometry.coordinates && !geometry.geometries) {
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
