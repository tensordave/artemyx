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

import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import { getConnection } from '../../db/core';
import { DEFAULT_COLOR } from '../../db/datasets';
import { getFeaturesAsGeoJSON } from '../../db/features';
import type { BinaryOperation, ContainsParams } from '../types';
import type { OperationContext, ComputeResult, ComputeCallbacks } from './index';
import { parseStyleConfig, shouldSkipAutoLayers } from './index';
import { addOperationResultToMap } from './render';

/**
 * Pure SQL computation for contains operation.
 * No MapLibre imports - can run in a Web Worker or headless CLI.
 */
export async function computeContains(
	connection: AsyncDuckDBConnection,
	op: BinaryOperation,
	callbacks?: ComputeCallbacks
): Promise<ComputeResult> {
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
	const displayName = op.name || outputId;
	const color = op.color ?? DEFAULT_COLOR;
	const style = parseStyleConfig(op.style);

	const modeLabel = mode === 'filter' ? 'A contains B → keep A' : 'A contains B → keep B';
	callbacks?.onProgress?.(`Contains ${inputA} / ${inputB} (${modeLabel})...`);

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
		callbacks?.onInfo?.('Contains', `Result: ${featureCount} features, type=${debugRow.geom_type}, mode=${mode}`);
	}

	if (featureCount === 0) {
		callbacks?.onWarn?.('Contains', `${inputA} contains ${inputB} produced no features`);
	}

	// Register dataset metadata
	const insertDataset = await connection.prepare(`
		INSERT INTO datasets (id, source_url, name, color, visible, feature_count, loaded_at, style)
		VALUES (?, 'operation:contains', ?, ?, true, ?, CURRENT_TIMESTAMP, ?)
	`);
	await insertDataset.query(outputId, displayName, color, featureCount, JSON.stringify(style));
	await insertDataset.close();

	return { outputId, displayName, featureCount, color, style };
}

/**
 * Execute a contains operation (compute + render).
 * Thin wrapper that calls computeContains then renders the result on the map.
 *
 * @param op - Binary operation config with inputs[0] as container (A), inputs[1] as contained (B)
 * @param context - Execution context with map, progress, etc.
 */
export async function executeContains(
	op: BinaryOperation,
	context: OperationContext
): Promise<boolean> {
	const { map, logger, layerToggleControl, loadedDatasets } = context;

	const connection = await getConnection();
	const result = await computeContains(connection, op, {
		onProgress: (msg) => logger.progress(op.name || op.output, 'processing', msg),
		onInfo: (tag, msg) => logger.info(tag, msg),
		onWarn: (tag, msg) => logger.warn(tag, msg),
	});

	// Query features as GeoJSON for map rendering
	const geoJsonData = await getFeaturesAsGeoJSON(result.outputId);

	// Add source and layers to map (skip layers if explicit config exists)
	const layerIds = addOperationResultToMap(map, result.outputId, result.color, result.style, geoJsonData, shouldSkipAutoLayers(result.outputId, context.layers));

	// Track dataset
	loadedDatasets.add(result.outputId);

	// Notify executor to attach popup/hover handlers
	if (layerIds.length > 0) {
		context.onLayersCreated?.(layerIds, result.displayName);
	}

	// Refresh layer control
	layerToggleControl.refreshPanel();

	const mode = (op.params as ContainsParams | undefined)?.mode ?? 'filter';

	if (result.featureCount === 0) {
		logger.progress(result.displayName, 'success', `No features found (${mode})`);
	} else {
		logger.progress(result.displayName, 'success', `${result.featureCount} feature(s) (${mode})`);
	}

	logger.info('Contains', `Complete: ${result.outputId} with ${result.featureCount} features`);

	return true;
}
