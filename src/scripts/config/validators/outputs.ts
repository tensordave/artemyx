/**
 * Output config validation.
 */

import { VALID_OUTPUT_FORMATS } from '../parser';
import type { OutputFormat } from '../types';

/**
 * Validate PMTiles-specific output params.
 */
function validatePMTilesParams(params: Record<string, unknown>, prefix: string): string[] {
	const errors: string[] = [];

	// Optional: minzoom (integer 0-22)
	if ('minzoom' in params && params.minzoom !== undefined) {
		if (typeof params.minzoom !== 'number' || !Number.isInteger(params.minzoom)) {
			errors.push(`${prefix}.params.minzoom: must be an integer`);
		} else if (params.minzoom < 0 || params.minzoom > 22) {
			errors.push(`${prefix}.params.minzoom: must be between 0 and 22`);
		}
	}

	// Optional: maxzoom (integer 0-22)
	if ('maxzoom' in params && params.maxzoom !== undefined) {
		if (typeof params.maxzoom !== 'number' || !Number.isInteger(params.maxzoom)) {
			errors.push(`${prefix}.params.maxzoom: must be an integer`);
		} else if (params.maxzoom < 0 || params.maxzoom > 22) {
			errors.push(`${prefix}.params.maxzoom: must be between 0 and 22`);
		}
	}

	// Cross-field: minzoom <= maxzoom
	if (typeof params.minzoom === 'number' && typeof params.maxzoom === 'number'
		&& Number.isInteger(params.minzoom) && Number.isInteger(params.maxzoom)
		&& params.minzoom > params.maxzoom) {
		errors.push(`${prefix}.params: minzoom (${params.minzoom}) must not exceed maxzoom (${params.maxzoom})`);
	}

	// Optional: layerName (non-empty string)
	if ('layerName' in params && params.layerName !== undefined) {
		if (typeof params.layerName !== 'string' || params.layerName.trim() === '') {
			errors.push(`${prefix}.params.layerName: must be a non-empty string`);
		}
	}

	// Optional: bbox ([west, south, east, north])
	if ('bbox' in params && params.bbox !== undefined) {
		if (!Array.isArray(params.bbox) || params.bbox.length !== 4 || !params.bbox.every(v => typeof v === 'number')) {
			errors.push(`${prefix}.params.bbox: must be an array of 4 numbers [west, south, east, north]`);
		} else {
			const [west, south, east, north] = params.bbox as number[];
			if (west >= east) errors.push(`${prefix}.params.bbox: west (${west}) must be less than east (${east})`);
			if (south >= north) errors.push(`${prefix}.params.bbox: south (${south}) must be less than north (${north})`);
		}
	}

	// Optional: layers (non-empty array of non-empty strings)
	if ('layers' in params && params.layers !== undefined) {
		if (!Array.isArray(params.layers) || params.layers.length === 0) {
			errors.push(`${prefix}.params.layers: must be a non-empty array of strings`);
		} else if (!params.layers.every(v => typeof v === 'string' && v.trim() !== '')) {
			errors.push(`${prefix}.params.layers: all entries must be non-empty strings`);
		}
	}

	// Optional: extractZoom (integer 0-22, required when source is PMTiles)
	if ('extractZoom' in params && params.extractZoom !== undefined) {
		if (typeof params.extractZoom !== 'number' || !Number.isInteger(params.extractZoom)) {
			errors.push(`${prefix}.params.extractZoom: must be an integer`);
		} else if (params.extractZoom < 0 || params.extractZoom > 22) {
			errors.push(`${prefix}.params.extractZoom: must be between 0 and 22`);
		}
	}

	return errors;
}

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

	// Optional: params (only valid for pmtiles format)
	if ('params' in o && o.params !== undefined) {
		if (o.format !== 'pmtiles') {
			errors.push(`${prefix}.params: params are only valid for pmtiles format`);
		} else if (typeof o.params !== 'object' || o.params === null || Array.isArray(o.params)) {
			errors.push(`${prefix}.params: must be an object`);
		} else {
			errors.push(...validatePMTilesParams(o.params as Record<string, unknown>, prefix));
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

	// Validate source references, PMTiles rejection, and extraction requirements
	outputs.forEach((output, index) => {
		const o = output as Record<string, unknown>;
		if (typeof o?.source === 'string' && o.source.trim() !== '') {
			if (!validSourceIds.has(o.source)) {
				errors.push(`outputs[${index}].source: '${o.source}' does not reference a valid dataset or operation output`);
			}
			if (pmtilesDatasetIds.has(o.source) && o.format !== 'pmtiles') {
				errors.push(`outputs[${index}].source: '${o.source}' is a PMTiles dataset (no feature data in DuckDB for export)`);
			}
			// PMTiles extraction requires extractZoom and bbox
			if (pmtilesDatasetIds.has(o.source) && o.format === 'pmtiles') {
				const params = o.params as Record<string, unknown> | undefined;
				if (!params || params.extractZoom === undefined) {
					errors.push(`outputs[${index}].params.extractZoom: required when source is a PMTiles dataset`);
				}
				if (!params || params.bbox === undefined) {
					errors.push(`outputs[${index}].params.bbox: required when source is a PMTiles dataset (cannot extract full archive)`);
				}
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
