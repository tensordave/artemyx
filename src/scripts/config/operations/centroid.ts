/**
 * Centroid operation - computes the geometric center point of each input feature.
 *
 * Uses ST_Centroid which returns a POINT geometry representing the center of mass.
 * Works on all geometry types: polygons → interior center, lines → midpoint, points → identity.
 * Original properties are preserved on the output points.
 *
 * No params required — centroid is unambiguous.
 */

import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import { getConnection } from '../../db/core';
import { DEFAULT_COLOR } from '../../db/datasets';
import { getFeaturesAsGeoJSON } from '../../db/features';
import type { UnaryOperation } from '../types';
import type { OperationContext, ComputeResult, ComputeCallbacks } from './index';
import { parseStyleConfig, shouldSkipAutoLayers } from './index';
import { addOperationResultToMap } from './render';

/**
 * Pure SQL computation for centroid operation.
 * No MapLibre imports - can run in a Web Worker or headless CLI.
 */
export async function computeCentroid(
	connection: AsyncDuckDBConnection,
	op: UnaryOperation,
	callbacks?: ComputeCallbacks
): Promise<ComputeResult> {
	const outputId = op.output;
	const displayName = op.name || outputId;
	const inputId = op.input;
	const color = op.color ?? DEFAULT_COLOR;
	const style = parseStyleConfig(op.style);

	callbacks?.onProgress?.(`Computing centroids of ${inputId}...`);

	// Delete existing output if present (allows re-running)
	const deleteFeatures = await connection.prepare('DELETE FROM features WHERE dataset_id = ?');
	await deleteFeatures.query(outputId);
	await deleteFeatures.close();

	const deleteDatasets = await connection.prepare('DELETE FROM datasets WHERE id = ?');
	await deleteDatasets.query(outputId);
	await deleteDatasets.close();

	// Compute centroid for each feature
	const insertCentroids = await connection.prepare(`
		INSERT INTO features (dataset_id, source_url, geometry, properties)
		SELECT
			?,
			'operation:centroid',
			ST_Centroid(geometry),
			properties
		FROM features
		WHERE dataset_id = ?
		AND geometry IS NOT NULL
	`);
	await insertCentroids.query(outputId, inputId);
	await insertCentroids.close();

	// Get feature count
	const countStmt = await connection.prepare(`
		SELECT COUNT(*) as count FROM features WHERE dataset_id = ?
	`);
	const countResult = await countStmt.query(outputId);
	await countStmt.close();
	const featureCount = Number(countResult.toArray()[0].count);

	if (featureCount === 0) {
		callbacks?.onWarn?.('Centroid', `${inputId} produced no centroid features`);
	}

	// Register dataset metadata
	const insertDataset = await connection.prepare(`
		INSERT INTO datasets (id, source_url, name, color, visible, feature_count, loaded_at, style)
		VALUES (?, 'operation:centroid', ?, ?, true, ?, CURRENT_TIMESTAMP, ?)
	`);
	await insertDataset.query(outputId, op.name || outputId, color, featureCount, JSON.stringify(style));
	await insertDataset.close();

	return { outputId, displayName, featureCount, color, style };
}

/**
 * Execute a centroid operation (compute + render).
 * Thin wrapper that calls computeCentroid then renders the result on the map.
 */
export async function executeCentroid(
	op: UnaryOperation,
	context: OperationContext
): Promise<boolean> {
	const { map, logger, layerToggleControl, loadedDatasets } = context;

	const connection = await getConnection();
	const result = await computeCentroid(connection, op, {
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

	logger.progress(result.displayName, 'success', `${result.featureCount} centroid(s)`);

	logger.info('Centroid', `Complete: ${result.outputId} with ${result.featureCount} features`);

	return true;
}
