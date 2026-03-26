import { describe, it, expect } from 'vitest';
import { writeVarint, serializeDirectory, buildHeaderBytes } from './pmtiles-writer';
import { readVarint, bytesToHeader, zxyToTileId, Compression, TileType } from 'pmtiles';
import type { Entry, Header } from 'pmtiles';

describe('writeVarint', () => {
	it('encodes 0', () => {
		expect(writeVarint(0)).toEqual(new Uint8Array([0]));
	});

	it('encodes single-byte values (1-127)', () => {
		expect(writeVarint(1)).toEqual(new Uint8Array([1]));
		expect(writeVarint(127)).toEqual(new Uint8Array([127]));
	});

	it('encodes two-byte value (128)', () => {
		const buf = writeVarint(128);
		expect(buf.length).toBe(2);
		const p = { buf, pos: 0 };
		expect(readVarint(p)).toBe(128);
	});

	it('encodes multi-byte values', () => {
		for (const val of [300, 16384, 1_000_000, 10_000_000]) {
			const buf = writeVarint(val);
			const p = { buf, pos: 0 };
			expect(readVarint(p)).toBe(val);
		}
	});
});

describe('serializeDirectory', () => {
	it('round-trips a single entry', () => {
		const entries: Entry[] = [
			{ tileId: 0, offset: 500, length: 100, runLength: 1 },
		];

		const buf = serializeDirectory(entries);
		const p = { buf, pos: 0 };

		const numEntries = readVarint(p);
		expect(numEntries).toBe(1);

		// tileId
		expect(readVarint(p)).toBe(0);
		// runLength
		expect(readVarint(p)).toBe(1);
		// length
		expect(readVarint(p)).toBe(100);
		// offset (first entry: offset+1)
		expect(readVarint(p)).toBe(501);
	});

	it('round-trips multiple contiguous entries', () => {
		const entries: Entry[] = [
			{ tileId: 0, offset: 0, length: 100, runLength: 1 },
			{ tileId: 1, offset: 100, length: 200, runLength: 1 },
			{ tileId: 4, offset: 300, length: 150, runLength: 1 },
		];

		const buf = serializeDirectory(entries);
		const p = { buf, pos: 0 };

		const n = readVarint(p);
		expect(n).toBe(3);

		// Decode tileId deltas
		const tileIds: number[] = [];
		let lastId = 0;
		for (let i = 0; i < n; i++) {
			lastId += readVarint(p);
			tileIds.push(lastId);
		}
		expect(tileIds).toEqual([0, 1, 4]);

		// runLengths
		for (let i = 0; i < n; i++) expect(readVarint(p)).toBe(1);

		// lengths
		const lengths: number[] = [];
		for (let i = 0; i < n; i++) lengths.push(readVarint(p));
		expect(lengths).toEqual([100, 200, 150]);

		// offsets
		const offsets: number[] = [];
		let prevOff = 0, prevLen = 0;
		for (let i = 0; i < n; i++) {
			const raw = readVarint(p);
			if (raw === 0 && i > 0) {
				offsets.push(prevOff + prevLen);
			} else {
				offsets.push(raw - 1);
			}
			prevOff = offsets[i];
			prevLen = lengths[i];
		}
		expect(offsets).toEqual([0, 100, 300]);
	});

	it('round-trips non-contiguous entries', () => {
		const entries: Entry[] = [
			{ tileId: 0, offset: 0, length: 100, runLength: 1 },
			{ tileId: 5, offset: 500, length: 200, runLength: 1 }, // gap at offset
		];

		const buf = serializeDirectory(entries);
		const p = { buf, pos: 0 };

		const n = readVarint(p);
		// skip tileIds
		let lastId = 0;
		for (let i = 0; i < n; i++) lastId += readVarint(p);
		// skip runLengths
		for (let i = 0; i < n; i++) readVarint(p);
		// lengths
		const lengths = [readVarint(p), readVarint(p)];
		// offsets
		const off0 = readVarint(p) - 1; // first entry: raw - 1
		const rawOff1 = readVarint(p);
		const off1 = rawOff1 - 1; // non-contiguous: raw - 1

		expect(off0).toBe(0);
		expect(off1).toBe(500);
		expect(lengths).toEqual([100, 200]);
	});
});

describe('buildHeaderBytes', () => {
	it('round-trips through bytesToHeader', () => {
		const header: Header = {
			specVersion: 3,
			rootDirectoryOffset: 127,
			rootDirectoryLength: 500,
			jsonMetadataOffset: 627,
			jsonMetadataLength: 200,
			leafDirectoryOffset: 0,
			leafDirectoryLength: 0,
			tileDataOffset: 827,
			tileDataLength: 50000,
			numAddressedTiles: 100,
			numTileEntries: 100,
			numTileContents: 100,
			clustered: true,
			internalCompression: Compression.Gzip,
			tileCompression: Compression.Gzip,
			tileType: TileType.Mvt,
			minZoom: 0,
			maxZoom: 14,
			minLon: -123.1207,
			minLat: 49.2827,
			maxLon: -123.0,
			maxLat: 49.3,
			centerZoom: 10,
			centerLon: -123.06035,
			centerLat: 49.29135,
		};

		const bytes = buildHeaderBytes(header);
		expect(bytes.length).toBe(127);

		const parsed = bytesToHeader(bytes.buffer as ArrayBuffer);
		expect(parsed.specVersion).toBe(3);
		expect(parsed.rootDirectoryOffset).toBe(127);
		expect(parsed.rootDirectoryLength).toBe(500);
		expect(parsed.jsonMetadataOffset).toBe(627);
		expect(parsed.jsonMetadataLength).toBe(200);
		expect(parsed.tileDataOffset).toBe(827);
		expect(parsed.tileDataLength).toBe(50000);
		expect(parsed.numAddressedTiles).toBe(100);
		expect(parsed.numTileEntries).toBe(100);
		expect(parsed.numTileContents).toBe(100);
		expect(parsed.clustered).toBe(true);
		expect(parsed.internalCompression).toBe(Compression.Gzip);
		expect(parsed.tileCompression).toBe(Compression.Gzip);
		expect(parsed.tileType).toBe(TileType.Mvt);
		expect(parsed.minZoom).toBe(0);
		expect(parsed.maxZoom).toBe(14);
		expect(parsed.centerZoom).toBe(10);

		// Bounds have int32*1e7 precision (7 decimal places)
		expect(parsed.minLon).toBeCloseTo(-123.1207, 4);
		expect(parsed.minLat).toBeCloseTo(49.2827, 4);
		expect(parsed.maxLon).toBeCloseTo(-123.0, 4);
		expect(parsed.maxLat).toBeCloseTo(49.3, 4);
		expect(parsed.centerLon).toBeCloseTo(-123.06035, 4);
		expect(parsed.centerLat).toBeCloseTo(49.29135, 4);
	});
});
