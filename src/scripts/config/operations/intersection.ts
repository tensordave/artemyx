/**
 * Intersection operation - finds features that overlap between two datasets.
 *
 * Two modes:
 * - 'filter': Keep features from first input that intersect with any feature in second input
 * - 'clip': Compute actual geometric intersection (output is the overlapping geometry)
 */

import { getConnection } from '../../db/core';
import { DEFAULT_COLOR } from '../../db/datasets';
import { getFeaturesAsGeoJSON } from '../../db/features';
import { attachFeatureClickHandlers } from '../../popup';
import type { BinaryOperation, IntersectionParams } from '../types';
import type { OperationContext } from './index';
import { parseStyleConfig } from './index';
import { addOperationResultToMap } from './buffer';

/**
 * Execute an intersection operation.
 * Takes two inputs: first input's features are tested/clipped against second input.
 *
 * @param op - Binary operation config with inputs[0] as primary, inputs[1] as overlay
 * @param context - Execution context with map, progress, etc.
 */
export async function executeIntersection(
	op: BinaryOperation,
	context: OperationContext
): Promise<boolean> {
	const { map, progressControl, layerToggleControl, loadedDatasets, layers } = context;
	const hasExplicitLayers = layers !== undefined;
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
	const color = op.color ?? DEFAULT_COLOR;
	const style = parseStyleConfig(op.style);

	const modeLabel = mode === 'filter' ? 'filtering' : 'clipping';
	progressControl.updateProgress(outputId, 'processing', `Intersecting ${inputA} with ${inputB} (${modeLabel})...`);

	const connection = await getConnection();

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
				SELECT ST_Union_Agg(ST_Simplify(geometry, 0.0003)) AS geometry
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
		console.log(`[Intersection] Result: ${featureCount} features, type=${debugRow.geom_type}, mode=${mode}`);
	}

	if (featureCount === 0) {
		// Not necessarily an error - could be valid "no intersection" result
		console.log(`[Intersection] Warning: ${inputA} ∩ ${inputB} produced no features`);
		progressControl.updateProgress(outputId, 'success', `No intersecting features found`);
		// Still register empty dataset for consistency
	}

	// Register dataset metadata
	const insertDataset = await connection.prepare(`
		INSERT INTO datasets (id, source_url, name, color, visible, feature_count, loaded_at, style)
		VALUES (?, 'operation:intersection', ?, ?, true, ?, CURRENT_TIMESTAMP, ?)
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

	console.log(`[Intersection] Complete: ${outputId} with ${featureCount} features`);

	return true;
}
