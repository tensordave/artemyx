import maplibregl from 'maplibre-gl';
import { getDatasets, updateDatasetName, updateDatasetVisible, swapLayerOrder } from './db';
import { stackIcon } from './icons';
import { progressControl } from './map';
import { toggleLayerVisibility } from './layer-actions/visibility';
import { showDeleteConfirmation, deleteDatasetWithLayers } from './layer-actions/delete';
import { createContextMenu, type ContextMenuHandle } from './layer-actions/context-menu';
import { createRenameItem, createDeleteItem, createMenuDivider } from './layer-actions/context-menu-items';
import { buildStyleView, savePendingStyle } from './layer-actions/style';
import { createLayerRow, startRenameEdit, type Dataset } from './layer-actions/layer-row';
import { resyncLayerOrder } from './layers';

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
	/** Cached ordered dataset list from last refreshPanel(), used for reorder logic */
	private datasets: any[] = [];
	/** Current view state: 'list' shows layer rows, 'style' shows style controls */
	private currentView: 'list' | 'style' = 'list';
	/** Dataset ID of the currently displayed style view */
	private currentStyleDatasetId: string | undefined;

	/**
	 * Set the callback for when this panel opens (wired after both controls exist).
	 */
	setOnPanelOpen(cb: () => void): void {
		this.onPanelOpen = cb;
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
		this.button.title = 'Toggle layers';
		this.container.appendChild(this.button);

		// Panel (hidden by default, positioned absolutely)
		this.panel = document.createElement('div');
		this.panel.className = 'control-panel control-panel--left control-panel--layers';
		this.container.appendChild(this.panel);

		// Toggle panel visibility
		this.button.addEventListener('click', () => {
			if (this.panel) {
				const isOpen = this.panel.classList.toggle('control-panel--open');
				if (isOpen) {
					this.onPanelOpen?.();
					this.showListView();
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
			() => this.showListView(),
			(newColor) => {
				// Update the style view header border color to reflect the new color
				const header = this.panel?.querySelector('.style-view-header') as HTMLElement | null;
				if (header) {
					header.style.borderLeftColor = newColor;
				}
			}
		);
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
				const targetDataset = this.datasets[targetIndex];
				const success = await swapLayerOrder(dataset.id, targetDataset.id);
				if (success) {
					await this.refreshPanel();
					resyncLayerOrder(this.map!, this.datasets.map((d: any) => d.id));

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

		// Add rename item
		const renameItem = createRenameItem(() => {
			this.closeContextMenu();

			// Find the row element for this dataset
			const rowElement = this.panel?.querySelector(
				`[data-dataset-id="${dataset.id}"]`
			) as HTMLDivElement | null;

			if (!rowElement) return;

			// Start inline edit mode
			startRenameEdit(rowElement, dataset as Dataset, async (newName) => {
				progressControl.updateProgress(`Renaming to "${newName}"...`, 'processing');
				const success = await updateDatasetName(dataset.id, newName);
				if (success) {
					progressControl.updateProgress(`Renamed to "${newName}"`, 'success');
					this.refreshPanel();
				} else {
					progressControl.updateProgress('Failed to rename dataset', 'error');
					this.refreshPanel();
				}
			});
		});
		menu.appendChild(renameItem);

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
				() => this.refreshPanel()
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
	 * Close the panel (called externally for mutual exclusivity with storage control).
	 */
	async closePanel(): Promise<void> {
		if (this.currentView === 'style') {
			await savePendingStyle();
			this.currentView = 'list';
			this.currentStyleDatasetId = undefined;
		}
		this.panel?.classList.remove('control-panel--open');
		this.closeContextMenu();
	}

	onRemove() {
		if (this.container && this.container.parentNode) {
			this.container.parentNode.removeChild(this.container);
		}
	}
}
