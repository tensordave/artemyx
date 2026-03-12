/**
 * Feature popup utilities for property inspection
 */

import maplibregl from 'maplibre-gl';

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

/**
 * Attach click handlers to feature layers for popups.
 * Returns the popup instance so hover handlers can hide it on click.
 */
export function attachFeatureClickHandlers(
	map: maplibregl.Map,
	layerIds: string[],
	hoverPopup?: maplibregl.Popup
): void {
	// Create a single popup instance to reuse
	const popup = new maplibregl.Popup({
		closeButton: true,
		closeOnClick: true,
		maxWidth: '350px',
		className: 'feature-popup'
	});

	// Add click handler for each layer
	layerIds.forEach(layerId => {
		map.on('click', layerId, (e) => {
			if (!e.features || e.features.length === 0) {
				return;
			}

			// Hide hover tooltip when click popup opens
			hoverPopup?.remove();

			// Get first feature's properties
			const feature = e.features[0];
			const properties = feature.properties;

			// Create popup content
			const content = createPopupContent(properties);

			// Set popup location and content
			popup
				.setLngLat(e.lngLat)
				.setDOMContent(content)
				.addTo(map);
		});

		// Change cursor on hover
		map.on('mouseenter', layerId, () => {
			map.getCanvas().style.cursor = 'pointer';
		});

		map.on('mouseleave', layerId, () => {
			map.getCanvas().style.cursor = '';
		});
	});
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

/**
 * Attach hover tooltip handlers to feature layers.
 * Uses a single shared popup and a map-level mousemove handler that picks
 * the topmost feature via queryRenderedFeatures — only one tooltip at a time.
 * Returns the shared popup instance for coordination with click handlers.
 */
export function attachFeatureHoverHandlers(
	map: maplibregl.Map,
	layerIds: string[],
	options: HoverTooltipOptions
): maplibregl.Popup {
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

				// Query only our registered layers — topmost feature is first
				const features = map.queryRenderedFeatures(e.point, { layers: registeredIds });

				if (features.length === 0) {
					sharedHoverPopup!.remove();
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
			});
		});

		hoverHandlerAttached = true;
	}

	return sharedHoverPopup;
}

/**
 * Remove layer IDs from the hover tooltip registry.
 * Call when deleting a dataset to prevent queryRenderedFeatures errors on stale layers.
 */
export function removeFeatureHandlers(layerIds: string[]): void {
	for (const id of layerIds) {
		hoverRegistry.delete(id);
	}
}

/**
 * Clear all entries from the hover tooltip registry.
 * Used by teardown to bulk-remove all feature handlers at once.
 */
export function clearAllFeatureHandlers(): void {
	hoverRegistry.clear();
}
