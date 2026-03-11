/**
 * Intersection operation - finds features that overlap between two datasets.
 *
 * Two modes:
 * - 'filter': Keep features from first input that intersect with any feature in second input
 * - 'clip': Compute actual geometric intersection (output is the overlapping geometry)
 */

import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import { getConnection } from '../../db/core';
import { DEFAULT_COLOR } from '../../db/datasets';
import { getFeaturesAsGeoJSON } from '../../db/features';
import type { BinaryOperation, IntersectionParams } from '../types';
import type { OperationContext, ComputeResult, ComputeCallbacks } from './index';
import { parseStyleConfig, shouldSkipAutoLayers } from './index';
import { addOperationResultToMap } from './render';

/**
 * Pure SQL computation for intersection operation.
 * No MapLibre imports - can run in a Web Worker or headless CLI.
 */
export async function computeIntersection(
	connection: AsyncDuckDBConnection,
	op: BinaryOperation,
	callbacks?: ComputeCallbacks
): Promise<ComputeResult> {
	const params = op.params as IntersectionParams | undefined;

	// Validate inputs
	if (!op.inputs || op.inputs.length !== 2) {
		throw new Error(`Intersection operation '${op.output}': requires exactly 2 inputs`);
	}

	// Validate params
	const mode = params?.mode ?? 'filter';
	if (mode !== 'filter' && mode !== 'clip') {
		throw new Error(`Intersection operation '${op.output}': mode must be 'filter' or 'clip'`);
	}

	const [inputA, inputB] = op.inputs;
	const outputId = op.output;
	const displayName = op.name || outputId;
	const color = op.color ?? DEFAULT_COLOR;
	const style = parseStyleConfig(op.style);

	const modeLabel = mode === 'filter' ? 'filtering' : 'clipping';
	callbacks?.onProgress?.(`Intersecting ${inputA} with ${inputB} (${modeLabel})...`);

	// Delete existing output if present (allows re-running)
	const deleteFeatures = await connection.prepare('DELETE FROM features WHERE dataset_id = ?');
	await deleteFeatures.query(outputId);
	await deleteFeatures.close();

	const deleteDatasets = await connection.prepare('DELETE FROM datasets WHERE id = ?');
	await deleteDatasets.query(outputId);
	await deleteDatasets.close();

	if (mode === 'filter') {
		// Filter mode: keep features from A that intersect with any feature in B
		// Uses EXISTS subquery for efficiency (stops at first match)
		const insertFiltered = await connection.prepare(`
			INSERT INTO features (dataset_id, source_url, geometry, properties)
			SELECT
				?,
				'operation:intersection',
				a.geometry,
				a.properties
			FROM features a
			WHERE a.dataset_id = ?
			AND EXISTS (
				SELECT 1 FROM features b
				WHERE b.dataset_id = ?
				AND ST_Intersects(a.geometry, b.geometry)
			)
		`);
		await insertFiltered.query(outputId, inputA, inputB);
		await insertFiltered.close();
	} else {
		// Clip mode: compute actual geometric intersection
		// CTE pre-simplifies and unions all B geometries into a single clip mask.
		// This dramatically reduces ST_Intersection cost when B is a complex dissolved
		// polygon (e.g., buffered bikeway walkshed from 3,730 segments).
		// Tolerance of ~33m at mid-latitudes — visually indistinguishable on a map.
		const insertClipped = await connection.prepare(`
			INSERT INTO features (dataset_id, source_url, geometry, properties)
			WITH clip_mask AS (
				SELECT ST_Union_Agg(ST_MakeValid(ST_Simplify(geometry, 0.0003))) AS geometry
				FROM features
				WHERE dataset_id = ?
				AND geometry IS NOT NULL
			)
			SELECT
				?,
				'operation:intersection',
				ST_Intersection(a.geometry, clip_mask.geometry),
				a.properties
			FROM features a, clip_mask
			WHERE a.dataset_id = ?
			AND a.geometry IS NOT NULL
			AND ST_Intersects(a.geometry, clip_mask.geometry)
		`);
		await insertClipped.query(inputB, outputId, inputA);
		await insertClipped.close();
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
		callbacks?.onInfo?.('Intersection', `Result: ${featureCount} features, type=${debugRow.geom_type}, mode=${mode}`);
	}

	if (featureCount === 0) {
		// Not necessarily an error - could be valid "no intersection" result
		callbacks?.onWarn?.('Intersection', `${inputA} ∩ ${inputB} produced no features`);
		// Still register empty dataset for consistency
	}

	// Register dataset metadata
	const insertDataset = await connection.prepare(`
		INSERT INTO datasets (id, source_url, name, color, visible, feature_count, loaded_at, style)
		VALUES (?, 'operation:intersection', ?, ?, true, ?, CURRENT_TIMESTAMP, ?)
	`);
	await insertDataset.query(outputId, displayName, color, featureCount, JSON.stringify(style));
	await insertDataset.close();

	return { outputId, displayName, featureCount, color, style };
}

/**
 * Execute an intersection operation (compute + render).
 * Thin wrapper that calls computeIntersection then renders the result on the map.
 *
 * @param op - Binary operation config with inputs[0] as primary, inputs[1] as overlay
 * @param context - Execution context with map, progress, etc.
 */
export async function executeIntersection(
	op: BinaryOperation,
	context: OperationContext
): Promise<boolean> {
	const { map, logger, layerToggleControl, loadedDatasets } = context;

	const connection = await getConnection();
	const result = await computeIntersection(connection, op, {
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

	const mode = (op.params as IntersectionParams | undefined)?.mode ?? 'filter';

	if (result.featureCount === 0) {
		logger.progress(result.displayName, 'success', `No intersecting features found`);
	} else {
		logger.progress(result.displayName, 'success', `${result.featureCount} feature(s) (${mode})`);
	}

	logger.info('Intersection', `Complete: ${result.outputId} with ${result.featureCount} features`);

	return true;
}
