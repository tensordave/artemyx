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

	// Label fields
	if ('labelField' in s && s.labelField !== undefined && s.labelField !== null) {
		if (typeof s.labelField !== 'string' || s.labelField.trim() === '') {
			errors.push(`${prefix}.labelField: must be a non-empty string or null`);
		}
	}
	if ('labelSize' in s && s.labelSize !== undefined) {
		if (typeof s.labelSize !== 'number') {
			errors.push(`${prefix}.labelSize: must be a number`);
		} else if (s.labelSize <= 0) {
			errors.push(`${prefix}.labelSize: must be a positive number`);
		}
	}
	if ('labelColor' in s && s.labelColor !== undefined) {
		errors.push(...validateHexColor(s.labelColor, `${prefix}.labelColor`));
	}
	if ('labelHaloColor' in s && s.labelHaloColor !== undefined) {
		errors.push(...validateHexColor(s.labelHaloColor, `${prefix}.labelHaloColor`));
	}
	if ('labelHaloWidth' in s && s.labelHaloWidth !== undefined) {
		if (typeof s.labelHaloWidth !== 'number') {
			errors.push(`${prefix}.labelHaloWidth: must be a number`);
		} else if (s.labelHaloWidth < 0) {
			errors.push(`${prefix}.labelHaloWidth: must be non-negative`);
		}
	}

	// Label zoom range
	if ('labelMinzoom' in s && s.labelMinzoom !== undefined) {
		if (typeof s.labelMinzoom !== 'number') {
			errors.push(`${prefix}.labelMinzoom: must be a number`);
		} else if (s.labelMinzoom < 0 || s.labelMinzoom > 24) {
			errors.push(`${prefix}.labelMinzoom: must be between 0 and 24`);
		}
	}
	if ('labelMaxzoom' in s && s.labelMaxzoom !== undefined) {
		if (typeof s.labelMaxzoom !== 'number') {
			errors.push(`${prefix}.labelMaxzoom: must be a number`);
		} else if (s.labelMaxzoom < 0 || s.labelMaxzoom > 24) {
			errors.push(`${prefix}.labelMaxzoom: must be between 0 and 24`);
		}
	}
	if (
		'labelMinzoom' in s && 'labelMaxzoom' in s &&
		typeof s.labelMinzoom === 'number' && typeof s.labelMaxzoom === 'number' &&
		s.labelMinzoom > s.labelMaxzoom
	) {
		errors.push(`${prefix}.labelMinzoom: must be less than or equal to labelMaxzoom`);
	}

	// Geometry zoom range
	if ('minzoom' in s && s.minzoom !== undefined) {
		if (typeof s.minzoom !== 'number') {
			errors.push(`${prefix}.minzoom: must be a number`);
		} else if (s.minzoom < 0 || s.minzoom > 24) {
			errors.push(`${prefix}.minzoom: must be between 0 and 24`);
		}
	}
	if ('maxzoom' in s && s.maxzoom !== undefined) {
		if (typeof s.maxzoom !== 'number') {
			errors.push(`${prefix}.maxzoom: must be a number`);
		} else if (s.maxzoom < 0 || s.maxzoom > 24) {
			errors.push(`${prefix}.maxzoom: must be between 0 and 24`);
		}
	}
	if (
		'minzoom' in s && 'maxzoom' in s &&
		typeof s.minzoom === 'number' && typeof s.maxzoom === 'number' &&
		s.minzoom > s.maxzoom
	) {
		errors.push(`${prefix}.minzoom: must be less than or equal to maxzoom`);
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
