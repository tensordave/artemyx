# Roadmap

This document tracks planned features, implementation phases, and the development backlog.

For completed work, see [CHANGELOG.md](CHANGELOG.md).

**Release strategy:** This public repo tracks semver releases only - commits correspond to changelog entries.

## Completed

### v0.1.0
- **Config Loading + Map Init**
- **Dataset Loading from Config**
- **Operations Framework** - Parse `operations`, build dependency graph, topological sort
- **Buffer Operation** - ST_Buffer with meter-to-degree conversion, dissolve via ST_Union_Agg

### v0.2.0
- **Computed Layers Rendering** - Decouple sources from layers, explicit layer config with expressions
- **Spatial Operations** - Full operation coverage via DuckDB Spatial: buffer (dissolve, quadSegs), intersection (filter/clip), union (merge/dissolve), difference (subtract/exclude), contains (filter/within), distance (filter/annotate), centroid; multi-unit support; Kahn's algorithm for dependency ordering
- **UI Polish** - Bug fixes (color picker, layer visibility, layer delete), progress control idle timer, human-readable dataset names, Phosphor SVG icons, compact top bar, landing page with live demo embed and expandable YAML config

### v0.3.0
- **Persistence (OPFS)** - OPFS-backed DuckDB surviving page refresh; session restore with visibility state; quota-safe writes; StorageControl with multi-tab detection; full fallback and error handling

### v0.3.1
- **Sandbox** - `/app` is now a blank slate (basemap + controls, no datasets loaded); previous full Vancouver demo moved to `/test` as a hidden dev route using `test-config.yaml`; all pages now use explicit `data-config` attributes; default config path updated to `app-config.yaml`

### v0.3.2
- **Examples Page** - `/examples` with dynamic Astro static routes (`[slug].astro` + `getStaticPaths()`), central registry at `src/scripts/examples/registry.ts`, left sidebar with grouped navigation, full-height map pane, bottom sheet config viewer with Shiki syntax highlighting at build time, mobile collapsible sidebar (hamburger, structured for v0.4.x header refactor); OPFS disabled on all example maps; all 8 Core Operations examples fully populated: buffer/dissolve (Vancouver), intersection/clip (San Francisco), union/merge (Portland), difference (Ottawa), contains/within (Winnipeg), distance/filter (Chicago), distance/annotate (Calgary), centroid (Denver)

### v0.3.3
- **Examples UX polish** - Close button inside the mobile sidebar overlay (previously could only dismiss by tapping a nav link); hamburger toggle repositioned from top-left (overlapping MapLibre layer controls) to mid-left as a flush edge tab, vertically centered

### v0.3.4
- **Advanced workflow + styling examples** - Interpolate expression styling (Vancouver parks by hectare size - 5-stop green ramp); match expression styling (Victoria road network by classification - 11 road classes with hierarchy-aware line widths); multi-dataset layers (Surrey, Burnaby, and New Westminster parks and active transportation - 7 datasets across 3 municipalities with per-city color palettes); multi-step workflow (Edmonton schools + transit - union, buffer, and intersection chained)

## Roadmap

### v0.4.x - Data, UX, and Foundation

- **Responsive header with hamburger menu** - Refactor the global header for narrow viewports; below ~768px the nav collapses into a hamburger menu: on examples pages it exposes the examples sidebar navigation, on all other pages it exposes About, App, and GitHub links; replaces the temporary per-layout toggle button introduced in v0.3.2
- **Dataset layer reordering** - Drag-and-drop layer order in the layer control panel
- **Paginated GeoJSON fetching** - Stream pages directly into DuckDB as they arrive; detect pagination via `exceededTransferLimit` (ArcGIS), `$offset/$limit` (Socrata), `next` link (OGC API Features)
- **Additional format support** - Load CSV files with lat/lng columns, plain JSON arrays with coordinate properties, and GeoParquet directly from URLs; support for download/file endpoints for CSV (with lat/lng), GeoParquet, GeoJSON
- **Local file upload** - Drag-and-drop or file picker for loading local files (GeoJSON, CSV, GeoParquet) directly onto the map without requiring a hosted URL
- **Download URL handling** - Properly handle file download endpoints (Content-Disposition attachments, direct file links) that don't return inline JSON; detect and follow download redirects; complements paginated fetching and format support
- **Scale bar** - Add MapLibre `ScaleControl` for distance reference; metric/imperial toggle
- **`attribute` operation** - Custom SQL filtering/transformation on a single dataset (e.g., keep only features where `streetuse = 'Arterial'`); complements MapLibre filter expressions with data-level filtering
- **Geocoding / address search** - Navigate to a place by name; Nominatim or Photon integration; search bar in or near the map controls
- **Hover tooltips** - Show feature properties on cursor hover as a lightweight tooltip, distinct from the existing click popup; configurable per layer
- **Mouse coordinate display** - Show lat/lng of cursor position in map corner; toggleable
- **Operation progress indicator** - Spinner or "processing" state during long-running operations to avoid appearing frozen
- **Progress history improvements** - Smarter URL label extraction for well-known portal patterns (Socrata, ArcGIS REST, OGC); horizontal scrolling for long messages; clear history button in expanded panel header
- **Async error messaging** - User-friendly error messaging for failed operations instead of silent failures
- **Attribution styling** - Restyle MapLibre and CARTO attribution for dark mode
- **artemyx attribution** - Add artemyx to the attribution area
- **Operation naming** - `name` field for GIS operations in `map-config.yaml`
- **Paint/layout validation** - Per-type validation of `paint`/`layout` properties at config load time
- **Parser refactor** - Review and simplify `parser.ts`
- **CSS refactor** - Reorganize `global.css` into logical styling groups
- **Unit test expansion** - Coverage for `db.ts` (dataset ID generation, bulk insert, query performance); establish testing patterns alongside new feature work going forward

### v0.5.x - Styling Overhaul

Goal: replace the current split between the color button and numeric style inputs with a unified, layer-aware style panel.

- **Unified style panel** - Single control surface per layer; color picker and style inputs side by side, not separate controls
- **Opacity control** - Per-layer opacity slider in the style panel, separate from color; applies to the appropriate paint property by geometry type (fill-opacity, line-opacity, circle-opacity)
- **Layer-type awareness** - Show only relevant controls based on geometry type (fill opacity for polygons, line width for lines, point radius for points); fix style panel overlap with the layer row below
- **Expression-aware overrides** - Expression-driven properties shown as disabled with an "Expression" badge; toggle lets user replace the expression with a flat GUI value for that property
- **Layer Expression Editor** - Raw MapLibre expression input per layer paint property; JSON validation before applying; updates MapLibre directly without modifying the config file
- **Labels** - Per-layer label configuration in the style panel; select an attribute for `text-field`, adjust font size, halo, and placement; renders as MapLibre `symbol` layer type alongside the data layer
- **Legend** - Auto-generated legend panel derived from active layer styles; shows color swatches for flat colors, ramp previews for interpolate expressions, and category swatches for match expressions; toggleable overlay or docked panel

### v0.6.x - Performance, Export, and Sharing

- **Cumulative feature count guard** - Track running feature total during OPFS restore; skip rendering datasets beyond threshold with a progress message (data stays in OPFS for operations); stopgap until deck.gl
- **Worker-based dataset loading** - Move fetch + DuckDB insert pipeline into a Web Worker so the map and controls remain responsive during large loads
- **Safari/iOS OPFS persistence** - Run DuckDB-WASM OPFS file access through a dedicated worker to satisfy Safari's requirement that `createSyncAccessHandle()` only be called from worker context; unblocks full persistence on iOS/iPadOS Safari and all WebKit-based browsers
- **Feature selection** - Click or box-select features on the map to create a subset dataset; selected features visually distinguished; selection available as input to operations
- **Feature generalization (LOD)** - `ST_Simplify(geometry, tolerance)` with tolerance scaled to zoom level
- **Viewport streaming** - Load only features visible in current extent via `ST_Intersects(geometry, ST_MakeEnvelope(west, south, east, north))`
- **Bounds query optimization** - Replace coordinate iteration with `SELECT ST_Envelope(ST_Union_Agg(geometry)) FROM features WHERE dataset_id = ?`
- **Geometry validation** - `ST_IsValid` + `ST_MakeValid` on load to catch and repair invalid geometries
- **Export** - Export datasets as GeoJSON, CSV, or Parquet
- **Export config** - Generate reproducible YAML from current session state
- **URL state sharing** - Serialize session (datasets, layers, paint, operations) into URL parameters for shareable links without needing a repo or exported YAML

### v0.7.x - Robustness and Richness

- **YAML snippet runner** - In-browser panel for pasting a single operation block in standard config YAML syntax; executes against loaded datasets; output appears as a new auto-styled layer; no new syntax - same format as `map-config.yaml`; pairs with Export Config for an interactive-to-reproducible workflow
- **Parquet/GeoParquet support** - Fetch and load via DuckDB's built-in reader
- **CRS support** - Detect and reproject to web mercator
- **Tabular view** - Bottom panel with sortable, filterable data grid; row click highlights feature on map
- **`join` operation** - Tabular join: attach a CSV or JSON dataset to a spatial dataset by a shared key field; enables workflows like coloring parcels by census data or enriching transit stops with ridership counts; config references a tabular `source`, a spatial `target`, and an `on` key; joined properties merged into the output feature's attributes
- **`spatial-join` operation** - Attach attributes from layer B to layer A based on geometric relationship (intersects, contains, nearest); distinct from tabular join - no shared key required, relationship is spatial; e.g., tag parcels with their containing neighbourhood or find the nearest transit stop to each school
- **Undo/redo** - Session history stack for operations and dataset changes; step backward and forward through state; covers dataset loads, operation executions, and layer modifications
- **Statistics panel** - Per-dataset summary statistics: feature count, and for numeric attribute columns, min/max/mean/median; accessible from the layer control
- **Measurement tools** - Distance, area, bearing calculations
- **Keyboard shortcuts** - L (layer control), P (progress), Esc (close), Delete (remove feature)
- **ARIA labels** - Accessibility improvements for `layer-control.ts`

### v0.8.x - deck.gl Renderer

- **deck.gl renderer** - Optional `renderer: deckgl` layer type for large-scale or advanced visualizations (heatmaps, hexbin aggregation, arc/flow layers, 3D extrusion); runs as a MapLibre overlay via `MapboxOverlay` adapter, parallel to the existing MapLibre layer pipeline; only warranted at scale or for visualization types MapLibre can't handle

### v0.9.x - Headless CLI

- **Headless CLI runner** - Run artemyx pipelines from the command line without a browser; likely a monorepo split (`app/`, `cli/`, `packages/core/`) or a separate repo with its own versioning and Docker support

  **Architecture:**
  - Monorepo split: `app/` (current Astro browser app), `cli/` (Node.js runner), `packages/core/` (shared config parsing, operations graph, types)
  - Swap `duckdb-wasm` for native `duckdb` Node.js bindings - faster, no WASM overhead, handles larger datasets, same spatial extension API
  - No MapLibre dependency - pipeline outputs files directly, rendering is optional
  - Node `fetch` replaces browser fetch for dataset URL loading

  **Usage:**
  ```bash
  npx artemyx run map-config.yaml --output ./results
  # outputs: results/bikeway_walkshed.geojson
  #          results/parcels_filtered.csv
  #          results/analysis.parquet
  #          results/bikeway_walkshed.pmtiles   (with --tiles flag)
  ```

  **PMTiles output** - CLI-only feature: pass `--tiles` to generate a PMTiles archive from any operation output alongside the data files; uses tippecanoe or a native Node.js PMTiles writer; tile zoom range configurable per dataset; generated `.pmtiles` files can be served statically and loaded directly into the artemyx web app as a custom basemap or overlay source - closing the loop from browser analysis to reproducible tiled output

  **Enables:**
  - Scheduled execution (cron, CI/CD pipelines)
  - Triggered re-runs when source data updates
  - Reproducible analysis as part of a data pipeline
  - Git-native: config in version control, outputs generated on demand
  - Static tile publishing: push `.pmtiles` to S3/R2/GitHub Pages, load in browser with no tile server
  - Zero-infrastructure self-updating maps: GitHub Actions runs the pipeline on a schedule, commits output PMTiles to the repo, GitHub Pages serves them via HTTP range requests - no backend, no tile server, no cloud bill

## Backlog (Unscheduled)

Items worth building eventually but not yet assigned to a version:

- **Custom basemap tile URL** - Let users point at their own tile server (self-hosted MapTiler, PMTiles, WMS) via config or UI; extends the existing basemap switcher; pairs with the CLI's PMTiles output for a full static publish-and-load workflow
- **Screenshot / print export** - Export current map view as PNG via `map.getCanvas().toDataURL()`; useful for reports and presentations
- **Bookmarks** - Named saved views (center, zoom, active layers, paint state); useful for multi-site projects or returning to a specific area
- **Multi-config loading** - Load an additional YAML on top of the current session, merging datasets and layers; enables composing configs without editing files
- **Drawing / digitizing** - Draw points, lines, and polygons directly on the map; output as a new dataset available for operations
- **PWA / offline support** - Service worker caching of app shell and tile assets for offline use; aligns with the static-first approach

## Testing Notes

Manual test scenarios that are difficult to trigger in normal use:

- **Large dataset OPFS reliability** - Restoring ~1.1M features (4 large manual datasets) from OPFS causes "Uncaught out of memory" in Firefox (~17GB RAM spike). Root cause: `getFeaturesAsGeoJSON` had a `JSON.parse(JSON.stringify())` deep clone creating ~3x peak memory per dataset, compounded across multiple large datasets being restored sequentially. The deep clone has been removed. Remaining risk: cumulative MapLibre GeoJSON source memory for 1M+ features is inherently high - a cumulative feature count guard (see Performance Optimizations) and eventually the deck.gl renderer are the proper mitigations.
