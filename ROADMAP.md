# Roadmap

This document tracks planned features, implementation phases, and the development backlog.
Completed work is listed at the bottom. For full detail on each release, see [CHANGELOG.md](CHANGELOG.md).

**Release strategy:** This public repo tracks semver releases only - commits correspond to changelog entries.

## Roadmap

### v0.4.3 - Map Interactivity

- **Mouse coordinate display** - Show lat/lng of cursor position in map corner; toggleable
- **Dataset layer reordering** - Drag-and-drop layer order in the layer control panel
- **Geocoding / address search** - Navigate to a place by name; Nominatim or Photon integration. Use Phosphor magnifying-glass icon. Top-left, below BasemapControl.

### v0.4.4 - Housekeeping

- **Parser refactor** - Review and simplify `parser.ts`
- **Paint/layout validation** - Per-type validation of `paint`/`layout` properties at config load time
- **CSS refactor** - Reorganize `global.css` into logical styling groups
- **Load.ts Refactor** - Split out loading functions into separate scripts
- **Unit test expansion** - Coverage for `db.ts` (dataset ID generation, bulk insert, query performance); establish testing patterns alongside new feature work going forward
- **Map page config injection refactor** - Build-time Shiki highlighting for config YAML is currently duplicated across all Astro map pages (app, index, test, examples); extract into a shared utility function or layout-level helper to reduce per-page boilerplate
- **Update example pages with pagination** - where applicable, update some of the example configs to auto-paginate

### v0.5.x - Styling Overhaul

Goal: replace the current split between the color button and numeric style inputs with a unified, layer-aware style panel. Style panel will be its own control (separate from LayerControl) using Phosphor palette icon, top-left. This keeps LayerControl focused on visibility, ordering, and deletion, while the style panel handles all appearance concerns.

- **Unified style panel** - Single control surface per layer; color picker and style inputs side by side, not separate controls
- **Opacity control** - Per-layer opacity slider in the style panel, separate from color; applies to the appropriate paint property by geometry type (fill-opacity, line-opacity, circle-opacity)
- **Layer-type awareness** - Show only relevant controls based on geometry type (fill opacity for polygons, line width for lines, point radius for points); fix style panel overlap with the layer row below
- **Expression-aware overrides** - Expression-driven properties shown as disabled with an "Expression" badge; toggle lets user replace the expression with a flat GUI value for that property
- **Layer Expression Editor** - Raw MapLibre expression input per layer paint property; JSON validation before applying; updates MapLibre directly without modifying the config file
- **Labels** - Per-layer label configuration in the style panel; select an attribute for `text-field`, adjust font size, halo, and placement; renders as MapLibre `symbol` layer type alongside the data layer
- **Legend** - Auto-generated legend panel derived from active layer styles; shows color swatches for flat colors, ramp previews for interpolate expressions, and category swatches for match expressions; toggleable overlay or docked panel
- **Mobile UX - colour picker** - on some browsers, colour controls don't trigger at all, making them unusable. Should have a fallback or design a robust colour picker implementation.
- **DB mutation error feedback** - Surface failures from color, style, and visibility DB updates in the progress control; currently callers don't check return values, leaving the UI appearing to succeed when the DB write failed

### v0.6.0 - Large Data Infrastructure

- **Cumulative feature count guard** - Track running feature total during OPFS restore; skip rendering datasets beyond threshold with a progress message (data stays in OPFS for operations); stopgap until v0.8.x auto-promote replaces this guard
- **Worker-based dataset loading** - Move fetch + DuckDB insert pipeline into a Web Worker so the map and controls remain responsive during large loads
- **Safari/iOS OPFS persistence** - Run DuckDB-WASM OPFS file access through a dedicated worker to satisfy Safari's requirement that `createSyncAccessHandle()` only be called from worker context; unblocks full persistence on iOS/iPadOS Safari and all WebKit-based browsers
- **Bounds query optimization** - Replace coordinate iteration with `SELECT ST_Envelope(ST_Union_Agg(geometry)) FROM features WHERE dataset_id = ?`
- **Geometry validation** - `ST_IsValid` + `ST_MakeValid` on load to catch and repair invalid geometries
- **Feature generalization (LOD)** - `ST_Simplify(geometry, tolerance)` with tolerance scaled to zoom level; applies to GeoJSON-backed sources (superseded for tiled datasets by the v0.7.0 PMTiles pipeline)
- **Viewport streaming** - Load only features visible in current extent via `ST_Intersects(geometry, ST_MakeEnvelope(west, south, east, north))`; applies to GeoJSON-backed sources

### v0.6.1 - Export and Sharing

- **Export** - Export datasets as GeoJSON, CSV, or Parquet
- **Export config** - Generate reproducible YAML from current session state
- **URL state sharing** - Serialize session (datasets, layers, paint, operations) into URL parameters for shareable links without needing a repo or exported YAML
- **External PMTiles loading** - Register the `pmtiles://` protocol handler on map init; allow `pmtiles://` URLs in `DatasetConfig` as a tiled vector source; enables loading externally hosted PMTiles files (open data portals, self-hosted, GitHub Pages); bridges to in-browser PMTiles generation in v0.7.0

### v0.7.0 - In-browser PMTiles Generation

Goal: generate PMTiles archives directly in the browser from any DuckDB-backed dataset, enabling MapLibre to render large datasets as tiled vector sources rather than monolithic GeoJSON; zoom-level simplification and viewport streaming come for free via the tile protocol.

- **`outputs:` config section** - Top-level `outputs:` key in `MapConfig` declaring dataset output formats; `format: pmtiles` with `minzoom`, `maxzoom`, and optional `layerName`; mirrors the v0.9.x CLI output schema so the same config drives both browser and command-line execution
- **Tiling pipeline** - Worker-based pipeline off main thread: `getFeaturesAsGeoJSON()` -> `geojson-vt` (tiles and simplifies per zoom level) -> `vt-pbf` (encodes as MVT protobuf) -> `pmtiles` writer (packs archive); progress surfaced in ProgressControl during generation
- **OPFS PMTiles cache** - Generated `.pmtiles` files persisted in OPFS alongside the DuckDB database; restored on session reload without regeneration; invalidated when source dataset changes; `StorageControl` panel updated to surface PMTiles cache size alongside DB size
- **MapLibre vector source wiring** - Tiled datasets use a MapLibre `vector` source pointing to the OPFS `pmtiles://` path instead of a `geojson` source; layer config requires a `source-layer` matching the declared `layerName`

### v0.7.x - Robustness and Richness

- **Feature selection** - Click or box-select features on the map to create a subset dataset; selected features visually distinguished; selection available as input to operations
- **YAML snippet runner** - In-browser panel for pasting a single operation block in standard config YAML syntax; executes against loaded datasets; output appears as a new auto-styled layer; no new syntax - same format as `map-config.yaml`; pairs with Export Config for an interactive-to-reproducible workflow. Use Phosphor terminal-window icon. Top-right, as a data/operations tool alongside DataControl and ConfigControl.
- **Parquet/GeoParquet support** - Fetch and load via DuckDB's built-in reader
- **Tabular view** - Bottom panel with sortable, filterable data grid; row click highlights feature on map
- **`join` operation** - Tabular join: attach a CSV or JSON dataset to a spatial dataset by a shared key field; enables workflows like coloring parcels by census data or enriching transit stops with ridership counts; config references a tabular `source`, a spatial `target`, and an `on` key; joined properties merged into the output feature's attributes
- **`spatial-join` operation** - Attach attributes from layer B to layer A based on geometric relationship (intersects, contains, nearest); distinct from tabular join - no shared key required, relationship is spatial; e.g., tag parcels with their containing neighbourhood or find the nearest transit stop to each school
- **Undo/redo** - Session history stack for operations and dataset changes; step backward and forward through state; covers dataset loads, operation executions, and layer modifications
- **Statistics panel** - Per-dataset summary statistics: feature count, and for numeric attribute columns, min/max/mean/median. Use Phosphor chart-bar icon. Top-left.
- **Measurement tools** - Distance, area, bearing calculations. Use Phosphor ruler icon. Top-left.
- **Keyboard shortcuts** - L (layer control), P (progress), Esc (close), Delete (remove feature), WASD for panning map, R/F to zoom in and out.
- **Collapsed tools menu** - By v0.7.x the top-left control group (LayerControl, StorageControl, BasemapControl, style panel, geocoding, stats, measurement) will be too tall for smaller screens; introduce a collapsible "tools" menu or grouped overflow control to keep the UI manageable without hiding functionality
- **ARIA labels** - Accessibility improvements for `layer-control.ts`
- **Toggle for showing text beside icons** - Accessibility improvement for desktop mainly, a button to expand all buttons to show their text value (ie the tooltip button title)

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

### v0.8.2 - Arrow Binary Data Path

- **Arrow data extraction** - `getFeaturesAsArrow()` in `features.ts` returns the raw Arrow table from DuckDB, bypassing `ST_AsGeoJSON` string serialization; coordinate columns extracted as `Float64Array` for direct consumption by deck.gl binary input format; eliminates the GeoJSON round-trip for large datasets
- **Binary layer path** - deck.gl layers using the binary path receive typed column buffers (`{length, positions, ...}`) instead of a `FeatureCollection`; geometry encoding schema (WKB vs coordinate column extraction) determined during implementation

### v0.8.3 - Extended deck.gl Layer Types

- **`ScatterplotLayer`** - Large point cloud rendering with radius scale and fill/stroke color accessors; suited for transit stops, parcel centroids, and other high-count point datasets
- **`HeatmapLayer`** - GPU-accelerated continuous density; distinct from MapLibre's `heatmap` type, operates entirely on the deck.gl pipeline
- **`HexagonLayer`** - Aggregation hexbins; count or sum of features per cell; configurable radius and elevation scale
- **`ArcLayer`** - Flow and OD (origin-destination) visualization; requires source and target coordinate columns in feature properties
- **`ColumnLayer`** - 3D vertical bars driven by a numeric property; pairs with `fill-extrusion` use cases that need deck.gl's rendering scale

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

## Completed

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
