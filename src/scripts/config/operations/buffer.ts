/**
 * Buffer operation - creates a polygon around input features at a specified distance.
 * Reprojects to a local UTM CRS for geodetically accurate buffering, then back to WGS84.
 * Falls back to degree approximation for polar regions outside UTM coverage.
 */

import type { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import { getConnection } from '../../db/core';
import { DEFAULT_COLOR } from '../../db/datasets';
import { getFeaturesAsGeoJSON } from '../../db/features';
import type { UnaryOperation, BufferParams } from '../types';
import type { OperationContext, ComputeResult, ComputeCallbacks } from './index';
import { parseStyleConfig, shouldSkipAutoLayers, callbacksToLogger } from './index';
import { addOperationResultToMap } from './render';
import { toMeters, metersToDegreesAtLatitude, getProjectedCrs } from './unit-conversion';

/**
 * Pure SQL computation for buffer operation.
 * No MapLibre imports - can run in a Web Worker or headless CLI.
 */
export async function computeBuffer(
	connection: AsyncDuckDBConnection,
	op: UnaryOperation,
	callbacks?: ComputeCallbacks
): Promise<ComputeResult> {
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

	callbacks?.onProgress?.(`Buffering ${inputId} by ${params.distance}${units === 'meters' ? 'm' : ' ' + units}...`);

	// Derive projected CRS for geodetically accurate buffering
	const crs = await getProjectedCrs(connection, inputId, callbacksToLogger(callbacks));

	callbacks?.onInfo?.('Buffer', `${params.distance} ${units} (${distanceMeters}m), quadSegs=${quadSegs}, crs=${crs.epsg ?? 'degree-fallback'}`);

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
			// Chunked union: group buffered features into chunks of 500 before final union.
			// Reduces per-call GEOS sweep complexity and prevents TopologyException on dense datasets.
			// Retry with escalating simplification tolerance if TopologyException still occurs.
			const toleranceMultipliers = [0.05, 0.15, 0.40];
			let dissolved = false;
			for (let attempt = 0; attempt < toleranceMultipliers.length; attempt++) {
				const simplifyTolerance = distanceDegrees * toleranceMultipliers[attempt];
				if (attempt > 0) {
					callbacks?.onWarn?.('Buffer', `TopologyException on attempt ${attempt}, retrying dissolve with ${(toleranceMultipliers[attempt] * 100).toFixed(0)}% simplify tolerance`);
					const del = await connection.prepare('DELETE FROM features WHERE dataset_id = ?');
					try { await del.query(outputId); } finally { await del.close(); }
				}
				const stmt = await connection.prepare(`
					WITH numbered AS (
						SELECT
							ROW_NUMBER() OVER () AS rn,
							ST_MakeValid(ST_Simplify(ST_Buffer(geometry, ?, CAST(? AS INTEGER)), ?)) AS geom
						FROM features
						WHERE dataset_id = ?
						AND geometry IS NOT NULL
					),
					chunk_unions AS (
						SELECT ST_Union_Agg(geom) AS geom
						FROM numbered
						GROUP BY CAST(FLOOR((rn - 1) / 500) AS INTEGER)
					)
					INSERT INTO features (dataset_id, source_url, geometry, properties)
					SELECT ?, 'operation:buffer', ST_Union_Agg(ST_MakeValid(geom)), '{"dissolved": true}'
					FROM chunk_unions
				`);
				try {
					await stmt.query(distanceDegrees, quadSegs, simplifyTolerance, inputId, outputId);
					dissolved = true;
					break;
				} catch (err) {
					if (err instanceof Error && err.message.includes('TopologyException') && attempt < toleranceMultipliers.length - 1) {
						continue;
					}
					if (err instanceof Error && err.message.includes('TopologyException')) {
						break; // fall through to non-dissolve fallback
					}
					throw err;
				} finally {
					await stmt.close();
				}
			}
			if (!dissolved) {
				callbacks?.onWarn?.('Buffer', 'Could not dissolve after all retries: returning individual buffers');
				const del = await connection.prepare('DELETE FROM features WHERE dataset_id = ?');
				try { await del.query(outputId); } finally { await del.close(); }
				const fallback = await connection.prepare(`
					INSERT INTO features (dataset_id, source_url, geometry, properties)
					SELECT ?, 'operation:buffer', ST_Buffer(geometry, ?, CAST(? AS INTEGER)), properties
					FROM features WHERE dataset_id = ?
				`);
				try { await fallback.query(outputId, distanceDegrees, quadSegs, inputId); } finally { await fallback.close(); }
			}
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
		// Projected CRS dissolve: flip → reproject → buffer → simplify → make valid → chunk union → reproject back → flip
		// ST_FlipCoordinates needed because EPSG:4326 axis order is (lat,lng) but we store (lng,lat)
		// Chunked union (500 features/chunk) reduces per-call GEOS sweep complexity, preventing
		// TopologyException on dense datasets (e.g., 66k water mains) where adjacent buffer rings
		// have near-coincident edges. Retry with escalating simplification tolerance as safety net.
		callbacks?.onInfo?.('Buffer', 'Using chunked dissolve (500 features/chunk)');
		const toleranceMultipliers = [0.05, 0.15, 0.40];
		let dissolved = false;
		for (let attempt = 0; attempt < toleranceMultipliers.length; attempt++) {
			const simplifyTolerance = distanceMeters * toleranceMultipliers[attempt];
			if (attempt > 0) {
				callbacks?.onWarn?.('Buffer', `TopologyException on attempt ${attempt}, retrying dissolve with ${(toleranceMultipliers[attempt] * 100).toFixed(0)}% simplify tolerance`);
				const del = await connection.prepare('DELETE FROM features WHERE dataset_id = ?');
				try { await del.query(outputId); } finally { await del.close(); }
			}
			const stmt = await connection.prepare(`
				WITH numbered AS (
					SELECT
						ROW_NUMBER() OVER () AS rn,
						ST_MakeValid(ST_Simplify(
							ST_Buffer(ST_Transform(ST_FlipCoordinates(geometry), 'EPSG:4326', ?), ?, CAST(? AS INTEGER)),
							?
						)) AS geom
					FROM features
					WHERE dataset_id = ?
					AND geometry IS NOT NULL
				),
				chunk_unions AS (
					SELECT ST_Union_Agg(geom) AS geom
					FROM numbered
					GROUP BY CAST(FLOOR((rn - 1) / 500) AS INTEGER)
				)
				INSERT INTO features (dataset_id, source_url, geometry, properties)
				SELECT
					?,
					'operation:buffer',
					ST_FlipCoordinates(ST_Transform(ST_Union_Agg(ST_MakeValid(geom)), ?, 'EPSG:4326')),
					'{"dissolved": true}'
				FROM chunk_unions
			`);
			try {
				await stmt.query(crs.epsg, distanceMeters, quadSegs, simplifyTolerance, inputId, outputId, crs.epsg);
				dissolved = true;
				break;
			} catch (err) {
				if (err instanceof Error && err.message.includes('TopologyException') && attempt < toleranceMultipliers.length - 1) {
					continue;
				}
				if (err instanceof Error && err.message.includes('TopologyException')) {
					break; // fall through to non-dissolve fallback
				}
				throw err;
			} finally {
				await stmt.close();
			}
		}
		if (!dissolved) {
			callbacks?.onWarn?.('Buffer', 'Could not dissolve after all retries: returning individual buffers');
			const del = await connection.prepare('DELETE FROM features WHERE dataset_id = ?');
			try { await del.query(outputId); } finally { await del.close(); }
			const fallback = await connection.prepare(`
				INSERT INTO features (dataset_id, source_url, geometry, properties)
				SELECT
					?,
					'operation:buffer',
					ST_FlipCoordinates(ST_Transform(
						ST_Buffer(ST_Transform(ST_FlipCoordinates(geometry), 'EPSG:4326', ?), ?, CAST(? AS INTEGER)),
						?, 'EPSG:4326'
					)),
					properties
				FROM features WHERE dataset_id = ?
			`);
			try { await fallback.query(outputId, crs.epsg, distanceMeters, quadSegs, crs.epsg, inputId); } finally { await fallback.close(); }
		}
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
		callbacks?.onInfo?.('Buffer', `Result: ${featureCount} features, type=${debugRow.geom_type}, geojson length=${debugRow.geojson?.length || 0}`);
	}

	if (featureCount === 0) {
		throw new Error(`Buffer operation '${op.output}': produced no features`);
	}

	// Register dataset metadata
	const insertDataset = await connection.prepare(`
		INSERT INTO datasets (id, source_url, name, color, visible, feature_count, loaded_at, style)
		VALUES (?, 'operation:buffer', ?, ?, true, ?, CURRENT_TIMESTAMP, ?)
	`);
	await insertDataset.query(outputId, displayName, color, featureCount, JSON.stringify(style));
	await insertDataset.close();

	return { outputId, displayName, featureCount, color, style };
}

/**
 * Execute a buffer operation (compute + render).
 * Thin wrapper that calls computeBuffer then renders the result on the map.
 */
export async function executeBuffer(
	op: UnaryOperation,
	context: OperationContext
): Promise<boolean> {
	const { map, logger, layerToggleControl, loadedDatasets } = context;

	const connection = await getConnection();
	const result = await computeBuffer(connection, op, {
		onProgress: (msg) => logger.progress(op.name || op.output, 'processing', msg),
		onInfo: (tag, msg) => logger.info(tag, msg),
		onWarn: (tag, msg) => logger.warn(tag, msg),
	});

	// Query features as GeoJSON for map rendering
	const geoJsonData = await getFeaturesAsGeoJSON(result.outputId);

	if (!geoJsonData.features || geoJsonData.features.length === 0) {
		throw new Error(`Buffer operation '${op.output}': no features returned from query`);
	}

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

	const dissolve = (op.params as BufferParams | undefined)?.dissolve ?? false;
	const dissolveNote = dissolve ? ' (dissolved)' : '';
	logger.progress(result.displayName, 'success', `Created ${result.featureCount} feature(s)${dissolveNote}`);

	logger.info('Buffer', `Complete: ${result.outputId} with ${result.featureCount} features`);

	return true;
}
