/**
 * Dataset config validation.
 */

import { validateHexColor, validateStyle, validateCrsString } from './shared';
import { VALID_FORMATS } from '../parser';
import type { ConfigFormat } from '../../loaders/types';

/**
 * Validate a single dataset config entry.
 * Returns array of error messages (empty if valid).
 */
export function validateDataset(dataset: unknown, index: number): string[] {
	const errors: string[] = [];
	const prefix = `datasets[${index}]`;

	if (typeof dataset !== 'object' || dataset === null) {
		return [`${prefix}: must be an object`];
	}

	const d = dataset as Record<string, unknown>;

	// Required: id (string)
	if (!('id' in d)) {
		errors.push(`${prefix}: missing required 'id'`);
	} else if (typeof d.id !== 'string' || d.id.trim() === '') {
		errors.push(`${prefix}.id: must be a non-empty string`);
	}

	// Required: url (string, valid URL format; empty string allowed for file-upload placeholders;
	// relative paths like ./data/file.geojson allowed for viewer config exports)
	if (!('url' in d)) {
		errors.push(`${prefix}: missing required 'url'`);
	} else if (typeof d.url !== 'string') {
		errors.push(`${prefix}.url: must be a string`);
	} else if (d.url !== '' && !d.url.startsWith('./') && !d.url.startsWith('../')) {
		try {
			const parsedUrl = new URL(d.url);
			if (parsedUrl.protocol !== 'https:') {
				errors.push(`${prefix}.url: must use HTTPS protocol`);
			}
		} catch {
			errors.push(`${prefix}.url: invalid URL format`);
		}
	}

	// Optional: name (string)
	if ('name' in d && d.name !== undefined) {
		if (typeof d.name !== 'string') {
			errors.push(`${prefix}.name: must be a string`);
		}
	}

	// Optional: color (hex string)
	if ('color' in d && d.color !== undefined) {
		errors.push(...validateHexColor(d.color, `${prefix}.color`));
	}

	// Optional: style (object with numeric fields)
	if ('style' in d && d.style !== undefined) {
		errors.push(...validateStyle(d.style, `${prefix}.style`));
	}

	// Optional: hidden (boolean)
	if ('hidden' in d && d.hidden !== undefined) {
		if (typeof d.hidden !== 'boolean') {
			errors.push(`${prefix}.hidden: must be a boolean`);
		}
	}

	// Optional: visible (boolean, defaults to true)
	if ('visible' in d && d.visible !== undefined) {
		if (typeof d.visible !== 'boolean') {
			errors.push(`${prefix}.visible: must be a boolean`);
		}
	}

	// Optional: fitBounds (boolean, defaults to true)
	if ('fitBounds' in d && d.fitBounds !== undefined) {
		if (typeof d.fitBounds !== 'boolean') {
			errors.push(`${prefix}.fitBounds: must be a boolean`);
		}
	}

	// Optional: format (must be a valid config format)
	if ('format' in d && d.format !== undefined) {
		if (typeof d.format !== 'string') {
			errors.push(`${prefix}.format: must be a string`);
		} else if (!VALID_FORMATS.includes(d.format as ConfigFormat)) {
			errors.push(`${prefix}.format: must be one of: ${VALID_FORMATS.join(', ')}. Got '${d.format}'`);
		}
	}

	// Optional: latColumn (string, only meaningful for csv/geoparquet)
	if ('latColumn' in d && d.latColumn !== undefined) {
		if (typeof d.latColumn !== 'string' || d.latColumn.trim() === '') {
			errors.push(`${prefix}.latColumn: must be a non-empty string`);
		}
	}

	// Optional: lngColumn (string, only meaningful for csv/geoparquet)
	if ('lngColumn' in d && d.lngColumn !== undefined) {
		if (typeof d.lngColumn !== 'string' || d.lngColumn.trim() === '') {
			errors.push(`${prefix}.lngColumn: must be a non-empty string`);
		}
	}

	// Optional: geoColumn (string, combined "lat, lng" column; mutually exclusive with latColumn/lngColumn)
	if ('geoColumn' in d && d.geoColumn !== undefined) {
		if (typeof d.geoColumn !== 'string' || d.geoColumn.trim() === '') {
			errors.push(`${prefix}.geoColumn: must be a non-empty string`);
		}
		if (('latColumn' in d && d.latColumn !== undefined) || ('lngColumn' in d && d.lngColumn !== undefined)) {
			errors.push(`${prefix}: geoColumn is mutually exclusive with latColumn/lngColumn`);
		}
	}

	// Optional: paginate (boolean or { maxPages?: number })
	if ('paginate' in d && d.paginate !== undefined) {
		if (typeof d.paginate === 'boolean') {
			// valid
		} else if (typeof d.paginate === 'object' && d.paginate !== null && !Array.isArray(d.paginate)) {
			const pag = d.paginate as Record<string, unknown>;
			if ('maxPages' in pag && pag.maxPages !== undefined) {
				if (typeof pag.maxPages !== 'number' || !Number.isInteger(pag.maxPages) || pag.maxPages < 1) {
					errors.push(`${prefix}.paginate.maxPages: must be a positive integer`);
				}
			}
		} else {
			errors.push(`${prefix}.paginate: must be a boolean or an object with optional maxPages`);
		}
	}

	// Optional: crs (authority:code string for explicit CRS override)
	if ('crs' in d && d.crs !== undefined) {
		errors.push(...validateCrsString(d.crs, `${prefix}.crs`));
	}

	// Optional: sourceFile (string, original filename for file-uploaded datasets)
	if ('sourceFile' in d && d.sourceFile !== undefined) {
		if (typeof d.sourceFile !== 'string' || d.sourceFile.trim() === '') {
			errors.push(`${prefix}.sourceFile: must be a non-empty string`);
		}
	}

	return errors;
}

/**
 * Validate the datasets array if present.
 */
export function validateDatasets(datasets: unknown): string[] {
	const errors: string[] = [];

	if (!Array.isArray(datasets)) {
		return ["'datasets' must be an array"];
	}

	if (datasets.length === 0) {
		return []; // Empty array is valid (no datasets to load)
	}

	// Check for duplicate IDs
	const ids = new Set<string>();
	datasets.forEach((dataset, index) => {
		const d = dataset as Record<string, unknown>;
		if (typeof d?.id === 'string') {
			if (ids.has(d.id)) {
				errors.push(`datasets[${index}].id: duplicate ID '${d.id}'`);
			}
			ids.add(d.id);
		}
	});

	// Validate each dataset
	datasets.forEach((dataset, index) => {
		errors.push(...validateDataset(dataset, index));
	});

	return errors;
}
