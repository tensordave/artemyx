import maplibregl from 'maplibre-gl';
import { loadDataFromUrl } from './data-actions/load';
import { mapPinIcon } from './icons';
import type { LayerToggleControl } from './layer-control';
import type { ProgressControl } from './progress-control';

interface DataControlOptions {
	map: maplibregl.Map;
	progressControl: ProgressControl;
	layerToggleControl: LayerToggleControl;
	loadedDatasets: Set<string>;
}

export class DataControl implements maplibregl.IControl {
	private container: HTMLDivElement | undefined;
	private button: HTMLButtonElement | undefined;
	private panel: HTMLDivElement | undefined;
	private input: HTMLInputElement | undefined;
	private loadButton: HTMLButtonElement | undefined;

	private map: maplibregl.Map;
	private progressControl: ProgressControl;
	private layerToggleControl: LayerToggleControl;
	private loadedDatasets: Set<string>;

	constructor(options: DataControlOptions) {
		this.map = options.map;
		this.progressControl = options.progressControl;
		this.layerToggleControl = options.layerToggleControl;
		this.loadedDatasets = options.loadedDatasets;
	}

	onAdd(_map: maplibregl.Map) {
		this.container = document.createElement('div');
		this.container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
		this.container.style.position = 'relative';

		// Toggle button
		this.button = document.createElement('button');
		this.button.type = 'button';
		this.button.className = 'control-btn';
		this.button.innerHTML = mapPinIcon;
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

		// Toggle panel visibility
		this.button.addEventListener('click', () => {
			if (this.panel && this.input) {
				const isOpen = this.panel.classList.toggle('control-panel--open');
				if (isOpen) {
					this.input.focus();
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

			try {
				const success = await loadDataFromUrl(url, {
					map: this.map,
					progressControl: this.progressControl,
					layerToggleControl: this.layerToggleControl,
					loadedDatasets: this.loadedDatasets
				});

				if (success) {
					this.panel.classList.remove('control-panel--open');
					this.input.value = '';
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

	onRemove() {
		if (this.container && this.container.parentNode) {
			this.container.parentNode.removeChild(this.container);
		}
	}
}
