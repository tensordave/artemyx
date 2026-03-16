/**
 * Layer row creation for the layer control panel.
 * Handles DOM structure and event wiring for individual dataset rows.
 */

import { dotsThreeVerticalIcon, arrowUpIcon, arrowDownIcon, eyeIcon, eyeSlashIcon } from '../icons';

export interface Dataset {
	id: string;
	name: string;
	color: string;
	visible: boolean;
	feature_count: number;
}

export interface LayerRowCallbacks {
	onToggleVisibility: (datasetId: string, visible: boolean) => void;
	onRowClick: (dataset: Dataset) => void;
	onMenuClick: (dataset: Dataset, menuButton: HTMLButtonElement) => void;
	onMoveUp?: () => void;
	onMoveDown?: () => void;
}

/**
 * Creates a layer row element for a dataset.
 * Returns the complete DOM element with all event handlers attached.
 */
export function createLayerRow(dataset: Dataset, callbacks: LayerRowCallbacks): HTMLDivElement {
	const itemDiv = document.createElement('div');
	itemDiv.className = 'layer-item';
	itemDiv.dataset.datasetId = dataset.id;
	// Dynamic border color based on dataset color
	itemDiv.style.borderLeftColor = dataset.color || '#3388ff';

	// DuckDB-WASM Arrow returns booleans as 0/1, so use truthiness check
	let isVisible = !!dataset.visible;

	// Visibility icon button (eye / eye-slash)
	const visibilityBtn = document.createElement('button');
	visibilityBtn.type = 'button';
	visibilityBtn.className = 'layer-visibility-btn';
	visibilityBtn.innerHTML = isVisible ? eyeIcon : eyeSlashIcon;
	visibilityBtn.title = isVisible ? 'Hide layer' : 'Show layer';

	// Menu button (⋮) for context menu
	const menuButton = document.createElement('button');
	menuButton.type = 'button';
	menuButton.className = 'layer-menu-btn';
	menuButton.innerHTML = dotsThreeVerticalIcon;
	menuButton.title = 'More options';

	// Label with dataset name and feature count
	const label = document.createElement('label');
	label.className = 'layer-label';
	label.textContent = `${dataset.name} (${dataset.feature_count.toLocaleString()})`;

	// Visibility toggle handler
	visibilityBtn.addEventListener('click', (e) => {
		e.stopPropagation();
		isVisible = !isVisible;
		visibilityBtn.innerHTML = isVisible ? eyeIcon : eyeSlashIcon;
		visibilityBtn.title = isVisible ? 'Hide layer' : 'Show layer';
		callbacks.onToggleVisibility(dataset.id, isVisible);
	});

	// Row click opens style view (except when clicking interactive elements)
	itemDiv.addEventListener('click', (e) => {
		const target = e.target as HTMLElement;
		if (target.closest('.layer-visibility-btn') || target.closest('.layer-menu-btn') || target.closest('.layer-reorder')) {
			return;
		}
		callbacks.onRowClick(dataset);
	});

	// Menu button opens context menu
	menuButton.addEventListener('click', (e) => {
		e.stopPropagation();
		callbacks.onMenuClick(dataset, menuButton);
	});

	// Reorder buttons container
	const reorderGroup = document.createElement('div');
	reorderGroup.className = 'layer-reorder';

	const upBtn = document.createElement('button');
	upBtn.type = 'button';
	upBtn.className = 'layer-reorder-btn';
	upBtn.innerHTML = arrowUpIcon;
	upBtn.title = 'Move up';
	if (callbacks.onMoveUp) {
		upBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			callbacks.onMoveUp!();
		});
	} else {
		upBtn.disabled = true;
	}

	const downBtn = document.createElement('button');
	downBtn.type = 'button';
	downBtn.className = 'layer-reorder-btn';
	downBtn.innerHTML = arrowDownIcon;
	downBtn.title = 'Move down';
	if (callbacks.onMoveDown) {
		downBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			callbacks.onMoveDown!();
		});
	} else {
		downBtn.disabled = true;
	}

	reorderGroup.appendChild(upBtn);
	reorderGroup.appendChild(downBtn);

	// Assemble row
	itemDiv.appendChild(visibilityBtn);
	itemDiv.appendChild(menuButton);
	itemDiv.appendChild(label);
	itemDiv.appendChild(reorderGroup);

	return itemDiv;
}

