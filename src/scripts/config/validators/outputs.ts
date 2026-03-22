/**
 * Output config validation.
 */

import { VALID_OUTPUT_FORMATS } from '../parser';
import type { OutputFormat } from '../types';

/**
 * Validate a single output config entry.
 * Returns array of error messages (empty if valid).
 */
export function validateOutput(output: unknown, index: number): string[] {
	const errors: string[] = [];
	const prefix = `outputs[${index}]`;

	if (typeof output !== 'object' || output === null) {
		return [`${prefix}: must be an object`];
	}

	const o = output as Record<string, unknown>;

	// Required: source (non-empty string)
	if (!('source' in o)) {
		errors.push(`${prefix}: missing required 'source'`);
	} else if (typeof o.source !== 'string' || o.source.trim() === '') {
		errors.push(`${prefix}.source: must be a non-empty string`);
	}

	// Required: format (one of VALID_OUTPUT_FORMATS)
	if (!('format' in o)) {
		errors.push(`${prefix}: missing required 'format'`);
	} else if (typeof o.format !== 'string') {
		errors.push(`${prefix}.format: must be a string`);
	} else if (!VALID_OUTPUT_FORMATS.includes(o.format as OutputFormat)) {
		errors.push(`${prefix}.format: invalid output format '${o.format}'. Valid formats: ${VALID_OUTPUT_FORMATS.join(', ')}`);
	}

	// Optional: filename (non-empty string if present)
	if ('filename' in o && o.filename !== undefined) {
		if (typeof o.filename !== 'string' || o.filename.trim() === '') {
			errors.push(`${prefix}.filename: must be a non-empty string`);
		}
	}

	return errors;
}

/**
 * Validate the outputs array if present.
 * Checks structure, source references, PMTiles rejection, and duplicate filenames.
 */
export function validateOutputs(
	outputs: unknown,
	validSourceIds: Set<string>,
	pmtilesDatasetIds: Set<string>
): string[] {
	const errors: string[] = [];

	if (!Array.isArray(outputs)) {
		return ["'outputs' must be an array"];
	}

	if (outputs.length === 0) {
		return [];
	}

	// Validate each output structure
	outputs.forEach((output, index) => {
		errors.push(...validateOutput(output, index));
	});

	// Validate source references and PMTiles rejection
	outputs.forEach((output, index) => {
		const o = output as Record<string, unknown>;
		if (typeof o?.source === 'string' && o.source.trim() !== '') {
			if (!validSourceIds.has(o.source)) {
				errors.push(`outputs[${index}].source: '${o.source}' does not reference a valid dataset or operation output`);
			}
			if (pmtilesDatasetIds.has(o.source)) {
				errors.push(`outputs[${index}].source: '${o.source}' is a PMTiles dataset (no feature data in DuckDB for export)`);
			}
		}
	});

	// Check for duplicate filenames after defaults applied
	const resolvedFilenames = new Map<string, number>();
	outputs.forEach((output, index) => {
		const o = output as Record<string, unknown>;
		if (typeof o?.format !== 'string' || !VALID_OUTPUT_FORMATS.includes(o.format as OutputFormat)) return;
		const baseName = (typeof o.filename === 'string' && o.filename.trim() !== '')
			? o.filename
			: (typeof o.source === 'string' ? o.source : '');
		const fullName = `${baseName}.${o.format}`;
		if (resolvedFilenames.has(fullName)) {
			errors.push(`outputs[${index}]: duplicate filename '${fullName}' (conflicts with outputs[${resolvedFilenames.get(fullName)}])`);
		} else {
			resolvedFilenames.set(fullName, index);
		}
	});

	return errors;
}
