# Changelog

All notable changes to this project will be documented in this file.

Format follows [Semantic Versioning](https://semver.org/).

## v0.3.2 - 2026-02-26

### Examples Page Framework

- `/examples` serves an interactive examples browser: 280px left sidebar with grouped navigation (Core Operations / Advanced), full-height map on the right, bottom sheet config viewer
- Static Astro pages generated at build time: dynamic route `src/pages/examples/[slug].astro` with `getStaticPaths()`; `src/pages/examples/index.astro` renders the first example directly at `/examples` (no redirect); central registry at `src/scripts/examples/registry.ts` defines all examples (slug, name, group, description, config path) - adding an example requires one registry entry + one YAML file in `public/examples/configs/`
- Config viewer: "View config" button centered at the bottom of the map pane triggers a bottom sheet that slides up to cover ~60% of the pane; map stays visible and interactive above it; YAML syntax-highlighted via Shiki at build time (zero client-side overhead)
- Mobile responsive: sidebar collapses below 768px; hamburger toggle button appears in the map area; HTML structured for clean refactor into the global header hamburger menu in v0.4.x
- All example maps use `data-persistence="false"` - no OPFS writes during example browsing
- Buffer/dissolve example (Vancouver bike walksheds) fully working
- Intersection/clip example populated (San Francisco): SF bike routes x parks and open spaces; two operations in one config demonstrating filter mode (whole segments touching a park) vs clip mode (routes trimmed to park boundary); datasets from SF Open Data (Socrata)
- Union/merge example populated (Portland): Portland neighbourhoods x development opportunity areas; merge mode preserves individual polygons, dissolve mode produces a single unified boundary; datasets from PortlandMaps ArcGIS REST
- Difference example populated (Ottawa): Ottawa neighbourhoods x parks and greenspaces; subtract mode carves park geometry out of each neighbourhood polygon, exclude mode returns only neighbourhoods with no park presence; datasets from Ottawa ArcGIS REST
- Contains/within example populated (Winnipeg): Winnipeg parks and open spaces x cycling network; filter mode returns parks that fully contain at least one cycling segment, within mode returns cycling segments entirely inside a park boundary; datasets from Winnipeg Open Data (Socrata)
- Distance/filter example populated (Chicago): Chicago parks x L rail stations; filter mode keeps only parks within 800m of a station; L station circles colored by line via `match` expression on the `Legend` field using official CTA hex codes; datasets from Chicago Open Data (Socrata)
- Distance/annotate example populated (Calgary): Calgary bikeways enriched with distance to nearest LRT station; green-to-blue interpolate gradient on `dist_km`; raw bikeways shown as a muted baseline for comparison; datasets from City of Calgary Open Data (Socrata)
- Centroid example populated (Denver): Denver park polygons reduced to centroid points; muted polygon fill + outline shown as context layer; datasets from Denver Open Data (ArcGIS REST)
- Examples nav link updated from `href="#"` to `href="/examples"` on all pages

---

## v0.3.1 - 2026-02-24

### Sandbox

- `/app` is now a blank slate: basemap and controls load with no datasets; users load data manually via the GeoJSON control or by pointing at a custom config
- Previous full Vancouver demo moved to `/test` as a hidden dev route for regression testing
- `map-config.yaml` renamed to `test-config.yaml`; new minimal `app-config.yaml` created for the blank slate
- All pages now use explicit `data-config` attributes instead of relying on the fallback path
- Default config path in `parser.ts` updated from `/map-config.yaml` to `/app-config.yaml`
- Expression-driven tooltip text now references generic "config" instead of a specific filename

## v0.3.0 - 2026-02-22

### Persistence (OPFS)

Full OPFS persistence implementation across all stages.

**Stage A - Session restore:**
- `initDB()` tries `db.open({ path: 'opfs://gis_app.db' })` before falling back to in-memory; OPFS errors caught silently
- Schema versioning via `meta` table (`key/value`); `SCHEMA_VERSION = '1'`; stale schema triggers full wipe and reinitialize
- `data-persistence="false"` attribute on `#map` opts out of OPFS entirely (used by landing page demo)
- `datasetExists(id)` added to `db/datasets.ts`; dataset loading and operation execution check this before fetching/running
- `restoreManualDatasets()` in `map.ts`: restores manually loaded datasets from previous sessions not covered by config

**Stage B - Resilience:**
- `StorageControl` - new `maplibregl.IControl` on `top-left`; database icon color reflects state: green (OPFS), blue (session-only), amber (error/fallback)
- `FallbackReason` type: `'none' | 'disabled' | 'opfs-failed' | 'corruption' | 'quota-exceeded'`
- `clearOPFS()`: closes DB, deletes OPFS file, reloads page
- "Clear Session" button with click-again-to-confirm (auto-reverts after 3s); "Clear & Retry" for error recovery
- `QuotaExceededError` caught by name in `loadGeoJSON()` - sets reason to `'quota-exceeded'`
- Mutual exclusivity between layer and storage panels via `closePanel()` / `setOnPanelOpen()`

**Stage C-1 - Startup UX:**
- Progress control shows "Restoring session from storage..." when an existing OPFS database is detected
- `beforeunload` warning when running in in-memory fallback mode - browser "Leave site?" dialog protects unsaved data

**Stage C-2 - Quota safety:**
- Quota preflight in `loadGeoJSONFromUrl()` - `navigator.storage.estimate()` warns at 80% capacity with a confirm dialog; cancelling blocks the load
- Storage usage display in StorageControl panel - "Storage: X MB of Y MB used (Z%)"; populated async after panel opens

**Stage C-3 - Multi-tab detection:**
- `BroadcastChannel('artemyx-gis')` in `StorageControl` constructor: posts `tab-open` on startup, responds `tab-present` to other tabs, detects responses within 200ms
- Amber icon and "Multiple tabs open" panel label when another tab is detected; panel warning explains concurrent OPFS write risk

**Stage C-4 - Visibility persistence:**
- Fixed: layers toggled off before a page refresh now restore hidden instead of always rendering visible
- Root cause: DuckDB-WASM Arrow serializes BOOLEAN columns as 0/1 integers; all comparisons updated from strict `=== false` / `!== false` to falsy checks (`!value`, `!!value`)
- End-of-pipeline visibility sweep added in `map.ts` after `executeLayersFromConfig()` - applies stored `visible` state to all datasets once all MapLibre layers actually exist; required because explicit layers are created after dataset sources, making earlier toggle attempts no-ops
- Checkbox state in layer panel also fixed (`!!dataset.visible`) - was always showing checked due to the same Arrow type mismatch

### Large Dataset Memory Fix

- Removed `JSON.parse(JSON.stringify())` deep clone at the end of `getFeaturesAsGeoJSON()` - was creating ~3x peak memory overhead per call, compounding across large datasets restored sequentially on startup
- Added `window.addEventListener('error', ...)` and `'unhandledrejection'` handlers in `map.ts` to surface OOM errors in the progress control instead of silently stalling

---

## v0.2.0 - 2026-02-21

### Landing Page

- New landing page at `/` with compact hero, live demo map embed, and expandable YAML config block
- Full GIS app moved to `/app`; header nav updated on both pages (About, App, Examples, GitHub)
- `demo-config.yaml` added to `public/` - bikeways + rapid transit stations with a `distance annotate` operation and MapLibre interpolate expression; used exclusively by the landing page demo
- `map.ts` reads optional `data-config` attribute from `#map` div to select config file; falls back to `/map-config.yaml` when absent - no changes to `loadConfig()` API

### Progress Control: Human-Readable Dataset Names

- Config datasets show their YAML `name` in progress messages; manual URL loads fall back to the URL hostname

### Layer Delete Fix

- `deleteDatasetWithLayers()` now uses `getLayersBySource()` to dynamically discover and remove all layers referencing a dataset's source - config-defined layers with custom YAML IDs are now correctly removed instead of silently skipped

### Layer Checkbox State Fix

- Checkboxes no longer reset to checked after color changes, renames, etc.
- `toggleLayerVisibility()` now persists visibility to DuckDB via new `updateDatasetVisible()`, so `refreshPanel()` reads correct state

### GUI Color Control Fix

- Color picker now discovers layers dynamically via `getLayersBySource()` instead of hardcoded `dataset-{id}-fill/line/point` IDs - works with both default layers and config-defined layers with arbitrary IDs
- Color picker is disabled (greyed out, tooltip) when all layers for a dataset use MapLibre expression-based colors (e.g. `match`, `interpolate`, `coalesce`); enabled when at least one layer has a simple color value
- Color picker pre-fills with the actual rendered paint value (fill-first priority) rather than the stored DB color
- `updateLayerColor()` skips expression-controlled layers and logs which were skipped; updates all simple-color layers it finds

### Progress Control: Idle Timer Fix

- Fixed progress bar reverting to "Ready" while operations were still running
- Added `ProgressControl.scheduleIdle(delay)` - replaces scattered `setTimeout(clear)` calls; auto-cancelled by any subsequent `updateProgress()`
- Final idle now scheduled once at the end of the full pipeline in `map.ts`

### Top Bar

- Replaced the stacked header (h1 + tagline) with a compact 44px horizontal nav bar
- Logo: favicon SVG at 24px paired with "artemyx" wordmark, wrapped as a home link
- Placeholder nav links added (About, Examples, GitHub) - right-aligned, styled for future wiring
- Replaced global `h1`/`p` selectors with scoped `.header-*` CSS classes

### Phosphor SVG Icons

- Replaced emoji icons with Phosphor SVG strings; icon registry at `src/scripts/icons/`

### Buffer: quadSegs Parameter

- `buffer` operation now accepts optional `quadSegs` param (segments per quarter-circle; default `32`, was DuckDB default of `8`)
- Fixes visibly blocky buffer curves when zoomed in; 32 produces smooth circles at all zoom levels
- `ST_Buffer(geometry, distance)` → `ST_Buffer(geometry, distance, CAST(quadSegs AS INTEGER))` with explicit cast required due to DuckDB-WASM binding all JS numbers as `DOUBLE`
- Dissolve path simplify tolerance reduced from 5% to 1% of buffer distance - preserves curve detail added by higher `quadSegs` while still preventing `TopologyException` in `ST_Union_Agg`
- Parser validates `quadSegs` as a positive integer when present

### Multi-Unit Distance Support

- `buffer` and `distance` operations now accept `units: meters | km | feet | miles` (was meters-only)
- `distance` annotate mode uses a dynamic property name based on the configured unit: `dist_m`, `dist_km`, `dist_ft`, or `dist_mi`; downstream MapLibre expressions reference whichever property matches the config
- Extracted shared `unit-conversion.ts` module: `toMeters`, `fromMeters`, `metersToDegreesAtLatitude`, `degreesToMetersAtLatitude`, `unitSuffix`, `VALID_DISTANCE_UNITS` - eliminates the duplicated conversion logic that existed in both `buffer.ts` and `distance.ts`
- `parser.ts` now validates `distance` operation params at config-load time (mode, units, maxDistance) - previously only validated at runtime; buffer units validation updated to accept all four units
- `map-config.yaml` examples updated to exercise non-meter units: distance filter uses `km`, railway buffer uses `feet`

### Performance and Reliability

- Intersection clip mode now pre-simplifies and unions the B dataset into a single CTE mask (`ST_Union_Agg(ST_Simplify(geometry, 0.0003))`) before joining - reduces `ST_Intersection` cost per feature against complex dissolved polygons; `streets ∩ bikeway_walkshed` dropped from ~30s to ~8s
- Fixed DuckDB-WASM init race condition in `core.ts`: the eager `initDB()` promise is now stored and reused by `ensureInit()`, so concurrent callers await the same init rather than triggering duplicate initialization that could leave the schema unbuilt when the first query arrived

### Centroid Operation

- Centroid computes `ST_Centroid(geometry)` on each input feature, converting polygons and lines to their center point; points are passed through as-is
- Unary operation (single `input`) - no params or modes required
- Original feature properties are preserved on the output points
- Exhaustive `never` check added to the `default` case in `executor.ts` dispatch switch - TypeScript now flags unhandled operation types at compile time

### Distance Operation

- Distance with two modes: `filter` (ST_DWithin - keeps features from A within `maxDistance` of any B feature) and `annotate` (enriches A features with a `dist_m` property - distance to nearest B feature via MIN(ST_Distance))
- Both modes use meter-to-degree conversion at the dataset's centroid latitude (same approach as buffer)
- Filter mode uses an `EXISTS` subquery with ST_DWithin for efficiency; annotate mode uses a CROSS JOIN with GROUP BY to compute nearest distance per feature
- `maxDistance` in annotate mode acts as an optional cap - omit to annotate all features, include to exclude features beyond the threshold
- Distance converted back to meters in annotate output via inverse of the meter-to-degree scale factor; rounded to 1 decimal place as `dist_m`
- `dist_m` integrates directly with MapLibre interpolate expressions for graduated styling (e.g., green→red proximity gradient)
- Input ordering is significant: `inputs[0]` is always the primary dataset (filtered or enriched), `inputs[1]` is the proximity target

### Contains Operation

- Contains with two modes: `filter` (returns A features that fully contain at least one B feature) and `within` (returns B features that are fully inside at least one A feature)
- Uses `ST_Contains(A, B)` for both modes - stricter than `ST_Intersects`; B must be completely inside A with no part outside
- `within` mode uses the same predicate but returns B features instead of A, avoiding a separate `ST_Within` call
- Both modes use an `EXISTS` subquery for efficiency (stops at first match per feature)
- Pure filter operation - geometry is never modified; both modes return original unclipped features
- Zero-result logged as a warning, not an error (valid outcome when no features are fully contained)
- Boundary note: follows GEOS semantics - a point exactly on the polygon boundary is not considered contained

### Difference Operation

- Difference with two modes: `subtract` (geometric erasure via ST_Difference) and `exclude` (boolean filter, keeps features from A not intersecting any feature in B)
- Subtract mode pre-unions all B geometries into a single CTE before subtracting, avoiding duplicate outputs when A overlaps multiple B features
- ST_Simplify applied to the B union in subtract mode to prevent TopologyException on complex polygons (same approach as buffer dissolve)
- Empty and null geometry results filtered out gracefully; zero-result is logged as a warning rather than an error

### Union Operation

- Union with two modes: `merge` (SQL UNION ALL, preserves individual features) and `dissolve` (ST_Union_Agg, merges all geometries into a single polygon)
- Dissolve applies ST_Simplify with configurable tolerance (default `1e-7`) to prevent TopologyException from near-coincident vertices
- Supports 2+ inputs; merge mode generalizes to N inputs via dynamic SQL construction
- Optional `tolerance` param in config for dissolve mode fine-tuning

### Intersection Operation

- Intersection with two modes: `filter` (boolean test) and `clip` (geometric intersection)
- Refactored operations into modular `operations/` directory (one file per operation)

### Computed Layers Rendering

Decouples data sources from rendering layers, enabling flexible styling via `map-config.yaml`.

**Layers Config:**
- New `layers` section in config for explicit layer definitions
- Control layer ordering (first = bottom, last = top)
- Reference datasets or operation outputs as sources
- Backwards compatible: auto-generates default layers when `layers` not defined

**Expression Support:**
- MapLibre expressions (`match`, `interpolate`) work directly in `paint` properties
- Categorized styling (e.g., road type → color) and graduated styling (e.g., speed → color ramp)

**Style GUI:**
- Style controls now work with config-defined layers (finds layers by source dynamically)
- Expression-controlled properties shown as disabled with "Expression" badge

**Refactoring:**
- Extracted layer/source logic into `src/scripts/layers/` module
- Decoupled source creation from layer creation

---

## v0.1.0 - 2026-02-11

Initial release: declarative GIS with spatial operations running entirely in-browser.

### Spatial Operations
- Buffer operation with dissolve (ST_Buffer + ST_Union_Agg)
- Meter-to-degree conversion for DuckDB spatial
- Operations dependency graph with topological sort (Kahn's algorithm)
- ST_Simplify before ST_Union_Agg to avoid TopologyException

### Configuration
- YAML-driven map, dataset, and operations initialization
- Config-based dataset loading with name, color, and style overrides
- Validation with fallback to defaults

### Map Rendering
- MapLibre GL JS with switchable basemaps (CARTO Dark/Light/Voyager, Satellite)
- Multi-dataset support with independent sources and layers
- Multi-geometry rendering (Point, LineString, Polygon, Multi* types)
- Auto-fit bounds to loaded features
- Feature popups with property inspection

### Layer Control
- Visibility toggle, color picker, inline rename, delete
- Context menu with viewport-aware positioning
- Colored border legend per dataset

### Data Pipeline
- GeoJSON loading from URLs with validation (HTTPS-only, 50MB limit)
- DuckDB-WASM with spatial extension (ST_GeomFromGeoJSON, ST_AsGeoJSON)
- Parameterized SQL queries via prepared statements

### UI
- Progress control with expandable history
- Styled error dialogs
