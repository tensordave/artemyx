/**
 * GeoParquet format loader.
 * Fetches as ArrayBuffer, registers with DuckDB, inspects schema for
 * WKB geometry column, and queries via read_parquet + ST_GeomFromWKB + ST_AsGeoJSON.
 * Detects CRS from GeoParquet file metadata and reprojects to WGS84 when needed.
 */

import type { FormatLoader, LoaderOptions, LoaderResult } from './types';
import { getDB, getConnection } from '../db/core';
import { parseCrsAuthority, isWgs84 } from './crs';

/** Common geometry column names in GeoParquet files */
const GEOMETRY_COLUMN_NAMES = ['geometry', 'geom', 'wkb_geometry', 'shape', 'the_geom', 'geo'];

/**
 * Detect CRS from GeoParquet file-level metadata.
 * The GeoParquet spec stores a JSON object under the 'geo' key in Parquet key-value metadata.
 * Structure: { columns: { <geomCol>: { crs: <PROJJSON object> } } }
 */
async function detectParquetCrs(
	conn: any,
	fileName: string,
	geomCol: string,
): Promise<string | undefined> {
	try {
		const metaResult = await conn.query(
			`SELECT value FROM parquet_kv_metadata('${fileName}') WHERE key = 'geo'`
		);
		const metaRows = metaResult.toArray();
		if (metaRows.length === 0 || !metaRows[0].value) return undefined;

		const geoMeta = JSON.parse(metaRows[0].value);
		const primaryCol = geoMeta.primary_column || geomCol;
		const colMeta = geoMeta.columns?.[primaryCol];
		if (!colMeta?.crs) return undefined;

		return parseCrsAuthority(colMeta.crs) ?? undefined;
	} catch {
		// parquet_kv_metadata may not be available or file may lack metadata
		return undefined;
	}
}

/**
 * Register an ArrayBuffer as a virtual file in DuckDB and query its schema
 * to find the geometry column, then convert to GeoJSON FeatureCollection.
 * Detects CRS from file metadata and reprojects to WGS84 when the source CRS differs.
 *
 * @param buffer - Raw Parquet file contents
 * @param configCrs - Explicit CRS override from config (takes priority over detected)
 */
async function loadParquet(
	buffer: ArrayBuffer,
	configCrs?: string,
): Promise<{ data: GeoJSON.FeatureCollection; detectedCrs?: string; crsHandled?: boolean }> {
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

		// Detect CRS from GeoParquet metadata
		const detectedCrs = await detectParquetCrs(conn, fileName, geomCol);

		// Resolve effective CRS: config override > detected > WGS84 (no transform)
		const effectiveCrs = configCrs ?? detectedCrs;
		const needsReprojection = !!effectiveCrs && !isWgs84(effectiveCrs);

		// Build property columns (everything except geometry)
		const propCols = columns
			.filter(c => c.name !== geomCol)
			.map(c => c.name);

		// Query: convert geometry to GeoJSON, keep all other columns as JSON properties.
		// Native GEOMETRY columns go straight to ST_AsGeoJSON; BLOB columns need ST_GeomFromWKB first.
		const propSelect = propCols.length > 0
			? propCols.map(c => `"${c}"`).join(', ') + ', '
			: '';

		// Build geometry expression with optional reprojection.
		// CRS string is interpolated (not parameterized) because DuckDB-WASM doesn't
		// support parameterizing CRS args to spatial functions. Values come from trusted
		// sources (YAML config or file metadata parsed by this app).
		const rawGeomExpr = isNativeGeometry
			? `"${geomCol}"`
			: `ST_GeomFromWKB("${geomCol}")`;

		// ST_FlipCoordinates corrects EPSG:4326 axis order (lat/lng -> lng/lat for GeoJSON)
		const geomExpr = needsReprojection
			? `ST_AsGeoJSON(ST_FlipCoordinates(ST_Transform(${rawGeomExpr}, '${effectiveCrs}', 'EPSG:4326')))`
			: `ST_AsGeoJSON(${rawGeomExpr})`;

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

		return {
			data: { type: 'FeatureCollection', features },
			detectedCrs,
			// Signal that reprojection was already done in the SQL query above,
			// so downstream loadGeoJSON should not apply ST_Transform again.
			crsHandled: needsReprojection,
		};
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
	async load(response: Response, options?: LoaderOptions): Promise<LoaderResult> {
		const buffer = await response.arrayBuffer();
		const { data, detectedCrs, crsHandled } = await loadParquet(buffer, options?.crs);

		if (data.features.length === 0) {
			throw new Error('GeoParquet file contains no valid geometry features');
		}

		return { data, detectedCrs, crsHandled };
	},
};
