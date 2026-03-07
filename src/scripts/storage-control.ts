import maplibregl from 'maplibre-gl';
import { databaseIcon, crosshairIcon, trashIcon } from './icons';
import { getStorageMode, getFallbackReason, clearOPFS } from './db/core';
import { clearCachedViewport, getCachedViewport } from './db/datasets';
import type { FallbackReason } from './db/core';

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Icon fill colors by storage state */
const ICON_COLORS: Record<string, string> = {
	opfs: '#22c55e',     // green — persisted locally
	memory: '#3388ff',   // blue — temporary/session-only
	error: '#f59e0b',    // amber — fallback/error
};

/** Reasons that count as an error state for icon coloring */
const ERROR_REASONS: FallbackReason[] = ['opfs-failed', 'corruption', 'quota-exceeded'];

interface StorageControlOptions {
	/** Called when this control's panel opens, so other right-hand controls can close */
	onPanelOpen?: () => void;
}

/**
 * Detect other open tabs via BroadcastChannel.
 * Posts 'tab-open' on creation; responds 'tab-present' to others.
 * Returns a promise that resolves to true if another tab responds within 200ms.
 */
function detectOtherTabs(): Promise<boolean> {
	return new Promise((resolve) => {
		try {
			const channel = new BroadcastChannel('artemyx-gis');
			let detected = false;

			channel.addEventListener('message', (e) => {
				if (e.data === 'tab-open') {
					// Another tab just opened — tell it we're here
					channel.postMessage('tab-present');
				} else if (e.data === 'tab-present') {
					detected = true;
				}
			});

			// Announce ourselves
			channel.postMessage('tab-open');

			// Wait 200ms for a response, then resolve
			setTimeout(() => resolve(detected), 200);
		} catch {
			// BroadcastChannel not supported — skip detection
			resolve(false);
		}
	});
}

export class StorageControl implements maplibregl.IControl {
	private container: HTMLDivElement | undefined;
	private button: HTMLButtonElement | undefined;
	private panel: HTMLDivElement | undefined;
	private onPanelOpen?: () => void;
	private multiTabDetected = false;
	private onDocPointerDown: (e: PointerEvent) => void;

	constructor(options?: StorageControlOptions) {
		this.onPanelOpen = options?.onPanelOpen;
		this.onDocPointerDown = (e: PointerEvent) => {
			if (!this.container?.contains(e.target as Node)) {
				this.closePanel();
			}
		};

		// Start multi-tab detection immediately (non-blocking)
		detectOtherTabs().then((detected) => {
			this.multiTabDetected = detected;
			if (detected) {
				console.warn('[Storage] Another tab is already open — shared OPFS access may cause issues');
				this.updateIconColor();
			}
		});
	}

	onAdd(_map: maplibregl.Map): HTMLElement {
		this.container = document.createElement('div');
		this.container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
		this.container.classList.add('control-container');

		// Toggle button
		this.button = document.createElement('button');
		this.button.type = 'button';
		this.button.className = 'control-btn';
		this.button.innerHTML = databaseIcon;
		this.button.title = 'Storage';
		this.container.appendChild(this.button);

		// Panel (hidden by default)
		this.panel = document.createElement('div');
		this.panel.className = 'control-panel control-panel--right storage-panel';
		this.container.appendChild(this.panel);

		// Toggle panel on click
		this.button.addEventListener('click', () => {
			if (this.panel) {
				const isOpen = this.panel.classList.toggle('control-panel--open');
				if (isOpen) {
					this.onPanelOpen?.();
					this.renderPanel();
					document.addEventListener('pointerdown', this.onDocPointerDown);
				} else {
					document.removeEventListener('pointerdown', this.onDocPointerDown);
				}
			}
		});

		// Set initial icon color
		this.updateIconColor();

		return this.container;
	}

	onRemove(): void {
		document.removeEventListener('pointerdown', this.onDocPointerDown);
		if (this.container?.parentNode) {
			this.container.parentNode.removeChild(this.container);
		}
	}

	setOnPanelOpen(cb: () => void): void {
		this.onPanelOpen = cb;
	}

	/**
	 * Close the panel (called externally for right-hand mutual exclusivity).
	 */
	closePanel(): void {
		this.panel?.classList.remove('control-panel--open');
		document.removeEventListener('pointerdown', this.onDocPointerDown);
	}

	/**
	 * Refresh icon color based on current storage state.
	 * Call after init completes or when fallback reason changes.
	 */
	updateIconColor(): void {
		if (!this.button) return;

		const svg = this.button.querySelector('svg');
		if (!svg) return;

		const mode = getStorageMode();
		const reason = getFallbackReason();
		const isError = ERROR_REASONS.includes(reason);

		const color = (isError || this.multiTabDetected) ? ICON_COLORS.error
			: mode === 'opfs' ? ICON_COLORS.opfs
			: ICON_COLORS.memory;

		svg.setAttribute('fill', color);
	}

	/**
	 * Render the panel contents based on current storage state.
	 */
	private renderPanel(): void {
		if (!this.panel) return;
		this.panel.innerHTML = '';

		const mode = getStorageMode();
		const reason = getFallbackReason();
		const isError = ERROR_REASONS.includes(reason);
		const hasWarning = isError || this.multiTabDetected;

		// Status badge
		const badge = document.createElement('div');
		badge.className = 'storage-badge';

		const dot = document.createElement('span');
		dot.className = 'storage-dot';
		dot.style.backgroundColor = hasWarning ? ICON_COLORS.error
			: mode === 'opfs' ? ICON_COLORS.opfs
			: ICON_COLORS.memory;
		badge.appendChild(dot);

		const label = document.createElement('span');
		label.className = 'storage-label';
		label.textContent = isError ? 'Storage unavailable'
			: this.multiTabDetected ? 'Multiple tabs open'
			: mode === 'opfs' ? 'Persisted (local)'
			: 'Session only';
		badge.appendChild(label);

		this.panel.appendChild(badge);

		// Error detail message
		if (isError) {
			const detail = document.createElement('div');
			detail.className = 'storage-detail storage-detail--error';
			detail.textContent = reason === 'quota-exceeded'
				? 'Storage quota exceeded. Data is temporary until the browser is closed.'
				: reason === 'corruption'
				? 'Database was corrupted and could not be recovered.'
				: 'Browser storage is unavailable. Data will not persist across sessions.';
			this.panel.appendChild(detail);
		} else if (mode === 'opfs') {
			const detail = document.createElement('div');
			detail.className = 'storage-detail';
			detail.textContent = 'Datasets persist across page refreshes.';
			this.panel.appendChild(detail);
		} else if (reason === 'disabled') {
			const detail = document.createElement('div');
			detail.className = 'storage-detail';
			detail.textContent = 'Persistence is disabled for this map.';
			this.panel.appendChild(detail);
		}

		// Multi-tab warning (shown alongside storage status)
		if (this.multiTabDetected) {
			const detail = document.createElement('div');
			detail.className = 'storage-detail storage-detail--error';
			detail.textContent = 'Another tab is using the same database. Multiple tabs writing to OPFS simultaneously can cause data corruption. Close other tabs to avoid issues.';
			this.panel.appendChild(detail);
		}

		// Quota usage (async — fills in after panel opens)
		if (mode === 'opfs' || reason === 'quota-exceeded') {
			const quotaEl = document.createElement('div');
			quotaEl.className = 'storage-detail storage-quota';
			this.panel.appendChild(quotaEl);
			this.renderQuotaUsage(quotaEl);
		}

		// Divider
		const divider = document.createElement('div');
		divider.className = 'storage-divider';
		this.panel.appendChild(divider);

		// Clear Session button (OPFS or error state — not for disabled/demo maps)
		if (reason !== 'disabled') {
			if (isError) {
				this.addClearRetryButton();
			} else {
				this.addClearSessionButton();
			}
		}
	}

	/**
	 * Fetch storage estimate and populate the quota element.
	 */
	private async renderQuotaUsage(el: HTMLElement): Promise<void> {
		if (!navigator.storage?.estimate) {
			el.textContent = 'Storage estimate unavailable';
			return;
		}

		try {
			const { usage = 0, quota = 0 } = await navigator.storage.estimate();
			if (quota === 0) {
				el.textContent = 'Storage estimate unavailable';
				return;
			}
			const pct = Math.round((usage / quota) * 100);
			el.textContent = `Storage: ${formatBytes(usage)} of ${formatBytes(quota)} used (${pct}%)`;
		} catch {
			el.textContent = 'Storage estimate unavailable';
		}
	}

	/**
	 * Add "Clear Session" button with inline confirmation (same UX as layer delete),
	 * plus a small viewport-reset button beside it.
	 */
	private addClearSessionButton(): void {
		if (!this.panel) return;

		const row = document.createElement('div');
		row.className = 'storage-action-row';

		const btn = document.createElement('button');
		btn.className = 'storage-action-btn';
		btn.textContent = 'Clear Session';
		btn.title = 'Remove all persisted data and reload';

		let confirmPending = false;

		btn.addEventListener('click', () => {
			if (!confirmPending) {
				// First click: switch to confirm state
				confirmPending = true;
				btn.textContent = 'Click again to confirm';
				btn.classList.add('storage-action-btn--confirm');

				// Auto-revert after 3 seconds
				setTimeout(() => {
					if (confirmPending) {
						confirmPending = false;
						btn.textContent = 'Clear Session';
						btn.classList.remove('storage-action-btn--confirm');
					}
				}, 3000);
			} else {
				// Second click: execute
				btn.textContent = 'Clearing...';
				btn.disabled = true;
				clearOPFS();
			}
		});

		row.appendChild(btn);

		// Viewport reset button (only shown when a saved viewport exists)
		if (getCachedViewport()) {
			const vpBtn = document.createElement('button');
			vpBtn.className = 'storage-action-btn storage-action-btn--icon';
			vpBtn.innerHTML = crosshairIcon;
			vpBtn.title = 'Reset saved map position';

			let vpConfirmPending = false;

			vpBtn.addEventListener('click', () => {
				if (!vpConfirmPending) {
					vpConfirmPending = true;
					vpBtn.innerHTML = trashIcon;
					vpBtn.classList.add('storage-action-btn--confirm');

					setTimeout(() => {
						if (vpConfirmPending) {
							vpConfirmPending = false;
							vpBtn.innerHTML = crosshairIcon;
							vpBtn.classList.remove('storage-action-btn--confirm');
						}
					}, 3000);
				} else {
					clearCachedViewport();
					vpBtn.remove();
				}
			});

			row.appendChild(vpBtn);
		}

		this.panel.appendChild(row);
	}

	/**
	 * Add "Clear & Retry" button for error recovery (no double-confirm needed).
	 */
	private addClearRetryButton(): void {
		if (!this.panel) return;

		const btn = document.createElement('button');
		btn.className = 'storage-action-btn storage-action-btn--retry';
		btn.textContent = 'Clear & Retry';
		btn.title = 'Delete corrupted storage and reload';

		btn.addEventListener('click', () => {
			btn.textContent = 'Clearing...';
			btn.disabled = true;
			clearOPFS();
		});

		this.panel.appendChild(btn);
	}
}
