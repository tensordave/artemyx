const FOCUSABLE_SELECTOR = [
	'a[href]',
	'button:not(:disabled)',
	'input:not(:disabled)',
	'select:not(:disabled)',
	'textarea:not(:disabled)',
	'[tabindex]:not([tabindex="-1"])',
].join(',');

function isVisible(el: HTMLElement): boolean {
	return el.offsetWidth > 0 || el.offsetHeight > 0;
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
	const els = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
	return els.filter(isVisible);
}

export interface FocusTrap {
	/** Start trapping Tab/Shift+Tab within the container. */
	activate(): void;
	/** Stop trapping, remove the keydown listener. */
	deactivate(): void;
	/** Re-scan the container for focusable elements (call after DOM mutations). */
	updateElements(): void;
	/** Move focus to the first focusable element in the container. */
	focusFirst(): void;
}

export function createFocusTrap(container: HTMLElement): FocusTrap {
	let elements: HTMLElement[] = [];

	function updateElements(): void {
		elements = getFocusableElements(container);
	}

	function handleKeydown(e: KeyboardEvent): void {
		if (e.key !== 'Tab') return;

		// Allow default Tab behavior inside textareas (indent)
		if (document.activeElement?.tagName === 'TEXTAREA') return;

		updateElements();
		if (elements.length === 0) return;

		const first = elements[0];
		const last = elements[elements.length - 1];

		if (e.shiftKey) {
			if (document.activeElement === first || !container.contains(document.activeElement)) {
				e.preventDefault();
				last.focus();
			}
		} else {
			if (document.activeElement === last || !container.contains(document.activeElement)) {
				e.preventDefault();
				first.focus();
			}
		}
	}

	function activate(): void {
		updateElements();
		container.addEventListener('keydown', handleKeydown);
	}

	function deactivate(): void {
		container.removeEventListener('keydown', handleKeydown);
		elements = [];
	}

	function focusFirst(): void {
		updateElements();
		if (elements.length > 0) elements[0].focus();
	}

	return { activate, deactivate, updateElements, focusFirst };
}
