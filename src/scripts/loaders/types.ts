/**
 * Format loader types.
 * Defines the loader interface and format detection types used by the loader registry.
 */

/** Supported data formats for loading */
export type DetectedFormat = 'geojson' | 'csv' | 'geoparquet' | 'json-array';

/** Formats that can be explicitly set in config (json-array is auto-detected only) */
export type ConfigFormat = 'geojson' | 'csv' | 'geoparquet';

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

/**
 * Interface that all format loaders implement.
 * Each loader receives a fetch Response and returns a GeoJSON FeatureCollection.
 */
export interface FormatLoader {
	/** Load data from a fetch Response and return a GeoJSON FeatureCollection */
	load(response: Response, options?: LoaderOptions): Promise<LoaderResult>;
}
