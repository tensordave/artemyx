import type { Map, IControl } from 'maplibre-gl';
import { textTIcon, textTSlashIcon } from '../icons';
import { injectButtonLabels, isLabelsEnabled, toggleLabels } from '../ui/button-labels';

/**
 * Toggle control for showing/hiding text labels beside icon buttons.
 * Swaps between TextT (labels off) and TextTSlash (labels on).
 */
export class LabelToggleControl implements IControl {
	private container: HTMLDivElement | null = null;
	private button: HTMLButtonElement | null = null;
	private map: Map | null = null;
	private enabled = false;

	onAdd(map: Map): HTMLElement {
		this.map = map;

		this.container = document.createElement('div');
		this.container.className = 'maplibregl-ctrl maplibregl-ctrl-group';

		this.button = document.createElement('button');
		this.button.type = 'button';
		this.button.className = 'control-btn';
		this.button.title = 'Toggle button labels (N)';
		this.button.setAttribute('aria-label', 'Toggle button labels');

		this.enabled = isLabelsEnabled();
		this.button.innerHTML = this.enabled ? textTSlashIcon : textTIcon;

		this.button.addEventListener('click', () => this.toggle());
		this.container.appendChild(this.button);

		return this.container;
	}

	onRemove(): void {
		this.container?.remove();
		this.container = null;
		this.button = null;
		this.map = null;
	}

	toggle(): void {
		const mapContainer = this.map?.getContainer();
		if (!mapContainer || !this.button) return;
		this.enabled = toggleLabels(mapContainer);
		this.updateIcon();
	}

	private updateIcon(): void {
		if (!this.button) return;
		const svg = this.button.querySelector('svg');
		if (svg) {
			const temp = document.createElement('div');
			temp.innerHTML = this.enabled ? textTSlashIcon : textTIcon;
			svg.replaceWith(temp.firstElementChild!);
		} else {
			this.button.innerHTML = this.enabled ? textTSlashIcon : textTIcon;
		}
	}

	/**
	 * Inject label spans into all existing .control-btn elements
	 * and restore the show-labels class if previously enabled.
	 * Call after all controls are mounted.
	 */
	restoreLabels(): void {
		const mapContainer = this.map?.getContainer();
		if (!mapContainer) return;
		injectButtonLabels(mapContainer);
		if (this.enabled) {
			mapContainer.classList.add('show-labels');
		}
	}
}
