/**
 * Style view builder for the layer control drill-down panel.
 * Builds the style view content (color, opacity, width, radius)
 * inside the layer panel element, replacing the layer list.
 */

import maplibregl from 'maplibre-gl';
import { getDatasetStyle, updateDatasetStyle, getDistinctGeometryTypes } from '../db';
import type { StyleConfig } from '../db/constants';
import { ProgressControl } from '../controls/progress-control';
import { getLayersForDataset, applyZoomRange, type SourceLayerInfo } from '../layers/layers';
import { buildLabelSection } from './labels';
import { arrowLeftIcon, pencilIcon } from '../icons';
import { isColorPickerEnabled, getDisplayColor, updateLayerColor } from './color';
import type { Dataset } from './layer-row';
import { getLayersByDataset } from '../deckgl/registry';

/** Geometry style properties (excludes label fields) */
type GeometryStyleProperty = 'fillOpacity' | 'lineOpacity' | 'pointOpacity' | 'lineWidth' | 'pointRadius';

/**
 * Maps geometry style properties to their target layer type and MapLibre paint property.
 */
const STYLE_PROPERTY_MAP: Record<
	GeometryStyleProperty,
	{ layerType: SourceLayerInfo['type']; paintProperty: string }
> = {
	fillOpacity: { layerType: 'fill', paintProperty: 'fill-opacity' },
	lineOpacity: { layerType: 'line', paintProperty: 'line-opacity' },
	pointOpacity: { layerType: 'circle', paintProperty: 'circle-opacity' },
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
): Record<GeometryStyleProperty, boolean> {
	const result: Record<GeometryStyleProperty, boolean> = {
		fillOpacity: false,
		lineOpacity: false,
		pointOpacity: false,
		lineWidth: false,
		pointRadius: false
	};

	// deck.gl layers are always editable (no expression support)
	if (getLayersByDataset(datasetId, 'deckgl').length > 0) {
		return {
			fillOpacity: true,
			lineOpacity: true,
			pointOpacity: true,
			lineWidth: true,
			pointRadius: true
		};
	}

	const layers = getLayersForDataset(map, datasetId);

	for (const property of Object.keys(STYLE_PROPERTY_MAP) as GeometryStyleProperty[]) {
		const mapping = STYLE_PROPERTY_MAP[property];

		for (const layer of layers) {
			if (layer.type !== mapping.layerType) {
				continue;
			}

			const currentValue = layer.paint[mapping.paintProperty];
			if (!isExpression(currentValue)) {
				result[property] = true;
				break;
			}
		}
	}

	return result;
}

/**
 * Check which geometry types exist for a dataset by querying DuckDB.
 * Returns accurate results regardless of viewport state or render timing.
 * PMTiles datasets have no features in DuckDB, so all three types are enabled
 * (vector tiles can contain any geometry type and we create all 3 default layers).
 */
async function getGeometryPresence(
	datasetId: string,
	format?: string | null
): Promise<{ hasFill: boolean; hasLine: boolean; hasCircle: boolean }> {
	if (format === 'pmtiles') {
		return { hasFill: true, hasLine: true, hasCircle: true };
	}
	const types = await getDistinctGeometryTypes(datasetId);
	return {
		hasFill: types.has('POLYGON') || types.has('MULTIPOLYGON'),
		hasLine: types.has('LINESTRING') || types.has('MULTILINESTRING') || types.has('POLYGON') || types.has('MULTIPOLYGON'),
		hasCircle: types.has('POINT') || types.has('MULTIPOINT')
	};
}

interface SliderConfig {
	property: GeometryStyleProperty;
	label: string;
	min: number;
	max: number;
	step: number;
	unit: string;
	format: (value: number) => string;
	requiredGeometry: 'hasFill' | 'hasLine' | 'hasCircle';
}

const SLIDER_CONFIGS: SliderConfig[] = [
	{
		property: 'fillOpacity',
		label: 'Fill Opacity',
		min: 0,
		max: 1,
		step: 0.05,
		unit: '',
		format: (v) => v.toFixed(2),
		requiredGeometry: 'hasFill'
	},
	{
		property: 'lineOpacity',
		label: 'Line Opacity',
		min: 0,
		max: 1,
		step: 0.05,
		unit: '',
		format: (v) => v.toFixed(2),
		requiredGeometry: 'hasLine'
	},
	{
		property: 'pointOpacity',
		label: 'Point Opacity',
		min: 0,
		max: 1,
		step: 0.05,
		unit: '',
		format: (v) => v.toFixed(2),
		requiredGeometry: 'hasCircle'
	},
	{
		property: 'lineWidth',
		label: 'Line Width',
		min: 1,
		max: 10,
		step: 0.5,
		unit: 'px',
		format: (v) => `${v}px`,
		requiredGeometry: 'hasLine'
	},
	{
		property: 'pointRadius',
		label: 'Point Radius',
		min: 2,
		max: 20,
		step: 1,
		unit: 'px',
		format: (v) => `${v}px`,
		requiredGeometry: 'hasCircle'
	}
];

/**
 * Apply a style property to all matching layers for a dataset.
 * Finds layers dynamically by source, filters by type, and skips expression-based properties.
 *
 * @returns true if at least one layer was updated, false if none (e.g., all use expressions)
 */
/** Map a style slider property to deck.gl updateLayer props. */
function mapStyleToDeckProps(property: GeometryStyleProperty, value: number): Record<string, unknown> {
	switch (property) {
		case 'lineWidth':
			return { lineWidthMinPixels: value };
		case 'pointRadius':
			return { getPointRadius: value, pointRadiusMinPixels: Math.min(3, value) };
		case 'fillOpacity':
			return { opacity: value };
		case 'lineOpacity':
			// GeoJsonLayer doesn't have a separate line opacity -- use lineWidthMinPixels with alpha
			return {};
		case 'pointOpacity':
			return {};
		default:
			return {};
	}
}

function applyStyleToMap(
	map: maplibregl.Map,
	datasetId: string,
	property: GeometryStyleProperty,
	value: number
): boolean {
	const layers = getLayersForDataset(map, datasetId);
	const mapping = STYLE_PROPERTY_MAP[property];

	let appliedCount = 0;

	for (const layer of layers) {
		if (layer.type !== mapping.layerType) {
			continue;
		}

		const currentValue = layer.paint[mapping.paintProperty];
		if (isExpression(currentValue)) {
			console.log(
				`[Style] Skipping ${layer.id}.${mapping.paintProperty}: uses expression`
			);
			continue;
		}

		map.setPaintProperty(layer.id, mapping.paintProperty, value);
		appliedCount++;
	}

	// deck.gl layers
	const deckLayerIds = getLayersByDataset(datasetId, 'deckgl');
	if (deckLayerIds.length > 0) {
		const deckProps = mapStyleToDeckProps(property, value);
		if (Object.keys(deckProps).length > 0) {
			void import('../deckgl/manager').then(({ updateLayer }) => {
				for (const id of deckLayerIds) {
					updateLayer(id, deckProps);
				}
			});
			appliedCount += deckLayerIds.length;
		}
	}

	return appliedCount > 0;
}

/**
 * Create a slider row element
 * @param disabled - If true, slider is disabled and shows "Expression" badge
 */
export function createSliderRow(
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
		valueDisplay.textContent = 'Expression';
		valueDisplay.classList.add('style-value-expression');
		valueDisplay.title = 'Controlled by config expression';
	} else {
		valueDisplay.textContent = config.format(currentValue);

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
 * Create the color row for the style view.
 * Shows a colored swatch that triggers the native color picker, plus the hex value.
 */
function createColorRow(
	map: maplibregl.Map,
	dataset: Dataset,
	progressControl: ProgressControl,
	onColorChanged: (newColor: string) => void
): HTMLDivElement {
	const row = document.createElement('div');
	row.className = 'style-row style-color-row';

	const label = document.createElement('span');
	label.className = 'style-label';
	label.textContent = 'Color';

	const colorEnabled = isColorPickerEnabled(map, dataset.id);
	const currentColor = getDisplayColor(map, dataset.id, dataset.color || '#3388ff');

	const swatchContainer = document.createElement('div');
	swatchContainer.className = 'style-color-swatch-container';

	const swatch = document.createElement('input');
	swatch.type = 'color';
	swatch.className = 'style-color-swatch';
	swatch.value = currentColor;
	swatch.title = colorEnabled ? 'Change color' : 'Color controlled by config expression';

	const hexDisplay = document.createElement('span');
	hexDisplay.className = 'style-value';

	if (!colorEnabled) {
		row.classList.add('style-row-disabled');
		swatch.disabled = true;
		hexDisplay.textContent = 'Expression';
		hexDisplay.classList.add('style-value-expression');
		hexDisplay.title = 'Controlled by config expression';
	} else {
		hexDisplay.textContent = currentColor;

		swatch.addEventListener('input', () => {
			hexDisplay.textContent = swatch.value;
		});

		swatch.addEventListener('change', async () => {
			const newColor = swatch.value;
			hexDisplay.textContent = newColor;
			await updateLayerColor(map, dataset.id, dataset.name, newColor, progressControl);
			onColorChanged(newColor);
		});
	}

	swatchContainer.appendChild(swatch);

	row.appendChild(label);
	row.appendChild(swatchContainer);
	row.appendChild(hexDisplay);

	return row;
}

/** Tracks the current style view's save function for auto-save on panel close */
let pendingSave: (() => Promise<void>) | null = null;

/** Debounce timer for auto-saving style changes to DB */
let saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Save any pending style changes (called when leaving the style view).
 */
export async function savePendingStyle(): Promise<void> {
	// Cancel any pending debounce - we're saving immediately
	if (saveDebounceTimer) {
		clearTimeout(saveDebounceTimer);
		saveDebounceTimer = null;
	}
	if (pendingSave) {
		await pendingSave();
		pendingSave = null;
	}
}

/**
 * Build the style view inside the layer panel.
 * Replaces panel content with style controls for the given dataset.
 */
export async function buildStyleView(
	map: maplibregl.Map,
	dataset: Dataset,
	panelElement: HTMLDivElement,
	progressControl: ProgressControl,
	onBack: () => void,
	onColorChanged: (newColor: string) => void,
	onRenamed: (newName: string) => void
): Promise<void> {
	// Get current style from database
	const currentStyle = await getDatasetStyle(dataset.id);
	const workingStyle: StyleConfig = { ...currentStyle };

	// Clear panel
	panelElement.innerHTML = '';

	// Header with back arrow, layer name, and rename button
	const header = document.createElement('div');
	header.className = 'style-view-header';
	header.style.borderLeftColor = dataset.color || '#3388ff';

	const backBtn = document.createElement('button');
	backBtn.type = 'button';
	backBtn.className = 'style-view-back';
	backBtn.innerHTML = arrowLeftIcon;
	backBtn.title = 'Back to layers';

	const title = document.createElement('span');
	title.className = 'style-view-title';
	title.textContent = dataset.name;

	const renameBtn = document.createElement('button');
	renameBtn.type = 'button';
	renameBtn.className = 'style-rename-btn';
	renameBtn.innerHTML = pencilIcon;
	renameBtn.title = 'Rename layer';

	let isEditing = false;

	const startRename = () => {
		if (isEditing) return;
		isEditing = true;

		const currentName = title.textContent || dataset.name;

		const input = document.createElement('input');
		input.type = 'text';
		input.className = 'style-rename-input';
		input.value = currentName;

		// Switch pencil to green confirm mode
		renameBtn.classList.add('style-rename-btn--confirm');
		renameBtn.title = 'Confirm rename';

		let hasExited = false;
		const exitEdit = (save: boolean) => {
			if (hasExited) return;
			hasExited = true;
			isEditing = false;

			const newName = input.value.trim();
			if (save && newName && newName !== currentName) {
				title.textContent = newName;
				onRenamed(newName);
			}

			input.replaceWith(title);
			renameBtn.classList.remove('style-rename-btn--confirm');
			renameBtn.title = 'Rename layer';
		};

		input.addEventListener('keydown', (ke) => {
			if (ke.key === 'Enter') {
				ke.preventDefault();
				exitEdit(true);
			} else if (ke.key === 'Escape') {
				ke.preventDefault();
				exitEdit(false);
			}
		});

		input.addEventListener('blur', (e) => {
			// Don't save on blur if the user clicked the confirm button (it handles save itself)
			if (e.relatedTarget === renameBtn) return;
			exitEdit(true);
		});

		title.replaceWith(input);
		input.focus();
		input.select();
	};

	renameBtn.addEventListener('click', (e) => {
		e.stopPropagation();
		if (isEditing) {
			// Confirm rename
			const input = header.querySelector('.style-rename-input') as HTMLInputElement | null;
			if (input) {
				input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
			}
		} else {
			startRename();
		}
	});

	title.addEventListener('dblclick', (e) => {
		e.stopPropagation();
		startRename();
	});

	header.appendChild(backBtn);
	header.appendChild(title);
	header.appendChild(renameBtn);
	panelElement.appendChild(header);

	// Content area
	const content = document.createElement('div');
	content.className = 'style-view-content';

	// Color row
	const colorRow = createColorRow(map, dataset, progressControl, onColorChanged);
	content.appendChild(colorRow);

	// Check which properties are editable and which geometries exist
	const editableProps = getEditableProperties(map, dataset.id);
	const geometryPresence = await getGeometryPresence(dataset.id, dataset.format);

	// Debounced save: persists style to DB 500ms after the last slider change.
	// Ensures OPFS persistence without waiting for the user to navigate away.
	const scheduleSave = () => {
		if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
		saveDebounceTimer = setTimeout(() => {
			saveDebounceTimer = null;
			pendingSave?.();
		}, 500);
	};

	// Create sliders for each relevant property
	SLIDER_CONFIGS.forEach((config) => {
		// Skip controls for geometry types not present in this dataset
		if (!geometryPresence[config.requiredGeometry]) {
			return;
		}

		const isEditable = editableProps[config.property];
		const sliderRow = createSliderRow(
			config,
			currentStyle[config.property],
			(newValue) => {
				workingStyle[config.property] = newValue;
				applyStyleToMap(map, dataset.id, config.property, newValue);
				scheduleSave();
			},
			!isEditable
		);
		content.appendChild(sliderRow);
	});

	// ── Visibility section (zoom range) ────────────────────────────

	const zoomDivider = document.createElement('div');
	zoomDivider.className = 'style-section-divider';
	zoomDivider.textContent = 'Visibility';
	content.appendChild(zoomDivider);

	const minZoomRow = createSliderRow(
		{ property: 'fillOpacity', label: 'Min Zoom', min: 0, max: 24, step: 1, unit: '', format: (v) => `${v}`, requiredGeometry: 'hasFill' },
		currentStyle.minzoom,
		(newValue) => {
			workingStyle.minzoom = newValue;
			// Clamp max if needed
			if (newValue > workingStyle.maxzoom) {
				workingStyle.maxzoom = newValue;
				maxZoomSlider.value = String(newValue);
				maxZoomDisplay.textContent = `${newValue}`;
			}
			applyZoomRange(map, dataset.id, workingStyle.minzoom, workingStyle.maxzoom);
			scheduleSave();
		}
	);
	content.appendChild(minZoomRow);
	const minZoomSlider = minZoomRow.querySelector('input') as HTMLInputElement;
	const minZoomDisplay = minZoomRow.querySelector('.style-value') as HTMLSpanElement;

	const maxZoomRow = createSliderRow(
		{ property: 'fillOpacity', label: 'Max Zoom', min: 0, max: 24, step: 1, unit: '', format: (v) => `${v}`, requiredGeometry: 'hasFill' },
		currentStyle.maxzoom,
		(newValue) => {
			workingStyle.maxzoom = newValue;
			// Clamp min if needed
			if (newValue < workingStyle.minzoom) {
				workingStyle.minzoom = newValue;
				minZoomSlider.value = String(newValue);
				minZoomDisplay.textContent = `${newValue}`;
			}
			applyZoomRange(map, dataset.id, workingStyle.minzoom, workingStyle.maxzoom);
			scheduleSave();
		}
	);
	content.appendChild(maxZoomRow);
	const maxZoomSlider = maxZoomRow.querySelector('input') as HTMLInputElement;
	const maxZoomDisplay = maxZoomRow.querySelector('.style-value') as HTMLSpanElement;

	// ── Labels section (skip for PMTiles - no property keys in DuckDB) ──

	if (dataset.format !== 'pmtiles') {
		const geometryTypes = await getDistinctGeometryTypes(dataset.id);
		const labelFragment = await buildLabelSection(map, dataset, workingStyle, currentStyle, geometryTypes, scheduleSave);
		content.appendChild(labelFragment);
	}

	panelElement.appendChild(content);

	// Set up pending save for auto-save on leave
	pendingSave = async () => {
		const hasChanges =
			workingStyle.fillOpacity !== currentStyle.fillOpacity ||
			workingStyle.lineOpacity !== currentStyle.lineOpacity ||
			workingStyle.pointOpacity !== currentStyle.pointOpacity ||
			workingStyle.lineWidth !== currentStyle.lineWidth ||
			workingStyle.pointRadius !== currentStyle.pointRadius ||
			workingStyle.labelField !== currentStyle.labelField ||
			workingStyle.labelSize !== currentStyle.labelSize ||
			workingStyle.labelColor !== currentStyle.labelColor ||
			workingStyle.labelHaloColor !== currentStyle.labelHaloColor ||
			workingStyle.labelHaloWidth !== currentStyle.labelHaloWidth ||
			workingStyle.labelMinzoom !== currentStyle.labelMinzoom ||
			workingStyle.labelMaxzoom !== currentStyle.labelMaxzoom ||
			workingStyle.minzoom !== currentStyle.minzoom ||
			workingStyle.maxzoom !== currentStyle.maxzoom;

		if (hasChanges) {
			progressControl.updateProgress(dataset.name, 'processing', 'Saving style');
			const success = await updateDatasetStyle(dataset.id, workingStyle);
			if (success) {
				progressControl.updateProgress(dataset.name, 'success', 'Style saved');
				progressControl.scheduleIdle(2000);
			} else {
				progressControl.updateProgress(dataset.name, 'error', 'Failed to save style');
			}
		}
	};

	// Back button handler
	backBtn.addEventListener('click', (e) => {
		e.stopPropagation();
		onBack();
	});
}
