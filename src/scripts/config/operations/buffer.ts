/**
 * Buffer operation - creates a polygon around input features at a specified distance.
 * Uses DuckDB spatial ST_Buffer with meter-to-degree conversion.
 */

import type maplibregl from 'maplibre-gl';
import { getConnection } from '../../db/core';
import { DEFAULT_COLOR } from '../../db/datasets';
import type { StyleConfig } from '../../db/datasets';
import { getFeaturesAsGeoJSON } from '../../db/features';
import { getSourceId, addSource, removeDefaultLayers, addDefaultLayers } from '../../layers';
import { attachFeatureClickHandlers } from '../../popup';
import type { UnaryOperation, BufferParams } from '../types';
import type { OperationContext } from './index';
import { parseStyleConfig } from './index';
import { toMeters, metersToDegreesAtLatitude } from './unit-conversion';

/**
 * Add GeoJSON data to map as source, optionally with default layers.
 * Removes existing source/layers first (for re-running operations).
 *
 * @param skipLayers - When true, only add source (explicit layers defined in config).
 * @returns Layer IDs if layers were created, empty array otherwise.
 */
export function addOperationResultToMap(
	map: maplibregl.Map,
	datasetId: string,
	datasetColor: string,
	style: StyleConfig,
	geoJsonData: GeoJSON.FeatureCollection,
	skipLayers: boolean = false
): string[] {
	const sourceId = getSourceId(datasetId);

	// Remove existing layers and source if present
	removeDefaultLayers(map, datasetId);

	// Add source
	addSource(map, sourceId, geoJsonData);

	// Add default layers only if no explicit layers config
	if (!skipLayers) {
		return addDefaultLayers(map, sourceId, datasetId, datasetColor, style);
	}

	return [];
}

/**
 * Execute a buffer operation.
 * Converts meter distance to degrees for DuckDB spatial (which lacks GEOGRAPHY type).
 * Optionally dissolves overlapping buffers with ST_Union_Agg.
 */
export async function executeBuffer(
	op: UnaryOperation,
	context: OperationContext
): Promise<boolean> {
	const { map, progressControl, layerToggleControl, loadedDatasets, layers } = context;
	const hasExplicitLayers = layers !== undefined;
	const params = op.params as BufferParams | undefined;

	// Validate params
	if (!params?.distance || params.distance <= 0) {
		throw new Error(`Buffer operation '${op.output}': distance must be a positive number`);
	}

	const units = params.units;
	const distanceMeters = toMeters(params.distance, units);
	const dissolve = params.dissolve ?? false;
	const quadSegs = params.quadSegs ?? 32;
	const outputId = op.output;
	const inputId = op.input;
	const color = op.color ?? DEFAULT_COLOR;
	const style = parseStyleConfig(op.style);

	progressControl.updateProgress(outputId, 'processing', `Buffering ${inputId} by ${params.distance}${units === 'meters' ? 'm' : ' ' + units}...`);

	const connection = await getConnection();

	// Get centroid latitude of input features for meter-to-degree conversion
	const centroidStmt = await connection.prepare(`
		SELECT AVG(ST_Y(ST_Centroid(geometry))) as avg_lat
		FROM features
		WHERE dataset_id = ?
	`);
	const centroidResult = await centroidStmt.query(inputId);
	await centroidStmt.close();
	const avgLatitude = Number(centroidResult.toArray()[0]?.avg_lat) || 49; // Default to Vancouver lat

	// Convert meters to degrees (DuckDB spatial lacks GEOGRAPHY type)
	const distanceDegrees = metersToDegreesAtLatitude(distanceMeters, avgLatitude);
	console.log(`[Buffer] ${params.distance} ${units} (${distanceMeters}m) → ${distanceDegrees.toFixed(6)}° at lat ${avgLatitude.toFixed(2)}°, quadSegs=${quadSegs}`);

	// Delete existing output if present (allows re-running)
	const deleteFeatures = await connection.prepare('DELETE FROM features WHERE dataset_id = ?');
	await deleteFeatures.query(outputId);
	await deleteFeatures.close();

	const deleteDatasets = await connection.prepare('DELETE FROM datasets WHERE id = ?');
	await deleteDatasets.query(outputId);
	await deleteDatasets.close();

	if (dissolve) {
		// Dissolve: merge all buffered geometries into a single feature
		// ST_Simplify with small tolerance reduces vertices and avoids
		// TopologyException from near-coincident edges during union.
		// Keep tolerance low (1%) to preserve curve detail from quadSegs.
		const simplifyTolerance = distanceDegrees * 0.01;
		const insertDissolved = await connection.prepare(`
			INSERT INTO features (dataset_id, source_url, geometry, properties)
			SELECT
				?,
				'operation:buffer',
				ST_Union_Agg(ST_Simplify(ST_Buffer(geometry, ?, CAST(? AS INTEGER)), ?)),
				'{"dissolved": true}'
			FROM features
			WHERE dataset_id = ?
			AND geometry IS NOT NULL
		`);
		await insertDissolved.query(outputId, distanceDegrees, quadSegs, simplifyTolerance, inputId);
		await insertDissolved.close();
	} else {
		// No dissolve: buffer each feature individually
		const insertBuffered = await connection.prepare(`
			INSERT INTO features (dataset_id, source_url, geometry, properties)
			SELECT
				?,
				'operation:buffer',
				ST_Buffer(geometry, ?, CAST(? AS INTEGER)),
				properties
			FROM features
			WHERE dataset_id = ?
		`);
		await insertBuffered.query(outputId, distanceDegrees, quadSegs, inputId);
		await insertBuffered.close();
	}

	// Get feature count and debug geometry info
	const countStmt = await connection.prepare(`
		SELECT COUNT(*) as count FROM features WHERE dataset_id = ?
	`);
	const countResult = await countStmt.query(outputId);
	await countStmt.close();
	const featureCount = Number(countResult.toArray()[0].count);

	// Debug: check geometry type and GeoJSON conversion
	if (featureCount > 0) {
		const debugStmt = await connection.prepare(`
			SELECT
				ST_GeometryType(geometry) as geom_type,
				ST_AsGeoJSON(geometry) as geojson
			FROM features
			WHERE dataset_id = ?
			LIMIT 1
		`);
		const debugResult = await debugStmt.query(outputId);
		await debugStmt.close();
		const debugRow = debugResult.toArray()[0];
		console.log(`[Buffer] Result: ${featureCount} features, type=${debugRow.geom_type}, geojson length=${debugRow.geojson?.length || 0}`);
	}

	if (featureCount === 0) {
		throw new Error(`Buffer operation '${op.output}': produced no features`);
	}

	// Register dataset metadata
	const insertDataset = await connection.prepare(`
		INSERT INTO datasets (id, source_url, name, color, visible, feature_count, loaded_at, style)
		VALUES (?, 'operation:buffer', ?, ?, true, ?, CURRENT_TIMESTAMP, ?)
	`);
	await insertDataset.query(outputId, outputId, color, featureCount, JSON.stringify(style));
	await insertDataset.close();

	// Query features as GeoJSON for map rendering
	const geoJsonData = await getFeaturesAsGeoJSON(outputId);

	if (!geoJsonData.features || geoJsonData.features.length === 0) {
		throw new Error(`Buffer operation '${op.output}': no features returned from query`);
	}

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

	const dissolveNote = dissolve ? ' (dissolved)' : '';
	progressControl.updateProgress(outputId, 'success', `Created ${featureCount} feature(s)${dissolveNote}`);

	console.log(`[Buffer] Complete: ${outputId} with ${featureCount} features`);

	return true;
}
