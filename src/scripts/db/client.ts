/**
 * Main-thread RPC client for the DuckDB Web Worker.
 * Exposes the same async API as the original core.ts/datasets.ts/features.ts modules.
 * All calls are transparently routed to the worker via postMessage.
 */

import type {
	WorkerMessage,
	WorkerRequest,
	InitResult,
	LoadPipelineRawResult,
	LoadPipelineResult,
	OperationPipelineRawResult,
	OperationPipelineResult,
	WorkerLoadUrlOptions,
	WorkerLoadFileOptions,
	InitLogEntry,
} from './worker-types';
import type { StyleConfig, LoadGeoJSONOptions } from './constants';
import type { FallbackReason } from './core';
import type { OperationConfig } from '../config/types';
import type { ProgressStatus } from '../logger/types';

// ── Worker instance (lazy — deferred until first RPC call) ───────────────────
// Not created at module load so that importing this module on Safari
// doesn't spawn a worker that will crash due to per-tab memory limits.

let worker: Worker | null = null;

function getWorker(): Worker {
	if (!worker) {
		worker = new Worker(
			new URL('./worker.ts', import.meta.url),
			{ type: 'module' }
		);
		wireWorkerHandlers(worker);
	}
	return worker;
}

// ── RPC mechanism ───────────────────────────────────────────────────────────

let requestCounter = 0;
const pending = new Map<string, { resolve: (data: any) => void; reject: (err: Error) => void }>();

const RPC_TIMEOUT_MS = 120_000; // 2 minutes — generous for heavy spatial ops

function rpc<T>(type: string, payload: Record<string, unknown> = {}, transfer?: Transferable[]): Promise<T> {
	const w = getWorker();
	const requestId = String(++requestCounter);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pending.delete(requestId);
			reject(new Error(`RPC '${type}' timed out after ${RPC_TIMEOUT_MS / 1000}s`));
		}, RPC_TIMEOUT_MS);

		pending.set(requestId, {
			resolve: (data: any) => { clearTimeout(timer); resolve(data); },
			reject: (err: Error) => { clearTimeout(timer); reject(err); },
		});
		const msg = { requestId, type, ...payload } as WorkerRequest;
		if (transfer) {
			w.postMessage(msg, transfer);
		} else {
			w.postMessage(msg);
		}
	});
}

// ── Event handler ───────────────────────────────────────────────────────────

export interface WorkerEventHandler {
	onProgress?: (operation: string, status: ProgressStatus, message?: string, progress?: number) => void;
	onInfo?: (tag: string, message: string) => void;
	onWarn?: (tag: string, message: string) => void;
	onInitLog?: (entries: InitLogEntry[]) => void;
}

let eventHandler: WorkerEventHandler | null = null;

export function setEventHandler(handler: WorkerEventHandler): void {
	eventHandler = handler;
}

// ── Progress listeners (secondary subscribers) ──────────────────────────────

export type ProgressListener = (operation: string, status: ProgressStatus, message?: string, progress?: number) => void;

const progressListeners: Set<ProgressListener> = new Set();

export function addProgressListener(fn: ProgressListener): void {
	progressListeners.add(fn);
}

export function removeProgressListener(fn: ProgressListener): void {
	progressListeners.delete(fn);
}

function notifyProgressListeners(operation: string, status: ProgressStatus, message?: string, progress?: number): void {
	for (const fn of progressListeners) fn(operation, status, message, progress);
}

// ── Message routing ─────────────────────────────────────────────────────────

function wireWorkerHandlers(w: Worker): void {
	w.onmessage = (e: MessageEvent<WorkerMessage>) => {
		const msg = e.data;

		// Correlated RPC response
		if ('requestId' in msg && msg.requestId) {
			const p = pending.get(msg.requestId);
			if (!p) return;
			pending.delete(msg.requestId);
			if (msg.type === 'error') {
				p.reject(new Error(msg.message));
			} else {
				p.resolve(msg.data);
			}
			return;
		}

		// Worker event (push notification)
		if ('event' in msg) {
			switch (msg.event) {
				case 'progress':
					eventHandler?.onProgress?.(msg.operation, msg.status, msg.message, msg.progress);
					notifyProgressListeners(msg.operation, msg.status, msg.message, msg.progress);
					break;
				case 'info':
					eventHandler?.onInfo?.(msg.tag, msg.message);
					break;
				case 'warn':
					eventHandler?.onWarn?.(msg.tag, msg.message);
					break;
				case 'crsPrompt':
					handleCrsPrompt(msg.promptId);
					break;
				case 'initLog':
					eventHandler?.onInitLog?.(msg.entries);
					break;
				case 'batch':
					for (const evt of msg.events) {
						switch (evt.event) {
							case 'progress':
								eventHandler?.onProgress?.(evt.operation, evt.status, evt.message, evt.progress);
								notifyProgressListeners(evt.operation, evt.status, evt.message, evt.progress);
								break;
							case 'info':
								eventHandler?.onInfo?.(evt.tag, evt.message);
								break;
							case 'warn':
								eventHandler?.onWarn?.(evt.tag, evt.message);
								break;
						}
					}
					break;
			}
		}
	};

	w.onerror = (e: ErrorEvent) => {
		// Reject all pending RPCs on worker crash
		for (const [, { reject }] of pending) {
			reject(new Error(`Worker crashed: ${e.message}`));
		}
		pending.clear();
		eventHandler?.onProgress?.('worker', 'error', 'Processing worker crashed. Try clearing the session.');
	};
}

// ── CRS prompt handler ──────────────────────────────────────────────────────

async function handleCrsPrompt(promptId: string): Promise<void> {
	const w = getWorker();
	try {
		const { showCrsPromptDialog } = await import('../ui/error-dialog');
		const crs = await showCrsPromptDialog();
		w.postMessage({ type: 'crsPromptResponse', promptId, crs });
	} catch {
		w.postMessage({ type: 'crsPromptResponse', promptId, crs: null });
	}
}

// ── Cached sync state (populated after init) ────────────────────────────────

let _storageMode: 'opfs' | 'memory' = 'memory';
let _fallbackReason: FallbackReason = 'none';
let _hasExistingData = false;

// ── Initialization ──────────────────────────────────────────────────────────

let initPromise: Promise<void> | null = null;

async function doInit(useOPFS: boolean): Promise<void> {
	const result = await rpc<InitResult>('init', { useOPFS });
	_storageMode = result.storageMode;
	_fallbackReason = result.fallbackReason;
	_hasExistingData = result.hasExistingData;
	// Forward init log to event handler
	eventHandler?.onInitLog?.(result.initLog);
}

export function startInit(useOPFS: boolean): void {
	if (!initPromise) {
		initPromise = doInit(useOPFS);
	}
}

export async function ensureInit(): Promise<void> {
	if (!initPromise) {
		initPromise = doInit(false);
	}
	await initPromise;
}

// ── Sync accessors (cached after init) ──────────────────────────────────────

export function getStorageMode(): 'opfs' | 'memory' {
	return _storageMode;
}

export function getFallbackReason(): FallbackReason {
	return _fallbackReason;
}

export function setFallbackReason(reason: FallbackReason): void {
	_fallbackReason = reason;
}

export function hasExistingOPFSData(): boolean {
	return _hasExistingData;
}

// ── DB operations (delegated to worker) ─────────────────────────────────────

export async function loadGeoJSON(data: any, sourceUrl: string, options?: LoadGeoJSONOptions): Promise<boolean> {
	return rpc<boolean>('loadGeoJSON', { data, sourceUrl, options });
}

export async function appendFeatures(datasetId: string, data: GeoJSON.FeatureCollection, sourceUrl: string, sourceCrs?: string | null): Promise<number> {
	return rpc<number>('appendFeatures', { datasetId, data, sourceUrl, sourceCrs });
}

export async function updateFeatureCount(datasetId: string): Promise<number> {
	return rpc<number>('updateFeatureCount', { datasetId });
}

export async function getDatasets(): Promise<any[]> {
	return rpc<any[]>('getDatasets');
}

export async function getDatasetById(id: string): Promise<any | null> {
	return rpc<any | null>('getDatasetById', { id });
}

export async function datasetExists(id: string): Promise<boolean> {
	return rpc<boolean>('datasetExists', { id });
}

export async function deleteDataset(datasetId: string): Promise<boolean> {
	return rpc<boolean>('deleteDataset', { datasetId });
}

export async function deleteSubDatasets(parentId: string): Promise<void> {
	await rpc<boolean>('deleteSubDatasets', { parentId });
}

export async function deleteAllDatasets(): Promise<void> {
	await rpc<boolean>('deleteAllDatasets');
}

export async function updateDatasetColor(datasetId: string, color: string): Promise<boolean> {
	return rpc<boolean>('updateDatasetColor', { datasetId, color });
}

export async function updateDatasetName(datasetId: string, name: string): Promise<boolean> {
	return rpc<boolean>('updateDatasetName', { datasetId, name });
}

export async function renameDatasetId(oldId: string, newId: string, newName: string): Promise<boolean> {
	return rpc<boolean>('renameDatasetId', { oldId, newId, newName });
}

export async function updateDatasetVisible(datasetId: string, visible: boolean): Promise<boolean> {
	return rpc<boolean>('updateDatasetVisible', { datasetId, visible });
}

export async function swapLayerOrder(idA: string, idB: string): Promise<boolean> {
	return rpc<boolean>('swapLayerOrder', { idA, idB });
}

export async function setLayerOrders(orderedIds: string[]): Promise<void> {
	await rpc<void>('setLayerOrders', { orderedIds });
}

export async function getNextLayerOrder(): Promise<number> {
	return rpc<number>('getNextLayerOrder');
}

export async function getDatasetStyle(datasetId: string): Promise<StyleConfig> {
	return rpc<StyleConfig>('getDatasetStyle', { datasetId });
}

export async function updateDatasetStyle(datasetId: string, style: StyleConfig): Promise<boolean> {
	return rpc<boolean>('updateDatasetStyle', { datasetId, style });
}

export async function createMetadataDataset(
	id: string, sourceUrl: string, name: string, color: string,
	style: StyleConfig, hidden: boolean, format: string, sourceLayer?: string
): Promise<boolean> {
	return rpc<boolean>('createMetadataDataset', { id, sourceUrl, name, color, style, hidden, format, sourceLayer });
}

export async function getFeaturesAsGeoJSON(datasetId?: string): Promise<GeoJSON.FeatureCollection> {
	const buffer = await rpc<Uint8Array>('getFeaturesAsGeoJSON', { datasetId });
	return decodeGeoJsonBuffer(buffer);
}

// ── Export functions (return raw buffers for download) ───────────────────

/** Export dataset as GeoJSON buffer (reuses getFeaturesAsGeoJSON RPC, returns raw bytes). */
export async function exportAsGeoJSON(datasetId: string): Promise<Uint8Array> {
	return rpc<Uint8Array>('getFeaturesAsGeoJSON', { datasetId });
}

/** Export dataset as CSV with flattened property columns and WKT geometry. */
export async function exportAsCSV(datasetId: string): Promise<Uint8Array> {
	return rpc<Uint8Array>('exportAsCSV', { datasetId });
}

/** Export dataset as GeoParquet with WKB geometry and flattened property columns. */
export async function exportAsParquet(datasetId: string): Promise<Uint8Array> {
	return rpc<Uint8Array>('exportAsParquet', { datasetId });
}

/** Export dataset as PMTiles v3 vector tile archive. */
export async function exportAsPMTiles(datasetId: string, params?: import('../config/types').PMTilesOutputParams): Promise<Uint8Array> {
	return rpc<Uint8Array>('exportAsPMTiles', { datasetId, params });
}

/** Extract features from a remote PMTiles archive, deduplicate, and rebuild as a new archive. */
export async function extractPMTiles(
	url: string,
	extractZoom: number,
	bbox: [number, number, number, number],
	layers?: string[],
	outputParams?: import('../config/types').PMTilesOutputParams
): Promise<Uint8Array> {
	return rpc<Uint8Array>('extractPMTiles', { url, extractZoom, bbox, layers, outputParams });
}

export async function getDatasetBounds(datasetId: string): Promise<[number, number, number, number] | null> {
	return rpc<[number, number, number, number] | null>('getDatasetBounds', { datasetId });
}

export async function getPropertyKeys(datasetId: string): Promise<string[]> {
	return rpc<string[]>('getPropertyKeys', { datasetId });
}

export async function getDistinctGeometryTypes(datasetId: string): Promise<Set<string>> {
	const arr = await rpc<string[]>('getDistinctGeometryTypes', { datasetId });
	return new Set(arr);
}

export async function saveConfig(configPath: string, yaml: string): Promise<void> {
	await rpc<void>('saveConfig', { configPath, yaml });
}

export async function getSavedConfig(configPath: string): Promise<string | null> {
	return rpc<string | null>('getSavedConfig', { configPath });
}

export async function deleteSavedConfig(configPath: string): Promise<void> {
	await rpc<void>('deleteSavedConfig', { configPath });
}

export async function checkpoint(): Promise<void> {
	await rpc<void>('checkpoint');
}

export async function vacuum(): Promise<void> {
	await rpc<void>('vacuum');
}

export async function clearOPFS(): Promise<void> {
	await rpc<void>('clearOPFS');
	// Worker handles DB teardown + OPFS file deletion
	// Main thread handles the page reload
	location.reload();
}

export async function exportOPFS(): Promise<Uint8Array> {
	return rpc<Uint8Array>('exportOPFS');
}

export async function importOPFS(buffer: ArrayBuffer): Promise<void> {
	await rpc<void>('importOPFS', { buffer }, [buffer]);
	location.reload();
}

export function getInitLog(): InitLogEntry[] {
	// Init log is delivered via event handler after init completes
	// This sync function is kept for backwards compatibility but returns empty
	// since the log is pushed from the worker via the initLog event
	return [];
}

// ── Full pipeline operations ────────────────────────────────────────────────

// ── GeoJSON buffer decoding ─────────────────────────────────────────────

const textDecoder = new TextDecoder();

/** Decode a Transferable Uint8Array GeoJSON buffer into a parsed FeatureCollection. */
function decodeGeoJsonBuffer(buffer: Uint8Array): GeoJSON.FeatureCollection {
	return JSON.parse(textDecoder.decode(buffer));
}

export async function loadFromUrl(url: string, options: WorkerLoadUrlOptions): Promise<LoadPipelineResult> {
	const raw = await rpc<LoadPipelineRawResult>('loadFromUrl', { url, options });
	// Hidden datasets return an empty buffer - skip the decode/parse cycle
	const geoJson = raw.geoJsonBuffer.byteLength > 0
		? decodeGeoJsonBuffer(raw.geoJsonBuffer)
		: { type: 'FeatureCollection' as const, features: [] };
	return { datasetId: raw.datasetId, color: raw.color, style: raw.style, geoJson, featureCount: raw.featureCount, hidden: raw.hidden, bounds: raw.bounds };
}

export async function loadFromBuffer(buffer: ArrayBuffer, options: WorkerLoadFileOptions): Promise<LoadPipelineResult> {
	const raw = await rpc<LoadPipelineRawResult>('loadFromBuffer', { buffer, options }, [buffer]);
	const geoJson = decodeGeoJsonBuffer(raw.geoJsonBuffer);
	return { datasetId: raw.datasetId, color: raw.color, style: raw.style, geoJson, featureCount: raw.featureCount, hidden: raw.hidden, bounds: raw.bounds };
}

/**
 * Immediately terminate the DuckDB worker and all sub-workers.
 * Called during page teardown to release WASM memory promptly.
 */
export function terminateWorker(): void {
	worker?.terminate();
}

export async function executeOperationInWorker(op: OperationConfig, execOrder: number): Promise<OperationPipelineResult> {
	const raw = await rpc<OperationPipelineRawResult>('executeOperation', { op, execOrder });
	const geoJson = decodeGeoJsonBuffer(raw.geoJsonBuffer);
	return { outputId: raw.outputId, displayName: raw.displayName, featureCount: raw.featureCount, color: raw.color, style: raw.style, geoJson };
}

export async function getOperations(): Promise<import('./worker-types').OperationRecord[]> {
	return rpc<import('./worker-types').OperationRecord[]>('getOperations');
}

export async function clearOperations(): Promise<void> {
	await rpc<undefined>('clearOperations');
}

export async function saveOperationMetadata(
	outputId: string,
	opType: string,
	inputsJson: string,
	paramsJson: string | null,
	execOrder: number
): Promise<void> {
	await rpc<undefined>('saveOperationMetadata', { outputId, opType, inputsJson, paramsJson, execOrder });
}
