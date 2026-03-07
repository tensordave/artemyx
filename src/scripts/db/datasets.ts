/**
 * Dataset CRUD operations
 */

import { getConnection, getDB, setFallbackReason } from './core';
import { generateDatasetId, extractDatasetName } from './utils';

/**
 * Style configuration for dataset rendering
 */
export interface StyleConfig {
	fillOpacity: number;
	lineWidth: number;
	pointRadius: number;
}

/**
 * Default style values applied to new datasets
 */
export const DEFAULT_STYLE: StyleConfig = {
	fillOpacity: 0.2,
	lineWidth: 2,
	pointRadius: 6
};

/** Default color for new datasets */
export const DEFAULT_COLOR = '#3388ff';

/**
 * Options for loading GeoJSON with config overrides
 */
export interface LoadGeoJSONOptions {
	/** Override the auto-generated dataset ID (use config ID instead of URL hash) */
	id?: string;
	/** Override the auto-generated dataset name */
	name?: string;
	/** Override the default color */
	color?: string;
	/** Override default style values */
	style?: Partial<StyleConfig>;
	/** When true, dataset is source-only (not rendered or shown in layer panel) */
	hidden?: boolean;
	/**
	 * Source CRS for reprojection. When set, ST_Transform is applied during INSERT
	 * to convert from this CRS to WGS84 (EPSG:4326). Null or undefined = already WGS84.
	 * Resolved via resolveSourceCrs() before calling this function.
	 */
	sourceCrs?: string | null;
}

/**
 * Load GeoJSON data into DuckDB using bulk in-memory conversion
 * @param data - GeoJSON data (FeatureCollection or single Feature)
 * @param sourceUrl - Source URL for the data
 * @param options - Optional overrides for name, color, and style
 */
export async function loadGeoJSON(data: any, sourceUrl: string, options?: LoadGeoJSONOptions): Promise<boolean> {
	const virtualFileName = 'temp_features.json';

	try {
		const connection = await getConnection();
		const database = await getDB();

		// Use provided ID or generate from URL hash
		const datasetId = options?.id || generateDatasetId(sourceUrl);
		const datasetName = options?.name || extractDatasetName(sourceUrl);
		const datasetColor = options?.color || DEFAULT_COLOR;
		const datasetStyle: StyleConfig = {
			...DEFAULT_STYLE,
			...options?.style
		};

		// Extract features array
		const features = data.type === 'FeatureCollection' ? data.features : [data];
		console.log(`[DuckDB] Loading ${features.length} features for dataset ${datasetId}`);

		// Delete existing data for this dataset (if reloading)
		const deleteFeatures = await connection.prepare('DELETE FROM features WHERE dataset_id = ?');
		await deleteFeatures.query(datasetId);
		await deleteFeatures.close();

		const deleteDatasets = await connection.prepare('DELETE FROM datasets WHERE id = ?');
		await deleteDatasets.query(datasetId);
		await deleteDatasets.close();

		// Register features as virtual JSON file
		const featuresJson = JSON.stringify(features);
		await database.registerFileText(virtualFileName, featuresJson);

		// Bulk insert JSON into features table with spatial transformation.
		// maximum_depth=1 prevents DuckDB from inferring deep nested types inside
		// geometry/coordinates, which breaks on mixed 2D/3D coordinates (e.g. ArcGIS
		// data with elevation values that fail auto-detected numeric array schemas).
		// When sourceCrs is set, ST_Transform reprojects from source CRS to WGS84.
		// CRS string is interpolated (not parameterized) because DuckDB-WASM doesn't
		// support parameterizing CRS args to spatial functions. Values come from
		// trusted sources (YAML config or file metadata parsed by this app).
		const rawGeomExpr = 'ST_GeomFromGeoJSON(json_extract_string(j, \'$.geometry\'))';
		// ST_FlipCoordinates corrects EPSG:4326 axis order (lat/lng -> lng/lat for GeoJSON)
		const geomExpr = options?.sourceCrs
			? `ST_FlipCoordinates(ST_Transform(${rawGeomExpr}, '${options.sourceCrs}', 'EPSG:4326'))`
			: rawGeomExpr;

		const insertFeatures = await connection.prepare(`
			INSERT INTO features
			SELECT
				? as dataset_id,
				? as source_url,
				${geomExpr} as geometry,
				json_extract_string(j, '$.properties') as properties
			FROM read_json_auto('${virtualFileName}', format='array', maximum_depth=1) j
			WHERE json_extract_string(j, '$.geometry') IS NOT NULL
		`);
		await insertFeatures.query(datasetId, sourceUrl);
		await insertFeatures.close();

		// Get final count for this dataset
		const countStmt = await connection.prepare('SELECT COUNT(*) as count FROM features WHERE dataset_id = ?');
		const result = await countStmt.query(datasetId);
		await countStmt.close();
		const count = Number(result.toArray()[0].count);

		// Insert dataset metadata with configured style and color
		const datasetHidden = options?.hidden ?? false;
		const layerOrder = await getNextLayerOrder();
		const insertDataset = await connection.prepare(`
			INSERT INTO datasets (id, source_url, name, color, visible, hidden, feature_count, loaded_at, style, source_crs, layer_order)
			VALUES (?, ?, ?, ?, true, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?)
		`);
		await insertDataset.query(datasetId, sourceUrl, datasetName, datasetColor, datasetHidden, count, JSON.stringify(datasetStyle), options?.sourceCrs ?? null, layerOrder);
		await insertDataset.close();

		console.log(`[DuckDB] Successfully loaded dataset ${datasetId} with ${count} features`);

		// Clean up virtual file
		await database.dropFile(virtualFileName);

		return true;
	} catch (error) {
		// Detect storage quota exceeded (OPFS write failure)
		if (error instanceof DOMException && error.name === 'QuotaExceededError') {
			console.error('[DuckDB] Storage quota exceeded:', error);
			setFallbackReason('quota-exceeded');
		} else {
			console.error('Failed to load GeoJSON:', error);
		}

		// Attempt cleanup on error
		try {
			const database = await getDB();
			await database.dropFile(virtualFileName);
		} catch (cleanupError) {
			// Silently ignore cleanup errors
		}

		return false;
	}
}

/**
 * Append additional features to an existing dataset (used for paginated loading).
 * Unlike loadGeoJSON(), this does NOT delete existing features or create dataset metadata.
 * @param datasetId - The dataset to append to (must already exist)
 * @param data - GeoJSON FeatureCollection to append
 * @param sourceUrl - Source URL for the data
 * @param sourceCrs - Source CRS for reprojection (null = already WGS84)
 * @returns Number of features inserted in this batch
 */
export async function appendFeatures(datasetId: string, data: GeoJSON.FeatureCollection, sourceUrl: string, sourceCrs?: string | null): Promise<number> {
	const virtualFileName = `temp_append_${Date.now()}.json`;

	try {
		const connection = await getConnection();
		const database = await getDB();

		const features = data.features;
		console.log(`[DuckDB] Appending ${features.length} features to dataset ${datasetId}`);

		const featuresJson = JSON.stringify(features);
		await database.registerFileText(virtualFileName, featuresJson);

		const rawGeomExpr = 'ST_GeomFromGeoJSON(json_extract_string(j, \'$.geometry\'))';
		const geomExpr = sourceCrs
			? `ST_Transform(${rawGeomExpr}, '${sourceCrs}', 'EPSG:4326')`
			: rawGeomExpr;

		const insertStmt = await connection.prepare(`
			INSERT INTO features
			SELECT
				? as dataset_id,
				? as source_url,
				${geomExpr} as geometry,
				json_extract_string(j, '$.properties') as properties
			FROM read_json_auto('${virtualFileName}', format='array', maximum_depth=1) j
			WHERE json_extract_string(j, '$.geometry') IS NOT NULL
		`);
		await insertStmt.query(datasetId, sourceUrl);
		await insertStmt.close();

		await database.dropFile(virtualFileName);

		return features.length;
	} catch (error) {
		if (error instanceof DOMException && error.name === 'QuotaExceededError') {
			console.error('[DuckDB] Storage quota exceeded during append:', error);
			setFallbackReason('quota-exceeded');
		} else {
			console.error('Failed to append features:', error);
		}

		try {
			const database = await getDB();
			await database.dropFile(virtualFileName);
		} catch { /* ignore cleanup errors */ }

		throw error;
	}
}

/**
 * Recount features for a dataset and update the metadata.
 * Called after paginated loading completes to set the final feature_count.
 * @returns The updated total feature count
 */
export async function updateFeatureCount(datasetId: string): Promise<number> {
	try {
		const connection = await getConnection();

		const countStmt = await connection.prepare(
			'SELECT COUNT(*) as count FROM features WHERE dataset_id = ?'
		);
		const result = await countStmt.query(datasetId);
		await countStmt.close();
		const count = Number(result.toArray()[0].count);

		const updateStmt = await connection.prepare(
			'UPDATE datasets SET feature_count = ? WHERE id = ?'
		);
		await updateStmt.query(count, datasetId);
		await updateStmt.close();

		console.log(`[DuckDB] Updated feature count for ${datasetId}: ${count}`);
		return count;
	} catch (error) {
		console.error('Failed to update feature count:', error);
		throw error;
	}
}

/**
 * Get the next layer_order value (one higher than the current maximum).
 * Used when inserting new datasets so they appear at the top.
 */
export async function getNextLayerOrder(): Promise<number> {
	try {
		const connection = await getConnection();
		const result = await connection.query('SELECT COALESCE(MAX(layer_order), 0) + 1 as next_order FROM datasets');
		return Number(result.toArray()[0].next_order);
	} catch (error) {
		console.error('Failed to get next layer order:', error);
		return 1;
	}
}

/**
 * Swap the layer_order values of two datasets.
 * This is the core reorder operation used by "Move up" / "Move down".
 */
export async function swapLayerOrder(idA: string, idB: string): Promise<boolean> {
	try {
		const connection = await getConnection();

		// Read both current orders
		const stmt = await connection.prepare('SELECT id, layer_order FROM datasets WHERE id = ? OR id = ?');
		const result = await stmt.query(idA, idB);
		await stmt.close();

		const rows = result.toArray();
		if (rows.length !== 2) return false;

		const orderA = Number(rows.find((r: any) => r.id === idA)!.layer_order);
		const orderB = Number(rows.find((r: any) => r.id === idB)!.layer_order);

		// Swap
		const updateA = await connection.prepare('UPDATE datasets SET layer_order = ? WHERE id = ?');
		await updateA.query(orderB, idA);
		await updateA.close();

		const updateB = await connection.prepare('UPDATE datasets SET layer_order = ? WHERE id = ?');
		await updateB.query(orderA, idB);
		await updateB.close();

		return true;
	} catch (error) {
		console.error('Failed to swap layer order:', error);
		return false;
	}
}

/**
 * Bulk-update layer_order for datasets to match a given visual ordering.
 * @param orderedIds - Dataset IDs sorted bottom-to-top (index 0 = bottom of map)
 */
export async function setLayerOrders(orderedIds: string[]): Promise<void> {
	try {
		const connection = await getConnection();
		for (let i = 0; i < orderedIds.length; i++) {
			const stmt = await connection.prepare('UPDATE datasets SET layer_order = ? WHERE id = ?');
			await stmt.query(i + 1, orderedIds[i]);
			await stmt.close();
		}
	} catch (error) {
		console.error('Failed to set layer orders:', error);
	}
}

/**
 * Get all loaded datasets metadata
 */
export async function getDatasets(): Promise<any[]> {
	try {
		const connection = await getConnection();
		const result = await connection.query(`
			SELECT * FROM datasets
			ORDER BY layer_order DESC
		`);
		return result.toArray();
	} catch (error) {
		console.error('Failed to query datasets:', error);
		return [];
	}
}

/**
 * Check if a dataset with the given ID exists in the database
 */
export async function datasetExists(id: string): Promise<boolean> {
	try {
		const connection = await getConnection();
		const stmt = await connection.prepare('SELECT COUNT(*) as count FROM datasets WHERE id = ?');
		const result = await stmt.query(id);
		await stmt.close();
		return Number(result.toArray()[0].count) > 0;
	} catch (error) {
		console.error('Failed to check dataset existence:', error);
		return false;
	}
}

/**
 * Update the color for a specific dataset
 */
export async function updateDatasetColor(datasetId: string, color: string): Promise<boolean> {
	try {
		const connection = await getConnection();
		const stmt = await connection.prepare('UPDATE datasets SET color = ? WHERE id = ?');
		await stmt.query(color, datasetId);
		await stmt.close();
		console.log(`[DuckDB] Updated dataset ${datasetId} color to ${color}`);
		return true;
	} catch (error) {
		console.error('Failed to update dataset color:', error);
		return false;
	}
}

/**
 * Update the name/alias for a specific dataset
 */
export async function updateDatasetName(datasetId: string, name: string): Promise<boolean> {
	try {
		const connection = await getConnection();
		const stmt = await connection.prepare('UPDATE datasets SET name = ? WHERE id = ?');
		await stmt.query(name, datasetId);
		await stmt.close();
		console.log(`[DuckDB] Updated dataset ${datasetId} name to "${name}"`);
		return true;
	} catch (error) {
		console.error('Failed to update dataset name:', error);
		return false;
	}
}

/**
 * Update the visibility state for a specific dataset
 */
export async function updateDatasetVisible(datasetId: string, visible: boolean): Promise<boolean> {
	try {
		const connection = await getConnection();
		const stmt = await connection.prepare('UPDATE datasets SET visible = ? WHERE id = ?');
		await stmt.query(visible, datasetId);
		await stmt.close();
		return true;
	} catch (error) {
		console.error('Failed to update dataset visibility:', error);
		return false;
	}
}

/**
 * Delete a dataset and all its associated features
 */
export async function deleteDataset(datasetId: string): Promise<boolean> {
	try {
		const connection = await getConnection();

		// Delete features associated with this dataset
		const deleteFeatures = await connection.prepare('DELETE FROM features WHERE dataset_id = ?');
		await deleteFeatures.query(datasetId);
		await deleteFeatures.close();

		// Delete dataset metadata
		const deleteDatasets = await connection.prepare('DELETE FROM datasets WHERE id = ?');
		await deleteDatasets.query(datasetId);
		await deleteDatasets.close();

		console.log(`[DuckDB] Successfully deleted dataset ${datasetId} and all associated features`);
		return true;
	} catch (error) {
		console.error('Failed to delete dataset:', error);
		return false;
	}
}

/**
 * Get the style configuration for a dataset
 * Returns defaults if no style is saved or parsing fails
 */
export async function getDatasetStyle(datasetId: string): Promise<StyleConfig> {
	try {
		const connection = await getConnection();
		const stmt = await connection.prepare('SELECT style FROM datasets WHERE id = ?');
		const result = await stmt.query(datasetId);
		await stmt.close();

		const rows = result.toArray();
		if (rows.length === 0 || !rows[0].style) {
			return { ...DEFAULT_STYLE };
		}

		const parsed = JSON.parse(rows[0].style);
		return {
			fillOpacity: parsed.fillOpacity ?? DEFAULT_STYLE.fillOpacity,
			lineWidth: parsed.lineWidth ?? DEFAULT_STYLE.lineWidth,
			pointRadius: parsed.pointRadius ?? DEFAULT_STYLE.pointRadius
		};
	} catch (error) {
		console.error('Failed to get dataset style:', error);
		return { ...DEFAULT_STYLE };
	}
}

/**
 * Update the style configuration for a dataset
 */
export async function updateDatasetStyle(datasetId: string, style: StyleConfig): Promise<boolean> {
	try {
		const connection = await getConnection();
		const stmt = await connection.prepare('UPDATE datasets SET style = ? WHERE id = ?');
		await stmt.query(JSON.stringify(style), datasetId);
		await stmt.close();
		console.log(`[DuckDB] Updated dataset ${datasetId} style:`, style);
		return true;
	} catch (error) {
		console.error('Failed to update dataset style:', error);
		return false;
	}
}
