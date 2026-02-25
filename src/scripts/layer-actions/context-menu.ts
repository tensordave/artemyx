/**
 * Context menu creation and positioning utilities
 *
 * Handles the container, viewport-aware positioning, and click-outside behavior.
 * Menu items are added separately via context-menu-items.ts
 */

export interface ContextMenuHandle {
	menu: HTMLDivElement;
	close: () => void;
}

/**
 * Calculate position for context menu that stays within viewport bounds
 */
function calculateMenuPosition(
	anchorRect: DOMRect,
	menuRect: DOMRect
): { left: number; top: number } {
	const viewportWidth = window.innerWidth;
	const viewportHeight = window.innerHeight;

	// Preferred position: to the right of anchor
	let left = anchorRect.right + 5;
	let top = anchorRect.top;

	// Check if menu would overflow viewport on the right
	if (left + menuRect.width > viewportWidth) {
		// Position to the left of the anchor instead
		left = anchorRect.left - menuRect.width - 5;
	}

	// Check if menu would overflow viewport on the bottom
	if (top + menuRect.height > viewportHeight) {
		// Align menu bottom with anchor bottom
		top = anchorRect.bottom - menuRect.height;
	}

	// Ensure menu doesn't go off the left edge
	if (left < 0) {
		left = 5;
	}

	// Ensure menu doesn't go off the top edge
	if (top < 0) {
		top = 5;
	}

	return { left, top };
}

/**
 * Create a context menu anchored to an element
 *
 * Returns a handle with the menu element and a close function.
 * The menu is appended to document.body to allow overflow beyond panels.
 */
export function createContextMenu(
	anchorElement: HTMLElement,
	onClose?: () => void
): ContextMenuHandle {
	// Create menu container
	const menu = document.createElement('div');
	menu.className = 'context-menu';

	// Append to body so it can overflow panel bounds
	document.body.appendChild(menu);

	// Click-outside handler
	let clickOutsideHandler: ((e: MouseEvent) => void) | undefined;

	const close = () => {
		if (menu.parentNode) {
			menu.parentNode.removeChild(menu);
		}
		if (clickOutsideHandler) {
			document.removeEventListener('click', clickOutsideHandler);
			clickOutsideHandler = undefined;
		}
		onClose?.();
	};

	// Position after items are added (needs to be called after menu has content)
	// We use requestAnimationFrame to ensure layout is calculated
	requestAnimationFrame(() => {
		const anchorRect = anchorElement.getBoundingClientRect();
		const menuRect = menu.getBoundingClientRect();
		const { left, top } = calculateMenuPosition(anchorRect, menuRect);

		menu.style.left = `${left}px`;
		menu.style.top = `${top}px`;
	});

	// Setup click-outside-to-close with delay to avoid immediate closure
	clickOutsideHandler = (e: MouseEvent) => {
		const target = e.target as Node;
		if (!menu.contains(target)) {
			close();
		}
	};

	setTimeout(() => {
		document.addEventListener('click', clickOutsideHandler!);
	}, 10);

	return { menu, close };
}
