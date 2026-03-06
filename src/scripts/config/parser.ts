/**
 * YAML config parser for map initialization.
 * Fetches config from URL, parses YAML, validates structure.
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
} from './types';
import type { ConfigFormat } from '../loaders/types';
import { VALID_DISTANCE_UNITS } from './operations/unit-conversion';

/** Valid explicit format values for datasets */
const VALID_FORMATS: ConfigFormat[] = ['geojson', 'csv', 'geoparquet'];

/** Valid basemap IDs (duplicated here for runtime validation) */
const VALID_BASEMAPS: BasemapId[] = ['carto-dark', 'carto-light', 'carto-voyager', 'esri-satellite'];

/** Unary operations (single input) */
const UNARY_OPERATIONS: UnaryOperationType[] = ['buffer', 'centroid', 'attribute'];

/** Binary operations (multiple inputs) */
const BINARY_OPERATIONS: BinaryOperationType[] = ['intersection', 'union', 'difference', 'contains', 'distance'];

/** All valid operation types */
const ALL_OPERATIONS = [...UNARY_OPERATIONS, ...BINARY_OPERATIONS];

/** Valid MapLibre layer types */
const VALID_LAYER_TYPES: LayerType[] = ['fill', 'line', 'circle', 'symbol', 'heatmap', 'fill-extrusion'];

/** Default config path served from public/ folder */
const DEFAULT_CONFIG_PATH = '/app-config.yaml';

/**
 * Validate a CRS authority:code string (e.g. 'EPSG:27700', 'ESRI:102001').
 * Returns array of error messages (empty if valid).
 */
function validateCrsString(value: unknown, prefix: string): string[] {
	if (typeof value !== 'string' || value.trim() === '') {
		return [`${prefix}: must be a non-empty string`];
	}
	if (!/^[A-Za-z]+:\S+$/.test(value.trim())) {
		return [`${prefix}: must be an authority:code string (e.g. 'EPSG:27700'). Got '${value}'`];
	}
	return [];
}

/**
 * Validate the parsed config object.
 * Checks required fields, types, and valid values.
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

	// Valid sources for layers = datasets ∪ operation outputs
	const validSourceIds = new Set([...datasetIds, ...operationOutputIds]);

	// Validate layers (optional section)
	if ('layers' in obj) {
		errors.push(...validateLayers(obj.layers, validSourceIds));
	}

	return { valid: errors.length === 0, errors };
}

/**
 * Validate a single dataset config entry.
 * Returns array of error messages (empty if valid).
 */
function validateDataset(dataset: unknown, index: number): string[] {
	const errors: string[] = [];
	const prefix = `datasets[${index}]`;

	if (typeof dataset !== 'object' || dataset === null) {
		return [`${prefix}: must be an object`];
	}

	const d = dataset as Record<string, unknown>;

	// Required: id (string)
	if (!('id' in d)) {
		errors.push(`${prefix}: missing required 'id'`);
	} else if (typeof d.id !== 'string' || d.id.trim() === '') {
		errors.push(`${prefix}.id: must be a non-empty string`);
	}

	// Required: url (string, valid URL format)
	if (!('url' in d)) {
		errors.push(`${prefix}: missing required 'url'`);
	} else if (typeof d.url !== 'string') {
		errors.push(`${prefix}.url: must be a string`);
	} else {
		try {
			const parsedUrl = new URL(d.url);
			if (parsedUrl.protocol !== 'https:') {
				errors.push(`${prefix}.url: must use HTTPS protocol`);
			}
		} catch {
			errors.push(`${prefix}.url: invalid URL format`);
		}
	}

	// Optional: name (string)
	if ('name' in d && d.name !== undefined) {
		if (typeof d.name !== 'string') {
			errors.push(`${prefix}.name: must be a string`);
		}
	}

	// Optional: color (hex string)
	if ('color' in d && d.color !== undefined) {
		if (typeof d.color !== 'string') {
			errors.push(`${prefix}.color: must be a string`);
		} else if (!/^#[0-9a-fA-F]{6}$/.test(d.color)) {
			errors.push(`${prefix}.color: must be a valid hex color (e.g., #3388ff)`);
		}
	}

	// Optional: style (object with numeric fields)
	if ('style' in d && d.style !== undefined) {
		if (typeof d.style !== 'object' || d.style === null) {
			errors.push(`${prefix}.style: must be an object`);
		} else {
			const style = d.style as Record<string, unknown>;
			if ('fillOpacity' in style && typeof style.fillOpacity !== 'number') {
				errors.push(`${prefix}.style.fillOpacity: must be a number`);
			} else if ('fillOpacity' in style && (style.fillOpacity as number) < 0 || (style.fillOpacity as number) > 1) {
				errors.push(`${prefix}.style.fillOpacity: must be between 0 and 1`);
			}
			if ('lineWidth' in style && typeof style.lineWidth !== 'number') {
				errors.push(`${prefix}.style.lineWidth: must be a number`);
			}
			if ('pointRadius' in style && typeof style.pointRadius !== 'number') {
				errors.push(`${prefix}.style.pointRadius: must be a number`);
			}
		}
	}

	// Optional: hidden (boolean)
	if ('hidden' in d && d.hidden !== undefined) {
		if (typeof d.hidden !== 'boolean') {
			errors.push(`${prefix}.hidden: must be a boolean`);
		}
	}

	// Optional: fitBounds (boolean, defaults to true)
	if ('fitBounds' in d && d.fitBounds !== undefined) {
		if (typeof d.fitBounds !== 'boolean') {
			errors.push(`${prefix}.fitBounds: must be a boolean`);
		}
	}

	// Optional: format (must be a valid config format)
	if ('format' in d && d.format !== undefined) {
		if (typeof d.format !== 'string') {
			errors.push(`${prefix}.format: must be a string`);
		} else if (!VALID_FORMATS.includes(d.format as ConfigFormat)) {
			errors.push(`${prefix}.format: must be one of: ${VALID_FORMATS.join(', ')}. Got '${d.format}'`);
		}
	}

	// Optional: latColumn (string, only meaningful for csv/geoparquet)
	if ('latColumn' in d && d.latColumn !== undefined) {
		if (typeof d.latColumn !== 'string' || d.latColumn.trim() === '') {
			errors.push(`${prefix}.latColumn: must be a non-empty string`);
		}
	}

	// Optional: lngColumn (string, only meaningful for csv/geoparquet)
	if ('lngColumn' in d && d.lngColumn !== undefined) {
		if (typeof d.lngColumn !== 'string' || d.lngColumn.trim() === '') {
			errors.push(`${prefix}.lngColumn: must be a non-empty string`);
		}
	}

	// Optional: geoColumn (string, combined "lat, lng" column; mutually exclusive with latColumn/lngColumn)
	if ('geoColumn' in d && d.geoColumn !== undefined) {
		if (typeof d.geoColumn !== 'string' || d.geoColumn.trim() === '') {
			errors.push(`${prefix}.geoColumn: must be a non-empty string`);
		}
		if (('latColumn' in d && d.latColumn !== undefined) || ('lngColumn' in d && d.lngColumn !== undefined)) {
			errors.push(`${prefix}: geoColumn is mutually exclusive with latColumn/lngColumn`);
		}
	}

	// Optional: paginate (boolean or { maxPages?: number })
	if ('paginate' in d && d.paginate !== undefined) {
		if (typeof d.paginate === 'boolean') {
			// valid
		} else if (typeof d.paginate === 'object' && d.paginate !== null && !Array.isArray(d.paginate)) {
			const pag = d.paginate as Record<string, unknown>;
			if ('maxPages' in pag && pag.maxPages !== undefined) {
				if (typeof pag.maxPages !== 'number' || !Number.isInteger(pag.maxPages) || pag.maxPages < 1) {
					errors.push(`${prefix}.paginate.maxPages: must be a positive integer`);
				}
			}
		} else {
			errors.push(`${prefix}.paginate: must be a boolean or an object with optional maxPages`);
		}
	}

	// Optional: crs (authority:code string for explicit CRS override)
	if ('crs' in d && d.crs !== undefined) {
		errors.push(...validateCrsString(d.crs, `${prefix}.crs`));
	}

	return errors;
}

/**
 * Validate the datasets array if present.
 */
function validateDatasets(datasets: unknown): string[] {
	const errors: string[] = [];

	if (!Array.isArray(datasets)) {
		return ["'datasets' must be an array"];
	}

	if (datasets.length === 0) {
		return []; // Empty array is valid (no datasets to load)
	}

	// Check for duplicate IDs
	const ids = new Set<string>();
	datasets.forEach((dataset, index) => {
		const d = dataset as Record<string, unknown>;
		if (typeof d?.id === 'string') {
			if (ids.has(d.id)) {
				errors.push(`datasets[${index}].id: duplicate ID '${d.id}'`);
			}
			ids.add(d.id);
		}
	});

	// Validate each dataset
	datasets.forEach((dataset, index) => {
		errors.push(...validateDataset(dataset, index));
	});

	return errors;
}

/**
 * Validate a single operation config entry.
 * Checks structure only - dependency graph validation happens separately.
 */
function validateOperation(op: unknown, index: number): string[] {
	const errors: string[] = [];
	const prefix = `operations[${index}]`;

	if (typeof op !== 'object' || op === null) {
		return [`${prefix}: must be an object`];
	}

	const o = op as Record<string, unknown>;

	// Required: type (must be valid operation type)
	if (!('type' in o)) {
		errors.push(`${prefix}: missing required 'type'`);
	} else if (typeof o.type !== 'string') {
		errors.push(`${prefix}.type: must be a string`);
	} else if (!ALL_OPERATIONS.includes(o.type as typeof ALL_OPERATIONS[number])) {
		errors.push(`${prefix}.type: invalid operation type '${o.type}'. Valid types: ${ALL_OPERATIONS.join(', ')}`);
	}

	// Required: output (non-empty string)
	if (!('output' in o)) {
		errors.push(`${prefix}: missing required 'output'`);
	} else if (typeof o.output !== 'string' || o.output.trim() === '') {
		errors.push(`${prefix}.output: must be a non-empty string`);
	}

	// Validate input/inputs based on operation type
	const opType = o.type as string;
	const isUnary = UNARY_OPERATIONS.includes(opType as UnaryOperationType);
	const isBinary = BINARY_OPERATIONS.includes(opType as BinaryOperationType);

	if (isUnary) {
		// Unary operations require 'input' (single string)
		if (!('input' in o)) {
			errors.push(`${prefix}: unary operation '${opType}' requires 'input' field`);
		} else if (typeof o.input !== 'string' || o.input.trim() === '') {
			errors.push(`${prefix}.input: must be a non-empty string`);
		}
		// Warn if 'inputs' is also present (likely user error)
		if ('inputs' in o) {
			errors.push(`${prefix}: unary operation '${opType}' uses 'input', not 'inputs'`);
		}
	} else if (isBinary) {
		// Binary operations require 'inputs' (array of strings)
		if (!('inputs' in o)) {
			errors.push(`${prefix}: binary operation '${opType}' requires 'inputs' field`);
		} else if (!Array.isArray(o.inputs)) {
			errors.push(`${prefix}.inputs: must be an array`);
		} else if (o.inputs.length < 2) {
			errors.push(`${prefix}.inputs: binary operation requires at least 2 inputs`);
		} else {
			// Validate each input is a non-empty string
			o.inputs.forEach((inp, i) => {
				if (typeof inp !== 'string' || inp.trim() === '') {
					errors.push(`${prefix}.inputs[${i}]: must be a non-empty string`);
				}
			});
		}
		// Warn if 'input' is also present (likely user error)
		if ('input' in o) {
			errors.push(`${prefix}: binary operation '${opType}' uses 'inputs', not 'input'`);
		}
	}

	// Optional: name (string)
	if ('name' in o && o.name !== undefined) {
		if (typeof o.name !== 'string') {
			errors.push(`${prefix}.name: must be a string`);
		}
	}

	// Params: required for some operations, optional for others
	if (opType === 'attribute' && !('params' in o)) {
		errors.push(`${prefix}: attribute operation requires 'params' (structured filter or where clause)`);
	}
	if ('params' in o && o.params !== undefined) {
		if (typeof o.params !== 'object' || o.params === null || Array.isArray(o.params)) {
			errors.push(`${prefix}.params: must be an object`);
		} else {
			// Validate operation-specific params
			const opType = o.type as string;
			if (opType === 'buffer') {
				errors.push(...validateBufferParams(o.params as Record<string, unknown>, prefix));
			} else if (opType === 'distance') {
				errors.push(...validateDistanceParams(o.params as Record<string, unknown>, prefix));
			} else if (opType === 'attribute') {
				errors.push(...validateAttributeParams(o.params as Record<string, unknown>, prefix));
			}
		}
	}

	// Optional: color (hex string, same validation as datasets)
	if ('color' in o && o.color !== undefined) {
		if (typeof o.color !== 'string') {
			errors.push(`${prefix}.color: must be a string`);
		} else if (!/^#[0-9a-fA-F]{6}$/.test(o.color)) {
			errors.push(`${prefix}.color: must be a valid hex color (e.g., #3388ff)`);
		}
	}

	// Optional: style (object with numeric fields, same validation as datasets)
	if ('style' in o && o.style !== undefined) {
		if (typeof o.style !== 'object' || o.style === null) {
			errors.push(`${prefix}.style: must be an object`);
		} else {
			const style = o.style as Record<string, unknown>;
			if ('fillOpacity' in style && typeof style.fillOpacity !== 'number') {
				errors.push(`${prefix}.style.fillOpacity: must be a number`);
			} else if ('fillOpacity' in style && ((style.fillOpacity as number) < 0 || (style.fillOpacity as number) > 1)) {
				errors.push(`${prefix}.style.fillOpacity: must be between 0 and 1`);
			}
			if ('lineWidth' in style && typeof style.lineWidth !== 'number') {
				errors.push(`${prefix}.style.lineWidth: must be a number`);
			}
			if ('pointRadius' in style && typeof style.pointRadius !== 'number') {
				errors.push(`${prefix}.style.pointRadius: must be a number`);
			}
		}
	}

	return errors;
}

/**
 * Validate buffer operation params.
 */
function validateBufferParams(params: Record<string, unknown>, prefix: string): string[] {
	const errors: string[] = [];

	// Required: distance (positive number)
	if (!('distance' in params)) {
		errors.push(`${prefix}.params: buffer operation requires 'distance'`);
	} else if (typeof params.distance !== 'number') {
		errors.push(`${prefix}.params.distance: must be a number`);
	} else if (params.distance <= 0) {
		errors.push(`${prefix}.params.distance: must be a positive number`);
	}

	// Required: units
	if (!('units' in params)) {
		errors.push(`${prefix}.params: buffer operation requires 'units'`);
	} else if (!VALID_DISTANCE_UNITS.includes(params.units as typeof VALID_DISTANCE_UNITS[number])) {
		errors.push(`${prefix}.params.units: must be one of: ${VALID_DISTANCE_UNITS.join(', ')}. Got '${params.units}'`);
	}

	// Optional: dissolve (boolean)
	if ('dissolve' in params && typeof params.dissolve !== 'boolean') {
		errors.push(`${prefix}.params.dissolve: must be a boolean`);
	}

	// Optional: quadSegs (positive integer, segments per quarter-circle)
	if ('quadSegs' in params) {
		if (typeof params.quadSegs !== 'number' || !Number.isInteger(params.quadSegs) || params.quadSegs < 1) {
			errors.push(`${prefix}.params.quadSegs: must be a positive integer`);
		}
	}

	return errors;
}

/**
 * Validate distance operation params.
 */
function validateDistanceParams(params: Record<string, unknown>, prefix: string): string[] {
	const errors: string[] = [];

	// Required: mode
	if (!('mode' in params)) {
		errors.push(`${prefix}.params: distance operation requires 'mode'`);
	} else if (params.mode !== 'filter' && params.mode !== 'annotate') {
		errors.push(`${prefix}.params.mode: must be 'filter' or 'annotate'`);
	}

	// Required: units
	if (!('units' in params)) {
		errors.push(`${prefix}.params: distance operation requires 'units'`);
	} else if (!VALID_DISTANCE_UNITS.includes(params.units as typeof VALID_DISTANCE_UNITS[number])) {
		errors.push(`${prefix}.params.units: must be one of: ${VALID_DISTANCE_UNITS.join(', ')}. Got '${params.units}'`);
	}

	// maxDistance: required and positive for filter mode, optional for annotate
	if (params.mode === 'filter') {
		if (!('maxDistance' in params)) {
			errors.push(`${prefix}.params: distance filter mode requires 'maxDistance'`);
		} else if (typeof params.maxDistance !== 'number') {
			errors.push(`${prefix}.params.maxDistance: must be a number`);
		} else if (params.maxDistance <= 0) {
			errors.push(`${prefix}.params.maxDistance: must be a positive number`);
		}
	} else if ('maxDistance' in params && params.maxDistance !== undefined) {
		if (typeof params.maxDistance !== 'number') {
			errors.push(`${prefix}.params.maxDistance: must be a number`);
		} else if (params.maxDistance <= 0) {
			errors.push(`${prefix}.params.maxDistance: must be a positive number`);
		}
	}

	return errors;
}

/** Valid structured attribute filter operators */
const VALID_ATTRIBUTE_OPERATORS = ['=', '!=', '>', '>=', '<', '<='];

/**
 * Validate attribute operation params.
 * Enforces mutual exclusivity: structured (property/operator/value) OR raw `where`, not both.
 */
function validateAttributeParams(params: Record<string, unknown>, prefix: string): string[] {
	const errors: string[] = [];

	const hasStructured = 'property' in params || 'operator' in params || 'value' in params;
	const hasWhere = 'where' in params;

	if (hasStructured && hasWhere) {
		errors.push(`${prefix}.params: cannot use both structured filter (property/operator/value) and 'where' clause`);
		return errors;
	}

	if (!hasStructured && !hasWhere) {
		errors.push(`${prefix}.params: attribute operation requires either structured filter (property/value) or 'where' clause`);
		return errors;
	}

	if (hasWhere) {
		if (typeof params.where !== 'string' || params.where.trim() === '') {
			errors.push(`${prefix}.params.where: must be a non-empty string`);
		}
	} else {
		// Structured mode validation
		if (!('property' in params)) {
			errors.push(`${prefix}.params: structured filter requires 'property'`);
		} else if (typeof params.property !== 'string' || params.property.trim() === '') {
			errors.push(`${prefix}.params.property: must be a non-empty string`);
		}

		if (!('value' in params) || params.value === undefined) {
			errors.push(`${prefix}.params: structured filter requires 'value'`);
		} else if (typeof params.value !== 'string' && typeof params.value !== 'number') {
			errors.push(`${prefix}.params.value: must be a string or number`);
		}

		if ('operator' in params && params.operator !== undefined) {
			if (!VALID_ATTRIBUTE_OPERATORS.includes(params.operator as string)) {
				errors.push(`${prefix}.params.operator: must be one of: ${VALID_ATTRIBUTE_OPERATORS.join(', ')}. Got '${params.operator}'`);
			}
		}
	}

	return errors;
}

/**
 * Validate the operations array if present.
 * Checks structure and duplicate outputs. Does NOT validate dependency graph.
 */
function validateOperations(operations: unknown, datasetIds: Set<string>): string[] {
	const errors: string[] = [];

	if (!Array.isArray(operations)) {
		return ["'operations' must be an array"];
	}

	if (operations.length === 0) {
		return []; // Empty array is valid (no operations to run)
	}

	// Collect output IDs and check for duplicates / shadowing
	const outputIds = new Set<string>();
	operations.forEach((op, index) => {
		const o = op as Record<string, unknown>;
		if (typeof o?.output === 'string') {
			// Check for duplicate output IDs
			if (outputIds.has(o.output)) {
				errors.push(`operations[${index}].output: duplicate output ID '${o.output}'`);
			}
			// Check if output shadows a dataset ID
			if (datasetIds.has(o.output)) {
				errors.push(`operations[${index}].output: '${o.output}' shadows existing dataset ID`);
			}
			outputIds.add(o.output);
		}
	});

	// Validate each operation
	operations.forEach((op, index) => {
		errors.push(...validateOperation(op, index));
	});

	return errors;
}

/**
 * Validate a single layer config entry.
 * Checks structure only - source reference validation happens in validateLayers.
 */
function validateLayer(layer: unknown, index: number): string[] {
	const errors: string[] = [];
	const prefix = `layers[${index}]`;

	if (typeof layer !== 'object' || layer === null) {
		return [`${prefix}: must be an object`];
	}

	const l = layer as Record<string, unknown>;

	// Required: id (non-empty string)
	if (!('id' in l)) {
		errors.push(`${prefix}: missing required 'id'`);
	} else if (typeof l.id !== 'string' || l.id.trim() === '') {
		errors.push(`${prefix}.id: must be a non-empty string`);
	}

	// Required: source (non-empty string)
	if (!('source' in l)) {
		errors.push(`${prefix}: missing required 'source'`);
	} else if (typeof l.source !== 'string' || l.source.trim() === '') {
		errors.push(`${prefix}.source: must be a non-empty string`);
	}

	// Required: type (valid MapLibre layer type)
	if (!('type' in l)) {
		errors.push(`${prefix}: missing required 'type'`);
	} else if (typeof l.type !== 'string') {
		errors.push(`${prefix}.type: must be a string`);
	} else if (!VALID_LAYER_TYPES.includes(l.type as LayerType)) {
		errors.push(`${prefix}.type: invalid layer type '${l.type}'. Valid types: ${VALID_LAYER_TYPES.join(', ')}`);
	}

	// Optional: minzoom (number 0-24)
	if ('minzoom' in l && l.minzoom !== undefined) {
		if (typeof l.minzoom !== 'number') {
			errors.push(`${prefix}.minzoom: must be a number`);
		} else if (l.minzoom < 0 || l.minzoom > 24) {
			errors.push(`${prefix}.minzoom: must be between 0 and 24`);
		}
	}

	// Optional: maxzoom (number 0-24)
	if ('maxzoom' in l && l.maxzoom !== undefined) {
		if (typeof l.maxzoom !== 'number') {
			errors.push(`${prefix}.maxzoom: must be a number`);
		} else if (l.maxzoom < 0 || l.maxzoom > 24) {
			errors.push(`${prefix}.maxzoom: must be between 0 and 24`);
		}
	}

	// Optional: filter (must be array if present - MapLibre expression)
	if ('filter' in l && l.filter !== undefined) {
		if (!Array.isArray(l.filter)) {
			errors.push(`${prefix}.filter: must be an array (MapLibre filter expression)`);
		}
	}

	// Optional: paint (must be object if present)
	if ('paint' in l && l.paint !== undefined) {
		if (typeof l.paint !== 'object' || l.paint === null || Array.isArray(l.paint)) {
			errors.push(`${prefix}.paint: must be an object`);
		}
	}

	// Optional: layout (must be object if present)
	if ('layout' in l && l.layout !== undefined) {
		if (typeof l.layout !== 'object' || l.layout === null || Array.isArray(l.layout)) {
			errors.push(`${prefix}.layout: must be an object`);
		}
	}

	// Optional: tooltip (string or array of strings - property names to show on hover)
	if ('tooltip' in l && l.tooltip !== undefined) {
		if (typeof l.tooltip === 'string') {
			if (l.tooltip.trim() === '') {
				errors.push(`${prefix}.tooltip: must be a non-empty string`);
			}
		} else if (Array.isArray(l.tooltip)) {
			if (l.tooltip.length === 0) {
				errors.push(`${prefix}.tooltip: array must not be empty`);
			}
			l.tooltip.forEach((field, i) => {
				if (typeof field !== 'string' || field.trim() === '') {
					errors.push(`${prefix}.tooltip[${i}]: must be a non-empty string`);
				}
			});
		} else {
			errors.push(`${prefix}.tooltip: must be a string or array of strings`);
		}
	}

	return errors;
}

/**
 * Validate the layers array if present.
 * Checks structure, duplicate IDs, and source references.
 */
function validateLayers(layers: unknown, validSourceIds: Set<string>): string[] {
	const errors: string[] = [];

	if (!Array.isArray(layers)) {
		return ["'layers' must be an array"];
	}

	if (layers.length === 0) {
		return []; // Empty array is valid (no custom layers)
	}

	// Check for duplicate layer IDs
	const layerIds = new Set<string>();
	layers.forEach((layer, index) => {
		const l = layer as Record<string, unknown>;
		if (typeof l?.id === 'string') {
			if (layerIds.has(l.id)) {
				errors.push(`layers[${index}].id: duplicate layer ID '${l.id}'`);
			}
			layerIds.add(l.id);
		}
	});

	// Validate each layer structure
	layers.forEach((layer, index) => {
		errors.push(...validateLayer(layer, index));
	});

	// Validate source references (only for layers that passed basic validation)
	layers.forEach((layer, index) => {
		const l = layer as Record<string, unknown>;
		if (typeof l?.source === 'string' && l.source.trim() !== '') {
			if (!validSourceIds.has(l.source)) {
				errors.push(`layers[${index}].source: '${l.source}' does not reference a valid dataset or operation output`);
			}
		}
	});

	return errors;
}

/**
 * Fetch and parse YAML config from URL.
 * @param configPath - Path to config file (defaults to /app-config.yaml)
 * @returns Parsed and validated MapConfig
 * @throws Error if fetch fails, YAML is invalid, or validation fails
 */
export async function loadConfig(configPath: string = DEFAULT_CONFIG_PATH): Promise<MapConfig> {
	// Fetch the config file
	const response = await fetch(configPath);
	if (!response.ok) {
		throw new Error(`Failed to load config from ${configPath}: ${response.status} ${response.statusText}`);
	}

	const yamlText = await response.text();

	// Parse YAML
	let parsed: unknown;
	try {
		parsed = yaml.load(yamlText);
	} catch (e) {
		const message = e instanceof Error ? e.message : 'Unknown error';
		throw new Error(`Failed to parse YAML: ${message}`);
	}

	// Validate structure
	const validation = validateConfig(parsed);
	if (!validation.valid) {
		throw new Error(`Invalid config:\n  - ${validation.errors.join('\n  - ')}`);
	}

	// Type assertion is safe after validation
	return parsed as MapConfig;
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
