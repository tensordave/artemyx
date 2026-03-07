/**
 * Operation executor - orchestrates spatial operations defined in config.
 * Takes an ExecutionPlan and executes each operation in topological order.
 *
 * Individual operations are implemented in the operations/ directory.
 */

import type maplibregl from 'maplibre-gl';
import type { LayerToggleControl } from '../layer-control';
import type { Logger } from '../logger';
import type { ExecutionPlan } from './operations-graph';
import type { OperationConfig, LayerConfig } from './types';
import { isUnaryOperation, isBinaryOperation } from './types';
import { executeBuffer, executeIntersection, executeUnion, executeDifference, executeContains, executeDistance, executeCentroid, executeAttribute } from './operations';
import type { OperationContext } from './operations';
import { datasetExists, getDatasets } from '../db/datasets';
import { getFeaturesAsGeoJSON } from '../db/features';
import { addOperationResultToMap } from './operations/buffer';
import { parseStyleConfig } from './operations';
import { attachFeatureClickHandlers, attachFeatureHoverHandlers } from '../popup';

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
 * Execute a single operation based on its type.
 * Dispatches to the appropriate operation handler.
 */
async function executeOperation(
	op: OperationConfig,
	context: OperationContext
): Promise<boolean> {
	switch (op.type) {
		case 'buffer':
			if (!isUnaryOperation(op)) {
				throw new Error(`Buffer operation must have single 'input' field`);
			}
			return executeBuffer(op, context);

		case 'intersection':
			if (!isBinaryOperation(op)) {
				throw new Error(`Intersection operation must have 'inputs' array`);
			}
			return executeIntersection(op, context);

		case 'union':
			if (!isBinaryOperation(op)) {
				throw new Error(`Union operation must have 'inputs' array`);
			}
			return executeUnion(op, context);

		case 'difference':
			if (!isBinaryOperation(op)) {
				throw new Error(`Difference operation must have 'inputs' array`);
			}
			return executeDifference(op, context);

		case 'contains':
			if (!isBinaryOperation(op)) {
				throw new Error(`Contains operation must have 'inputs' array`);
			}
			return executeContains(op, context);

		case 'distance':
			if (!isBinaryOperation(op)) {
				throw new Error(`Distance operation must have 'inputs' array`);
			}
			return executeDistance(op, context);

		case 'centroid':
			if (!isUnaryOperation(op)) {
				throw new Error(`Centroid operation must have single 'input' field`);
			}
			return executeCentroid(op, context);

		case 'attribute':
			if (!isUnaryOperation(op)) {
				throw new Error(`Attribute operation must have single 'input' field`);
			}
			return executeAttribute(op, context);

		default: {
			const _exhaustive: never = op;
			throw new Error(`Unsupported operation type: ${(_exhaustive as OperationConfig).type}`);
		}
	}
}

/**
 * Execute all operations in an ExecutionPlan.
 * Operations run in topological order (dependencies first).
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

	// Build set of source IDs covered by explicit layer entries
	const coveredSources = new Set(layers?.map(l => l.source) ?? []);

	// Centralized popup/hover handler attachment for all operations
	const onLayersCreated = (layerIds: string[], label: string) => {
		const hoverPopup = attachFeatureHoverHandlers(map, layerIds, { label });
		attachFeatureClickHandlers(map, layerIds, hoverPopup);
	};

	for (const op of plan.order) {
		try {
			// OPFS restore: if output dataset already exists, render from persisted data
			if (await datasetExists(op.output)) {
				const geoJsonData = await getFeaturesAsGeoJSON(op.output);
				if (geoJsonData.features && geoJsonData.features.length > 0) {
					const allDatasets = await getDatasets();
					const meta = allDatasets.find((d: any) => d.id === op.output);
					const color = meta?.color || op.color || '#3388ff';
					const style = parseStyleConfig(op.style);

					const skipLayers = !!layers && coveredSources.has(op.output);
					const layerIds = addOperationResultToMap(map, op.output, color, style, geoJsonData, skipLayers);
					loadedDatasets.add(op.output);

					if (layerIds.length > 0) {
						onLayersCreated(layerIds, op.name || op.output);
					}

					layerToggleControl.refreshPanel();
					logger.progress(op.name || op.output, 'success', `Restored from session (${geoJsonData.features.length} features)`);
					result.executed++;
					continue;
				}
			}

			await executeOperation(op, { ...context, onLayersCreated });
			result.executed++;
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : 'Unknown error';
			result.errors.push(`${op.output}: ${errorMsg}`);
			result.failed++;
			logger.progress(op.name || op.output, 'error', errorMsg);
			// Continue with other operations (don't fail fast)
		}
	}

	// Summary
	const status = result.failed > 0 ? 'error' : 'success';
	const summaryParts: string[] = [];
	if (result.executed > 0) summaryParts.push(`${result.executed} executed`);
	if (result.failed > 0) summaryParts.push(`${result.failed} failed`);
	logger.progress('operations', status, summaryParts.join(', '));

	return result;
}
