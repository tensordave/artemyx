/**
 * Attribute operation - filter features based on property values.
 *
 * Two authoring modes:
 * - Structured: property/operator/value for simple comparisons
 * - Raw `where`: DuckDB SQL WHERE clause for advanced filtering
 *
 * Unary operation — takes a single input dataset.
 * Features missing the filtered property are silently excluded.
 */

import { getConnection } from '../../db/core';
import { DEFAULT_COLOR } from '../../db/datasets';
import { getFeaturesAsGeoJSON } from '../../db/features';
import type { UnaryOperation, AttributeParams } from '../types';
import type { OperationContext } from './index';
import { parseStyleConfig, shouldSkipAutoLayers } from './index';
import { addOperationResultToMap } from './buffer';

/**
 * Build a SQL WHERE clause fragment from structured params.
 * Uses json_extract_string for string comparisons, json_extract with DOUBLE cast for numeric.
 */
function buildStructuredWhere(property: string, operator: string, value: string | number): string {
	if (typeof value === 'number') {
		return `CAST(json_extract_string(properties, '$.${property}') AS DOUBLE) ${operator} ${value}`;
	}
	// String comparison — single quotes escaped for SQL safety
	const escaped = String(value).replace(/'/g, "''");
	return `json_extract_string(properties, '$.${property}') ${operator} '${escaped}'`;
}

/**
 * Execute an attribute filter operation.
 */
export async function executeAttribute(
	op: UnaryOperation,
	context: OperationContext
): Promise<boolean> {
	const { map, progressControl, layerToggleControl, loadedDatasets } = context;
	const params = op.params as AttributeParams | undefined;

	if (!params) {
		throw new Error(`Attribute operation '${op.output}': requires params (structured filter or where clause)`);
	}

	const outputId = op.output;
	const displayName = op.name || outputId;
	const inputId = op.input;
	const color = op.color ?? DEFAULT_COLOR;
	const style = parseStyleConfig(op.style);

	// Build WHERE clause from either structured params or raw where
	let whereClause: string;
	let filterLabel: string;

	if (params.where) {
		// Raw SQL WHERE clause — config YAML is trusted input
		whereClause = params.where;
		filterLabel = 'custom SQL filter';
	} else {
		const property = params.property!;
		const operator = params.operator ?? '=';
		const value = params.value!;
		whereClause = buildStructuredWhere(property, operator, value);
		filterLabel = `${property} ${operator} ${typeof value === 'string' ? `'${value}'` : value}`;
	}

	progressControl.updateProgress(displayName, 'processing', `Filtering ${inputId} (${filterLabel})...`);

	const connection = await getConnection();

	// Delete existing output if present (allows re-running)
	const deleteFeatures = await connection.prepare('DELETE FROM features WHERE dataset_id = ?');
	await deleteFeatures.query(outputId);
	await deleteFeatures.close();

	const deleteDatasets = await connection.prepare('DELETE FROM datasets WHERE id = ?');
	await deleteDatasets.query(outputId);
	await deleteDatasets.close();

	// Execute the filter query
	// The WHERE clause is built from trusted config YAML, not user runtime input
	const insertFiltered = await connection.prepare(`
		INSERT INTO features (dataset_id, source_url, geometry, properties)
		SELECT
			?,
			'operation:attribute',
			geometry,
			properties
		FROM features
		WHERE dataset_id = ?
		AND (${whereClause})
	`);
	await insertFiltered.query(outputId, inputId);
	await insertFiltered.close();

	// Get feature count
	const countStmt = await connection.prepare(`
		SELECT COUNT(*) as count FROM features WHERE dataset_id = ?
	`);
	const countResult = await countStmt.query(outputId);
	await countStmt.close();
	const featureCount = Number(countResult.toArray()[0].count);

	if (featureCount === 0) {
		console.log(`[Attribute] Warning: ${inputId} filter produced no features (${filterLabel})`);
		progressControl.updateProgress(displayName, 'success', `No features matched filter`);
	}

	// Register dataset metadata
	const insertDataset = await connection.prepare(`
		INSERT INTO datasets (id, source_url, name, color, visible, feature_count, loaded_at, style)
		VALUES (?, 'operation:attribute', ?, ?, true, ?, CURRENT_TIMESTAMP, ?)
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

	progressControl.updateProgress(displayName, 'success', `${featureCount} feature(s) (${filterLabel})`);

	console.log(`[Attribute] Complete: ${outputId} with ${featureCount} features (${filterLabel})`);

	return true;
}
