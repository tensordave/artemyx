import maplibregl from 'maplibre-gl';
import { getDatasets, updateDatasetName, updateDatasetVisible } from './db';
import { stackIcon } from './icons';
import { progressControl } from './map';
import { toggleLayerVisibility } from './layer-actions/visibility';
import { updateLayerColor, isColorPickerEnabled, getDisplayColor } from './layer-actions/color';
import { showDeleteConfirmation, deleteDatasetWithLayers } from './layer-actions/delete';
import { createContextMenu, type ContextMenuHandle } from './layer-actions/context-menu';
import { createColorPickerItem, createRenameItem, createStyleItem, createDeleteItem, createMenuDivider } from './layer-actions/context-menu-items';
import { showStylePanel, closeStylePanel } from './layer-actions/style';
import { createLayerRow, startRenameEdit, type Dataset } from './layer-actions/layer-row';

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
		this.container.style.position = 'relative';

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
					this.refreshPanel();
				}
			}
		});

		return this.container;
	}

	async refreshPanel() {
		if (!this.panel || !this.map) return;

		// Query all datasets, excluding hidden (source-only) datasets
		const allDatasets = await getDatasets();
		const datasets = allDatasets.filter((d: any) => !d.hidden);

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
		datasets.forEach((dataset: any) => {
			const row = createLayerRow(dataset as Dataset, {
				onToggleVisibility: (datasetId, visible) => {
					toggleLayerVisibility(this.map!, datasetId, visible);
					updateDatasetVisible(datasetId, visible);
				},
				onMenuClick: (ds, menuButton) => {
					// Toggle behavior: close if already open, otherwise show
					if (this.currentContextMenuDatasetId === ds.id) {
						this.closeContextMenu();
					} else {
						this.showContextMenu(ds, menuButton);
					}
				}
			});
			this.panel!.appendChild(row);
		});
	}

	/**
	 * Show context menu for a dataset
	 */
	private showContextMenu(dataset: any, menuButton: HTMLButtonElement) {
		// Close any existing context menu and style panel
		this.closeContextMenu();
		closeStylePanel();

		// Track which dataset's menu is open
		this.currentContextMenuDatasetId = dataset.id;

		// Create context menu with automatic positioning and click-outside handling
		this.contextMenuHandle = createContextMenu(menuButton, () => {
			this.currentContextMenuDatasetId = undefined;
		});

		const { menu } = this.contextMenuHandle;

		// Add color picker item (disabled if all layers use expression-based colors)
		const colorEnabled = isColorPickerEnabled(this.map!, dataset.id);
		const displayColor = getDisplayColor(this.map!, dataset.id, dataset.color || '#3388ff');
		const colorItem = createColorPickerItem(
			displayColor,
			async (newColor) => {
				await updateLayerColor(
					this.map!,
					dataset.id,
					dataset.name,
					newColor,
					progressControl
				);
				this.closeContextMenu();
				this.refreshPanel();
			},
			!colorEnabled
		);
		menu.appendChild(colorItem);

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
					// Refresh to ensure UI consistency
					this.refreshPanel();
				} else {
					progressControl.updateProgress('Failed to rename dataset', 'error');
					this.refreshPanel();
				}
			});
		});
		menu.appendChild(renameItem);

		// Add style item
		const styleItem = createStyleItem(() => {
			this.closeContextMenu();

			// Find the row element for this dataset
			const rowElement = this.panel?.querySelector(
				`[data-dataset-id="${dataset.id}"]`
			) as HTMLDivElement | null;

			if (!rowElement) return;

			// Show inline style panel
			showStylePanel(
				this.map!,
				dataset.id,
				dataset.name,
				rowElement,
				progressControl
			);
		});
		menu.appendChild(styleItem);

		// Add divider
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
	closePanel(): void {
		this.panel?.classList.remove('control-panel--open');
		this.closeContextMenu();
	}

	onRemove() {
		if (this.container && this.container.parentNode) {
			this.container.parentNode.removeChild(this.container);
		}
	}
}
