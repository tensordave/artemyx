import maplibregl from 'maplibre-gl';
import { getDatasets, updateDatasetVisible, swapLayerOrder, updateDatasetName } from '../db';
import { renameDataset } from '../layer-actions/rename';
import type { LegendControl } from './legend-control';
import type { DatasetControl } from './dataset-control';
import { updateHoverLabel } from '../controls/popup';
import { getLayersForDataset } from '../layers';
import { stackIcon } from '../icons';
import { progressControl } from '../map';
import { toggleLayerVisibility } from '../layer-actions/visibility';
import { showDeleteConfirmation, deleteDatasetWithLayers } from '../layer-actions/delete';
import { createContextMenu, type ContextMenuHandle } from '../layer-actions/context-menu';
import { createExportItems, createDeleteItem, createMenuDivider } from '../layer-actions/context-menu-items';
import { exportDatasetAs } from '../layer-actions/export';
import { buildStyleView, savePendingStyle } from '../layer-actions/style';
import { createLayerRow, type Dataset } from '../layer-actions/layer-row';
import { resyncLayerOrder } from '../layers';
import type { OperationBuilderControl } from './operation-builder-control';
import { createFocusTrap, type FocusTrap } from '../utils/focus-trap';

/**
 * Custom control for toggling layer visibility
 */
export class LayerToggleControl implements maplibregl.IControl {
	private container: HTMLDivElement | undefined;
	private button: HTMLButtonElement | undefined;
	private panel: HTMLDivElement | undefined;
	private map: maplibregl.Map | undefined;
	private contextMenuHandle: ContextMenuHandle | undefined;
	private currentContextMenuDatasetId: string | undefined;
	private onPanelOpen?: () => void;
	private liveRegion: HTMLDivElement | undefined;
	/** Cached ordered dataset list from last refreshPanel(), used for reorder logic */
	private datasets: any[] = [];
	/** Current view state: 'list' shows layer rows, 'style' shows style controls */
	private currentView: 'list' | 'style' = 'list';
	/** Dataset ID of the currently displayed style view */
	private currentStyleDatasetId: string | undefined;
	/** Global tracker of loaded dataset IDs on the map */
	private loadedDatasets?: Set<string>;
	/** Operation Builder control, notified on dataset rename/delete */
	private operationBuilderControl?: OperationBuilderControl;
	/** Legend control, refreshed on PMTiles rename */
	private legendControl?: LegendControl;
	/** Dataset control, icon color updated on dataset changes */
	private datasetControl?: DatasetControl;
	private focusTrap: FocusTrap | null = null;
	private previousFocus: HTMLElement | null = null;

	/**
	 * Set the callback for when this panel opens (wired after both controls exist).
	 */
	setOnPanelOpen(cb: () => void): void {
		this.onPanelOpen = cb;
	}

	/**
	 * Set the loaded datasets tracker (wired after construction in map.ts).
	 */
	setLoadedDatasets(ds: Set<string>): void {
		this.loadedDatasets = ds;
	}

	/**
	 * Set the Operation Builder control reference for dataset change notifications.
	 */
	setOperationBuilderControl(obc: OperationBuilderControl): void {
		this.operationBuilderControl = obc;
	}

	/**
	 * Set the Legend control reference for refresh on PMTiles rename.
	 */
	setLegendControl(lc: LegendControl): void {
		this.legendControl = lc;
	}

	setDatasetControl(dc: DatasetControl): void {
		this.datasetControl = dc;
	}

	onAdd(map: maplibregl.Map) {
		this.map = map;
		this.container = document.createElement('div');
		this.container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
		this.container.classList.add('control-container');

		// Toggle button
		this.button = document.createElement('button');
		this.button.type = 'button';
		this.button.className = 'control-btn';
		this.button.innerHTML = stackIcon;
		this.button.title = 'Toggle layers (L)';
		this.button.setAttribute('aria-label', 'Toggle layers');
		this.button.setAttribute('aria-expanded', 'false');
		this.container.appendChild(this.button);

		// Visually-hidden live region for screen reader announcements
		this.liveRegion = document.createElement('div');
		this.liveRegion.setAttribute('aria-live', 'polite');
		this.liveRegion.setAttribute('role', 'status');
		this.liveRegion.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0';
		this.container.appendChild(this.liveRegion);

		// Panel (hidden by default, positioned absolutely)
		this.panel = document.createElement('div');
		this.panel.className = 'control-panel control-panel--left control-panel--layers';
		this.container.appendChild(this.panel);

		// Toggle panel visibility
		this.button.addEventListener('click', () => {
			if (this.panel) {
				const isOpen = this.panel.classList.toggle('control-panel--open');
				this.button!.setAttribute('aria-expanded', String(isOpen));
				if (isOpen) {
					this.previousFocus = document.activeElement as HTMLElement | null;
					this.onPanelOpen?.();
					this.showListView();
					this.focusTrap = createFocusTrap(this.panel);
					this.focusTrap.activate();
					this.focusTrap.focusFirst();
				} else {
					this.focusTrap?.deactivate();
					this.focusTrap = null;
					if (this.previousFocus?.isConnected) this.previousFocus.focus();
					this.previousFocus = null;
				}
			}
		});

		return this.container;
	}

	/**
	 * Show the layer list view (default view).
	 * Saves any pending style changes before transitioning.
	 */
	private async showListView() {
		await savePendingStyle();
		this.currentView = 'list';
		this.currentStyleDatasetId = undefined;
		await this.refreshPanel();
		this.focusTrap?.updateElements();
	}

	/**
	 * Show the style view for a specific dataset.
	 * Replaces the panel content with style controls.
	 */
	private async showStyleView(dataset: Dataset) {
		if (!this.panel || !this.map) return;

		// Save any pending style from a previous style view
		await savePendingStyle();

		this.closeContextMenu();
		this.currentView = 'style';
		this.currentStyleDatasetId = dataset.id;

		await buildStyleView(
			this.map,
			dataset,
			this.panel,
			progressControl,
			() => { this.showListView(); },
			(newColor) => {
				// Update the style view header border color to reflect the new color
				const header = this.panel?.querySelector('.style-view-header') as HTMLElement | null;
				if (header) {
					header.style.borderLeftColor = newColor;
				}
			},
			async (newName: string) => {
				progressControl.updateProgress(`Renaming to "${newName}"...`, 'processing');

				if (dataset.format === 'pmtiles') {
					// PMTiles: display-name only (ID encodes parent/sourceLayer structure)
					const ok = await updateDatasetName(dataset.id, newName);
					if (ok) {
						dataset.name = newName;
						const layerInfos = getLayersForDataset(this.map!, dataset.id);
						updateHoverLabel(layerInfos.map(l => l.id), newName);
						this.legendControl?.refresh();
						progressControl.updateProgress(`Renamed to "${newName}"`, 'success');
						progressControl.scheduleIdle(3000);
						this.showListView();
					} else {
						progressControl.updateProgress('Failed to rename dataset', 'error');
						progressControl.scheduleIdle(5000);
					}
					return;
				}

				const oldId = dataset.id;
				const result = await renameDataset(this.map!, oldId, newName, progressControl);
				if (result.success) {
					if (this.loadedDatasets) {
						this.loadedDatasets.delete(oldId);
						this.loadedDatasets.add(result.newId);
					}
					dataset.id = result.newId;
					dataset.name = newName;
					// Resync MapLibre layer order from DB (layer_order column
					// is preserved during rename but may drift during the swap)
					const allDatasets = await getDatasets();
					resyncLayerOrder(this.map!, allDatasets.filter((d: any) => !d.hidden).map((d: any) => d.id));
					progressControl.updateProgress(`Renamed to "${newName}"`, 'success');
					progressControl.scheduleIdle(3000);
					this.operationBuilderControl?.refreshDatasets();
					this.showListView();
				} else {
					progressControl.updateProgress('Failed to rename dataset', 'error');
					progressControl.scheduleIdle(5000);
				}
			}
		);
		this.focusTrap?.updateElements();
	}

	async refreshPanel() {
		if (!this.panel || !this.map) return;

		// Only rebuild when in list view
		if (this.currentView !== 'list') return;

		// Query all datasets, excluding hidden (source-only) datasets
		const allDatasets = await getDatasets();
		const datasets = allDatasets.filter((d: any) => !d.hidden);
		this.datasets = datasets;

		// Clear panel
		this.panel.innerHTML = '';

		if (datasets.length === 0) {
			const emptyMsg = document.createElement('div');
			emptyMsg.className = 'layer-empty';
			emptyMsg.textContent = 'No datasets loaded';
			this.panel.appendChild(emptyMsg);
			return;
		}

		// Create row for each dataset
		datasets.forEach((dataset: any, index: number) => {
			const isFirst = index === 0;
			const isLast = index === datasets.length - 1;

			const handleMove = async (targetIndex: number) => {
				const direction = targetIndex < index ? 'up' : 'down';
				const targetDataset = this.datasets[targetIndex];
				const success = await swapLayerOrder(dataset.id, targetDataset.id);
				if (success) {
					await this.refreshPanel();
					resyncLayerOrder(this.map!, this.datasets.map((d: any) => d.id));
					this.announce(`Layer ${dataset.name} moved ${direction}`);

					// Highlight the moved row until the user moves their mouse
					const movedRow = this.panel?.querySelector(`[data-dataset-id="${dataset.id}"]`) as HTMLDivElement | null;
					if (movedRow) {
						movedRow.classList.add('layer-item--active');
						this.panel?.addEventListener('mousemove', () => {
							this.panel?.querySelectorAll('.layer-item--active').forEach(el => el.classList.remove('layer-item--active'));
						}, { once: true });
					}
				}
			};

			const row = createLayerRow(dataset as Dataset, {
				onToggleVisibility: (datasetId, visible) => {
					toggleLayerVisibility(this.map!, datasetId, visible);
					updateDatasetVisible(datasetId, visible);
					this.legendControl?.refresh();
					this.announce(`Layer ${dataset.name} ${visible ? 'shown' : 'hidden'}`);
				},
				onRowClick: (ds) => {
					this.showStyleView(ds);
				},
				onMenuClick: (ds, menuButton) => {
					// Toggle behavior: close if already open, otherwise show
					if (this.currentContextMenuDatasetId === ds.id) {
						this.closeContextMenu();
					} else {
						this.showContextMenu(ds, menuButton);
					}
				},
				onMoveUp: isFirst ? undefined : () => handleMove(index - 1),
				onMoveDown: isLast ? undefined : () => handleMove(index + 1)
			});
			this.panel!.appendChild(row);
		});

		this.legendControl?.refresh();
	}

	/**
	 * Show context menu for a dataset (rename + delete only)
	 */
	private showContextMenu(dataset: any, menuButton: HTMLButtonElement) {
		// Close any existing context menu
		this.closeContextMenu();

		// Track which dataset's menu is open
		this.currentContextMenuDatasetId = dataset.id;

		// Create context menu with automatic positioning and click-outside handling
		this.contextMenuHandle = createContextMenu(menuButton, () => {
			this.currentContextMenuDatasetId = undefined;
		});

		const { menu } = this.contextMenuHandle;

		// Add export items (not available for PMTiles - no feature data in DuckDB)
		if (dataset.format !== 'pmtiles') {
			const exportItems = createExportItems(async (format) => {
				this.closeContextMenu();
				const formatLabel = format.toUpperCase();
				progressControl.updateProgress(`Exporting "${dataset.name}" as ${formatLabel}...`, 'processing');
				try {
					await exportDatasetAs(dataset.id, dataset.name, format);
					progressControl.updateProgress(`Exported "${dataset.name}" as ${formatLabel}`, 'success');
				} catch (err) {
					console.error(`Export as ${formatLabel} failed:`, err);
					progressControl.updateProgress(`Export as ${formatLabel} failed`, 'error');
				}
			});
			for (const item of exportItems) {
				menu.appendChild(item);
			}
		}

		// Add divider before delete
		menu.appendChild(createMenuDivider());

		// Add delete item
		const deleteItem = createDeleteItem(async () => {
			this.closeContextMenu();

			const confirmed = await showDeleteConfirmation(
				this.panel!,
				dataset.name,
				dataset.feature_count,
				() => this.refreshPanel()
			);

			if (!confirmed) {
				return;
			}

			await deleteDatasetWithLayers(
				this.map!,
				dataset.id,
				dataset.name,
				progressControl,
				() => {
					this.refreshPanel();
					this.operationBuilderControl?.refreshDatasets();
					this.datasetControl?.updateIconColor();
					this.announce(`Layer ${dataset.name} deleted`);
				}
			);
		});
		menu.appendChild(deleteItem);
	}

	/**
	 * Close the currently open context menu
	 */
	private closeContextMenu() {
		if (this.contextMenuHandle) {
			this.contextMenuHandle.close();
			this.contextMenuHandle = undefined;
		}
		this.currentContextMenuDatasetId = undefined;
	}

	/**
	 * Toggle the panel open/closed (used by keyboard shortcuts).
	 */
	togglePanel(): void {
		if (this.panel) {
			const isOpen = this.panel.classList.toggle('control-panel--open');
			this.button?.setAttribute('aria-expanded', String(isOpen));
			if (isOpen) {
				this.previousFocus = document.activeElement as HTMLElement | null;
				this.onPanelOpen?.();
				this.showListView();
				this.focusTrap = createFocusTrap(this.panel);
				this.focusTrap.activate();
				this.focusTrap.focusFirst();
			} else {
				this.focusTrap?.deactivate();
				this.focusTrap = null;
				if (this.previousFocus?.isConnected) this.previousFocus.focus();
				this.previousFocus = null;
			}
		}
	}

	/**
	 * Close the panel (called externally for mutual exclusivity with storage control).
	 */
	async closePanel(): Promise<void> {
		if (this.currentView === 'style') {
			await savePendingStyle();
			this.currentView = 'list';
			this.currentStyleDatasetId = undefined;
		}
		this.focusTrap?.deactivate();
		this.focusTrap = null;
		this.panel?.classList.remove('control-panel--open');
		this.button?.setAttribute('aria-expanded', 'false');
		this.closeContextMenu();
		if (this.previousFocus?.isConnected) this.previousFocus.focus();
		this.previousFocus = null;
	}

	/** Announce a message to screen readers via the live region. */
	private announce(message: string): void {
		if (!this.liveRegion) return;
		this.liveRegion.textContent = '';
		requestAnimationFrame(() => {
			if (this.liveRegion) this.liveRegion.textContent = message;
		});
	}

	onRemove() {
		if (this.container && this.container.parentNode) {
			this.container.parentNode.removeChild(this.container);
		}
	}
}
