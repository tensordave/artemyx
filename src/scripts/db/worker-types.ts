/**
 * Worker message protocol types.
 * Discriminated unions for typed postMessage RPC between main thread and DuckDB worker.
 * Types only - no runtime code.
 */

import type { StyleConfig, LoadGeoJSONOptions } from './constants';
import type { OperationConfig } from '../config/types';
import type { ConfigFormat, LoaderOptions } from '../loaders/types';
import type { ProgressStatus } from '../logger/types';
import type { FallbackReason } from './core';
import type { ComputeResult } from '../config/operations';

// ── Init log entry (duplicated from core.ts to avoid importing runtime code) ──

export interface InitLogEntry {
	message: string;
	timestamp: number;
}

// ── Request types (main -> worker) ──────────────────────────────────────────

interface RequestBase {
	requestId: string;
}

export interface InitRequest extends RequestBase {
	type: 'init';
	useOPFS: boolean;
}

export interface LoadGeoJSONRequest extends RequestBase {
	type: 'loadGeoJSON';
	data: GeoJSON.FeatureCollection;
	sourceUrl: string;
	options?: LoadGeoJSONOptions;
}

export interface AppendFeaturesRequest extends RequestBase {
	type: 'appendFeatures';
	datasetId: string;
	data: GeoJSON.FeatureCollection;
	sourceUrl: string;
	sourceCrs?: string | null;
}

export interface UpdateFeatureCountRequest extends RequestBase {
	type: 'updateFeatureCount';
	datasetId: string;
}

export interface GetDatasetsRequest extends RequestBase {
	type: 'getDatasets';
}

export interface GetDatasetByIdRequest extends RequestBase {
	type: 'getDatasetById';
	id: string;
}

export interface DatasetExistsRequest extends RequestBase {
	type: 'datasetExists';
	id: string;
}

export interface DeleteDatasetRequest extends RequestBase {
	type: 'deleteDataset';
	datasetId: string;
}

export interface DeleteAllDatasetsRequest extends RequestBase {
	type: 'deleteAllDatasets';
}

export interface UpdateDatasetColorRequest extends RequestBase {
	type: 'updateDatasetColor';
	datasetId: string;
	color: string;
}

export interface UpdateDatasetNameRequest extends RequestBase {
	type: 'updateDatasetName';
	datasetId: string;
	name: string;
}

export interface RenameDatasetIdRequest extends RequestBase {
	type: 'renameDatasetId';
	oldId: string;
	newId: string;
	newName: string;
}

export interface UpdateDatasetVisibleRequest extends RequestBase {
	type: 'updateDatasetVisible';
	datasetId: string;
	visible: boolean;
}

export interface SwapLayerOrderRequest extends RequestBase {
	type: 'swapLayerOrder';
	idA: string;
	idB: string;
}

export interface SetLayerOrdersRequest extends RequestBase {
	type: 'setLayerOrders';
	orderedIds: string[];
}

export interface GetNextLayerOrderRequest extends RequestBase {
	type: 'getNextLayerOrder';
}

export interface GetDatasetStyleRequest extends RequestBase {
	type: 'getDatasetStyle';
	datasetId: string;
}

export interface UpdateDatasetStyleRequest extends RequestBase {
	type: 'updateDatasetStyle';
	datasetId: string;
	style: StyleConfig;
}

export interface GetFeaturesAsGeoJSONRequest extends RequestBase {
	type: 'getFeaturesAsGeoJSON';
	datasetId?: string;
}

export interface GetPropertyKeysRequest extends RequestBase {
	type: 'getPropertyKeys';
	datasetId: string;
}

export interface GetDatasetBoundsRequest extends RequestBase {
	type: 'getDatasetBounds';
	datasetId: string;
}

export interface GetDistinctGeometryTypesRequest extends RequestBase {
	type: 'getDistinctGeometryTypes';
	datasetId: string;
}

export interface CheckpointRequest extends RequestBase {
	type: 'checkpoint';
}

export interface ClearOPFSRequest extends RequestBase {
	type: 'clearOPFS';
}

export interface VacuumRequest extends RequestBase {
	type: 'vacuum';
}

export interface GetStorageModeRequest extends RequestBase {
	type: 'getStorageMode';
}

export interface GetFallbackReasonRequest extends RequestBase {
	type: 'getFallbackReason';
}

export interface HasExistingOPFSDataRequest extends RequestBase {
	type: 'hasExistingOPFSData';
}

export interface GetInitLogRequest extends RequestBase {
	type: 'getInitLog';
}

// ── Full pipeline requests ──────────────────────────────────────────────────

/** Options for the worker's loadFromUrl pipeline (no MapLibre/DOM refs) */
export interface WorkerLoadUrlOptions {
	configOverrides?: LoadGeoJSONOptions;
	displayName?: string;
	format?: ConfigFormat;
	latColumn?: string;
	lngColumn?: string;
	geoColumn?: string;
	paginate?: boolean | { maxPages?: number };
	crs?: string;
	mapCrs?: string;
	hidden?: boolean;
	/** When true, skip CRS prompt and throw on projected coordinates */
	skipCrsPrompt?: boolean;
}

export interface LoadFromUrlRequest extends RequestBase {
	type: 'loadFromUrl';
	url: string;
	options: WorkerLoadUrlOptions;
}

/** Options for the worker's loadFromBuffer pipeline */
export interface WorkerLoadFileOptions {
	fileName: string;
	format?: ConfigFormat;
	latColumn?: string;
	lngColumn?: string;
	geoColumn?: string;
	crs?: string;
	configOverrides?: LoadGeoJSONOptions;
}

export interface LoadFromBufferRequest extends RequestBase {
	type: 'loadFromBuffer';
	buffer: ArrayBuffer;
	options: WorkerLoadFileOptions;
}

export interface ExecuteOperationRequest extends RequestBase {
	type: 'executeOperation';
	op: OperationConfig;
	execOrder: number;
}

export interface GetOperationsRequest extends RequestBase {
	type: 'getOperations';
}

export interface ClearOperationsRequest extends RequestBase {
	type: 'clearOperations';
}

export interface SaveOperationMetadataRequest extends RequestBase {
	type: 'saveOperationMetadata';
	outputId: string;
	opType: string;
	inputsJson: string;
	paramsJson: string | null;
	execOrder: number;
}

export interface SaveConfigRequest extends RequestBase {
	type: 'saveConfig';
	configPath: string;
	yaml: string;
}

export interface GetSavedConfigRequest extends RequestBase {
	type: 'getSavedConfig';
	configPath: string;
}

export interface DeleteSavedConfigRequest extends RequestBase {
	type: 'deleteSavedConfig';
	configPath: string;
}

export interface DeleteSubDatasetsRequest extends RequestBase {
	type: 'deleteSubDatasets';
	parentId: string;
}

export interface CreateMetadataDatasetRequest extends RequestBase {
	type: 'createMetadataDataset';
	id: string;
	sourceUrl: string;
	name: string;
	color: string;
	style: StyleConfig;
	hidden: boolean;
	format: string;
	sourceLayer?: string;
}

export interface ExportOPFSRequest extends RequestBase {
	type: 'exportOPFS';
}

export interface ImportOPFSRequest extends RequestBase {
	type: 'importOPFS';
	buffer: ArrayBuffer;
}

// ── CRS prompt response (main -> worker, no requestId) ──────────────────────

export interface CrsPromptResponse {
	type: 'crsPromptResponse';
	promptId: string;
	crs: string | null;
}

// ── Union of all requests ───────────────────────────────────────────────────

export type WorkerRequest =
	| InitRequest
	| LoadGeoJSONRequest
	| AppendFeaturesRequest
	| UpdateFeatureCountRequest
	| GetDatasetsRequest
	| GetDatasetByIdRequest
	| DatasetExistsRequest
	| DeleteDatasetRequest
	| DeleteAllDatasetsRequest
	| UpdateDatasetColorRequest
	| UpdateDatasetNameRequest
	| RenameDatasetIdRequest
	| UpdateDatasetVisibleRequest
	| SwapLayerOrderRequest
	| SetLayerOrdersRequest
	| GetNextLayerOrderRequest
	| GetDatasetStyleRequest
	| UpdateDatasetStyleRequest
	| GetFeaturesAsGeoJSONRequest
	| GetDatasetBoundsRequest
	| GetPropertyKeysRequest
	| GetDistinctGeometryTypesRequest
	| CheckpointRequest
	| ClearOPFSRequest
	| VacuumRequest
	| GetStorageModeRequest
	| GetFallbackReasonRequest
	| HasExistingOPFSDataRequest
	| GetInitLogRequest
	| LoadFromUrlRequest
	| LoadFromBufferRequest
	| ExecuteOperationRequest
	| GetOperationsRequest
	| ClearOperationsRequest
	| SaveOperationMetadataRequest
	| SaveConfigRequest
	| GetSavedConfigRequest
	| DeleteSavedConfigRequest
	| DeleteSubDatasetsRequest
	| CreateMetadataDatasetRequest
	| ExportOPFSRequest
	| ImportOPFSRequest;

// ── Response types (worker -> main, correlated by requestId) ────────────────

export interface WorkerResultResponse {
	requestId: string;
	type: 'result';
	data: unknown;
}

export interface WorkerErrorResponse {
	requestId: string;
	type: 'error';
	message: string;
}

export type WorkerResponse = WorkerResultResponse | WorkerErrorResponse;

// ── Worker events (worker -> main, push notifications) ──────────────────────

export interface ProgressEvent {
	event: 'progress';
	operation: string;
	status: ProgressStatus;
	message?: string;
}

export interface InfoEvent {
	event: 'info';
	tag: string;
	message: string;
}

export interface WarnEvent {
	event: 'warn';
	tag: string;
	message: string;
}

export interface CrsPromptEvent {
	event: 'crsPrompt';
	promptId: string;
}

export interface InitLogEvent {
	event: 'initLog';
	entries: InitLogEntry[];
}

/** Batched events to reduce IPC frequency (Safari Mach port overflow mitigation). */
export interface BatchEvent {
	event: 'batch';
	events: (ProgressEvent | InfoEvent | WarnEvent)[];
}

export type WorkerEvent =
	| ProgressEvent
	| InfoEvent
	| WarnEvent
	| CrsPromptEvent
	| InitLogEvent
	| BatchEvent;

/** All messages the worker can send to main thread */
export type WorkerMessage = WorkerResponse | WorkerEvent;

// ── All messages the main thread can send to worker ─────────────────────────

export type MainMessage = WorkerRequest | CrsPromptResponse;

// ── Result types for full pipeline responses ────────────────────────────────

/** Raw result from worker pipelines (GeoJSON as Transferable buffer). */
export interface LoadPipelineRawResult {
	datasetId: string;
	color: string;
	style: StyleConfig;
	geoJsonBuffer: Uint8Array;
	featureCount: number;
	hidden: boolean;
	bounds: [number, number, number, number] | null;
}

/** Decoded result after client-side buffer decode. */
export interface LoadPipelineResult {
	datasetId: string;
	color: string;
	style: StyleConfig;
	geoJson: GeoJSON.FeatureCollection;
	featureCount: number;
	hidden: boolean;
	bounds: [number, number, number, number] | null;
}

/** Raw result from executeOperation worker pipeline (GeoJSON as Transferable buffer). */
export interface OperationPipelineRawResult extends ComputeResult {
	geoJsonBuffer: Uint8Array;
}

/** Decoded result after client-side buffer decode. */
export interface OperationPipelineResult extends ComputeResult {
	geoJson: GeoJSON.FeatureCollection;
}

/** Result from init */
export interface InitResult {
	storageMode: 'opfs' | 'memory';
	fallbackReason: FallbackReason;
	hasExistingData: boolean;
	initLog: InitLogEntry[];
}

// ── Operation metadata record (persisted in DuckDB operations table) ────────

export interface OperationRecord {
	output_id: string;
	type: string;
	inputs_json: string;
	params_json: string | null;
	exec_order: number;
}
