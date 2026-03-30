import type { Map, IControl } from 'maplibre-gl';
import { basemaps, getDefaultBasemap, type BasemapConfig } from '../basemaps';
import { mapTrifoldIcon } from '../icons';

/**
 * Custom MapLibre control for switching between basemaps.
 * Displays an icon button that opens a panel with basemap options.
 */
export class BasemapControl implements IControl {
	private map: Map | null = null;
	private container: HTMLDivElement | null = null;
	private button: HTMLButtonElement | null = null;
	private panel: HTMLDivElement | null = null;
	private currentBasemap: BasemapConfig;
	private onPanelOpen?: () => void;
	private onDocPointerDown: (e: PointerEvent) => void;
	private previousFocus: HTMLElement | null = null;

	constructor() {
		this.currentBasemap = getDefaultBasemap();
		this.onDocPointerDown = (e: PointerEvent) => {
			if (!this.container?.contains(e.target as Node)) {
				this.previousFocus = null;
				this.closePanel();
			}
		};
	}

	setOnPanelOpen(cb: () => void): void {
		this.onPanelOpen = cb;
	}

	onAdd(map: Map): HTMLElement {
		this.map = map;

		this.container = document.createElement('div');
		this.container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
		this.container.classList.add('control-container');

		this.button = document.createElement('button');
		this.button.type = 'button';
		this.button.className = 'control-btn';
		this.button.innerHTML = mapTrifoldIcon;
		this.button.title = 'Switch basemap (B)';
		this.button.setAttribute('aria-label', 'Switch basemap');
		this.button.setAttribute('aria-expanded', 'false');
		this.container.appendChild(this.button);

		this.panel = document.createElement('div');
		this.panel.className = 'control-panel control-panel--left basemap-panel';
		this.container.appendChild(this.panel);

		this.renderPanelOptions();

		this.button.addEventListener('click', () => {
			if (!this.panel) return;
			const isOpen = this.panel.classList.toggle('control-panel--open');
			this.button!.setAttribute('aria-expanded', String(isOpen));
			if (isOpen) {
				this.previousFocus = document.activeElement as HTMLElement | null;
				this.onPanelOpen?.();
				document.addEventListener('pointerdown', this.onDocPointerDown);
			} else {
				document.removeEventListener('pointerdown', this.onDocPointerDown);
			}
		});

		return this.container;
	}

	onRemove(): void {
		document.removeEventListener('pointerdown', this.onDocPointerDown);
		this.container?.remove();
		this.map = null;
		this.container = null;
		this.button = null;
		this.panel = null;
	}

	togglePanel(): void {
		if (!this.panel) return;
		const isOpen = this.panel.classList.contains('control-panel--open');
		if (isOpen) {
			this.closePanel();
		} else {
			this.previousFocus = document.activeElement as HTMLElement | null;
			this.panel.classList.add('control-panel--open');
			this.button?.setAttribute('aria-expanded', 'true');
			this.onPanelOpen?.();
			document.addEventListener('pointerdown', this.onDocPointerDown);
		}
	}

	closePanel(): void {
		this.panel?.classList.remove('control-panel--open');
		this.button?.setAttribute('aria-expanded', 'false');
		document.removeEventListener('pointerdown', this.onDocPointerDown);
		if (this.previousFocus?.isConnected) this.previousFocus.focus();
		this.previousFocus = null;
	}

	private renderPanelOptions(): void {
		if (!this.panel) return;
		this.panel.innerHTML = '';

		basemaps.forEach((basemap) => {
			const option = document.createElement('button');
			option.type = 'button';
			option.className = 'basemap-option';
			if (basemap.id === this.currentBasemap.id) {
				option.classList.add('basemap-option--active');
			}
			const indicator = basemap.id === this.currentBasemap.id ? '●' : '○';
			option.textContent = `${indicator} ${basemap.name}`;
			option.addEventListener('click', () => this.selectBasemap(basemap));
			this.panel!.appendChild(option);
		});
	}

	private selectBasemap(basemap: BasemapConfig): void {
		if (!this.map || basemap.id === this.currentBasemap.id) {
			this.closePanel();
			return;
		}

		const layers = this.map.getStyle().layers;
		const firstDataLayerId = layers.find((l) => l.id !== 'basemap-layer')?.id;

		if (this.map.getLayer('basemap-layer')) {
			this.map.removeLayer('basemap-layer');
		}
		if (this.map.getSource('basemap')) {
			this.map.removeSource('basemap');
		}

		this.map.addSource('basemap', basemap.source);
		this.map.addLayer(basemap.layer, firstDataLayerId);

		this.currentBasemap = basemap;
		this.renderPanelOptions();
		this.closePanel();
	}

	getCurrentBasemapId(): string {
		return this.currentBasemap.id;
	}

	setBasemap(basemap: BasemapConfig): void {
		this.selectBasemap(basemap);
	}
}
