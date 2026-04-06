/**
 * Renderer registry.
 * Maps layer IDs to their rendering backend (MapLibre or deck.gl).
 * Shared between layers.ts and layer-actions/ to route actions
 * to the correct API without per-action renderer detection.
 *
 * No dependency on manager, deck.gl, or MapLibre -- safe to import anywhere.
 */

import type { RendererType } from '../config/types';

interface RegistryEntry {
	renderer: RendererType;
	/** Dataset or operation ID this layer draws from (LayerConfig.source) */
	source: string;
}

const registry = new Map<string, RegistryEntry>();

/**
 * Register a layer's renderer. Called during layer creation.
 */
export function registerLayer(layerId: string, renderer: RendererType, source: string): void {
	registry.set(layerId, { renderer, source });
}

/**
 * Remove a layer from the registry. Called during layer deletion.
 */
export function unregisterLayer(layerId: string): void {
	registry.delete(layerId);
}

/**
 * Get the renderer for a layer. Returns 'maplibre' if not registered (safe default).
 */
export function getRenderer(layerId: string): RendererType {
	return registry.get(layerId)?.renderer ?? 'maplibre';
}

/**
 * Check whether a layer is rendered via deck.gl.
 */
export function isDeckGL(layerId: string): boolean {
	return getRenderer(layerId) === 'deckgl';
}

/**
 * Get all registered layer IDs for a dataset, optionally filtered by renderer.
 */
export function getLayersByDataset(datasetId: string, renderer?: RendererType): string[] {
	const result: string[] = [];
	for (const [layerId, entry] of registry) {
		if (entry.source !== datasetId) continue;
		if (renderer && entry.renderer !== renderer) continue;
		result.push(layerId);
	}
	return result;
}

/**
 * Clear all entries. Called during teardown.
 */
export function clearRegistry(): void {
	registry.clear();
}
