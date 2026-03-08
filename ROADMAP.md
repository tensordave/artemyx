# Roadmap

This document tracks planned features, implementation phases, and the development backlog.
Completed work is listed at the bottom. For full detail on each release, see [CHANGELOG.md](CHANGELOG.md).

## Roadmap

### v0.6.0 - Large Data Infrastructure

- **Cumulative feature count guard** - Track running feature total during OPFS restore; skip rendering datasets beyond threshold with a progress message (data stays in OPFS for operations); stopgap until v0.8.x auto-promote replaces this guard
- **Worker-based DuckDB pipeline** - Move fetch + DuckDB insert pipeline into a Web Worker so the map and controls remain responsive during large loads; run all DuckDB-WASM file access through the worker to satisfy Safari's `createSyncAccessHandle()` worker-only requirement, unblocking full OPFS persistence on iOS/iPadOS Safari and all WebKit-based browsers
- **Bounds query optimization** - Replace coordinate iteration with `SELECT ST_Envelope(ST_Union_Agg(geometry)) FROM features WHERE dataset_id = ?`
- **Geometry validation** - `ST_IsValid` + `ST_MakeValid` on load to catch and repair invalid geometries
- **Operation compute/render split** - Refactor each operation file in `config/operations/` to separate SQL execution (pure, returns GeoJSON) from MapLibre rendering (source/layer creation, popup handlers); executor.ts delegates rendering as a post-step; pure execution functions become the shared core for the v0.9.x CLI
- **Loader Response decoupling** - Refactor loader signatures from `load(response: Response)` to `load(data: string | object | ArrayBuffer)`; callers (data-actions) handle Response unwrapping; makes loaders usable from Node.js without polyfilling browser Response

### v0.6.1 - Config Editor

Goal: evolve ConfigControl from a read-only viewer into a full config editor. Import, edit, run, and export configs from a single panel - the same codeblock icon, same position, but with modes instead of separate controls.

- **Edit mode** - Toggle from Shiki-highlighted read-only view to a monospace textarea; "Run" button parses YAML via existing `config/parser.ts`, tears down current state (datasets, sources, layers), and re-runs the full pipeline; inline validation errors for invalid YAML or config; update landing page controls grid to reflect new config editor capabilities (edit, import, export vs view-only)
- **Import** - Paste or upload a `.yaml` file to replace the current config; equivalent to editing + running but from an external source
- **Export data** - Export datasets as GeoJSON, CSV, or Parquet
- **Export config** - Generate reproducible YAML from current session state; exported config uses the full author schema (datasets, operations, layers); this is the same config the CLI consumes
- **Export viewer config** - Generate a viewer-only YAML from current session: datasets pointing to exported files + layer definitions; no operations or outputs (data is pre-baked); pairs with CLI's `--viewer-config` output for the same purpose
- **Clean teardown** - New function to remove all datasets, sources, and layers from DuckDB and MapLibre; required by edit/import to reset state before re-running a config
- **External PMTiles loading** - Register the `pmtiles://` protocol handler on map init; allow `pmtiles://` URLs in `DatasetConfig` as a tiled vector source; enables loading externally hosted PMTiles files (open data portals, self-hosted, GitHub Pages); bridges to in-browser PMTiles generation in v0.7.0

### v0.6.2 - Config Generation

- **Generate config from session** - "Generate" button in the config editor toolbar; reads current map state (datasets, styles, operations, layers) and serializes to YAML; populates the editor textarea so the user can review, tweak, and re-run; file-uploaded datasets emit a placeholder comment since they have no URL to reference; reads paint properties back from MapLibre via `getPaintProperty()` for manually adjusted styles
- **Preserve local datasets on re-run** - When the config pipeline tears down and re-runs, file-uploaded datasets (no URL) are kept in DuckDB untouched; teardown skips them, and the pipeline treats them as already-loaded (same `datasetExists()` check used for OPFS restore); the placeholder comment in generated YAML is cosmetic only and does not affect the running session

### v0.6.3 - Operations Builder

Goal: form-based UI for running spatial operations without writing YAML. Dedicated control (top-right, alongside DataControl and ConfigControl) with a Phosphor icon.

- **Operation form** - Dropdown for operation type; input dropdown(s) populated from loaded datasets (one for unary ops, two for binary); type-specific parameter fields (distance + unit for buffer, mode for intersection, etc.); output name text input; "Run" button executes via existing operation pipeline; add to landing page controls grid
- **Generated YAML preview** - Show the equivalent YAML snippet below the form as a learning aid; users see the config syntax for what they just built visually

### v0.7.0 - In-browser PMTiles Generation

Goal: generate PMTiles archives directly in the browser from any DuckDB-backed dataset, enabling MapLibre to render large datasets as tiled vector sources rather than monolithic GeoJSON; zoom-level simplification and viewport streaming come for free via the tile protocol.

- **`outputs:` config section** - Top-level `outputs:` key in `MapConfig` declaring dataset output formats; `format: geojson | csv | parquet | pmtiles` with format-specific options (PMTiles: `minzoom`, `maxzoom`, `layerName`); this is the contract between the full app, CLI, and viewer - the same config drives all three
- **Tiling pipeline** - Worker-based pipeline off main thread: `getFeaturesAsGeoJSON()` -> `geojson-vt` (tiles and simplifies per zoom level) -> `vt-pbf` (encodes as MVT protobuf) -> `pmtiles` writer (packs archive); progress surfaced in ProgressControl during generation
- **OPFS PMTiles cache** - Generated `.pmtiles` files persisted in OPFS alongside the DuckDB database; restored on session reload without regeneration; invalidated when source dataset changes; `StorageControl` panel updated to surface PMTiles cache size alongside DB size
- **MapLibre vector source wiring** - Tiled datasets use a MapLibre `vector` source pointing to the OPFS `pmtiles://` path instead of a `geojson` source; layer config requires a `source-layer` matching the declared `layerName`

### v0.7.1 - Accessibility and Shortcuts

- **Keyboard shortcuts** - L (layer control), P (progress), Esc (close), Delete (remove feature), WASD for panning map, R/F to zoom in and out
- **ARIA labels** - Accessibility improvements for `layer-control.ts`

### v0.8.0 - deck.gl Core Integration

Goal: establish the full deck.gl integration path using GeoJsonLayer as the initial renderer type, handling all geometry types (polygon, line, point) in parallel with the existing MapLibre pipeline.

- **`MapboxOverlay` manager** - Singleton `DeckGLManager` (`src/scripts/deckgl/manager.ts`) holds the `MapboxOverlay` instance added to the map on load; exposes `addLayer`, `removeLayer`, `updateLayer`; composites all deck.gl layers into a single WebGL context; deck.gl loaded via dynamic `import()` only when first deck.gl layer is requested to avoid bundling cost when unused
- **Config schema: `renderer` field** - Optional `renderer: maplibre | deckgl` on `LayerConfig` (defaults to `maplibre`); `deckProps` passthrough for raw deck.gl layer props (color accessors, radius scale, etc.) that have no MapLibre paint equivalent; parser validation rejects deck.gl-only `type` values when `renderer: maplibre` and vice versa
- **Layer creation branch** - `executeLayersFromConfig` in `layers.ts` branches on `renderer`: MapLibre path unchanged; deck.gl path constructs a `GeoJsonLayer` spec and calls the manager; both paths feed data from `getFeaturesAsGeoJSON` initially
- **Layer registry** - Small dataset-ID-to-renderer map shared between the manager and `layer-actions/`; enables visibility, color, and delete actions to route to the correct API without per-action renderer detection
- **Layer control renderer-awareness** - `visibility.ts`, `color.ts`, and `delete.ts` in `layer-actions/` consult the registry; call deck.gl manager when deck.gl-managed instead of MapLibre style API
- **Popup/hover parity** - `attachDeckHoverHandlers` / `attachDeckClickHandlers` wired via deck.gl `onHover` / `onClick` callbacks on the layer spec; reuse existing popup DOM and CSS from `popup.ts`; matches current MapLibre popup behavior for feature properties and layer name display

### v0.8.1 - Auto-promote and Feature Count Guard

- **Auto-promote large datasets** - Datasets exceeding a configurable feature count threshold (default: 50k) are automatically assigned `renderer: deckgl` using a `GeoJsonLayer`; explicit `renderer` in config always wins; threshold configurable via `map.deckglThreshold` in YAML
- **Retire cumulative feature count guard** - The render-skip guard from v0.6.x is removed; datasets previously skipped are auto-promoted to deck.gl instead of being excluded from rendering

### v0.8.2 - ArcLayer

- **`ArcLayer`** - Flow and OD (origin-destination) visualization; requires source and target coordinate columns in feature properties; distinct from GeoJsonLayer line rendering - draws curved great-circle arcs between point pairs

### v0.9.0 - Monorepo Split and Shared Core

Goal: restructure the codebase into a monorepo with a shared core package, preparing the foundation for the CLI and viewer. No new user-facing features - this is a structural release.

- **Monorepo setup** - pnpm/npm workspaces with `packages/core/`, `apps/app/` (current Astro browser app), `apps/viewer/` (placeholder), `apps/cli/` (placeholder)
- **`packages/core/`** - Extract shared modules: config types, parser (with pluggable loader), operations graph, operation SQL functions (compute-only, no render), loader parsers (data in, GeoJSON out), logger interface, unit conversion, DB query builders and schema definitions
- **`apps/app/`** - Current browser app, imports from `@artemyx/core`; browser-specific code stays here: MapLibre integration, DuckDB-WASM initialization, OPFS persistence, UI controls, popup handlers, rendering side of operations
- **DB interface** - Abstract `DBAdapter` interface in core (`execute`, `prepare`, `registerFile`); WASM implementation in `apps/app/`, native DuckDB implementation added in v0.9.1; SQL queries written against the interface, not the driver

### v0.9.1 - Headless CLI

Goal: run artemyx pipelines from the command line without a browser.

  **Architecture:**
  - `apps/cli/` - Node.js runner importing `@artemyx/core`
  - Native `duckdb` Node.js bindings via the `DBAdapter` interface - faster, no WASM overhead, handles larger datasets, same spatial extension and SQL API
  - Node `fetch` for dataset URL loading; file:// support for local datasets
  - Console logger implementation of the core `Logger` interface
  - No MapLibre dependency - pipeline outputs files, no rendering

  **Usage:**
  ```bash
  npx artemyx run config.yaml --output ./results
  # reads: datasets, operations, outputs from config
  # writes: results/walksheds.geojson
  #         results/transit_access.parquet
  #         results/walksheds.pmtiles

  npx artemyx run config.yaml --output ./results --viewer-config ./viewer.yaml
  # also generates a viewer-ready config:
  #   datasets pointing to output files + layers from source config
  ```

  **PMTiles output** - Declared via `outputs:` config (same schema as v0.7.0 browser generation); uses tippecanoe or a native Node.js PMTiles writer; generated `.pmtiles` files served statically and loaded by the viewer

  **`--viewer-config`** - Generates a viewer-ready YAML: rewrites dataset URLs to point at output files, carries over layer definitions (or generates defaults), strips operations and outputs sections; this is the bridge from CLI processing to static viewer deployment

  **Enables:**
  - Scheduled execution (cron, CI/CD pipelines)
  - Triggered re-runs when source data updates
  - Reproducible analysis as part of a data pipeline
  - Git-native: config in version control, outputs generated on demand
  - Static tile publishing: push `.pmtiles` to S3/R2/GitHub Pages, load in browser with no tile server
  - Zero-infrastructure self-updating maps: GitHub Actions runs the pipeline on a schedule, commits output PMTiles to the repo, GitHub Pages serves them via HTTP range requests - no backend, no tile server, no cloud bill

### v0.9.2 - Lightweight Viewer

Goal: a minimal map app that renders pre-processed data without DuckDB, operations, or data loading UI.

  **Architecture:**
  - `apps/viewer/` - Astro static site importing `@artemyx/core` (config types, parser) + MapLibre + deck.gl
  - No DuckDB dependency - datasets are pre-processed GeoJSON, PMTiles, or GeoParquet served as static files
  - Reads viewer configs (generated by CLI `--viewer-config` or app "Export viewer config")
  - Config schema: `map` (center/zoom/basemap) + `datasets` (id/url/format) + `layers` (styling)

  **What it includes:**
  - MapLibre map with basemap switching
  - PMTiles protocol handler for tiled vector sources
  - deck.gl overlay for large datasets (shared `DeckGLManager` from v0.8.x)
  - Layer visibility toggle
  - Feature popups
  - Responsive layout

  **What it excludes:**
  - No DuckDB, no OPFS, no storage control
  - No DataControl (no URL loading)
  - No operations, no YAML snippet runner
  - No export (data is read-only)

  **Deployment model:**
  - CLI generates output files + viewer config
  - Viewer deployed as a static site (GitHub Pages, Netlify, S3)
  - Config and data files co-located or hosted separately (URLs in config)
  - Example GitHub Actions workflow: CLI runs on schedule, commits outputs, viewer rebuilds via Pages

## Backlog (Unscheduled)

Items worth building eventually but not yet assigned to a version:

- **Expression-aware overrides** - Expression-driven properties shown as disabled with an "Expression" badge; toggle lets user replace the expression with a flat GUI value for that property
- **Layer Expression Editor** - Raw MapLibre expression input per layer paint property; JSON validation before applying; updates MapLibre directly without modifying the config file
- **Feature generalization (LOD)** - `ST_Simplify(geometry, tolerance)` with tolerance scaled to zoom level; applies to GeoJSON-backed sources (superseded for tiled datasets by the PMTiles pipeline); may be removable once PMTiles is the default large-data path
- **Viewport streaming** - Load only features visible in current extent via `ST_Intersects(geometry, ST_MakeEnvelope(west, south, east, north))`; applies to GeoJSON-backed sources; may be removable once PMTiles is the default large-data path
- **URL state sharing** - Serialize session (datasets, layers, paint, operations) into URL parameters for shareable links without needing a repo or exported YAML
- **Feature selection** - Click or box-select features on the map to create a subset dataset; selected features visually distinguished; selection available as input to operations
- **Tabular view** - Bottom panel with sortable, filterable data grid; row click highlights feature on map
- **`join` operation** - Tabular join: attach a CSV or JSON dataset to a spatial dataset by a shared key field; enables workflows like coloring parcels by census data or enriching transit stops with ridership counts; config references a tabular `source`, a spatial `target`, and an `on` key; joined properties merged into the output feature's attributes
- **`spatial-join` operation** - Attach attributes from layer B to layer A based on geometric relationship (intersects, contains, nearest); distinct from tabular join - no shared key required, relationship is spatial; e.g., tag parcels with their containing neighbourhood or find the nearest transit stop to each school
- **Undo/redo** - Session history stack for operations and dataset changes; step backward and forward through state; covers dataset loads, operation executions, and layer modifications
- **Statistics panel** - Per-dataset summary statistics: feature count, and for numeric attribute columns, min/max/mean/median. Use Phosphor chart-bar icon. Top-left.
- **Measurement tools** - Distance, area, bearing calculations. Use Phosphor ruler icon. Top-left.
- **Collapsed tools menu** - Collapsible "tools" menu or grouped overflow control to keep the UI manageable on smaller screens without hiding functionality
- **Toggle for showing text beside icons** - Accessibility improvement for desktop mainly, a button to expand all buttons to show their text value (ie the tooltip button title)
- **Arrow binary data path** - `getFeaturesAsArrow()` in `features.ts` returns the raw Arrow table from DuckDB, bypassing `ST_AsGeoJSON` string serialization; coordinate columns extracted as `Float64Array` for direct consumption by deck.gl binary input format; eliminates the GeoJSON round-trip for large datasets
- **`ScatterplotLayer`** - deck.gl large point cloud rendering with radius scale and fill/stroke color accessors; suited for transit stops, parcel centroids, and other high-count point datasets
- **`HeatmapLayer`** - deck.gl GPU-accelerated continuous density; distinct from MapLibre's `heatmap` type, operates entirely on the deck.gl pipeline
- **`HexagonLayer`** - deck.gl aggregation hexbins; count or sum of features per cell; configurable radius and elevation scale
- **`ColumnLayer`** - deck.gl 3D vertical bars driven by a numeric property; pairs with `fill-extrusion` use cases that need deck.gl's rendering scale
- **`attribute` annotate mode** - Extend the `attribute` operation with a second mode that enriches features with computed properties via SQL expressions (e.g., derive a `category` field from `speed_limit` thresholds, or normalize a string column); structured params for simple computed fields, raw SQL expression escape hatch for advanced transformations; adds to the existing filter mode introduced in v0.4.0
- **Custom basemap tile URL** - Let users point at their own tile server (self-hosted MapTiler, PMTiles, WMS) via config or UI; extends the existing basemap switcher; pairs with the CLI's PMTiles output for a full static publish-and-load workflow
- **Screenshot / print export** - Export current map view as PNG via `map.getCanvas().toDataURL()`; useful for reports and presentations
- **Bookmarks** - Named saved views (center, zoom, active layers, paint state); useful for multi-site projects or returning to a specific area
- **Multi-config loading** - Load an additional YAML on top of the current session, merging datasets and layers; enables composing configs without editing files
- **Drawing / digitizing** - Draw points, lines, and polygons directly on the map; output as a new dataset available for operations
- **PWA / offline support** - Service worker caching of app shell and tile assets for offline use; aligns with the static-first approach
- **Shapefile support** - Load `.shp`/`.dbf` archives from URLs; requires an additional JS library (e.g., shpjs) for parsing multi-file ZIP archives; more involved than other format additions and likely requires download endpoint handling to be in place first
- **`geometryColumn` config field** - explicit geometry column name override on `DatasetConfig` for GeoParquet and similar tabular formats where auto-detection fails or is ambiguous; paired with an input in the load UI for manual datasets
- **Smarter URL label extraction** - Progress control currently shows raw URLs in loading messages; extract human-readable dataset names from well-known portal URL patterns (Socrata `/resource/<4x4>`, ArcGIS REST `/FeatureServer/0/query`, OGC `/collections/<id>/items`); fall back to hostname or full URL for unrecognized patterns
- **Scale bar unit config field** - `map.unit: metric | imperial` in YAML config to set the default scale bar unit for a given map; useful for configs targeting a specific regional audience; defaults to metric when omitted
- **Persist scale bar unit preference** - store the user's last-selected metric/imperial toggle choice in `localStorage`; restored on next session; overrides config default but can itself be overridden by explicit `map.unit` in config
- **Map Options Configurations** - give the ability for map-configs to specify what GUI features to enable/disable, like: storage controls, basemap picker, loading data, styling editor, etc.
- **DB mutation error feedback** - Surface failures from color, style, and visibility DB updates in the progress control; currently callers don't check return values, leaving the UI appearing to succeed when the DB write failed (hard to test - DB mutations have been rock-solid in practice)

## Completed

### v0.5.2 - Legend and Polish
- Auto-generated legend panel (color swatches, interpolate ramps, match categories), label config GUI fix for config-defined symbol layers, landing page controls grid update, mobile bug fixes (iOS input zoom, progress panel overflow, hamburger icon), map controls and style panel refactors

### v0.5.1 - Labels and Zoom Controls
- Per-layer label configuration in the style panel and YAML configs (`labelField`, `labelSize`, `labelColor`, `labelHaloColor`, `labelHaloWidth`); auto-detected symbol placement (point vs line-center); independent zoom ranges for geometry (`minzoom`/`maxzoom`) and labels (`labelMinzoom`/`labelMaxzoom`) with interactive sliders and YAML support; labels example (Calgary) and centroid example (Denver) updated

### v0.5.0 - Style Panel
- Drill-down style panel (color, opacity, width, radius) with layer-type-aware controls via DuckDB geometry queries, visibility eye icon, reorder highlight fix, debounced OPFS metadata persistence with WAL checkpoint, mobile colour picker fix and panel overflow, viewport persistence to localStorage

### v0.4.4 - Housekeeping
- CSS partial split, paint/layout style-spec validation, parser and load.ts module splits, config injection shared utility, unit test expansion (156 tests), example pagination, Logger interface decoupling pipeline code from ProgressControl

### v0.4.3 - Map Interactivity
- Geocoding search, dataset layer reordering, explicit layer order fix, mouse coordinate display, control styling overhaul, progress control init logging with database icon glow animation

### v0.4.2 - Data Loading Robustness
- Local file upload, paginated GeoJSON fetching (ArcGIS, Socrata, OGC), download URL handling, CRS detection and reprojection, DataControl advanced options, geodetically accurate spatial operations (UTM auto-projection), controls UX updates, import fixes

### v0.4.1 - Polish and Feedback
- View config map control, scale bar, attribution, progress control overhaul, basemap control move, mobile UX polish, landing page update

### v0.4.0
- Multi-format loading (GeoJSON, CSV, GeoParquet, JSON array), attribute operation, hover tooltips, layer fallback fix, operation naming, responsive header

### v0.3.4
- **Advanced workflow + styling examples** - Interpolate expression styling (Vancouver parks by hectare size - 5-stop green ramp); match expression styling (Victoria road network by classification - 11 road classes with hierarchy-aware line widths); multi-dataset layers (Surrey, Burnaby, and New Westminster parks and active transportation - 7 datasets across 3 municipalities with per-city color palettes); multi-step workflow (Edmonton schools + transit - union, buffer, and intersection chained)

### v0.3.3
- **Examples UX polish** - Close button inside the mobile sidebar overlay (previously could only dismiss by tapping a nav link); hamburger toggle repositioned from top-left (overlapping MapLibre layer controls) to mid-left as a flush edge tab, vertically centered

### v0.3.2
- **Examples Page** - `/examples` with dynamic Astro static routes (`[slug].astro` + `getStaticPaths()`), central registry at `src/scripts/examples/registry.ts`, left sidebar with grouped navigation, full-height map pane, bottom sheet config viewer with Shiki syntax highlighting at build time, mobile collapsible sidebar; OPFS disabled on all example maps; all 8 Core Operations examples fully populated: buffer/dissolve (Vancouver), intersection/clip (San Francisco), union/merge (Portland), difference (Ottawa), contains/within (Winnipeg), distance/filter (Chicago), distance/annotate (Calgary), centroid (Denver)

### v0.3.1
- **Sandbox** - `/app` is now a blank slate (basemap + controls, no datasets loaded); previous full Vancouver demo moved to `/test` as a hidden dev route using `test-config.yaml`; all pages now use explicit `data-config` attributes; default config path updated to `app-config.yaml`

### v0.3.0
- **Persistence (OPFS)** - OPFS-backed DuckDB surviving page refresh; session restore with visibility state; quota-safe writes; StorageControl with multi-tab detection; full fallback and error handling

### v0.2.0
- **Computed Layers Rendering** - Decouple sources from layers, explicit layer config with expressions
- **Spatial Operations** - Full operation coverage via DuckDB Spatial: buffer (dissolve, quadSegs), intersection (filter/clip), union (merge/dissolve), difference (subtract/exclude), contains (filter/within), distance (filter/annotate), centroid; multi-unit support; Kahn's algorithm for dependency ordering
- **UI Polish** - Bug fixes (color picker, layer visibility, layer delete), progress control idle timer, human-readable dataset names, Phosphor SVG icons, compact top bar, landing page with live demo embed and expandable YAML config

### v0.1.0
- **Config Loading + Map Init**
- **Dataset Loading from Config**
- **Operations Framework** - Parse `operations`, build dependency graph, topological sort
- **Buffer Operation** - ST_Buffer with meter-to-degree conversion, dissolve via ST_Union_Agg
