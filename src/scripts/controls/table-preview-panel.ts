/**
 * Floating table preview panel for inspecting dataset properties.
 * Not a MapLibre IControl — opened programmatically from DatasetControl.
 * Follows the same drag/resize pattern as OutputsControl.
 */

import type { Map } from 'maplibre-gl';
import { getPreviewRows } from '../db';
import { createFocusTrap, type FocusTrap } from '../utils/focus-trap';

export class TablePreviewPanel {
	private map: Map;
	private panel: HTMLDivElement | null = null;
	private titleEl: HTMLSpanElement | null = null;
	private scrollEl: HTMLDivElement | null = null;
	private footerEl: HTMLDivElement | null = null;
	private currentDatasetId: string | null = null;

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

	private readonly MIN_WIDTH = 400;
	private readonly MIN_HEIGHT = 200;

	constructor(map: Map) {
		this.map = map;
	}

	async open(datasetId: string, datasetName: string): Promise<void> {
		if (!this.panel) {
			this.panel = this.buildPanel();
			this.map.getContainer().appendChild(this.panel);
		}

		// If same dataset is already showing and panel is open, just focus
		if (this.currentDatasetId === datasetId && this.panel.classList.contains('table-preview-panel--open')) {
			this.focusTrap?.focusFirst();
			return;
		}

		this.currentDatasetId = datasetId;
		this.previousFocus = document.activeElement as HTMLElement | null;

		// Update title
		if (this.titleEl) this.titleEl.textContent = datasetName;

		// Show panel and render loading state
		this.panel.classList.add('table-preview-panel--open');
		if (this.scrollEl) this.scrollEl.innerHTML = '<div class="table-preview-loading">Loading...</div>';
		if (this.footerEl) this.footerEl.textContent = '';

		document.addEventListener('keydown', this.handleEsc);

		this.focusTrap = createFocusTrap(this.panel);
		this.focusTrap.activate();
		this.focusTrap.focusFirst();

		// Fetch and render
		try {
			const data = await getPreviewRows(datasetId);
			this.renderTable(data);
		} catch (err) {
			console.error('Failed to load preview rows:', err);
			if (this.scrollEl) {
				this.scrollEl.innerHTML = '<div class="table-preview-empty">Failed to load preview</div>';
			}
		}
	}

	close(): void {
		if (!this.panel) return;
		this.currentDatasetId = null;
		this.focusTrap?.deactivate();
		this.focusTrap = null;
		this.panel.classList.remove('table-preview-panel--open');
		document.removeEventListener('keydown', this.handleEsc);
		if (this.previousFocus?.isConnected) this.previousFocus.focus();
		this.previousFocus = null;
	}

	private handleEsc = (e: KeyboardEvent) => {
		if (e.key === 'Escape') this.close();
	};

	private buildPanel(): HTMLDivElement {
		const panel = document.createElement('div');
		panel.className = 'table-preview-panel';

		// Header
		const header = document.createElement('div');
		header.className = 'table-preview-header';

		this.titleEl = document.createElement('span');
		this.titleEl.className = 'table-preview-title';
		header.appendChild(this.titleEl);

		const closeBtn = document.createElement('button');
		closeBtn.type = 'button';
		closeBtn.className = 'table-preview-close';
		closeBtn.textContent = '\u00d7';
		closeBtn.title = 'Close (Esc)';
		closeBtn.setAttribute('aria-label', 'Close table preview');
		closeBtn.addEventListener('click', () => this.close());
		header.appendChild(closeBtn);

		header.addEventListener('pointerdown', (e) => this.onDragStart(e));
		panel.appendChild(header);

		// Scroll wrapper
		this.scrollEl = document.createElement('div');
		this.scrollEl.className = 'table-preview-scroll';
		panel.appendChild(this.scrollEl);

		// Footer
		this.footerEl = document.createElement('div');
		this.footerEl.className = 'table-preview-footer';
		panel.appendChild(this.footerEl);

		// Resize handle
		const resizeHandle = document.createElement('div');
		resizeHandle.className = 'table-preview-resize-handle';
		resizeHandle.addEventListener('pointerdown', (e) => this.onResizeStart(e));
		panel.appendChild(resizeHandle);

		return panel;
	}

	private renderTable(data: { columns: string[]; rows: Record<string, unknown>[] }): void {
		if (!this.scrollEl) return;

		if (data.columns.length === 0 || data.rows.length === 0) {
			this.scrollEl.innerHTML = '<div class="table-preview-empty">No tabular data available</div>';
			if (this.footerEl) this.footerEl.textContent = '';
			return;
		}

		const table = document.createElement('table');
		table.className = 'table-preview-table';

		// Header
		const thead = document.createElement('thead');
		const headerRow = document.createElement('tr');
		// Row number column
		const thNum = document.createElement('th');
		thNum.className = 'table-preview-row-num';
		thNum.textContent = '#';
		headerRow.appendChild(thNum);
		for (const col of data.columns) {
			const th = document.createElement('th');
			th.textContent = col;
			th.title = col;
			headerRow.appendChild(th);
		}
		thead.appendChild(headerRow);
		table.appendChild(thead);

		// Body
		const tbody = document.createElement('tbody');
		for (let i = 0; i < data.rows.length; i++) {
			const row = data.rows[i];
			const tr = document.createElement('tr');

			// Row number
			const tdNum = document.createElement('td');
			tdNum.className = 'table-preview-row-num';
			tdNum.textContent = String(i + 1);
			tr.appendChild(tdNum);

			for (const col of data.columns) {
				const td = document.createElement('td');
				const value = row[col];
				td.textContent = formatCellValue(value);
				if (value === null || value === undefined) {
					td.classList.add('table-preview-null');
				}
				tr.appendChild(td);
			}
			tbody.appendChild(tr);
		}
		table.appendChild(tbody);

		this.scrollEl.innerHTML = '';
		this.scrollEl.appendChild(table);

		if (this.footerEl) {
			this.footerEl.textContent = `Showing ${data.rows.length} rows, ${data.columns.length} columns`;
		}
	}

	// ── Drag / Resize ───────────────────────────────────────────────

	private ensurePositioned(): void {
		if (!this.panel || this.hasBeenPositioned) return;
		const rect = this.panel.getBoundingClientRect();
		this.panel.style.top = `${rect.top}px`;
		this.panel.style.left = `${rect.left}px`;
		this.panel.style.width = `${rect.width}px`;
		this.panel.classList.add('table-preview-panel--positioned');
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

		this.panel!.classList.add('table-preview-panel--dragging');

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
			this.panel?.classList.remove('table-preview-panel--dragging');
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

			const maxW = window.innerWidth * 0.95;
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

	destroy(): void {
		this.focusTrap?.deactivate();
		this.focusTrap = null;
		document.removeEventListener('keydown', this.handleEsc);
		if (this.boundPointerMove) document.removeEventListener('pointermove', this.boundPointerMove);
		if (this.boundPointerUp) document.removeEventListener('pointerup', this.boundPointerUp);
		this.panel?.remove();
		this.panel = null;
	}
}

function formatCellValue(value: unknown): string {
	if (value === null || value === undefined) return 'null';
	if (typeof value === 'number') return value.toLocaleString();
	const str = String(value);
	if (str.length > 120) return str.substring(0, 120) + '...';
	return str;
}
