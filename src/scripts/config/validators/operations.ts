/**
 * Operation config validation (structure, params, duplicates, shadowing).
 */

import { validateHexColor, validateStyle } from './shared';
import { UNARY_OPERATIONS, BINARY_OPERATIONS, ALL_OPERATIONS } from '../parser';
import { VALID_DISTANCE_UNITS } from '../operations/unit-conversion';
import type { UnaryOperationType, BinaryOperationType } from '../types';

/** Valid structured attribute filter operators */
const VALID_ATTRIBUTE_OPERATORS = ['=', '!=', '>', '>=', '<', '<='];

/**
 * Validate buffer operation params.
 */
function validateBufferParams(params: Record<string, unknown>, prefix: string): string[] {
	const errors: string[] = [];

	// Required: distance (positive number)
	if (!('distance' in params)) {
		errors.push(`${prefix}.params: buffer operation requires 'distance'`);
	} else if (typeof params.distance !== 'number') {
		errors.push(`${prefix}.params.distance: must be a number`);
	} else if (params.distance <= 0) {
		errors.push(`${prefix}.params.distance: must be a positive number`);
	}

	// Required: units
	if (!('units' in params)) {
		errors.push(`${prefix}.params: buffer operation requires 'units'`);
	} else if (!VALID_DISTANCE_UNITS.includes(params.units as typeof VALID_DISTANCE_UNITS[number])) {
		errors.push(`${prefix}.params.units: must be one of: ${VALID_DISTANCE_UNITS.join(', ')}. Got '${params.units}'`);
	}

	// Optional: dissolve (boolean)
	if ('dissolve' in params && typeof params.dissolve !== 'boolean') {
		errors.push(`${prefix}.params.dissolve: must be a boolean`);
	}

	// Optional: quadSegs (positive integer, segments per quarter-circle)
	if ('quadSegs' in params) {
		if (typeof params.quadSegs !== 'number' || !Number.isInteger(params.quadSegs) || params.quadSegs < 1) {
			errors.push(`${prefix}.params.quadSegs: must be a positive integer`);
		}
	}

	return errors;
}

/**
 * Validate distance operation params.
 */
function validateDistanceParams(params: Record<string, unknown>, prefix: string): string[] {
	const errors: string[] = [];

	// Required: mode
	if (!('mode' in params)) {
		errors.push(`${prefix}.params: distance operation requires 'mode'`);
	} else if (params.mode !== 'filter' && params.mode !== 'annotate') {
		errors.push(`${prefix}.params.mode: must be 'filter' or 'annotate'`);
	}

	// Required: units
	if (!('units' in params)) {
		errors.push(`${prefix}.params: distance operation requires 'units'`);
	} else if (!VALID_DISTANCE_UNITS.includes(params.units as typeof VALID_DISTANCE_UNITS[number])) {
		errors.push(`${prefix}.params.units: must be one of: ${VALID_DISTANCE_UNITS.join(', ')}. Got '${params.units}'`);
	}

	// maxDistance: required and positive for filter mode, optional for annotate
	if (params.mode === 'filter') {
		if (!('maxDistance' in params)) {
			errors.push(`${prefix}.params: distance filter mode requires 'maxDistance'`);
		} else if (typeof params.maxDistance !== 'number') {
			errors.push(`${prefix}.params.maxDistance: must be a number`);
		} else if (params.maxDistance <= 0) {
			errors.push(`${prefix}.params.maxDistance: must be a positive number`);
		}
	} else if ('maxDistance' in params && params.maxDistance !== undefined) {
		if (typeof params.maxDistance !== 'number') {
			errors.push(`${prefix}.params.maxDistance: must be a number`);
		} else if (params.maxDistance <= 0) {
			errors.push(`${prefix}.params.maxDistance: must be a positive number`);
		}
	}

	return errors;
}

/**
 * Validate attribute operation params.
 * Enforces mutual exclusivity: structured (property/operator/value) OR raw `where`, not both.
 */
function validateAttributeParams(params: Record<string, unknown>, prefix: string): string[] {
	const errors: string[] = [];

	const hasStructured = 'property' in params || 'operator' in params || 'value' in params;
	const hasWhere = 'where' in params;

	if (hasStructured && hasWhere) {
		errors.push(`${prefix}.params: cannot use both structured filter (property/operator/value) and 'where' clause`);
		return errors;
	}

	if (!hasStructured && !hasWhere) {
		errors.push(`${prefix}.params: attribute operation requires either structured filter (property/value) or 'where' clause`);
		return errors;
	}

	if (hasWhere) {
		if (typeof params.where !== 'string' || params.where.trim() === '') {
			errors.push(`${prefix}.params.where: must be a non-empty string`);
		}
	} else {
		// Structured mode validation
		if (!('property' in params)) {
			errors.push(`${prefix}.params: structured filter requires 'property'`);
		} else if (typeof params.property !== 'string' || params.property.trim() === '') {
			errors.push(`${prefix}.params.property: must be a non-empty string`);
		}

		if (!('value' in params) || params.value === undefined) {
			errors.push(`${prefix}.params: structured filter requires 'value'`);
		} else if (typeof params.value !== 'string' && typeof params.value !== 'number') {
			errors.push(`${prefix}.params.value: must be a string or number`);
		}

		if ('operator' in params && params.operator !== undefined) {
			if (!VALID_ATTRIBUTE_OPERATORS.includes(params.operator as string)) {
				errors.push(`${prefix}.params.operator: must be one of: ${VALID_ATTRIBUTE_OPERATORS.join(', ')}. Got '${params.operator}'`);
			}
		}
	}

	return errors;
}

/**
 * Validate join operation params.
 */
function validateJoinParams(params: Record<string, unknown>, prefix: string): string[] {
	const errors: string[] = [];

	// Required: sourceKey (non-empty string)
	if (!('sourceKey' in params)) {
		errors.push(`${prefix}.params: join operation requires 'sourceKey'`);
	} else if (typeof params.sourceKey !== 'string' || params.sourceKey.trim() === '') {
		errors.push(`${prefix}.params.sourceKey: must be a non-empty string`);
	}

	// Required: targetKey (non-empty string)
	if (!('targetKey' in params)) {
		errors.push(`${prefix}.params: join operation requires 'targetKey'`);
	} else if (typeof params.targetKey !== 'string' || params.targetKey.trim() === '') {
		errors.push(`${prefix}.params.targetKey: must be a non-empty string`);
	}

	// Optional: mode ('inner' or 'left')
	if ('mode' in params && params.mode !== undefined) {
		if (params.mode !== 'inner' && params.mode !== 'left') {
			errors.push(`${prefix}.params.mode: must be 'inner' or 'left'`);
		}
	}

	return errors;
}

/**
 * Validate a single operation config entry.
 * Checks structure only - dependency graph validation happens separately.
 */
export function validateOperation(op: unknown, index: number): string[] {
	const errors: string[] = [];
	const prefix = `operations[${index}]`;

	if (typeof op !== 'object' || op === null) {
		return [`${prefix}: must be an object`];
	}

	const o = op as Record<string, unknown>;

	// Required: type (must be valid operation type)
	if (!('type' in o)) {
		errors.push(`${prefix}: missing required 'type'`);
	} else if (typeof o.type !== 'string') {
		errors.push(`${prefix}.type: must be a string`);
	} else if (!ALL_OPERATIONS.includes(o.type as typeof ALL_OPERATIONS[number])) {
		errors.push(`${prefix}.type: invalid operation type '${o.type}'. Valid types: ${ALL_OPERATIONS.join(', ')}`);
	}

	// Required: output (non-empty string)
	if (!('output' in o)) {
		errors.push(`${prefix}: missing required 'output'`);
	} else if (typeof o.output !== 'string' || o.output.trim() === '') {
		errors.push(`${prefix}.output: must be a non-empty string`);
	}

	// Validate input/inputs based on operation type
	const opType = o.type as string;
	const isUnary = UNARY_OPERATIONS.includes(opType as UnaryOperationType);
	const isBinary = BINARY_OPERATIONS.includes(opType as BinaryOperationType);

	if (isUnary) {
		// Unary operations require 'input' (single string)
		if (!('input' in o)) {
			errors.push(`${prefix}: unary operation '${opType}' requires 'input' field`);
		} else if (typeof o.input !== 'string' || o.input.trim() === '') {
			errors.push(`${prefix}.input: must be a non-empty string`);
		}
		// Warn if 'inputs' is also present (likely user error)
		if ('inputs' in o) {
			errors.push(`${prefix}: unary operation '${opType}' uses 'input', not 'inputs'`);
		}
	} else if (isBinary) {
		// Binary operations require 'inputs' (array of strings)
		if (!('inputs' in o)) {
			errors.push(`${prefix}: binary operation '${opType}' requires 'inputs' field`);
		} else if (!Array.isArray(o.inputs)) {
			errors.push(`${prefix}.inputs: must be an array`);
		} else if (o.inputs.length < 2) {
			errors.push(`${prefix}.inputs: binary operation requires at least 2 inputs`);
		} else {
			// Validate each input is a non-empty string
			o.inputs.forEach((inp, i) => {
				if (typeof inp !== 'string' || inp.trim() === '') {
					errors.push(`${prefix}.inputs[${i}]: must be a non-empty string`);
				}
			});
		}
		// Warn if 'input' is also present (likely user error)
		if ('input' in o) {
			errors.push(`${prefix}: binary operation '${opType}' uses 'inputs', not 'input'`);
		}
	}

	// Optional: name (string)
	if ('name' in o && o.name !== undefined) {
		if (typeof o.name !== 'string') {
			errors.push(`${prefix}.name: must be a string`);
		}
	}

	// Params: required for some operations, optional for others
	if (opType === 'attribute' && !('params' in o)) {
		errors.push(`${prefix}: attribute operation requires 'params' (structured filter or where clause)`);
	}
	if (opType === 'join' && !('params' in o)) {
		errors.push(`${prefix}: join operation requires 'params' (sourceKey, targetKey)`);
	}
	if ('params' in o && o.params !== undefined) {
		if (typeof o.params !== 'object' || o.params === null || Array.isArray(o.params)) {
			errors.push(`${prefix}.params: must be an object`);
		} else {
			// Validate operation-specific params
			if (opType === 'buffer') {
				errors.push(...validateBufferParams(o.params as Record<string, unknown>, prefix));
			} else if (opType === 'distance') {
				errors.push(...validateDistanceParams(o.params as Record<string, unknown>, prefix));
			} else if (opType === 'attribute') {
				errors.push(...validateAttributeParams(o.params as Record<string, unknown>, prefix));
			} else if (opType === 'join') {
				errors.push(...validateJoinParams(o.params as Record<string, unknown>, prefix));
			}
		}
	}

	// Optional: color (hex string, same validation as datasets)
	if ('color' in o && o.color !== undefined) {
		errors.push(...validateHexColor(o.color, `${prefix}.color`));
	}

	// Optional: style (object with numeric fields, same validation as datasets)
	if ('style' in o && o.style !== undefined) {
		errors.push(...validateStyle(o.style, `${prefix}.style`));
	}

	return errors;
}

/**
 * Validate the operations array if present.
 * Checks structure and duplicate outputs. Does NOT validate dependency graph.
 */
export function validateOperations(
	operations: unknown,
	datasetIds: Set<string>,
	pmtilesDatasetIds: Set<string> = new Set(),
): string[] {
	const errors: string[] = [];

	if (!Array.isArray(operations)) {
		return ["'operations' must be an array"];
	}

	if (operations.length === 0) {
		return []; // Empty array is valid (no operations to run)
	}

	// Collect output IDs and check for duplicates / shadowing
	const outputIds = new Set<string>();
	operations.forEach((op, index) => {
		const o = op as Record<string, unknown>;
		if (typeof o?.output === 'string') {
			// Check for duplicate output IDs
			if (outputIds.has(o.output)) {
				errors.push(`operations[${index}].output: duplicate output ID '${o.output}'`);
			}
			// Check if output shadows a dataset ID
			if (datasetIds.has(o.output)) {
				errors.push(`operations[${index}].output: '${o.output}' shadows existing dataset ID`);
			}
			outputIds.add(o.output);
		}
	});

	// Validate each operation
	operations.forEach((op, index) => {
		errors.push(...validateOperation(op, index));

		// Reject PMTiles datasets as operation inputs (no feature data in DuckDB)
		const o = op as Record<string, unknown>;
		if (typeof o?.input === 'string' && pmtilesDatasetIds.has(o.input)) {
			errors.push(
				`operations[${index}].input: '${o.input}' is a PMTiles dataset (no feature data for operations)`,
			);
		}
		if (Array.isArray(o?.inputs)) {
			o.inputs.forEach((inp, i) => {
				if (typeof inp === 'string' && pmtilesDatasetIds.has(inp)) {
					errors.push(
						`operations[${index}].inputs[${i}]: '${inp}' is a PMTiles dataset (no feature data for operations)`,
					);
				}
			});
		}
	});

	return errors;
}
