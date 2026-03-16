/**
 * Context menu item builders
 *
 * Each function creates a menu item element ready to append to a context menu.
 * Callbacks are provided by the caller to handle actions.
 */

import { trashIcon, downloadIcon } from '../icons';

/**
 * Create a generic menu item with icon and label
 */
function createMenuItem(
	icon: string,
	label: string,
	onClick: () => void,
	isDanger = false
): HTMLDivElement {
	const item = document.createElement('div');
	item.className = isDanger
		? 'context-menu-item context-menu-item--danger'
		: 'context-menu-item';

	const iconSpan = document.createElement('span');
	iconSpan.className = 'context-menu-icon';
	iconSpan.innerHTML = icon;

	const labelSpan = document.createElement('span');
	labelSpan.textContent = label;

	item.appendChild(iconSpan);
	item.appendChild(labelSpan);
	item.addEventListener('click', onClick);

	return item;
}

/**
 * Create a divider element for separating menu sections
 */
export function createMenuDivider(): HTMLDivElement {
	const divider = document.createElement('div');
	divider.className = 'context-menu-divider';
	return divider;
}

/**
 * Create an export GeoJSON menu item
 */
export function createExportItem(onExport: () => void): HTMLDivElement {
	return createMenuItem(downloadIcon, 'Export GeoJSON', onExport);
}

/**
 * Create a delete dataset menu item
 *
 * Styled as a danger action. Calls onDelete when clicked.
 */
export function createDeleteItem(onDelete: () => void): HTMLDivElement {
	return createMenuItem(trashIcon, 'Delete dataset', onDelete, true);
}
