/**
 * Layer config validation (structure, paint/layout spec, source references).
 */

import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import { VALID_LAYER_TYPES } from '../parser';
import type { LayerType } from '../types';

/**
 * Validate paint/layout properties against the MapLibre style spec.
 * Uses @maplibre/maplibre-gl-style-spec's validateStyleMin for full spec-compliant validation.
 * Returns warning strings (non-blocking - invalid properties don't prevent config loading).
 */
function validatePaintLayout(
	layerType: string,
	paint: Record<string, unknown> | undefined,
	layout: Record<string, unknown> | undefined,
	prefix: string
): string[] {
	if (!paint && !layout) return [];

	const dummyStyle = {
		version: 8 as const,
		sources: { _validate: { type: 'geojson' as const, data: { type: 'FeatureCollection' as const, features: [] } } },
		layers: [{
			id: '_validate',
			type: layerType,
			source: '_validate',
			...(paint ? { paint } : {}),
			...(layout ? { layout } : {}),
		}],
	};

	// Cast needed: we're deliberately feeding potentially invalid values for validation
	const errors = validateStyleMin(dummyStyle as Parameters<typeof validateStyleMin>[0]);
	const warnings: string[] = [];
	for (const err of errors) {
		// Style-spec returns messages like "layers[0].paint.fill-colur: unknown property..."
		// Remap the prefix to match our config path
		const msg = err.message.replace(/^layers\[0\]\./, `${prefix}.`);
		warnings.push(msg);
	}
	return warnings;
}

/**
 * Validate a single layer config entry.
 * Checks structure only - source reference validation happens in validateLayers.
 */
export function validateLayer(layer: unknown, index: number): string[] {
	const errors: string[] = [];
	const prefix = `layers[${index}]`;

	if (typeof layer !== 'object' || layer === null) {
		return [`${prefix}: must be an object`];
	}

	const l = layer as Record<string, unknown>;

	// Required: id (non-empty string)
	if (!('id' in l)) {
		errors.push(`${prefix}: missing required 'id'`);
	} else if (typeof l.id !== 'string' || l.id.trim() === '') {
		errors.push(`${prefix}.id: must be a non-empty string`);
	}

	// Required: source (non-empty string)
	if (!('source' in l)) {
		errors.push(`${prefix}: missing required 'source'`);
	} else if (typeof l.source !== 'string' || l.source.trim() === '') {
		errors.push(`${prefix}.source: must be a non-empty string`);
	}

	// Required: type (valid MapLibre layer type)
	if (!('type' in l)) {
		errors.push(`${prefix}: missing required 'type'`);
	} else if (typeof l.type !== 'string') {
		errors.push(`${prefix}.type: must be a string`);
	} else if (!VALID_LAYER_TYPES.includes(l.type as LayerType)) {
		errors.push(`${prefix}.type: invalid layer type '${l.type}'. Valid types: ${VALID_LAYER_TYPES.join(', ')}`);
	}

	// Optional: minzoom (number 0-24)
	if ('minzoom' in l && l.minzoom !== undefined) {
		if (typeof l.minzoom !== 'number') {
			errors.push(`${prefix}.minzoom: must be a number`);
		} else if (l.minzoom < 0 || l.minzoom > 24) {
			errors.push(`${prefix}.minzoom: must be between 0 and 24`);
		}
	}

	// Optional: maxzoom (number 0-24)
	if ('maxzoom' in l && l.maxzoom !== undefined) {
		if (typeof l.maxzoom !== 'number') {
			errors.push(`${prefix}.maxzoom: must be a number`);
		} else if (l.maxzoom < 0 || l.maxzoom > 24) {
			errors.push(`${prefix}.maxzoom: must be between 0 and 24`);
		}
	}

	// Optional: source-layer (non-empty string, for vector tile sources)
	if ('source-layer' in l && l['source-layer'] !== undefined) {
		if (typeof l['source-layer'] !== 'string' || l['source-layer'].trim() === '') {
			errors.push(`${prefix}.source-layer: must be a non-empty string`);
		}
	}

	// Optional: filter (must be array if present - MapLibre expression)
	if ('filter' in l && l.filter !== undefined) {
		if (!Array.isArray(l.filter)) {
			errors.push(`${prefix}.filter: must be an array (MapLibre filter expression)`);
		}
	}

	// Optional: paint (must be object if present)
	if ('paint' in l && l.paint !== undefined) {
		if (typeof l.paint !== 'object' || l.paint === null || Array.isArray(l.paint)) {
			errors.push(`${prefix}.paint: must be an object`);
		}
	}

	// Optional: layout (must be object if present)
	if ('layout' in l && l.layout !== undefined) {
		if (typeof l.layout !== 'object' || l.layout === null || Array.isArray(l.layout)) {
			errors.push(`${prefix}.layout: must be an object`);
		}
	}

	// Validate paint/layout property names and values against MapLibre style spec
	if (typeof l.type === 'string' && VALID_LAYER_TYPES.includes(l.type as LayerType)) {
		const paint = ('paint' in l && typeof l.paint === 'object' && l.paint !== null && !Array.isArray(l.paint))
			? l.paint as Record<string, unknown> : undefined;
		const layout = ('layout' in l && typeof l.layout === 'object' && l.layout !== null && !Array.isArray(l.layout))
			? l.layout as Record<string, unknown> : undefined;
		const warnings = validatePaintLayout(l.type, paint, layout, prefix);
		for (const warning of warnings) {
			console.warn(`[config] ${warning}`);
		}
	}

	// Optional: tooltip (string or array of strings - property names to show on hover)
	if ('tooltip' in l && l.tooltip !== undefined) {
		if (typeof l.tooltip === 'string') {
			if (l.tooltip.trim() === '') {
				errors.push(`${prefix}.tooltip: must be a non-empty string`);
			}
		} else if (Array.isArray(l.tooltip)) {
			if (l.tooltip.length === 0) {
				errors.push(`${prefix}.tooltip: array must not be empty`);
			}
			l.tooltip.forEach((field, i) => {
				if (typeof field !== 'string' || field.trim() === '') {
					errors.push(`${prefix}.tooltip[${i}]: must be a non-empty string`);
				}
			});
		} else {
			errors.push(`${prefix}.tooltip: must be a string or array of strings`);
		}
	}

	return errors;
}

/**
 * Validate the layers array if present.
 * Checks structure, duplicate IDs, and source references.
 */
export function validateLayers(layers: unknown, validSourceIds: Set<string>): string[] {
	const errors: string[] = [];

	if (!Array.isArray(layers)) {
		return ["'layers' must be an array"];
	}

	if (layers.length === 0) {
		return []; // Empty array is valid (no custom layers)
	}

	// Check for duplicate layer IDs
	const layerIds = new Set<string>();
	layers.forEach((layer, index) => {
		const l = layer as Record<string, unknown>;
		if (typeof l?.id === 'string') {
			if (layerIds.has(l.id)) {
				errors.push(`layers[${index}].id: duplicate layer ID '${l.id}'`);
			}
			layerIds.add(l.id);
		}
	});

	// Validate each layer structure
	layers.forEach((layer, index) => {
		errors.push(...validateLayer(layer, index));
	});

	// Validate source references (only for layers that passed basic validation)
	layers.forEach((layer, index) => {
		const l = layer as Record<string, unknown>;
		if (typeof l?.source === 'string' && l.source.trim() !== '') {
			if (!validSourceIds.has(l.source)) {
				errors.push(`layers[${index}].source: '${l.source}' does not reference a valid dataset or operation output`);
			}
		}
	});

	return errors;
}
