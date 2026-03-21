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
 * Fetch PMTiles header and metadata from a URL.
 * Only reads the archive header (single range request), not tile data.
 */
export async function getPMTilesMetadata(url: string): Promise<PMTilesMetadata> {
	const pm = new PMTiles(url);
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
