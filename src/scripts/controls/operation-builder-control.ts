/**
 * Operation Builder control — form-based UI for running spatial operations.
 * Floating panel (draggable, resizable, ESC to close) following the ConfigControl pattern.
 */

import type { Map, IControl } from 'maplibre-gl';
import type { LayerToggleControl } from './layer-control';
import type { Logger } from '../logger';
import type { OperationConfig, UnaryOperationType, BinaryOperationType } from '../config/types';
import { UNARY_OPERATIONS, BINARY_OPERATIONS } from '../config/parser';
import { VALID_DISTANCE_UNITS } from '../config/operations/unit-conversion';
import type { DistanceUnit } from '../config/operations/unit-conversion';
import yaml from 'js-yaml';
import { getDatasets, executeOperationInWorker, getDatasetBounds } from '../db';
import { addOperationResultToMap } from '../config/operations/render';
import { attachFeatureClickHandlers, attachFeatureHoverHandlers } from './popup';
import { gitMergeIcon, eraserIcon } from '../icons';
import { getHighlighter, highlightSync, highlightAsync } from '../utils/shiki';
import { createFocusTrap, type FocusTrap } from '../utils/focus-trap';

export interface OperationBuilderOptions {
	map: Map;
	logger: Logger;
	layerToggleControl: LayerToggleControl;
	loadedDatasets: Set<string>;
}

/** Dataset option for select dropdowns */
interface DatasetOption {
	id: string;
	name: string;
	format: string | null;
}

export class OperationBuilderControl implements IControl {
	private options: OperationBuilderOptions;
	private container: HTMLElement | null = null;
	private panel: HTMLElement | null = null;
	private mapContainer: HTMLElement | null = null;
	private mainBtn: HTMLButtonElement | null = null;
	private isOpen = false;
	private onPanelOpen: (() => void) | null = null;

	// Form elements
	private typeSelect: HTMLSelectElement | null = null;
	private inputsContainer: HTMLElement | null = null;
	private paramsContainer: HTMLElement | null = null;
	private outputInput: HTMLInputElement | null = null;
	private runBtn: HTMLButtonElement | null = null;
	private statusEl: HTMLElement | null = null;

	// Form state
	private userEditedOutput = false;
	private isRunning = false;
	private datasetOptions: DatasetOption[] = [];

	// Drag/resize state
	private hasBeenPositioned = false;
	private isDragging = false;
	private isResizing = false;
	private dragStartX = 0;
	private dragStartY = 0;
	private panelStartX = 0;
	private panelStartY = 0;
	private panelStartW = 0;
	private panelStartH = 0;
	private boundPointerMove: ((e: PointerEvent) => void) | null = null;
	private boundPointerUp: (() => void) | null = null;
	private readonly MIN_WIDTH = 340;
	private readonly MIN_HEIGHT = 300;
	private focusTrap: FocusTrap | null = null;
	private previousFocus: HTMLElement | null = null;

	// YAML preview
	private yamlPreviewContainer: HTMLElement | null = null;
	private yamlPreviewBody: HTMLElement | null = null;
	private yamlPreviewOpen = false;
	private updatePreviewTimer: ReturnType<typeof setTimeout> | null = null;

	// Event handlers (stored for cleanup)
	private handleEsc = (e: KeyboardEvent) => {
		if (e.key === 'Escape') this.close();
	};

	constructor(options: OperationBuilderOptions) {
		this.options = options;
	}

	setOnPanelOpen(cb: () => void): void {
		this.onPanelOpen = cb;
	}

	closePanel(): void {
		this.close();
	}

	onAdd(map: Map): HTMLElement {
		this.container = document.createElement('div');
		this.container.className = 'maplibregl-ctrl maplibregl-ctrl-group';

		const button = document.createElement('button');
		button.className = 'control-btn';
		button.type = 'button';
		button.title = 'Operation Builder (O)';
		button.setAttribute('aria-label', 'Operation Builder');
		button.setAttribute('aria-expanded', 'false');
		button.innerHTML = gitMergeIcon;
		button.addEventListener('click', () => this.togglePanel());
		this.mainBtn = button;
		this.container.appendChild(button);

		this.mapContainer = map.getContainer();
		this.buildPanel();

		return this.container;
	}

	onRemove(): void {
		this.focusTrap?.deactivate();
		this.focusTrap = null;
		document.removeEventListener('keydown', this.handleEsc);
		if (this.boundPointerMove) {
			document.removeEventListener('pointermove', this.boundPointerMove);
		}
		if (this.boundPointerUp) {
			document.removeEventListener('pointerup', this.boundPointerUp);
		}
		if (this.panel?.parentNode) {
			this.panel.parentNode.removeChild(this.panel);
		}
		if (this.container?.parentNode) {
			this.container.parentNode.removeChild(this.container);
		}
		if (this.updatePreviewTimer !== null) clearTimeout(this.updatePreviewTimer);
		this.panel = null;
		this.container = null;
		this.mapContainer = null;
		this.typeSelect = null;
		this.inputsContainer = null;
		this.paramsContainer = null;
		this.outputInput = null;
		this.runBtn = null;
		this.statusEl = null;
		this.yamlPreviewContainer = null;
		this.yamlPreviewBody = null;
	}

	// ── Panel construction ──────────────────────────────────────────────

	private buildPanel(): void {
		this.panel = document.createElement('div');
		this.panel.className = 'operation-builder';

		// Header
		const header = document.createElement('div');
		header.className = 'operation-builder-header';
		header.addEventListener('pointerdown', (e) => this.onDragStart(e));

		const title = document.createElement('span');
		title.className = 'operation-builder-title';
		title.textContent = 'Operations';

		const headerActions = document.createElement('div');
		headerActions.className = 'operation-builder-header-actions';

		const clearBtn = document.createElement('button');
		clearBtn.className = 'operation-builder-header-btn';
		clearBtn.type = 'button';
		clearBtn.title = 'Clear form';
		clearBtn.setAttribute('aria-label', 'Clear form');
		clearBtn.innerHTML = eraserIcon;
		clearBtn.addEventListener('click', () => this.resetForm());
		headerActions.appendChild(clearBtn);

		const closeBtn = document.createElement('button');
		closeBtn.className = 'operation-builder-close';
		closeBtn.type = 'button';
		closeBtn.title = 'Close (Esc)';
		closeBtn.setAttribute('aria-label', 'Close operation builder');
		closeBtn.textContent = '\u00d7';
		closeBtn.addEventListener('click', () => this.close());
		headerActions.appendChild(closeBtn);

		header.appendChild(title);
		header.appendChild(headerActions);
		this.panel.appendChild(header);

		// Body
		const body = document.createElement('div');
		body.className = 'operation-builder-body';

		// Operation type
		body.appendChild(this.buildField('Type', () => {
			this.typeSelect = document.createElement('select');
			this.typeSelect.className = 'ob-select';

			const unaryGroup = document.createElement('optgroup');
			unaryGroup.label = 'Unary (single input)';
			for (const op of UNARY_OPERATIONS) {
				const opt = document.createElement('option');
				opt.value = op;
				opt.textContent = this.formatOpName(op);
				unaryGroup.appendChild(opt);
			}
			this.typeSelect.appendChild(unaryGroup);

			const binaryGroup = document.createElement('optgroup');
			binaryGroup.label = 'Binary (two inputs)';
			for (const op of BINARY_OPERATIONS) {
				const opt = document.createElement('option');
				opt.value = op;
				opt.textContent = this.formatOpName(op);
				binaryGroup.appendChild(opt);
			}
			this.typeSelect.appendChild(binaryGroup);

			this.typeSelect.addEventListener('change', () => {
				this.clearStatus();
				this.renderInputs();
				this.renderParams();
				this.autoGenerateOutputName();
				this.schedulePreviewUpdate();
			});

			return this.typeSelect;
		}));

		// Inputs
		this.inputsContainer = document.createElement('div');
		body.appendChild(this.inputsContainer);

		// Params
		this.paramsContainer = document.createElement('div');
		this.paramsContainer.addEventListener('input', () => { this.clearStatus(); this.schedulePreviewUpdate(); });
		this.paramsContainer.addEventListener('change', () => { this.clearStatus(); this.schedulePreviewUpdate(); });
		body.appendChild(this.paramsContainer);

		// Divider
		const divider = document.createElement('hr');
		divider.className = 'ob-divider';
		body.appendChild(divider);

		// Output name
		body.appendChild(this.buildField('Output name', () => {
			this.outputInput = document.createElement('input');
			this.outputInput.type = 'text';
			this.outputInput.className = 'ob-text-input';
			this.outputInput.placeholder = 'e.g. buffer_1';
			this.outputInput.addEventListener('input', () => {
				this.userEditedOutput = true;
				this.clearStatus();
				this.schedulePreviewUpdate();
			});
			return this.outputInput;
		}));

		// Run button
		this.runBtn = document.createElement('button');
		this.runBtn.type = 'button';
		this.runBtn.className = 'ob-run-btn';
		this.runBtn.textContent = 'Run';
		this.runBtn.addEventListener('click', () => this.handleRun());
		body.appendChild(this.runBtn);

		// Status
		this.statusEl = document.createElement('div');
		this.statusEl.className = 'ob-status';
		this.statusEl.style.display = 'none';
		body.appendChild(this.statusEl);

		// YAML preview toggle + collapsible body
		const yamlToggle = document.createElement('div');
		yamlToggle.className = 'ob-yaml-toggle';
		const chevron = document.createElement('span');
		chevron.className = 'ob-yaml-chevron';
		chevron.textContent = '\u25b8';
		yamlToggle.appendChild(chevron);
		yamlToggle.appendChild(document.createTextNode('YAML Preview'));
		yamlToggle.addEventListener('click', () => {
			this.yamlPreviewOpen = !this.yamlPreviewOpen;
			chevron.classList.toggle('ob-yaml-chevron--open', this.yamlPreviewOpen);
			this.yamlPreviewContainer?.classList.toggle('ob-yaml-preview--open', this.yamlPreviewOpen);
			if (this.yamlPreviewOpen) {
				this.updateYamlPreview();
				this.expandPanelForPreview();
			}
		});
		body.appendChild(yamlToggle);

		this.yamlPreviewContainer = document.createElement('div');
		this.yamlPreviewContainer.className = 'ob-yaml-preview';
		this.yamlPreviewBody = document.createElement('div');
		this.yamlPreviewContainer.appendChild(this.yamlPreviewBody);
		body.appendChild(this.yamlPreviewContainer);

		this.panel.appendChild(body);

		// Resize handle
		const resizeHandle = document.createElement('div');
		resizeHandle.className = 'operation-builder-resize-handle';
		resizeHandle.addEventListener('pointerdown', (e) => this.onResizeStart(e));
		this.panel.appendChild(resizeHandle);

		this.mapContainer!.appendChild(this.panel);

		// Initial render
		this.renderInputs();
		this.renderParams();
		this.autoGenerateOutputName();
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

	private formatOpName(op: string): string {
		return op.charAt(0).toUpperCase() + op.slice(1);
	}

	// ── Dynamic form sections ───────────────────────────────────────────

	private getSelectedType(): string {
		return this.typeSelect?.value ?? 'buffer';
	}

	private isUnary(): boolean {
		return (UNARY_OPERATIONS as readonly string[]).includes(this.getSelectedType());
	}

	private renderInputs(): void {
		if (!this.inputsContainer) return;
		this.inputsContainer.innerHTML = '';

		if (this.isUnary()) {
			this.inputsContainer.appendChild(this.buildField('Input', () => {
				return this.buildDatasetSelect('input-a');
			}));
		} else {
			this.inputsContainer.appendChild(this.buildField('Input A', () => {
				return this.buildDatasetSelect('input-a');
			}));
			this.inputsContainer.appendChild(this.buildField('Input B', () => {
				return this.buildDatasetSelect('input-b');
			}));
		}
		this.focusTrap?.updateElements();
	}

	private buildDatasetSelect(name: string): HTMLSelectElement {
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
			const isPMTiles = ds.format === 'pmtiles';
			opt.textContent = isPMTiles ? `${ds.name} (PMTiles)` : ds.name;
			if (isPMTiles) opt.disabled = true;
			select.appendChild(opt);
		}

		select.addEventListener('change', () => {
			this.clearStatus();
			this.schedulePreviewUpdate();
		});
		return select;
	}

	private getInputSelect(name: string): HTMLSelectElement | null {
		return this.inputsContainer?.querySelector(`select[data-name="${name}"]`) ?? null;
	}

	private renderParams(): void {
		if (!this.paramsContainer) return;
		this.paramsContainer.innerHTML = '';

		const type = this.getSelectedType();

		switch (type) {
			case 'buffer':
				this.renderBufferParams();
				break;
			case 'centroid':
				this.renderCentroidParams();
				break;
			case 'attribute':
				this.renderAttributeParams();
				break;
			case 'intersection':
				this.renderModeParams('Mode', [
					{ value: 'filter', label: 'Filter (boolean test)' },
					{ value: 'clip', label: 'Clip (geometric intersection)' },
				]);
				break;
			case 'union':
				this.renderModeParams('Mode', [
					{ value: 'merge', label: 'Merge (combine features)' },
					{ value: 'dissolve', label: 'Dissolve (unify geometry)' },
				]);
				break;
			case 'difference':
				this.renderModeParams('Mode', [
					{ value: 'subtract', label: 'Subtract (geometric removal)' },
					{ value: 'exclude', label: 'Exclude (boolean filter)' },
				]);
				break;
			case 'contains':
				this.renderModeParams('Mode', [
					{ value: 'filter', label: 'Filter (A contains B)' },
					{ value: 'within', label: 'Within (B inside A)' },
				]);
				break;
			case 'distance':
				this.renderDistanceParams();
				break;
		}
	}

	private renderBufferParams(): void {
		if (!this.paramsContainer) return;

		// Distance + units row
		const row = document.createElement('div');
		row.className = 'ob-field ob-row';

		const distField = document.createElement('div');
		const distLabel = document.createElement('label');
		distLabel.className = 'ob-label';
		distLabel.textContent = 'Distance';
		const distInput = document.createElement('input');
		distInput.type = 'number';
		distInput.className = 'ob-number-input';
		distInput.dataset.param = 'distance';
		distInput.placeholder = '100';
		distInput.min = '0';
		distInput.step = 'any';
		distField.appendChild(distLabel);
		distField.appendChild(distInput);
		row.appendChild(distField);

		const unitField = document.createElement('div');
		const unitLabel = document.createElement('label');
		unitLabel.className = 'ob-label';
		unitLabel.textContent = 'Units';
		unitField.appendChild(unitLabel);
		unitField.appendChild(this.buildUnitsSelect());
		row.appendChild(unitField);

		this.paramsContainer.appendChild(row);

		// Dissolve checkbox
		const dissolveRow = document.createElement('div');
		dissolveRow.className = 'ob-field ob-checkbox-row';
		const dissolveCheck = document.createElement('input');
		dissolveCheck.type = 'checkbox';
		dissolveCheck.id = 'ob-dissolve';
		dissolveCheck.dataset.param = 'dissolve';
		dissolveCheck.checked = true;
		const dissolveLabel = document.createElement('label');
		dissolveLabel.htmlFor = 'ob-dissolve';
		dissolveLabel.textContent = 'Dissolve overlapping buffers';
		dissolveRow.appendChild(dissolveCheck);
		dissolveRow.appendChild(dissolveLabel);
		this.paramsContainer.appendChild(dissolveRow);

		// QuadSegs (optional)
		this.paramsContainer.appendChild(this.buildField('Curve segments (optional)', () => {
			const input = document.createElement('input');
			input.type = 'number';
			input.className = 'ob-number-input';
			input.dataset.param = 'quadSegs';
			input.placeholder = '32';
			input.min = '1';
			input.step = '1';
			return input;
		}));
	}

	private renderCentroidParams(): void {
		if (!this.paramsContainer) return;
		const p = document.createElement('p');
		p.className = 'ob-no-params';
		p.textContent = 'No additional parameters needed.';
		this.paramsContainer.appendChild(p);
	}

	private renderAttributeParams(): void {
		if (!this.paramsContainer) return;

		// Radio toggle
		const radioGroup = document.createElement('div');
		radioGroup.className = 'ob-field ob-radio-group';

		const structuredLabel = document.createElement('label');
		structuredLabel.className = 'ob-radio-label';
		const structuredRadio = document.createElement('input');
		structuredRadio.type = 'radio';
		structuredRadio.name = 'ob-attr-mode';
		structuredRadio.value = 'structured';
		structuredRadio.checked = true;
		structuredLabel.appendChild(structuredRadio);
		structuredLabel.appendChild(document.createTextNode('Structured'));
		radioGroup.appendChild(structuredLabel);

		const rawLabel = document.createElement('label');
		rawLabel.className = 'ob-radio-label';
		const rawRadio = document.createElement('input');
		rawRadio.type = 'radio';
		rawRadio.name = 'ob-attr-mode';
		rawRadio.value = 'raw';
		rawLabel.appendChild(rawRadio);
		rawLabel.appendChild(document.createTextNode('Raw WHERE'));
		radioGroup.appendChild(rawLabel);

		this.paramsContainer.appendChild(radioGroup);

		// Structured fields
		const structuredGroup = document.createElement('div');
		structuredGroup.dataset.attrGroup = 'structured';

		const propOpRow = document.createElement('div');
		propOpRow.className = 'ob-field ob-row';

		const propField = document.createElement('div');
		propField.style.flex = '2';
		const propLabel = document.createElement('label');
		propLabel.className = 'ob-label';
		propLabel.textContent = 'Property';
		const propInput = document.createElement('input');
		propInput.type = 'text';
		propInput.className = 'ob-text-input';
		propInput.dataset.param = 'property';
		propInput.placeholder = 'column_name';
		propField.appendChild(propLabel);
		propField.appendChild(propInput);
		propOpRow.appendChild(propField);

		const opField = document.createElement('div');
		opField.style.flex = '1';
		const opLabel = document.createElement('label');
		opLabel.className = 'ob-label';
		opLabel.textContent = 'Operator';
		const opSelect = document.createElement('select');
		opSelect.className = 'ob-select';
		opSelect.dataset.param = 'operator';
		for (const op of ['=', '!=', '>', '>=', '<', '<=', 'LIKE', 'NOT LIKE']) {
			const opt = document.createElement('option');
			opt.value = op;
			opt.textContent = op;
			opSelect.appendChild(opt);
		}
		opField.appendChild(opLabel);
		opField.appendChild(opSelect);
		propOpRow.appendChild(opField);

		structuredGroup.appendChild(propOpRow);

		structuredGroup.appendChild(this.buildField('Value', () => {
			const input = document.createElement('input');
			input.type = 'text';
			input.className = 'ob-text-input';
			input.dataset.param = 'value';
			input.placeholder = 'filter value';
			return input;
		}));

		this.paramsContainer.appendChild(structuredGroup);

		// Raw WHERE field
		const rawGroup = document.createElement('div');
		rawGroup.dataset.attrGroup = 'raw';
		rawGroup.style.display = 'none';

		rawGroup.appendChild(this.buildField('WHERE clause', () => {
			const textarea = document.createElement('textarea');
			textarea.className = 'ob-textarea';
			textarea.dataset.param = 'where';
			textarea.placeholder = "json_extract_string(properties, '$.type') = 'Park'";
			return textarea;
		}));

		this.paramsContainer.appendChild(rawGroup);

		// Radio toggle handler
		const toggleAttrMode = () => {
			const isStructured = structuredRadio.checked;
			structuredGroup.style.display = isStructured ? '' : 'none';
			rawGroup.style.display = isStructured ? 'none' : '';
		};
		structuredRadio.addEventListener('change', toggleAttrMode);
		rawRadio.addEventListener('change', toggleAttrMode);
	}

	private renderModeParams(label: string, modes: { value: string; label: string }[]): void {
		if (!this.paramsContainer) return;
		this.paramsContainer.appendChild(this.buildField(label, () => {
			const select = document.createElement('select');
			select.className = 'ob-select';
			select.dataset.param = 'mode';
			for (const m of modes) {
				const opt = document.createElement('option');
				opt.value = m.value;
				opt.textContent = m.label;
				select.appendChild(opt);
			}
			return select;
		}));
	}

	private renderDistanceParams(): void {
		if (!this.paramsContainer) return;

		// Mode
		this.paramsContainer.appendChild(this.buildField('Mode', () => {
			const select = document.createElement('select');
			select.className = 'ob-select';
			select.dataset.param = 'mode';

			const filterOpt = document.createElement('option');
			filterOpt.value = 'filter';
			filterOpt.textContent = 'Filter (proximity threshold)';
			select.appendChild(filterOpt);

			const annotateOpt = document.createElement('option');
			annotateOpt.value = 'annotate';
			annotateOpt.textContent = 'Annotate (add distance property)';
			select.appendChild(annotateOpt);

			select.addEventListener('change', () => {
				const hint = this.paramsContainer?.querySelector('.ob-distance-hint');
				if (hint) {
					hint.textContent = select.value === 'filter'
						? 'Required for filter mode'
						: 'Optional for annotate mode';
				}
			});

			return select;
		}));

		// maxDistance + units row
		const row = document.createElement('div');
		row.className = 'ob-field ob-row';

		const distField = document.createElement('div');
		const distLabel = document.createElement('label');
		distLabel.className = 'ob-label';
		distLabel.textContent = 'Max distance';
		const distInput = document.createElement('input');
		distInput.type = 'number';
		distInput.className = 'ob-number-input';
		distInput.dataset.param = 'maxDistance';
		distInput.placeholder = '500';
		distInput.min = '0';
		distInput.step = 'any';
		distField.appendChild(distLabel);
		distField.appendChild(distInput);
		row.appendChild(distField);

		const unitField = document.createElement('div');
		const unitLabel = document.createElement('label');
		unitLabel.className = 'ob-label';
		unitLabel.textContent = 'Units';
		unitField.appendChild(unitLabel);
		unitField.appendChild(this.buildUnitsSelect());
		row.appendChild(unitField);

		this.paramsContainer.appendChild(row);

		const hint = document.createElement('div');
		hint.className = 'ob-hint ob-distance-hint';
		hint.textContent = 'Required for filter mode';
		this.paramsContainer.appendChild(hint);
	}

	private buildUnitsSelect(): HTMLSelectElement {
		const select = document.createElement('select');
		select.className = 'ob-select';
		select.dataset.param = 'units';
		for (const unit of VALID_DISTANCE_UNITS) {
			const opt = document.createElement('option');
			opt.value = unit;
			opt.textContent = unit;
			select.appendChild(opt);
		}
		return select;
	}

	// ── Output name auto-generation ─────────────────────────────────────

	private autoGenerateOutputName(): void {
		if (this.userEditedOutput) return;
		const type = this.getSelectedType();
		let i = 1;
		while (this.options.loadedDatasets.has(`${type}_${i}`)) i++;
		if (this.outputInput) {
			this.outputInput.value = `${type}_${i}`;
		}
	}

	// ── Validation ──────────────────────────────────────────────────────

	private validate(): string | null {
		const output = this.outputInput?.value.trim();
		if (!output) return 'Output name is required';
		if (/\s/.test(output)) return 'Output name cannot contain spaces';
		if (this.options.loadedDatasets.has(output)) return `"${output}" already exists`;

		const inputA = this.getInputSelect('input-a')?.value;
		if (!inputA) return 'Select an input dataset';
		if (this.datasetOptions.find((d) => d.id === inputA)?.format === 'pmtiles')
			return 'PMTiles datasets cannot be used in operations';

		if (!this.isUnary()) {
			const inputB = this.getInputSelect('input-b')?.value;
			if (!inputB) return 'Select Input B dataset';
			if (this.datasetOptions.find((d) => d.id === inputB)?.format === 'pmtiles')
				return 'PMTiles datasets cannot be used in operations';
		}

		const type = this.getSelectedType();
		if (type === 'buffer') {
			const dist = this.getNumberParam('distance');
			if (dist === null || dist <= 0) return 'Buffer distance must be positive';
		}

		if (type === 'distance') {
			const mode = this.getSelectParam('mode');
			const maxDist = this.getNumberParam('maxDistance');
			if (mode === 'filter' && (maxDist === null || maxDist <= 0)) {
				return 'Max distance is required for filter mode';
			}
		}

		if (type === 'attribute') {
			const attrMode = this.getAttrMode();
			if (attrMode === 'structured') {
				const prop = this.getTextParam('property');
				const val = this.getTextParam('value');
				if (!prop) return 'Property name is required';
				if (!val && val !== '0') return 'Filter value is required';
			} else {
				const where = this.getTextParam('where');
				if (!where) return 'WHERE clause is required';
			}
		}

		return null;
	}

	// ── Build OperationConfig from form ──────────────────────────────────

	private buildOperationConfig(): OperationConfig | null {
		const error = this.validate();
		if (error) {
			this.showStatus('error', error);
			return null;
		}

		const type = this.getSelectedType();
		const output = this.outputInput!.value.trim();
		const params = this.readParams(type);

		if (this.isUnary()) {
			return {
				type: type as UnaryOperationType,
				input: this.getInputSelect('input-a')!.value,
				output,
				...(params && { params }),
			};
		} else {
			return {
				type: type as BinaryOperationType,
				inputs: [
					this.getInputSelect('input-a')!.value,
					this.getInputSelect('input-b')!.value,
				],
				output,
				...(params && { params }),
			};
		}
	}

	private readParams(type: string): Record<string, unknown> | undefined {
		switch (type) {
			case 'buffer': {
				const params: Record<string, unknown> = {
					distance: this.getNumberParam('distance')!,
					units: this.getSelectParam('units') as DistanceUnit,
					dissolve: this.getCheckboxParam('dissolve'),
				};
				const quadSegs = this.getNumberParam('quadSegs');
				if (quadSegs !== null) params.quadSegs = quadSegs;
				return params;
			}
			case 'centroid':
				return undefined;
			case 'attribute': {
				if (this.getAttrMode() === 'structured') {
					const params: Record<string, unknown> = {
						property: this.getTextParam('property'),
						value: this.getTextParam('value'),
					};
					const op = this.getSelectParam('operator');
					if (op && op !== '=') params.operator = op;
					return params;
				} else {
					return { where: this.getTextParam('where') };
				}
			}
			case 'intersection':
			case 'union':
			case 'difference':
			case 'contains':
				return { mode: this.getSelectParam('mode') };
			case 'distance': {
				const params: Record<string, unknown> = {
					mode: this.getSelectParam('mode'),
					units: this.getSelectParam('units') as DistanceUnit,
				};
				const maxDist = this.getNumberParam('maxDistance');
				if (maxDist !== null) params.maxDistance = maxDist;
				return params;
			}
			default:
				return undefined;
		}
	}

	// ── Param helpers ───────────────────────────────────────────────────

	private getNumberParam(name: string): number | null {
		const el = this.paramsContainer?.querySelector<HTMLInputElement>(`[data-param="${name}"]`);
		if (!el || el.value === '') return null;
		const n = parseFloat(el.value);
		return isNaN(n) ? null : n;
	}

	private getSelectParam(name: string): string {
		const el = this.paramsContainer?.querySelector<HTMLSelectElement>(`[data-param="${name}"]`);
		return el?.value ?? '';
	}

	private getTextParam(name: string): string {
		const el = this.paramsContainer?.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-param="${name}"]`);
		return el?.value.trim() ?? '';
	}

	private getCheckboxParam(name: string): boolean {
		const el = this.paramsContainer?.querySelector<HTMLInputElement>(`[data-param="${name}"]`);
		return el?.checked ?? false;
	}

	private getAttrMode(): 'structured' | 'raw' {
		const radio = this.paramsContainer?.querySelector<HTMLInputElement>('input[name="ob-attr-mode"]:checked');
		return (radio?.value === 'raw') ? 'raw' : 'structured';
	}

	// ── YAML preview ────────────────────────────────────────────────────

	private buildPreviewConfig(): Record<string, unknown> | null {
		const type = this.getSelectedType();
		const output = this.outputInput?.value.trim();
		if (!type || !output) return null;

		const config: Record<string, unknown> = { type, output };

		if (this.isUnary()) {
			const input = this.getInputSelect('input-a')?.value;
			if (input) config.input = input;
		} else {
			const a = this.getInputSelect('input-a')?.value;
			const b = this.getInputSelect('input-b')?.value;
			if (a || b) config.inputs = [a || '...', b || '...'];
		}

		const params = this.readParams(type);
		if (params) {
			// Strip default-false booleans for cleaner preview
			const cleaned: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(params)) {
				if (v !== false && v !== '' && v !== null && v !== undefined) {
					cleaned[k] = v;
				}
			}
			if (Object.keys(cleaned).length > 0) config.params = cleaned;
		}

		return config;
	}

	private schedulePreviewUpdate(): void {
		if (this.updatePreviewTimer !== null) clearTimeout(this.updatePreviewTimer);
		this.updatePreviewTimer = setTimeout(() => this.updateYamlPreview(), 150);
	}

	private async updateYamlPreview(): Promise<void> {
		if (!this.yamlPreviewBody || !this.yamlPreviewOpen) return;

		const config = this.buildPreviewConfig();
		if (!config) {
			this.yamlPreviewBody.innerHTML = '<p class="ob-yaml-placeholder">Fill in the form to see YAML</p>';
			return;
		}

		const yamlStr = yaml.dump({ operations: [config] }, {
			lineWidth: -1,
			noRefs: true,
			quotingType: '"',
		});

		const html = highlightSync(yamlStr);
		if (html) {
			this.yamlPreviewBody.innerHTML = html;
		} else {
			this.yamlPreviewBody.innerHTML = await highlightAsync(yamlStr);
		}
	}

	private expandPanelForPreview(): void {
		if (!this.panel || window.innerWidth < 768) return;

		if (this.hasBeenPositioned) {
			// Panel has explicit height from drag/resize — grow it to fit content
			this.panel.style.height = 'auto';
			const newRect = this.panel.getBoundingClientRect();
			const maxH = window.innerHeight - newRect.top - 16;
			this.panel.style.height = `${Math.min(newRect.height, maxH)}px`;
		} else {
			// Panel is CSS-centered — just bump max-height so content is visible
			this.panel.style.maxHeight = '85vh';
		}
	}

	// ── Execution ───────────────────────────────────────────────────────

	private async handleRun(): Promise<void> {
		if (this.isRunning) return;

		const op = this.buildOperationConfig();
		if (!op) return;

		this.isRunning = true;
		this.runBtn!.disabled = true;
		this.runBtn!.textContent = 'Running...';
		this.clearStatus();

		try {
			const result = await executeOperationInWorker(op, 0);

			const layerIds = addOperationResultToMap(
				this.options.map,
				result.outputId,
				result.color,
				result.style,
				result.geoJson
			);

			// Release GeoJSON reference - MapLibre owns the data now
			result.geoJson = null as any;
			this.options.loadedDatasets.add(result.outputId);

			// Attach popup/hover handlers
			if (layerIds.length > 0) {
				attachFeatureHoverHandlers(
					this.options.map, layerIds, { label: result.displayName }
				);
				attachFeatureClickHandlers(this.options.map, layerIds);
			}

			this.options.layerToggleControl.refreshPanel();

			// fitBounds to result
			const bounds = await getDatasetBounds(result.outputId);
			if (bounds) {
				this.options.map.fitBounds(
					[[bounds[0], bounds[1]], [bounds[2], bounds[3]]],
					{ padding: 50, maxZoom: 17 }
				);
			}

			this.showStatus('success', `Created ${result.featureCount} feature(s)`);
			// Delay success so it arrives after any pending batched worker progress events (150ms batch interval)
			setTimeout(() => {
				this.options.logger.progress(result.displayName, 'success', `Created ${result.featureCount} feature(s)`);
				this.options.logger.scheduleIdle(3000);
			}, 200);

			// Refresh dropdowns (new output available as input for chaining)
			await this.populateDatasetOptions();
			this.renderInputs();

			// Auto-increment output name
			this.userEditedOutput = false;
			this.autoGenerateOutputName();
		} catch (error) {
			const msg = error instanceof Error ? error.message : 'Operation failed';
			this.showStatus('error', msg);
			this.options.logger.progress('operation', 'error', msg);
			this.options.logger.scheduleIdle(5000);
		} finally {
			this.isRunning = false;
			this.runBtn!.disabled = false;
			this.runBtn!.textContent = 'Run';
		}
	}

	// ── Status display ──────────────────────────────────────────────────

	private showStatus(type: 'success' | 'error', message: string): void {
		if (!this.statusEl) return;
		this.statusEl.style.display = '';
		this.statusEl.className = `ob-status ob-status--${type}`;
		this.statusEl.textContent = message;
	}

	private clearStatus(): void {
		if (!this.statusEl) return;
		this.statusEl.style.display = 'none';
		this.statusEl.textContent = '';
	}

	// ── Dataset options ─────────────────────────────────────────────────

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

	/** Refresh dataset dropdowns (called externally after dataset rename/delete). */
	refreshDatasets(): void {
		if (!this.isOpen) return;
		this.populateDatasetOptions().then(() => this.renderInputs());
	}

	// ── Form reset ──────────────────────────────────────────────────────

	private resetForm(): void {
		if (this.typeSelect) this.typeSelect.selectedIndex = 0;
		this.userEditedOutput = false;
		this.renderInputs();
		this.renderParams();
		this.autoGenerateOutputName();
		this.clearStatus();
		this.schedulePreviewUpdate();
	}

	// ── Open / Close ────────────────────────────────────────────────────

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

		// Pre-warm Shiki for YAML preview
		getHighlighter();

		// Refresh dataset list
		await this.populateDatasetOptions();
		this.renderInputs();
		this.autoGenerateOutputName();

		this.panel.classList.add('operation-builder--open');
		this.mainBtn?.setAttribute('aria-expanded', 'true');
		this.onPanelOpen?.();
		document.addEventListener('keydown', this.handleEsc);
		this.focusTrap = createFocusTrap(this.panel);
		this.focusTrap.activate();
		this.focusTrap.focusFirst();
	}

	private close(): void {
		if (!this.panel) return;
		this.isOpen = false;
		this.focusTrap?.deactivate();
		this.focusTrap = null;
		this.panel.classList.remove('operation-builder--open');
		this.mainBtn?.setAttribute('aria-expanded', 'false');
		document.removeEventListener('keydown', this.handleEsc);
		if (this.previousFocus?.isConnected) this.previousFocus.focus();
		this.previousFocus = null;
	}

	// ── Drag / Resize ───────────────────────────────────────────────────

	private ensurePositioned(): void {
		if (!this.panel || this.hasBeenPositioned) return;
		const rect = this.panel.getBoundingClientRect();
		this.panel.style.top = `${rect.top}px`;
		this.panel.style.left = `${rect.left}px`;
		this.panel.style.width = `${rect.width}px`;
		this.panel.style.height = `${rect.height}px`;
		this.panel.style.maxHeight = 'none';
		this.panel.classList.add('operation-builder--positioned');
		this.hasBeenPositioned = true;
	}

	private onDragStart(e: PointerEvent): void {
		if (window.innerWidth < 768) return;
		const target = e.target as HTMLElement;
		if (target.closest('button')) return;

		e.preventDefault();
		this.ensurePositioned();

		this.isDragging = true;
		this.dragStartX = e.clientX;
		this.dragStartY = e.clientY;
		const rect = this.panel!.getBoundingClientRect();
		this.panelStartX = rect.left;
		this.panelStartY = rect.top;

		this.panel!.classList.add('operation-builder--dragging');

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
			this.panel?.classList.remove('operation-builder--dragging');
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
			const maxH = window.innerHeight * 0.85;

			const newW = Math.max(this.MIN_WIDTH, Math.min(this.panelStartW + dx, maxW));
			const newH = Math.max(this.MIN_HEIGHT, Math.min(this.panelStartH + dy, maxH));

			this.panel!.style.width = `${newW}px`;
			this.panel!.style.height = `${newH}px`;
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
