/**
 * YAML config parser for map initialization.
 * Fetches config from URL, parses YAML, validates structure.
 *
 * Validation logic is split into domain-specific modules under validators/.
 * This file owns the constants, orchestrates validation, and exports the public API.
 */

import yaml from 'js-yaml';
import type {
	MapConfig,
	MapSettings,
	BasemapId,
	ValidationResult,
	UnaryOperationType,
	BinaryOperationType,
	LayerType,
	OutputFormat,
} from './types';
import type { ConfigFormat } from '../loaders/types';
import { validateCrsString } from './validators/shared';
import { validateDatasets } from './validators/datasets';
import { validateOperations } from './validators/operations';
import { validateLayers } from './validators/layers';
import { validateOutputs } from './validators/outputs';

// --- Constants (exported for use by validators) ---

/** Valid explicit format values for datasets */
export const VALID_FORMATS: ConfigFormat[] = ['geojson', 'csv', 'geoparquet', 'pmtiles'];

/** Valid basemap IDs (duplicated here for runtime validation) */
export const VALID_BASEMAPS: BasemapId[] = ['carto-dark', 'carto-light', 'carto-voyager', 'esri-satellite'];

/** Unary operations (single input) */
export const UNARY_OPERATIONS: UnaryOperationType[] = ['buffer', 'centroid', 'attribute'];

/** Binary operations (multiple inputs) */
export const BINARY_OPERATIONS: BinaryOperationType[] = ['intersection', 'union', 'difference', 'contains', 'distance'];

/** All valid operation types */
export const ALL_OPERATIONS = [...UNARY_OPERATIONS, ...BINARY_OPERATIONS];

/** Valid MapLibre layer types */
export const VALID_LAYER_TYPES: LayerType[] = ['fill', 'line', 'circle', 'symbol', 'heatmap', 'fill-extrusion'];

/** Valid output format values */
export const VALID_OUTPUT_FORMATS: OutputFormat[] = ['geojson', 'csv', 'parquet', 'pmtiles'];

/** Default config path served from public/ folder */
const DEFAULT_CONFIG_PATH = '/app-config.yaml';

// --- Validation orchestrator ---

/**
 * Validate the parsed config object.
 * Checks required fields, types, and valid values.
 * Delegates domain-specific validation to validators/.
 */
function validateConfig(config: unknown): ValidationResult {
	const errors: string[] = [];

	// Check root structure
	if (typeof config !== 'object' || config === null) {
		return { valid: false, errors: ['Config must be an object'] };
	}

	const obj = config as Record<string, unknown>;

	// Check map section exists
	if (!('map' in obj)) {
		errors.push("Missing required 'map' section");
		return { valid: false, errors };
	}

	const mapSection = obj.map as Record<string, unknown>;

	// Validate center
	if (!('center' in mapSection)) {
		errors.push("Missing required 'map.center'");
	} else if (!Array.isArray(mapSection.center) || mapSection.center.length !== 2) {
		errors.push("'map.center' must be an array of [longitude, latitude]");
	} else {
		const [lng, lat] = mapSection.center as [unknown, unknown];
		if (typeof lng !== 'number' || typeof lat !== 'number') {
			errors.push("'map.center' values must be numbers");
		} else if (lng < -180 || lng > 180) {
			errors.push(`'map.center' longitude must be between -180 and 180, got ${lng}`);
		} else if (lat < -90 || lat > 90) {
			errors.push(`'map.center' latitude must be between -90 and 90, got ${lat}`);
		}
	}

	// Validate zoom
	if (!('zoom' in mapSection)) {
		errors.push("Missing required 'map.zoom'");
	} else if (typeof mapSection.zoom !== 'number') {
		errors.push("'map.zoom' must be a number");
	} else if (mapSection.zoom < 0 || mapSection.zoom > 22) {
		errors.push(`'map.zoom' must be between 0 and 22, got ${mapSection.zoom}`);
	}

	// Validate basemap
	if (!('basemap' in mapSection)) {
		errors.push("Missing required 'map.basemap'");
	} else if (typeof mapSection.basemap !== 'string') {
		errors.push("'map.basemap' must be a string");
	} else if (!VALID_BASEMAPS.includes(mapSection.basemap as BasemapId)) {
		errors.push(
			`'map.basemap' must be one of: ${VALID_BASEMAPS.join(', ')}. Got '${mapSection.basemap}'`
		);
	}

	// Optional: crs (authority:code string for fallback CRS)
	if ('crs' in mapSection && mapSection.crs !== undefined) {
		errors.push(...validateCrsString(mapSection.crs, "'map.crs'"));
	}

	// Validate datasets (optional section)
	if ('datasets' in obj) {
		errors.push(...validateDatasets(obj.datasets));
	}

	// Collect dataset IDs for operation validation (needed to check for shadowing)
	const datasetIds = new Set<string>();
	if (Array.isArray(obj.datasets)) {
		obj.datasets.forEach((d) => {
			const dataset = d as Record<string, unknown>;
			if (typeof dataset?.id === 'string') {
				datasetIds.add(dataset.id);
			}
		});
	}

	// Validate operations (optional section)
	if ('operations' in obj) {
		errors.push(...validateOperations(obj.operations, datasetIds));
	}

	// Collect operation output IDs for layer source validation
	const operationOutputIds = new Set<string>();
	if (Array.isArray(obj.operations)) {
		obj.operations.forEach((op) => {
			const operation = op as Record<string, unknown>;
			if (typeof operation?.output === 'string') {
				operationOutputIds.add(operation.output);
			}
		});
	}

	// Valid sources for layers = datasets + operation outputs
	const validSourceIds = new Set([...datasetIds, ...operationOutputIds]);

	// Validate layers (optional section)
	if ('layers' in obj) {
		errors.push(...validateLayers(obj.layers, validSourceIds));
	}

	// Collect PMTiles dataset IDs for output validation (PMTiles sources rejected)
	const pmtilesDatasetIds = new Set<string>();
	if (Array.isArray(obj.datasets)) {
		obj.datasets.forEach((d) => {
			const dataset = d as Record<string, unknown>;
			if (typeof dataset?.id === 'string') {
				if (dataset.format === 'pmtiles' ||
					(typeof dataset.url === 'string' && dataset.url.endsWith('.pmtiles'))) {
					pmtilesDatasetIds.add(dataset.id);
				}
			}
		});
	}

	// Validate outputs (optional section)
	if ('outputs' in obj) {
		errors.push(...validateOutputs(obj.outputs, validSourceIds, pmtilesDatasetIds));
	}

	return { valid: errors.length === 0, errors };
}

// --- Public API ---

/**
 * Parse and validate a YAML config string.
 * Pure function with no I/O - usable from any environment (browser, Node.js CLI).
 * @param yamlText - Raw YAML string
 * @returns Parsed and validated MapConfig
 * @throws Error if YAML is invalid or validation fails
 */
export function parseConfig(yamlText: string): MapConfig {
	let parsed: unknown;
	try {
		parsed = yaml.load(yamlText);
	} catch (e) {
		const message = e instanceof Error ? e.message : 'Unknown error';
		throw new Error(`Failed to parse YAML: ${message}`);
	}

	const validation = validateConfig(parsed);
	if (!validation.valid) {
		throw new Error(`Invalid config:\n  - ${validation.errors.join('\n  - ')}`);
	}

	return parsed as MapConfig;
}

/**
 * Fetch and parse YAML config from URL.
 * Browser convenience wrapper around parseConfig.
 * @param configPath - Path to config file (defaults to /app-config.yaml)
 * @returns Parsed and validated MapConfig
 * @throws Error if fetch fails, YAML is invalid, or validation fails
 */
export async function loadConfig(configPath: string = DEFAULT_CONFIG_PATH): Promise<MapConfig> {
	const response = await fetch(configPath);
	if (!response.ok) {
		throw new Error(`Failed to load config from ${configPath}: ${response.status} ${response.statusText}`);
	}

	const yamlText = await response.text();
	return parseConfig(yamlText);
}

/**
 * Get default map settings (used as fallback if config fails to load).
 * Matches current hardcoded values in map.ts.
 */
export function getDefaultMapSettings(): MapSettings {
	return {
		center: [-123.1207, 49.2827],
		zoom: 13,
		basemap: 'carto-dark'
	};
}
