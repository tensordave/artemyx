import type { Map, IControl, MapMouseEvent } from 'maplibre-gl';

type Unit = 'metric' | 'imperial';
type CoordFormat = 'dd' | 'dms';

// Max bar width in pixels - drives scale calculation
const MAX_WIDTH = 120;

/**
 * Round down to the nearest "nice" number for scale labels.
 * Mirrors MapLibre's internal scale bar rounding.
 */
function getRoundNum(num: number): number {
	const pow10 = Math.pow(10, `${Math.floor(num)}`.length - 1);
	let d = num / pow10;
	d = d >= 10 ? 10 : d >= 5 ? 5 : d >= 3 ? 3 : d >= 2 ? 2 : 1;
	return pow10 * d;
}

function formatDD(lat: number, lng: number): string {
	return `${lat.toFixed(4)}\u00b0, ${lng.toFixed(4)}\u00b0`;
}

function formatDMS(deg: number, isLat: boolean): string {
	const abs = Math.abs(deg);
	const d = Math.floor(abs);
	const minFloat = (abs - d) * 60;
	const m = Math.floor(minFloat);
	const s = ((minFloat - m) * 60).toFixed(1);
	const dir = isLat ? (deg >= 0 ? 'N' : 'S') : (deg >= 0 ? 'E' : 'W');
	return `${d}\u00b0${m}'${s}"${dir}`;
}

/**
 * Custom map control that renders a distance scale bar with a metric/imperial toggle
 * and a mouse coordinate display with a decimal/DMS toggle.
 * Scale calculation uses map.unproject() + LngLat.distanceTo() (Haversine),
 * the same approach as MapLibre's built-in ScaleControl.
 */
export class ScaleBarControl implements IControl {
	private map: Map | null = null;
	private container: HTMLDivElement | null = null;
	private bar: HTMLDivElement | null = null;
	private label: HTMLSpanElement | null = null;
	private toggleBtn: HTMLButtonElement | null = null;
	private unit: Unit = 'metric';

	private coordLabel: HTMLSpanElement | null = null;
	private coordFormatBtn: HTMLButtonElement | null = null;
	private coordFormat: CoordFormat = 'dd';
	private isMobile = false;
	private hasMouseOver = false;
	private cursorLat = 0;
	private cursorLng = 0;

	onAdd(map: Map): HTMLElement {
		this.map = map;
		this.isMobile = window.matchMedia('(pointer: coarse)').matches;

		this.container = document.createElement('div');
		this.container.className = 'maplibregl-ctrl scale-bar-control';

		// Scale bar row
		const scaleRow = document.createElement('div');
		scaleRow.className = 'scale-bar-row';

		this.bar = document.createElement('div');
		this.bar.className = 'scale-bar';

		this.label = document.createElement('span');
		this.label.className = 'scale-bar-label';

		this.toggleBtn = document.createElement('button');
		this.toggleBtn.type = 'button';
		this.toggleBtn.className = 'scale-unit-btn';
		this.toggleBtn.title = 'Toggle scale units';
		this.toggleBtn.addEventListener('click', () => this.toggle());

		scaleRow.appendChild(this.bar);
		scaleRow.appendChild(this.label);
		scaleRow.appendChild(this.toggleBtn);

		// Coordinate row
		const coordRow = document.createElement('div');
		coordRow.className = 'coord-row';

		this.coordLabel = document.createElement('span');
		this.coordLabel.className = 'coord-label';

		this.coordFormatBtn = document.createElement('button');
		this.coordFormatBtn.type = 'button';
		this.coordFormatBtn.className = 'coord-format-btn';
		this.coordFormatBtn.title = 'Toggle coordinate format';
		this.coordFormatBtn.addEventListener('click', () => this.toggleCoordFormat());

		coordRow.appendChild(this.coordLabel);
		coordRow.appendChild(this.coordFormatBtn);

		this.container.appendChild(scaleRow);
		this.container.appendChild(coordRow);

		map.on('move', this.update);

		if (!this.isMobile) {
			map.on('mousemove', this.onMouseMove);
			map.getCanvas().addEventListener('mouseleave', this.onMouseLeave);
		}

		this.update();

		return this.container;
	}

	onRemove(): void {
		this.map?.off('move', this.update);
		if (!this.isMobile) {
			this.map?.off('mousemove', this.onMouseMove);
			this.map?.getCanvas().removeEventListener('mouseleave', this.onMouseLeave);
		}
		this.container?.remove();
		this.map = null;
		this.container = null;
		this.bar = null;
		this.label = null;
		this.toggleBtn = null;
		this.coordLabel = null;
		this.coordFormatBtn = null;
	}

	private toggle(): void {
		this.unit = this.unit === 'metric' ? 'imperial' : 'metric';
		this.update();
	}

	private toggleCoordFormat(): void {
		this.coordFormat = this.coordFormat === 'dd' ? 'dms' : 'dd';
		this.updateCoords();
	}

	private onMouseMove = (e: MapMouseEvent): void => {
		this.hasMouseOver = true;
		this.cursorLat = e.lngLat.lat;
		this.cursorLng = e.lngLat.lng;
		this.updateCoords();
	};

	private onMouseLeave = (): void => {
		this.hasMouseOver = false;
		this.updateCoordsFromCenter();
	};

	private updateCoordsFromCenter(): void {
		if (!this.map) return;
		const center = this.map.getCenter();
		this.cursorLat = center.lat;
		this.cursorLng = center.lng;
		this.updateCoords();
	}

	private updateCoords(): void {
		if (!this.coordLabel || !this.coordFormatBtn) return;

		if (this.coordFormat === 'dms') {
			this.coordLabel.textContent = `${formatDMS(this.cursorLat, true)}, ${formatDMS(this.cursorLng, false)}`;
		} else {
			this.coordLabel.textContent = formatDD(this.cursorLat, this.cursorLng);
		}
		this.coordFormatBtn.textContent = this.coordFormat === 'dd' ? 'DMS' : 'DD';
	}

	// Arrow function so it can be passed directly to map.on/off without rebinding
	private update = (): void => {
		if (!this.map || !this.bar || !this.label || !this.toggleBtn) return;

		const y = this.map.getContainer().clientHeight / 2;
		const left = this.map.unproject([0, y]);
		const right = this.map.unproject([MAX_WIDTH, y]);
		const maxMeters = left.distanceTo(right);

		let distance: number;
		let unitLabel: string;
		let barWidth: number;

		if (this.unit === 'imperial') {
			const maxFeet = maxMeters * 3.28084;
			if (maxFeet > 5280) {
				const miles = maxFeet / 5280;
				distance = getRoundNum(miles);
				unitLabel = 'mi';
				barWidth = MAX_WIDTH * (distance / miles);
			} else {
				distance = getRoundNum(maxFeet);
				unitLabel = 'ft';
				barWidth = MAX_WIDTH * (distance / maxFeet);
			}
		} else {
			if (maxMeters >= 1000) {
				const km = maxMeters / 1000;
				distance = getRoundNum(km);
				unitLabel = 'km';
				barWidth = MAX_WIDTH * (distance / km);
			} else {
				distance = getRoundNum(maxMeters);
				unitLabel = 'm';
				barWidth = MAX_WIDTH * (distance / maxMeters);
			}
		}

		this.bar.style.width = `${barWidth}px`;
		this.label.textContent = `${distance}\u00a0${unitLabel}`;
		this.toggleBtn.textContent = this.unit === 'metric' ? 'mi' : 'km';

		// Update coords from map center when cursor isn't over the map
		if (!this.hasMouseOver) {
			this.updateCoordsFromCenter();
		}
	};
}
