/**
 * DuckDB-WASM core initialization and connection management.
 *
 * Supports two storage modes:
 *   - 'opfs': persisted via Origin Private File System (survives refresh)
 *   - 'memory': in-memory only (lost on refresh)
 *
 * Call initDB(useOPFS) from the app entry point before any DB access.
 */

import * as duckdb from '@duckdb/duckdb-wasm';
import { isSafari } from '../utils/safari-detect';

const SCHEMA_VERSION = '4';
const OPFS_DB_PATH = 'opfs://gis_app.db';
const OPFS_FILE_NAME = 'gis_app.db';

/**
 * Why we're running in-memory instead of OPFS.
 * - 'none': OPFS is active (or persistence was never requested)
 * - 'disabled': data-persistence="false" on #map
 * - 'opfs-failed': OPFS open threw an error (browser unsupported, permissions, etc.)
 * - 'corruption': OPFS opened but schema was stale/invalid (wiped + fell back)
 * - 'quota-exceeded': a write hit QuotaExceededError mid-session
 */
export type FallbackReason = 'none' | 'disabled' | 'opfs-failed' | 'corruption' | 'quota-exceeded';

// Database instance and connection
let db: duckdb.AsyncDuckDB | null = null;
let conn: duckdb.AsyncDuckDBConnection | null = null;
let initPromise: Promise<void> | null = null;
let storageMode: 'opfs' | 'memory' = 'memory';
let fallbackReason: FallbackReason = 'none';
let opfsHadExistingData = false;

/** Timestamped init log entries for replay into ProgressControl after it mounts. */
interface InitLogEntry {
	message: string;
	timestamp: number;
}
const initLog: InitLogEntry[] = [];

function logInitStep(message: string): void {
	initLog.push({ message, timestamp: Date.now() });
}

/** Get recorded init steps for replay into progress history. */
export function getInitLog(): InitLogEntry[] {
	return initLog;
}

/**
 * Initialize database schema for multi-dataset support
 */
export async function initSchema(): Promise<void> {
	if (!conn) {
		throw new Error('Database connection not initialized');
	}

	// Create features table with dataset_id column
	await conn.query(`
		CREATE TABLE IF NOT EXISTS features (
			dataset_id TEXT,
			source_url TEXT,
			geometry GEOMETRY,
			properties TEXT
		)
	`);

	// Create datasets metadata table
	await conn.query(`
		CREATE TABLE IF NOT EXISTS datasets (
			id TEXT PRIMARY KEY,
			source_url TEXT,
			name TEXT,
			color TEXT,
			visible BOOLEAN,
			hidden BOOLEAN DEFAULT false,
			feature_count INTEGER,
			loaded_at TIMESTAMP,
			style TEXT,
			source_crs TEXT
		)
	`);

	// Schema version tracking
	await conn.query(`
		CREATE TABLE IF NOT EXISTS meta (
			key TEXT PRIMARY KEY,
			value TEXT
		)
	`);
	await conn.query(`
		INSERT INTO meta (key, value) VALUES ('schema_version', '${SCHEMA_VERSION}')
		ON CONFLICT (key) DO NOTHING
	`);

	// Migration: add layer_order column (non-destructive, no schema version bump)
	await conn.query(`
		ALTER TABLE datasets ADD COLUMN IF NOT EXISTS layer_order INTEGER DEFAULT 0
	`);

	// Migration: add format and source_layer columns for PMTiles support (non-destructive)
	await conn.query(`
		ALTER TABLE datasets ADD COLUMN IF NOT EXISTS format TEXT DEFAULT NULL
	`);
	await conn.query(`
		ALTER TABLE datasets ADD COLUMN IF NOT EXISTS source_layer TEXT DEFAULT NULL
	`);

	// Migration: add is_spatial column for non-spatial (table-only) datasets
	await conn.query(`
		ALTER TABLE datasets ADD COLUMN IF NOT EXISTS is_spatial BOOLEAN DEFAULT true
	`);

	// Backfill layer_order for existing rows that still have the default (0)
	await conn.query(`
		UPDATE datasets SET layer_order = sub.rn
		FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY loaded_at ASC) as rn
		      FROM datasets WHERE layer_order = 0) sub
		WHERE datasets.id = sub.id AND datasets.layer_order = 0
	`);

	// Operation metadata for config reconstruction
	await conn.query(`
		CREATE TABLE IF NOT EXISTS operations (
			output_id TEXT PRIMARY KEY,
			type TEXT NOT NULL,
			inputs_json TEXT NOT NULL,
			params_json TEXT,
			exec_order INTEGER NOT NULL
		)
	`);

	// Create spatial index for geometry queries (bounding box, intersections, etc.)
	await conn.query(`
		CREATE INDEX IF NOT EXISTS features_geom_idx ON features USING RTREE (geometry)
	`);

	console.log('[DuckDB] Schema initialized with spatial indexing');
}

/**
 * Validate the persisted schema version.
 * Returns true if the schema matches, false if it's stale and was wiped.
 */
async function validateSchema(): Promise<boolean> {
	if (!conn) return false;

	try {
		const result = await conn.query(`SELECT value FROM meta WHERE key = 'schema_version'`);
		const rows = result.toArray();
		if (rows.length > 0 && rows[0].value === SCHEMA_VERSION) {
			console.log(`[DuckDB] OPFS schema version ${SCHEMA_VERSION} — valid`);
			return true;
		}
	} catch {
		// meta table doesn't exist or query failed — stale schema
	}

	console.warn('[DuckDB] Stale or missing schema — wiping OPFS database');
	await wipeSchema();
	return false;
}

/**
 * Drop all application tables so initSchema() can recreate them fresh.
 */
async function wipeSchema(): Promise<void> {
	if (!conn) return;
	await conn.query('DROP INDEX IF EXISTS features_geom_idx');
	await conn.query('DROP TABLE IF EXISTS features');
	await conn.query('DROP TABLE IF EXISTS datasets');
	await conn.query('DROP TABLE IF EXISTS operations');
	await conn.query('DROP TABLE IF EXISTS meta');
}

/**
 * Delete the OPFS database file. No-op if it doesn't exist.
 */
async function deleteOPFSFile(): Promise<void> {
	try {
		const root = await navigator.storage.getDirectory();
		await root.removeEntry(OPFS_FILE_NAME);
		console.log('[DuckDB] OPFS file deleted');
	} catch {
		// File may not exist — that's fine
	}
}

/**
 * Try to open an OPFS-backed database with one automatic retry.
 * On first failure, wipes the OPFS file and retries with a clean slate.
 * Returns true if OPFS succeeded, false to fall through to in-memory.
 */
async function tryOpenOPFS(
	bundle: { mainModule: string; mainWorker?: string | null; pthreadWorker?: string | null },
	voidLogger: duckdb.VoidLogger
): Promise<boolean> {
	for (let attempt = 1; attempt <= 2; attempt++) {
		try {
			if (attempt === 2) {
				logInitStep('Retrying OPFS with clean database...');
			} else {
				logInitStep('Opening OPFS database...');
			}

			await db!.open({
				path: OPFS_DB_PATH,
				accessMode: duckdb.DuckDBAccessMode.READ_WRITE,
			});
			conn = await db!.connect();

			// OPFS open can reset max_expression_depth to 0; restore a sane default.
			// If depth is already 0, even this SET fails (parser can't parse the literal).
			await conn.query('SET max_expression_depth TO 250');

			logInitStep('Loading spatial extension...');
			await conn.query('INSTALL spatial; LOAD spatial;');

			logInitStep('Validating schema...');
			const valid = await validateSchema();
			if (valid) {
				opfsHadExistingData = true;
			} else {
				logInitStep('Initializing schema...');
				await initSchema();
			}

			storageMode = 'opfs';
			fallbackReason = 'none';
			logInitStep('Database ready (OPFS)');
			console.log('[DuckDB] Initialized with OPFS persistence');
			return true;

		} catch (opfsError) {
			console.warn(`[DuckDB] OPFS attempt ${attempt} failed:`, opfsError);

			// Teardown broken instance
			try { if (conn) await conn.close(); } catch { /* ignore */ }
			conn = null;
			try { await db!.terminate(); } catch { /* ignore */ }

			if (attempt === 1) {
				// First failure: wipe the (likely corrupt) OPFS file and retry
				await deleteOPFSFile();
				const freshWorker = new Worker(bundle.mainWorker!);
				db = new duckdb.AsyncDuckDB(voidLogger, freshWorker);
				await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
				continue;
			}

			// Second failure: genuine browser/permission issue — give up on OPFS
			fallbackReason = 'opfs-failed';
			const freshWorker = new Worker(bundle.mainWorker!);
			db = new duckdb.AsyncDuckDB(voidLogger, freshWorker);
			await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
			return false;
		}
	}
	return false;
}

/**
 * Initialize DuckDB-WASM with spatial extension.
 * When useOPFS is true, attempts OPFS-backed persistence with automatic
 * wipe-and-retry on failure, then fallback to in-memory.
 */
/**
 * Detect Safari or mobile devices where the COI bundle's pthread workers
 * create excessive IPC channels that overwhelm Safari's Mach port limits.
 */
function shouldUseCOI(): boolean {
	if (typeof navigator === 'undefined') return true;
	// Safari is gated at the map.ts level (worker never created), but guard here too
	if (isSafari()) return false;
	// Mobile devices have tighter memory/IPC limits
	const ua = navigator.userAgent;
	if (/iPhone|iPad|iPod|Android/i.test(ua) || navigator.maxTouchPoints > 1) return false;
	return true;
}

export async function initDB(useOPFS: boolean = false): Promise<void> {
	try {
		logInitStep('Initializing database...');
		logInitStep('Resolving DuckDB bundle...');

		// Workers are self-hosted; WASM loads from jsDelivr (files exceed Cloudflare's 25MB limit)
		const cdnBundles = duckdb.getJsDelivrBundles();
		const useCoi = shouldUseCOI();
		const bundle = await duckdb.selectBundle({
			mvp: {
				mainModule: cdnBundles.mvp.mainModule,
				mainWorker: '/duckdb/duckdb-browser-mvp.worker.js',
			},
			eh: cdnBundles.eh ? {
				mainModule: cdnBundles.eh.mainModule,
				mainWorker: '/duckdb/duckdb-browser-eh.worker.js',
			} : undefined,
			coi: useCoi && cdnBundles.coi ? {
				mainModule: cdnBundles.coi.mainModule,
				mainWorker: '/duckdb/duckdb-browser-coi.worker.js',
				pthreadWorker: '/duckdb/duckdb-browser-coi.pthread.worker.js',
			} : undefined,
		});

		// Create worker directly from same-origin URL (no Blob wrapper needed)
		const worker = new Worker(bundle.mainWorker!);
		const voidLogger = new duckdb.VoidLogger();

		// Initialize database
		logInitStep('Downloading DuckDB engine...');
		db = new duckdb.AsyncDuckDB(voidLogger, worker);
		await db.instantiate(bundle.mainModule, bundle.pthreadWorker);

		if (useOPFS) {
			const opfsOk = await tryOpenOPFS(bundle, voidLogger);
			if (opfsOk) return;
		} else {
			fallbackReason = 'disabled';
		}

		// In-memory path (default or OPFS fallback)
		conn = await db.connect();
		logInitStep('Loading spatial extension...');
		await conn.query('INSTALL spatial; LOAD spatial;');
		logInitStep('Initializing schema...');
		await initSchema();
		storageMode = 'memory';
		logInitStep('Database ready (in-memory)');
		console.log('[DuckDB] Initialized in-memory');
	} catch (error) {
		console.error('Failed to initialize DuckDB-WASM:', error);
		throw error;
	}
}

/**
 * Get the current storage mode ('opfs' or 'memory').
 */
export function getStorageMode(): 'opfs' | 'memory' {
	return storageMode;
}

/**
 * Get the reason why we're running in-memory (if we are).
 */
export function getFallbackReason(): FallbackReason {
	return fallbackReason;
}

/**
 * Set the fallback reason externally (e.g. when a QuotaExceededError is caught).
 */
export function setFallbackReason(reason: FallbackReason): void {
	fallbackReason = reason;
}

/**
 * Whether the OPFS database had existing valid data on startup.
 */
export function hasExistingOPFSData(): boolean {
	return opfsHadExistingData;
}

/**
 * Clear the OPFS database file and reload the page.
 * Used for "Clear Session" and "Clear & Retry" recovery.
 */
export async function clearOPFS(): Promise<void> {
	try { if (conn) { await conn.close(); conn = null; } } catch { /* ignore */ }
	try { if (db) { await db.terminate(); db = null; } } catch { /* ignore */ }
	await deleteOPFSFile();
	location.reload();
}

/**
 * Export the raw OPFS database file as a Uint8Array for download.
 * Checkpoints the WAL first to ensure all data is flushed.
 */
export async function exportOPFSFile(): Promise<Uint8Array> {
	if (storageMode !== 'opfs') {
		throw new Error('Cannot export: database is not using OPFS persistence');
	}
	await checkpoint();
	const root = await navigator.storage.getDirectory();
	const fileHandle = await root.getFileHandle(OPFS_FILE_NAME);
	const file = await fileHandle.getFile();
	const buffer = await file.arrayBuffer();
	return new Uint8Array(buffer);
}

/**
 * Import a database file into OPFS, replacing the current session.
 * Closes the current DB and writes the uploaded file. Does NOT reload —
 * the main thread handles location.reload() after this resolves.
 */
export async function importOPFSFile(buffer: Uint8Array): Promise<void> {
	// Close current DB
	try { if (conn) { await conn.close(); conn = null; } } catch { /* ignore */ }
	try { if (db) { await db.terminate(); db = null; } } catch { /* ignore */ }

	// Replace the OPFS file
	await deleteOPFSFile();
	const root = await navigator.storage.getDirectory();
	const fileHandle = await root.getFileHandle(OPFS_FILE_NAME, { create: true });
	const writable = await fileHandle.createWritable();
	await writable.write(buffer.buffer as ArrayBuffer);
	await writable.close();
}

/**
 * Ensure DB is fully initialized (schema + spatial extension).
 * Reuses the in-flight promise if init was already triggered.
 */
export async function ensureInit(): Promise<void> {
	if (!initPromise) {
		// Fallback: if no one called initDB() yet, default to in-memory
		initPromise = initDB(false);
	}
	await initPromise;
}

/**
 * Start initialization and store the promise for ensureInit() to reuse.
 * Called from map.ts after reading the data-persistence attribute.
 */
export function startInit(useOPFS: boolean): void {
	if (!initPromise) {
		initPromise = initDB(useOPFS);
	}
}

/**
 * Get database instance
 */
export async function getDB(): Promise<duckdb.AsyncDuckDB> {
	await ensureInit();
	return db!;
}

/**
 * Get database connection
 */
export async function getConnection(): Promise<duckdb.AsyncDuckDBConnection> {
	await ensureInit();
	return conn!;
}

/**
 * Execute SQL query
 */
export async function query(sql: string): Promise<any> {
	const connection = await getConnection();
	const result = await connection.query(sql);
	return result.toArray();
}

/**
 * Flush WAL to the OPFS database file.
 * DuckDB-WASM auto-checkpoints after large writes but small UPDATE statements
 * (color, style, visibility) may sit in the WAL unflushed. Call this after
 * metadata mutations to ensure persistence survives page close.
 * No-op when running in-memory.
 */
export async function checkpoint(): Promise<void> {
	if (storageMode !== 'opfs') return;
	try {
		const connection = await getConnection();
		await connection.query('CHECKPOINT');
	} catch (error) {
		console.warn('[DuckDB] Checkpoint failed:', error);
	}
}

/**
 * Compact the database to reclaim freed pages.
 * In-memory mode: DuckDB's buffer pool grows monotonically - DELETE frees pages
 * for reuse but never returns memory to the browser. VACUUM rebuilds tables and
 * releases unused pages back to the allocator.
 * OPFS mode: CHECKPOINT flushes WAL, then VACUUM compacts the database file.
 */
export async function vacuum(): Promise<void> {
	try {
		const connection = await getConnection();
		if (storageMode === 'opfs') {
			await connection.query('CHECKPOINT');
		}
		await connection.query('VACUUM');
	} catch (error) {
		console.warn('[DuckDB] Vacuum failed:', error);
	}
}
