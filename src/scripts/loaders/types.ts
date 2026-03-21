/**
 * Format loader types.
 * Defines the loader interface and format detection types used by the loader registry.
 */

/** Supported data formats for loading */
export type DetectedFormat = 'geojson' | 'csv' | 'geoparquet' | 'json-array' | 'pmtiles';

/** Formats that can be explicitly set in config (json-array is auto-detected only) */
export type ConfigFormat = 'geojson' | 'csv' | 'geoparquet' | 'pmtiles';

/** Options passed to individual loaders */
export interface LoaderOptions {
	/** Override for latitude column name (CSV and JSON array formats) */
	latColumn?: string;
	/** Override for longitude column name (CSV and JSON array formats) */
	lngColumn?: string;
	/** Combined coordinate column name containing "lat, lng" values (mutually exclusive with latColumn/lngColumn) */
	geoColumn?: string;
	/** Explicit CRS override from config (e.g. 'EPSG:27700'). Overrides file-detected CRS. */
	crs?: string;
}

/** Result returned by a format loader */
export interface LoaderResult {
	/** Parsed GeoJSON FeatureCollection */
	data: GeoJSON.FeatureCollection;
	/** CRS detected from file metadata (e.g. 'EPSG:27700'). Undefined when no metadata found. */
	detectedCrs?: string;
	/** When true, the loader already reprojected to WGS84 - skip downstream ST_Transform. */
	crsHandled?: boolean;
}

/** Raw data types accepted by loaders (replaces browser Response for portability) */
export type LoaderData = string | object | ArrayBuffer;

/**
 * Interface that all format loaders implement.
 * Each loader receives pre-unwrapped data and returns a GeoJSON FeatureCollection.
 * Callers (data-actions) handle Response/File unwrapping before calling loaders.
 */
export interface FormatLoader {
	/** Load pre-unwrapped data and return a GeoJSON FeatureCollection */
	load(data: LoaderData, options?: LoaderOptions): Promise<LoaderResult>;
}
