/**
 * Contains operation - tests for complete spatial containment between two datasets.
 *
 * Uses ST_Contains(A, B) which is stricter than ST_Intersects:
 * - ST_Intersects: any overlap (touching, crossing, or inside)
 * - ST_Contains: B must be completely inside A (no part of B outside A)
 *
 * Two modes:
 * - 'filter': Keep features from first input (A) that fully contain at least one feature from B
 * - 'within': Keep features from second input (B) that are fully inside at least one feature from A
 *
 * Note: ST_Contains follows GEOS semantics — a point exactly on the polygon boundary
 * is NOT considered contained. Both modes return original geometry (no clipping).
 */

import { getConnection } from '../../db/core';
import { DEFAULT_COLOR } from '../../db/datasets';
import { getFeaturesAsGeoJSON } from '../../db/features';
import { attachFeatureClickHandlers } from '../../popup';
import type { BinaryOperation, ContainsParams } from '../types';
import type { OperationContext } from './index';
import { parseStyleConfig } from './index';
import { addOperationResultToMap } from './buffer';

/**
 * Execute a contains operation.
 * Takes two inputs: A (container polygons) and B (contained features).
 *
 * @param op - Binary operation config with inputs[0] as container (A), inputs[1] as contained (B)
 * @param context - Execution context with map, progress, etc.
 */
export async function executeContains(
	op: BinaryOperation,
	context: OperationContext
): Promise<boolean> {
	const { map, progressControl, layerToggleControl, loadedDatasets, layers } = context;
	const hasExplicitLayers = layers !== undefined;
	const params = op.params as ContainsParams | undefined;

	// Validate inputs
	if (!op.inputs || op.inputs.length !== 2) {
		throw new Error(`Contains operation '${op.output}': requires exactly 2 inputs`);
	}

	// Validate params
	const mode = params?.mode ?? 'filter';
	if (mode !== 'filter' && mode !== 'within') {
		throw new Error(`Contains operation '${op.output}': mode must be 'filter' or 'within'`);
	}

	const [inputA, inputB] = op.inputs;
	const outputId = op.output;
	const color = op.color ?? DEFAULT_COLOR;
	const style = parseStyleConfig(op.style);

	const modeLabel = mode === 'filter' ? 'A contains B → keep A' : 'A contains B → keep B';
	progressControl.updateProgress(outputId, 'processing', `Contains ${inputA} / ${inputB} (${modeLabel})...`);

	const connection = await getConnection();

	// Delete existing output if present (allows re-running)
	const deleteFeatures = await connection.prepare('DELETE FROM features WHERE dataset_id = ?');
	await deleteFeatures.query(outputId);
	await deleteFeatures.close();

	const deleteDatasets = await connection.prepare('DELETE FROM datasets WHERE id = ?');
	await deleteDatasets.query(outputId);
	await deleteDatasets.close();

	if (mode === 'filter') {
		// Filter mode: keep features from A that fully contain at least one feature from B
		const insertFiltered = await connection.prepare(`
			INSERT INTO features (dataset_id, source_url, geometry, properties)
			SELECT
				?,
				'operation:contains',
				a.geometry,
				a.properties
			FROM features a
			WHERE a.dataset_id = ?
			AND EXISTS (
				SELECT 1 FROM features b
				WHERE b.dataset_id = ?
				AND ST_Contains(a.geometry, b.geometry)
			)
		`);
		await insertFiltered.query(outputId, inputA, inputB);
		await insertFiltered.close();
	} else {
		// Within mode: keep features from B that are fully inside at least one feature from A
		// Same predicate (ST_Contains(A, B)) but returns B features
		const insertWithin = await connection.prepare(`
			INSERT INTO features (dataset_id, source_url, geometry, properties)
			SELECT
				?,
				'operation:contains',
				b.geometry,
				b.properties
			FROM features b
			WHERE b.dataset_id = ?
			AND EXISTS (
				SELECT 1 FROM features a
				WHERE a.dataset_id = ?
				AND ST_Contains(a.geometry, b.geometry)
			)
		`);
		await insertWithin.query(outputId, inputB, inputA);
		await insertWithin.close();
	}

	// Get feature count
	const countStmt = await connection.prepare(`
		SELECT COUNT(*) as count FROM features WHERE dataset_id = ?
	`);
	const countResult = await countStmt.query(outputId);
	await countStmt.close();
	const featureCount = Number(countResult.toArray()[0].count);

	// Debug: log geometry info
	if (featureCount > 0) {
		const debugStmt = await connection.prepare(`
			SELECT
				ST_GeometryType(geometry) as geom_type,
				LENGTH(ST_AsGeoJSON(geometry)) as geojson_len
			FROM features
			WHERE dataset_id = ?
			LIMIT 1
		`);
		const debugResult = await debugStmt.query(outputId);
		await debugStmt.close();
		const debugRow = debugResult.toArray()[0];
		console.log(`[Contains] Result: ${featureCount} features, type=${debugRow.geom_type}, mode=${mode}`);
	}

	if (featureCount === 0) {
		console.log(`[Contains] Warning: ${inputA} contains ${inputB} produced no features`);
		progressControl.updateProgress(outputId, 'success', `No features found (${mode})`);
	}

	// Register dataset metadata
	const insertDataset = await connection.prepare(`
		INSERT INTO datasets (id, source_url, name, color, visible, feature_count, loaded_at, style)
		VALUES (?, 'operation:contains', ?, ?, true, ?, CURRENT_TIMESTAMP, ?)
	`);
	await insertDataset.query(outputId, outputId, color, featureCount, JSON.stringify(style));
	await insertDataset.close();

	// Query features as GeoJSON for map rendering
	const geoJsonData = await getFeaturesAsGeoJSON(outputId);

	// Add source and layers to map (skip layers if explicit config exists)
	const layerIds = addOperationResultToMap(map, outputId, color, style, geoJsonData, hasExplicitLayers);

	// Track dataset
	loadedDatasets.add(outputId);

	// Attach popup handlers (only if default layers were created)
	if (layerIds.length > 0) {
		attachFeatureClickHandlers(map, layerIds);
	}

	// Refresh layer control
	layerToggleControl.refreshPanel();

	progressControl.updateProgress(outputId, 'success', `${featureCount} feature(s) (${mode})`);

	console.log(`[Contains] Complete: ${outputId} with ${featureCount} features`);

	return true;
}
