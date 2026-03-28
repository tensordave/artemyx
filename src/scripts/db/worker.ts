/**
 * DuckDB Web Worker entry point.
 * Owns the DuckDB-WASM instance, connection, and all data processing.
 * Main thread communicates via typed postMessage RPC.
 */

import type { MainMessage, WorkerRequest, CrsPromptResponse, InitResult, LoadPipelineRawResult, OperationPipelineRawResult } from './worker-types';
import { startInit, ensureInit, getStorageMode, getFallbackReason, hasExistingOPFSData, getInitLog, getConnection, getDB, checkpoint, vacuum, exportOPFSFile, importOPFSFile } from './core';
import { loadGeoJSON, appendFeatures, updateFeatureCount, getDatasets, getDatasetById, datasetExists, deleteDataset, deleteAllDatasets, deleteSubDatasets, updateDatasetColor, updateDatasetName, renameDatasetId, updateDatasetVisible, swapLayerOrder, setLayerOrders, getNextLayerOrder, getDatasetStyle, updateDatasetStyle, getOperations, clearOperations, saveOperationMetadata, createMetadataOnlyDataset, DEFAULT_COLOR, DEFAULT_STYLE } from './datasets';
import type { StyleConfig } from './datasets';
import { getFeaturesAsGeoJSONString, getDatasetBounds, getPropertyKeys, getDistinctGeometryTypes, exportAsCSV, exportAsParquet } from './features';
import type { OperationConfig } from '../config/types';
import { isUnaryOperation, isBinaryOperation } from '../config/types';
import type { ComputeCallbacks, ComputeResult } from '../config/operations';
import { computeBuffer } from '../config/operations/buffer';
import { computeIntersection } from '../config/operations/intersection';
import { computeUnion } from '../config/operations/union';
import { computeDifference } from '../config/operations/difference';
import { computeContains } from '../config/operations/contains';
import { computeDistance } from '../config/operations/distance';
import { computeCentroid } from '../config/operations/centroid';
import { computeAttribute } from '../config/operations/attribute';
import { detectFormat, detectFormatFromFilename } from '../loaders/detect';
import { dispatch as loaderDispatch } from '../loaders';
import type { LoaderOptions } from '../loaders/types';
import { resolveSourceCrs, hasProjectedCoordinates } from '../loaders/crs';
import { fetchWithPagination } from '../loaders/paginator';
import { normalizeGeoJSON, tryLoadJsonArray } from '../loaders';
import type { WorkerLoadUrlOptions, WorkerLoadFileOptions } from './worker-types';
import type { LoadGeoJSONOptions } from './datasets';
import { generateDatasetId } from './utils';
import type { ProgressStatus } from '../logger/types';
import type { ProgressEvent, InfoEvent, WarnEvent } from './worker-types';

// ── Helpers ─────────────────────────────────────────────────────────────────

const textEncoder = new TextEncoder();

function respond(requestId: string, data: unknown): void {
	self.postMessage({ requestId, type: 'result', data });
}

/** Respond with Transferable buffers (zero-copy to main thread). */
function respondTransfer(requestId: string, data: unknown, transfers: Transferable[]): void {
	(self as unknown as Worker).postMessage({ requestId, type: 'result', data }, transfers);
}

function respondError(requestId: string, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	self.postMessage({ requestId, type: 'error', message });
}

// ── Event batching (Safari Mach IPC overflow mitigation) ─────────────────

const BATCH_INTERVAL_MS = 150;
let pendingEvents: (ProgressEvent | InfoEvent | WarnEvent)[] = [];
let batchTimer: ReturnType<typeof setTimeout> | null = null;

/** Flush all pending events as a single batched postMessage. */
function flushEvents(): void {
	batchTimer = null;
	if (pendingEvents.length === 0) return;

	// Deduplicate progress events: keep only the latest per operation key
	const progressLatest = new Map<string, ProgressEvent>();
	const nonProgress: (InfoEvent | WarnEvent)[] = [];

	for (const evt of pendingEvents) {
		if (evt.event === 'progress') {
			progressLatest.set(evt.operation, evt);
		} else {
			nonProgress.push(evt);
		}
	}

	const deduped = [...nonProgress, ...progressLatest.values()];
	pendingEvents = [];

	if (deduped.length === 1) {
		self.postMessage(deduped[0]);
	} else {
		self.postMessage({ event: 'batch', events: deduped });
	}
}

function scheduleBatchFlush(): void {
	if (batchTimer === null) {
		batchTimer = setTimeout(flushEvents, BATCH_INTERVAL_MS);
	}
}

function postProgress(operation: string, status: ProgressStatus, message?: string, progress?: number): void {
	const evt: ProgressEvent = { event: 'progress', operation, status, message, progress };
	// Terminal statuses flush immediately for instant user feedback
	if (status === 'success' || status === 'error') {
		pendingEvents.push(evt);
		if (batchTimer !== null) { clearTimeout(batchTimer); batchTimer = null; }
		flushEvents();
		return;
	}
	pendingEvents.push(evt);
	scheduleBatchFlush();
}

function postInfo(tag: string, message: string): void {
	pendingEvents.push({ event: 'info', tag, message });
	scheduleBatchFlush();
}

function postWarn(tag: string, message: string): void {
	pendingEvents.push({ event: 'warn', tag, message });
	scheduleBatchFlush();
}

function makeCallbacks(operationName: string): ComputeCallbacks {
	return {
		onProgress: (msg) => postProgress(operationName, 'processing', msg),
		onInfo: (tag, msg) => postInfo(tag, msg),
		onWarn: (tag, msg) => postWarn(tag, msg),
	};
}

// ── CRS prompt suspension ───────────────────────────────────────────────────

const pendingCrsPrompts = new Map<string, (crs: string | null) => void>();

async function requestCrsFromUser(): Promise<string | null> {
	const promptId = crypto.randomUUID();
	self.postMessage({ event: 'crsPrompt', promptId });
	return new Promise((resolve) => {
		pendingCrsPrompts.set(promptId, resolve);
	});
}

function handleCrsPromptResponse(msg: CrsPromptResponse): void {
	const resolve = pendingCrsPrompts.get(msg.promptId);
	if (resolve) {
		pendingCrsPrompts.delete(msg.promptId);
		resolve(msg.crs);
	}
}

// ── Normalize page helper (replicated from load-url.ts) ─────────────────────

function normalizePage(data: any, loaderOptions?: LoaderOptions): GeoJSON.FeatureCollection {
	const normalized = normalizeGeoJSON(data);
	if (normalized) return normalized;

	const arrayResult = tryLoadJsonArray(data, loaderOptions);
	if (arrayResult) return arrayResult.data;

	throw new Error('Page data is not valid GeoJSON or recognizable coordinate array');
}

// ── Full pipeline: loadFromUrl ──────────────────────────────────────────────

async function workerLoadFromUrl(url: string, options: WorkerLoadUrlOptions): Promise<LoadPipelineRawResult> {
	const displayName = options.displayName || new URL(url).hostname;
	const loaderOptions: LoaderOptions = {};
	if (options.latColumn) loaderOptions.latColumn = options.latColumn;
	if (options.lngColumn) loaderOptions.lngColumn = options.lngColumn;
	if (options.geoColumn) loaderOptions.geoColumn = options.geoColumn;
	if (options.crs) loaderOptions.crs = options.crs;

	postInfo('Data', `Fetching from ${url}`);
	postProgress(displayName, 'loading');

	// Build pagination options
	let paginationOpts: { force?: boolean; maxPages?: number } | undefined;
	if (options.paginate === true) paginationOpts = { force: true };
	else if (options.paginate && typeof options.paginate === 'object') paginationOpts = { maxPages: options.paginate.maxPages };

	// Pagination disabled - direct fetch
	if (options.paginate === false) {
		return await workerLoadSingleFetch(url, displayName, loaderOptions, options);
	}

	// Fetch with pagination detection
	const paginationResult = await fetchWithPagination(url, paginationOpts);

	// Non-JSON response (parquet, etc.) - paginator returns raw Response
	if (!paginationResult.paginated && paginationResult.firstPage instanceof Response) {
		return await workerLoadFromResponse(paginationResult.firstPage, url, displayName, loaderOptions, options);
	}

	// Non-paginated JSON
	if (!paginationResult.paginated) {
		const { extractGeoJsonCrs } = await import('../loaders/geojson');
		const detectedCrs = extractGeoJsonCrs(paginationResult.firstPage);
		const data = normalizePage(paginationResult.firstPage, loaderOptions);
		return await workerLoadFeatureCollection(data, url, displayName, options, detectedCrs);
	}

	// Paginated response
	const { firstPage, pages, apiType } = paginationResult;
	postInfo('Data', `Paginated ${apiType} response detected`);
	postProgress(displayName, 'loading', `Loading ${displayName} (page 1)...`);

	const { extractGeoJsonCrs: extractCrs } = await import('../loaders/geojson');
	const pagDetectedCrs = extractCrs(firstPage);
	const pagSourceCrs = resolveSourceCrs(options.crs, pagDetectedCrs, options.mapCrs);
	const firstData = normalizePage(firstPage, loaderOptions);

	const pagDbOptions: LoadGeoJSONOptions = { ...options.configOverrides, sourceCrs: pagSourceCrs };
	const loaded = await loadGeoJSON(firstData, url, pagDbOptions);
	if (!loaded) throw new Error('Failed to load first page into DuckDB');

	// Get dataset metadata by known ID
	const datasetId = pagDbOptions.id || generateDatasetId(url);
	const dataset = await getDatasetById(datasetId);
	if (!dataset) throw new Error('No dataset found after loading first page');

	// Fetch subsequent pages
	let totalFeatures = firstData.features.length;
	let pageNum = 2;

	if (pages) {
		for await (const pageData of pages) {
			postProgress(displayName, 'loading', `Loading ${displayName} (page ${pageNum}, ${totalFeatures} features)...`);
			const pageFeatures = normalizePage(pageData, loaderOptions);
			const appendedCount = await appendFeatures(datasetId, pageFeatures, url, pagSourceCrs);
			totalFeatures += appendedCount;
			pageNum++;
		}
	}

	const finalCount = await updateFeatureCount(datasetId);

	// Compact memory after bulk paginated load to prevent WASM heap monotonic growth
	if (pageNum > 2) {
		await vacuum();
	}

	postInfo('Data', `Pagination complete: ${finalCount} total features across ${pageNum - 1} pages`);

	const geoJsonStr = await getFeaturesAsGeoJSONString(datasetId);
	const color = dataset.color || DEFAULT_COLOR;
	const style = parseDatasetStyleJson(dataset.style);
	const bounds = await getDatasetBounds(datasetId);

	postProgress(displayName, 'success', `Loaded ${finalCount} features (${pageNum - 1} pages)`);

	const geoJsonBuffer = textEncoder.encode(geoJsonStr);

	return {
		datasetId,
		color,
		style,
		geoJsonBuffer,
		featureCount: finalCount,
		hidden: !!options.hidden,
		bounds,
	};
}

async function workerLoadSingleFetch(
	url: string,
	displayName: string,
	loaderOptions: LoaderOptions,
	options: WorkerLoadUrlOptions
): Promise<LoadPipelineRawResult> {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
	return await workerLoadFromResponse(response, url, displayName, loaderOptions, options);
}

async function workerLoadFromResponse(
	response: Response,
	url: string,
	displayName: string,
	loaderOptions: LoaderOptions,
	options: WorkerLoadUrlOptions
): Promise<LoadPipelineRawResult> {
	// Size check
	const MAX_SIZE_BYTES = 100 * 1024 * 1024;
	const contentLength = response.headers.get('Content-Length');
	if (contentLength && parseInt(contentLength, 10) > MAX_SIZE_BYTES) {
		throw new Error(`File too large (>100MB). Content-Length: ${contentLength} bytes`);
	}

	const contentType = response.headers.get('Content-Type');
	const contentDisposition = response.headers.get('Content-Disposition');
	const detectedFormat = detectFormat(response.url, contentType, options.format, contentDisposition);

	// Unwrap to raw data
	let rawData: string | object | ArrayBuffer;
	if (detectedFormat === 'csv') {
		rawData = await response.text();
	} else if (detectedFormat === 'geoparquet') {
		rawData = await response.arrayBuffer();
	} else {
		rawData = await response.json();
	}

	postProgress(displayName, 'processing');
	const { data, detectedCrs, crsHandled } = await loaderDispatch(rawData, detectedFormat, loaderOptions);
	return await workerLoadFeatureCollection(data, url, displayName, options, detectedCrs, crsHandled);
}

async function workerLoadFeatureCollection(
	data: GeoJSON.FeatureCollection,
	url: string,
	displayName: string,
	options: WorkerLoadUrlOptions,
	detectedCrs?: string,
	crsHandled?: boolean
): Promise<LoadPipelineRawResult> {
	postProgress(displayName, 'processing');

	let sourceCrs = crsHandled ? undefined : resolveSourceCrs(options.crs, detectedCrs, options.mapCrs);

	// Guard: detect projected coordinates
	if (!sourceCrs && hasProjectedCoordinates(data)) {
		if (options.skipCrsPrompt) {
			throw new Error('Data appears to use a projected coordinate system. Specify crs on the dataset config.');
		}
		const userCrs = await requestCrsFromUser();
		if (!userCrs) {
			throw new Error('Projected coordinate system detected but no CRS provided.');
		}
		sourceCrs = userCrs;
	}

	const dbOptions: LoadGeoJSONOptions = { ...options.configOverrides, sourceCrs };
	const loaded = await loadGeoJSON(data, url, dbOptions);
	if (!loaded) throw new Error('Failed to load into DuckDB');

	const datasetId = dbOptions.id || generateDatasetId(url);
	const dataset = await getDatasetById(datasetId);
	if (!dataset) throw new Error('No dataset found after loading');

	const color = dataset.color || DEFAULT_COLOR;
	const style = parseDatasetStyleJson(dataset.style);
	const featureCount = dataset.feature_count ?? 0;

	// Hidden datasets: skip GeoJSON materialization entirely - main thread never renders them.
	// Only verify features exist via the already-known feature_count.
	if (options.hidden) {
		if (featureCount === 0) {
			throw new Error('No valid features returned from DuckDB');
		}
		postInfo('Data', `Hidden dataset ${datasetId}: ${featureCount} features loaded (source-only)`);
		postProgress(displayName, 'success', `Loaded ${featureCount} features (hidden)`);
		return {
			datasetId,
			color,
			style,
			geoJsonBuffer: new Uint8Array(0),
			featureCount,
			hidden: true,
			bounds: null,
		};
	}

	const geoJsonStr = await getFeaturesAsGeoJSONString(datasetId);
	// Quick check: the string_agg result is empty when no features match
	const hasFeatures = geoJsonStr.length > '{"type":"FeatureCollection","features":[]}'.length;
	if (!hasFeatures) {
		throw new Error('No valid features returned from DuckDB');
	}

	postInfo('Data', `Displaying ${featureCount} features for dataset ${datasetId}`);
	postProgress(displayName, 'success', `Loaded ${featureCount} features`);

	const geoJsonBuffer = textEncoder.encode(geoJsonStr);
	const bounds = await getDatasetBounds(datasetId);

	return {
		datasetId,
		color,
		style,
		geoJsonBuffer,
		featureCount,
		hidden: !!options.hidden,
		bounds,
	};
}

// ── Full pipeline: loadFromBuffer ───────────────────────────────────────────

async function workerLoadFromBuffer(buffer: ArrayBuffer, options: WorkerLoadFileOptions): Promise<LoadPipelineRawResult> {
	const displayName = options.fileName;
	const loaderOptions: LoaderOptions = {};
	if (options.latColumn) loaderOptions.latColumn = options.latColumn;
	if (options.lngColumn) loaderOptions.lngColumn = options.lngColumn;
	if (options.geoColumn) loaderOptions.geoColumn = options.geoColumn;
	if (options.crs) loaderOptions.crs = options.crs;

	postProgress(displayName, 'processing');

	// Detect format from file name (use filename-based detection, not URL-based)
	const detectedFormat = options.format || detectFormatFromFilename(options.fileName);

	// Convert buffer to appropriate raw data
	let rawData: string | object | ArrayBuffer;
	if (detectedFormat === 'geoparquet') {
		rawData = buffer;
	} else if (detectedFormat === 'csv') {
		rawData = new TextDecoder().decode(buffer);
	} else {
		rawData = JSON.parse(new TextDecoder().decode(buffer));
	}

	const { data, detectedCrs, crsHandled } = await loaderDispatch(rawData, detectedFormat, loaderOptions);

	let sourceCrs = crsHandled ? undefined : resolveSourceCrs(options.crs, detectedCrs, undefined);

	// Guard: detect projected coordinates
	if (!sourceCrs && hasProjectedCoordinates(data)) {
		const userCrs = await requestCrsFromUser();
		if (!userCrs) {
			throw new Error('Projected coordinate system detected but no CRS provided.');
		}
		sourceCrs = userCrs;
	}

	const sourceUrl = `file://${options.fileName}`;
	const dbOptions: LoadGeoJSONOptions = { ...options.configOverrides, sourceCrs };
	const loaded = await loadGeoJSON(data, sourceUrl, dbOptions);
	if (!loaded) throw new Error('Failed to load into DuckDB');

	const datasetId = dbOptions.id || generateDatasetId(sourceUrl);
	const dataset = await getDatasetById(datasetId);
	if (!dataset) throw new Error('No dataset found after loading');

	const color = dataset.color || DEFAULT_COLOR;
	const style = parseDatasetStyleJson(dataset.style);

	const geoJsonStr = await getFeaturesAsGeoJSONString(datasetId);
	const hasFeatures = geoJsonStr.length > '{"type":"FeatureCollection","features":[]}'.length;
	if (!hasFeatures) {
		throw new Error('No valid features returned from DuckDB');
	}

	const featureCount = dataset.feature_count ?? 0;
	postProgress(displayName, 'success', `Loaded ${featureCount} features`);

	const geoJsonBuffer = textEncoder.encode(geoJsonStr);
	const bounds = await getDatasetBounds(datasetId);

	return {
		datasetId,
		color,
		style,
		geoJsonBuffer,
		featureCount,
		hidden: false,
		bounds,
	};
}

// ── Full pipeline: executeOperation ─────────────────────────────────────────

async function workerExecuteOperation(op: OperationConfig, execOrder: number): Promise<OperationPipelineRawResult> {
	const connection = await getConnection();
	const callbacks = makeCallbacks(op.name || op.output);
	let result: ComputeResult;

	switch (op.type) {
		case 'buffer':
			if (!isUnaryOperation(op)) throw new Error(`Buffer operation must have single 'input' field`);
			result = await computeBuffer(connection, op, callbacks);
			break;
		case 'intersection':
			if (!isBinaryOperation(op)) throw new Error(`Intersection operation must have 'inputs' array`);
			result = await computeIntersection(connection, op, callbacks);
			break;
		case 'union':
			if (!isBinaryOperation(op)) throw new Error(`Union operation must have 'inputs' array`);
			result = await computeUnion(connection, op, callbacks);
			break;
		case 'difference':
			if (!isBinaryOperation(op)) throw new Error(`Difference operation must have 'inputs' array`);
			result = await computeDifference(connection, op, callbacks);
			break;
		case 'contains':
			if (!isBinaryOperation(op)) throw new Error(`Contains operation must have 'inputs' array`);
			result = await computeContains(connection, op, callbacks);
			break;
		case 'distance':
			if (!isBinaryOperation(op)) throw new Error(`Distance operation must have 'inputs' array`);
			result = await computeDistance(connection, op, callbacks);
			break;
		case 'centroid':
			if (!isUnaryOperation(op)) throw new Error(`Centroid operation must have single 'input' field`);
			result = await computeCentroid(connection, op, callbacks);
			break;
		case 'attribute':
			if (!isUnaryOperation(op)) throw new Error(`Attribute operation must have single 'input' field`);
			result = await computeAttribute(connection, op, callbacks);
			break;
		default: {
			const _exhaustive: never = op;
			throw new Error(`Unsupported operation type: ${(_exhaustive as OperationConfig).type}`);
		}
	}

	// Persist operation metadata for config reconstruction
	const inputs = isUnaryOperation(op) ? [op.input] : op.inputs;
	const insertOp = await connection.prepare(`
		INSERT INTO operations (output_id, type, inputs_json, params_json, exec_order)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT (output_id) DO UPDATE SET
			type = EXCLUDED.type, inputs_json = EXCLUDED.inputs_json,
			params_json = EXCLUDED.params_json, exec_order = EXCLUDED.exec_order
	`);
	await insertOp.query(
		op.output,
		op.type,
		JSON.stringify(inputs),
		op.params ? JSON.stringify(op.params) : null,
		execOrder
	);
	await insertOp.close();

	const geoJsonStr = await getFeaturesAsGeoJSONString(result.outputId);
	const hasFeatures = geoJsonStr.length > '{"type":"FeatureCollection","features":[]}'.length;
	if (!hasFeatures) {
		throw new Error(`Operation '${op.output}': no features returned from query`);
	}

	const geoJsonBuffer = textEncoder.encode(geoJsonStr);

	return { ...result, geoJsonBuffer };
}

// ── clearOPFS (worker-side: teardown only, no location.reload) ──────────────

async function workerClearOPFS(): Promise<void> {
	postProgress('clear-session', 'processing', 'Clearing session data...');

	// 1. Flush all data from tables so OPFS is empty even if file deletion fails.
	//    database.terminate() may not synchronously release the OPFS access handle,
	//    causing removeEntry() to silently fail. Clearing tables first ensures the
	//    OPFS file contains an empty DB regardless.
	try {
		const connection = await getConnection();
		await connection.query('DELETE FROM features');
		await connection.query('DELETE FROM datasets');
		await connection.query('DELETE FROM operations');
		await connection.query('DELETE FROM meta');
		await checkpoint();
	} catch { /* DB might not be initialized */ }

	// 2. Close connection and terminate database
	try {
		const connection = await getConnection();
		await connection.close();
	} catch { /* ignore */ }
	try {
		const database = await getDB();
		await database.terminate();
	} catch { /* ignore */ }

	// 3. Delete OPFS file (best-effort — may fail if access handle lingers)
	try {
		const root = await navigator.storage.getDirectory();
		await root.removeEntry('gis_app.db');
		console.log('[Worker] OPFS file deleted');
	} catch (e) {
		console.warn('[Worker] Could not delete OPFS file:', e);
	}

	// 4. Clean up WAL file if present
	try {
		const root = await navigator.storage.getDirectory();
		await root.removeEntry('gis_app.db.wal');
	} catch { /* may not exist */ }
}

// ── Style parsing helper ────────────────────────────────────────────────────

function parseDatasetStyleJson(styleJson: string | null | undefined): StyleConfig {
	if (!styleJson) return { ...DEFAULT_STYLE };
	try {
		const parsed = JSON.parse(styleJson);
		return {
			fillOpacity: parsed.fillOpacity ?? DEFAULT_STYLE.fillOpacity,
			lineOpacity: parsed.lineOpacity ?? DEFAULT_STYLE.lineOpacity,
			pointOpacity: parsed.pointOpacity ?? DEFAULT_STYLE.pointOpacity,
			lineWidth: parsed.lineWidth ?? DEFAULT_STYLE.lineWidth,
			pointRadius: parsed.pointRadius ?? DEFAULT_STYLE.pointRadius,
			labelField: parsed.labelField ?? DEFAULT_STYLE.labelField,
			labelSize: parsed.labelSize ?? DEFAULT_STYLE.labelSize,
			labelColor: parsed.labelColor ?? DEFAULT_STYLE.labelColor,
			labelHaloColor: parsed.labelHaloColor ?? DEFAULT_STYLE.labelHaloColor,
			labelHaloWidth: parsed.labelHaloWidth ?? DEFAULT_STYLE.labelHaloWidth,
			labelMinzoom: parsed.labelMinzoom ?? DEFAULT_STYLE.labelMinzoom,
			labelMaxzoom: parsed.labelMaxzoom ?? DEFAULT_STYLE.labelMaxzoom,
			minzoom: parsed.minzoom ?? DEFAULT_STYLE.minzoom,
			maxzoom: parsed.maxzoom ?? DEFAULT_STYLE.maxzoom,
		};
	} catch {
		return { ...DEFAULT_STYLE };
	}
}

// ── Message handler ─────────────────────────────────────────────────────────

self.onmessage = async (e: MessageEvent<MainMessage>) => {
	const msg = e.data;

	// CRS prompt response (no requestId)
	if (msg.type === 'crsPromptResponse') {
		handleCrsPromptResponse(msg as CrsPromptResponse);
		return;
	}

	const req = msg as WorkerRequest;
	const { requestId } = req;

	try {
		switch (req.type) {
			case 'init': {
				startInit(req.useOPFS);
			await ensureInit();
				const result: InitResult = {
					storageMode: getStorageMode(),
					fallbackReason: getFallbackReason(),
					hasExistingData: hasExistingOPFSData(),
					initLog: getInitLog(),
				};
				respond(requestId, result);
				break;
			}

			case 'loadGeoJSON': {
				const ok = await loadGeoJSON(req.data, req.sourceUrl, req.options);
				respond(requestId, ok);
				break;
			}

			case 'appendFeatures': {
				const count = await appendFeatures(req.datasetId, req.data, req.sourceUrl, req.sourceCrs);
				respond(requestId, count);
				break;
			}

			case 'updateFeatureCount': {
				const count = await updateFeatureCount(req.datasetId);
				respond(requestId, count);
				break;
			}

			case 'getDatasets': {
				const datasets = await getDatasets();
				respond(requestId, datasets);
				break;
			}

			case 'getDatasetById': {
				const dataset = await getDatasetById(req.id);
				respond(requestId, dataset);
				break;
			}

			case 'datasetExists': {
				const exists = await datasetExists(req.id);
				respond(requestId, exists);
				break;
			}

			case 'deleteDataset': {
				const ok = await deleteDataset(req.datasetId);
				respond(requestId, ok);
				break;
			}

			case 'deleteAllDatasets': {
				await deleteAllDatasets();
				respond(requestId, true);
				break;
			}

			case 'deleteSubDatasets': {
				await deleteSubDatasets(req.parentId);
				respond(requestId, true);
				break;
			}

			case 'createMetadataDataset': {
				const ok = await createMetadataOnlyDataset(
					req.id, req.sourceUrl, req.name, req.color,
					req.style, req.hidden, req.format, req.sourceLayer
				);
				respond(requestId, ok);
				break;
			}

			case 'getOperations': {
				const ops = await getOperations();
				respond(requestId, ops);
				break;
			}

			case 'clearOperations': {
				await clearOperations();
				respond(requestId, undefined);
				break;
			}

			case 'saveOperationMetadata': {
				await saveOperationMetadata(req.outputId, req.opType, req.inputsJson, req.paramsJson, req.execOrder);
				respond(requestId, undefined);
				break;
			}

			case 'updateDatasetColor': {
				const ok = await updateDatasetColor(req.datasetId, req.color);
				respond(requestId, ok);
				break;
			}

			case 'updateDatasetName': {
				const ok = await updateDatasetName(req.datasetId, req.name);
				respond(requestId, ok);
				break;
			}

			case 'renameDatasetId': {
				const ok = await renameDatasetId(req.oldId, req.newId, req.newName);
				respond(requestId, ok);
				break;
			}

			case 'updateDatasetVisible': {
				const ok = await updateDatasetVisible(req.datasetId, req.visible);
				respond(requestId, ok);
				break;
			}

			case 'swapLayerOrder': {
				const ok = await swapLayerOrder(req.idA, req.idB);
				respond(requestId, ok);
				break;
			}

			case 'setLayerOrders': {
				await setLayerOrders(req.orderedIds);
				respond(requestId, undefined);
				break;
			}

			case 'getNextLayerOrder': {
				const order = await getNextLayerOrder();
				respond(requestId, order);
				break;
			}

			case 'getDatasetStyle': {
				const style = await getDatasetStyle(req.datasetId);
				respond(requestId, style);
				break;
			}

			case 'updateDatasetStyle': {
				const ok = await updateDatasetStyle(req.datasetId, req.style);
				respond(requestId, ok);
				break;
			}

			case 'getFeaturesAsGeoJSON': {
				const geoJsonStr = await getFeaturesAsGeoJSONString(req.datasetId);
				const geoJsonBuf = textEncoder.encode(geoJsonStr);
				respondTransfer(requestId, geoJsonBuf, [geoJsonBuf.buffer]);
				break;
			}

			case 'exportAsCSV': {
				postProgress(req.datasetId, 'processing', 'Exporting as CSV...');
				const csvBuf = await exportAsCSV(req.datasetId);
				postProgress(req.datasetId, 'success', 'CSV export complete');
				respondTransfer(requestId, csvBuf, [csvBuf.buffer]);
				break;
			}

			case 'exportAsParquet': {
				postProgress(req.datasetId, 'processing', 'Exporting as Parquet...');
				const parquetBuf = await exportAsParquet(req.datasetId);
				postProgress(req.datasetId, 'success', 'Parquet export complete');
				respondTransfer(requestId, parquetBuf, [parquetBuf.buffer]);
				break;
			}

			case 'exportAsPMTiles': {
				postProgress(req.datasetId, 'processing', 'Generating PMTiles...');
				const { generatePMTiles } = await import('./pmtiles-writer');
				const pmtilesBuf = await generatePMTiles({
					datasetId: req.datasetId,
					params: req.params,
					onProgress: (msg, p) => postProgress(req.datasetId, 'processing', msg, p),
				});
				postProgress(req.datasetId, 'success', 'PMTiles export complete');
				respondTransfer(requestId, pmtilesBuf, [pmtilesBuf.buffer]);
				break;
			}

			case 'exportAsMultiLayerPMTiles': {
				const opId = req.operationId;
				postProgress(opId, 'processing', 'Reading datasets for multi-layer PMTiles...');
				const { getFeaturesAsGeoJSON } = await import('./features');
				const { generateMultiLayerPMTiles } = await import('./pmtiles-writer');

				const layers = new Map<string, GeoJSON.FeatureCollection>();
				for (const datasetId of req.datasetIds) {
					const fc = await getFeaturesAsGeoJSON(datasetId);
					if (fc.features.length === 0) {
						throw new Error(`Dataset '${datasetId}' has no features to tile`);
					}
					layers.set(datasetId, fc);
				}

				const mlBuf = await generateMultiLayerPMTiles({
					layers,
					params: req.params,
					onProgress: (msg, p) => postProgress(opId, 'processing', msg, p),
				});
				postProgress(opId, 'success', 'Multi-layer PMTiles export complete');
				respondTransfer(requestId, mlBuf, [mlBuf.buffer]);
				break;
			}

			case 'extractPMTiles': {
				const extractOp = req.sourceId || 'extract-pmtiles';
				postProgress(extractOp, 'processing', 'Extracting PMTiles...');
				const { extractPMTilesAndRebuild } = await import('./pmtiles-reader');
				const extractBuf = await extractPMTilesAndRebuild({
					url: req.url,
					extractZoom: req.extractZoom,
					bbox: req.bbox,
					layers: req.layers,
					outputParams: req.outputParams,
					onProgress: (msg, p) => postProgress(extractOp, 'processing', msg, p),
				});
				postProgress(extractOp, 'success', 'PMTiles extraction complete');
				respondTransfer(requestId, extractBuf, [extractBuf.buffer]);
				break;
			}

			case 'getPropertyKeys': {
				const keys = await getPropertyKeys(req.datasetId);
				respond(requestId, keys);
				break;
			}

			case 'getDatasetBounds': {
				const bounds = await getDatasetBounds(req.datasetId);
				respond(requestId, bounds);
				break;
			}

			case 'getDistinctGeometryTypes': {
				const types = await getDistinctGeometryTypes(req.datasetId);
				// Serialize Set as array (structured clone doesn't handle Set)
				respond(requestId, Array.from(types));
				break;
			}

			case 'checkpoint': {
				await checkpoint();
				respond(requestId, undefined);
				break;
			}

			case 'clearOPFS': {
				await workerClearOPFS();
				respond(requestId, undefined);
				break;
			}

			case 'exportOPFS': {
				const bytes = await exportOPFSFile();
				respondTransfer(requestId, bytes, [bytes.buffer]);
				break;
			}

			case 'importOPFS': {
				await importOPFSFile(new Uint8Array(req.buffer));
				respond(requestId, undefined);
				break;
			}

			case 'vacuum': {
				await vacuum();
				respond(requestId, undefined);
				break;
			}

			case 'getStorageMode': {
				respond(requestId, getStorageMode());
				break;
			}

			case 'getFallbackReason': {
				respond(requestId, getFallbackReason());
				break;
			}

			case 'hasExistingOPFSData': {
				respond(requestId, hasExistingOPFSData());
				break;
			}

			case 'getInitLog': {
				respond(requestId, getInitLog());
				break;
			}

			case 'saveConfig': {
				const c = await getConnection();
				const key = `config:${req.configPath}`;
				const stmt = await c.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = ?`);
				await stmt.query(key, req.yaml, req.yaml);
				await stmt.close();
				await checkpoint();
				respond(requestId, undefined);
				break;
			}

			case 'getSavedConfig': {
				const c = await getConnection();
				const key = `config:${req.configPath}`;
				const stmt = await c.prepare(`SELECT value FROM meta WHERE key = ?`);
				const result = await stmt.query(key);
				await stmt.close();
				const rows = result.toArray();
				respond(requestId, rows.length > 0 ? rows[0].value : null);
				break;
			}

			case 'deleteSavedConfig': {
				const c = await getConnection();
				const key = `config:${req.configPath}`;
				const stmt = await c.prepare(`DELETE FROM meta WHERE key = ?`);
				await stmt.query(key);
				await stmt.close();
				await checkpoint();
				respond(requestId, undefined);
				break;
			}

			// Full pipelines (use Transferable for zero-copy GeoJSON buffer)
			case 'loadFromUrl': {
				const result = await workerLoadFromUrl(req.url, req.options);
				const transfer = result.geoJsonBuffer ? [result.geoJsonBuffer.buffer] : [];
				respondTransfer(requestId, result, transfer);
				break;
			}

			case 'loadFromBuffer': {
				const result = await workerLoadFromBuffer(req.buffer, req.options);
				const transfer = result.geoJsonBuffer ? [result.geoJsonBuffer.buffer] : [];
				respondTransfer(requestId, result, transfer);
				break;
			}

			case 'executeOperation': {
				const result = await workerExecuteOperation(req.op, req.execOrder);
				// Flush any pending batched progress events before responding,
				// so all progress messages arrive before the result on the main thread.
				if (batchTimer !== null) { clearTimeout(batchTimer); batchTimer = null; }
				flushEvents();
				const transfer = result.geoJsonBuffer ? [result.geoJsonBuffer.buffer] : [];
				respondTransfer(requestId, result, transfer);
				break;
			}

			default: {
				respondError(requestId, `Unknown message type: ${(req as any).type}`);
			}
		}
	} catch (error) {
		respondError(requestId, error);
	}
};
