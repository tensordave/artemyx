import type { SourceSpecification, LayerSpecification } from 'maplibre-gl';

/**
 * Configuration for a basemap tile source.
 * Each basemap has a unique ID, display name, and MapLibre source/layer specs.
 */
export interface BasemapConfig {
	id: string;
	name: string;
	source: SourceSpecification;
	layer: LayerSpecification;
}

/**
 * Available basemaps for the application.
 * Order here determines order in the UI menu.
 */
export const basemaps: BasemapConfig[] = [
	{
		id: 'carto-dark',
		name: 'CARTO Dark',
		source: {
			type: 'raster',
			tiles: [
				'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
				'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
				'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
				'https://d.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png'
			],
			tileSize: 256,
			attribution:
				'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
		},
		layer: {
			id: 'basemap-layer',
			type: 'raster',
			source: 'basemap',
			minzoom: 0,
			maxzoom: 20
		}
	},
	{
		id: 'carto-light',
		name: 'CARTO Light',
		source: {
			type: 'raster',
			tiles: [
				'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
				'https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
				'https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
				'https://d.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png'
			],
			tileSize: 256,
			attribution:
				'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
		},
		layer: {
			id: 'basemap-layer',
			type: 'raster',
			source: 'basemap',
			minzoom: 0,
			maxzoom: 20
		}
	},
	{
		id: 'carto-voyager',
		name: 'CARTO Voyager',
		source: {
			type: 'raster',
			tiles: [
				'https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
				'https://b.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
				'https://c.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
				'https://d.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png'
			],
			tileSize: 256,
			attribution:
				'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
		},
		layer: {
			id: 'basemap-layer',
			type: 'raster',
			source: 'basemap',
			minzoom: 0,
			maxzoom: 20
		}
	},
	{
		id: 'esri-satellite',
		name: 'Satellite',
		source: {
			type: 'raster',
			tiles: [
				'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
			],
			tileSize: 256,
			attribution:
				'&copy; <a href="https://www.esri.com/">Esri</a>, Maxar, Earthstar Geographics'
		},
		layer: {
			id: 'basemap-layer',
			type: 'raster',
			source: 'basemap',
			minzoom: 0,
			maxzoom: 19
		}
	}
];

/** Default basemap ID used on initial map load */
export const defaultBasemapId = 'carto-dark';

/** Get a basemap configuration by ID */
export function getBasemap(id: string): BasemapConfig | undefined {
	return basemaps.find((b) => b.id === id);
}

/** Get the default basemap configuration */
export function getDefaultBasemap(): BasemapConfig {
	return getBasemap(defaultBasemapId) ?? basemaps[0];
}
