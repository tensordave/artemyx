/**
 * Difference operation - subtracts one dataset's geometry from another.
 *
 * Two modes:
 * - 'exclude': Keep features from first input that do NOT intersect with any feature in second input
 * - 'subtract': Compute geometric difference — remove the area of B from each feature in A
 */

import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import { getConnection } from '../../db/core';
import { DEFAULT_COLOR } from '../../db/datasets';
import { getFeaturesAsGeoJSON } from '../../db/features';
import type { BinaryOperation, DifferenceParams } from '../types';
import type { OperationContext, ComputeResult, ComputeCallbacks } from './index';
import { parseStyleConfig, shouldSkipAutoLayers } from './index';
import { addOperationResultToMap } from './render';

/**
 * Pure SQL computation for difference operation.
 * No MapLibre imports - can run in a Web Worker or headless CLI.
 */
export async function computeDifference(
	connection: AsyncDuckDBConnection,
	op: BinaryOperation,
	callbacks?: ComputeCallbacks
): Promise<ComputeResult> {
	const params = op.params as DifferenceParams | undefined;

	// Validate inputs
	if (!op.inputs || op.inputs.length !== 2) {
		throw new Error(`Difference operation '${op.output}': requires exactly 2 inputs`);
	}

	// Validate params
	const mode = params?.mode ?? 'subtract';
	if (mode !== 'subtract' && mode !== 'exclude') {
		throw new Error(`Difference operation '${op.output}': mode must be 'subtract' or 'exclude'`);
	}

	const [inputA, inputB] = op.inputs;
	const outputId = op.output;
	const displayName = op.name || outputId;
	const color = op.color ?? DEFAULT_COLOR;
	const style = parseStyleConfig(op.style);

	const modeLabel = mode === 'exclude' ? 'excluding' : 'subtracting';
	callbacks?.onProgress?.(`Differencing ${inputA} minus ${inputB} (${modeLabel})...`);

	// Delete existing output if present (allows re-running)
	const deleteFeatures = await connection.prepare('DELETE FROM features WHERE dataset_id = ?');
	await deleteFeatures.query(outputId);
	await deleteFeatures.close();

	const deleteDatasets = await connection.prepare('DELETE FROM datasets WHERE id = ?');
	await deleteDatasets.query(outputId);
	await deleteDatasets.close();

	if (mode === 'exclude') {
		// Exclude mode: keep features from A that do NOT intersect any feature in B
		// Logical inverse of intersection's filter mode
		const insertExcluded = await connection.prepare(`
			INSERT INTO features (dataset_id, source_url, geometry, properties)
			SELECT
				?,
				'operation:difference',
				a.geometry,
				a.properties
			FROM features a
			WHERE a.dataset_id = ?
			AND NOT EXISTS (
				SELECT 1 FROM features b
				WHERE b.dataset_id = ?
				AND ST_Intersects(a.geometry, b.geometry)
			)
		`);
		await insertExcluded.query(outputId, inputA, inputB);
		await insertExcluded.close();
	} else {
		// Subtract mode: geometric difference — remove area of B from each feature in A
		// Pre-union all B geometries into a single shape, then subtract from each A feature.
		// ST_Simplify reduces vertices, ST_MakeValid repairs topology before ST_Union_Agg
		// to prevent TopologyException from non-noded intersections and degenerate segments.
		// Filters out NULL results (no B features) and empty geometries (A fully covered by B).
		const insertSubtracted = await connection.prepare(`
			WITH b_union AS (
				SELECT ST_Union_Agg(ST_MakeValid(ST_Simplify(geometry, 1e-7))) AS union_geom
				FROM features
				WHERE dataset_id = ?
				AND geometry IS NOT NULL
			)
			INSERT INTO features (dataset_id, source_url, geometry, properties)
			SELECT
				?,
				'operation:difference',
				ST_Difference(a.geometry, b_union.union_geom),
				a.properties
			FROM features a
			CROSS JOIN b_union
			WHERE a.dataset_id = ?
			AND a.geometry IS NOT NULL
			AND b_union.union_geom IS NOT NULL
			AND NOT ST_IsEmpty(ST_Difference(a.geometry, b_union.union_geom))
		`);
		await insertSubtracted.query(inputB, outputId, inputA);
		await insertSubtracted.close();
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
		callbacks?.onInfo?.('Difference', `Result: ${featureCount} features, type=${debugRow.geom_type}, mode=${mode}`);
	}

	if (featureCount === 0) {
		// Not necessarily an error — could be a valid "nothing left" result
		callbacks?.onWarn?.('Difference', `${inputA} - ${inputB} produced no features`);
		// Still register empty dataset for consistency
	}

	// Register dataset metadata
	const insertDataset = await connection.prepare(`
		INSERT INTO datasets (id, source_url, name, color, visible, feature_count, loaded_at, style)
		VALUES (?, 'operation:difference', ?, ?, true, ?, CURRENT_TIMESTAMP, ?)
	`);
	await insertDataset.query(outputId, displayName, color, featureCount, JSON.stringify(style));
	await insertDataset.close();

	return { outputId, displayName, featureCount, color, style };
}

/**
 * Execute a difference operation (compute + render).
 * Thin wrapper that calls computeDifference then renders the result on the map.
 *
 * @param op - Binary operation config with inputs[0] as primary, inputs[1] as overlay
 * @param context - Execution context with map, progress, etc.
 */
export async function executeDifference(
	op: BinaryOperation,
	context: OperationContext
): Promise<boolean> {
	const { map, logger, layerToggleControl, loadedDatasets } = context;

	const connection = await getConnection();
	const result = await computeDifference(connection, op, {
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

	const mode = (op.params as DifferenceParams | undefined)?.mode ?? 'subtract';

	if (result.featureCount === 0) {
		logger.progress(result.displayName, 'success', `No features remaining after difference`);
	} else {
		logger.progress(result.displayName, 'success', `${result.featureCount} feature(s) (${mode})`);
	}

	logger.info('Difference', `Complete: ${result.outputId} with ${result.featureCount} features`);

	return true;
}
