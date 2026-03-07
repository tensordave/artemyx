/**
 * Buffer operation - creates a polygon around input features at a specified distance.
 * Reprojects to a local UTM CRS for geodetically accurate buffering, then back to WGS84.
 * Falls back to degree approximation for polar regions outside UTM coverage.
 */

import type maplibregl from 'maplibre-gl';
import { getConnection } from '../../db/core';
import { DEFAULT_COLOR } from '../../db/datasets';
import type { StyleConfig } from '../../db/datasets';
import { getFeaturesAsGeoJSON } from '../../db/features';
import { getSourceId, addSource, removeDefaultLayers, addDefaultLayers } from '../../layers';
import type { UnaryOperation, BufferParams } from '../types';
import type { OperationContext } from './index';
import { parseStyleConfig, shouldSkipAutoLayers } from './index';
import { toMeters, metersToDegreesAtLatitude, getProjectedCrs } from './unit-conversion';

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
 * Reprojects input geometry to a local UTM CRS so ST_Buffer operates in meters,
 * then reprojects the result back to WGS84. Optionally dissolves with ST_Union_Agg.
 */
export async function executeBuffer(
	op: UnaryOperation,
	context: OperationContext
): Promise<boolean> {
	const { map, logger, layerToggleControl, loadedDatasets } = context;
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
	const displayName = op.name || outputId;
	const inputId = op.input;
	const color = op.color ?? DEFAULT_COLOR;
	const style = parseStyleConfig(op.style);

	logger.progress(displayName, 'processing', `Buffering ${inputId} by ${params.distance}${units === 'meters' ? 'm' : ' ' + units}...`);

	const connection = await getConnection();

	// Derive projected CRS for geodetically accurate buffering
	const crs = await getProjectedCrs(connection, inputId, logger);

	logger.info('Buffer', `${params.distance} ${units} (${distanceMeters}m), quadSegs=${quadSegs}, crs=${crs.epsg ?? 'degree-fallback'}`);

	// Delete existing output if present (allows re-running)
	const deleteFeatures = await connection.prepare('DELETE FROM features WHERE dataset_id = ?');
	await deleteFeatures.query(outputId);
	await deleteFeatures.close();

	const deleteDatasets = await connection.prepare('DELETE FROM datasets WHERE id = ?');
	await deleteDatasets.query(outputId);
	await deleteDatasets.close();

	if (crs.fallback) {
		// Polar fallback: use degree approximation (same as pre-v0.4.2 behavior)
		const distanceDegrees = metersToDegreesAtLatitude(distanceMeters, crs.latitude);

		if (dissolve) {
			const simplifyTolerance = distanceDegrees * 0.05;
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
	} else if (dissolve) {
		// Projected CRS dissolve: flip → reproject → buffer → simplify → union → reproject back → flip
		// ST_FlipCoordinates needed because EPSG:4326 axis order is (lat,lng) but we store (lng,lat)
		// ST_Simplify (5% of buffer distance) reduces vertices, then ST_Buffer(geom, 0)
		// repairs topology to prevent TopologyException during union.
		const simplifyTolerance = distanceMeters * 0.05;
		const insertDissolved = await connection.prepare(`
			INSERT INTO features (dataset_id, source_url, geometry, properties)
			SELECT
				?,
				'operation:buffer',
				ST_FlipCoordinates(ST_Transform(
					ST_Union_Agg(ST_Buffer(ST_Simplify(
						ST_Buffer(ST_Transform(ST_FlipCoordinates(geometry), 'EPSG:4326', ?), ?, CAST(? AS INTEGER)),
						?
					), 0)),
					?, 'EPSG:4326'
				)),
				'{"dissolved": true}'
			FROM features
			WHERE dataset_id = ?
			AND geometry IS NOT NULL
		`);
		await insertDissolved.query(outputId, crs.epsg, distanceMeters, quadSegs, simplifyTolerance, crs.epsg, inputId);
		await insertDissolved.close();
	} else {
		// Projected CRS: flip → reproject → buffer → reproject back → flip
		// ST_FlipCoordinates needed because EPSG:4326 axis order is (lat,lng) but we store (lng,lat)
		const insertBuffered = await connection.prepare(`
			INSERT INTO features (dataset_id, source_url, geometry, properties)
			SELECT
				?,
				'operation:buffer',
				ST_FlipCoordinates(ST_Transform(
					ST_Buffer(ST_Transform(ST_FlipCoordinates(geometry), 'EPSG:4326', ?), ?, CAST(? AS INTEGER)),
					?, 'EPSG:4326'
				)),
				properties
			FROM features
			WHERE dataset_id = ?
		`);
		await insertBuffered.query(outputId, crs.epsg, distanceMeters, quadSegs, crs.epsg, inputId);
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
		logger.info('Buffer', `Result: ${featureCount} features, type=${debugRow.geom_type}, geojson length=${debugRow.geojson?.length || 0}`);
	}

	if (featureCount === 0) {
		throw new Error(`Buffer operation '${op.output}': produced no features`);
	}

	// Register dataset metadata
	const insertDataset = await connection.prepare(`
		INSERT INTO datasets (id, source_url, name, color, visible, feature_count, loaded_at, style)
		VALUES (?, 'operation:buffer', ?, ?, true, ?, CURRENT_TIMESTAMP, ?)
	`);
	await insertDataset.query(outputId, op.name || outputId, color, featureCount, JSON.stringify(style));
	await insertDataset.close();

	// Query features as GeoJSON for map rendering
	const geoJsonData = await getFeaturesAsGeoJSON(outputId);

	if (!geoJsonData.features || geoJsonData.features.length === 0) {
		throw new Error(`Buffer operation '${op.output}': no features returned from query`);
	}

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

	const dissolveNote = dissolve ? ' (dissolved)' : '';
	logger.progress(displayName, 'success', `Created ${featureCount} feature(s)${dissolveNote}`);

	logger.info('Buffer', `Complete: ${outputId} with ${featureCount} features`);

	return true;
}
