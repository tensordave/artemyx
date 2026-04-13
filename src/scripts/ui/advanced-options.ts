/**
 * Shared advanced options row for DataControl and UploadControl.
 * Builds a collapsible options panel with format, CRS, and column overrides.
 */

import { gearIcon } from '../icons';
import type { ConfigFormat } from '../loaders/types';
import type { RendererType } from '../config/types';

/** Values returned by the advanced options panel */
export interface AdvancedOptionsValues {
	format?: ConfigFormat;
	renderer?: RendererType;
	crs?: string;
	latColumn?: string;
	lngColumn?: string;
	geoColumn?: string;
	/** When true, skip geometry detection and load as table-only dataset */
	tableOnly?: boolean;
}

/** Result of building the advanced options panel */
export interface AdvancedOptionsHandle {
	/** The root element to insert into the parent panel */
	element: HTMLDivElement;
	/** Read current option values (undefined for empty/default fields) */
	getValues(): AdvancedOptionsValues;
	/** Reset all fields to defaults */
	reset(): void;
}

/** Matches authority:code CRS identifiers (EPSG:4326, CRS:84, ESRI:102001, etc.) */
const CRS_PATTERN = /^[A-Za-z]+:\S+$/;

/**
 * Build an advanced options row with toggle, format select, CRS input,
 * and lat/lng/geo column inputs with mutual exclusivity.
 */
export function buildAdvancedOptions(): AdvancedOptionsHandle {
	// Root wrapper
	const wrapper = document.createElement('div');
	wrapper.className = 'advanced-options-wrapper';

	// Toggle button
	const toggle = document.createElement('button');
	toggle.type = 'button';
	toggle.className = 'advanced-options-toggle';
	toggle.innerHTML = gearIcon + '<span>Options</span>';
	toggle.title = 'Advanced loading options';
	toggle.setAttribute('aria-label', 'Advanced loading options');
	toggle.setAttribute('aria-expanded', 'false');
	wrapper.appendChild(toggle);

	// Collapsible body
	const body = document.createElement('div');
	body.className = 'advanced-options';
	wrapper.appendChild(body);

	// -- Format select --
	const formatGroup = makeFieldGroup('Format');
	const formatSelect = document.createElement('select');
	formatSelect.className = 'advanced-options-select';
	for (const [value, label] of [['', 'Auto-detect'], ['geojson', 'GeoJSON'], ['csv', 'CSV'], ['geoparquet', 'GeoParquet']] as const) {
		const opt = document.createElement('option');
		opt.value = value;
		opt.textContent = label;
		formatSelect.appendChild(opt);
	}
	formatGroup.appendChild(formatSelect);
	body.appendChild(formatGroup);

	// -- Table only checkbox --
	const tableOnlyGroup = document.createElement('div');
	tableOnlyGroup.className = 'advanced-options-field advanced-options-field--checkbox';
	const tableOnlyLabel = document.createElement('label');
	tableOnlyLabel.className = 'advanced-options-label advanced-options-label--checkbox';
	const tableOnlyCheckbox = document.createElement('input');
	tableOnlyCheckbox.type = 'checkbox';
	tableOnlyCheckbox.className = 'advanced-options-checkbox';
	tableOnlyLabel.appendChild(tableOnlyCheckbox);
	tableOnlyLabel.appendChild(document.createTextNode(' Table only'));
	tableOnlyGroup.appendChild(tableOnlyLabel);
	const tableOnlyHint = document.createElement('span');
	tableOnlyHint.className = 'advanced-options-hint';
	tableOnlyHint.textContent = 'Skip geometry detection, load as tabular data';
	tableOnlyGroup.appendChild(tableOnlyHint);
	body.appendChild(tableOnlyGroup);

	// -- Renderer select --
	const rendererGroup = makeFieldGroup('Renderer');
	const rendererSelect = document.createElement('select');
	rendererSelect.className = 'advanced-options-select';
	for (const [value, label] of [['', 'Auto'], ['maplibre', 'MapLibre'], ['deckgl', 'deck.gl']] as const) {
		const opt = document.createElement('option');
		opt.value = value;
		opt.textContent = label;
		rendererSelect.appendChild(opt);
	}
	rendererGroup.appendChild(rendererSelect);
	body.appendChild(rendererGroup);

	// -- CRS input --
	const crsGroup = makeFieldGroup('CRS');
	const crsInput = document.createElement('input');
	crsInput.type = 'text';
	crsInput.className = 'advanced-options-input';
	crsInput.placeholder = 'e.g. EPSG:3005, CRS:84';
	crsGroup.appendChild(crsInput);

	const crsHint = document.createElement('span');
	crsHint.className = 'advanced-options-hint';
	crsGroup.appendChild(crsHint);
	body.appendChild(crsGroup);

	// -- Column overrides --
	const colSection = document.createElement('div');
	colSection.className = 'advanced-options-columns';

	const latGroup = makeFieldGroup('Lat column');
	const latInput = document.createElement('input');
	latInput.type = 'text';
	latInput.className = 'advanced-options-input';
	latInput.placeholder = 'e.g. latitude';
	latGroup.appendChild(latInput);
	colSection.appendChild(latGroup);

	const lngGroup = makeFieldGroup('Lng column');
	const lngInput = document.createElement('input');
	lngInput.type = 'text';
	lngInput.className = 'advanced-options-input';
	lngInput.placeholder = 'e.g. longitude';
	lngGroup.appendChild(lngInput);
	colSection.appendChild(lngGroup);

	const geoGroup = makeFieldGroup('Geo column');
	const geoInput = document.createElement('input');
	geoInput.type = 'text';
	geoInput.className = 'advanced-options-input';
	geoInput.placeholder = 'e.g. geo_point_2d';
	geoGroup.appendChild(geoInput);
	colSection.appendChild(geoGroup);

	body.appendChild(colSection);

	// -- Toggle visibility --
	toggle.addEventListener('click', () => {
		const isOpen = body.classList.toggle('advanced-options--open');
		toggle.classList.toggle('advanced-options-toggle--open');
		toggle.setAttribute('aria-expanded', String(isOpen));
	});

	// -- CRS validation --
	crsInput.addEventListener('input', () => {
		const val = crsInput.value.trim();
		if (!val) {
			crsInput.classList.remove('advanced-options-input--invalid');
			crsHint.textContent = '';
		} else if (CRS_PATTERN.test(val)) {
			crsInput.classList.remove('advanced-options-input--invalid');
			crsHint.textContent = '';
		} else {
			crsInput.classList.add('advanced-options-input--invalid');
			crsHint.textContent = 'Expected format: AUTHORITY:CODE (e.g. EPSG:4326, CRS:84)';
		}
	});

	// -- Mutual exclusivity: geoColumn vs latColumn/lngColumn, and tableOnly disables spatial fields --
	const updateColumnExclusivity = () => {
		const isTableOnly = tableOnlyCheckbox.checked;
		const geoHasValue = geoInput.value.trim().length > 0;
		const latLngHasValue = latInput.value.trim().length > 0 || lngInput.value.trim().length > 0;

		// Table-only mode disables all spatial-related fields
		crsInput.disabled = isTableOnly;
		rendererSelect.disabled = isTableOnly;
		latInput.disabled = isTableOnly || geoHasValue;
		lngInput.disabled = isTableOnly || geoHasValue;
		geoInput.disabled = isTableOnly || latLngHasValue;
	};

	latInput.addEventListener('input', updateColumnExclusivity);
	lngInput.addEventListener('input', updateColumnExclusivity);
	geoInput.addEventListener('input', updateColumnExclusivity);
	tableOnlyCheckbox.addEventListener('change', updateColumnExclusivity);

	// -- Public API --
	function getValues(): AdvancedOptionsValues {
		const values: AdvancedOptionsValues = {};

		if (tableOnlyCheckbox.checked) values.tableOnly = true;

		const format = formatSelect.value as ConfigFormat | '';
		if (format) values.format = format;

		const renderer = rendererSelect.value as RendererType | '';
		if (renderer) values.renderer = renderer;

		const crs = crsInput.value.trim();
		if (crs && CRS_PATTERN.test(crs)) values.crs = crs;

		const lat = latInput.value.trim();
		if (lat) values.latColumn = lat;

		const lng = lngInput.value.trim();
		if (lng) values.lngColumn = lng;

		const geo = geoInput.value.trim();
		if (geo) values.geoColumn = geo;

		return values;
	}

	function reset() {
		tableOnlyCheckbox.checked = false;
		formatSelect.value = '';
		rendererSelect.value = '';
		crsInput.value = '';
		crsInput.classList.remove('advanced-options-input--invalid');
		crsHint.textContent = '';
		latInput.value = '';
		lngInput.value = '';
		geoInput.value = '';
		crsInput.disabled = false;
		rendererSelect.disabled = false;
		latInput.disabled = false;
		lngInput.disabled = false;
		geoInput.disabled = false;
		body.classList.remove('advanced-options--open');
		toggle.classList.remove('advanced-options-toggle--open');
		toggle.setAttribute('aria-expanded', 'false');
	}

	return { element: wrapper, getValues, reset };
}

/** Create a labeled field group */
function makeFieldGroup(labelText: string): HTMLDivElement {
	const group = document.createElement('div');
	group.className = 'advanced-options-field';
	const label = document.createElement('label');
	label.className = 'advanced-options-label';
	label.textContent = labelText;
	group.appendChild(label);
	return group;
}
