/**
 * Union operation - combines features from multiple datasets.
 *
 * Two modes:
 * - 'merge': Combine all features into one dataset (SQL UNION ALL, no geometry modification)
 * - 'dissolve': Merge all geometries into a single unified polygon (ST_Union_Agg)
 */

import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import { getConnection } from '../../db/core';
import { DEFAULT_COLOR } from '../../db/datasets';
import { getFeaturesAsGeoJSON } from '../../db/features';
import type { BinaryOperation, UnionParams } from '../types';
import type { OperationContext, ComputeResult, ComputeCallbacks } from './index';
import { parseStyleConfig, shouldSkipAutoLayers } from './index';
import { addOperationResultToMap } from './render';

/**
 * Pure SQL computation for union operation.
 * No MapLibre imports - can run in a Web Worker or headless CLI.
 */
export async function computeUnion(
	connection: AsyncDuckDBConnection,
	op: BinaryOperation,
	callbacks?: ComputeCallbacks
): Promise<ComputeResult> {
	const params = op.params as UnionParams | undefined;

	// Validate inputs
	if (!op.inputs || op.inputs.length < 2) {
		throw new Error(`Union operation '${op.output}': requires at least 2 inputs`);
	}

	// Validate params
	const mode = params?.mode ?? 'merge';
	if (mode !== 'merge' && mode !== 'dissolve') {
		throw new Error(`Union operation '${op.output}': mode must be 'merge' or 'dissolve'`);
	}

	const outputId = op.output;
	const displayName = op.name || outputId;
	const color = op.color ?? DEFAULT_COLOR;
	const style = parseStyleConfig(op.style);
	const inputList = op.inputs.join(', ');

	const modeLabel = mode === 'merge' ? 'merging' : 'dissolving';
	callbacks?.onProgress?.(`Union ${inputList} (${modeLabel})...`);

	// Delete existing output if present (allows re-running)
	const deleteFeatures = await connection.prepare('DELETE FROM features WHERE dataset_id = ?');
	await deleteFeatures.query(outputId);
	await deleteFeatures.close();

	const deleteDatasets = await connection.prepare('DELETE FROM datasets WHERE id = ?');
	await deleteDatasets.query(outputId);
	await deleteDatasets.close();

	if (mode === 'merge') {
		// Merge mode: UNION ALL from all inputs, preserving individual features
		// Build one SELECT per input and combine with UNION ALL
		const selects = op.inputs.map(() =>
			`SELECT ?, 'operation:union', geometry, properties FROM features WHERE dataset_id = ?`
		).join(' UNION ALL ');

		const insertMerged = await connection.prepare(`
			INSERT INTO features (dataset_id, source_url, geometry, properties)
			${selects}
		`);

		// Flatten params: [outputId, inputA, outputId, inputB, ...]
		const queryParams = op.inputs.flatMap(inputId => [outputId, inputId]);
		await insertMerged.query(...queryParams);
		await insertMerged.close();
	} else {
		// Dissolve mode: merge all geometries from all inputs into a single feature
		// ST_MakeValid repairs invalid/degenerate geometries (self-intersections,
		// non-noded intersections, zero-length segments) before ST_Union_Agg.
		// ST_Buffer(geom, 0) alone can throw TopologyException on these inputs.
		const placeholders = op.inputs.map(() => '?').join(', ');

		const insertDissolved = await connection.prepare(`
			INSERT INTO features (dataset_id, source_url, geometry, properties)
			SELECT
				?,
				'operation:union',
				ST_Union_Agg(ST_MakeValid(geometry)),
				'{"dissolved": true}'
			FROM features
			WHERE dataset_id IN (${placeholders})
			AND geometry IS NOT NULL
		`);
		await insertDissolved.query(outputId, ...op.inputs);
		await insertDissolved.close();
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
		callbacks?.onInfo?.('Union', `Result: ${featureCount} features, type=${debugRow.geom_type}, mode=${mode}`);
	}

	if (featureCount === 0) {
		callbacks?.onWarn?.('Union', `union of ${inputList} produced no features`);
	}

	// Register dataset metadata
	const insertDataset = await connection.prepare(`
		INSERT INTO datasets (id, source_url, name, color, visible, feature_count, loaded_at, style)
		VALUES (?, 'operation:union', ?, ?, true, ?, CURRENT_TIMESTAMP, ?)
	`);
	await insertDataset.query(outputId, displayName, color, featureCount, JSON.stringify(style));
	await insertDataset.close();

	return { outputId, displayName, featureCount, color, style };
}

/**
 * Execute a union operation (compute + render).
 * Thin wrapper that calls computeUnion then renders the result on the map.
 *
 * @param op - Binary operation config with inputs as datasets to union
 * @param context - Execution context with map, progress, etc.
 */
export async function executeUnion(
	op: BinaryOperation,
	context: OperationContext
): Promise<boolean> {
	const { map, logger, layerToggleControl, loadedDatasets } = context;

	const connection = await getConnection();
	const result = await computeUnion(connection, op, {
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

	const mode = (op.params as UnionParams | undefined)?.mode ?? 'merge';

	if (result.featureCount === 0) {
		logger.progress(result.displayName, 'success', `No features produced`);
	} else {
		logger.progress(result.displayName, 'success', `${result.featureCount} feature(s) (${mode})`);
	}

	logger.info('Union', `Complete: ${result.outputId} with ${result.featureCount} features`);

	return true;
}
