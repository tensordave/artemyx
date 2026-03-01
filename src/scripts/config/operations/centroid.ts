/**
 * Centroid operation - computes the geometric center point of each input feature.
 *
 * Uses ST_Centroid which returns a POINT geometry representing the center of mass.
 * Works on all geometry types: polygons → interior center, lines → midpoint, points → identity.
 * Original properties are preserved on the output points.
 *
 * No params required — centroid is unambiguous.
 */

import { getConnection } from '../../db/core';
import { DEFAULT_COLOR } from '../../db/datasets';
import { getFeaturesAsGeoJSON } from '../../db/features';
import type { UnaryOperation } from '../types';
import type { OperationContext } from './index';
import { parseStyleConfig, shouldSkipAutoLayers } from './index';
import { addOperationResultToMap } from './buffer';

/**
 * Execute a centroid operation.
 * Converts each input feature's geometry to its center point.
 *
 * @param op - Unary operation config with input dataset ID
 * @param context - Execution context with map, progress, etc.
 */
export async function executeCentroid(
	op: UnaryOperation,
	context: OperationContext
): Promise<boolean> {
	const { map, progressControl, layerToggleControl, loadedDatasets } = context;

	const outputId = op.output;
	const displayName = op.name || outputId;
	const inputId = op.input;
	const color = op.color ?? DEFAULT_COLOR;
	const style = parseStyleConfig(op.style);

	progressControl.updateProgress(displayName, 'processing', `Computing centroids of ${inputId}...`);

	const connection = await getConnection();

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
		console.log(`[Centroid] Warning: ${inputId} produced no centroid features`);
		progressControl.updateProgress(displayName, 'success', `No features found`);
	}

	// Register dataset metadata
	const insertDataset = await connection.prepare(`
		INSERT INTO datasets (id, source_url, name, color, visible, feature_count, loaded_at, style)
		VALUES (?, 'operation:centroid', ?, ?, true, ?, CURRENT_TIMESTAMP, ?)
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

	progressControl.updateProgress(displayName, 'success', `${featureCount} centroid(s)`);

	console.log(`[Centroid] Complete: ${outputId} with ${featureCount} features`);

	return true;
}
