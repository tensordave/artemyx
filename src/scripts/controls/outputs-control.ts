import type { Map, IControl } from 'maplibre-gl';
import { boxArrowDownIcon, circleNotchIcon, codeBlockIcon, crosshairIcon, downloadSimpleIcon, playIcon } from '../icons';
import type { OutputResult } from '../config/output-types';
import { revokeOutputBlobs } from '../config/output-types';
import { executeOutputs, checkSourcesExist } from '../config/output-executor';
import { exportViewerZip } from '../config/export-viewer';
import { parseConfig, VALID_OUTPUT_FORMATS } from '../config/parser';
import { validateOutput } from '../config/validators/outputs';
import { addProgressListener, removeProgressListener, getDatasets } from '../db';
import type { ProgressListener } from '../db';
import { zipSync } from 'fflate';
import { createFocusTrap, type FocusTrap } from '../utils/focus-trap';
import yaml from 'js-yaml';
import { getHighlighter, highlightSync, highlightAsync } from '../utils/shiki';

function formatFileSize(bytes: number): string {
	if (bytes === 0) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB'];
	const i = Math.floor(Math.log(bytes) / Math.log(1024));
	return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

function downloadBlob(url: string, filename: string): void {
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
}

/** Dataset option for source dropdowns */
interface DatasetOption {
	id: string;
	name: string;
	format: string | null;
}

export interface OutputsControlOptions {
	getYaml: () => string;
	getBasemapId?: () => string;
	openConfigEditor?: () => void;
	updateYaml?: (yaml: string) => void;
}

export class OutputsControl implements IControl {
	private map: Map | null = null;
	private container: HTMLDivElement | null = null;
	private panel: HTMLDivElement | null = null;
	private isOpen = false;
	private mainBtn: HTMLButtonElement | null = null;
	private options: OutputsControlOptions;

	private outputResults: OutputResult[] = [];
	private isOutputsExecuting = false;
	private outputProgressListener: ProgressListener | null = null;
	private statusLineListener: ProgressListener | null = null;
	private pmtilesSourceIds: Set<string> = new Set();
	private outputsBody: HTMLDivElement | null = null;
	private configBtn: HTMLButtonElement | null = null;
	private runBtn: HTMLButtonElement | null = null;
	private exportViewerBtn: HTMLButtonElement | null = null;
	private statusLine: HTMLDivElement | null = null;
	private overallProgressBar: HTMLDivElement | null = null;

	// Panel lifecycle callbacks
	private onPanelOpen?: () => void;
	private onPanelClose?: () => void;
	private hasBeenDragged = false;

	// Builder state
	private builderCollapsed = true;
	private builderContainer: HTMLDivElement | null = null;
	private builderSection: HTMLDivElement | null = null;
	private formatSelect: HTMLSelectElement | null = null;
	private sourceContainer: HTMLDivElement | null = null;
	private paramsContainer: HTMLDivElement | null = null;
	private filenameInput: HTMLInputElement | null = null;
	private builderStatusEl: HTMLDivElement | null = null;
	private builderYamlContainer: HTMLElement | null = null;
	private builderYamlBody: HTMLElement | null = null;
	private builderYamlOpen = false;
	private updatePreviewTimer: ReturnType<typeof setTimeout> | null = null;
	private datasetOptions: DatasetOption[] = [];
	private sourceRowCount = 1;

	// Drag/resize state
	private isDragging = false;
	private isResizing = false;
	private dragStartX = 0;
	private dragStartY = 0;
	private panelStartX = 0;
	private panelStartY = 0;
	private panelStartW = 0;
	private panelStartH = 0;
	private hasBeenPositioned = false;
	private boundPointerMove: ((e: PointerEvent) => void) | null = null;
	private boundPointerUp: ((e: PointerEvent) => void) | null = null;

	private readonly MIN_WIDTH = 320;
	private readonly MIN_HEIGHT = 200;
	private focusTrap: FocusTrap | null = null;
	private previousFocus: HTMLElement | null = null;

	constructor(options: OutputsControlOptions) {
		this.options = options;
	}

	closePanel(): void {
		this.close();
	}

	setOnPanelOpen(cb: () => void): void {
		this.onPanelOpen = cb;
	}

	setOnPanelClose(cb: () => void): void {
		this.onPanelClose = cb;
	}

	getIsOpen(): boolean {
		return this.isOpen;
	}

	getHasBeenDragged(): boolean {
		return this.hasBeenDragged;
	}

	setPosition(left: number, top: number): void {
		if (!this.panel) return;
		this.ensurePositioned();
		this.panel.style.left = `${left}px`;
		this.panel.style.top = `${top}px`;
	}

	resetPosition(): void {
		if (!this.panel) return;
		this.panel.style.removeProperty('left');
		this.panel.style.removeProperty('top');
		this.panel.style.removeProperty('width');
		this.panel.style.removeProperty('height');
		this.panel.style.removeProperty('max-height');
		this.panel.classList.remove('outputs-panel--positioned');
		this.hasBeenPositioned = false;
	}

	/**
	 * Clear cached output results (e.g. on config re-run).
	 */
	clearResults(): void {
		revokeOutputBlobs(this.outputResults);
		this.outputResults = [];
		if (this.outputsBody) {
			this.renderBody();
		}
	}

	onAdd(map: Map): HTMLElement {
		this.map = map;

		this.container = document.createElement('div');
		this.container.className = 'maplibregl-ctrl outputs-control';

		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'control-btn';
		btn.title = 'Outputs (X)';
		btn.setAttribute('aria-label', 'Outputs');
		btn.setAttribute('aria-expanded', 'false');
		btn.innerHTML = boxArrowDownIcon;
		btn.addEventListener('click', () => this.togglePanel());
		this.mainBtn = btn;
		this.container.appendChild(btn);

		this.panel = this.buildPanel();
		map.getContainer().appendChild(this.panel);

		return this.container;
	}

	onRemove(): void {
		this.focusTrap?.deactivate();
		this.focusTrap = null;
		document.removeEventListener('keydown', this.handleEsc);
		if (this.boundPointerMove) document.removeEventListener('pointermove', this.boundPointerMove);
		if (this.boundPointerUp) document.removeEventListener('pointerup', this.boundPointerUp);
		if (this.outputProgressListener) {
			removeProgressListener(this.outputProgressListener);
			this.outputProgressListener = null;
		}
		if (this.statusLineListener) {
			removeProgressListener(this.statusLineListener);
			this.statusLineListener = null;
		}
		if (this.updatePreviewTimer !== null) clearTimeout(this.updatePreviewTimer);
		revokeOutputBlobs(this.outputResults);
		this.panel?.remove();
		this.container?.remove();
		this.map = null;
		this.mainBtn = null;
		this.builderSection = null;
		this.builderContainer = null;
		this.formatSelect = null;
		this.sourceContainer = null;
		this.paramsContainer = null;
		this.filenameInput = null;
		this.builderStatusEl = null;
		this.builderYamlContainer = null;
		this.builderYamlBody = null;
	}

	private handleEsc = (e: KeyboardEvent) => {
		if (e.key === 'Escape') this.close();
	};

	private buildPanel(): HTMLDivElement {
		const panel = document.createElement('div');
		panel.className = 'outputs-panel';

		// Header
		const header = document.createElement('div');
		header.className = 'outputs-panel-header';

		const title = document.createElement('span');
		title.className = 'outputs-panel-title';
		title.textContent = 'Outputs';
		header.appendChild(title);

		const closeBtn = document.createElement('button');
		closeBtn.type = 'button';
		closeBtn.className = 'outputs-panel-close';
		closeBtn.textContent = '\u00d7';
		closeBtn.title = 'Close (Esc)';
		closeBtn.setAttribute('aria-label', 'Close outputs panel');
		closeBtn.addEventListener('click', () => this.close());
		header.appendChild(closeBtn);

		header.addEventListener('pointerdown', (e) => this.onDragStart(e));
		panel.appendChild(header);

		// Scroll wrapper (builder + body share one scroll container)
		const scroll = document.createElement('div');
		scroll.className = 'outputs-scroll';

		// Builder section (persists across renderBody calls)
		this.builderSection = this.buildBuilderSection();
		scroll.appendChild(this.builderSection);

		const builderDivider = document.createElement('div');
		builderDivider.className = 'outputs-divider';
		scroll.appendChild(builderDivider);

		// Body
		this.outputsBody = document.createElement('div');
		this.outputsBody.className = 'outputs-body';
		this.renderBody();
		scroll.appendChild(this.outputsBody);

		panel.appendChild(scroll);

		// Resize handle
		const resizeHandle = document.createElement('div');
		resizeHandle.className = 'outputs-resize-handle';
		resizeHandle.addEventListener('pointerdown', (e) => this.onResizeStart(e));
		panel.appendChild(resizeHandle);

		return panel;
	}

	// ── Builder section ─────────────────────────────────────────────

	private buildBuilderSection(): HTMLDivElement {
		const section = document.createElement('div');
		section.className = 'outputs-builder-section';

		// Toggle header
		const toggle = document.createElement('div');
		toggle.className = 'outputs-builder-toggle';
		toggle.setAttribute('role', 'button');
		toggle.setAttribute('aria-expanded', 'false');
		const chevron = document.createElement('span');
		chevron.className = 'outputs-builder-chevron';
		chevron.textContent = '\u25b8';
		toggle.appendChild(chevron);
		toggle.appendChild(document.createTextNode('Add Output'));
		toggle.addEventListener('click', () => {
			this.builderCollapsed = !this.builderCollapsed;
			chevron.classList.toggle('outputs-builder-chevron--open', !this.builderCollapsed);
			this.builderContainer?.classList.toggle('outputs-builder--open', !this.builderCollapsed);
			toggle.setAttribute('aria-expanded', String(!this.builderCollapsed));
			if (!this.builderCollapsed) {
				this.populateDatasetOptions().then(() => this.renderSourceSection());
			}
		});
		section.appendChild(toggle);

		// Collapsible body
		this.builderContainer = document.createElement('div');
		this.builderContainer.className = 'outputs-builder';

		// Format
		this.builderContainer.appendChild(this.buildField('Format', () => {
			this.formatSelect = document.createElement('select');
			this.formatSelect.className = 'ob-select';
			for (const fmt of VALID_OUTPUT_FORMATS) {
				const opt = document.createElement('option');
				opt.value = fmt;
				opt.textContent = fmt.toUpperCase();
				this.formatSelect.appendChild(opt);
			}
			this.formatSelect.addEventListener('change', () => {
				this.renderSourceSection();
				this.renderParamsSection();
				this.clearBuilderStatus();
				this.schedulePreviewUpdate();
			});
			return this.formatSelect;
		}));

		// Source
		this.sourceContainer = document.createElement('div');
		this.builderContainer.appendChild(this.sourceContainer);

		// Params (PMTiles-specific)
		this.paramsContainer = document.createElement('div');
		this.paramsContainer.addEventListener('input', () => { this.clearBuilderStatus(); this.schedulePreviewUpdate(); });
		this.paramsContainer.addEventListener('change', () => { this.clearBuilderStatus(); this.schedulePreviewUpdate(); });
		this.builderContainer.appendChild(this.paramsContainer);

		// Filename
		this.builderContainer.appendChild(this.buildField('Filename (optional)', () => {
			this.filenameInput = document.createElement('input');
			this.filenameInput.type = 'text';
			this.filenameInput.className = 'ob-text-input';
			this.filenameInput.placeholder = 'defaults to source ID';
			this.filenameInput.addEventListener('input', () => { this.clearBuilderStatus(); this.schedulePreviewUpdate(); });
			return this.filenameInput;
		}));

		// YAML preview toggle
		const yamlToggle = document.createElement('div');
		yamlToggle.className = 'ob-yaml-toggle';
		const yamlChevron = document.createElement('span');
		yamlChevron.className = 'ob-yaml-chevron';
		yamlChevron.textContent = '\u25b8';
		yamlToggle.appendChild(yamlChevron);
		yamlToggle.appendChild(document.createTextNode('YAML Preview'));
		yamlToggle.addEventListener('click', () => {
			this.builderYamlOpen = !this.builderYamlOpen;
			yamlChevron.classList.toggle('ob-yaml-chevron--open', this.builderYamlOpen);
			this.builderYamlContainer?.classList.toggle('ob-yaml-preview--open', this.builderYamlOpen);
			if (this.builderYamlOpen) this.updateYamlPreview();
		});
		this.builderContainer.appendChild(yamlToggle);

		this.builderYamlContainer = document.createElement('div');
		this.builderYamlContainer.className = 'ob-yaml-preview';
		this.builderYamlBody = document.createElement('div');
		this.builderYamlContainer.appendChild(this.builderYamlBody);
		this.builderContainer.appendChild(this.builderYamlContainer);

		// Status
		this.builderStatusEl = document.createElement('div');
		this.builderStatusEl.className = 'ob-status';
		this.builderStatusEl.style.display = 'none';
		this.builderContainer.appendChild(this.builderStatusEl);

		// Add to Config button
		const addBtn = document.createElement('button');
		addBtn.type = 'button';
		addBtn.className = 'outputs-add-btn';
		addBtn.textContent = 'Add to Config';
		addBtn.addEventListener('click', () => this.handleAddToConfig());
		this.builderContainer.appendChild(addBtn);

		section.appendChild(this.builderContainer);

		// Initial render
		this.renderSourceSection();
		this.renderParamsSection();

		return section;
	}

	private buildField(label: string, buildInput: () => HTMLElement): HTMLElement {
		const field = document.createElement('div');
		field.className = 'ob-field';
		const lbl = document.createElement('label');
		lbl.className = 'ob-label';
		lbl.textContent = label;
		field.appendChild(lbl);
		field.appendChild(buildInput());
		return field;
	}

	private getSelectedFormat(): string {
		return this.formatSelect?.value ?? 'geojson';
	}

	private isPMTilesFormat(): boolean {
		return this.getSelectedFormat() === 'pmtiles';
	}

	// ── Source section ───────────────────────────────────────────────

	private renderSourceSection(): void {
		if (!this.sourceContainer) return;

		// Snapshot current selections before rebuilding
		const savedSelections = this.getSelectedSources();

		this.sourceContainer.innerHTML = '';

		if (this.isPMTilesFormat()) {
			// Multi-source mode
			const label = document.createElement('label');
			label.className = 'ob-label';
			label.textContent = 'Source(s)';
			this.sourceContainer.appendChild(label);

			const rowsContainer = document.createElement('div');
			rowsContainer.dataset.role = 'source-rows';
			this.sourceContainer.appendChild(rowsContainer);

			// Ensure at least one row
			if (this.sourceRowCount < 1) this.sourceRowCount = 1;
			for (let i = 0; i < this.sourceRowCount; i++) {
				rowsContainer.appendChild(this.buildSourceRow(i, savedSelections[i]));
			}

			const addSourceBtn = document.createElement('button');
			addSourceBtn.type = 'button';
			addSourceBtn.className = 'outputs-add-source-btn';
			addSourceBtn.textContent = '+ Add source';
			addSourceBtn.addEventListener('click', () => {
				this.sourceRowCount++;
				this.renderSourceSection();
				this.renderParamsSection();
				this.schedulePreviewUpdate();
			});
			this.sourceContainer.appendChild(addSourceBtn);
		} else {
			// Single-source mode
			this.sourceRowCount = 1;
			const restoredValue = savedSelections[0];
			this.sourceContainer.appendChild(this.buildField('Source', () => {
				return this.buildSourceSelect('source-0', restoredValue);
			}));
		}
		this.focusTrap?.updateElements();
	}

	private buildSourceRow(index: number, savedValue?: string): HTMLDivElement {
		const row = document.createElement('div');
		row.className = 'outputs-source-row';

		row.appendChild(this.buildSourceSelect(`source-${index}`, savedValue));

		const removeBtn = document.createElement('button');
		removeBtn.type = 'button';
		removeBtn.className = 'outputs-source-remove';
		removeBtn.textContent = '\u00d7';
		removeBtn.title = 'Remove source';
		removeBtn.disabled = this.sourceRowCount <= 1;
		removeBtn.addEventListener('click', () => {
			if (this.sourceRowCount <= 1) return;
			this.sourceRowCount--;
			this.renderSourceSection();
			this.renderParamsSection();
			this.schedulePreviewUpdate();
		});
		row.appendChild(removeBtn);

		return row;
	}

	private buildSourceSelect(name: string, savedValue?: string): HTMLSelectElement {
		const select = document.createElement('select');
		select.className = 'ob-select';
		select.dataset.name = name;

		const placeholder = document.createElement('option');
		placeholder.value = '';
		placeholder.textContent = '-- Select dataset --';
		placeholder.disabled = true;
		placeholder.selected = true;
		select.appendChild(placeholder);

		for (const ds of this.datasetOptions) {
			const opt = document.createElement('option');
			opt.value = ds.id;
			opt.textContent = ds.name;
			select.appendChild(opt);
		}

		if (savedValue) select.value = savedValue;

		select.addEventListener('change', () => {
			this.clearBuilderStatus();
			this.renderParamsSection();
			this.schedulePreviewUpdate();
		});
		return select;
	}

	private getSelectedSources(): string[] {
		if (!this.sourceContainer) return [];
		const selects = this.sourceContainer.querySelectorAll<HTMLSelectElement>('select[data-name^="source-"]');
		const sources: string[] = [];
		for (const s of selects) {
			if (s.value) sources.push(s.value);
		}
		return sources;
	}

	private hasAnyPMTilesSource(): boolean {
		const sources = this.getSelectedSources();
		return sources.some(s => this.datasetOptions.find(d => d.id === s)?.format === 'pmtiles');
	}

	// ── Params section ──────────────────────────────────────────────

	private renderParamsSection(): void {
		if (!this.paramsContainer) return;
		this.paramsContainer.innerHTML = '';

		if (!this.isPMTilesFormat()) return;

		// Minzoom / Maxzoom row
		const zoomRow = document.createElement('div');
		zoomRow.className = 'ob-field ob-row';

		const minField = document.createElement('div');
		const minLabel = document.createElement('label');
		minLabel.className = 'ob-label';
		minLabel.textContent = 'Min zoom';
		const minInput = document.createElement('input');
		minInput.type = 'number';
		minInput.className = 'ob-number-input';
		minInput.dataset.param = 'minzoom';
		minInput.placeholder = '0';
		minInput.min = '0';
		minInput.max = '22';
		minInput.step = '1';
		minField.appendChild(minLabel);
		minField.appendChild(minInput);
		zoomRow.appendChild(minField);

		const maxField = document.createElement('div');
		const maxLabel = document.createElement('label');
		maxLabel.className = 'ob-label';
		maxLabel.textContent = 'Max zoom';
		const maxInput = document.createElement('input');
		maxInput.type = 'number';
		maxInput.className = 'ob-number-input';
		maxInput.dataset.param = 'maxzoom';
		maxInput.placeholder = '14';
		maxInput.min = '0';
		maxInput.max = '22';
		maxInput.step = '1';
		maxField.appendChild(maxLabel);
		maxField.appendChild(maxInput);
		zoomRow.appendChild(maxField);

		this.paramsContainer.appendChild(zoomRow);

		// Layer name (hidden when multi-source since each source auto-becomes a layer)
		if (this.sourceRowCount <= 1) {
			this.paramsContainer.appendChild(this.buildField('Layer name (optional)', () => {
				const input = document.createElement('input');
				input.type = 'text';
				input.className = 'ob-text-input';
				input.dataset.param = 'layerName';
				input.placeholder = 'defaults to source ID';
				return input;
			}));
		}

		// Extract zoom (shown when source is a PMTiles dataset)
		if (this.hasAnyPMTilesSource()) {
			this.paramsContainer.appendChild(this.buildField('Extract zoom (required for PMTiles source)', () => {
				const input = document.createElement('input');
				input.type = 'number';
				input.className = 'ob-number-input';
				input.dataset.param = 'extractZoom';
				input.placeholder = '10';
				input.min = '0';
				input.max = '22';
				input.step = '1';
				return input;
			}));
		}

		// Bounding box
		const bboxLabel = document.createElement('label');
		bboxLabel.className = 'ob-label';
		bboxLabel.textContent = 'Bounding box (optional)';
		this.paramsContainer.appendChild(bboxLabel);

		const bboxGrid = document.createElement('div');
		bboxGrid.className = 'outputs-bbox-grid';

		const bboxFields: Array<{ param: string; placeholder: string }> = [
			{ param: 'bbox-west', placeholder: 'West' },
			{ param: 'bbox-south', placeholder: 'South' },
			{ param: 'bbox-east', placeholder: 'East' },
			{ param: 'bbox-north', placeholder: 'North' },
		];

		for (const bf of bboxFields) {
			const input = document.createElement('input');
			input.type = 'number';
			input.className = 'ob-number-input';
			input.dataset.param = bf.param;
			input.placeholder = bf.placeholder;
			input.step = 'any';
			bboxGrid.appendChild(input);
		}
		this.paramsContainer.appendChild(bboxGrid);

		const bboxAction = document.createElement('div');
		bboxAction.className = 'outputs-bbox-action';
		const viewBtn = document.createElement('button');
		viewBtn.type = 'button';
		viewBtn.className = 'outputs-bbox-btn';
		viewBtn.innerHTML = `${crosshairIcon}<span>Use current view</span>`;
		viewBtn.addEventListener('click', () => this.handleBboxFromView());
		bboxAction.appendChild(viewBtn);
		this.paramsContainer.appendChild(bboxAction);

		this.focusTrap?.updateElements();
	}

	// ── Bbox from viewport ──────────────────────────────────────────

	private handleBboxFromView(): void {
		if (!this.map) return;
		const bounds = this.map.getBounds();
		const setVal = (param: string, val: number) => {
			const el = this.paramsContainer?.querySelector<HTMLInputElement>(`[data-param="${param}"]`);
			if (el) el.value = String(Math.round(val * 1e6) / 1e6);
		};
		setVal('bbox-west', bounds.getWest());
		setVal('bbox-south', bounds.getSouth());
		setVal('bbox-east', bounds.getEast());
		setVal('bbox-north', bounds.getNorth());
		this.schedulePreviewUpdate();
	}

	// ── Build output config from form ───────────────────────────────

	private buildOutputConfig(): Record<string, unknown> {
		const format = this.getSelectedFormat();
		const sources = this.getSelectedSources();
		const source = (format === 'pmtiles' && sources.length > 1)
			? sources : sources[0] ?? '';

		const config: Record<string, unknown> = { source, format };

		const filename = this.filenameInput?.value.trim();
		if (filename) config.filename = filename;

		if (format === 'pmtiles') {
			const params = this.readPMTilesParams();
			if (params && Object.keys(params).length > 0) {
				config.params = params;
			}
		}

		return config;
	}

	private readPMTilesParams(): Record<string, unknown> | null {
		if (!this.paramsContainer) return null;

		const params: Record<string, unknown> = {};

		const getNum = (param: string): number | undefined => {
			const el = this.paramsContainer?.querySelector<HTMLInputElement>(`[data-param="${param}"]`);
			if (!el || el.value.trim() === '') return undefined;
			const n = Number(el.value);
			return Number.isFinite(n) ? n : undefined;
		};

		const getText = (param: string): string | undefined => {
			const el = this.paramsContainer?.querySelector<HTMLInputElement>(`[data-param="${param}"]`);
			const v = el?.value.trim();
			return v || undefined;
		};

		const minzoom = getNum('minzoom');
		const maxzoom = getNum('maxzoom');
		if (minzoom !== undefined) params.minzoom = minzoom;
		if (maxzoom !== undefined) params.maxzoom = maxzoom;

		const layerName = getText('layerName');
		if (layerName) params.layerName = layerName;

		const extractZoom = getNum('extractZoom');
		if (extractZoom !== undefined) params.extractZoom = extractZoom;

		// Bbox: only include if all 4 values present
		const west = getNum('bbox-west');
		const south = getNum('bbox-south');
		const east = getNum('bbox-east');
		const north = getNum('bbox-north');
		if (west !== undefined && south !== undefined && east !== undefined && north !== undefined) {
			params.bbox = [west, south, east, north];
		}

		return Object.keys(params).length > 0 ? params : null;
	}

	// ── YAML preview ────────────────────────────────────────────────

	private schedulePreviewUpdate(): void {
		if (this.updatePreviewTimer !== null) clearTimeout(this.updatePreviewTimer);
		this.updatePreviewTimer = setTimeout(() => this.updateYamlPreview(), 150);
	}

	private async updateYamlPreview(): Promise<void> {
		if (!this.builderYamlBody || !this.builderYamlOpen) return;

		const config = this.buildOutputConfig();
		const sources = Array.isArray(config.source) ? config.source as string[] : [config.source as string];
		if (sources.every(s => !s)) {
			this.builderYamlBody.innerHTML = '<p class="ob-yaml-placeholder">Fill in the form to see YAML</p>';
			return;
		}

		const yamlStr = yaml.dump({ outputs: [config] }, {
			lineWidth: -1,
			noRefs: true,
			quotingType: '"',
		});

		const html = highlightSync(yamlStr);
		if (html) {
			this.builderYamlBody.innerHTML = html;
		} else {
			this.builderYamlBody.innerHTML = await highlightAsync(yamlStr);
		}
	}

	// ── Add to Config ───────────────────────────────────────────────

	private handleAddToConfig(): void {
		const outputConfig = this.buildOutputConfig();

		// Validate sources are selected
		const sources = Array.isArray(outputConfig.source) ? outputConfig.source as string[] : [outputConfig.source as string];
		if (sources.length === 0 || sources.every(s => !s)) {
			this.showBuilderStatus('error', 'Select a source dataset');
			return;
		}

		// Structural validation via existing validator
		const errors = validateOutput(outputConfig, 0);
		if (errors.length > 0) {
			this.showBuilderStatus('error', errors[0]);
			return;
		}

		// Parse current YAML and append
		let currentYaml: string;
		try {
			currentYaml = this.options.getYaml();
		} catch {
			this.showBuilderStatus('error', 'Failed to read current config');
			return;
		}

		let parsed: Record<string, unknown>;
		try {
			parsed = (yaml.load(currentYaml) as Record<string, unknown>) ?? {};
		} catch {
			this.showBuilderStatus('error', 'Current config has invalid YAML');
			return;
		}

		if (!Array.isArray(parsed.outputs)) {
			parsed.outputs = [];
		}
		(parsed.outputs as unknown[]).push(outputConfig);

		const newYaml = yaml.dump(parsed, {
			lineWidth: -1,
			noRefs: true,
			quotingType: '"',
		});

		this.options.updateYaml?.(newYaml);
		this.showBuilderStatus('success', 'Output added to config');
		this.updateRunButtonState();

		// Reset filename for next entry
		if (this.filenameInput) this.filenameInput.value = '';
		this.schedulePreviewUpdate();
	}

	// ── Builder status ──────────────────────────────────────────────

	private showBuilderStatus(type: 'success' | 'error', message: string): void {
		if (!this.builderStatusEl) return;
		this.builderStatusEl.style.display = '';
		this.builderStatusEl.className = `ob-status ob-status--${type}`;
		this.builderStatusEl.textContent = message;
	}

	private clearBuilderStatus(): void {
		if (!this.builderStatusEl) return;
		this.builderStatusEl.style.display = 'none';
		this.builderStatusEl.textContent = '';
	}

	// ── Dataset options ─────────────────────────────────────────────

	private async populateDatasetOptions(): Promise<void> {
		try {
			const datasets = await getDatasets();
			this.datasetOptions = datasets.map((d: any) => ({
				id: d.id,
				name: d.name || d.id,
				format: d.format ?? null,
			}));
		} catch {
			this.datasetOptions = [];
		}
	}

	private renderBody(): void {
		if (!this.outputsBody) return;
		this.outputsBody.innerHTML = '';

		// ── Run Outputs section ──
		const outputsSection = document.createElement('div');
		outputsSection.className = 'outputs-section';

		// ── Button row (Config Editor + Run Outputs) ──
		const btnRow = document.createElement('div');
		btnRow.className = 'outputs-btn-row';

		this.configBtn = document.createElement('button');
		this.configBtn.type = 'button';
		this.configBtn.className = 'outputs-config-btn';
		this.configBtn.title = 'Config Editor';
		this.configBtn.setAttribute('aria-label', 'Open config editor');
		this.configBtn.innerHTML = codeBlockIcon;
		this.configBtn.addEventListener('click', () => {
			this.options.openConfigEditor?.();
		});
		btnRow.appendChild(this.configBtn);

		this.runBtn = document.createElement('button');
		this.runBtn.type = 'button';
		this.runBtn.className = 'outputs-run-btn';
		this.runBtn.innerHTML = `${playIcon}<span>Run Outputs</span>`;
		this.runBtn.addEventListener('click', () => this.handleRunOutputs());
		btnRow.appendChild(this.runBtn);

		outputsSection.appendChild(btnRow);
		this.updateRunButtonState();

		this.overallProgressBar = document.createElement('div');
		this.overallProgressBar.className = 'outputs-overall-progress-track';
		const overallFill = document.createElement('div');
		overallFill.className = 'outputs-overall-progress-fill';
		this.overallProgressBar.appendChild(overallFill);
		if (this.isOutputsExecuting) {
			this.overallProgressBar.classList.add('outputs-overall-progress-track--visible');
		}
		outputsSection.appendChild(this.overallProgressBar);

		this.statusLine = document.createElement('div');
		this.statusLine.className = 'outputs-status-line';
		outputsSection.appendChild(this.statusLine);

		// Results container
		const resultsContainer = document.createElement('div');
		resultsContainer.className = 'outputs-results';

		if (this.outputResults.length > 0) {
			for (let i = 0; i < this.outputResults.length; i++) {
				const row = this.renderOutputRow(this.outputResults[i]);
				row.setAttribute('data-output-index', String(i));
				resultsContainer.appendChild(row);
			}
			this.appendDownloadAll(resultsContainer);
		} else {
			const empty = document.createElement('div');
			empty.className = 'outputs-empty';
			empty.textContent = this.hasOutputsInConfig()
				? 'Click "Run Outputs" to generate files.'
				: 'No outputs defined in config.';
			resultsContainer.appendChild(empty);
		}

		outputsSection.appendChild(resultsContainer);
		this.outputsBody.appendChild(outputsSection);

		// ── Divider ──
		const divider = document.createElement('div');
		divider.className = 'outputs-divider';
		this.outputsBody.appendChild(divider);

		// ── Export Viewer section ──
		const exportSection = document.createElement('div');
		exportSection.className = 'outputs-export-section';

		const exportLabel = document.createElement('div');
		exportLabel.className = 'outputs-export-label';
		exportLabel.textContent = 'Export Viewer';
		exportSection.appendChild(exportLabel);

		this.exportViewerBtn = document.createElement('button');
		this.exportViewerBtn.type = 'button';
		this.exportViewerBtn.className = 'outputs-export-btn';
		this.exportViewerBtn.innerHTML = `${downloadSimpleIcon}<span>Export Viewer (.zip)</span>`;
		this.exportViewerBtn.addEventListener('click', () => this.handleExportViewer());
		exportSection.appendChild(this.exportViewerBtn);

		this.outputsBody.appendChild(exportSection);
		this.focusTrap?.updateElements();
	}

	private hasOutputsInConfig(): boolean {
		try {
			const config = parseConfig(this.options.getYaml());
			return !!(config.outputs && config.outputs.length > 0);
		} catch {
			return false;
		}
	}

	private updateRunButtonState(): void {
		if (!this.runBtn) return;
		const hasOutputs = this.hasOutputsInConfig();
		this.runBtn.disabled = !hasOutputs || this.isOutputsExecuting;

		// State-driven colors: guide user toward config when no outputs defined
		if (hasOutputs) {
			this.configBtn?.classList.remove('outputs-config-btn--primary');
			this.runBtn.classList.remove('outputs-run-btn--muted');
		} else {
			this.configBtn?.classList.add('outputs-config-btn--primary');
			this.runBtn.classList.add('outputs-run-btn--muted');
		}
	}

	private setStatusLine(text: string | null, status?: 'loading' | 'processing' | 'success' | 'error'): void {
		if (!this.statusLine) return;
		if (text) {
			const icon = (status === 'success')
				? `<span class="outputs-status-line-icon outputs-status-line-icon--success">\u2713</span>`
				: `<span class="outputs-status-line-icon outputs-status--spinning">${circleNotchIcon}</span>`;
			this.statusLine.innerHTML = `${icon}<span class="outputs-status-line-text">${text}</span>`;
			this.statusLine.classList.add('outputs-status-line--visible');
		} else {
			this.statusLine.classList.remove('outputs-status-line--visible');
			this.statusLine.innerHTML = '';
		}
	}

	private updateOverallProgress(): void {
		if (!this.overallProgressBar) return;
		const fill = this.overallProgressBar.querySelector('.outputs-overall-progress-fill') as HTMLDivElement | null;
		if (!fill) return;
		const total = this.outputResults.length;
		if (total === 0) return;
		let progress = 0;
		for (const r of this.outputResults) {
			if (r.status === 'complete' || r.status === 'error') {
				progress += 1;
			} else if (r.status === 'generating') {
				progress += (r.progress ?? 0);
			}
		}
		fill.style.width = `${Math.round(Math.min(progress / total, 1) * 100)}%`;
	}

	private async handleRunOutputs(): Promise<void> {
		if (this.isOutputsExecuting) return;

		let config;
		try {
			config = parseConfig(this.options.getYaml());
		} catch {
			return;
		}
		if (!config.outputs || config.outputs.length === 0) return;

		// Pre-check sources
		const { allExist, missing } = await checkSourcesExist(config.outputs);
		if (!allExist) {
			this.showNotice(missing);
			return;
		}

		// Start execution
		this.isOutputsExecuting = true;
		this.updateRunButtonState();
		if (this.exportViewerBtn) this.exportViewerBtn.disabled = true;

		revokeOutputBlobs(this.outputResults);
		this.pmtilesSourceIds = new Set(
			config.outputs.filter(o => o.format === 'pmtiles').map(o =>
				Array.isArray(o.source) ? (o.filename || o.source[0]) : o.source
			)
		);
		this.outputResults = config.outputs.map(o => {
			const sourceKey = Array.isArray(o.source) ? (o.filename || o.source[0]) : o.source;
			return {
				source: sourceKey,
				filename: `${o.filename || sourceKey}.${o.format}`,
				format: o.format,
				blobUrl: null,
				size: 0,
				pending: true,
				status: 'pending' as const,
			};
		});
		this.renderBody();
		if (this.overallProgressBar) {
			this.overallProgressBar.classList.add('outputs-overall-progress-track--visible');
		}
		this.setStatusLine('Starting...');

		// Register worker progress listener for granular PMTiles row updates
		this.outputProgressListener = (operation, _status, message, progress) => {
			if (!this.pmtilesSourceIds.has(operation)) return;
			const idx = this.outputResults.findIndex(
				r => r.source === operation && r.status === 'generating'
			);
			if (idx === -1) return;
			this.outputResults[idx] = {
				...this.outputResults[idx],
				statusMessage: message,
				progress,
			};
			this.updateOutputRow(idx);
			this.updateOverallProgress();
		};
		addProgressListener(this.outputProgressListener);

		// Status line listener: mirrors all worker progress events (same info as ProgressControl)
		this.statusLineListener = (operation, status, message) => {
			if (status === 'idle') return;
			const text = message || (status === 'success' ? `${operation} complete` : `Processing ${operation}...`);
			this.setStatusLine(text, status);
		};
		addProgressListener(this.statusLineListener);

		try {
			const finalResults = await executeOutputs(config.outputs, (i, result) => {
				this.outputResults[i] = result;
				this.updateOutputRow(i);
				this.updateOverallProgress();
			}, config.datasets);
			this.outputResults = finalResults;
			this.renderBody();
		} catch (e) {
			console.error('Output execution failed:', e);
		} finally {
			this.setStatusLine(null);
			this.isOutputsExecuting = false;
			if (this.overallProgressBar) {
				this.overallProgressBar.classList.remove('outputs-overall-progress-track--visible');
			}
			if (this.outputProgressListener) {
				removeProgressListener(this.outputProgressListener);
				this.outputProgressListener = null;
			}
			if (this.statusLineListener) {
				removeProgressListener(this.statusLineListener);
				this.statusLineListener = null;
			}
			if (this.exportViewerBtn) this.exportViewerBtn.disabled = false;
			this.updateRunButtonState();
		}
	}

	private showNotice(missing: string[]): void {
		if (!this.outputsBody) return;
		const resultsContainer = this.outputsBody.querySelector('.outputs-results');
		if (!resultsContainer) return;

		resultsContainer.innerHTML = '';

		const notice = document.createElement('div');
		notice.className = 'outputs-notice';
		notice.textContent = 'Run the config first to load data.';
		resultsContainer.appendChild(notice);

		for (const id of missing) {
			const row = document.createElement('div');
			row.className = 'outputs-missing';
			row.textContent = `Missing: ${id}`;
			resultsContainer.appendChild(row);
		}
	}

	private renderOutputRow(result: OutputResult): HTMLDivElement {
		const row = document.createElement('div');
		row.className = 'outputs-row';

		if (result.status === 'pending') row.classList.add('outputs-row--pending');
		else if (result.status === 'generating') row.classList.add('outputs-row--generating');

		const name = document.createElement('span');
		name.className = 'outputs-filename';
		name.textContent = result.filename;
		row.appendChild(name);

		const badge = document.createElement('span');
		badge.className = `outputs-badge outputs-badge--${result.format}`;
		badge.textContent = result.format.toUpperCase();
		row.appendChild(badge);

		if (result.status === 'pending' || result.status === 'generating') {
			const status = document.createElement('span');
			status.className = 'outputs-status outputs-status--spinning';
			status.innerHTML = circleNotchIcon;
			row.appendChild(status);

			if (result.status === 'generating' && result.statusMessage) {
				const msgEl = document.createElement('span');
				msgEl.className = 'outputs-status-text';
				msgEl.textContent = result.statusMessage;
				row.appendChild(msgEl);
			}

			if (result.progress !== undefined && result.progress > 0) {
				const bar = document.createElement('div');
				bar.className = 'outputs-progress';
				bar.style.width = `${Math.round(result.progress * 100)}%`;
				row.appendChild(bar);
			}
		} else if (result.status === 'error' || result.error) {
			const errorEl = document.createElement('span');
			errorEl.className = 'outputs-error';
			errorEl.textContent = result.error || 'Unknown error';
			row.appendChild(errorEl);
		} else {
			// complete
			const sizeEl = document.createElement('span');
			sizeEl.className = 'outputs-size';
			sizeEl.textContent = formatFileSize(result.size);
			row.appendChild(sizeEl);

			const dlBtn = document.createElement('button');
			dlBtn.className = 'outputs-dl';
			dlBtn.innerHTML = downloadSimpleIcon;
			dlBtn.title = `Download ${result.filename}`;
			dlBtn.disabled = !result.blobUrl;
			dlBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				if (result.blobUrl) downloadBlob(result.blobUrl, result.filename);
			});
			row.appendChild(dlBtn);
		}

		return row;
	}

	private updateOutputRow(index: number): void {
		const resultsContainer = this.outputsBody?.querySelector('.outputs-results');
		if (!resultsContainer) return;
		const existing = resultsContainer.querySelector(`[data-output-index="${index}"]`);
		if (!existing) return;
		const newRow = this.renderOutputRow(this.outputResults[index]);
		newRow.setAttribute('data-output-index', String(index));
		existing.replaceWith(newRow);
	}

	private appendDownloadAll(container: HTMLElement): void {
		const successResults = this.outputResults.filter(r => r.blobUrl);
		if (successResults.length <= 1) return;

		const divider = document.createElement('div');
		divider.className = 'outputs-row-divider';
		container.appendChild(divider);

		const downloadAll = document.createElement('button');
		downloadAll.type = 'button';
		downloadAll.className = 'outputs-download-all';
		downloadAll.innerHTML = `${downloadSimpleIcon}<span>Download All (.zip)</span>`;
		downloadAll.addEventListener('click', () => this.downloadAllAsZip(successResults));
		container.appendChild(downloadAll);
	}

	private async downloadAllAsZip(results: OutputResult[]): Promise<void> {
		const files: Record<string, Uint8Array> = {};
		for (const r of results) {
			if (!r.blobUrl) continue;
			const resp = await fetch(r.blobUrl);
			const buf = await resp.arrayBuffer();
			files[r.filename] = new Uint8Array(buf);
		}
		const zipData = zipSync(files);
		const blob = new Blob([zipData.buffer as ArrayBuffer], { type: 'application/zip' });
		const url = URL.createObjectURL(blob);
		downloadBlob(url, 'outputs.zip');
		URL.revokeObjectURL(url);
	}

	private async handleExportViewer(): Promise<void> {
		if (!this.map) return;
		if (this.exportViewerBtn) this.exportViewerBtn.disabled = true;
		try {
			const basemapId = this.options.getBasemapId?.() ?? 'carto-dark';
			await exportViewerZip(this.map, basemapId);
		} finally {
			if (this.exportViewerBtn) this.exportViewerBtn.disabled = false;
		}
	}

	// ── Panel open/close ────────────────────────────────────────────

	togglePanel(): void {
		if (this.isOpen) {
			this.close();
		} else {
			this.open();
		}
	}

	private async open(): Promise<void> {
		if (!this.panel) return;
		this.previousFocus = document.activeElement as HTMLElement | null;
		this.isOpen = true;
		this.panel.classList.add('outputs-panel--open');
		this.mainBtn?.setAttribute('aria-expanded', 'true');
		this.renderBody();
		document.addEventListener('keydown', this.handleEsc);
		this.onPanelOpen?.();

		// Pre-warm Shiki for YAML preview
		getHighlighter();

		// Populate dataset options for builder dropdowns
		await this.populateDatasetOptions();
		this.renderSourceSection();

		this.focusTrap = createFocusTrap(this.panel);
		this.focusTrap.activate();
		this.focusTrap.focusFirst();
	}

	private close(): void {
		if (!this.panel) return;
		this.isOpen = false;
		this.focusTrap?.deactivate();
		this.focusTrap = null;
		this.panel.classList.remove('outputs-panel--open');
		this.mainBtn?.setAttribute('aria-expanded', 'false');
		document.removeEventListener('keydown', this.handleEsc);
		this.onPanelClose?.();
		if (this.previousFocus?.isConnected) this.previousFocus.focus();
		this.previousFocus = null;
	}

	// ── Drag / Resize ───────────────────────────────────────────────

	private ensurePositioned(): void {
		if (!this.panel || this.hasBeenPositioned) return;
		const rect = this.panel.getBoundingClientRect();
		this.panel.style.top = `${rect.top}px`;
		this.panel.style.left = `${rect.left}px`;
		this.panel.style.width = `${rect.width}px`;
		this.panel.classList.add('outputs-panel--positioned');
		this.hasBeenPositioned = true;
	}

	private onDragStart(e: PointerEvent): void {
		if (window.innerWidth < 768) return;
		const target = e.target as HTMLElement;
		if (target.closest('button')) return;

		e.preventDefault();
		this.ensurePositioned();

		this.isDragging = true;
		this.hasBeenDragged = true;
		this.dragStartX = e.clientX;
		this.dragStartY = e.clientY;
		const rect = this.panel!.getBoundingClientRect();
		this.panelStartX = rect.left;
		this.panelStartY = rect.top;

		this.panel!.classList.add('outputs-panel--dragging');

		this.boundPointerMove = (ev: PointerEvent) => {
			const dx = ev.clientX - this.dragStartX;
			const dy = ev.clientY - this.dragStartY;
			let newX = this.panelStartX + dx;
			let newY = this.panelStartY + dy;

			const w = this.panel!.offsetWidth;
			const h = this.panel!.offsetHeight;
			newX = Math.max(0, Math.min(newX, window.innerWidth - w));
			newY = Math.max(0, Math.min(newY, window.innerHeight - h));

			this.panel!.style.left = `${newX}px`;
			this.panel!.style.top = `${newY}px`;
		};

		this.boundPointerUp = () => {
			this.isDragging = false;
			this.panel?.classList.remove('outputs-panel--dragging');
			document.removeEventListener('pointermove', this.boundPointerMove!);
			document.removeEventListener('pointerup', this.boundPointerUp!);
			this.boundPointerMove = null;
			this.boundPointerUp = null;
		};

		document.addEventListener('pointermove', this.boundPointerMove);
		document.addEventListener('pointerup', this.boundPointerUp);
	}

	private onResizeStart(e: PointerEvent): void {
		if (window.innerWidth < 768) return;
		e.preventDefault();
		e.stopPropagation();
		this.ensurePositioned();

		this.isResizing = true;
		this.dragStartX = e.clientX;
		this.dragStartY = e.clientY;
		const rect = this.panel!.getBoundingClientRect();
		this.panelStartW = rect.width;
		this.panelStartH = rect.height;

		this.boundPointerMove = (ev: PointerEvent) => {
			const dx = ev.clientX - this.dragStartX;
			const dy = ev.clientY - this.dragStartY;

			const maxW = window.innerWidth * 0.9;
			const maxH = window.innerHeight * 0.95;

			const newW = Math.max(this.MIN_WIDTH, Math.min(this.panelStartW + dx, maxW));
			const newH = Math.max(this.MIN_HEIGHT, Math.min(this.panelStartH + dy, maxH));

			this.panel!.style.width = `${newW}px`;
			this.panel!.style.height = `${newH}px`;
			this.panel!.style.maxHeight = `${newH}px`;
		};

		this.boundPointerUp = () => {
			this.isResizing = false;
			document.removeEventListener('pointermove', this.boundPointerMove!);
			document.removeEventListener('pointerup', this.boundPointerUp!);
			this.boundPointerMove = null;
			this.boundPointerUp = null;
		};

		document.addEventListener('pointermove', this.boundPointerMove);
		document.addEventListener('pointerup', this.boundPointerUp);
	}
}
