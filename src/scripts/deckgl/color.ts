/**
 * Color conversion utilities for deck.gl integration.
 * deck.gl uses RGBA arrays [r, g, b, a] (0-255) while MapLibre uses CSS color strings.
 * Pure functions with no deck.gl or MapLibre dependency.
 */

/**
 * Convert a CSS hex color string to a deck.gl RGBA array.
 * Supports #RGB, #RRGGBB, and #RRGGBBAA formats.
 * Alpha defaults to 255 (fully opaque) when not specified.
 */
export function hexToRGBA(hex: string, alphaOverride?: number): [number, number, number, number] {
	let h = hex.replace('#', '');

	// Expand shorthand (#RGB -> #RRGGBB)
	if (h.length === 3) {
		h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
	}

	const r = parseInt(h.substring(0, 2), 16);
	const g = parseInt(h.substring(2, 4), 16);
	const b = parseInt(h.substring(4, 6), 16);
	const a = h.length >= 8 ? parseInt(h.substring(6, 8), 16) : 255;

	return [r, g, b, alphaOverride ?? a];
}

/**
 * Convert a deck.gl RGBA array to a CSS hex string (#RRGGBB).
 * Alpha channel is dropped (use opacity props separately).
 */
export function rgbaToHex(rgba: [number, number, number, number]): string {
	const [r, g, b] = rgba;
	return '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('');
}

/**
 * Build deck.gl color accessor props from a CSS color and opacity values.
 * Returns props suitable for passing to manager.updateLayer() or addLayer().
 */
export function buildDeckColorProps(
	cssColor: string,
	fillOpacity: number = 0.2,
	lineOpacity: number = 0.6,
	pointOpacity: number = 0.6
): Record<string, unknown> {
	const rgb = hexToRGBA(cssColor);
	return {
		getFillColor: [rgb[0], rgb[1], rgb[2], Math.round(fillOpacity * 255)],
		getLineColor: [rgb[0], rgb[1], rgb[2], Math.round(lineOpacity * 255)],
	};
}
