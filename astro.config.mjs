// @ts-check
import { defineConfig } from 'astro/config';
import { viteStaticCopy } from 'vite-plugin-static-copy';

import cloudflare from '@astrojs/cloudflare';

const DUCKDB_DIST = 'node_modules/@duckdb/duckdb-wasm/dist';

// https://astro.build/config
export default defineConfig({
  vite: {
      plugins: [
          // Workers are self-hosted; WASM files (~33MB each) exceed Cloudflare Pages'
          // 25MB asset limit so they load from jsDelivr CDN via getJsDelivrBundles()
          viteStaticCopy({
              targets: [
                  { src: `${DUCKDB_DIST}/duckdb-browser-mvp.worker.js`, dest: 'duckdb' },
                  { src: `${DUCKDB_DIST}/duckdb-browser-eh.worker.js`, dest: 'duckdb' },
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
	},

  adapter: cloudflare()
});