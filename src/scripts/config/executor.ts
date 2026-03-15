/**
 * Operation executor - orchestrates spatial operations defined in config.
 * Takes an ExecutionPlan and executes each operation in topological order.
 *
 * Computation is delegated to the DuckDB Web Worker via executeOperationInWorker().
 * Rendering (MapLibre source/layer creation) happens on the main thread.
 */

import type maplibregl from 'maplibre-gl';
import type { LayerToggleControl } from '../controls/layer-control';
import type { Logger } from '../logger';
import type { ExecutionPlan } from './operations-graph';
import type { OperationConfig, LayerConfig } from './types';
import { datasetExists, getDatasetById, getFeaturesAsGeoJSON, executeOperationInWorker, clearOperations, saveOperationMetadata, vacuum } from '../db';
import { getOperationInputs } from './types';
import { addOperationResultToMap } from './operations/render';
import { shouldSkipAutoLayers } from './operations';
import { parseDatasetStyle } from '../data-actions/shared';
import { attachFeatureClickHandlers, attachFeatureHoverHandlers } from '../controls/popup';

/** Context needed for operation execution */
export interface ExecutionContext {
	map: maplibregl.Map;
	logger: Logger;
	layerToggleControl: LayerToggleControl;
	loadedDatasets: Set<string>;
	layers?: LayerConfig[];
}

/** Result of executing operations */
export interface ExecutionResult {
	executed: number;
	failed: number;
	errors: string[];
}

/**
 * Execute all operations in an ExecutionPlan.
 * Operations run in topological order (dependencies first).
 * Computation runs in the worker; rendering happens here on the main thread.
 */
export async function executeOperations(
	plan: ExecutionPlan,
	context: ExecutionContext
): Promise<ExecutionResult> {
	const result: ExecutionResult = {
		executed: 0,
		failed: 0,
		errors: []
	};

	if (!plan.valid) {
		result.errors.push(...plan.errors);
		result.failed = plan.order.length;
		return result;
	}

	if (plan.order.length === 0) {
		return result;
	}

	const { logger } = context;
	logger.progress('operations', 'processing', `Executing ${plan.order.length} operation(s)...`);

	const { map, layerToggleControl, loadedDatasets, layers } = context;

	// Reset operation metadata so exec_order starts clean for this run
	await clearOperations();

	// Centralized popup/hover handler attachment for all operations
	const onLayersCreated = (layerIds: string[], label: string) => {
		const hoverPopup = attachFeatureHoverHandlers(map, layerIds, { label });
		attachFeatureClickHandlers(map, layerIds, hoverPopup);
	};

	for (let i = 0; i < plan.order.length; i++) {
		const op = plan.order[i];
		try {
			// OPFS restore: if output dataset already exists, render from persisted data
			if (await datasetExists(op.output)) {
				let geoJsonData = await getFeaturesAsGeoJSON(op.output);
				if (geoJsonData.features && geoJsonData.features.length > 0) {
					const meta = await getDatasetById(op.output);
					const color = meta?.color || op.color || '#3388ff';
					const style = parseDatasetStyle(meta?.style);
					const featureCount = geoJsonData.features.length;

					const skipLayers = shouldSkipAutoLayers(op.output, layers);
					const layerIds = addOperationResultToMap(map, op.output, color, style, geoJsonData, skipLayers);
					// Release GeoJSON reference - MapLibre owns the data now
					geoJsonData = null as any;
					loadedDatasets.add(op.output);

					// Re-write operation metadata (clearOperations() wiped it at the start)
					const inputs = getOperationInputs(op);
					saveOperationMetadata(
						op.output, op.type, JSON.stringify(inputs),
						op.params ? JSON.stringify(op.params) : null, i
					);

					if (layerIds.length > 0) {
						onLayersCreated(layerIds, op.name || op.output);
					}

					layerToggleControl.refreshPanel();
					logger.progress(op.name || op.output, 'success', `Restored from session (${featureCount} features)`);
					result.executed++;
					continue;
				}
			}

			// Delegate computation to worker, render result on main thread
			const opResult = await executeOperationInWorker(op, i);

			const skipLayers = shouldSkipAutoLayers(opResult.outputId, layers);
			const layerIds = addOperationResultToMap(map, opResult.outputId, opResult.color, opResult.style, opResult.geoJson, skipLayers);
			// Release GeoJSON reference - MapLibre owns the data now
			opResult.geoJson = null as any;
			loadedDatasets.add(opResult.outputId);

			if (layerIds.length > 0) {
				onLayersCreated(layerIds, opResult.displayName);
			}

			layerToggleControl.refreshPanel();
			logger.progress(opResult.displayName, 'success', `Created ${opResult.featureCount} feature(s)`);
			result.executed++;
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : 'Unknown error';
			result.errors.push(`${op.output}: ${errorMsg}`);
			result.failed++;
			logger.progress(op.name || op.output, 'error', errorMsg);
			// Continue with other operations (don't fail fast)
		}
	}

	// Compact DuckDB storage after all operations complete.
	// Operations create intermediate data and overwrite outputs - vacuum reclaims freed pages.
	if (result.executed > 0) {
		await vacuum();
	}

	// Summary
	const status = result.failed > 0 ? 'error' : 'success';
	const summaryParts: string[] = [];
	if (result.executed > 0) summaryParts.push(`${result.executed} executed`);
	if (result.failed > 0) summaryParts.push(`${result.failed} failed`);
	logger.progress('operations', status, summaryParts.join(', '));

	return result;
}
