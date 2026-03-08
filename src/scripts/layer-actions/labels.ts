/**
 * Label controls for the layer style panel.
 * Builds the label section: field dropdown, size, color, halo, zoom range.
 */

import maplibregl from 'maplibre-gl';
import type { StyleConfig } from '../db/datasets';
import { getPropertyKeys } from '../db/features';
import { addLabelLayer, removeLabelLayer, getLabelLayerId, getLayersBySource } from '../layers/layers';
import { getSourceId } from '../layers/sources';
import { createSliderRow } from './style';
import type { Dataset } from './layer-row';

/**
 * Detect a label field from a config-defined symbol layer on the map.
 * Scans for symbol layers (excluding the default label layer) using this dataset's source.
 * Only detects simple ["get", "fieldName"] expressions.
 * Returns the field name and the config layer ID so sub-controls can target it.
 */
function detectConfigLabelField(
	map: maplibregl.Map,
	datasetId: string
): { fieldName: string; layerId: string } | null {
	const sourceId = getSourceId(datasetId);
	const defaultLabelId = getLabelLayerId(datasetId);
	const layers = getLayersBySource(map, sourceId);

	for (const layer of layers) {
		if (layer.type !== 'symbol' || layer.id === defaultLabelId) continue;

		const textField = map.getLayoutProperty(layer.id, 'text-field');
		if (
			Array.isArray(textField) &&
			textField.length === 2 &&
			textField[0] === 'get' &&
			typeof textField[1] === 'string'
		) {
			return { fieldName: textField[1], layerId: layer.id };
		}
	}

	return null;
}

/**
 * Create a simple color row for label properties (no expression awareness needed).
 */
function createLabelColorRow(
	labelText: string,
	currentColor: string,
	onChange: (newColor: string) => void
): HTMLDivElement {
	const row = document.createElement('div');
	row.className = 'style-row style-color-row';

	const label = document.createElement('span');
	label.className = 'style-label';
	label.textContent = labelText;

	const swatchContainer = document.createElement('div');
	swatchContainer.className = 'style-color-swatch-container';

	const swatch = document.createElement('input');
	swatch.type = 'color';
	swatch.className = 'style-color-swatch';
	swatch.value = currentColor;

	const hexDisplay = document.createElement('span');
	hexDisplay.className = 'style-value';
	hexDisplay.textContent = currentColor;

	swatch.addEventListener('input', () => {
		hexDisplay.textContent = swatch.value;
	});

	swatch.addEventListener('change', () => {
		const newColor = swatch.value;
		hexDisplay.textContent = newColor;
		onChange(newColor);
	});

	swatchContainer.appendChild(swatch);
	row.appendChild(label);
	row.appendChild(swatchContainer);
	row.appendChild(hexDisplay);

	return row;
}

/**
 * Build the labels section for the style panel.
 * Returns a document fragment containing the section divider, field dropdown, and label sub-controls.
 */
export async function buildLabelSection(
	map: maplibregl.Map,
	dataset: Dataset,
	workingStyle: StyleConfig,
	currentStyle: StyleConfig,
	geometryTypes: Set<string>,
	scheduleSave: () => void
): Promise<DocumentFragment> {
	const fragment = document.createDocumentFragment();

	// Section divider
	const divider = document.createElement('div');
	divider.className = 'style-section-divider';
	divider.textContent = 'Labels';
	fragment.appendChild(divider);

	// Attribute dropdown
	const fieldRow = document.createElement('div');
	fieldRow.className = 'style-row';

	const fieldLabel = document.createElement('span');
	fieldLabel.className = 'style-label';
	fieldLabel.textContent = 'Field';

	const fieldSelect = document.createElement('select');
	fieldSelect.className = 'style-select';

	const noneOption = document.createElement('option');
	noneOption.value = '';
	noneOption.textContent = 'None';
	fieldSelect.appendChild(noneOption);

	// Detect label field from config-defined symbol layer if not in DB style
	const configLabel = !currentStyle.labelField
		? detectConfigLabelField(map, dataset.id)
		: null;
	const activeLabelField = currentStyle.labelField || configLabel?.fieldName || null;

	// Resolve which layer ID to target for live updates:
	// config-defined symbol layer (e.g. "lrt-labels") or default label layer ("dataset-{id}-label")
	const targetLabelLayerId = configLabel?.layerId ?? getLabelLayerId(dataset.id);

	const propertyKeys = await getPropertyKeys(dataset.id);
	for (const key of propertyKeys) {
		const option = document.createElement('option');
		option.value = key;
		option.textContent = key;
		if (key === activeLabelField) {
			option.selected = true;
		}
		fieldSelect.appendChild(option);
	}

	fieldRow.appendChild(fieldLabel);
	fieldRow.appendChild(fieldSelect);
	fragment.appendChild(fieldRow);

	// Label sub-controls container (shown only when a field is selected)
	const labelControls = document.createElement('div');
	labelControls.className = 'style-label-controls';
	if (!activeLabelField) {
		labelControls.style.display = 'none';
	}

	/** Update a paint or layout property on the active label layer */
	const setLabelProp = (kind: 'paint' | 'layout', property: string, value: unknown) => {
		if (!map.getLayer(targetLabelLayerId)) return;
		if (kind === 'paint') {
			map.setPaintProperty(targetLabelLayerId, property, value);
		} else {
			map.setLayoutProperty(targetLabelLayerId, property, value);
		}
	};

	// Label size slider
	const sizeRow = createSliderRow(
		{ property: 'pointRadius', label: 'Size', min: 8, max: 24, step: 1, unit: 'px', format: (v) => `${v}px`, requiredGeometry: 'hasFill' },
		currentStyle.labelSize,
		(newValue) => {
			workingStyle.labelSize = newValue;
			setLabelProp('layout', 'text-size', newValue);
			scheduleSave();
		}
	);
	labelControls.appendChild(sizeRow);

	// Label color
	const labelColorRow = createLabelColorRow('Color', currentStyle.labelColor, (newColor) => {
		workingStyle.labelColor = newColor;
		setLabelProp('paint', 'text-color', newColor);
		scheduleSave();
	});
	labelControls.appendChild(labelColorRow);

	// Halo color
	const haloColorRow = createLabelColorRow('Halo', currentStyle.labelHaloColor, (newColor) => {
		workingStyle.labelHaloColor = newColor;
		setLabelProp('paint', 'text-halo-color', newColor);
		scheduleSave();
	});
	labelControls.appendChild(haloColorRow);

	// Halo width slider
	const haloWidthRow = createSliderRow(
		{ property: 'pointRadius', label: 'Halo Width', min: 0, max: 3, step: 0.5, unit: 'px', format: (v) => `${v}px`, requiredGeometry: 'hasFill' },
		currentStyle.labelHaloWidth,
		(newValue) => {
			workingStyle.labelHaloWidth = newValue;
			setLabelProp('paint', 'text-halo-width', newValue);
			scheduleSave();
		}
	);
	labelControls.appendChild(haloWidthRow);

	// Label min zoom slider
	const labelMinZoomRow = createSliderRow(
		{ property: 'pointRadius', label: 'Min Zoom', min: 0, max: 24, step: 1, unit: '', format: (v) => `${v}`, requiredGeometry: 'hasFill' },
		currentStyle.labelMinzoom,
		(newValue) => {
			workingStyle.labelMinzoom = newValue;
			if (newValue > workingStyle.labelMaxzoom) {
				workingStyle.labelMaxzoom = newValue;
				labelMaxZoomSlider.value = String(newValue);
				labelMaxZoomDisplay.textContent = `${newValue}`;
			}
			if (map.getLayer(targetLabelLayerId)) {
				map.setLayerZoomRange(targetLabelLayerId, workingStyle.labelMinzoom, workingStyle.labelMaxzoom);
			}
			scheduleSave();
		}
	);
	labelControls.appendChild(labelMinZoomRow);
	const labelMinZoomSlider = labelMinZoomRow.querySelector('input') as HTMLInputElement;
	const labelMinZoomDisplay = labelMinZoomRow.querySelector('.style-value') as HTMLSpanElement;

	// Label max zoom slider
	const labelMaxZoomRow = createSliderRow(
		{ property: 'pointRadius', label: 'Max Zoom', min: 0, max: 24, step: 1, unit: '', format: (v) => `${v}`, requiredGeometry: 'hasFill' },
		currentStyle.labelMaxzoom,
		(newValue) => {
			workingStyle.labelMaxzoom = newValue;
			if (newValue < workingStyle.labelMinzoom) {
				workingStyle.labelMinzoom = newValue;
				labelMinZoomSlider.value = String(newValue);
				labelMinZoomDisplay.textContent = `${newValue}`;
			}
			if (map.getLayer(targetLabelLayerId)) {
				map.setLayerZoomRange(targetLabelLayerId, workingStyle.labelMinzoom, workingStyle.labelMaxzoom);
			}
			scheduleSave();
		}
	);
	labelControls.appendChild(labelMaxZoomRow);
	const labelMaxZoomSlider = labelMaxZoomRow.querySelector('input') as HTMLInputElement;
	const labelMaxZoomDisplay = labelMaxZoomRow.querySelector('.style-value') as HTMLSpanElement;

	fragment.appendChild(labelControls);

	// Dropdown change handler
	fieldSelect.addEventListener('change', () => {
		const selected = fieldSelect.value || null;
		workingStyle.labelField = selected;

		if (selected) {
			addLabelLayer(map, dataset.id, workingStyle, geometryTypes);
			labelControls.style.display = '';
		} else {
			removeLabelLayer(map, dataset.id);
			labelControls.style.display = 'none';
		}
		scheduleSave();
	});

	return fragment;
}
