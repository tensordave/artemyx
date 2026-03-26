import type { Map, IControl } from 'maplibre-gl';
import { codeBlockIcon, playIcon, pencilIcon, eraserIcon, trashIcon, fileArrowUpIcon, magicWandIcon, exportIcon, fileCodeIcon, downloadSimpleIcon, boxArrowDownIcon, circleNotchIcon } from '../icons';
import { generateConfigYaml } from '../config/generator';
import { exportConfigYaml } from '../config/export-config';
import { exportViewerZip } from '../config/export-viewer';
import { highlightSync, highlightAsync } from '../utils/shiki';
import type { OutputResult } from '../config/output-types';
import { revokeOutputBlobs } from '../config/output-types';
import { executeOutputs, checkSourcesExist } from '../config/output-executor';
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

export interface ConfigControlOptions {
	onRun?: (yamlText?: string) => Promise<void>;
	onClear?: () => Promise<void>;
	getBasemapId?: () => string;
}

/**
 * Custom MapLibre control for viewing and editing the active YAML config.
 * Reads pre-highlighted Shiki HTML from a hidden #config-highlighted element
 * injected at build time by each Astro page.
 *
 * Header buttons:
 * - Edit (pencil icon): toggle edit mode (textarea for YAML editing)
 * - Run (play icon): teardown + re-execute current config pipeline
 * - Clear (eraser icon): teardown only, double-click confirm
 */
export class ConfigControl implements IControl {
	private map: Map | null = null;
	private container: HTMLDivElement | null = null;
	private panel: HTMLDivElement | null = null;
	private isOpen = false;
	private onPanelOpen?: () => void;
	private options: ConfigControlOptions;

	private editBtn: HTMLButtonElement | null = null;
	private importBtn: HTMLButtonElement | null = null;
	private generateBtn: HTMLButtonElement | null = null;
	private exportBtn: HTMLButtonElement | null = null;
	private exportDropdown: HTMLDivElement | null = null;
	private exportDropdownCloseHandler: ((e: MouseEvent) => void) | null = null;
	private outputsBtn: HTMLButtonElement | null = null;
	private outputsDropdown: HTMLDivElement | null = null;
	private outputsDropdownCloseHandler: ((e: MouseEvent) => void) | null = null;
	private outputResults: OutputResult[] = [];
	private isOutputsExecuting = false;
	private outputProgressListener: ProgressListener | null = null;
	private pmtilesSourceIds: Set<string> = new Set();
	private runBtn: HTMLButtonElement | null = null;
	private clearBtn: HTMLButtonElement | null = null;
	private bodyEl: HTMLDivElement | null = null;
	private fileInput: HTMLInputElement | null = null;
	private isExecuting = false;
	private clearConfirmTimer: ReturnType<typeof setTimeout> | null = null;
	private clearConfirmPending = false;

	private isEditing = false;
	private originalHtml = '';
	private rawYaml = '';
	private hasBeenEdited = false;
	private highlightEl: HTMLDivElement | null = null;
	private highlightRafId: number | null = null;

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

	private readonly MIN_WIDTH = 360;
	private readonly MIN_HEIGHT = 250;

	constructor(options?: ConfigControlOptions) {
		this.options = options ?? {};
	}

	setOnPanelOpen(cb: () => void): void {
		this.onPanelOpen = cb;
	}

	/**
	 * Update the displayed config with new YAML text.
	 * Used when restoring a saved config from OPFS on page load.
	 */
	updateConfig(yaml: string): void {
		this.rawYaml = yaml;
		this.hasBeenEdited = true;

		if (this.bodyEl && !this.isEditing) {
			highlightAsync(yaml).then((html) => {
				if (this.bodyEl && !this.isEditing) {
					this.bodyEl.innerHTML = html;
				}
			});
		}

		this.updateOutputsButtonState();
	}

	closePanel(): void {
		this.close();
	}

	private handleEsc = (e: KeyboardEvent) => {
		if (e.key === 'Escape') this.close();
	};

	onAdd(map: Map): HTMLElement {
		this.map = map;

		this.container = document.createElement('div');
		this.container.className = 'maplibregl-ctrl config-control';

		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'control-btn';
		btn.title = 'Config Editor';
		btn.innerHTML = codeBlockIcon;
		btn.addEventListener('click', () => this.toggle());
		this.container.appendChild(btn);

		// Build panel and append to map container (not control group)
		// so it can be positioned freely over the map
		this.panel = this.buildPanel();
		map.getContainer().appendChild(this.panel);

		return this.container;
	}

	onRemove(): void {
		document.removeEventListener('keydown', this.handleEsc);
		if (this.clearConfirmTimer) clearTimeout(this.clearConfirmTimer);
		if (this.highlightRafId) cancelAnimationFrame(this.highlightRafId);
		if (this.boundPointerMove) document.removeEventListener('pointermove', this.boundPointerMove);
		if (this.boundPointerUp) document.removeEventListener('pointerup', this.boundPointerUp);
		this.closeExportDropdown();
		this.closeOutputsDropdown();
		if (this.outputProgressListener) {
			removeProgressListener(this.outputProgressListener);
			this.outputProgressListener = null;
		}
		revokeOutputBlobs(this.outputResults);
		this.outputResults = [];
		this.panel?.remove();
		this.container?.remove();
		this.map = null;
		this.container = null;
		this.panel = null;
		this.editBtn = null;
		this.importBtn = null;
		this.generateBtn = null;
		this.exportBtn = null;
		this.outputsBtn = null;
		this.runBtn = null;
		this.clearBtn = null;
		this.bodyEl = null;
		this.fileInput = null;
		this.highlightEl = null;
	}

	private buildPanel(): HTMLDivElement {
		const sourceEl = document.getElementById('config-highlighted');

		// Cache raw YAML and build-time Shiki HTML
		this.rawYaml = sourceEl?.textContent ?? '';
		this.originalHtml = sourceEl?.innerHTML ?? '';

		const panel = document.createElement('div');
		panel.className = 'config-viewer';

		// Header
		const header = document.createElement('div');
		header.className = 'config-viewer-header';

		const filename = document.createElement('span');
		filename.className = 'config-viewer-filename';
		filename.textContent = sourceEl?.dataset.configFilename ?? 'config.yaml';
		header.appendChild(filename);

		// Action buttons
		const actions = document.createElement('div');
		actions.className = 'config-viewer-actions';

		// Authoring group (edit, import, generate)
		const authoringGroup = document.createElement('div');
		authoringGroup.className = 'config-viewer-btn-group';

		this.editBtn = document.createElement('button');
		this.editBtn.type = 'button';
		this.editBtn.className = 'config-viewer-action-btn';
		this.editBtn.title = 'Edit config';
		this.editBtn.innerHTML = pencilIcon;
		this.editBtn.addEventListener('click', () => this.toggleEdit());
		authoringGroup.appendChild(this.editBtn);

		this.importBtn = document.createElement('button');
		this.importBtn.type = 'button';
		this.importBtn.className = 'config-viewer-action-btn';
		this.importBtn.title = 'Import config file';
		this.importBtn.innerHTML = fileArrowUpIcon;
		this.importBtn.addEventListener('click', () => this.fileInput?.click());
		authoringGroup.appendChild(this.importBtn);

		// Hidden file input for import
		this.fileInput = document.createElement('input');
		this.fileInput.type = 'file';
		this.fileInput.accept = '.yaml,.yml';
		this.fileInput.style.display = 'none';
		this.fileInput.addEventListener('change', () => this.handleImport());
		panel.appendChild(this.fileInput);

		this.generateBtn = document.createElement('button');
		this.generateBtn.type = 'button';
		this.generateBtn.className = 'config-viewer-action-btn';
		this.generateBtn.title = 'Generate config from session';
		this.generateBtn.innerHTML = magicWandIcon;
		this.generateBtn.addEventListener('click', () => this.handleGenerate());
		authoringGroup.appendChild(this.generateBtn);

		actions.appendChild(authoringGroup);

		// Divider
		const divider1 = document.createElement('span');
		divider1.className = 'config-viewer-divider';
		actions.appendChild(divider1);

		// Download group (export)
		const downloadGroup = document.createElement('div');
		downloadGroup.className = 'config-viewer-btn-group';

		this.exportBtn = document.createElement('button');
		this.exportBtn.type = 'button';
		this.exportBtn.className = 'config-viewer-action-btn';
		this.exportBtn.title = 'Export';
		this.exportBtn.innerHTML = exportIcon;
		this.exportBtn.addEventListener('click', () => this.toggleExportDropdown());
		downloadGroup.appendChild(this.exportBtn);

		this.outputsBtn = document.createElement('button');
		this.outputsBtn.type = 'button';
		this.outputsBtn.className = 'config-viewer-action-btn';
		this.outputsBtn.title = 'Run outputs';
		this.outputsBtn.innerHTML = boxArrowDownIcon;
		this.outputsBtn.disabled = true;
		this.outputsBtn.addEventListener('click', () => this.handleOutputsClick());
		downloadGroup.appendChild(this.outputsBtn);

		actions.appendChild(downloadGroup);

		// Divider
		const divider2 = document.createElement('span');
		divider2.className = 'config-viewer-divider';
		actions.appendChild(divider2);

		// Execution group (run, clear)
		const executionGroup = document.createElement('div');
		executionGroup.className = 'config-viewer-btn-group';

		this.runBtn = document.createElement('button');
		this.runBtn.type = 'button';
		this.runBtn.className = 'config-viewer-action-btn config-viewer-action-btn--run';
		this.runBtn.title = 'Run config';
		this.runBtn.innerHTML = playIcon;
		this.runBtn.addEventListener('click', () => this.handleRun());
		executionGroup.appendChild(this.runBtn);

		this.clearBtn = document.createElement('button');
		this.clearBtn.type = 'button';
		this.clearBtn.className = 'config-viewer-action-btn config-viewer-action-btn--clear';
		this.clearBtn.title = 'Clear all data';
		this.clearBtn.innerHTML = eraserIcon;
		this.clearBtn.addEventListener('click', () => this.handleClear());
		executionGroup.appendChild(this.clearBtn);

		actions.appendChild(executionGroup);

		header.appendChild(actions);

		const closeBtn = document.createElement('button');
		closeBtn.type = 'button';
		closeBtn.className = 'config-viewer-close';
		closeBtn.textContent = '\u00d7';
		closeBtn.addEventListener('click', () => this.close());
		header.appendChild(closeBtn);

		panel.appendChild(header);

		// Body (Shiki-highlighted content)
		this.bodyEl = document.createElement('div');
		this.bodyEl.className = 'config-viewer-body';
		if (sourceEl) {
			this.bodyEl.innerHTML = sourceEl.innerHTML;
		}
		panel.appendChild(this.bodyEl);

		// Double-click body to enter edit mode
		this.bodyEl.addEventListener('dblclick', () => {
			if (!this.isEditing && !this.isExecuting) this.enterEditMode();
		});

		// Double-click header to exit edit mode
		header.addEventListener('dblclick', (e) => {
			const target = e.target as HTMLElement;
			if (target.closest('button')) return;
			if (this.isEditing && !this.isExecuting) this.exitEditMode();
		});

		// Resize handle (bottom-right corner)
		const resizeHandle = document.createElement('div');
		resizeHandle.className = 'config-viewer-resize-handle';
		resizeHandle.addEventListener('pointerdown', (e) => this.onResizeStart(e));
		panel.appendChild(resizeHandle);

		// Drag via header
		header.addEventListener('pointerdown', (e) => this.onDragStart(e));

		return panel;
	}

	private setButtonsDisabled(disabled: boolean): void {
		if (this.editBtn) this.editBtn.disabled = disabled;
		if (this.importBtn) this.importBtn.disabled = disabled;
		if (this.generateBtn) this.generateBtn.disabled = disabled;
		if (this.exportBtn) this.exportBtn.disabled = disabled;
		if (this.outputsBtn) this.outputsBtn.disabled = disabled;
		if (this.runBtn) this.runBtn.disabled = disabled;
		if (this.clearBtn) this.clearBtn.disabled = disabled;
	}

	private async handleGenerate(): Promise<void> {
		if (this.isExecuting || !this.map) return;
		this.setButtonsDisabled(true);
		try {
			const basemapId = this.options.getBasemapId?.() ?? 'carto-dark';
			// Round-trip outputs from current config if present
			let currentOutputs;
			try {
				const config = parseConfig(this.rawYaml);
				currentOutputs = config.outputs;
			} catch { /* no valid config to extract outputs from */ }
			const yaml = await generateConfigYaml(this.map, basemapId, currentOutputs);
			this.updateConfig(yaml);
			if (!this.isEditing) this.enterEditMode();
			const textarea = this.bodyEl?.querySelector('textarea');
			if (textarea) this.autoExpandPanel(textarea as HTMLTextAreaElement, 0.85);
		} finally {
			this.setButtonsDisabled(false);
		}
	}

	private toggleExportDropdown(): void {
		if (this.isExecuting) return;
		if (this.exportDropdown) {
			this.closeExportDropdown();
			return;
		}

		const dropdown = document.createElement('div');
		dropdown.className = 'context-menu';

		// Export Config item
		const configItem = document.createElement('div');
		configItem.className = 'context-menu-item';
		const configIconEl = document.createElement('span');
		configIconEl.className = 'context-menu-icon';
		configIconEl.innerHTML = fileCodeIcon;
		configItem.appendChild(configIconEl);
		configItem.appendChild(document.createTextNode('Export Config'));
		configItem.addEventListener('click', () => {
			this.closeExportDropdown();
			const filenameEl = this.panel?.querySelector('.config-viewer-filename');
			const name = filenameEl?.textContent?.replace(/\.yaml$/, '') || 'config';
			exportConfigYaml(this.rawYaml, name);
		});
		dropdown.appendChild(configItem);

		// Export Viewer (.zip) item
		const viewerItem = document.createElement('div');
		viewerItem.className = 'context-menu-item';
		const viewerIconEl = document.createElement('span');
		viewerIconEl.className = 'context-menu-icon';
		viewerIconEl.innerHTML = downloadSimpleIcon;
		viewerItem.appendChild(viewerIconEl);
		viewerItem.appendChild(document.createTextNode('Export Viewer (.zip)'));
		viewerItem.addEventListener('click', () => {
			this.closeExportDropdown();
			this.handleExportViewer();
		});
		dropdown.appendChild(viewerItem);

		// Position below the export button
		document.body.appendChild(dropdown);
		this.exportDropdown = dropdown;

		requestAnimationFrame(() => {
			if (!this.exportBtn || !this.exportDropdown) return;
			const btnRect = this.exportBtn.getBoundingClientRect();
			const menuRect = this.exportDropdown.getBoundingClientRect();

			let left = btnRect.left;
			let top = btnRect.bottom + 4;

			// Keep within viewport
			if (left + menuRect.width > window.innerWidth) {
				left = btnRect.right - menuRect.width;
			}
			if (top + menuRect.height > window.innerHeight) {
				top = btnRect.top - menuRect.height - 4;
			}

			this.exportDropdown.style.left = `${left}px`;
			this.exportDropdown.style.top = `${top}px`;
		});

		// Click-outside to close (delayed to avoid immediate closure)
		this.exportDropdownCloseHandler = (e: MouseEvent) => {
			if (!this.exportDropdown?.contains(e.target as Node)) {
				this.closeExportDropdown();
			}
		};
		setTimeout(() => {
			if (this.exportDropdownCloseHandler) {
				document.addEventListener('click', this.exportDropdownCloseHandler);
			}
		}, 10);
	}

	private closeExportDropdown(): void {
		if (this.exportDropdown) {
			this.exportDropdown.remove();
			this.exportDropdown = null;
		}
		if (this.exportDropdownCloseHandler) {
			document.removeEventListener('click', this.exportDropdownCloseHandler);
			this.exportDropdownCloseHandler = null;
		}
	}

	// ── Outputs dropdown ─────────────────────────────────────────────

	private updateOutputsButtonState(): void {
		if (!this.outputsBtn) return;
		try {
			const config = parseConfig(this.rawYaml);
			const hasOutputs = config.outputs && config.outputs.length > 0;
			this.outputsBtn.disabled = !hasOutputs || this.isExecuting;
		} catch {
			this.outputsBtn.disabled = true;
		}
	}

	private async handleOutputsClick(): Promise<void> {
		if (this.isExecuting || this.isOutputsExecuting) return;

		// If we already have completed results, toggle the dropdown
		if (this.outputResults.length > 0 && this.outputResults.every(r => !r.pending)) {
			if (this.outputsDropdown) {
				this.closeOutputsDropdown();
			} else {
				this.showOutputsDropdown();
			}
			return;
		}

		// Parse config
		let config;
		try {
			config = parseConfig(this.rawYaml);
		} catch {
			return;
		}
		if (!config.outputs || config.outputs.length === 0) return;

		// Pre-check: do all sources exist in DuckDB?
		const { allExist, missing } = await checkSourcesExist(config.outputs);
		if (!allExist) {
			this.showOutputsNotice(missing);
			return;
		}

		// Build pending results and show dropdown immediately
		this.isOutputsExecuting = true;
		if (this.outputsBtn) {
			this.outputsBtn.classList.add('config-viewer-action-btn--loading');
		}

		revokeOutputBlobs(this.outputResults);
		this.pmtilesSourceIds = new Set(
			config.outputs.filter(o => o.format === 'pmtiles').map(o => o.source)
		);
		this.outputResults = config.outputs.map(o => ({
			source: o.source,
			filename: `${o.filename || o.source}.${o.format}`,
			format: o.format,
			blobUrl: null,
			size: 0,
			pending: true,
			status: 'pending' as const,
		}));
		this.showOutputsDropdown();

		// Register worker progress listener for granular PMTiles updates
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
		};
		addProgressListener(this.outputProgressListener);

		try {
			const finalResults = await executeOutputs(config.outputs, (i, result) => {
				this.outputResults[i] = result;
				this.updateOutputRow(i);
			}, config.datasets);
			this.outputResults = finalResults;
			// Append "Download All" if multiple successes
			this.appendDownloadAll();
		} catch (e) {
			console.error('Output execution failed:', e);
		} finally {
			this.isOutputsExecuting = false;
			if (this.outputProgressListener) {
				removeProgressListener(this.outputProgressListener);
				this.outputProgressListener = null;
			}
			if (this.outputsBtn) {
				this.outputsBtn.classList.remove('config-viewer-action-btn--loading');
			}
			this.updateOutputsButtonState();
		}
	}

	private renderOutputRow(result: OutputResult): HTMLDivElement {
		const row = document.createElement('div');
		row.className = 'outputs-dropdown-row';

		// Status modifier class
		if (result.status === 'pending') row.classList.add('outputs-dropdown-row--pending');
		else if (result.status === 'generating') row.classList.add('outputs-dropdown-row--generating');

		const name = document.createElement('span');
		name.className = 'outputs-dropdown-filename';
		name.textContent = result.filename;
		row.appendChild(name);

		const badge = document.createElement('span');
		badge.className = `outputs-dropdown-badge outputs-dropdown-badge--${result.format}`;
		badge.textContent = result.format.toUpperCase();
		row.appendChild(badge);

		if (result.status === 'pending' || result.status === 'generating') {
			const status = document.createElement('span');
			status.className = 'outputs-dropdown-status outputs-dropdown-status--spinning';
			status.innerHTML = circleNotchIcon;
			row.appendChild(status);

			if (result.status === 'generating' && result.statusMessage) {
				const msgEl = document.createElement('span');
				msgEl.className = 'outputs-dropdown-status-text';
				msgEl.textContent = result.statusMessage;
				row.appendChild(msgEl);
			}

			// Progress bar for PMTiles
			if (result.progress !== undefined && result.progress > 0) {
				const bar = document.createElement('div');
				bar.className = 'outputs-dropdown-progress';
				bar.style.width = `${Math.round(result.progress * 100)}%`;
				row.appendChild(bar);
			}
		} else if (result.status === 'error' || result.error) {
			const errorEl = document.createElement('span');
			errorEl.className = 'outputs-dropdown-error';
			errorEl.textContent = result.error || 'Unknown error';
			row.appendChild(errorEl);
		} else {
			// complete
			const sizeEl = document.createElement('span');
			sizeEl.className = 'outputs-dropdown-size';
			sizeEl.textContent = formatFileSize(result.size);
			row.appendChild(sizeEl);

			const dlBtn = document.createElement('button');
			dlBtn.className = 'outputs-dropdown-dl';
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
		if (!this.outputsDropdown) return;
		const existing = this.outputsDropdown.querySelector(`[data-output-index="${index}"]`);
		if (!existing) return;
		const newRow = this.renderOutputRow(this.outputResults[index]);
		newRow.setAttribute('data-output-index', String(index));
		existing.replaceWith(newRow);
	}

	private appendDownloadAll(): void {
		if (!this.outputsDropdown) return;
		const successResults = this.outputResults.filter(r => r.blobUrl);
		if (successResults.length <= 1) return;

		const divider = document.createElement('div');
		divider.className = 'context-menu-divider';
		this.outputsDropdown.appendChild(divider);

		const downloadAll = document.createElement('div');
		downloadAll.className = 'context-menu-item';
		const dlIcon = document.createElement('span');
		dlIcon.className = 'context-menu-icon';
		dlIcon.innerHTML = downloadSimpleIcon;
		downloadAll.appendChild(dlIcon);
		downloadAll.appendChild(document.createTextNode('Download All (.zip)'));
		downloadAll.addEventListener('click', () => {
			this.closeOutputsDropdown();
			this.downloadAllAsZip(successResults);
		});
		this.outputsDropdown.appendChild(downloadAll);
	}

	private showOutputsNotice(missing: string[]): void {
		this.closeOutputsDropdown();
		const dropdown = document.createElement('div');
		dropdown.className = 'context-menu outputs-dropdown';

		const notice = document.createElement('div');
		notice.className = 'outputs-dropdown-notice';
		notice.textContent = 'Run the config first to load data.';
		dropdown.appendChild(notice);

		for (const id of missing) {
			const row = document.createElement('div');
			row.className = 'outputs-dropdown-missing';
			row.textContent = `Missing: ${id}`;
			dropdown.appendChild(row);
		}

		document.body.appendChild(dropdown);
		this.outputsDropdown = dropdown;
		this.positionOutputsDropdown();

		this.outputsDropdownCloseHandler = (e: MouseEvent) => {
			if (!this.outputsDropdown?.contains(e.target as Node)) {
				this.closeOutputsDropdown();
			}
		};
		setTimeout(() => {
			if (this.outputsDropdownCloseHandler) {
				document.addEventListener('click', this.outputsDropdownCloseHandler);
			}
		}, 10);
	}

	private showOutputsDropdown(): void {
		if (this.outputsDropdown) {
			this.closeOutputsDropdown();
		}

		const dropdown = document.createElement('div');
		dropdown.className = 'context-menu outputs-dropdown';

		for (let i = 0; i < this.outputResults.length; i++) {
			const row = this.renderOutputRow(this.outputResults[i]);
			row.setAttribute('data-output-index', String(i));
			dropdown.appendChild(row);
		}

		document.body.appendChild(dropdown);
		this.outputsDropdown = dropdown;
		this.positionOutputsDropdown();

		this.outputsDropdownCloseHandler = (e: MouseEvent) => {
			if (!this.outputsDropdown?.contains(e.target as Node)) {
				this.closeOutputsDropdown();
			}
		};
		setTimeout(() => {
			if (this.outputsDropdownCloseHandler) {
				document.addEventListener('click', this.outputsDropdownCloseHandler);
			}
		}, 10);
	}

	private positionOutputsDropdown(): void {
		requestAnimationFrame(() => {
			if (!this.outputsBtn || !this.outputsDropdown) return;
			const btnRect = this.outputsBtn.getBoundingClientRect();
			const menuRect = this.outputsDropdown.getBoundingClientRect();
			let left = btnRect.left;
			let top = btnRect.bottom + 4;
			if (left + menuRect.width > window.innerWidth) {
				left = btnRect.right - menuRect.width;
			}
			if (top + menuRect.height > window.innerHeight) {
				top = btnRect.top - menuRect.height - 4;
			}
			this.outputsDropdown.style.left = `${left}px`;
			this.outputsDropdown.style.top = `${top}px`;
		});
	}

	private closeOutputsDropdown(): void {
		if (this.outputsDropdown) {
			this.outputsDropdown.remove();
			this.outputsDropdown = null;
		}
		if (this.outputsDropdownCloseHandler) {
			document.removeEventListener('click', this.outputsDropdownCloseHandler);
			this.outputsDropdownCloseHandler = null;
		}
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
		if (this.isExecuting || !this.map) return;
		this.setButtonsDisabled(true);
		try {
			const basemapId = this.options.getBasemapId?.() ?? 'carto-dark';
			await exportViewerZip(this.map, basemapId);
		} finally {
			this.setButtonsDisabled(false);
		}
	}

	private handleImport(): void {
		const file = this.fileInput?.files?.[0];
		if (!file) return;

		const reader = new FileReader();
		reader.onload = () => {
			const text = reader.result as string;
			this.rawYaml = text;
			this.hasBeenEdited = true;

			if (this.isEditing) {
				// Update textarea and re-highlight
				const textarea = this.bodyEl?.querySelector('textarea');
				if (textarea) {
					textarea.value = text;
					this.updateHighlight(text);
					this.autoExpandPanel(textarea, 0.85);
				}
			} else {
				// Enter edit mode with imported content
				this.enterEditMode();
				const ta = this.bodyEl?.querySelector('textarea');
				if (ta) this.autoExpandPanel(ta as HTMLTextAreaElement, 0.85);
			}
		};
		reader.readAsText(file);

		// Reset so re-importing the same file triggers change
		if (this.fileInput) this.fileInput.value = '';
	}

	private toggleEdit(): void {
		if (this.isExecuting) return;
		this.resetClearConfirm();

		if (this.isEditing) {
			this.exitEditMode();
		} else {
			this.enterEditMode();
		}
	}

	private enterEditMode(): void {
		if (!this.bodyEl) return;
		this.isEditing = true;
		this.panel?.classList.add('config-viewer--editing');
		this.editBtn!.classList.add('config-viewer-action-btn--active');
		this.editBtn!.innerHTML = pencilIcon.replace('fill="#3388ff"', 'fill="#22c55e"');
		this.editBtn!.title = 'Exit edit mode';

		// Disable Run while editing
		if (this.runBtn) this.runBtn.disabled = true;

		// Lock panel height (not body) so content swap doesn't cause layout shift
		// Body stays flex:1 to fill naturally, allowing resize to work
		this.ensurePositioned();

		// Build overlay structure: highlight layer (background) + textarea (foreground)
		const editor = document.createElement('div');
		editor.className = 'config-viewer-editor';

		this.highlightEl = document.createElement('div');
		this.highlightEl.className = 'config-viewer-highlight';
		editor.appendChild(this.highlightEl);

		const textarea = document.createElement('textarea');
		textarea.className = 'config-viewer-textarea';
		textarea.value = this.rawYaml;
		textarea.spellcheck = false;

		// Re-highlight on input, batched to next animation frame; auto-grow and expand panel
		textarea.addEventListener('input', () => {
			if (this.highlightRafId) cancelAnimationFrame(this.highlightRafId);
			this.highlightRafId = requestAnimationFrame(() => {
				this.updateHighlight(textarea.value);
				this.autoGrow(textarea);
				this.autoExpandPanel(textarea);
			});
		});

		editor.appendChild(textarea);

		// Preserve scroll position across view -> edit transition
		const savedScroll = this.bodyEl.scrollTop;

		this.bodyEl.innerHTML = '';
		this.bodyEl.appendChild(editor);

		// Initial highlight
		this.updateHighlight(this.rawYaml);

		textarea.focus();
		textarea.setSelectionRange(0, 0);

		// Defer until layout settles: auto-grow textarea and restore body scroll
		requestAnimationFrame(() => {
			this.autoGrow(textarea);
			if (this.bodyEl) this.bodyEl.scrollTop = savedScroll;
		});
	}

	private autoGrow(textarea: HTMLTextAreaElement): void {
		const savedScroll = this.bodyEl?.scrollTop ?? 0;
		textarea.style.height = 'auto';
		textarea.style.height = `${textarea.scrollHeight}px`;
		if (this.bodyEl) this.bodyEl.scrollTop = savedScroll;
	}

	private autoExpandPanel(textarea: HTMLTextAreaElement, maxRatio = 0.6): void {
		if (!this.panel || !this.bodyEl) return;
		const normalMax = window.innerHeight * maxRatio;
		const panelRect = this.panel.getBoundingClientRect();
		if (panelRect.height >= normalMax) return;

		const headerHeight = panelRect.height - this.bodyEl.offsetHeight;
		const neededPanelHeight = textarea.scrollHeight + headerHeight;
		if (neededPanelHeight > panelRect.height) {
			const newHeight = Math.min(neededPanelHeight, normalMax);
			this.panel.style.height = `${newHeight}px`;

			// Shift panel up if it would overflow below the viewport
			const overflow = panelRect.top + newHeight - window.innerHeight;
			if (overflow > 0) {
				const newTop = Math.max(0, panelRect.top - overflow);
				this.panel.style.top = `${newTop}px`;
			}
		}
	}

	private updateHighlight(yaml: string): void {
		if (!this.highlightEl) return;
		const html = highlightSync(yaml);
		if (html) {
			this.highlightEl.innerHTML = html;
		} else {
			highlightAsync(yaml).then((h) => {
				if (this.highlightEl && this.isEditing) {
					this.highlightEl.innerHTML = h;
				}
			});
		}
	}

	private exitEditMode(): void {
		if (!this.bodyEl) return;
		this.isEditing = false;
		this.panel?.classList.remove('config-viewer--editing');
		this.editBtn!.classList.remove('config-viewer-action-btn--active');
		this.editBtn!.innerHTML = pencilIcon;
		this.editBtn!.title = 'Edit config';

		// Capture textarea content, scroll position, and clean up highlight state
		const textarea = this.bodyEl.querySelector('textarea');
		const savedScroll = this.bodyEl.scrollTop;
		if (textarea) {
			this.rawYaml = textarea.value;
			this.hasBeenEdited = true;
		}
		if (this.highlightRafId) cancelAnimationFrame(this.highlightRafId);
		this.highlightRafId = null;
		this.highlightEl = null;

		// Re-enable Run
		if (this.runBtn) this.runBtn.disabled = false;

		// Re-highlight with Shiki (async - show plain text as brief fallback)
		this.bodyEl.innerHTML = '';
		const pre = document.createElement('pre');
		pre.style.margin = '0';
		pre.style.padding = '16px';
		const code = document.createElement('code');
		code.textContent = this.rawYaml;
		pre.appendChild(code);
		this.bodyEl.appendChild(pre);
		this.bodyEl.scrollTop = savedScroll;

		highlightAsync(this.rawYaml).then((html) => {
			if (this.bodyEl && !this.isEditing) {
				const scrollPos = this.bodyEl.scrollTop;
				this.bodyEl.innerHTML = html;
				this.bodyEl.scrollTop = scrollPos;
			}
		});

		this.updateOutputsButtonState();
	}

	private async handleRun(): Promise<void> {
		if (this.isExecuting || !this.options.onRun) return;
		this.resetClearConfirm();

		// Clear previous output results on re-run
		revokeOutputBlobs(this.outputResults);
		this.outputResults = [];
		this.closeOutputsDropdown();

		this.isExecuting = true;
		this.setButtonsDisabled(true);
		try {
			await this.options.onRun(this.hasBeenEdited ? this.rawYaml : undefined);
		} finally {
			this.isExecuting = false;
			this.setButtonsDisabled(false);
			this.updateOutputsButtonState();
		}
	}

	private async handleClear(): Promise<void> {
		if (this.isExecuting || !this.options.onClear) return;

		// Double-click confirm pattern
		if (!this.clearConfirmPending) {
			this.clearConfirmPending = true;
			this.clearBtn!.classList.add('config-viewer-action-btn--confirm');
			this.clearBtn!.innerHTML = trashIcon.replace('fill="#3388ff"', 'fill="#ef4444"');
			this.clearBtn!.title = 'Click again to confirm';

			this.clearConfirmTimer = setTimeout(() => {
				this.resetClearConfirm();
			}, 3000);
			return;
		}

		// Second click - execute
		this.resetClearConfirm();
		this.isExecuting = true;
		this.setButtonsDisabled(true);
		try {
			await this.options.onClear();
		} finally {
			this.isExecuting = false;
			this.setButtonsDisabled(false);
		}
	}

	private resetClearConfirm(): void {
		this.clearConfirmPending = false;
		if (this.clearConfirmTimer) {
			clearTimeout(this.clearConfirmTimer);
			this.clearConfirmTimer = null;
		}
		if (this.clearBtn) {
			this.clearBtn.classList.remove('config-viewer-action-btn--confirm');
			this.clearBtn.innerHTML = eraserIcon;
			this.clearBtn.title = 'Clear all data';
		}
	}

	private ensurePositioned(): void {
		if (!this.panel || this.hasBeenPositioned) return;
		const rect = this.panel.getBoundingClientRect();
		this.panel.style.top = `${rect.top}px`;
		this.panel.style.left = `${rect.left}px`;
		this.panel.style.width = `${rect.width}px`;
		this.panel.style.height = `${rect.height}px`;
		this.panel.style.maxHeight = 'none';
		this.panel.classList.add('config-viewer--positioned');
		this.hasBeenPositioned = true;
	}

	private onDragStart(e: PointerEvent): void {
		// Don't drag when clicking buttons or on mobile
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

		this.panel!.classList.add('config-viewer--dragging');

		this.boundPointerMove = (ev: PointerEvent) => {
			const dx = ev.clientX - this.dragStartX;
			const dy = ev.clientY - this.dragStartY;
			let newX = this.panelStartX + dx;
			let newY = this.panelStartY + dy;

			// Clamp to viewport
			const w = this.panel!.offsetWidth;
			const h = this.panel!.offsetHeight;
			newX = Math.max(0, Math.min(newX, window.innerWidth - w));
			newY = Math.max(0, Math.min(newY, window.innerHeight - h));

			this.panel!.style.left = `${newX}px`;
			this.panel!.style.top = `${newY}px`;
		};

		this.boundPointerUp = () => {
			this.isDragging = false;
			this.panel?.classList.remove('config-viewer--dragging');
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
		this.panel.classList.add('config-viewer--open');
		this.onPanelOpen?.();
		document.addEventListener('keydown', this.handleEsc);
	}

	private close(): void {
		if (!this.panel) return;
		this.isOpen = false;
		this.panel.classList.remove('config-viewer--open');
		this.resetClearConfirm();
		this.closeOutputsDropdown();

		// Capture textarea content if closing mid-edit
		this.panel?.classList.remove('config-viewer--editing');
		if (this.isEditing && this.bodyEl) {
			const textarea = this.bodyEl.querySelector('textarea');
			if (textarea) {
				this.rawYaml = textarea.value;
				this.hasBeenEdited = true;
			}
			if (this.highlightRafId) cancelAnimationFrame(this.highlightRafId);
			this.highlightRafId = null;
			this.highlightEl = null;
			this.isEditing = false;
			this.editBtn?.classList.remove('config-viewer-action-btn--active');
			if (this.editBtn) {
				this.editBtn.innerHTML = pencilIcon;
				this.editBtn.title = 'Edit config';
			}
			if (this.runBtn) this.runBtn.disabled = false;

			// Re-highlight for next open
			highlightAsync(this.rawYaml).then((html) => {
				if (this.bodyEl && !this.isEditing) {
					this.bodyEl.innerHTML = html;
				}
			});
		}

		document.removeEventListener('keydown', this.handleEsc);
	}
}
