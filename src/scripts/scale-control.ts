import type { Map, IControl } from 'maplibre-gl';

type Unit = 'metric' | 'imperial';

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

/**
 * Custom map control that renders a distance scale bar with a metric/imperial toggle.
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

	onAdd(map: Map): HTMLElement {
		this.map = map;

		this.container = document.createElement('div');
		this.container.className = 'maplibregl-ctrl scale-bar-control';

		// Bar element: three-sided bracket (left, bottom, right borders; no top)
		this.bar = document.createElement('div');
		this.bar.className = 'scale-bar';

		// Distance label (e.g. "500 km")
		this.label = document.createElement('span');
		this.label.className = 'scale-bar-label';

		// Unit toggle button (shows the inactive unit as a hint: click to switch)
		this.toggleBtn = document.createElement('button');
		this.toggleBtn.type = 'button';
		this.toggleBtn.className = 'scale-unit-btn';
		this.toggleBtn.title = 'Toggle scale units';
		this.toggleBtn.addEventListener('click', () => this.toggle());

		this.container.appendChild(this.bar);
		this.container.appendChild(this.label);
		this.container.appendChild(this.toggleBtn);

		map.on('move', this.update);
		this.update();

		return this.container;
	}

	onRemove(): void {
		this.map?.off('move', this.update);
		this.container?.remove();
		this.map = null;
		this.container = null;
		this.bar = null;
		this.label = null;
		this.toggleBtn = null;
	}

	private toggle(): void {
		this.unit = this.unit === 'metric' ? 'imperial' : 'metric';
		this.update();
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
	};
}
