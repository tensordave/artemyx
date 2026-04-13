/**
 * Configuration types for YAML-based map initialization.
 * Phase 1: Map settings (center, zoom, basemap)
 * Phase 2: Dataset loading from config
 * Phase 3: Operations framework (parsing, dependency graph, execution order)
 */

/** Valid basemap identifiers (must match IDs in basemaps.ts) */
export type BasemapId = 'carto-dark' | 'carto-light' | 'carto-voyager' | 'esri-satellite';

/** Map view settings */
export interface MapSettings {
	/** Center coordinates as [longitude, latitude] */
	center: [number, number];
	/** Initial zoom level (0-22) */
	zoom: number;
	/** Basemap identifier */
	basemap: BasemapId;
	/** Fallback CRS for datasets without file-level metadata (CSV, JSON array). Defaults to EPSG:4326. */
	crs?: string;
}

/** Partial style configuration for dataset rendering (all fields optional) */
export interface StyleConfigPartial {
	/** Fill opacity for polygons (0-1) */
	fillOpacity?: number;
	/** Line/edge opacity (0-1) */
	lineOpacity?: number;
	/** Point opacity (0-1) */
	pointOpacity?: number;
	/** Line width in pixels */
	lineWidth?: number;
	/** Point radius in pixels */
	pointRadius?: number;
	/** Property name to use for labels (null = no labels) */
	labelField?: string | null;
	/** Label font size in pixels */
	labelSize?: number;
	/** Label text color */
	labelColor?: string;
	/** Label halo/outline color */
	labelHaloColor?: string;
	/** Label halo width in pixels */
	labelHaloWidth?: number;
	/** Minimum zoom level where labels are visible (0-24) */
	labelMinzoom?: number;
	/** Maximum zoom level where labels are visible (0-24) */
	labelMaxzoom?: number;
	/** Minimum zoom level where dataset geometry layers are visible (0-24) */
	minzoom?: number;
	/** Maximum zoom level where dataset geometry layers are visible (0-24) */
	maxzoom?: number;
}

/** Dataset configuration for loading GeoJSON from URL */
export interface DatasetConfig {
	/** User-defined identifier (used for operations/layers reference) */
	id: string;
	/** GeoJSON URL (HTTPS required) */
	url: string;
	/** Display name (defaults to id if not provided) */
	name?: string;
	/** Hex color for rendering (defaults to #3388ff) */
	color?: string;
	/** Style overrides */
	style?: StyleConfigPartial;
	/** When true, dataset is loaded into DuckDB but not rendered or shown in layer panel (source-only for operations) */
	hidden?: boolean;
	/** When false, dataset layers start with visibility off (defaults to true) */
	visible?: boolean;
	/** When false, this dataset's geometry is excluded from the initial fitBounds calculation (default: true) */
	fitBounds?: boolean;
	/** Explicit format override when URL or Content-Type is ambiguous */
	format?: ConfigFormat;
	/** Latitude column name override for CSV and JSON array formats */
	latColumn?: string;
	/** Longitude column name override for CSV and JSON array formats */
	lngColumn?: string;
	/** Combined coordinate column containing "lat, lng" values (mutually exclusive with latColumn/lngColumn) */
	geoColumn?: string;
	/**
	 * Pagination control for APIs that limit response size.
	 * - true: force pagination detection
	 * - false: disable pagination (single fetch only)
	 * - { maxPages: N }: cap the number of pages fetched
	 * - omitted: auto-detect from response (default)
	 */
	paginate?: boolean | { maxPages?: number };
	/** Explicit source CRS override (e.g. 'EPSG:3005'). Takes priority over file-detected CRS and map.crs. */
	crs?: string;
	/** Original filename for file-uploaded datasets (preserved through YAML round-trips since comments are stripped) */
	sourceFile?: string;
	/** Vector tile layer name within a PMTiles archive. Required for multi-layer archives, auto-detected for single-layer. */
	sourceLayer?: string;
}

import type { ConfigFormat } from '../loaders/types';
import type { DistanceUnit } from './operations/unit-conversion';

/**
 * Supported spatial operation types.
 * Unary operations take a single input, binary operations take multiple inputs.
 */
export type UnaryOperationType = 'buffer' | 'centroid' | 'attribute';
export type BinaryOperationType = 'intersection' | 'union' | 'difference' | 'contains' | 'distance' | 'join';
export type OperationType = UnaryOperationType | BinaryOperationType;

/** Buffer operation parameters */
export interface BufferParams {
	/** Buffer distance (positive number) */
	distance: number;
	/** Distance units */
	units: DistanceUnit;
	/** Whether to dissolve overlapping buffers into single polygon */
	dissolve?: boolean;
	/** Segments per quarter-circle for buffer curves (default: 32). Higher = smoother circles. */
	quadSegs?: number;
}

/** Intersection operation parameters */
export interface IntersectionParams {
	/**
	 * Intersection mode:
	 * - 'filter': Keep features from first input that intersect with second input (boolean test)
	 * - 'clip': Compute actual geometric intersection (output geometry is the overlap)
	 */
	mode: 'filter' | 'clip';
}

/** Union operation parameters */
export interface UnionParams {
	/**
	 * Union mode:
	 * - 'merge': Combine features from all inputs into one dataset (SQL UNION ALL, no geometry modification)
	 * - 'dissolve': Merge all geometries into a single unified polygon (ST_Union_Agg)
	 */
	mode: 'merge' | 'dissolve';
	/**
	 * Simplification tolerance in degrees for dissolve mode.
	 * Applied via ST_Simplify before ST_Union_Agg to prevent TopologyException
	 * from near-coincident vertices. Ignored in merge mode.
	 * Default: 1e-7 (~1cm at mid-latitudes)
	 */
	tolerance?: number;
}

/** Difference operation parameters */
export interface DifferenceParams {
	/**
	 * Difference mode:
	 * - 'subtract': Geometric subtraction — removes the area of B from each feature in A (ST_Difference)
	 * - 'exclude': Boolean exclusion — keeps features from A that do NOT intersect any feature in B
	 */
	mode: 'subtract' | 'exclude';
}

/** Contains operation parameters */
export interface ContainsParams {
	/**
	 * Contains mode:
	 * - 'filter': Keep features from first input (A) that fully contain at least one feature from second input (B)
	 *             Uses ST_Contains(A, B) — stricter than ST_Intersects (complete containment, not just overlap)
	 * - 'within': Keep features from second input (B) that are fully inside at least one feature from first input (A)
	 *             Same predicate (ST_Contains(A, B)) but returns B features instead of A
	 *
	 * Note: ST_Contains uses GEOS semantics — a point exactly on the polygon boundary is NOT considered contained.
	 */
	mode: 'filter' | 'within';
}

/** Distance operation parameters */
export interface DistanceParams {
	/**
	 * Distance mode:
	 * - 'filter': Keep features from inputs[0] that are within maxDistance of any feature in inputs[1] (ST_DWithin)
	 * - 'annotate': Enrich features from inputs[0] with a `dist_m` property — distance to nearest feature in inputs[1]
	 *
	 * Input ordering matters: inputs[0] is always the primary dataset (filtered or enriched),
	 * inputs[1] is the proximity target.
	 */
	mode: 'filter' | 'annotate';
	/** Maximum distance threshold. Required for filter mode. Optional for annotate (omit to annotate all). */
	maxDistance?: number;
	/** Distance units */
	units: DistanceUnit;
}

/** Valid comparison operators for structured attribute filters */
export type AttributeOperator = '=' | '!=' | '>' | '>=' | '<' | '<=';

/** Attribute operation parameters */
export interface AttributeParams {
	/**
	 * Structured filter — property name to filter on.
	 * Mutually exclusive with `where`.
	 */
	property?: string;
	/** Comparison operator (defaults to '=' if omitted with property/value) */
	operator?: AttributeOperator;
	/** Value to compare against (string or number; type determines SQL casting) */
	value?: string | number;
	/**
	 * Raw DuckDB SQL WHERE clause for advanced filtering.
	 * Interpolated directly into the query — config YAML is trusted input.
	 * Mutually exclusive with property/operator/value.
	 *
	 * Example: "json_extract_string(properties, '$.streetuse') IN ('Arterial', 'Collector')"
	 */
	where?: string;
}

/** Join operation parameters */
export interface JoinParams {
	/** Property key in the source (tabular) dataset to join on */
	sourceKey: string;
	/** Property key in the target (spatial) dataset to join on */
	targetKey: string;
	/**
	 * Join mode:
	 * - 'left': Keep all target features, merging source properties where keys match (default)
	 * - 'inner': Keep only target features that have a matching source row
	 */
	mode?: 'inner' | 'left';
}

/** Base fields common to all operations */
interface OperationBase {
	/** Output dataset ID (must be unique, cannot shadow existing dataset IDs) */
	output: string;
	/** Display name for the operation output (defaults to output ID if not provided) */
	name?: string;
	/** Operation-specific parameters (validated in Phase 4 during execution) */
	params?: Record<string, unknown>;
	/** Hex color for output dataset rendering (defaults to #3388ff) */
	color?: string;
	/** Style overrides for output dataset */
	style?: StyleConfigPartial;
}

/** Operations that take a single input dataset (e.g., buffer, centroid) */
export interface UnaryOperation extends OperationBase {
	type: UnaryOperationType;
	/** Input dataset ID (must reference a dataset or previous operation output) */
	input: string;
}

/** Operations that take multiple input datasets (e.g., intersection, union) */
export interface BinaryOperation extends OperationBase {
	type: BinaryOperationType;
	/** Input dataset IDs (must reference datasets or previous operation outputs) */
	inputs: string[];
}

/** Union type for all operation configs */
export type OperationConfig = UnaryOperation | BinaryOperation;

/**
 * Type guard to check if an operation is unary (has single `input`).
 * Use this to narrow OperationConfig to UnaryOperation.
 */
export function isUnaryOperation(op: OperationConfig): op is UnaryOperation {
	return 'input' in op;
}

/**
 * Type guard to check if an operation is binary (has `inputs` array).
 * Use this to narrow OperationConfig to BinaryOperation.
 */
export function isBinaryOperation(op: OperationConfig): op is BinaryOperation {
	return 'inputs' in op;
}

/**
 * Helper to get all input IDs from an operation (works for both unary and binary).
 */
export function getOperationInputs(op: OperationConfig): string[] {
	return isUnaryOperation(op) ? [op.input] : op.inputs;
}

/**
 * Supported MapLibre layer types for rendering.
 * These map directly to MapLibre GL JS layer types.
 */
export type LayerType =
	| 'fill' // Polygon fills
	| 'line' // LineStrings and polygon outlines
	| 'circle' // Point markers
	| 'symbol' // Icons and text labels
	| 'heatmap' // Density visualization
	| 'fill-extrusion'; // 3D buildings

/**
 * Rendering engine for a layer.
 * - 'maplibre': Default. Rendered via MapLibre GL JS.
 * - 'deckgl': Rendered via deck.gl MapboxOverlay.
 */
export type RendererType = 'maplibre' | 'deckgl';

/**
 * Layer configuration for explicit rendering control.
 * Decouples data sources (datasets/operations) from visual representation.
 *
 * When `layers` is defined in config, these replace the auto-generated
 * fill/line/circle layers. When omitted, default layers are created
 * automatically for backwards compatibility (see Phase 5c).
 */
export interface LayerConfig {
	/** Unique layer identifier */
	id: string;
	/**
	 * Source dataset or operation output ID.
	 * Must reference a valid dataset ID or operation output.
	 */
	source: string;
	/** Display name for this layer in the panel. Overrides the dataset name for this layer's entry. */
	name?: string;
	/** MapLibre layer type */
	type: LayerType;
	/**
	 * MapLibre filter expression (optional).
	 * Example: ['==', ['geometry-type'], 'Polygon']
	 */
	filter?: unknown[];
	/**
	 * Paint properties for styling (varies by layer type).
	 * Examples: fill-color, line-width, circle-radius
	 * Validated at runtime during layer execution (Phase 5d).
	 */
	paint?: Record<string, unknown>;
	/**
	 * Layout properties (varies by layer type).
	 * Examples: visibility, text-field, icon-image
	 */
	layout?: Record<string, unknown>;
	/** Minimum zoom level where layer is visible (0-24) */
	minzoom?: number;
	/** Maximum zoom level where layer is visible (0-24) */
	maxzoom?: number;
	/** Vector tile source layer name. Required when source is a PMTiles/vector dataset. */
	'source-layer'?: string;
	/**
	 * Property field(s) to display in hover tooltip.
	 * Single string or array of property names from the source GeoJSON.
	 * When omitted, tooltip shows only the layer/dataset display name.
	 */
	tooltip?: string | string[];
	/** Rendering engine for this layer. Defaults to 'maplibre'. Set to 'deckgl' to render via deck.gl overlay. */
	renderer?: RendererType;
	/**
	 * Raw deck.gl layer properties passed through without validation.
	 * Only meaningful when renderer is 'deckgl'.
	 * Properties are spread directly into the deck.gl layer spec (e.g. color accessors, radius scale).
	 */
	deckProps?: Record<string, unknown>;
}

/** Supported output formats (distinct from input ConfigFormat) */
export type OutputFormat = 'geojson' | 'csv' | 'parquet' | 'pmtiles';

/** Format-specific parameters for PMTiles output generation */
export interface PMTilesOutputParams {
	/** Minimum zoom level for tile generation (default: 0) */
	minzoom?: number;
	/** Maximum zoom level for tile generation (default: 14) */
	maxzoom?: number;
	/** Layer name in the MVT output (defaults to source ID) */
	layerName?: string;
	/** Spatial bounding box for subsetting [west, south, east, north] */
	bbox?: [number, number, number, number];
	/** Source layers to include (for multi-layer PMTiles archive extraction) */
	layers?: string[];
	/** Zoom level to extract tiles at (required for PMTiles source extraction). Its presence signals extraction mode. */
	extractZoom?: number;
}

/** Output configuration for exporting datasets or operation results */
export interface OutputConfig {
	/** Source dataset or operation output ID, or array of IDs for multi-layer PMTiles */
	source: string | string[];
	/** Export format */
	format: OutputFormat;
	/** Output filename (without extension). Defaults to source ID. */
	filename?: string;
	/** Format-specific parameters (currently only used for pmtiles) */
	params?: PMTilesOutputParams;
}

/**
 * Root configuration object.
 * Parsed from YAML config file (e.g., public/app-config.yaml)
 */
export interface MapConfig {
	map: MapSettings;
	/** Datasets to load on initialization */
	datasets?: DatasetConfig[];
	/** Spatial operations to execute (Phase 3+) */
	operations?: OperationConfig[];
	/**
	 * Explicit layer definitions for rendering (Phase 5+).
	 * When defined, these replace auto-generated layers.
	 * When omitted, default fill/line/circle layers are created per dataset.
	 */
	layers?: LayerConfig[];
	/** Output definitions for exporting datasets or operation results */
	outputs?: OutputConfig[];
}

/** Result of config validation */
export interface ValidationResult {
	valid: boolean;
	errors: string[];
}
