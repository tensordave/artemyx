/**
 * Difference operation - subtracts one dataset's geometry from another.
 *
 * Two modes:
 * - 'exclude': Keep features from first input that do NOT intersect with any feature in second input
 * - 'subtract': Compute geometric difference — remove the area of B from each feature in A
 */

import { getConnection } from '../../db/core';
import { DEFAULT_COLOR } from '../../db/datasets';
import { getFeaturesAsGeoJSON } from '../../db/features';
import type { BinaryOperation, DifferenceParams } from '../types';
import type { OperationContext } from './index';
import { parseStyleConfig, shouldSkipAutoLayers } from './index';
import { addOperationResultToMap } from './buffer';

/**
 * Execute a difference operation.
 * Takes two inputs: first input's features are subtracted/filtered by second input.
 *
 * @param op - Binary operation config with inputs[0] as primary, inputs[1] as overlay
 * @param context - Execution context with map, progress, etc.
 */
export async function executeDifference(
	op: BinaryOperation,
	context: OperationContext
): Promise<boolean> {
	const { map, logger, layerToggleControl, loadedDatasets } = context;
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
	logger.progress(displayName, 'processing', `Differencing ${inputA} minus ${inputB} (${modeLabel})...`);

	const connection = await getConnection();

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
		// ST_Simplify on the B union prevents TopologyException from near-coincident vertices
		// (same approach as buffer dissolve and union dissolve).
		// Filters out NULL results (no B features) and empty geometries (A fully covered by B).
		const insertSubtracted = await connection.prepare(`
			WITH b_union AS (
				SELECT ST_Simplify(ST_Union_Agg(geometry), 1e-7) AS union_geom
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
		logger.info('Difference', `Result: ${featureCount} features, type=${debugRow.geom_type}, mode=${mode}`);
	}

	if (featureCount === 0) {
		// Not necessarily an error — could be a valid "nothing left" result
		logger.warn('Difference', `${inputA} - ${inputB} produced no features`);
		logger.progress(displayName, 'success', `No features remaining after difference`);
		// Still register empty dataset for consistency
	}

	// Register dataset metadata
	const insertDataset = await connection.prepare(`
		INSERT INTO datasets (id, source_url, name, color, visible, feature_count, loaded_at, style)
		VALUES (?, 'operation:difference', ?, ?, true, ?, CURRENT_TIMESTAMP, ?)
	`);
	await insertDataset.query(outputId, op.name || outputId, color, featureCount, JSON.stringify(style));
	await insertDataset.close();

	// Query features as GeoJSON for map rendering
	const geoJsonData = await getFeaturesAsGeoJSON(outputId);

	// Add source and layers to map (skip layers if explicit config exists)
	const layerIds = addOperationResultToMap(map, outputId, color, style, geoJsonData, shouldSkipAutoLayers(outputId, context.layers));

	// Track dataset
	loadedDatasets.add(outputId);

	// Notify executor to attach popup/hover handlers
	if (layerIds.length > 0) {
		context.onLayersCreated?.(layerIds, displayName);
	}

	// Refresh layer control
	layerToggleControl.refreshPanel();

	logger.progress(displayName, 'success', `${featureCount} feature(s) (${mode})`);

	logger.info('Difference', `Complete: ${outputId} with ${featureCount} features`);

	return true;
}
