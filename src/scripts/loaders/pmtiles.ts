/**
 * PMTiles metadata reader.
 * Reads the archive header via a single HTTP range request to determine
 * tile type, available layers, zoom range, and bounds.
 * Main-thread only (not used in the DuckDB worker).
 */

import { PMTiles, TileType } from 'pmtiles';

export interface PMTilesMetadata {
	/** Vector tile layer names from TileJSON metadata */
	layers: string[];
	/** Minimum zoom level */
	minZoom: number;
	/** Maximum zoom level */
	maxZoom: number;
	/** Geographic bounds [west, south, east, north] */
	bounds?: [number, number, number, number];
	/** Tile format */
	tileType: 'mvt' | 'raster' | 'unknown';
}

/**
 * Read PMTiles header and metadata.
 * Accepts a URL string (fetched via HTTP range requests) or a PMTiles instance
 * (for local files using FileSource).
 */
export async function getPMTilesMetadata(urlOrInstance: string | PMTiles): Promise<PMTilesMetadata> {
	const pm = typeof urlOrInstance === 'string' ? new PMTiles(urlOrInstance) : urlOrInstance;
	const header = await pm.getHeader();
	const metadata = await pm.getMetadata();

	// Extract vector tile layer names from TileJSON-style metadata
	const layers: string[] = [];
	if (metadata && typeof metadata === 'object' && 'vector_layers' in metadata) {
		const vectorLayers = (metadata as any).vector_layers;
		if (Array.isArray(vectorLayers)) {
			for (const vl of vectorLayers) {
				if (vl && typeof vl.id === 'string') {
					layers.push(vl.id);
				}
			}
		}
	}

	let tileType: PMTilesMetadata['tileType'] = 'unknown';
	if (header.tileType === TileType.Mvt) {
		tileType = 'mvt';
	} else if (
		header.tileType === TileType.Png ||
		header.tileType === TileType.Jpeg ||
		header.tileType === TileType.Webp ||
		header.tileType === TileType.Avif
	) {
		tileType = 'raster';
	}

	const bounds: [number, number, number, number] | undefined =
		(header.minLon !== 0 || header.minLat !== 0 || header.maxLon !== 0 || header.maxLat !== 0)
			? [header.minLon, header.minLat, header.maxLon, header.maxLat]
			: undefined;

	return { layers, minZoom: header.minZoom, maxZoom: header.maxZoom, bounds, tileType };
}
