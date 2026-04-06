/**
 * Singleton deck.gl manager.
 * Holds a single MapboxOverlay instance and composites all deck.gl layers
 * into one WebGL context on top of the MapLibre map.
 *
 * deck.gl is lazy-loaded via dynamic import() on first use -- no deck.gl
 * code enters the initial bundle unless a deck.gl layer is actually requested.
 */

import type maplibregl from 'maplibre-gl';

/** Entry stored in the deck.gl layer registry */
export interface DeckLayerEntry {
	id: string;
	props: Record<string, unknown>;
	visible: boolean;
}

// ---------------------------------------------------------------------------
// Private module state
// ---------------------------------------------------------------------------

/** Cached dynamic imports */
let deckModules: {
	MapboxOverlay: typeof import('@deck.gl/mapbox').MapboxOverlay;
	GeoJsonLayer: typeof import('@deck.gl/layers').GeoJsonLayer;
} | null = null;

/** The single MapboxOverlay instance */
let overlay: InstanceType<typeof import('@deck.gl/mapbox').MapboxOverlay> | null = null;

/** Reference to the MapLibre map the overlay is attached to */
let mapRef: maplibregl.Map | null = null;

/** Layer registry: deck.gl layer ID -> entry */
const layerRegistry = new Map<string, DeckLayerEntry>();

/** Whether the overlay has been successfully initialized */
let initialized = false;

/** In-flight initialization promise (prevents duplicate init) */
let initPromise: Promise<void> | null = null;

// ---------------------------------------------------------------------------
// Lazy-load & initialization
// ---------------------------------------------------------------------------

/**
 * Ensure deck.gl modules are loaded and the overlay is attached to the map.
 * Safe to call multiple times -- only the first call does work.
 */
async function ensureInitialized(map: maplibregl.Map): Promise<void> {
	if (initialized) return;
	if (initPromise) {
		await initPromise;
		return;
	}

	initPromise = (async () => {
		try {
			console.log('[DeckGL] Loading deck.gl modules...');

			const [mapboxMod, layersMod] = await Promise.all([
				import('@deck.gl/mapbox'),
				import('@deck.gl/layers')
			]);

			deckModules = {
				MapboxOverlay: mapboxMod.MapboxOverlay,
				GeoJsonLayer: layersMod.GeoJsonLayer
			};

			overlay = new deckModules.MapboxOverlay({
				interleaved: false,
				layers: []
			});

			map.addControl(overlay as unknown as maplibregl.IControl);
			mapRef = map;
			initialized = true;

			console.log('[DeckGL] Overlay attached to map');
		} catch (error) {
			// Reset so a retry is possible
			initPromise = null;
			throw error;
		}
	})();

	await initPromise;
}

// ---------------------------------------------------------------------------
// Recomposite
// ---------------------------------------------------------------------------

/**
 * Rebuild the full deck.gl layer array and push it to the overlay.
 * Called after every mutation (add, remove, update, visibility toggle).
 */
function recomposite(): void {
	if (!overlay || !deckModules) return;

	const layers = [];
	for (const entry of layerRegistry.values()) {
		const needsPicking = 'onHover' in entry.props || 'onClick' in entry.props;
		layers.push(
			new deckModules.GeoJsonLayer({
				id: entry.id,
				visible: entry.visible,
				...(needsPicking ? { pickable: true } : {}),
				...entry.props
			})
		);
	}

	overlay.setProps({ layers });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Add a deck.gl layer. Lazy-loads deck.gl on first call.
 *
 * @param map - MapLibre map instance (needed for first-time overlay attachment)
 * @param id - Unique layer identifier (matches LayerConfig.id)
 * @param props - deck.gl GeoJsonLayer constructor props (data, getColor, etc.)
 */
export async function addLayer(
	map: maplibregl.Map,
	id: string,
	props: Record<string, unknown>
): Promise<void> {
	await ensureInitialized(map);

	layerRegistry.set(id, { id, props, visible: true });
	recomposite();

	console.log(`[DeckGL] Added layer '${id}'`);
}

/**
 * Remove a deck.gl layer by ID.
 * No-op if the layer doesn't exist. Does not tear down the overlay.
 */
export function removeLayer(id: string): void {
	if (!layerRegistry.delete(id)) return;
	recomposite();
	console.log(`[DeckGL] Removed layer '${id}'`);
}

/**
 * Update properties on an existing deck.gl layer.
 * Merges new props with existing ones, then recomposites.
 */
export function updateLayer(id: string, props: Record<string, unknown>): void {
	const entry = layerRegistry.get(id);
	if (!entry) return;

	entry.props = { ...entry.props, ...props };
	recomposite();

	console.log(`[DeckGL] Updated layer '${id}'`);
}

/**
 * Toggle visibility of a deck.gl layer.
 */
export function setLayerVisibility(id: string, visible: boolean): void {
	const entry = layerRegistry.get(id);
	if (!entry) return;

	entry.visible = visible;
	recomposite();

	console.log(`[DeckGL] Layer '${id}' visibility: ${visible}`);
}

/**
 * Tear down the overlay and clear all deck.gl layers.
 * Called from teardown.ts during full reset.
 */
export function destroy(): void {
	if (overlay && mapRef) {
		try {
			mapRef.removeControl(overlay as unknown as maplibregl.IControl);
		} catch {
			// Map may already be removed
		}
	}

	overlay = null;
	mapRef = null;
	deckModules = null;
	initialized = false;
	initPromise = null;
	layerRegistry.clear();

	console.log('[DeckGL] Destroyed overlay and cleared all layers');
}

/**
 * Check whether the manager has been initialized (deck.gl loaded).
 */
export function isInitialized(): boolean {
	return initialized;
}

/**
 * Check whether a specific layer ID is managed by deck.gl.
 */
export function hasLayer(id: string): boolean {
	return layerRegistry.has(id);
}
