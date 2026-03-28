import type { Map, IControl } from 'maplibre-gl';
import { boxArrowDownIcon, circleNotchIcon, codeBlockIcon, downloadSimpleIcon, playIcon } from '../icons';
import type { OutputResult } from '../config/output-types';
import { revokeOutputBlobs } from '../config/output-types';
import { executeOutputs, checkSourcesExist } from '../config/output-executor';
import { exportViewerZip } from '../config/export-viewer';
import { parseConfig } from '../config/parser';
import { addProgressListener, removeProgressListener } from '../db';
import type { ProgressListener } from '../db';
import { zipSync } from 'fflate';

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

export interface OutputsControlOptions {
	getYaml: () => string;
	getBasemapId?: () => string;
	openConfigEditor?: () => void;
}

export class OutputsControl implements IControl {
	private map: Map | null = null;
	private container: HTMLDivElement | null = null;
	private panel: HTMLDivElement | null = null;
	private isOpen = false;
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
		btn.title = 'Outputs';
		btn.innerHTML = boxArrowDownIcon;
		btn.addEventListener('click', () => this.toggle());
		this.container.appendChild(btn);

		this.panel = this.buildPanel();
		map.getContainer().appendChild(this.panel);

		return this.container;
	}

	onRemove(): void {
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
		revokeOutputBlobs(this.outputResults);
		this.panel?.remove();
		this.container?.remove();
		this.map = null;
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
		closeBtn.addEventListener('click', () => this.close());
		header.appendChild(closeBtn);

		header.addEventListener('pointerdown', (e) => this.onDragStart(e));
		panel.appendChild(header);

		// Body
		this.outputsBody = document.createElement('div');
		this.outputsBody.className = 'outputs-body';
		this.renderBody();
		panel.appendChild(this.outputsBody);

		// Resize handle
		const resizeHandle = document.createElement('div');
		resizeHandle.className = 'outputs-resize-handle';
		resizeHandle.addEventListener('pointerdown', (e) => this.onResizeStart(e));
		panel.appendChild(resizeHandle);

		return panel;
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

	private toggle(): void {
		if (this.isOpen) {
			this.close();
		} else {
			this.open();
		}
	}

	private open(): void {
		if (!this.panel) return;
		this.isOpen = true;
		this.panel.classList.add('outputs-panel--open');
		this.renderBody();
		document.addEventListener('keydown', this.handleEsc);
		this.onPanelOpen?.();
	}

	private close(): void {
		if (!this.panel) return;
		this.isOpen = false;
		this.panel.classList.remove('outputs-panel--open');
		document.removeEventListener('keydown', this.handleEsc);
		this.onPanelClose?.();
	}

	// ── Drag / Resize ───────────────────────────────────────────────

	private ensurePositioned(): void {
		if (!this.panel || this.hasBeenPositioned) return;
		const rect = this.panel.getBoundingClientRect();
		this.panel.style.top = `${rect.top}px`;
		this.panel.style.left = `${rect.left}px`;
		this.panel.style.width = `${rect.width}px`;
		this.panel.style.height = `${rect.height}px`;
		this.panel.style.maxHeight = 'none';
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
