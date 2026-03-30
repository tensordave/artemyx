import type { Map as MaplibreMap } from 'maplibre-gl';

const PAN_OFFSET = 100;

interface ShortcutBinding {
	key: string;
	action: () => void;
}

interface ShortcutsConfig {
	map: MaplibreMap;
	bindings: ShortcutBinding[];
	closers: Array<() => void>;
}

function isTextInputFocused(): boolean {
	const el = document.activeElement;
	if (!el) return false;
	const tag = el.tagName;
	if (tag === 'INPUT') {
		const type = (el as HTMLInputElement).type.toLowerCase();
		const textTypes = ['text', 'search', 'url', 'tel', 'email', 'password', 'number'];
		return textTypes.includes(type);
	}
	if (tag === 'TEXTAREA') return true;
	if ((el as HTMLElement).isContentEditable) return true;
	return false;
}

export function initShortcuts({ map, bindings, closers }: ShortcutsConfig): void {
	const bindingMap = new Map<string, () => void>();
	for (const b of bindings) {
		bindingMap.set(b.key, b.action);
	}

	document.addEventListener('keydown', (e: KeyboardEvent) => {
		if (e.ctrlKey || e.metaKey || e.altKey) return;

		const key = e.key.toLowerCase();

		if (key === 'escape') {
			for (const close of closers) close();
			return;
		}

		if (isTextInputFocused()) return;

		// WASD panning
		if (key === 'w') { map.panBy([0, -PAN_OFFSET], { duration: 100 }); return; }
		if (key === 'a') { map.panBy([-PAN_OFFSET, 0], { duration: 100 }); return; }
		if (key === 's') { map.panBy([0, PAN_OFFSET], { duration: 100 }); return; }
		if (key === 'd') { map.panBy([PAN_OFFSET, 0], { duration: 100 }); return; }

		// R/F zoom
		if (key === 'r') { map.zoomIn({ duration: 200 }); return; }
		if (key === 'f') { map.zoomOut({ duration: 200 }); return; }

		// Panel toggles
		const action = bindingMap.get(key);
		if (action) {
			e.preventDefault();
			action();
		}
	});
}
