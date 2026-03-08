import type { Map, IControl } from 'maplibre-gl';
import { magnifyingGlassIcon } from '../icons';

const PHOTON_API = 'https://photon.komoot.io/api/';
const DEBOUNCE_MS = 400;
const MIN_QUERY_LENGTH = 3;
const MAX_RESULTS = 5;

interface PhotonFeature {
	type: 'Feature';
	geometry: { type: 'Point'; coordinates: [number, number] };
	properties: {
		name?: string;
		city?: string;
		state?: string;
		country?: string;
		extent?: [number, number, number, number]; // [minLng, maxLat, maxLng, minLat]
	};
}

export class GeocodingControl implements IControl {
	private map: Map | null = null;
	private container: HTMLDivElement | null = null;
	private button: HTMLButtonElement | null = null;
	private panel: HTMLDivElement | null = null;
	private input: HTMLInputElement | null = null;
	private resultsList: HTMLDivElement | null = null;
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private abortController: AbortController | null = null;
	private activeIndex = -1;
	private currentFeatures: PhotonFeature[] = [];
	private onPanelOpen?: () => void;
	private onDocPointerDown: (e: PointerEvent) => void;

	constructor() {
		this.onDocPointerDown = (e: PointerEvent) => {
			if (!this.container?.contains(e.target as Node)) {
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
		this.button.innerHTML = magnifyingGlassIcon;
		this.button.title = 'Search location';
		this.container.appendChild(this.button);

		this.panel = document.createElement('div');
		this.panel.className = 'control-panel control-panel--left geocoding-panel';

		this.input = document.createElement('input');
		this.input.type = 'text';
		this.input.className = 'control-input';
		this.input.placeholder = 'Search for a place...';
		this.panel.appendChild(this.input);

		this.resultsList = document.createElement('div');
		this.resultsList.className = 'geocoding-results';
		this.panel.appendChild(this.resultsList);

		this.container.appendChild(this.panel);

		// Toggle panel
		this.button.addEventListener('click', () => {
			if (!this.panel) return;
			const isOpen = this.panel.classList.toggle('control-panel--open');
			if (isOpen) {
				this.onPanelOpen?.();
				this.input?.focus();
				document.addEventListener('pointerdown', this.onDocPointerDown);
			} else {
				document.removeEventListener('pointerdown', this.onDocPointerDown);
			}
		});

		// Debounced search on input
		this.input.addEventListener('input', () => {
			this.clearDebounce();
			const query = this.input?.value.trim() ?? '';
			if (query.length < MIN_QUERY_LENGTH) {
				this.clearResults();
				return;
			}
			this.debounceTimer = setTimeout(() => this.fetchResults(query), DEBOUNCE_MS);
		});

		// Keyboard navigation: arrows to move, Enter to select or search
		this.input.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				if (this.currentFeatures.length > 0) {
					this.setActiveIndex(Math.min(this.activeIndex + 1, this.currentFeatures.length - 1));
				}
			} else if (e.key === 'ArrowUp') {
				e.preventDefault();
				if (this.currentFeatures.length > 0) {
					this.setActiveIndex(Math.max(this.activeIndex - 1, 0));
				}
			} else if (e.key === 'Enter') {
				e.preventDefault();
				if (this.activeIndex >= 0 && this.activeIndex < this.currentFeatures.length) {
					this.selectResult(this.currentFeatures[this.activeIndex]);
				} else {
					this.clearDebounce();
					const query = this.input?.value.trim() ?? '';
					if (query.length >= MIN_QUERY_LENGTH) {
						this.fetchResults(query);
					}
				}
			}
		});

		return this.container;
	}

	onRemove(): void {
		document.removeEventListener('pointerdown', this.onDocPointerDown);
		this.clearDebounce();
		this.abortController?.abort();
		this.container?.remove();
		this.map = null;
		this.container = null;
		this.button = null;
		this.panel = null;
		this.input = null;
		this.resultsList = null;
	}

	closePanel(): void {
		this.panel?.classList.remove('control-panel--open');
		document.removeEventListener('pointerdown', this.onDocPointerDown);
	}

	private clearDebounce(): void {
		if (this.debounceTimer !== null) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
	}

	private clearResults(): void {
		if (this.resultsList) this.resultsList.innerHTML = '';
		this.currentFeatures = [];
		this.activeIndex = -1;
	}

	private setActiveIndex(index: number): void {
		this.activeIndex = index;
		if (!this.resultsList) return;
		const items = this.resultsList.querySelectorAll<HTMLButtonElement>('.geocoding-result-item');
		items.forEach((item, i) => {
			item.classList.toggle('geocoding-result-item--active', i === index);
		});
		items[index]?.scrollIntoView({ block: 'nearest' });
	}

	private async fetchResults(query: string): Promise<void> {
		// Cancel any in-flight request
		this.abortController?.abort();
		this.abortController = new AbortController();

		const center = this.map?.getCenter();
		const params = new URLSearchParams({
			q: query,
			limit: String(MAX_RESULTS),
			lang: 'en',
		});
		if (center) {
			params.set('lat', String(center.lat));
			params.set('lon', String(center.lng));
		}

		try {
			const res = await fetch(`${PHOTON_API}?${params}`, {
				signal: this.abortController.signal,
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			this.renderResults(data.features ?? []);
		} catch (e: any) {
			if (e.name === 'AbortError') return;
			this.showMessage('Search failed', 'geocoding-error');
		}
	}

	private renderResults(features: PhotonFeature[]): void {
		if (!this.resultsList) return;
		this.resultsList.innerHTML = '';
		this.currentFeatures = features;
		this.activeIndex = -1;

		if (features.length === 0) {
			this.showMessage('No results found', 'geocoding-no-results');
			return;
		}

		for (const feature of features) {
			const item = document.createElement('button');
			item.type = 'button';
			item.className = 'geocoding-result-item';

			const name = document.createElement('span');
			name.className = 'geocoding-result-name';
			name.textContent = feature.properties.name || 'Unnamed';
			item.appendChild(name);

			const context = [
				feature.properties.city,
				feature.properties.state,
				feature.properties.country,
			].filter(Boolean).join(', ');

			if (context) {
				const detail = document.createElement('span');
				detail.className = 'geocoding-result-detail';
				detail.textContent = context;
				item.appendChild(detail);
			}

			item.addEventListener('click', () => this.selectResult(feature));
			this.resultsList.appendChild(item);
		}
	}

	private selectResult(feature: PhotonFeature): void {
		if (!this.map) return;
		const [lng, lat] = feature.geometry.coordinates;
		const extent = feature.properties.extent;

		if (extent) {
			// extent: [minLng, maxLat, maxLng, minLat]
			this.map.fitBounds(
				[[extent[0], extent[3]], [extent[2], extent[1]]],
				{ padding: 50, maxZoom: 16 }
			);
		} else {
			this.map.flyTo({ center: [lng, lat], zoom: 15 });
		}

		this.closePanel();
	}

	private showMessage(text: string, className: string): void {
		if (!this.resultsList) return;
		this.resultsList.innerHTML = '';
		const msg = document.createElement('div');
		msg.className = className;
		msg.textContent = text;
		this.resultsList.appendChild(msg);
	}
}
