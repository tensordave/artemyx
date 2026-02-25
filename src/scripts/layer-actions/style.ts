/**
 * Inline style panel for editing layer display properties.
 * Provides sliders for fill opacity, line width, and point radius
 * with live preview updates to the map.
 */

import maplibregl from 'maplibre-gl';
import { getDatasetStyle, updateDatasetStyle, type StyleConfig } from '../db/datasets';
import { ProgressControl } from '../progress-control';
import { getLayersBySource, type SourceLayerInfo } from '../layers/layers';
import { getSourceId } from '../layers/sources';

/**
 * Maps StyleConfig properties to their target layer type and MapLibre paint property.
 */
const STYLE_PROPERTY_MAP: Record<
	keyof StyleConfig,
	{ layerType: SourceLayerInfo['type']; paintProperty: string }
> = {
	fillOpacity: { layerType: 'fill', paintProperty: 'fill-opacity' },
	lineWidth: { layerType: 'line', paintProperty: 'line-width' },
	pointRadius: { layerType: 'circle', paintProperty: 'circle-radius' }
};

/**
 * Check if a paint property value is a MapLibre expression (array).
 * Expressions like ["match", ...] or ["interpolate", ...] shouldn't be overwritten by simple values.
 */
function isExpression(value: unknown): boolean {
	return Array.isArray(value);
}

/**
 * Check which style properties can be edited (i.e., don't use expressions).
 * Returns a map of property -> whether it's editable.
 */
function getEditableProperties(
	map: maplibregl.Map,
	datasetId: string
): Record<keyof StyleConfig, boolean> {
	const sourceId = getSourceId(datasetId);
	const layers = getLayersBySource(map, sourceId);

	const result: Record<keyof StyleConfig, boolean> = {
		fillOpacity: false,
		lineWidth: false,
		pointRadius: false
	};

	// For each property, check if there's at least one matching layer without an expression
	for (const property of Object.keys(STYLE_PROPERTY_MAP) as (keyof StyleConfig)[]) {
		const mapping = STYLE_PROPERTY_MAP[property];

		for (const layer of layers) {
			if (layer.type !== mapping.layerType) {
				continue;
			}

			const currentValue = layer.paint[mapping.paintProperty];
			if (!isExpression(currentValue)) {
				// Found at least one editable layer for this property
				result[property] = true;
				break;
			}
		}
	}

	return result;
}

interface SliderConfig {
	property: keyof StyleConfig;
	label: string;
	min: number;
	max: number;
	step: number;
	unit: string;
	format: (value: number) => string;
}

const SLIDER_CONFIGS: SliderConfig[] = [
	{
		property: 'fillOpacity',
		label: 'Fill Opacity',
		min: 0,
		max: 1,
		step: 0.05,
		unit: '',
		format: (v) => v.toFixed(2)
	},
	{
		property: 'lineWidth',
		label: 'Line Width',
		min: 1,
		max: 10,
		step: 0.5,
		unit: 'px',
		format: (v) => `${v}px`
	},
	{
		property: 'pointRadius',
		label: 'Point Radius',
		min: 2,
		max: 20,
		step: 1,
		unit: 'px',
		format: (v) => `${v}px`
	}
];

/**
 * Track currently open style panel to ensure only one is open at a time
 */
let currentStylePanel: {
	panel: HTMLDivElement;
	datasetId: string;
	cleanup: () => void;
} | null = null;

/**
 * Apply a style property to all matching layers for a dataset.
 * Finds layers dynamically by source, filters by type, and skips expression-based properties.
 *
 * @returns true if at least one layer was updated, false if none (e.g., all use expressions)
 */
function applyStyleToMap(
	map: maplibregl.Map,
	datasetId: string,
	property: keyof StyleConfig,
	value: number
): boolean {
	const sourceId = getSourceId(datasetId);
	const layers = getLayersBySource(map, sourceId);
	const mapping = STYLE_PROPERTY_MAP[property];

	let appliedCount = 0;

	for (const layer of layers) {
		// Only apply to matching layer type
		if (layer.type !== mapping.layerType) {
			continue;
		}

		// Skip if current value is an expression
		const currentValue = layer.paint[mapping.paintProperty];
		if (isExpression(currentValue)) {
			console.log(
				`[Style] Skipping ${layer.id}.${mapping.paintProperty}: uses expression`
			);
			continue;
		}

		// Apply the simple value
		map.setPaintProperty(layer.id, mapping.paintProperty, value);
		appliedCount++;
	}

	return appliedCount > 0;
}

/**
 * Create a slider row element
 * @param disabled - If true, slider is disabled and shows "Expression" badge
 */
function createSliderRow(
	config: SliderConfig,
	currentValue: number,
	onChange: (value: number) => void,
	disabled: boolean = false
): HTMLDivElement {
	const row = document.createElement('div');
	row.className = 'style-row';
	if (disabled) {
		row.classList.add('style-row-disabled');
	}

	const label = document.createElement('span');
	label.className = 'style-label';
	label.textContent = config.label;

	const slider = document.createElement('input');
	slider.type = 'range';
	slider.className = 'style-slider';
	slider.min = String(config.min);
	slider.max = String(config.max);
	slider.step = String(config.step);
	slider.value = String(currentValue);
	slider.disabled = disabled;

	const valueDisplay = document.createElement('span');
	valueDisplay.className = 'style-value';

	if (disabled) {
		// Show "Expression" badge instead of value
		valueDisplay.textContent = 'Expression';
		valueDisplay.classList.add('style-value-expression');
		valueDisplay.title = 'Controlled by config expression';
	} else {
		valueDisplay.textContent = config.format(currentValue);

		// Live update on slider input
		slider.addEventListener('input', () => {
			const newValue = parseFloat(slider.value);
			valueDisplay.textContent = config.format(newValue);
			onChange(newValue);
		});
	}

	row.appendChild(label);
	row.appendChild(slider);
	row.appendChild(valueDisplay);

	return row;
}

/**
 * Show the inline style panel for a dataset.
 * Inserts the panel after the layer row element.
 */
export async function showStylePanel(
	map: maplibregl.Map,
	datasetId: string,
	datasetName: string,
	rowElement: HTMLDivElement,
	progressControl: ProgressControl,
	onClose?: () => void
): Promise<void> {
	// Close any existing style panel
	closeStylePanel();

	// Get current style from database
	const currentStyle = await getDatasetStyle(datasetId);
	const workingStyle: StyleConfig = { ...currentStyle };

	// Create panel element
	const panel = document.createElement('div');
	panel.className = 'style-panel';

	// Header with title and close button
	const header = document.createElement('div');
	header.className = 'style-panel-header';

	const title = document.createElement('span');
	title.className = 'style-panel-title';
	title.textContent = 'Style Settings';

	const closeBtn = document.createElement('button');
	closeBtn.type = 'button';
	closeBtn.className = 'style-panel-close';
	closeBtn.textContent = '✕';
	closeBtn.title = 'Close';

	header.appendChild(title);
	header.appendChild(closeBtn);
	panel.appendChild(header);

	// Check which properties are editable (not using expressions)
	const editableProps = getEditableProperties(map, datasetId);

	// Create sliders for each property
	SLIDER_CONFIGS.forEach((config) => {
		const isEditable = editableProps[config.property];
		const sliderRow = createSliderRow(
			config,
			currentStyle[config.property],
			(newValue) => {
				// Update working style
				workingStyle[config.property] = newValue;
				// Live update map
				applyStyleToMap(map, datasetId, config.property, newValue);
			},
			!isEditable // disabled if not editable
		);
		panel.appendChild(sliderRow);
	});

	// Save and cleanup function
	const saveAndClose = async () => {
		// Check if style actually changed
		const hasChanges =
			workingStyle.fillOpacity !== currentStyle.fillOpacity ||
			workingStyle.lineWidth !== currentStyle.lineWidth ||
			workingStyle.pointRadius !== currentStyle.pointRadius;

		if (hasChanges) {
			progressControl.updateProgress(datasetName, 'processing', 'Saving style');
			const success = await updateDatasetStyle(datasetId, workingStyle);
			if (success) {
				progressControl.updateProgress(datasetName, 'success', 'Style saved');
				progressControl.scheduleIdle(2000);
			} else {
				progressControl.updateProgress(datasetName, 'error', 'Failed to save style');
			}
		}

		// Remove panel from DOM
		panel.remove();
		currentStylePanel = null;

		if (onClose) {
			onClose();
		}
	};

	// Close button handler
	closeBtn.addEventListener('click', (e) => {
		e.stopPropagation();
		saveAndClose();
	});

	// Prevent clicks inside panel from bubbling to row
	panel.addEventListener('click', (e) => {
		e.stopPropagation();
	});

	// Insert panel after the row element
	rowElement.insertAdjacentElement('afterend', panel);

	// Track current panel
	currentStylePanel = {
		panel,
		datasetId,
		cleanup: saveAndClose
	};
}

/**
 * Close the currently open style panel (if any)
 */
export function closeStylePanel(): void {
	if (currentStylePanel) {
		currentStylePanel.cleanup();
	}
}

/**
 * Check if a style panel is currently open for a specific dataset
 */
export function isStylePanelOpen(datasetId?: string): boolean {
	if (!currentStylePanel) return false;
	if (datasetId === undefined) return true;
	return currentStylePanel.datasetId === datasetId;
}
