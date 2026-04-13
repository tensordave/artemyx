/**
 * DatasetControl — top-level map control listing all datasets in DuckDB.
 * Shows table icon (tabular preview) and geo icon (layer cross-reference).
 */

import type { Map, IControl } from 'maplibre-gl';
import { databaseIcon, tableIcon, mapPinIcon } from '../icons';
import { getDatasets } from '../db';
import { getLayersForDataset } from '../layers';
import { getLayersByDataset } from '../deckgl/registry';
import { createFocusTrap, type FocusTrap } from '../utils/focus-trap';
import type { TablePreviewPanel } from './table-preview-panel';

const ICON_COLORS: Record<string, string> = {
	empty: '#3388ff',    // blue — no data
	tabular: '#14b8a6',  // teal — tabular only
	spatial: '#22c55e',  // green — has spatial data
};

export interface DatasetControlOptions {
	tablePreviewPanel: TablePreviewPanel;
}

export class DatasetControl implements IControl {
	private map: Map | null = null;
	private container: HTMLDivElement | null = null;
	private panel: HTMLDivElement | null = null;
	private bodyEl: HTMLDivElement | null = null;
	private isOpen = false;
	private mainBtn: HTMLButtonElement | null = null;
	private options: DatasetControlOptions;

	// Panel lifecycle callbacks
	private onPanelOpen?: () => void;

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
	private focusTrap: FocusTrap | null = null;
	private previousFocus: HTMLElement | null = null;

	private readonly MIN_WIDTH = 300;
	private readonly MIN_HEIGHT = 200;

	constructor(options: DatasetControlOptions) {
		this.options = options;
	}

	closePanel(): void {
		this.close();
	}

	setOnPanelOpen(cb: () => void): void {
		this.onPanelOpen = cb;
	}

	async updateIconColor(): Promise<void> {
		if (!this.mainBtn) return;
		const svg = this.mainBtn.querySelector('svg');
		if (!svg) return;

		const allDatasets = await getDatasets();
		const datasets = allDatasets.filter((d: any) => !d.hidden);

		let color = ICON_COLORS.empty;
		if (datasets.length > 0) {
			const hasSpatial = datasets.some((d: any) => d.is_spatial !== false);
			color = hasSpatial ? ICON_COLORS.spatial : ICON_COLORS.tabular;
		}

		svg.setAttribute('fill', color);
	}

	onAdd(map: Map): HTMLElement {
		this.map = map;

		this.container = document.createElement('div');
		this.container.className = 'maplibregl-ctrl dataset-control';

		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'control-btn';
		btn.title = 'Datasets (T)';
		btn.setAttribute('aria-label', 'Datasets');
		btn.setAttribute('aria-expanded', 'false');
		btn.innerHTML = databaseIcon;
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
		this.panel?.remove();
		this.container?.remove();
		this.map = null;
		this.mainBtn = null;
		this.bodyEl = null;
	}

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
		this.panel.classList.add('dataset-panel--open');
		this.mainBtn?.setAttribute('aria-expanded', 'true');
		document.addEventListener('keydown', this.handleEsc);
		this.onPanelOpen?.();

		await this.refreshPanel();

		this.focusTrap = createFocusTrap(this.panel);
		this.focusTrap.activate();
		this.focusTrap.focusFirst();
	}

	private close(): void {
		if (!this.panel) return;
		this.isOpen = false;
		this.focusTrap?.deactivate();
		this.focusTrap = null;
		this.panel.classList.remove('dataset-panel--open');
		this.mainBtn?.setAttribute('aria-expanded', 'false');
		document.removeEventListener('keydown', this.handleEsc);
		if (this.previousFocus?.isConnected) this.previousFocus.focus();
		this.previousFocus = null;
	}

	private handleEsc = (e: KeyboardEvent) => {
		if (e.key === 'Escape') this.close();
	};

	private buildPanel(): HTMLDivElement {
		const panel = document.createElement('div');
		panel.className = 'dataset-panel';

		// Header
		const header = document.createElement('div');
		header.className = 'dataset-panel-header';

		const title = document.createElement('span');
		title.className = 'dataset-panel-title';
		title.textContent = 'Datasets';
		header.appendChild(title);

		const closeBtn = document.createElement('button');
		closeBtn.type = 'button';
		closeBtn.className = 'dataset-panel-close';
		closeBtn.textContent = '\u00d7';
		closeBtn.title = 'Close (Esc)';
		closeBtn.setAttribute('aria-label', 'Close datasets panel');
		closeBtn.addEventListener('click', () => this.close());
		header.appendChild(closeBtn);

		header.addEventListener('pointerdown', (e) => this.onDragStart(e));
		panel.appendChild(header);

		// Scroll wrapper
		const scroll = document.createElement('div');
		scroll.className = 'dataset-panel-scroll';

		this.bodyEl = document.createElement('div');
		this.bodyEl.className = 'dataset-panel-body';
		scroll.appendChild(this.bodyEl);

		panel.appendChild(scroll);

		// Resize handle
		const resizeHandle = document.createElement('div');
		resizeHandle.className = 'dataset-panel-resize-handle';
		resizeHandle.addEventListener('pointerdown', (e) => this.onResizeStart(e));
		panel.appendChild(resizeHandle);

		return panel;
	}

	async refreshPanel(): Promise<void> {
		if (!this.bodyEl || !this.map) return;

		const allDatasets = await getDatasets();
		const datasets = allDatasets.filter((d: any) => !d.hidden);

		this.bodyEl.innerHTML = '';

		if (datasets.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'dataset-panel-empty';
			empty.textContent = 'No datasets loaded';
			this.bodyEl.appendChild(empty);
			return;
		}

		for (const ds of datasets) {
			const row = this.buildDatasetRow(ds);
			this.bodyEl.appendChild(row);
		}
	}

	private buildDatasetRow(dataset: any): HTMLDivElement {
		const isSpatial = dataset.is_spatial !== false;
		const row = document.createElement('div');
		row.className = 'dataset-row';
		row.style.borderLeftColor = isSpatial ? (dataset.color || '#3388ff') : '#888';

		// Top section: info + actions on one line
		const top = document.createElement('div');
		top.className = 'dataset-row-top';

		// Info section: ID (slug) as primary, human name as secondary
		const info = document.createElement('div');
		info.className = 'dataset-row-info';

		const idEl = document.createElement('span');
		idEl.className = 'dataset-row-id';
		idEl.textContent = dataset.id;
		idEl.title = dataset.id;
		info.appendChild(idEl);

		// Show human-readable name below the ID if it differs
		if (dataset.name && dataset.name !== dataset.id) {
			const nameEl = document.createElement('span');
			nameEl.className = 'dataset-row-name';
			nameEl.textContent = dataset.name;
			info.appendChild(nameEl);
		}

		const count = document.createElement('span');
		count.className = 'dataset-row-count';
		count.textContent = dataset.format === 'pmtiles'
			? 'PMTiles'
			: isSpatial
				? `${dataset.feature_count.toLocaleString()} features`
				: `${dataset.feature_count.toLocaleString()} rows`;
		info.appendChild(count);

		top.appendChild(info);

		// Action icons
		const actions = document.createElement('div');
		actions.className = 'dataset-row-actions';

		// Table icon (for non-PMTiles with features)
		if (dataset.format !== 'pmtiles' && dataset.feature_count > 0) {
			const tableBtn = document.createElement('button');
			tableBtn.type = 'button';
			tableBtn.className = 'dataset-row-icon-btn';
			tableBtn.innerHTML = tableIcon;
			tableBtn.title = 'Preview data';
			tableBtn.setAttribute('aria-label', `Preview data for ${dataset.id}`);
			tableBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				this.options.tablePreviewPanel.open(dataset.id, dataset.name || dataset.id);
			});
			actions.appendChild(tableBtn);
		}

		// Geo/map-pin icon (for spatial datasets only)
		if (isSpatial && dataset.feature_count > 0) {
			const geoBtn = document.createElement('button');
			geoBtn.type = 'button';
			geoBtn.className = 'dataset-row-icon-btn';
			geoBtn.innerHTML = mapPinIcon;
			geoBtn.title = 'Show layers';
			geoBtn.setAttribute('aria-label', `Show layers for ${dataset.id}`);
			geoBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				this.toggleLayerList(row, dataset);
			});
			actions.appendChild(geoBtn);
		}

		top.appendChild(actions);
		row.appendChild(top);

		return row;
	}

	private toggleLayerList(row: HTMLDivElement, dataset: any): void {
		// Toggle: remove if already showing
		const existing = row.querySelector('.dataset-layer-list');
		if (existing) {
			existing.remove();
			return;
		}

		const list = document.createElement('div');
		list.className = 'dataset-layer-list';

		// Human-readable name as the layer label (what appears in the layer panel)
		const layerName = dataset.name || dataset.id;

		// MapLibre layers — show: name, renderer, type
		const maplibreLayers = this.map ? getLayersForDataset(this.map, dataset.id) : [];
		for (const layer of maplibreLayers) {
			const entry = document.createElement('div');
			entry.className = 'dataset-layer-entry';

			const nameTag = document.createElement('span');
			nameTag.className = 'dataset-layer-name';
			nameTag.textContent = layerName;
			entry.appendChild(nameTag);

			const rendererTag = document.createElement('span');
			rendererTag.className = 'dataset-layer-tag';
			rendererTag.textContent = 'MapLibre';
			entry.appendChild(rendererTag);

			const typeTag = document.createElement('span');
			typeTag.className = 'dataset-layer-tag dataset-layer-tag--type';
			typeTag.textContent = layer.type;
			entry.appendChild(typeTag);

			list.appendChild(entry);
		}

		// deck.gl layers — show: name, renderer, deck.gl
		const deckLayers = getLayersByDataset(dataset.id, 'deckgl');
		for (const _ of deckLayers) {
			const entry = document.createElement('div');
			entry.className = 'dataset-layer-entry';

			const nameTag = document.createElement('span');
			nameTag.className = 'dataset-layer-name';
			nameTag.textContent = layerName;
			entry.appendChild(nameTag);

			const rendererTag = document.createElement('span');
			rendererTag.className = 'dataset-layer-tag dataset-layer-tag--deckgl';
			rendererTag.textContent = 'deck.gl';
			entry.appendChild(rendererTag);

			list.appendChild(entry);
		}

		if (maplibreLayers.length === 0 && deckLayers.length === 0) {
			const entry = document.createElement('div');
			entry.className = 'dataset-layer-entry';
			const empty = document.createElement('span');
			empty.className = 'dataset-layer-name dataset-layer-name--empty';
			empty.textContent = 'No layers';
			entry.appendChild(empty);
			list.appendChild(entry);
		}

		row.appendChild(list);
	}

	// ── Drag / Resize ───────────────────────────────────────────────

	private ensurePositioned(): void {
		if (!this.panel || this.hasBeenPositioned) return;
		const rect = this.panel.getBoundingClientRect();
		this.panel.style.top = `${rect.top}px`;
		this.panel.style.left = `${rect.left}px`;
		this.panel.style.width = `${rect.width}px`;
		this.panel.classList.add('dataset-panel--positioned');
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

		this.panel!.classList.add('dataset-panel--dragging');

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
			this.panel?.classList.remove('dataset-panel--dragging');
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
