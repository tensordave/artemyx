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

const SCHEMA_VERSION = '2';
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

/**
 * Initialize database schema for multi-dataset support
 */
async function initSchema(): Promise<void> {
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
			style TEXT
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
	await conn.query('DROP TABLE IF EXISTS meta');
}

/**
 * Initialize DuckDB-WASM with spatial extension.
 * When useOPFS is true, attempts OPFS-backed persistence with automatic
 * fallback to in-memory on any failure.
 */
export async function initDB(useOPFS: boolean = false): Promise<void> {
	try {
		// Workers are self-hosted; WASM loads from jsDelivr (files exceed Cloudflare's 25MB limit)
		const cdnBundles = duckdb.getJsDelivrBundles();
		const bundle = await duckdb.selectBundle({
			mvp: {
				mainModule: cdnBundles.mvp.mainModule,
				mainWorker: '/duckdb/duckdb-browser-mvp.worker.js',
			},
			eh: cdnBundles.eh ? {
				mainModule: cdnBundles.eh.mainModule,
				mainWorker: '/duckdb/duckdb-browser-eh.worker.js',
			} : undefined,
			coi: cdnBundles.coi ? {
				mainModule: cdnBundles.coi.mainModule,
				mainWorker: '/duckdb/duckdb-browser-coi.worker.js',
				pthreadWorker: '/duckdb/duckdb-browser-coi.pthread.worker.js',
			} : undefined,
		});

		// Create worker directly from same-origin URL (no Blob wrapper needed)
		const worker = new Worker(bundle.mainWorker!);
		const logger = new duckdb.VoidLogger();

		// Initialize database
		db = new duckdb.AsyncDuckDB(logger, worker);
		await db.instantiate(bundle.mainModule, bundle.pthreadWorker);

		if (useOPFS) {
			try {
				await db.open({
					path: OPFS_DB_PATH,
					accessMode: duckdb.DuckDBAccessMode.READ_WRITE
				});
				conn = await db.connect();
				await conn.query('INSTALL spatial; LOAD spatial;');

				// Check if this is an existing DB with a valid schema
				const valid = await validateSchema();
				if (valid) {
					opfsHadExistingData = true;
				} else {
					await initSchema();
				}

				storageMode = 'opfs';
				fallbackReason = 'none';
				console.log('[DuckDB] Initialized with OPFS persistence');
				return;
			} catch (opfsError) {
				console.warn('[DuckDB] OPFS failed, falling back to in-memory:', opfsError);
				fallbackReason = 'opfs-failed';
				// Reset state for in-memory fallback
				conn = null;
			}
		} else {
			fallbackReason = 'disabled';
		}

		// In-memory path (default or OPFS fallback)
		conn = await db.connect();
		await conn.query('INSTALL spatial; LOAD spatial;');
		await initSchema();
		storageMode = 'memory';
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
	// Close connection and database before deleting
	try {
		if (conn) {
			await conn.close();
			conn = null;
		}
		if (db) {
			await db.terminate();
			db = null;
		}
	} catch (e) {
		console.warn('[DuckDB] Error closing DB before OPFS clear:', e);
	}

	// Delete the OPFS file
	try {
		const root = await navigator.storage.getDirectory();
		await root.removeEntry(OPFS_FILE_NAME);
		console.log('[DuckDB] OPFS file deleted');
	} catch (e) {
		// File may not exist — that's fine
		console.warn('[DuckDB] Could not delete OPFS file (may not exist):', e);
	}

	// Reload to start fresh
	location.reload();
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
