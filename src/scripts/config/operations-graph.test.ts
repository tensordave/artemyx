/**
 * Unit tests for operations-graph.ts
 * Tests dependency graph building, validation, and topological sort.
 */

import { describe, it, expect } from 'vitest';
import {
	buildDependencyGraph,
	validateInputReferences,
	topologicalSort,
	createExecutionPlan,
} from './operations-graph';
import type { OperationConfig, UnaryOperation, BinaryOperation } from './types';

// Helper to create unary operations (buffer, centroid)
function unary(
	type: 'buffer' | 'centroid',
	input: string,
	output: string,
	params?: Record<string, unknown>
): UnaryOperation {
	return { type, input, output, params };
}

// Helper to create binary operations (intersection, union, etc.)
function binary(
	type: 'intersection' | 'union' | 'difference' | 'contains',
	inputs: string[],
	output: string,
	params?: Record<string, unknown>
): BinaryOperation {
	return { type, inputs, output, params };
}

describe('buildDependencyGraph', () => {
	it('should include all dataset IDs as nodes', () => {
		const graph = buildDependencyGraph(['a', 'b', 'c'], []);

		expect(graph.nodes.has('a')).toBe(true);
		expect(graph.nodes.has('b')).toBe(true);
		expect(graph.nodes.has('c')).toBe(true);
		expect(graph.datasetIds.size).toBe(3);
	});

	it('should add operation outputs as nodes', () => {
		const ops: OperationConfig[] = [unary('buffer', 'a', 'a_buffered')];

		const graph = buildDependencyGraph(['a'], ops);

		expect(graph.nodes.has('a')).toBe(true);
		expect(graph.nodes.has('a_buffered')).toBe(true);
	});

	it('should create edges from output to inputs', () => {
		const ops: OperationConfig[] = [binary('intersection', ['a', 'b'], 'a_and_b')];

		const graph = buildDependencyGraph(['a', 'b'], ops);

		expect(graph.edges.get('a_and_b')).toEqual(['a', 'b']);
	});
});

describe('validateInputReferences', () => {
	it('should return no errors when all inputs exist', () => {
		const ops: OperationConfig[] = [
			unary('buffer', 'transit', 'transit_500m'),
			binary('intersection', ['parcels', 'transit_500m'], 'parcels_near_transit'),
		];
		const graph = buildDependencyGraph(['transit', 'parcels'], ops);

		const errors = validateInputReferences(graph, ops);

		expect(errors).toEqual([]);
	});

	it('should return error for unknown input', () => {
		const ops: OperationConfig[] = [unary('buffer', 'nonexistent', 'output')];
		const graph = buildDependencyGraph(['a', 'b'], ops);

		const errors = validateInputReferences(graph, ops);

		expect(errors.length).toBe(1);
		expect(errors[0]).toContain("unknown input 'nonexistent'");
	});

	it('should return multiple errors for multiple unknown inputs', () => {
		const ops: OperationConfig[] = [binary('intersection', ['foo', 'bar'], 'output')];
		const graph = buildDependencyGraph(['a'], ops);

		const errors = validateInputReferences(graph, ops);

		expect(errors.length).toBe(2);
		expect(errors[0]).toContain("unknown input 'foo'");
		expect(errors[1]).toContain("unknown input 'bar'");
	});
});

describe('topologicalSort', () => {
	it('should handle linear chain: A → B → C', () => {
		// Dataset 'a', buffer to 'b', buffer again to 'c'
		const ops: OperationConfig[] = [
			unary('buffer', 'a', 'b'),
			unary('buffer', 'b', 'c'),
		];
		const graph = buildDependencyGraph(['a'], ops);

		const result = topologicalSort(graph, ops);

		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
		expect(result.order.map((op) => op.output)).toEqual(['b', 'c']);
	});

	it('should handle diamond dependency: A → B, A → C, B+C → D', () => {
		const ops: OperationConfig[] = [
			unary('buffer', 'a', 'b'),
			unary('centroid', 'a', 'c'),
			binary('intersection', ['b', 'c'], 'd'),
		];
		const graph = buildDependencyGraph(['a'], ops);

		const result = topologicalSort(graph, ops);

		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);

		// 'd' must come after both 'b' and 'c'
		const order = result.order.map((op) => op.output);
		expect(order.indexOf('d')).toBeGreaterThan(order.indexOf('b'));
		expect(order.indexOf('d')).toBeGreaterThan(order.indexOf('c'));
	});

	it('should handle parallel independent operations', () => {
		// Two operations with no dependencies on each other
		const ops: OperationConfig[] = [
			unary('buffer', 'a', 'a_buf'),
			unary('buffer', 'b', 'b_buf'),
		];
		const graph = buildDependencyGraph(['a', 'b'], ops);

		const result = topologicalSort(graph, ops);

		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
		expect(result.order.length).toBe(2);
	});

	it('should detect simple cycle: A → B → A', () => {
		// b depends on a_out, a_out depends on b (cycle)
		const ops: OperationConfig[] = [
			unary('buffer', 'b_out', 'a_out'),
			unary('buffer', 'a_out', 'b_out'),
		];
		const graph = buildDependencyGraph(['seed'], ops);

		const result = topologicalSort(graph, ops);

		expect(result.valid).toBe(false);
		expect(result.errors.length).toBe(1);
		expect(result.errors[0]).toContain('Circular dependency');
	});

	it('should detect longer cycle: A → B → C → A', () => {
		const ops: OperationConfig[] = [
			unary('buffer', 'c_out', 'a_out'),
			unary('buffer', 'a_out', 'b_out'),
			unary('buffer', 'b_out', 'c_out'),
		];
		const graph = buildDependencyGraph(['seed'], ops);

		const result = topologicalSort(graph, ops);

		expect(result.valid).toBe(false);
		expect(result.errors[0]).toContain('Circular dependency');
	});
});

describe('createExecutionPlan', () => {
	it('should return valid empty plan for no operations', () => {
		const result = createExecutionPlan(['a', 'b'], []);

		expect(result.valid).toBe(true);
		expect(result.order).toEqual([]);
		expect(result.errors).toEqual([]);
	});

	it('should fail fast on missing input references', () => {
		const ops: OperationConfig[] = [unary('buffer', 'nonexistent', 'output')];

		const result = createExecutionPlan(['a'], ops);

		expect(result.valid).toBe(false);
		expect(result.errors[0]).toContain("unknown input 'nonexistent'");
		expect(result.order).toEqual([]); // No partial results
	});

	it('should handle the README example: transit buffer + intersection', () => {
		// From README.md:
		// 1. buffer(transit) → transit_500m
		// 2. intersection(parcels, transit_500m) → parcels_near_transit
		const ops: OperationConfig[] = [
			unary('buffer', 'transit', 'transit_500m', { distance: 500, units: 'meters' }),
			binary('intersection', ['parcels', 'transit_500m'], 'parcels_near_transit'),
		];

		const result = createExecutionPlan(['transit', 'parcels'], ops);

		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);

		// Verify execution order
		const order = result.order.map((op) => op.output);
		expect(order).toEqual(['transit_500m', 'parcels_near_transit']);

		// Verify params are preserved
		expect(result.order[0].params).toEqual({ distance: 500, units: 'meters' });
	});

	it('should handle complex multi-step workflow', () => {
		// More complex scenario:
		// 1. buffer(transit) → transit_walkshed
		// 2. buffer(schools) → school_zones
		// 3. intersection(transit_walkshed, school_zones) → overlap
		// 4. intersection(parcels, overlap) → target_parcels
		const ops: OperationConfig[] = [
			unary('buffer', 'transit', 'transit_walkshed'),
			unary('buffer', 'schools', 'school_zones'),
			binary('intersection', ['transit_walkshed', 'school_zones'], 'overlap'),
			binary('intersection', ['parcels', 'overlap'], 'target_parcels'),
		];

		const result = createExecutionPlan(['transit', 'schools', 'parcels'], ops);

		expect(result.valid).toBe(true);

		const order = result.order.map((op) => op.output);

		// 'overlap' must come after both buffers
		expect(order.indexOf('overlap')).toBeGreaterThan(order.indexOf('transit_walkshed'));
		expect(order.indexOf('overlap')).toBeGreaterThan(order.indexOf('school_zones'));

		// 'target_parcels' must come after 'overlap'
		expect(order.indexOf('target_parcels')).toBeGreaterThan(order.indexOf('overlap'));
	});
});
