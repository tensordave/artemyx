/**
 * Context menu item builders
 *
 * Each function creates a menu item element ready to append to a context menu.
 * Callbacks are provided by the caller to handle actions.
 */

import { gearIcon, trashIcon, paletteIcon, pencilIcon } from '../icons';

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
 * Create a color picker menu item
 *
 * Opens the native color picker when clicked. Calls onColorChange with the
 * new color value when user selects a color.
 *
 * @param disabled - If true, item is greyed out (color is controlled by config expressions)
 */
export function createColorPickerItem(
	currentColor: string,
	onColorChange: (newColor: string) => void,
	disabled: boolean = false
): HTMLDivElement {
	if (disabled) {
		const item = createMenuItem(paletteIcon, 'Change color', () => {});
		item.classList.add('context-menu-item--disabled');
		item.title = 'Color controlled by config expression';
		return item;
	}

	return createMenuItem(paletteIcon, 'Change color', () => {
		// Create a hidden color input
		const colorInput = document.createElement('input');
		colorInput.type = 'color';
		colorInput.value = currentColor;
		colorInput.style.display = 'none';

		colorInput.addEventListener('change', () => {
			onColorChange(colorInput.value);
		});

		// Trigger color picker and clean up
		document.body.appendChild(colorInput);
		colorInput.click();
		setTimeout(() => document.body.removeChild(colorInput), 100);
	});
}

/**
 * Create a rename dataset menu item
 *
 * Calls onRename when clicked to trigger inline edit mode.
 */
export function createRenameItem(onRename: () => void): HTMLDivElement {
	return createMenuItem(pencilIcon, 'Rename', onRename);
}

/**
 * Create a style settings menu item
 *
 * Opens the inline style panel for adjusting fill opacity, line width, point radius.
 */
export function createStyleItem(onStyle: () => void): HTMLDivElement {
	return createMenuItem(gearIcon, 'Style...', onStyle);
}

/**
 * Create a delete dataset menu item
 *
 * Styled as a danger action. Calls onDelete when clicked.
 */
export function createDeleteItem(onDelete: () => void): HTMLDivElement {
	return createMenuItem(trashIcon, 'Delete dataset', onDelete, true);
}
