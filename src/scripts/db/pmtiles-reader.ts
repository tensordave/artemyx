/**
 * PMTiles extraction pipeline.
 * Reads tiles from a remote PMTiles archive via HTTP range requests,
 * decodes MVT features, deduplicates across tile boundaries,
 * and feeds the result into the tiling pipeline to produce a new archive.
 *
 * Runs in the DuckDB Web Worker thread.
 */

import { PMTiles, TileType } from 'pmtiles';
import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import type { PMTilesOutputParams } from '../config/types';
import { bboxToTileRange, computeBounds } from './pmtiles-writer';

// ── Types ───────────────────────────────────────────────────────────────────

export interface PMTilesExtractOptions {
	/** Remote PMTiles URL */
	url: string;
	/** Zoom level to extract tiles at */
	extractZoom: number;
	/** Geographic bbox to extract [west, south, east, north] */
	bbox: [number, number, number, number];
	/** Source layer names to extract (empty/omitted = all layers) */
	layers?: string[];
	/** Output PMTiles params for the re-tiling stage */
	outputParams?: PMTilesOutputParams;
	/** Progress callback */
	onProgress?: (message: string, progress?: number) => void;
}

export interface ExtractedFeatures {
	/** Per-layer FeatureCollections keyed by layer name */
	layers: Map<string, GeoJSON.FeatureCollection>;
	/** Total unique feature count across all layers */
	totalFeatures: number;
	/** Actual bounds of extracted features */
	bounds: [number, number, number, number];
}

/** Maximum number of tiles allowed in a single extraction. */
const MAX_TILE_COUNT = 10_000;

/** Number of concurrent tile fetch requests. */
const FETCH_CONCURRENCY = 6;

// ── Deduplication ───────────────────────────────────────────────────────────

/**
 * Compute a representative point for deduplication.
 * Points use coordinates directly. Lines/polygons use centroid.
 */
export function computeCentroid(geometry: GeoJSON.Geometry): [number, number] {
	switch (geometry.type) {
		case 'Point':
			return [geometry.coordinates[0], geometry.coordinates[1]];

		case 'MultiPoint':
		case 'LineString':
			return averageCoords(geometry.coordinates as number[][]);

		case 'MultiLineString':
		case 'Polygon':
			// Use first ring/line for centroid
			return averageCoords((geometry.coordinates as number[][][])[0]);

		case 'MultiPolygon':
			// Use outer ring of first polygon
			return averageCoords((geometry.coordinates as number[][][][])[0][0]);

		case 'GeometryCollection': {
			if (geometry.geometries.length === 0) return [0, 0];
			return computeCentroid(geometry.geometries[0]);
		}

		default:
			return [0, 0];
	}
}

function averageCoords(coords: number[][]): [number, number] {
	if (coords.length === 0) return [0, 0];
	let sumX = 0, sumY = 0;
	for (const c of coords) {
		sumX += c[0];
		sumY += c[1];
	}
	return [sumX / coords.length, sumY / coords.length];
}

/**
 * Compute a dedup key from centroid coordinates and properties.
 * Rounds coordinates to ~1.1m precision (1e-5 degrees).
 */
export function computeDedupKey(feature: GeoJSON.Feature): string {
	const [lon, lat] = computeCentroid(feature.geometry);
	const roundedLon = Math.round(lon * 1e5);
	const roundedLat = Math.round(lat * 1e5);
	const props = JSON.stringify(feature.properties ?? {});
	return `${roundedLon}:${roundedLat}:${props}`;
}

// ── Tile bounds ─────────────────────────────────────────────────────────────

/** Compute the geographic bounds [west, south, east, north] for a tile. */
function tileBounds(x: number, y: number, z: number): [number, number, number, number] {
	const n = 1 << z;
	const west = (x / n) * 360 - 180;
	const east = ((x + 1) / n) * 360 - 180;
	const north = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
	const south = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * 180) / Math.PI;
	return [west, south, east, north];
}

// ── Geometry clipping (Sutherland-Hodgman + Liang-Barsky) ───────────────────

/** Clip a GeoJSON geometry to a bounding box. Returns null if fully outside. */
function clipToBBox(
	geometry: GeoJSON.Geometry,
	bbox: [number, number, number, number]
): GeoJSON.Geometry | null {
	const [west, south, east, north] = bbox;

	switch (geometry.type) {
		case 'Point': {
			const [x, y] = geometry.coordinates;
			return (x >= west && x <= east && y >= south && y <= north) ? geometry : null;
		}
		case 'MultiPoint': {
			const coords = geometry.coordinates.filter(
				([x, y]) => x >= west && x <= east && y >= south && y <= north
			);
			return coords.length > 0 ? { type: 'MultiPoint', coordinates: coords } : null;
		}
		case 'LineString': {
			const segs = clipLineCoords(geometry.coordinates, west, south, east, north);
			if (segs.length === 0) return null;
			if (segs.length === 1) return { type: 'LineString', coordinates: segs[0] };
			return { type: 'MultiLineString', coordinates: segs };
		}
		case 'MultiLineString': {
			const all: number[][][] = [];
			for (const line of geometry.coordinates) {
				for (const seg of clipLineCoords(line, west, south, east, north)) all.push(seg);
			}
			return all.length > 0 ? { type: 'MultiLineString', coordinates: all } : null;
		}
		case 'Polygon': {
			const rings = clipPolygonCoords(geometry.coordinates, west, south, east, north);
			return rings ? { type: 'Polygon', coordinates: rings } : null;
		}
		case 'MultiPolygon': {
			const polys: number[][][][] = [];
			for (const poly of geometry.coordinates) {
				const rings = clipPolygonCoords(poly, west, south, east, north);
				if (rings) polys.push(rings);
			}
			return polys.length > 0 ? { type: 'MultiPolygon', coordinates: polys } : null;
		}
		case 'GeometryCollection': {
			const geoms: GeoJSON.Geometry[] = [];
			for (const g of geometry.geometries) {
				const c = clipToBBox(g, bbox);
				if (c) geoms.push(c);
			}
			return geoms.length > 0 ? { type: 'GeometryCollection', geometries: geoms } : null;
		}
		default:
			return geometry;
	}
}

/** Clip polygon rings to bbox using Sutherland-Hodgman. */
function clipPolygonCoords(
	rings: number[][][],
	west: number, south: number, east: number, north: number
): number[][][] | null {
	const result: number[][][] = [];

	for (let i = 0; i < rings.length; i++) {
		let ring = rings[i];
		// SH expects open rings — strip closing vertex if present
		if (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) {
			ring = ring.slice(0, -1);
		}

		ring = shClipEdge(ring, 0, 1, west);    // left:   x >= west
		if (ring.length === 0) { if (i === 0) return null; continue; }
		ring = shClipEdge(ring, 0, -1, east);   // right:  x <= east
		if (ring.length === 0) { if (i === 0) return null; continue; }
		ring = shClipEdge(ring, 1, 1, south);   // bottom: y >= south
		if (ring.length === 0) { if (i === 0) return null; continue; }
		ring = shClipEdge(ring, 1, -1, north);  // top:    y <= north
		if (ring.length === 0) { if (i === 0) return null; continue; }

		// Close the ring (GeoJSON requires first == last)
		ring.push([ring[0][0], ring[0][1]]);
		if (ring.length >= 4) result.push(ring);
	}

	return result.length > 0 ? result : null;
}

/**
 * Sutherland-Hodgman clip of a ring against one edge.
 * @param axis 0 = x, 1 = y
 * @param sign 1 = keep values >= threshold, -1 = keep values <= threshold
 */
function shClipEdge(ring: number[][], axis: number, sign: number, threshold: number): number[][] {
	const output: number[][] = [];
	const len = ring.length;
	if (len === 0) return output;
	const thr = threshold * sign;

	for (let i = 0; i < len; i++) {
		const curr = ring[i];
		const prev = ring[(i + len - 1) % len];
		const currInside = curr[axis] * sign >= thr;
		const prevInside = prev[axis] * sign >= thr;

		if (currInside) {
			if (!prevInside) output.push(edgeIntersect(prev, curr, axis, threshold));
			output.push(curr);
		} else if (prevInside) {
			output.push(edgeIntersect(prev, curr, axis, threshold));
		}
	}

	return output;
}

function edgeIntersect(a: number[], b: number[], axis: number, threshold: number): number[] {
	const t = (threshold - a[axis]) / (b[axis] - a[axis]);
	if (axis === 0) return [threshold, a[1] + t * (b[1] - a[1])];
	return [a[0] + t * (b[0] - a[0]), threshold];
}

/** Clip a linestring to bbox using Liang-Barsky per segment. Returns connected segments. */
function clipLineCoords(
	coords: number[][],
	west: number, south: number, east: number, north: number
): number[][][] {
	const segments: number[][][] = [];
	let current: number[][] = [];

	for (let i = 0; i < coords.length - 1; i++) {
		const clipped = liangBarsky(
			coords[i][0], coords[i][1], coords[i + 1][0], coords[i + 1][1],
			west, south, east, north
		);

		if (clipped) {
			const [x1, y1, x2, y2] = clipped;
			if (current.length > 0) {
				const last = current[current.length - 1];
				if (last[0] !== x1 || last[1] !== y1) {
					if (current.length >= 2) segments.push(current);
					current = [];
				}
			}
			if (current.length === 0) current.push([x1, y1]);
			current.push([x2, y2]);
		} else if (current.length >= 2) {
			segments.push(current);
			current = [];
		}
	}

	if (current.length >= 2) segments.push(current);
	return segments;
}

/** Liang-Barsky parametric line segment clip. Returns [x1,y1,x2,y2] or null. */
function liangBarsky(
	x1: number, y1: number, x2: number, y2: number,
	west: number, south: number, east: number, north: number
): [number, number, number, number] | null {
	const dx = x2 - x1, dy = y2 - y1;
	let t0 = 0, t1 = 1;

	const edges = [[-dx, x1 - west], [dx, east - x1], [-dy, y1 - south], [dy, north - y1]];
	for (const [p, q] of edges) {
		if (p === 0) {
			if (q < 0) return null;
		} else {
			const r = q / p;
			if (p < 0) { if (r > t0) t0 = r; }
			else { if (r < t1) t1 = r; }
			if (t0 > t1) return null;
		}
	}

	return [x1 + t0 * dx, y1 + t0 * dy, x1 + t1 * dx, y1 + t1 * dy];
}

// ── MVT Decoding ────────────────────────────────────────────────────────────

/**
 * Decode an MVT tile buffer into GeoJSON features grouped by layer.
 * Features are clipped to exact tile bounds to remove buffer overhang.
 * Features entirely outside tile bounds clip to null and are dropped.
 * @param data Already-decompressed tile data (PMTiles library handles decompression)
 */
function decodeMVTTile(
	data: ArrayBuffer,
	x: number,
	y: number,
	z: number,
	layerFilter?: Set<string>
): Map<string, GeoJSON.Feature[]> {
	const vt = new VectorTile(new Pbf(data));
	const result = new Map<string, GeoJSON.Feature[]>();
	const bounds = tileBounds(x, y, z);

	for (const layerName of Object.keys(vt.layers)) {
		if (layerFilter && !layerFilter.has(layerName)) continue;

		const layer = vt.layers[layerName];
		const features: GeoJSON.Feature[] = [];

		for (let i = 0; i < layer.length; i++) {
			const vtFeature = layer.feature(i);
			const geojson = vtFeature.toGeoJSON(x, y, z) as GeoJSON.Feature;

			// Clip geometry to tile bounds — removes buffer overhang,
			// returns null for features entirely outside the tile
			const clipped = clipToBBox(geojson.geometry, bounds);
			if (!clipped) continue;

			features.push({ ...geojson, geometry: clipped });
		}

		if (features.length > 0) {
			result.set(layerName, features);
		}
	}

	return result;
}

// ── Tile Fetching ───────────────────────────────────────────────────────────

interface TileCoord {
	z: number;
	x: number;
	y: number;
}

/**
 * Fetch and process tiles with bounded concurrency.
 * Each tile is decoded immediately on receipt to keep memory bounded.
 */
async function fetchAndDecodeTiles(
	pm: PMTiles,
	tiles: TileCoord[],
	layerFilter: Set<string> | undefined,
	dedupSets: Map<string, Set<string>>,
	layerFeatures: Map<string, GeoJSON.Feature[]>,
	onProgress?: (fetched: number, total: number) => void
): Promise<void> {
	let fetched = 0;
	const total = tiles.length;
	let active = 0;
	let tileIndex = 0;

	await new Promise<void>((resolve, reject) => {
		function startNext(): void {
			if (tileIndex >= total && active === 0) {
				resolve();
				return;
			}

			while (active < FETCH_CONCURRENCY && tileIndex < total) {
				const tile = tiles[tileIndex++];
				active++;

				pm.getZxy(tile.z, tile.x, tile.y)
					.then((response) => {
						if (response?.data) {
							const decoded = decodeMVTTile(response.data, tile.x, tile.y, tile.z, layerFilter);

							for (const [layerName, features] of decoded) {
								let dedupSet = dedupSets.get(layerName);
								if (!dedupSet) {
									dedupSet = new Set();
									dedupSets.set(layerName, dedupSet);
								}

								let collected = layerFeatures.get(layerName);
								if (!collected) {
									collected = [];
									layerFeatures.set(layerName, collected);
								}

								for (const feature of features) {
									const key = computeDedupKey(feature);
									if (!dedupSet.has(key)) {
										dedupSet.add(key);
										collected.push(feature);
									}
								}
							}
						}

						fetched++;
						active--;
						onProgress?.(fetched, total);
						startNext();
					})
					.catch((err) => {
						reject(err instanceof Error ? err : new Error(String(err)));
					});
			}
		}

		startNext();
	});
}

// ── Extraction ──────────────────────────────────────────────────────────────

/**
 * Extract and deduplicate features from a remote PMTiles archive.
 */
export async function extractPMTilesFeatures(
	options: PMTilesExtractOptions
): Promise<ExtractedFeatures> {
	const { url, extractZoom, bbox, layers, onProgress } = options;

	// 1. Initialize PMTiles instance
	onProgress?.('Reading tile index...', 0);
	const pm = new PMTiles(url);
	const header = await pm.getHeader();

	if (header.tileType !== TileType.Mvt) {
		throw new Error('PMTiles archive does not contain vector tiles (MVT)');
	}

	// 2. Read metadata for layer discovery
	const metadata = await pm.getMetadata();
	const availableLayers: string[] = [];
	if (metadata && typeof metadata === 'object' && 'vector_layers' in metadata) {
		const vectorLayers = (metadata as Record<string, unknown>).vector_layers;
		if (Array.isArray(vectorLayers)) {
			for (const vl of vectorLayers) {
				if (vl && typeof vl.id === 'string') {
					availableLayers.push(vl.id);
				}
			}
		}
	}

	// Validate requested layers exist
	const layerFilter = layers && layers.length > 0 ? new Set(layers) : undefined;
	if (layerFilter) {
		for (const name of layerFilter) {
			if (availableLayers.length > 0 && !availableLayers.includes(name)) {
				throw new Error(`Source layer '${name}' not found in PMTiles archive. Available: ${availableLayers.join(', ')}`);
			}
		}
	}

	onProgress?.('Reading tile index...', 0.02);

	// 3. Compute tile range
	const range = bboxToTileRange(bbox, extractZoom);
	const tiles: TileCoord[] = [];
	for (let x = range.minX; x <= range.maxX; x++) {
		for (let y = range.minY; y <= range.maxY; y++) {
			tiles.push({ z: extractZoom, x, y });
		}
	}

	if (tiles.length === 0) {
		throw new Error('No tiles found within the specified bounding box and zoom level');
	}

	if (tiles.length > MAX_TILE_COUNT) {
		throw new Error(
			`Extraction would require ${tiles.length.toLocaleString()} tiles (limit: ${MAX_TILE_COUNT.toLocaleString()}). ` +
			`Reduce the bounding box or lower the extractZoom level.`
		);
	}

	// 4. Fetch, decode, and deduplicate
	const dedupSets = new Map<string, Set<string>>();
	const layerFeatures = new Map<string, GeoJSON.Feature[]>();

	await fetchAndDecodeTiles(
		pm,
		tiles,
		layerFilter,
		dedupSets,
		layerFeatures,
		(fetched, total) => {
			onProgress?.(`Reading tiles [${fetched}/${total}]`, 0.02 + (fetched / total) * 0.58);
		}
	);

	// 5. Build per-layer FeatureCollections
	const resultLayers = new Map<string, GeoJSON.FeatureCollection>();
	let totalFeatures = 0;

	for (const [layerName, features] of layerFeatures) {
		resultLayers.set(layerName, { type: 'FeatureCollection', features });
		totalFeatures += features.length;
	}

	// Free dedup sets
	dedupSets.clear();

	if (totalFeatures === 0) {
		throw new Error('No features found in the specified bounding box and zoom level');
	}

	// 6. Compute actual bounds from extracted features
	const allFeatures: GeoJSON.Feature[] = [];
	for (const fc of resultLayers.values()) {
		for (const f of fc.features) allFeatures.push(f);
	}
	const bounds = computeBounds({ type: 'FeatureCollection', features: allFeatures });

	onProgress?.(`Deduplicated: ${totalFeatures.toLocaleString()} unique features`, 0.60);

	return { layers: resultLayers, totalFeatures, bounds };
}

// ── Orchestrator ────────────────────────────────────────────────────────────

/**
 * Extract features from a remote PMTiles archive and rebuild into a new archive.
 * Top-level function called from the worker message handler.
 */
export async function extractPMTilesAndRebuild(
	options: PMTilesExtractOptions
): Promise<Uint8Array> {
	const { outputParams, onProgress } = options;

	// Stage 1+2: Extract and deduplicate
	let extracted: ExtractedFeatures | null = await extractPMTilesFeatures(options);

	// Stage 3: Re-tile into a new PMTiles archive
	const layerNames = [...extracted.layers.keys()];
	const isMultiLayer = layerNames.length > 1;

	if (isMultiLayer) {
		// Multi-layer: use the multi-layer writer
		const { generateMultiLayerPMTiles } = await import('./pmtiles-writer');
		// Pass layers to writer, then release extraction data
		const layers = extracted.layers;
		extracted = null;
		return generateMultiLayerPMTiles({
			layers,
			params: outputParams,
			onProgress: (msg, p) => {
				// Remap progress from 0-1 to 0.62-0.98
				const mapped = p !== undefined ? 0.62 + p * 0.36 : undefined;
				onProgress?.(msg, mapped);
			},
		});
	} else {
		// Single layer: use the existing single-layer writer
		const { generatePMTiles } = await import('./pmtiles-writer');
		const layerName = layerNames[0];
		const fc = extracted.layers.get(layerName)!;
		// Release extraction data — writer owns the FeatureCollection now
		extracted = null;

		return generatePMTiles({
			datasetId: layerName,
			params: {
				...outputParams,
				layerName: outputParams?.layerName ?? layerName,
			},
			featureCollection: fc,
			onProgress: (msg, p) => {
				const mapped = p !== undefined ? 0.62 + p * 0.36 : undefined;
				onProgress?.(msg, mapped);
			},
		});
	}
}
