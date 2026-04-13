/**
 * Join operation - tabular join between a source (lookup) dataset and a spatial target dataset.
 * Merges properties from the source into the target by matching a shared key field.
 *
 * Two modes:
 * - 'left' (default): Keep all target features, merging source properties where keys match
 * - 'inner': Keep only target features that have a matching source row
 *
 * Input ordering: inputs[0] is the source (tabular lookup), inputs[1] is the target (spatial).
 * Output geometry comes from the target dataset.
 */

import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import { getConnection } from '../../db/core';
import { DEFAULT_COLOR } from '../../db/datasets';
import { getFeaturesAsGeoJSON } from '../../db/features';
import type { BinaryOperation, JoinParams } from '../types';
import type { OperationContext, ComputeResult, ComputeCallbacks } from './index';
import { parseStyleConfig, shouldSkipAutoLayers } from './index';
import { addOperationResultToMap } from './render';

/**
 * Pure SQL computation for join operation.
 * No MapLibre imports - can run in a Web Worker or headless CLI.
 */
export async function computeJoin(
	connection: AsyncDuckDBConnection,
	op: BinaryOperation,
	callbacks?: ComputeCallbacks
): Promise<ComputeResult> {
	const params = op.params as JoinParams | undefined;

	// Validate inputs
	if (!op.inputs || op.inputs.length !== 2) {
		throw new Error(`Join operation '${op.output}': requires exactly 2 inputs`);
	}

	// Validate params
	if (!params?.sourceKey || !params?.targetKey) {
		throw new Error(`Join operation '${op.output}': requires 'sourceKey' and 'targetKey' params`);
	}

	const mode = params.mode ?? 'left';
	if (mode !== 'left' && mode !== 'inner') {
		throw new Error(`Join operation '${op.output}': mode must be 'left' or 'inner'`);
	}

	const [source, target] = op.inputs;
	const outputId = op.output;
	const displayName = op.name || outputId;
	const color = op.color ?? DEFAULT_COLOR;
	const style = parseStyleConfig(op.style);

	const modeLabel = mode === 'left' ? 'left (keep all target)' : 'inner (matches only)';
	callbacks?.onProgress?.(`Join ${source} -> ${target} on ${params.sourceKey}/${params.targetKey} (${modeLabel})...`);

	// Delete existing output if present (allows re-running)
	const deleteFeatures = await connection.prepare('DELETE FROM features WHERE dataset_id = ?');
	await deleteFeatures.query(outputId);
	await deleteFeatures.close();

	const deleteDatasets = await connection.prepare('DELETE FROM datasets WHERE id = ?');
	await deleteDatasets.query(outputId);
	await deleteDatasets.close();

	// Build JSON path expressions for key matching.
	// Keys come from validated config (not runtime user input), so string interpolation is safe here.
	// DuckDB does not support parameterized JSON path expressions.
	const sourceKeyPath = `$.${params.sourceKey}`;
	const targetKeyPath = `$.${params.targetKey}`;

	if (mode === 'left') {
		// Left join: keep all target features, merge source properties where keys match
		const insertJoined = await connection.prepare(`
			INSERT INTO features (dataset_id, source_url, geometry, properties)
			SELECT
				?,
				'operation:join',
				t.geometry,
				CASE
					WHEN s.properties IS NOT NULL
					THEN json_merge_patch(t.properties, s.properties)
					ELSE t.properties
				END
			FROM features t
			LEFT JOIN features s
				ON s.dataset_id = ?
				AND json_extract_string(s.properties, '${sourceKeyPath}') = json_extract_string(t.properties, '${targetKeyPath}')
			WHERE t.dataset_id = ?
			AND t.geometry IS NOT NULL
		`);
		await insertJoined.query(outputId, source, target);
		await insertJoined.close();
	} else {
		// Inner join: keep only target features with matching source rows
		const insertJoined = await connection.prepare(`
			INSERT INTO features (dataset_id, source_url, geometry, properties)
			SELECT
				?,
				'operation:join',
				t.geometry,
				json_merge_patch(t.properties, s.properties)
			FROM features t
			JOIN features s
				ON s.dataset_id = ?
				AND json_extract_string(s.properties, '${sourceKeyPath}') = json_extract_string(t.properties, '${targetKeyPath}')
			WHERE t.dataset_id = ?
			AND t.geometry IS NOT NULL
		`);
		await insertJoined.query(outputId, source, target);
		await insertJoined.close();
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
		callbacks?.onInfo?.('Join', `Result: ${featureCount} features, type=${debugRow.geom_type}, mode=${mode}`);
	}

	if (featureCount === 0) {
		callbacks?.onWarn?.('Join', `${source} join ${target} produced no features`);
	}

	// Register dataset metadata
	const insertDataset = await connection.prepare(`
		INSERT INTO datasets (id, source_url, name, color, visible, feature_count, loaded_at, style)
		VALUES (?, 'operation:join', ?, ?, true, ?, CURRENT_TIMESTAMP, ?)
	`);
	await insertDataset.query(outputId, displayName, color, featureCount, JSON.stringify(style));
	await insertDataset.close();

	return { outputId, displayName, featureCount, color, style };
}

/**
 * Execute a join operation (compute + render).
 * Thin wrapper that calls computeJoin then renders the result on the map.
 *
 * @param op - Binary operation config with inputs[0] as source (tabular), inputs[1] as target (spatial)
 * @param context - Execution context with map, progress, etc.
 */
export async function executeJoin(
	op: BinaryOperation,
	context: OperationContext
): Promise<boolean> {
	const { map, logger, layerToggleControl, loadedDatasets } = context;

	const connection = await getConnection();
	const result = await computeJoin(connection, op, {
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

	const mode = (op.params as JoinParams | undefined)?.mode ?? 'left';

	if (result.featureCount === 0) {
		logger.progress(result.displayName, 'success', `No features found (${mode} join)`);
	} else {
		logger.progress(result.displayName, 'success', `${result.featureCount} feature(s) (${mode} join)`);
	}

	logger.info('Join', `Complete: ${result.outputId} with ${result.featureCount} features`);

	return true;
}
