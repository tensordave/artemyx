/**
 * PMTiles v3 archive writer.
 * Converts DuckDB feature data into a downloadable PMTiles vector tile archive.
 *
 * Pipeline: DuckDB features -> GeoJSON FeatureCollection -> geojson-vt (tile slicing)
 *           -> vt-pbf (MVT encoding) -> gzip (tile compression) -> PMTiles v3 archive
 *
 * Runs in the DuckDB Web Worker thread.
 */

import geojsonvt from 'geojson-vt';
import { fromGeojsonVt } from 'vt-pbf';
import { gzipSync } from 'fflate';
import { zxyToTileId, Compression, TileType } from 'pmtiles';
import type { Entry, Header } from 'pmtiles';
import type { PMTilesOutputParams } from '../config/types';
import { getFeaturesAsGeoJSON } from './features';

// ── Public API ──────────────────────────────────────────────────────────────

export interface PMTilesGenerateOptions {
	datasetId: string;
	params?: PMTilesOutputParams;
	onProgress?: (message: string, progress?: number) => void;
	/** Direct GeoJSON input — bypasses DuckDB read when provided (used by extraction pipeline). */
	featureCollection?: GeoJSON.FeatureCollection;
}

/**
 * Generate a PMTiles v3 archive from a DuckDB dataset.
 * @returns Uint8Array containing the complete PMTiles v3 binary archive
 */
export async function generatePMTiles(options: PMTilesGenerateOptions): Promise<Uint8Array> {
	const { datasetId, params, onProgress } = options;
	const minZoom = params?.minzoom ?? 0;
	const maxZoom = params?.maxzoom ?? 14;
	const layerName = params?.layerName ?? datasetId;

	const totalZooms = maxZoom - minZoom + 1;

	// 1. Read features from DuckDB (or use provided FeatureCollection)
	onProgress?.('Reading features...', 0);
	const fc = options.featureCollection ?? await getFeaturesAsGeoJSON(datasetId);

	if (fc.features.length === 0) {
		throw new Error(`Dataset '${datasetId}' has no features to tile`);
	}

	// 2. Compute bounds from the FeatureCollection
	const bounds = computeBounds(fc);

	// 3. Slice into vector tiles
	onProgress?.(`Slicing ${fc.features.length} features into tiles...`, 0.05);
	const tileIndex = geojsonvt(fc as GeoJSON.FeatureCollection<GeoJSON.Geometry>, {
		maxZoom,
		indexMaxZoom: maxZoom,
		indexMaxPoints: 0, // index all points at all zoom levels
		tolerance: 3,
		extent: 4096,
		buffer: 64,
	});

	// 4. Enumerate tiles within data bounds, encode MVT, compress
	const tileEntries: { tileId: number; data: Uint8Array }[] = [];

	for (let z = minZoom; z <= maxZoom; z++) {
		const { minX, minY, maxX, maxY } = bboxToTileRange(bounds, z);
		let tileCount = 0;

		for (let x = minX; x <= maxX; x++) {
			for (let y = minY; y <= maxY; y++) {
				const tile = tileIndex.getTile(z, x, y);
				if (!tile || tile.features.length === 0) continue;

				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const pbf = fromGeojsonVt({ [layerName]: tile } as any);
				const compressed = gzipSync(new Uint8Array(pbf));
				tileEntries.push({
					tileId: zxyToTileId(z, x, y),
					data: compressed,
				});
				tileCount++;
			}
		}

		onProgress?.(`Zoom ${z}/${maxZoom}: ${tileCount} tiles`, 0.1 + ((z - minZoom + 1) / totalZooms) * 0.8);
	}

	if (tileEntries.length === 0) {
		throw new Error(`No tiles generated for dataset '${datasetId}'`);
	}

	// 5. Sort by tileId (Hilbert order)
	tileEntries.sort((a, b) => a.tileId - b.tileId);

	// 6. Build archive
	onProgress?.(`Building archive (${tileEntries.length} tiles)...`, 0.95);
	return buildPMTilesArchive(tileEntries, {
		minZoom,
		maxZoom,
		bounds,
		layerNames: [layerName],
	});
}

// ── Multi-layer PMTiles generation ──────────────────────────────────────────

export interface MultiLayerPMTilesOptions {
	/** Per-layer FeatureCollections keyed by layer name */
	layers: Map<string, GeoJSON.FeatureCollection>;
	params?: PMTilesOutputParams;
	onProgress?: (message: string, progress?: number) => void;
}

/**
 * Generate a PMTiles v3 archive containing multiple named layers.
 * Used by the extraction pipeline for multi-layer PMTiles archives.
 */
export async function generateMultiLayerPMTiles(options: MultiLayerPMTilesOptions): Promise<Uint8Array> {
	const { layers, params, onProgress } = options;
	const minZoom = params?.minzoom ?? 0;
	const maxZoom = params?.maxzoom ?? 14;
	const layerNames = [...layers.keys()];

	const totalZooms = maxZoom - minZoom + 1;

	// 1. Compute combined bounds
	onProgress?.('Computing bounds...', 0);
	const allFeatures: GeoJSON.Feature[] = [];
	for (const fc of layers.values()) {
		allFeatures.push(...fc.features);
	}
	const bounds = computeBounds({ type: 'FeatureCollection', features: allFeatures });

	// 2. Create a geojson-vt index per layer
	onProgress?.('Slicing features into tiles...', 0.05);
	const tileIndices = new Map<string, ReturnType<typeof geojsonvt>>();
	for (const [name, fc] of layers) {
		tileIndices.set(name, geojsonvt(fc as GeoJSON.FeatureCollection<GeoJSON.Geometry>, {
			maxZoom,
			indexMaxZoom: maxZoom,
			indexMaxPoints: 0,
			tolerance: 3,
			extent: 4096,
			buffer: 64,
		}));
	}

	// 3. Enumerate tiles, encode MVT with all layers per tile
	const tileEntries: { tileId: number; data: Uint8Array }[] = [];

	for (let z = minZoom; z <= maxZoom; z++) {
		const { minX, minY, maxX, maxY } = bboxToTileRange(bounds, z);
		let tileCount = 0;

		for (let x = minX; x <= maxX; x++) {
			for (let y = minY; y <= maxY; y++) {
				// Collect non-empty tiles from each layer
				const layerTiles: Record<string, ReturnType<ReturnType<typeof geojsonvt>['getTile']>> = {};
				let hasData = false;

				for (const [name, index] of tileIndices) {
					const tile = index.getTile(z, x, y);
					if (tile && tile.features.length > 0) {
						layerTiles[name] = tile;
						hasData = true;
					}
				}

				if (!hasData) continue;

				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const pbf = fromGeojsonVt(layerTiles as any);
				const compressed = gzipSync(new Uint8Array(pbf));
				tileEntries.push({
					tileId: zxyToTileId(z, x, y),
					data: compressed,
				});
				tileCount++;
			}
		}

		onProgress?.(`Zoom ${z}/${maxZoom}: ${tileCount} tiles`, 0.1 + ((z - minZoom + 1) / totalZooms) * 0.8);
	}

	if (tileEntries.length === 0) {
		throw new Error('No tiles generated from extracted features');
	}

	// 4. Sort by tileId (Hilbert order)
	tileEntries.sort((a, b) => a.tileId - b.tileId);

	// 5. Build archive
	onProgress?.(`Building archive (${tileEntries.length} tiles)...`, 0.95);
	return buildPMTilesArchive(tileEntries, {
		minZoom,
		maxZoom,
		bounds,
		layerNames,
	});
}

// ── Archive builder ─────────────────────────────────────────────────────────

interface ArchiveOptions {
	minZoom: number;
	maxZoom: number;
	bounds: [number, number, number, number];
	/** Single layer name or array of layer names for multi-layer archives */
	layerNames: string[];
}

function buildPMTilesArchive(
	tileEntries: { tileId: number; data: Uint8Array }[],
	options: ArchiveOptions
): Uint8Array {
	const { minZoom, maxZoom, bounds, layerNames } = options;
	const [minLon, minLat, maxLon, maxLat] = bounds;
	const centerLon = (minLon + maxLon) / 2;
	const centerLat = (minLat + maxLat) / 2;
	const centerZoom = minZoom;
	const HEADER_SIZE = 127;

	// 1. Concatenate tile data, track relative offsets
	const tileDataParts: Uint8Array[] = [];
	let tileDataSize = 0;
	const relativeOffsets: number[] = [];

	for (const { data } of tileEntries) {
		relativeOffsets.push(tileDataSize);
		tileDataParts.push(data);
		tileDataSize += data.length;
	}

	// 2. Compress metadata
	const metadata = JSON.stringify({
		vector_layers: layerNames.map(name => ({
			id: name,
			minzoom: minZoom,
			maxzoom: maxZoom,
		})),
	});
	const compressedMetadata = gzipSync(new TextEncoder().encode(metadata));

	// 3. Layout: header | root directory | metadata | tile data
	//    The pmtiles library reads the first 16KB and expects the root directory
	//    immediately after the header. Directory uses relative offsets into the
	//    tile data section, so tile data position doesn't affect directory content.

	// 4. Build directory entries with offsets relative to tileDataOffset
	//    (the PMTiles reader adds tileDataOffset when reading)
	const entries: Entry[] = tileEntries.map(({ tileId, data }, i) => ({
		tileId,
		offset: relativeOffsets[i],
		length: data.length,
		runLength: 1,
	}));

	const compressedDirectory = gzipSync(serializeDirectory(entries));

	// 5. Calculate section offsets
	const rootDirOffset = HEADER_SIZE;
	const metadataOffset = rootDirOffset + compressedDirectory.length;
	const tileDataOffset = metadataOffset + compressedMetadata.length;

	// 6. Build header
	const header: Header = {
		specVersion: 3,
		rootDirectoryOffset: rootDirOffset,
		rootDirectoryLength: compressedDirectory.length,
		jsonMetadataOffset: metadataOffset,
		jsonMetadataLength: compressedMetadata.length,
		leafDirectoryOffset: 0,
		leafDirectoryLength: 0,
		tileDataOffset,
		tileDataLength: tileDataSize,
		numAddressedTiles: entries.length,
		numTileEntries: entries.length,
		numTileContents: entries.length,
		clustered: true,
		internalCompression: Compression.Gzip,
		tileCompression: Compression.Gzip,
		tileType: TileType.Mvt,
		minZoom,
		maxZoom,
		minLon,
		minLat,
		maxLon,
		maxLat,
		centerZoom,
		centerLon,
		centerLat,
	};

	// 7. Concatenate: header | directory | metadata | tile data
	const totalSize = HEADER_SIZE + compressedDirectory.length + compressedMetadata.length + tileDataSize;
	const archive = new Uint8Array(totalSize);
	let writePos = 0;

	archive.set(buildHeaderBytes(header), writePos); writePos += HEADER_SIZE;
	archive.set(compressedDirectory, writePos); writePos += compressedDirectory.length;
	archive.set(compressedMetadata, writePos); writePos += compressedMetadata.length;
	for (const part of tileDataParts) {
		archive.set(part, writePos);
		writePos += part.length;
	}

	return archive;
}

// ── Varint encoding ─────────────────────────────────────────────────────────

/**
 * Encode a non-negative integer as a protobuf-style LEB128 varint.
 * Compatible with the pmtiles library's `readVarint`.
 */
export function writeVarint(value: number): Uint8Array {
	const bytes: number[] = [];
	let v = value;
	while (v > 0x7f) {
		bytes.push((v & 0x7f) | 0x80);
		v >>>= 7;
	}
	bytes.push(v & 0x7f);
	return new Uint8Array(bytes);
}

// ── Directory serialization ─────────────────────────────────────────────────

/**
 * Serialize directory entries into the PMTiles v3 wire format.
 * Must produce output compatible with the pmtiles library's directory reader.
 *
 * Wire format:
 * 1. varint: entry count
 * 2. Per entry: varint tileId delta (first absolute, rest delta from previous)
 * 3. Per entry: varint runLength
 * 4. Per entry: varint length (byte size of tile data)
 * 5. Per entry: varint offset encoding
 *    - i=0: always offset+1
 *    - i>0: 0 = contiguous (prev.offset + prev.length), otherwise offset+1
 */
export function serializeDirectory(entries: Entry[]): Uint8Array {
	const parts: Uint8Array[] = [];

	// Entry count
	parts.push(writeVarint(entries.length));

	// TileId deltas
	let lastTileId = 0;
	for (const e of entries) {
		parts.push(writeVarint(e.tileId - lastTileId));
		lastTileId = e.tileId;
	}

	// Run lengths
	for (const e of entries) {
		parts.push(writeVarint(e.runLength));
	}

	// Lengths
	for (const e of entries) {
		parts.push(writeVarint(e.length));
	}

	// Offsets
	for (let i = 0; i < entries.length; i++) {
		if (i > 0 && entries[i].offset === entries[i - 1].offset + entries[i - 1].length) {
			parts.push(writeVarint(0)); // contiguous
		} else {
			parts.push(writeVarint(entries[i].offset + 1));
		}
	}

	// Concatenate
	const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
	const result = new Uint8Array(totalLength);
	let pos = 0;
	for (const p of parts) {
		result.set(p, pos);
		pos += p.length;
	}
	return result;
}

// ── Header serialization ────────────────────────────────────────────────────

/**
 * Serialize a PMTiles v3 header into a 127-byte buffer.
 * Compatible with the pmtiles library's `bytesToHeader`.
 *
 * Byte layout:
 * 0-1: magic (0x4D50 LE = "PM")
 * 2-6: reserved (zero)
 * 7: spec version (3)
 * 8-15: root directory offset (uint64 LE)
 * 16-23: root directory length (uint64 LE)
 * 24-31: json metadata offset (uint64 LE)
 * 32-39: json metadata length (uint64 LE)
 * 40-47: leaf directory offset (uint64 LE)
 * 48-55: leaf directory length (uint64 LE)
 * 56-63: tile data offset (uint64 LE)
 * 64-71: tile data length (uint64 LE)
 * 72-79: num addressed tiles (uint64 LE)
 * 80-87: num tile entries (uint64 LE)
 * 88-95: num tile contents (uint64 LE)
 * 96: clustered (uint8, 0 or 1)
 * 97: internal compression (uint8)
 * 98: tile compression (uint8)
 * 99: tile type (uint8)
 * 100: min zoom (uint8)
 * 101: max zoom (uint8)
 * 102-105: min lon (int32 LE, degrees * 10^7)
 * 106-109: min lat (int32 LE, degrees * 10^7)
 * 110-113: max lon (int32 LE, degrees * 10^7)
 * 114-117: max lat (int32 LE, degrees * 10^7)
 * 118: center zoom (uint8)
 * 119-122: center lon (int32 LE, degrees * 10^7)
 * 123-126: center lat (int32 LE, degrees * 10^7)
 */
export function buildHeaderBytes(header: Header): Uint8Array {
	const buf = new ArrayBuffer(127);
	const view = new DataView(buf);

	// Magic
	view.setUint16(0, 0x4d50, true);

	// Spec version
	view.setUint8(7, header.specVersion);

	// Uint64 fields (safe for values < Number.MAX_SAFE_INTEGER)
	setUint64(view, 8, header.rootDirectoryOffset);
	setUint64(view, 16, header.rootDirectoryLength);
	setUint64(view, 24, header.jsonMetadataOffset);
	setUint64(view, 32, header.jsonMetadataLength);
	setUint64(view, 40, header.leafDirectoryOffset ?? 0);
	setUint64(view, 48, header.leafDirectoryLength ?? 0);
	setUint64(view, 56, header.tileDataOffset);
	setUint64(view, 64, header.tileDataLength ?? 0);
	setUint64(view, 72, header.numAddressedTiles);
	setUint64(view, 80, header.numTileEntries);
	setUint64(view, 88, header.numTileContents);

	// Single-byte fields
	view.setUint8(96, header.clustered ? 1 : 0);
	view.setUint8(97, header.internalCompression);
	view.setUint8(98, header.tileCompression);
	view.setUint8(99, header.tileType);
	view.setUint8(100, header.minZoom);
	view.setUint8(101, header.maxZoom);

	// Bounds (int32, degrees * 10^7)
	view.setInt32(102, Math.round(header.minLon * 1e7), true);
	view.setInt32(106, Math.round(header.minLat * 1e7), true);
	view.setInt32(110, Math.round(header.maxLon * 1e7), true);
	view.setInt32(114, Math.round(header.maxLat * 1e7), true);

	// Center
	view.setUint8(118, header.centerZoom);
	view.setInt32(119, Math.round(header.centerLon * 1e7), true);
	view.setInt32(123, Math.round(header.centerLat * 1e7), true);

	return new Uint8Array(buf);
}

/** Write a JavaScript number as a little-endian uint64 into a DataView. */
function setUint64(view: DataView, offset: number, value: number): void {
	// Split into low 32 bits and high 32 bits
	view.setUint32(offset, value & 0xffffffff, true);
	view.setUint32(offset + 4, Math.floor(value / 0x100000000), true);
}

// ── Bounds computation ──────────────────────────────────────────────────────

/** Convert a geographic bounding box to tile coordinate range at a given zoom level. */
export function bboxToTileRange(bbox: [number, number, number, number], z: number) {
	const [west, south, east, north] = bbox;
	const n = 1 << z;

	const minX = Math.max(0, Math.floor(((west + 180) / 360) * n));
	const maxX = Math.min(n - 1, Math.floor(((east + 180) / 360) * n));

	// Y axis is inverted (north = 0)
	const latRadN = (north * Math.PI) / 180;
	const latRadS = (south * Math.PI) / 180;
	const minY = Math.max(0, Math.floor((1 - Math.log(Math.tan(latRadN) + 1 / Math.cos(latRadN)) / Math.PI) / 2 * n));
	const maxY = Math.min(n - 1, Math.floor((1 - Math.log(Math.tan(latRadS) + 1 / Math.cos(latRadS)) / Math.PI) / 2 * n));

	return { minX, minY, maxX, maxY };
}

export function computeBounds(fc: GeoJSON.FeatureCollection): [number, number, number, number] {
	let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;

	for (const feature of fc.features) {
		visitCoords(feature.geometry, (lon, lat) => {
			if (lon < minLon) minLon = lon;
			if (lat < minLat) minLat = lat;
			if (lon > maxLon) maxLon = lon;
			if (lat > maxLat) maxLat = lat;
		});
	}

	if (!isFinite(minLon)) return [-180, -85, 180, 85];
	return [minLon, minLat, maxLon, maxLat];
}

function visitCoords(geometry: GeoJSON.Geometry, fn: (lon: number, lat: number) => void): void {
	switch (geometry.type) {
		case 'Point':
			fn(geometry.coordinates[0], geometry.coordinates[1]);
			break;
		case 'MultiPoint':
		case 'LineString':
			for (const c of geometry.coordinates) fn(c[0], c[1]);
			break;
		case 'MultiLineString':
		case 'Polygon':
			for (const ring of geometry.coordinates)
				for (const c of ring) fn(c[0], c[1]);
			break;
		case 'MultiPolygon':
			for (const poly of geometry.coordinates)
				for (const ring of poly)
					for (const c of ring) fn(c[0], c[1]);
			break;
		case 'GeometryCollection':
			for (const g of geometry.geometries) visitCoords(g, fn);
			break;
	}
}
