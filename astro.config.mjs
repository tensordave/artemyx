// @ts-check
import { defineConfig } from 'astro/config';
import { viteStaticCopy } from 'vite-plugin-static-copy';

const DUCKDB_DIST = 'node_modules/@duckdb/duckdb-wasm/dist';

// https://astro.build/config
export default defineConfig({
	vite: {
		plugins: [
			viteStaticCopy({
				targets: [
					{ src: `${DUCKDB_DIST}/duckdb-mvp.wasm`, dest: 'duckdb' },
					{ src: `${DUCKDB_DIST}/duckdb-browser-mvp.worker.js`, dest: 'duckdb' },
					{ src: `${DUCKDB_DIST}/duckdb-eh.wasm`, dest: 'duckdb' },
					{ src: `${DUCKDB_DIST}/duckdb-browser-eh.worker.js`, dest: 'duckdb' },
					{ src: `${DUCKDB_DIST}/duckdb-coi.wasm`, dest: 'duckdb' },
					{ src: `${DUCKDB_DIST}/duckdb-browser-coi.worker.js`, dest: 'duckdb' },
					{ src: `${DUCKDB_DIST}/duckdb-browser-coi.pthread.worker.js`, dest: 'duckdb' },
				]
			})
		],
		optimizeDeps: {
			include: ['maplibre-gl'],
			esbuildOptions: {
				target: 'esnext'
			}
		},
		build: {
			target: 'esnext'
		}
	}
});
