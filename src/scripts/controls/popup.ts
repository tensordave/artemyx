/**
 * Feature popup utilities for property inspection
 */

import maplibregl from 'maplibre-gl';
import { isDeckGL } from '../deckgl/registry';

/**
 * Escape HTML special characters to prevent XSS
 */
function escapeHTML(str: string): string {
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
}

/**
 * Format a property value for display
 */
function formatValue(value: any): string {
	if (value === null || value === undefined) {
		return '<em>null</em>';
	}

	if (typeof value === 'boolean') {
		return value ? 'true' : 'false';
	}

	if (typeof value === 'number') {
		return value.toLocaleString();
	}

	if (typeof value === 'string') {
		// Truncate very long strings, then escape HTML
		if (value.length > 100) {
			return escapeHTML(`${value.substring(0, 100)}...`);
		}
		return escapeHTML(value);
	}

	if (typeof value === 'object') {
		// Handle arrays
		if (Array.isArray(value)) {
			if (value.length === 0) {
				return '[]';
			}
			return `[${value.length} items]`;
		}
		// Handle objects
		return '{object}';
	}

	return String(value);
}

/**
 * Format properties object as HTML string
 */
export function formatProperties(properties: any): string {
	if (!properties || typeof properties !== 'object') {
		return '<p style="color: #999; font-style: italic;">No properties available</p>';
	}

	const entries = Object.entries(properties);

	if (entries.length === 0) {
		return '<p style="color: #999; font-style: italic;">No properties available</p>';
	}

	const rows = entries
		.map(([key, value]) => {
			const formattedKey = escapeHTML(key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()));
			const formattedValue = formatValue(value);

			return `
				<tr>
					<td style="
						padding: 6px 12px 6px 0;
						font-weight: 600;
						color: #aaa;
						vertical-align: top;
						white-space: nowrap;
					">${formattedKey}</td>
					<td style="
						padding: 6px 0;
						color: #fff;
						word-break: break-word;
					">${formattedValue}</td>
				</tr>
			`;
		})
		.join('');

	return `
		<table style="
			width: 100%;
			border-collapse: collapse;
			font-size: 13px;
			line-height: 1.4;
		">
			${rows}
		</table>
	`;
}

/**
 * Create popup content DOM element
 */
export function createPopupContent(properties: any): HTMLElement {
	const container = document.createElement('div');
	container.style.maxWidth = '300px';
	container.style.maxHeight = '400px';
	container.style.overflowY = 'auto';
	container.innerHTML = formatProperties(properties);
	return container;
}

/** Minimal deck.gl picking info (avoids importing @deck.gl/core) */
interface DeckPickInfo {
	object?: Record<string, unknown>;
	coordinate?: [number, number];
	picked?: boolean;
	index?: number;
}

/**
 * Extract properties from a deck.gl picked object.
 * With GeoJSON data, info.object is a Feature: { type: 'Feature', properties: {...} }.
 * With binary data, info.object IS the properties object directly.
 */
function extractPickedProperties(object: Record<string, unknown>): Record<string, unknown> | undefined {
	if (object.type === 'Feature' && object.properties && typeof object.properties === 'object') {
		return object.properties as Record<string, unknown>;
	}
	return object;
}

/**
 * Build a flat properties lookup indexed by globalFeatureId from a
 * BinaryFeatureCollection.  deck.gl v9 does not populate `info.object`
 * for binary data, so hover/click callbacks use this array with
 * `info.index` (which equals the globalFeatureId) to resolve properties.
 */
export function buildGlobalProperties(
	binary: { points: BinaryGeomSub; lines: BinaryGeomSub; polygons: BinaryGeomSub }
): Record<string, unknown>[] {
	const result: Record<string, unknown>[] = [];
	for (const key of ['points', 'lines', 'polygons'] as const) {
		const geom = binary[key];
		const gfids = geom.globalFeatureIds.value;
		const fids = geom.featureIds.value;
		for (let v = 0; v < gfids.length; v++) {
			const gfid = gfids[v];
			if (result[gfid] === undefined) {
				result[gfid] = geom.properties[fids[v]] as Record<string, unknown>;
			}
		}
	}
	return result;
}

/** Minimal shape needed by buildGlobalProperties (avoids importing full BinaryFeatureCollection). */
interface BinaryGeomSub {
	globalFeatureIds: { value: ArrayLike<number> };
	featureIds: { value: ArrayLike<number> };
	properties: object[];
}

// Shared click popup state — single popup + registry ensures only the
// topmost layer shows a popup when multiple layers overlap.
let sharedClickPopup: maplibregl.Popup | null = null;
const clickRegistry = new Set<string>();
let clickHandlerAttached = false;

/**
 * Attach click handlers to feature layers for popups.
 * Uses a single shared popup and a map-level click handler that picks
 * the topmost feature via queryRenderedFeatures — only one popup at a time.
 */
export function attachFeatureClickHandlers(
	map: maplibregl.Map,
	layerIds: string[]
): void {
	// Create shared popup on first call
	if (!sharedClickPopup) {
		sharedClickPopup = new maplibregl.Popup({
			closeButton: true,
			closeOnClick: true,
			maxWidth: '350px',
			className: 'feature-popup'
		});
	}

	// Register each layer; add cursor handlers for new layers only
	for (const layerId of layerIds) {
		if (!clickRegistry.has(layerId)) {
			clickRegistry.add(layerId);

			// Skip MapLibre layer-specific events for deck.gl layers
			if (!isDeckGL(layerId)) {
				map.on('mouseenter', layerId, () => {
					map.getCanvas().style.cursor = 'pointer';
				});

				map.on('mouseleave', layerId, () => {
					map.getCanvas().style.cursor = '';
				});
			}
		}
	}

	// Attach a single map-level click handler (once)
	if (!clickHandlerAttached) {
		map.on('click', (e) => {
			const registeredIds = [...clickRegistry];
			if (registeredIds.length === 0) return;

			const maplibreIds = registeredIds.filter(id => !isDeckGL(id));
			if (maplibreIds.length === 0) return;

			const features = map.queryRenderedFeatures(e.point, { layers: maplibreIds });
			if (features.length === 0) return;

			const topFeature = features[0];

			// Hide hover tooltip when click popup opens
			sharedHoverPopup?.remove();
			hoverPopupOwner = null;

			const content = createPopupContent(topFeature.properties);

			sharedClickPopup!
				.setLngLat(e.lngLat)
				.setDOMContent(content)
				.addTo(map);
		});

		clickHandlerAttached = true;
	}
}

/** Options for hover tooltip behavior */
export interface HoverTooltipOptions {
	/** Display label shown at top of tooltip (dataset/layer name) */
	label: string;
	/** Property field names to show from feature properties */
	fields?: string[];
}

/**
 * Format a single tooltip field value (compact version of formatValue).
 */
function formatTooltipValue(value: unknown): string {
	if (value === null || value === undefined) return 'null';
	if (typeof value === 'number') return value.toLocaleString();
	if (typeof value === 'string') {
		return value.length > 60 ? escapeHTML(`${value.substring(0, 60)}...`) : escapeHTML(value);
	}
	return String(value);
}

/**
 * Build tooltip HTML content.
 * Shows the label (dataset/layer name) and optionally property field values.
 */
function buildTooltipHTML(label: string, properties?: Record<string, unknown>, fields?: string[]): string {
	let html = `<strong class="hover-tooltip-label">${escapeHTML(label)}</strong>`;

	if (fields && fields.length > 0 && properties) {
		const rows = fields
			.filter(field => field in properties)
			.map(field => {
				const key = escapeHTML(field.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()));
				const val = formatTooltipValue(properties[field]);
				return `<span class="hover-tooltip-field">${key}: ${val}</span>`;
			})
			.join('');

		if (rows) {
			html += rows;
		}
	}

	return html;
}

// Shared hover tooltip state — single popup + registry ensures only the
// topmost layer shows a tooltip when multiple layers overlap.
let sharedHoverPopup: maplibregl.Popup | null = null;
const hoverRegistry = new Map<string, HoverTooltipOptions>();
let hoverHandlerAttached = false;
/** Which renderer currently owns the hover popup. Prevents cross-renderer removal. */
let hoverPopupOwner: 'maplibre' | 'deckgl' | null = null;

/**
 * Attach hover tooltip handlers to feature layers.
 * Uses a single shared popup and a map-level mousemove handler that picks
 * the topmost feature via queryRenderedFeatures — only one tooltip at a time.
 */
export function attachFeatureHoverHandlers(
	map: maplibregl.Map,
	layerIds: string[],
	options: HoverTooltipOptions
): void {
	// Create shared popup on first call
	if (!sharedHoverPopup) {
		sharedHoverPopup = new maplibregl.Popup({
			closeButton: false,
			closeOnClick: false,
			className: 'hover-tooltip',
			offset: 15
		});
	}

	// Register each layer with its tooltip options
	for (const id of layerIds) {
		hoverRegistry.set(id, options);
	}

	// Attach a single map-level mousemove handler (once), throttled to animation frame rate
	if (!hoverHandlerAttached) {
		let hoverRafPending = false;
		map.on('mousemove', (e) => {
			if (hoverRafPending) return;
			hoverRafPending = true;
			requestAnimationFrame(() => {
				hoverRafPending = false;

				const registeredIds = [...hoverRegistry.keys()];
				if (registeredIds.length === 0) return;

				// Filter to MapLibre-only layers — deck.gl layers handle hover via their own callbacks
				const maplibreIds = registeredIds.filter(id => !isDeckGL(id));
				if (maplibreIds.length === 0) return;

				// Query only our registered layers — topmost feature is first
				const features = map.queryRenderedFeatures(e.point, { layers: maplibreIds });

				if (features.length === 0) {
					if (hoverPopupOwner !== 'deckgl') {
						sharedHoverPopup!.remove();
						hoverPopupOwner = null;
					}
					return;
				}

				const topFeature = features[0];
				const layerId = topFeature.layer.id;
				const opts = hoverRegistry.get(layerId);
				if (!opts) return;

				const html = buildTooltipHTML(opts.label, topFeature.properties as Record<string, unknown>, opts.fields);

				sharedHoverPopup!
					.setLngLat(e.lngLat)
					.setHTML(html)
					.addTo(map);
				hoverPopupOwner = 'maplibre';
			});
		});

		hoverHandlerAttached = true;
	}
}

/**
 * Remove layer IDs from the hover tooltip registry.
 * Call when deleting a dataset to prevent queryRenderedFeatures errors on stale layers.
 */
export function removeFeatureHandlers(layerIds: string[]): void {
	for (const id of layerIds) {
		hoverRegistry.delete(id);
		clickRegistry.delete(id);
	}
}

/**
 * Clear all entries from the hover tooltip registry.
 * Used by teardown to bulk-remove all feature handlers at once.
 */
export function clearAllFeatureHandlers(): void {
	hoverRegistry.clear();
	clickRegistry.clear();
	hoverPopupOwner = null;
}

/**
 * Read the tooltip fields configured for a layer.
 * Used by the config generator to reconstruct tooltip config from runtime state.
 */
export function getTooltipFields(layerId: string): string[] | undefined {
	return hoverRegistry.get(layerId)?.fields;
}

/**
 * Read the full hover tooltip options for a layer.
 * Used by the rename orchestrator to capture and re-register handlers.
 */
export function getHoverOptions(layerId: string): HoverTooltipOptions | undefined {
	return hoverRegistry.get(layerId);
}

/**
 * Update the display label for existing hover tooltip entries.
 * Used by PMTiles rename (display-name only) to update tooltips
 * without removing and re-registering handlers.
 */
export function updateHoverLabel(layerIds: string[], newLabel: string): void {
	for (const id of layerIds) {
		const opts = hoverRegistry.get(id);
		if (opts) {
			hoverRegistry.set(id, { ...opts, label: newLabel });
		}
	}
}

// ── deck.gl callback builders ──────────────────────────────────────────
// These return closures that drive the shared MapLibre popup singletons
// from deck.gl onHover / onClick callbacks, giving both renderers
// identical popup/tooltip behavior.

/**
 * Build a deck.gl `onHover` callback for a layer.
 * Registers the layer in `hoverRegistry` (parity with config generator,
 * `getTooltipFields`, `removeFeatureHandlers`, etc.) and returns a
 * closure that shows/hides the shared hover tooltip.
 */
export function buildDeckHoverCallback(
	map: maplibregl.Map,
	layerId: string,
	options: HoverTooltipOptions,
	globalProperties?: Record<string, unknown>[]
): (info: DeckPickInfo) => void {
	// Register so getTooltipFields / getHoverOptions / config generator work
	hoverRegistry.set(layerId, options);

	// Lazy-create shared popup (same pattern as attachFeatureHoverHandlers)
	if (!sharedHoverPopup) {
		sharedHoverPopup = new maplibregl.Popup({
			closeButton: false,
			closeOnClick: false,
			className: 'hover-tooltip',
			offset: 15
		});
	}

	return (info: DeckPickInfo) => {
		// Resolve object: info.object is set for GeoJSON data but undefined for
		// binary data (deck.gl v9 doesn't populate it). Fall back to the
		// globalProperties lookup using info.index (== globalFeatureId).
		const object = info.object
			?? (globalProperties && info.index != null && info.index >= 0
				? globalProperties[info.index] as Record<string, unknown> | undefined
				: undefined);

		if (!info.picked || !object) {
			if (hoverPopupOwner === 'deckgl') {
				sharedHoverPopup!.remove();
				hoverPopupOwner = null;
			}
			map.getCanvas().style.cursor = '';
			return;
		}

		map.getCanvas().style.cursor = 'pointer';

		const properties = extractPickedProperties(object);
		const html = buildTooltipHTML(options.label, properties, options.fields);

		sharedHoverPopup!
			.setLngLat(info.coordinate as [number, number])
			.setHTML(html)
			.addTo(map);
		hoverPopupOwner = 'deckgl';
	};
}

/**
 * Build a deck.gl `onClick` callback for a layer.
 * Registers the layer in `clickRegistry` and returns a closure that
 * shows the shared click popup with all feature properties.
 */
export function buildDeckClickCallback(
	map: maplibregl.Map,
	layerId: string,
	globalProperties?: Record<string, unknown>[]
): (info: DeckPickInfo) => void {
	// Register so removeFeatureHandlers cleanup works
	clickRegistry.add(layerId);

	// Lazy-create shared popup (same pattern as attachFeatureClickHandlers)
	if (!sharedClickPopup) {
		sharedClickPopup = new maplibregl.Popup({
			closeButton: true,
			closeOnClick: true,
			maxWidth: '350px',
			className: 'feature-popup'
		});
	}

	return (info: DeckPickInfo) => {
		const object = info.object
			?? (globalProperties && info.index != null && info.index >= 0
				? globalProperties[info.index] as Record<string, unknown> | undefined
				: undefined);

		if (!object) return;

		// Dismiss hover tooltip when click popup opens
		sharedHoverPopup?.remove();
		hoverPopupOwner = null;

		const content = createPopupContent(extractPickedProperties(object));

		sharedClickPopup!
			.setLngLat(info.coordinate as [number, number])
			.setDOMContent(content)
			.addTo(map);
	};
}
