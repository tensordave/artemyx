import maplibregl from 'maplibre-gl';
import { loadDataFromFile } from './data-actions/load';
import { fileArrowUpIcon } from './icons';
import type { LayerToggleControl } from './layer-control';
import type { Logger } from './logger';
import { buildAdvancedOptions, type AdvancedOptionsHandle } from './ui/advanced-options';

interface UploadControlOptions {
	map: maplibregl.Map;
	logger: Logger;
	layerToggleControl: LayerToggleControl;
	loadedDatasets: Set<string>;
}

export class UploadControl implements maplibregl.IControl {
	private container: HTMLDivElement | undefined;
	private button: HTMLButtonElement | undefined;
	private panel: HTMLDivElement | undefined;
	private dropZone: HTMLDivElement | undefined;
	private fileInput: HTMLInputElement | undefined;
	private mapContainer: HTMLElement | undefined;
	private advancedOptions: AdvancedOptionsHandle | undefined;

	private map: maplibregl.Map;
	private logger: Logger;
	private layerToggleControl: LayerToggleControl;
	private loadedDatasets: Set<string>;

	private onPanelOpenCb?: () => void;
	private onEsc: (e: KeyboardEvent) => void;
	private onDocPointerDown: (e: PointerEvent) => void;

	setOnPanelOpen(cb: () => void): void {
		this.onPanelOpenCb = cb;
	}

	// Drag event handlers stored for cleanup
	private onMapDragOver: (e: DragEvent) => void;
	private onMapDragLeave: (e: DragEvent) => void;
	private onMapDrop: (e: DragEvent) => void;

	constructor(options: UploadControlOptions) {
		this.map = options.map;
		this.logger = options.logger;
		this.layerToggleControl = options.layerToggleControl;
		this.loadedDatasets = options.loadedDatasets;

		this.onEsc = (e: KeyboardEvent) => {
			if (e.key === 'Escape') this.closePanel();
		};

		this.onDocPointerDown = (e: PointerEvent) => {
			if (!this.container?.contains(e.target as Node)) {
				this.closePanel();
			}
		};

		this.onMapDragOver = (e: DragEvent) => {
			e.preventDefault();
			this.mapContainer?.classList.add('map--dragover');
			this.button?.classList.add('control-btn--dragover');
			this.dropZone?.classList.add('upload-drop-zone--active');
		};

		this.onMapDragLeave = (e: DragEvent) => {
			// Only remove highlight when leaving the map container itself, not child elements
			if (e.relatedTarget && this.mapContainer?.contains(e.relatedTarget as Node)) return;
			this.clearDragState();
		};

		this.onMapDrop = (e: DragEvent) => {
			e.preventDefault();
			this.clearDragState();
			this.closePanel();
			const file = e.dataTransfer?.files[0];
			if (file) this.handleFile(file);
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
		this.button.innerHTML = fileArrowUpIcon;
		this.button.title = 'Upload File';
		this.container.appendChild(this.button);

		// Panel
		this.panel = document.createElement('div');
		this.panel.className = 'control-panel control-panel--right';
		this.container.appendChild(this.panel);

		// Drop zone inside panel
		this.dropZone = document.createElement('div');
		this.dropZone.className = 'upload-drop-zone';
		this.panel.appendChild(this.dropZone);

		const label = document.createElement('p');
		label.className = 'upload-drop-label';
		label.textContent = 'Drag a GeoJSON, CSV, or Parquet file onto the map, or click below to browse.';
		this.dropZone.appendChild(label);

		const browseBtn = document.createElement('button');
		browseBtn.type = 'button';
		browseBtn.className = 'upload-browse-btn';
		browseBtn.textContent = 'Browse files';
		this.dropZone.appendChild(browseBtn);

		// Advanced options (collapsible)
		this.advancedOptions = buildAdvancedOptions();
		this.panel.appendChild(this.advancedOptions.element);

		// Hidden file input
		this.fileInput = document.createElement('input');
		this.fileInput.type = 'file';
		this.fileInput.accept = '.geojson,.json,.csv,.parquet,.geoparquet';
		this.fileInput.style.display = 'none';
		this.container.appendChild(this.fileInput);

		// Toggle panel on button click
		this.button.addEventListener('click', () => {
			const isOpen = this.panel?.classList.contains('control-panel--open');
			if (isOpen) {
				this.closePanel();
			} else {
				this.openPanel();
			}
		});

		// Browse button opens file picker
		browseBtn.addEventListener('click', () => this.fileInput?.click());

		// File selected via picker
		this.fileInput.addEventListener('change', () => {
			const file = this.fileInput?.files?.[0];
			if (file) {
				this.closePanel();
				this.handleFile(file);
			}
			if (this.fileInput) this.fileInput.value = '';
		});

		// Register drag-and-drop on the map container
		this.mapContainer = this.map.getContainer();
		this.mapContainer.addEventListener('dragover', this.onMapDragOver);
		this.mapContainer.addEventListener('dragleave', this.onMapDragLeave);
		this.mapContainer.addEventListener('drop', this.onMapDrop);

		return this.container;
	}

	onRemove() {
		this.mapContainer?.removeEventListener('dragover', this.onMapDragOver);
		this.mapContainer?.removeEventListener('dragleave', this.onMapDragLeave);
		this.mapContainer?.removeEventListener('drop', this.onMapDrop);
		document.removeEventListener('keydown', this.onEsc);
		document.removeEventListener('pointerdown', this.onDocPointerDown);

		if (this.container?.parentNode) {
			this.container.parentNode.removeChild(this.container);
		}
	}

	private openPanel() {
		this.panel?.classList.add('control-panel--open');
		this.onPanelOpenCb?.();
		document.addEventListener('keydown', this.onEsc);
		document.addEventListener('pointerdown', this.onDocPointerDown);
	}

	closePanel() {
		this.panel?.classList.remove('control-panel--open');
		document.removeEventListener('keydown', this.onEsc);
		document.removeEventListener('pointerdown', this.onDocPointerDown);
	}

	private clearDragState() {
		this.mapContainer?.classList.remove('map--dragover');
		this.button?.classList.remove('control-btn--dragover');
		this.dropZone?.classList.remove('upload-drop-zone--active');
	}

	private async handleFile(file: File) {
		const opts = this.advancedOptions?.getValues() ?? {};

		const success = await loadDataFromFile(file, {
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
			this.advancedOptions?.reset();
		}
	}
}
