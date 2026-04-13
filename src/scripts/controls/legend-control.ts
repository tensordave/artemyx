/**
 * Legend control — auto-generated legend panel derived from active layer styles.
 * Bottom-right overlay above the scale bar, toggleable via header click.
 */

import type { Map as MaplibreMap, IControl } from 'maplibre-gl';
import type { SourceLayerInfo } from '../layers/layers';
import { listIcon } from '../icons';
import { getDatasets } from '../db';
import { getLayersByDataset } from '../deckgl/registry';
import { getLayerEntry } from '../deckgl/manager';

const STORAGE_KEY = 'artemyx-legend-expanded';
const DEBOUNCE_MS = 200;

/** Maps layer types to their primary color paint property. */
const COLOR_PROPERTY: Record<string, string> = {
	fill: 'fill-color',
	line: 'line-color',
	circle: 'circle-color',
	'fill-extrusion': 'fill-extrusion-color'
};

// Chevron SVG (Phosphor CaretDown, 12px)
const chevronSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="currentColor" viewBox="0 0 256 256"><path d="M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,53.66,90.34L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z"></path></svg>`;

// ── Types ──

interface SolidEntry {
	type: 'solid';
	color: string;
	layerType: 'fill' | 'line' | 'circle' | 'fill-extrusion';
}

interface GradientEntry {
	type: 'gradient';
	property: string;
	stops: Array<{ value: number; color: string }>;
}

interface CategoryEntry {
	type: 'categories';
	property: string;
	categories: Array<{ value: string; color: string }>;
	fallback: string;
}

type LegendEntry = SolidEntry | GradientEntry | CategoryEntry;

interface LegendGroup {
	label: string;
	entries: LegendEntry[];
}

// ── Expression parsing ──

function parseInterpolate(expr: unknown[]): GradientEntry | null {
	// ["interpolate", ["linear"], ["get", "prop"], v1, c1, v2, c2, ...]
	if (expr.length < 5) return null;
	const inputExpr = expr[2];
	const property = Array.isArray(inputExpr) && inputExpr[0] === 'get'
		? String(inputExpr[1])
		: '?';
	const stops: GradientEntry['stops'] = [];
	for (let i = 3; i < expr.length - 1; i += 2) {
		stops.push({ value: Number(expr[i]), color: String(expr[i + 1]) });
	}
	if (stops.length < 2) return null;
	return { type: 'gradient', property, stops };
}

function parseMatch(expr: unknown[]): CategoryEntry | null {
	// ["match", ["get", "prop"], cat1, color1, cat2, color2, ..., fallback]
	if (expr.length < 4) return null;
	const inputExpr = expr[1];
	const property = Array.isArray(inputExpr) && inputExpr[0] === 'get'
		? String(inputExpr[1])
		: '?';
	const fallback = String(expr[expr.length - 1]);
	const categories: CategoryEntry['categories'] = [];
	for (let i = 2; i < expr.length - 1; i += 2) {
		categories.push({ value: String(expr[i]), color: String(expr[i + 1]) });
	}
	if (categories.length === 0) return null;
	return { type: 'categories', property, categories, fallback };
}

function parseColorValue(value: unknown, layerType: SourceLayerInfo['type']): LegendEntry | null {
	if (typeof value === 'string') {
		return { type: 'solid', color: value, layerType: layerType as SolidEntry['layerType'] };
	}
	if (!Array.isArray(value) || value.length === 0) return null;
	const head = value[0];
	if (head === 'interpolate') return parseInterpolate(value);
	if (head === 'match') return parseMatch(value);
	return null;
}

// ── Helpers ──

interface LegendBuildResult {
	groups: LegendGroup[];
	/** Dataset IDs that have at least one MapLibre legend entry */
	coveredDatasetIds: Set<string>;
}

function buildLegendGroups(map: MaplibreMap, datasetNames: Record<string, string>): LegendBuildResult {
	const style = map.getStyle();
	if (!style?.layers) return { groups: [], coveredDatasetIds: new Set() };

	// Group layers by source
	const sourceMap = new Map<string, Array<{ type: SourceLayerInfo['type']; paint: Record<string, unknown> }>>();

	for (const layer of style.layers) {
		if (!('source' in layer) || typeof layer.source !== 'string') continue;
		if (!layer.source.startsWith('dataset-')) continue;

		// Skip hidden layers
		if (layer.layout && (layer.layout as Record<string, unknown>).visibility === 'none') continue;

		// Skip symbol and heatmap
		if (layer.type === 'symbol' || layer.type === 'heatmap') continue;

		const validTypes = ['fill', 'line', 'circle', 'fill-extrusion'];
		if (!validTypes.includes(layer.type)) continue;

		// Group by source + source-layer so PMTiles sublayers get separate legend entries
		const sourceLayer = ('source-layer' in layer) ? (layer as any)['source-layer'] as string : undefined;
		const groupKey = sourceLayer ? `${layer.source}|${sourceLayer}` : layer.source;

		if (!sourceMap.has(groupKey)) sourceMap.set(groupKey, []);
		sourceMap.get(groupKey)!.push({
			type: layer.type as SourceLayerInfo['type'],
			paint: (layer.paint as Record<string, unknown>) || {}
		});
	}

	const groups: LegendGroup[] = [];
	const coveredDatasetIds = new Set<string>();

	for (const [groupKey, layers] of sourceMap) {
		// Parse composite key: "dataset-parent|sourceLayer" or plain "dataset-id"
		const pipeIdx = groupKey.indexOf('|');
		let datasetId: string;
		if (pipeIdx >= 0) {
			const sourceId = groupKey.substring(0, pipeIdx);
			const sourceLayer = groupKey.substring(pipeIdx + 1);
			const parentId = sourceId.replace(/^dataset-/, '');
			datasetId = `${parentId}/${sourceLayer}`;
		} else {
			datasetId = groupKey.replace(/^dataset-/, '');
		}
		const label = datasetNames[datasetId] || datasetId;
		const entries: LegendEntry[] = [];

		for (const layer of layers) {
			const colorProp = COLOR_PROPERTY[layer.type];
			if (!colorProp) continue;
			const value = layer.paint[colorProp];
			if (value === undefined) continue;
			const entry = parseColorValue(value, layer.type);
			if (entry) entries.push(entry);
		}

		// Deduplicate: if all entries are solid with the same color, keep one
		if (entries.length > 1 && entries.every(e => e.type === 'solid')) {
			const colors = new Set(entries.map(e => (e as SolidEntry).color));
			if (colors.size === 1) {
				entries.splice(1);
			}
		}

		if (entries.length > 0) {
			groups.push({ label, entries });
			coveredDatasetIds.add(datasetId);
		}
	}

	return { groups, coveredDatasetIds };
}

// ── deck.gl legend groups ──

function buildDeckLegendGroups(
	datasets: Array<{ id: string; name: string; color: string }>,
	excludeIds: Set<string>
): LegendGroup[] {
	const groups: LegendGroup[] = [];

	for (const ds of datasets) {
		if (excludeIds.has(ds.id)) continue;

		const deckLayerIds = getLayersByDataset(ds.id, 'deckgl');
		if (deckLayerIds.length === 0) continue;

		// Check authoritative visibility from the manager
		const entry = getLayerEntry(deckLayerIds[0]);
		if (entry && !entry.visible) continue;

		groups.push({
			label: ds.name || ds.id,
			entries: [{
				type: 'solid',
				color: ds.color || '#3388ff',
				layerType: 'fill'
			}]
		});
	}

	return groups;
}

// ── Rendering ──

function renderSwatch(entry: SolidEntry): HTMLElement {
	const el = document.createElement('div');
	el.className = 'legend-swatch';
	if (entry.layerType === 'line') el.className += ' legend-swatch--line';
	if (entry.layerType === 'circle') el.className += ' legend-swatch--circle';
	el.style.backgroundColor = entry.color;
	return el;
}

function renderSolidEntry(entry: SolidEntry): HTMLElement {
	const row = document.createElement('div');
	row.className = 'legend-solid';
	row.appendChild(renderSwatch(entry));
	return row;
}

function renderGradientEntry(entry: GradientEntry): HTMLElement {
	const container = document.createElement('div');
	container.className = 'legend-gradient';

	const prop = document.createElement('div');
	prop.className = 'legend-gradient-property';
	prop.textContent = entry.property;
	container.appendChild(prop);

	const bar = document.createElement('div');
	bar.className = 'legend-gradient-bar';
	const cssStops = entry.stops.map((s, i) => {
		const pct = (i / (entry.stops.length - 1)) * 100;
		return `${s.color} ${pct}%`;
	}).join(', ');
	bar.style.background = `linear-gradient(to right, ${cssStops})`;
	container.appendChild(bar);

	const labels = document.createElement('div');
	labels.className = 'legend-gradient-labels';
	const minLabel = document.createElement('span');
	minLabel.textContent = String(entry.stops[0].value);
	const maxLabel = document.createElement('span');
	maxLabel.textContent = String(entry.stops[entry.stops.length - 1].value);
	labels.appendChild(minLabel);
	labels.appendChild(maxLabel);
	container.appendChild(labels);

	return container;
}

function renderCategoryEntry(entry: CategoryEntry): HTMLElement {
	const container = document.createElement('div');
	container.className = 'legend-categories';

	const prop = document.createElement('div');
	prop.className = 'legend-category-property';
	prop.textContent = entry.property;
	container.appendChild(prop);

	for (const cat of entry.categories) {
		const row = document.createElement('div');
		row.className = 'legend-category-row';

		const swatch = document.createElement('div');
		swatch.className = 'legend-swatch';
		swatch.style.backgroundColor = cat.color;
		row.appendChild(swatch);

		const label = document.createElement('div');
		label.className = 'legend-category-label';
		label.textContent = cat.value;
		row.appendChild(label);

		container.appendChild(row);
	}

	// Fallback
	const fallbackRow = document.createElement('div');
	fallbackRow.className = 'legend-category-row';
	const fallbackSwatch = document.createElement('div');
	fallbackSwatch.className = 'legend-swatch';
	fallbackSwatch.style.backgroundColor = entry.fallback;
	fallbackRow.appendChild(fallbackSwatch);
	const fallbackLabel = document.createElement('div');
	fallbackLabel.className = 'legend-category-label';
	fallbackLabel.textContent = 'Other';
	fallbackRow.appendChild(fallbackLabel);
	container.appendChild(fallbackRow);

	return container;
}

function renderEntry(entry: LegendEntry): HTMLElement {
	switch (entry.type) {
		case 'solid': return renderSolidEntry(entry);
		case 'gradient': return renderGradientEntry(entry);
		case 'categories': return renderCategoryEntry(entry);
	}
}

function renderGroup(group: LegendGroup): HTMLElement {
	const el = document.createElement('div');
	el.className = 'legend-group';

	// Show dataset label if the group has only solid entries (no property header)
	// For gradient/category entries, the property name serves as context
	const hasOnlySolid = group.entries.every(e => e.type === 'solid');

	if (hasOnlySolid) {
		const label = document.createElement('div');
		label.className = 'legend-group-label';
		label.textContent = group.label;
		el.appendChild(label);
	} else {
		const label = document.createElement('div');
		label.className = 'legend-group-label';
		label.textContent = group.label;
		el.appendChild(label);
	}

	for (const entry of group.entries) {
		el.appendChild(renderEntry(entry));
	}

	return el;
}

// ── Control ──

export class LegendControl implements IControl {
	private map: MaplibreMap | null = null;
	private container: HTMLDivElement | null = null;
	private content: HTMLDivElement | null = null;
	private header: HTMLDivElement | null = null;
	private expanded: boolean;
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private boundScheduleRebuild = () => this.scheduleRebuild();

	constructor() {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored !== null) {
			this.expanded = stored === 'true';
		} else {
			// Default: collapsed on all screens
			this.expanded = false;
		}
	}

	onAdd(map: MaplibreMap): HTMLElement {
		this.map = map;

		this.container = document.createElement('div');
		this.container.className = 'maplibregl-ctrl legend-control';
		if (!this.expanded) this.container.classList.add('legend-control--collapsed');

		// Header
		const header = document.createElement('div');
		header.className = 'legend-header';
		header.addEventListener('click', () => this.toggle());
		header.title = 'Legend (E)';
		header.setAttribute('aria-label', 'Legend');
		header.setAttribute('role', 'button');
		header.setAttribute('aria-expanded', String(this.expanded));
		header.tabIndex = 0;
		header.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				this.toggle();
			}
		});
		this.header = header;

		const icon = document.createElement('span');
		icon.className = 'legend-header-icon';
		icon.innerHTML = listIcon;
		header.appendChild(icon);

		const label = document.createElement('span');
		label.className = 'legend-header-label';
		label.textContent = 'Legend';
		header.appendChild(label);

		const chevron = document.createElement('span');
		chevron.className = 'legend-header-chevron';
		chevron.innerHTML = chevronSvg;
		header.appendChild(chevron);

		this.container.appendChild(header);

		// Content
		this.content = document.createElement('div');
		this.content.className = 'legend-content';
		this.container.appendChild(this.content);

		// Subscribe to style changes
		map.on('styledata', this.boundScheduleRebuild);

		// Initial build
		this.rebuild();

		return this.container;
	}

	onRemove(): void {
		if (this.map) {
			this.map.off('styledata', this.boundScheduleRebuild);
		}
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		this.container?.remove();
		this.map = null;
		this.container = null;
		this.content = null;
		this.header = null;
	}

	/** Public: trigger a legend refresh from outside. */
	refresh(): void {
		this.scheduleRebuild();
	}

	togglePanel(): void {
		this.toggle();
	}

	private toggle(): void {
		this.expanded = !this.expanded;
		this.container?.classList.toggle('legend-control--collapsed', !this.expanded);
		this.header?.setAttribute('aria-expanded', String(this.expanded));
		localStorage.setItem(STORAGE_KEY, String(this.expanded));
	}

	private scheduleRebuild(): void {
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		this.debounceTimer = setTimeout(() => this.rebuild(), DEBOUNCE_MS);
	}

	private async rebuild(): Promise<void> {
		if (!this.map || !this.content) return;

		// Resolve dataset names
		const datasets = await getDatasets();
		const nameMap: Record<string, string> = {};
		for (const ds of datasets) {
			nameMap[ds.id] = ds.name || ds.id;
		}

		const { groups: maplibreGroups, coveredDatasetIds } = buildLegendGroups(this.map, nameMap);
		const deckGroups = buildDeckLegendGroups(datasets, coveredDatasetIds);
		const groups = [...maplibreGroups, ...deckGroups];

		// Clear and re-render
		this.content.innerHTML = '';

		if (groups.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'legend-empty';
			empty.textContent = 'No layers';
			this.content.appendChild(empty);
			return;
		}

		for (const group of groups) {
			this.content.appendChild(renderGroup(group));
		}
	}
}
