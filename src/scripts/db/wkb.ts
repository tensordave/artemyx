/**
 * Lightweight WKB (Well-Known Binary) coordinate extractor.
 * Parses DuckDB ST_AsWKB() output into flat coordinate arrays
 * suitable for building deck.gl BinaryFeatureCollection.
 *
 * Handles: Point, LineString, Polygon, MultiPoint, MultiLineString, MultiPolygon.
 * Multi* types are flattened into multiple singular geometry entries.
 */

export type GeometryType = 'Point' | 'LineString' | 'Polygon';

export interface ParsedGeometry {
	type: GeometryType;
	/** Flat coordinate array: [x, y, x, y, ...] */
	flatCoords: number[];
	/** Ring start offsets for Polygon (e.g., [0, 10, 16] for outer ring of 10 coords + hole of 6) */
	ringOffsets?: number[];
}

// WKB geometry type constants
const WKB_POINT = 1;
const WKB_LINESTRING = 2;
const WKB_POLYGON = 3;
const WKB_MULTIPOINT = 4;
const WKB_MULTILINESTRING = 5;
const WKB_MULTIPOLYGON = 6;

/**
 * Parse a WKB buffer into one or more ParsedGeometry entries.
 * Multi* geometries are flattened: each sub-geometry becomes a separate entry.
 */
export function parseWKB(wkb: Uint8Array): ParsedGeometry[] {
	const view = new DataView(wkb.buffer, wkb.byteOffset, wkb.byteLength);
	return parseGeometry(view, 0).geometries;
}

interface ParseResult {
	geometries: ParsedGeometry[];
	bytesRead: number;
}

function parseGeometry(view: DataView, offset: number): ParseResult {
	const littleEndian = view.getUint8(offset) === 1;
	const wkbType = view.getUint32(offset + 1, littleEndian);
	offset += 5;

	switch (wkbType) {
		case WKB_POINT:
			return parsePoint(view, offset, littleEndian);
		case WKB_LINESTRING:
			return parseLineString(view, offset, littleEndian);
		case WKB_POLYGON:
			return parsePolygon(view, offset, littleEndian);
		case WKB_MULTIPOINT:
			return parseMulti(view, offset, littleEndian, 'Point');
		case WKB_MULTILINESTRING:
			return parseMulti(view, offset, littleEndian, 'LineString');
		case WKB_MULTIPOLYGON:
			return parseMulti(view, offset, littleEndian, 'Polygon');
		default:
			throw new Error(`Unsupported WKB geometry type: ${wkbType}`);
	}
}

function parsePoint(view: DataView, offset: number, le: boolean): ParseResult {
	const x = view.getFloat64(offset, le);
	const y = view.getFloat64(offset + 8, le);
	return {
		geometries: [{ type: 'Point', flatCoords: [x, y] }],
		bytesRead: 5 + 16
	};
}

function parseLineString(view: DataView, offset: number, le: boolean): ParseResult {
	const numPoints = view.getUint32(offset, le);
	offset += 4;
	const flatCoords = readCoords(view, offset, numPoints, le);
	return {
		geometries: [{ type: 'LineString', flatCoords }],
		bytesRead: 5 + 4 + numPoints * 16
	};
}

function parsePolygon(view: DataView, offset: number, le: boolean): ParseResult {
	const numRings = view.getUint32(offset, le);
	offset += 4;
	const flatCoords: number[] = [];
	const ringOffsets: number[] = [0];
	let totalCoords = 0;

	for (let r = 0; r < numRings; r++) {
		const numPoints = view.getUint32(offset, le);
		offset += 4;
		const coords = readCoords(view, offset, numPoints, le);
		flatCoords.push(...coords);
		totalCoords += numPoints;
		ringOffsets.push(totalCoords);
		offset += numPoints * 16;
	}

	// Calculate total bytes: 5 (header) + 4 (numRings) + numRings * 4 (ring counts) + totalCoords * 16
	const bytesRead = 5 + 4 + numRings * 4 + totalCoords * 16;
	return {
		geometries: [{ type: 'Polygon', flatCoords, ringOffsets }],
		bytesRead
	};
}

function parseMulti(view: DataView, offset: number, le: boolean, _subType: GeometryType): ParseResult {
	const numGeoms = view.getUint32(offset, le);
	offset += 4;
	const geometries: ParsedGeometry[] = [];
	let totalBytes = 5 + 4; // header + numGeoms

	for (let i = 0; i < numGeoms; i++) {
		const sub = parseGeometry(view, offset);
		geometries.push(...sub.geometries);
		offset += sub.bytesRead;
		totalBytes += sub.bytesRead;
	}

	return { geometries, bytesRead: totalBytes };
}

/** Read numPoints 2D coordinates into a flat number array. */
function readCoords(view: DataView, offset: number, numPoints: number, le: boolean): number[] {
	const coords: number[] = new Array(numPoints * 2);
	for (let i = 0; i < numPoints; i++) {
		coords[i * 2] = view.getFloat64(offset + i * 16, le);
		coords[i * 2 + 1] = view.getFloat64(offset + i * 16 + 8, le);
	}
	return coords;
}
