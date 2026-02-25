/**
 * Operations dependency graph and execution planning.
 * Builds a DAG from datasets + operations, validates dependencies,
 * and determines execution order via topological sort.
 */

import type { OperationConfig } from './types';
import { getOperationInputs } from './types';

/**
 * Represents the dependency graph structure.
 * - nodes: all known IDs (datasets + operation outputs)
 * - edges: maps each output ID to the IDs it depends on
 */
export interface DependencyGraph {
	/** All node IDs (datasets are "source" nodes, operation outputs are computed) */
	nodes: Set<string>;
	/** Maps output ID -> input IDs it depends on */
	edges: Map<string, string[]>;
	/** Set of dataset IDs (source nodes with no dependencies) */
	datasetIds: Set<string>;
}

/**
 * Result of creating an execution plan.
 * Contains ordered operations and any validation errors.
 */
export interface ExecutionPlan {
	/** Operations in valid execution order (dependencies before dependents) */
	order: OperationConfig[];
	/** Whether the plan is valid (no errors) */
	valid: boolean;
	/** Validation errors (missing inputs, cycles, etc.) */
	errors: string[];
	/** Warnings (non-fatal issues) */
	warnings: string[];
}

/**
 * Build a dependency graph from datasets and operations.
 *
 * @param datasetIds - IDs of datasets (source nodes)
 * @param operations - Operation configs to analyze
 * @returns DependencyGraph with nodes and edges
 */
export function buildDependencyGraph(
	datasetIds: string[],
	operations: OperationConfig[]
): DependencyGraph {
	const nodes = new Set<string>(datasetIds);
	const edges = new Map<string, string[]>();
	const datasetIdSet = new Set<string>(datasetIds);

	// Add each operation's output as a node, with edges to its inputs
	for (const op of operations) {
		nodes.add(op.output);
		edges.set(op.output, getOperationInputs(op));
	}

	return { nodes, edges, datasetIds: datasetIdSet };
}

/**
 * Validate that all operation inputs reference valid sources.
 * A valid source is either a dataset ID or a previous operation's output.
 *
 * @param graph - The dependency graph
 * @param operations - Operations to validate
 * @returns Array of error messages (empty if all valid)
 */
export function validateInputReferences(
	graph: DependencyGraph,
	operations: OperationConfig[]
): string[] {
	const errors: string[] = [];

	for (const op of operations) {
		const inputs = getOperationInputs(op);
		for (const input of inputs) {
			if (!graph.nodes.has(input)) {
				errors.push(
					`Operation '${op.output}': unknown input '${input}'. ` +
						`Must be a dataset ID or previous operation output.`
				);
			}
		}
	}

	return errors;
}

/**
 * Topologically sort operations using Kahn's algorithm.
 * Returns operations in execution order (dependencies before dependents).
 * Detects cycles and returns errors if found.
 *
 * @param graph - The dependency graph
 * @param operations - Operations to sort
 * @returns ExecutionPlan with ordered operations or errors
 */
export function topologicalSort(
	graph: DependencyGraph,
	operations: OperationConfig[]
): ExecutionPlan {
	const errors: string[] = [];
	const warnings: string[] = [];

	// Build a map from output ID to operation for quick lookup
	const opByOutput = new Map<string, OperationConfig>();
	for (const op of operations) {
		opByOutput.set(op.output, op);
	}

	// Calculate in-degree (number of dependencies) for each operation output
	// Datasets have in-degree 0 (they're source nodes)
	const inDegree = new Map<string, number>();

	// Initialize all nodes with 0
	for (const node of graph.nodes) {
		inDegree.set(node, 0);
	}

	// Count incoming edges for operation outputs
	for (const op of operations) {
		const inputs = getOperationInputs(op);
		// Only count dependencies that are themselves operation outputs (not datasets)
		// Actually, we need to count ALL dependencies for the algorithm to work,
		// but datasets will always be "processed" first since they have no deps
		let depCount = 0;
		for (const input of inputs) {
			// Only count if the input is an operation output (has edges)
			if (graph.edges.has(input)) {
				depCount++;
			}
		}
		inDegree.set(op.output, depCount);
	}

	// Start with nodes that have zero in-degree
	// This includes all datasets and any operations with only dataset inputs
	const queue: string[] = [];
	for (const [node, degree] of inDegree) {
		if (degree === 0) {
			queue.push(node);
		}
	}

	// Process nodes in topological order
	const sorted: OperationConfig[] = [];
	const processed = new Set<string>();

	while (queue.length > 0) {
		const current = queue.shift()!;
		processed.add(current);

		// If this is an operation output, add it to sorted list
		const op = opByOutput.get(current);
		if (op) {
			sorted.push(op);
		}

		// Decrement in-degree for all operations that depend on this node
		// Only decrement if current is an operation output (not a dataset)
		// because we excluded dataset dependencies from the initial count
		if (graph.edges.has(current)) {
			for (const dependentOp of operations) {
				const inputs = getOperationInputs(dependentOp);
				if (inputs.includes(current)) {
					const newDegree = inDegree.get(dependentOp.output)! - 1;
					inDegree.set(dependentOp.output, newDegree);
					if (newDegree === 0) {
						queue.push(dependentOp.output);
					}
				}
			}
		}
	}

	// Check for cycles: if we didn't process all operations, there's a cycle
	if (sorted.length !== operations.length) {
		// Find which operations are in the cycle
		const inCycle = operations.filter((op) => !processed.has(op.output));
		const cycleOutputs = inCycle.map((op) => op.output);
		errors.push(
			`Circular dependency detected involving: ${cycleOutputs.join(', ')}. ` +
				`Operations cannot depend on each other in a cycle.`
		);
	}

	return {
		order: sorted,
		valid: errors.length === 0,
		errors,
		warnings,
	};
}

/**
 * Create an execution plan for operations.
 * This is the main entry point - validates and sorts in one call.
 *
 * @param datasetIds - IDs of available datasets
 * @param operations - Operations to plan
 * @returns ExecutionPlan with ordered operations, validity, and any errors
 */
export function createExecutionPlan(
	datasetIds: string[],
	operations: OperationConfig[]
): ExecutionPlan {
	// Handle empty operations
	if (operations.length === 0) {
		return {
			order: [],
			valid: true,
			errors: [],
			warnings: [],
		};
	}

	// Build the dependency graph
	const graph = buildDependencyGraph(datasetIds, operations);

	// Validate all inputs reference valid sources
	const refErrors = validateInputReferences(graph, operations);
	if (refErrors.length > 0) {
		return {
			order: [],
			valid: false,
			errors: refErrors,
			warnings: [],
		};
	}

	// Topologically sort to get execution order
	return topologicalSort(graph, operations);
}
