/**
 * GeoParquet format loader.
 * Fetches as ArrayBuffer, registers with DuckDB, inspects schema for
 * WKB geometry column, and queries via read_parquet + ST_GeomFromWKB + ST_AsGeoJSON.
 */

import type { FormatLoader, LoaderResult } from './types';
import { getDB, getConnection } from '../db/core';

/** Common geometry column names in GeoParquet files */
const GEOMETRY_COLUMN_NAMES = ['geometry', 'geom', 'wkb_geometry', 'shape', 'the_geom', 'geo'];

/**
 * Register an ArrayBuffer as a virtual file in DuckDB and query its schema
 * to find the geometry column, then convert to GeoJSON FeatureCollection.
 */
async function loadParquet(buffer: ArrayBuffer): Promise<GeoJSON.FeatureCollection> {
	const db = await getDB();
	const conn = await getConnection();

	// Register the buffer as a virtual file
	const fileName = `_upload_${Date.now()}.parquet`;
	await db.registerFileBuffer(fileName, new Uint8Array(buffer));

	try {
		// Read schema to find columns and detect geometry
		const schemaResult = await conn.query(`DESCRIBE SELECT * FROM read_parquet('${fileName}')`);
		const columns = schemaResult.toArray().map((row: any) => ({
			name: row.column_name as string,
			type: (row.column_type as string).toUpperCase(),
		}));

		// Find geometry column: look for BLOB/GEOMETRY types with known names,
		// then fall back to any BLOB column
		const geomMatch = findGeometryColumn(columns);
		if (!geomMatch) {
			throw new Error(
				`No geometry column found in Parquet file. ` +
				`Columns: ${columns.map(c => `${c.name} (${c.type})`).join(', ')}`
			);
		}

		const geomCol = geomMatch.name;
		const isNativeGeometry = geomMatch.type === 'GEOMETRY';

		// Build property columns (everything except geometry)
		const propCols = columns
			.filter(c => c.name !== geomCol)
			.map(c => c.name);

		// Query: convert geometry to GeoJSON, keep all other columns as JSON properties.
		// Native GEOMETRY columns go straight to ST_AsGeoJSON; BLOB columns need ST_GeomFromWKB first.
		const propSelect = propCols.length > 0
			? propCols.map(c => `"${c}"`).join(', ') + ', '
			: '';

		const geomExpr = isNativeGeometry
			? `ST_AsGeoJSON("${geomCol}")`
			: `ST_AsGeoJSON(ST_GeomFromWKB("${geomCol}"))`;

		const result = await conn.query(`
			SELECT
				${propSelect}
				${geomExpr} AS __geojson_geom
			FROM read_parquet('${fileName}')
			WHERE "${geomCol}" IS NOT NULL
		`);

		const rows = result.toArray();
		const features: GeoJSON.Feature[] = [];

		for (const row of rows) {
			const geomStr = row.__geojson_geom;
			if (!geomStr) continue;

			const geometry = JSON.parse(geomStr);
			const properties: Record<string, unknown> = {};
			for (const col of propCols) {
				const val = row[col];
				// BigInt can't be serialized by JSON.stringify; coerce to Number if safe, else String
				properties[col] = typeof val === 'bigint'
					? (val >= Number.MIN_SAFE_INTEGER && val <= Number.MAX_SAFE_INTEGER ? Number(val) : String(val))
					: val;
			}

			features.push({
				type: 'Feature',
				geometry,
				properties,
			});
		}

		return { type: 'FeatureCollection', features };
	} finally {
		// Clean up virtual file registration
		await db.dropFile(fileName);
	}
}

/**
 * Find the geometry column from a list of column definitions.
 * Checks known geometry column names first, then falls back to any BLOB column.
 * Returns name and type so the caller can decide whether ST_GeomFromWKB is needed.
 */
function findGeometryColumn(
	columns: { name: string; type: string }[]
): { name: string; type: string } | null {
	// Check by known name + compatible type (BLOB, GEOMETRY, WKB_GEOMETRY)
	const geomTypes = new Set(['BLOB', 'GEOMETRY', 'WKB_GEOMETRY']);
	for (const knownName of GEOMETRY_COLUMN_NAMES) {
		const match = columns.find(
			c => c.name.toLowerCase() === knownName && geomTypes.has(c.type)
		);
		if (match) return match;
	}

	// Fall back to first BLOB column (likely WKB geometry)
	const blobCol = columns.find(c => c.type === 'BLOB');
	if (blobCol) return blobCol;

	return null;
}

export const geoparquetLoader: FormatLoader = {
	async load(response: Response): Promise<LoaderResult> {
		const buffer = await response.arrayBuffer();
		const data = await loadParquet(buffer);

		if (data.features.length === 0) {
			throw new Error('GeoParquet file contains no valid geometry features');
		}

		return { data };
	},
};
