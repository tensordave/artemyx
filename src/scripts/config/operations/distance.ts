/**
 * Distance operation - proximity queries between two datasets.
 * Reprojects to a local UTM CRS for geodetically accurate distance calculations,
 * then stores results in WGS84. Falls back to degree approximation for polar regions.
 *
 * Two modes:
 * - 'filter': Keep features from inputs[0] within maxDistance of any feature in inputs[1] (ST_DWithin)
 * - 'annotate': Enrich features from inputs[0] with dist_<unit> property - distance to nearest feature in inputs[1]
 *
 * Input ordering: inputs[0] is always the primary dataset (filtered/enriched),
 * inputs[1] is the proximity target.
 */

import { getConnection } from '../../db/core';
import { DEFAULT_COLOR } from '../../db/datasets';
import { getFeaturesAsGeoJSON } from '../../db/features';
import type { BinaryOperation, DistanceParams } from '../types';
import type { OperationContext } from './index';
import { parseStyleConfig, shouldSkipAutoLayers } from './index';
import { addOperationResultToMap } from './buffer';
import { toMeters, fromMeters, metersToDegreesAtLatitude, degreesToMetersAtLatitude, unitSuffix, getProjectedCrs } from './unit-conversion';

/**
 * Execute a distance operation.
 * inputs[0] = primary dataset (filtered or enriched)
 * inputs[1] = proximity target
 */
export async function executeDistance(
	op: BinaryOperation,
	context: OperationContext
): Promise<boolean> {
	const { map, progressControl, layerToggleControl, loadedDatasets } = context;
	const params = op.params as DistanceParams | undefined;

	// Validate inputs
	if (!op.inputs || op.inputs.length !== 2) {
		throw new Error(`Distance operation '${op.output}': requires exactly 2 inputs`);
	}

	// Validate params
	const mode = params?.mode ?? 'filter';
	if (mode !== 'filter' && mode !== 'annotate') {
		throw new Error(`Distance operation '${op.output}': mode must be 'filter' or 'annotate'`);
	}

	if (mode === 'filter' && (params?.maxDistance === undefined || params.maxDistance <= 0)) {
		throw new Error(`Distance operation '${op.output}': filter mode requires a positive maxDistance`);
	}

	const [inputA, inputB] = op.inputs;
	const outputId = op.output;
	const displayName = op.name || outputId;
	const color = op.color ?? DEFAULT_COLOR;
	const style = parseStyleConfig(op.style);
	const maxDistance = params?.maxDistance;
	const units = params?.units ?? 'meters';
	const suffix = unitSuffix(units);

	const modeLabel = mode === 'filter' ? `filtering within ${maxDistance} ${units}` : 'annotating nearest distance';
	progressControl.updateProgress(displayName, 'processing', `Distance: ${inputA} → ${inputB} (${modeLabel})...`);

	const connection = await getConnection();

	// Derive projected CRS for geodetically accurate distance calculations
	const crs = await getProjectedCrs(connection, inputA);

	// Delete existing output if present (allows re-running)
	const deleteFeatures = await connection.prepare('DELETE FROM features WHERE dataset_id = ?');
	await deleteFeatures.query(outputId);
	await deleteFeatures.close();

	const deleteDatasets = await connection.prepare('DELETE FROM datasets WHERE id = ?');
	await deleteDatasets.query(outputId);
	await deleteDatasets.close();

	if (mode === 'filter') {
		const maxDistMeters = toMeters(maxDistance!, units);

		if (crs.fallback) {
			// Polar fallback: degree approximation
			const distanceDegrees = metersToDegreesAtLatitude(maxDistMeters, crs.latitude);
			console.log(`[Distance] Filter (fallback): ${maxDistance} ${units} (${maxDistMeters}m) → ${distanceDegrees.toFixed(6)}° at lat ${crs.latitude.toFixed(2)}°`);

			const insertFiltered = await connection.prepare(`
				INSERT INTO features (dataset_id, source_url, geometry, properties)
				SELECT
					?,
					'operation:distance',
					a.geometry,
					a.properties
				FROM features a
				WHERE a.dataset_id = ?
				AND EXISTS (
					SELECT 1 FROM features b
					WHERE b.dataset_id = ?
					AND ST_DWithin(a.geometry, b.geometry, ?)
				)
			`);
			await insertFiltered.query(outputId, inputA, inputB, distanceDegrees);
			await insertFiltered.close();
		} else {
			// Projected CRS: ST_DWithin in meters
			// ST_FlipCoordinates needed because EPSG:4326 axis order is (lat,lng) but we store (lng,lat)
			console.log(`[Distance] Filter: ${maxDistance} ${units} (${maxDistMeters}m), crs=${crs.epsg}`);

			const insertFiltered = await connection.prepare(`
				INSERT INTO features (dataset_id, source_url, geometry, properties)
				SELECT
					?,
					'operation:distance',
					a.geometry,
					a.properties
				FROM features a
				WHERE a.dataset_id = ?
				AND EXISTS (
					SELECT 1 FROM features b
					WHERE b.dataset_id = ?
					AND ST_DWithin(
						ST_Transform(ST_FlipCoordinates(a.geometry), 'EPSG:4326', ?),
						ST_Transform(ST_FlipCoordinates(b.geometry), 'EPSG:4326', ?),
						?
					)
				)
			`);
			await insertFiltered.query(outputId, inputA, inputB, crs.epsg, crs.epsg, maxDistMeters);
			await insertFiltered.close();
		}
	} else {
		// Annotate mode: enrich A features with distance to nearest B feature
		const propName = `dist_${suffix}`;

		if (crs.fallback) {
			// Polar fallback: degree approximation with scale factor
			const metersPerDegree = degreesToMetersAtLatitude(1, crs.latitude);
			const unitsPerDegree = fromMeters(metersPerDegree, units);
			console.log(`[Distance] Annotate (fallback): scale factor ${unitsPerDegree.toFixed(4)} ${units}/° at lat ${crs.latitude.toFixed(2)}° (property: ${propName})`);

			const havingClause = maxDistance !== undefined
				? `HAVING min_dist_deg <= ${metersToDegreesAtLatitude(toMeters(maxDistance, units), crs.latitude)}`
				: '';

			const insertAnnotated = await connection.prepare(`
				INSERT INTO features (dataset_id, source_url, geometry, properties)
				SELECT
					?,
					'operation:distance',
					sub.geometry,
					json_merge_patch(
						sub.properties,
						json_object('${propName}', ROUND(sub.min_dist_deg * ?, 1))
					)
				FROM (
					SELECT
						a.geometry,
						a.properties,
						MIN(ST_Distance(a.geometry, b.geometry)) as min_dist_deg
					FROM features a
					CROSS JOIN features b
					WHERE a.dataset_id = ?
					AND b.dataset_id = ?
					AND a.geometry IS NOT NULL
					AND b.geometry IS NOT NULL
					GROUP BY a.rowid, a.geometry, a.properties
					${havingClause}
				) sub
			`);
			await insertAnnotated.query(outputId, unitsPerDegree, inputA, inputB);
			await insertAnnotated.close();
		} else {
			// Projected CRS: ST_Distance in meters, convert to output unit
			// ST_FlipCoordinates needed because EPSG:4326 axis order is (lat,lng) but we store (lng,lat)
			const unitDivisor = toMeters(1, units); // meters per output unit
			console.log(`[Distance] Annotate: crs=${crs.epsg}, output unit=${units} (property: ${propName})`);

			const havingClause = maxDistance !== undefined
				? `HAVING min_dist_m <= ${toMeters(maxDistance, units)}`
				: '';

			const insertAnnotated = await connection.prepare(`
				INSERT INTO features (dataset_id, source_url, geometry, properties)
				SELECT
					?,
					'operation:distance',
					sub.geometry,
					json_merge_patch(
						sub.properties,
						json_object('${propName}', ROUND(sub.min_dist_m / ?, 1))
					)
				FROM (
					SELECT
						a.geometry,
						a.properties,
						MIN(ST_Distance(
							ST_Transform(ST_FlipCoordinates(a.geometry), 'EPSG:4326', ?),
							ST_Transform(ST_FlipCoordinates(b.geometry), 'EPSG:4326', ?)
						)) as min_dist_m
					FROM features a
					CROSS JOIN features b
					WHERE a.dataset_id = ?
					AND b.dataset_id = ?
					AND a.geometry IS NOT NULL
					AND b.geometry IS NOT NULL
					GROUP BY a.rowid, a.geometry, a.properties
					${havingClause}
				) sub
			`);
			await insertAnnotated.query(outputId, unitDivisor, crs.epsg, crs.epsg, inputA, inputB);
			await insertAnnotated.close();
		}
	}

	// Get feature count
	const countStmt = await connection.prepare(`
		SELECT COUNT(*) as count FROM features WHERE dataset_id = ?
	`);
	const countResult = await countStmt.query(outputId);
	await countStmt.close();
	const featureCount = Number(countResult.toArray()[0].count);

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
		console.log(`[Distance] Result: ${featureCount} features, type=${debugRow.geom_type}, mode=${mode}`);
	}

	if (featureCount === 0) {
		console.log(`[Distance] Warning: ${inputA} → ${inputB} produced no features`);
		progressControl.updateProgress(displayName, 'success', `No features within distance`);
	}

	// Register dataset metadata
	const insertDataset = await connection.prepare(`
		INSERT INTO datasets (id, source_url, name, color, visible, feature_count, loaded_at, style)
		VALUES (?, 'operation:distance', ?, ?, true, ?, CURRENT_TIMESTAMP, ?)
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

	const distNote = maxDistance !== undefined ? ` (≤${maxDistance} ${units})` : '';
	progressControl.updateProgress(displayName, 'success', `${featureCount} feature(s) (${mode}${distNote})`);

	console.log(`[Distance] Complete: ${outputId} with ${featureCount} features`);

	return true;
}
