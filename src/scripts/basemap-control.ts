import type { Map, IControl } from 'maplibre-gl';
import { basemaps, getDefaultBasemap, type BasemapConfig } from './basemaps';

/**
 * Custom MapLibre control for switching between basemaps.
 * Displays a button with current basemap name and a drop-up menu for selection.
 */
export class BasemapControl implements IControl {
	private map: Map | null = null;
	private container: HTMLDivElement | null = null;
	private button: HTMLButtonElement | null = null;
	private menu: HTMLDivElement | null = null;
	private currentBasemap: BasemapConfig;
	private isMenuOpen = false;

	constructor() {
		this.currentBasemap = getDefaultBasemap();
		this.handleClickOutside = this.handleClickOutside.bind(this);
	}

	onAdd(map: Map): HTMLElement {
		this.map = map;

		// Create container
		this.container = document.createElement('div');
		this.container.className = 'maplibregl-ctrl basemap-control';

		// Create drop-up menu (above button, hidden by default)
		this.menu = document.createElement('div');
		this.menu.className = 'basemap-menu';
		this.renderMenuOptions();
		this.container.appendChild(this.menu);

		// Create button showing current basemap
		this.button = document.createElement('button');
		this.button.type = 'button';
		this.button.className = 'basemap-btn';
		this.button.title = 'Change basemap';
		this.updateButtonText();
		this.button.addEventListener('click', () => this.toggleMenu());
		this.container.appendChild(this.button);

		return this.container;
	}

	onRemove(): void {
		this.closeMenu();
		this.container?.remove();
		this.map = null;
		this.container = null;
		this.button = null;
		this.menu = null;
	}

	/** Update button text to show current basemap name */
	private updateButtonText(): void {
		if (this.button) {
			this.button.textContent = `${this.currentBasemap.name} ▲`;
		}
	}

	/** Render the menu options list */
	private renderMenuOptions(): void {
		if (!this.menu) return;
		const menu = this.menu;

		menu.innerHTML = '';

		basemaps.forEach((basemap) => {
			const option = document.createElement('button');
			option.type = 'button';
			option.className = 'basemap-option';
			if (basemap.id === this.currentBasemap.id) {
				option.classList.add('basemap-option--active');
			}

			// Radio indicator + name
			const indicator = basemap.id === this.currentBasemap.id ? '●' : '○';
			option.textContent = `${indicator} ${basemap.name}`;

			option.addEventListener('click', () => this.selectBasemap(basemap));
			menu.appendChild(option);
		});
	}

	/** Toggle menu open/closed */
	private toggleMenu(): void {
		if (this.isMenuOpen) {
			this.closeMenu();
		} else {
			this.openMenu();
		}
	}

	/** Open the drop-up menu */
	private openMenu(): void {
		if (!this.menu) return;

		this.isMenuOpen = true;
		this.menu.classList.add('basemap-menu--open');

		// Listen for clicks outside to close
		setTimeout(() => {
			document.addEventListener('click', this.handleClickOutside);
		}, 0);
	}

	/** Close the drop-up menu */
	private closeMenu(): void {
		if (!this.menu) return;

		this.isMenuOpen = false;
		this.menu.classList.remove('basemap-menu--open');
		document.removeEventListener('click', this.handleClickOutside);
	}

	/** Handle clicks outside the control to close menu */
	private handleClickOutside(event: MouseEvent): void {
		if (this.container && !this.container.contains(event.target as Node)) {
			this.closeMenu();
		}
	}

	/** Select a new basemap and update the map */
	private selectBasemap(basemap: BasemapConfig): void {
		if (!this.map || basemap.id === this.currentBasemap.id) {
			this.closeMenu();
			return;
		}

		// Find the first non-basemap layer (data layer) to insert before
		const layers = this.map.getStyle().layers;
		const firstDataLayerId = layers.find((l) => l.id !== 'basemap-layer')?.id;

		// Remove old basemap layer and source
		if (this.map.getLayer('basemap-layer')) {
			this.map.removeLayer('basemap-layer');
		}
		if (this.map.getSource('basemap')) {
			this.map.removeSource('basemap');
		}

		// Add new basemap source and layer
		this.map.addSource('basemap', basemap.source);
		this.map.addLayer(basemap.layer, firstDataLayerId);

		// Update state
		this.currentBasemap = basemap;
		this.updateButtonText();
		this.renderMenuOptions();
		this.closeMenu();
	}

	/** Get the current basemap ID (useful for config export) */
	getCurrentBasemapId(): string {
		return this.currentBasemap.id;
	}
}
