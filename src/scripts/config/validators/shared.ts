/**
 * Shared validation helpers used across dataset, operation, and layer validators.
 */

/**
 * Validate a hex color string (e.g. '#3388ff').
 * Returns array of error messages (empty if valid).
 */
export function validateHexColor(value: unknown, prefix: string): string[] {
	if (typeof value !== 'string') {
		return [`${prefix}: must be a string`];
	}
	if (!/^#[0-9a-fA-F]{6}$/.test(value)) {
		return [`${prefix}: must be a valid hex color (e.g., #3388ff)`];
	}
	return [];
}

/**
 * Validate a style config object (fillOpacity, lineWidth, pointRadius).
 * Returns array of error messages (empty if valid).
 */
export function validateStyle(style: unknown, prefix: string): string[] {
	const errors: string[] = [];

	if (typeof style !== 'object' || style === null) {
		return [`${prefix}: must be an object`];
	}

	const s = style as Record<string, unknown>;
	if ('fillOpacity' in s && typeof s.fillOpacity !== 'number') {
		errors.push(`${prefix}.fillOpacity: must be a number`);
	} else if ('fillOpacity' in s && ((s.fillOpacity as number) < 0 || (s.fillOpacity as number) > 1)) {
		errors.push(`${prefix}.fillOpacity: must be between 0 and 1`);
	}
	if ('lineOpacity' in s && typeof s.lineOpacity !== 'number') {
		errors.push(`${prefix}.lineOpacity: must be a number`);
	} else if ('lineOpacity' in s && ((s.lineOpacity as number) < 0 || (s.lineOpacity as number) > 1)) {
		errors.push(`${prefix}.lineOpacity: must be between 0 and 1`);
	}
	if ('pointOpacity' in s && typeof s.pointOpacity !== 'number') {
		errors.push(`${prefix}.pointOpacity: must be a number`);
	} else if ('pointOpacity' in s && ((s.pointOpacity as number) < 0 || (s.pointOpacity as number) > 1)) {
		errors.push(`${prefix}.pointOpacity: must be between 0 and 1`);
	}
	if ('lineWidth' in s && typeof s.lineWidth !== 'number') {
		errors.push(`${prefix}.lineWidth: must be a number`);
	}
	if ('pointRadius' in s && typeof s.pointRadius !== 'number') {
		errors.push(`${prefix}.pointRadius: must be a number`);
	}

	return errors;
}

/**
 * Validate a CRS authority:code string (e.g. 'EPSG:27700', 'ESRI:102001').
 * Returns array of error messages (empty if valid).
 */
export function validateCrsString(value: unknown, prefix: string): string[] {
	if (typeof value !== 'string' || value.trim() === '') {
		return [`${prefix}: must be a non-empty string`];
	}
	if (!/^[A-Za-z]+:\S+$/.test(value.trim())) {
		return [`${prefix}: must be an authority:code string (e.g. 'EPSG:27700'). Got '${value}'`];
	}
	return [];
}
