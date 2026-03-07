import maplibregl from 'maplibre-gl';
import { loadDataFromUrl } from './data-actions/load';
import { cloudArrowDownIcon } from './icons';
import type { LayerToggleControl } from './layer-control';
import type { Logger } from './logger';
import { buildAdvancedOptions, type AdvancedOptionsHandle } from './ui/advanced-options';

interface DataControlOptions {
	map: maplibregl.Map;
	logger: Logger;
	layerToggleControl: LayerToggleControl;
	loadedDatasets: Set<string>;
}

export class DataControl implements maplibregl.IControl {
	private container: HTMLDivElement | undefined;
	private button: HTMLButtonElement | undefined;
	private panel: HTMLDivElement | undefined;
	private input: HTMLInputElement | undefined;
	private loadButton: HTMLButtonElement | undefined;
	private advancedOptions: AdvancedOptionsHandle | undefined;

	private map: maplibregl.Map;
	private logger: Logger;
	private layerToggleControl: LayerToggleControl;
	private loadedDatasets: Set<string>;
	private onPanelOpen?: () => void;
	private onDocPointerDown: (e: PointerEvent) => void;

	setOnPanelOpen(cb: () => void): void {
		this.onPanelOpen = cb;
	}

	constructor(options: DataControlOptions) {
		this.map = options.map;
		this.logger = options.logger;
		this.layerToggleControl = options.layerToggleControl;
		this.loadedDatasets = options.loadedDatasets;
		this.onDocPointerDown = (e: PointerEvent) => {
			if (!this.container?.contains(e.target as Node)) {
				this.closePanel();
			}
		};
	}

	onAdd(_map: maplibregl.Map) {
		this.container = document.createElement('div');
		this.container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
		this.container.classList.add('control-container');

		// Toggle button
		this.button = document.createElement('button');
		this.button.type = 'button';
		this.button.className = 'control-btn';
		this.button.innerHTML = cloudArrowDownIcon;
		this.button.title = 'Load Data';
		this.container.appendChild(this.button);

		// Panel (hidden by default)
		this.panel = document.createElement('div');
		this.panel.className = 'control-panel control-panel--right';
		this.container.appendChild(this.panel);

		// URL input
		this.input = document.createElement('input');
		this.input.type = 'text';
		this.input.className = 'control-input';
		this.input.placeholder = 'Paste data URL (GeoJSON, CSV, Parquet)...';
		this.panel.appendChild(this.input);

		// Load button
		this.loadButton = document.createElement('button');
		this.loadButton.type = 'button';
		this.loadButton.className = 'control-submit';
		this.loadButton.textContent = 'Load';
		this.panel.appendChild(this.loadButton);

		// Advanced options (collapsible, below the main action)
		this.advancedOptions = buildAdvancedOptions();
		this.panel.appendChild(this.advancedOptions.element);

		// Toggle panel visibility
		this.button.addEventListener('click', () => {
			if (this.panel && this.input) {
				const isOpen = this.panel.classList.toggle('control-panel--open');
				if (isOpen) {
					this.onPanelOpen?.();
					this.input.focus();
					document.addEventListener('pointerdown', this.onDocPointerDown);
				} else {
					document.removeEventListener('pointerdown', this.onDocPointerDown);
				}
			}
		});

		// Load handler
		const handleLoad = async () => {
			if (!this.input || !this.loadButton || !this.panel) return;

			const url = this.input.value.trim();
			if (!url) return;

			this.loadButton.textContent = 'Loading...';
			this.loadButton.disabled = true;

			const opts = this.advancedOptions?.getValues() ?? {};

			try {
				const success = await loadDataFromUrl(url, {
					map: this.map,
					logger: this.logger,
					layerToggleControl: this.layerToggleControl,
					loadedDatasets: this.loadedDatasets,
					format: opts.format,
					crs: opts.crs,
					latColumn: opts.latColumn,
					lngColumn: opts.lngColumn,
					geoColumn: opts.geoColumn,
				});

				if (success) {
					this.closePanel();
					this.input.value = '';
					this.advancedOptions?.reset();
				}
			} finally {
				this.loadButton.textContent = 'Load';
				this.loadButton.disabled = false;
			}
		};

		// Load on button click
		this.loadButton.addEventListener('click', handleLoad);

		// Load on Enter key
		this.input.addEventListener('keypress', (e) => {
			if (e.key === 'Enter') {
				handleLoad();
			}
		});

		return this.container;
	}

	closePanel(): void {
		this.panel?.classList.remove('control-panel--open');
		document.removeEventListener('pointerdown', this.onDocPointerDown);
	}

	onRemove() {
		document.removeEventListener('pointerdown', this.onDocPointerDown);
		if (this.container && this.container.parentNode) {
			this.container.parentNode.removeChild(this.container);
		}
	}
}
