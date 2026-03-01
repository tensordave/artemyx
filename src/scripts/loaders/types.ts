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
}

/** Result returned by a format loader */
export interface LoaderResult {
	/** Parsed GeoJSON FeatureCollection */
	data: GeoJSON.FeatureCollection;
}

/**
 * Interface that all format loaders implement.
 * Each loader receives a fetch Response and returns a GeoJSON FeatureCollection.
 */
export interface FormatLoader {
	/** Load data from a fetch Response and return a GeoJSON FeatureCollection */
	load(response: Response, options?: LoaderOptions): Promise<LoaderResult>;
}
