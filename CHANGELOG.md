# Changelog

All notable changes to this project will be documented in this file.

Format follows [Semantic Versioning](https://semver.org/).

## v0.4.1 - 2026-03-03

### Progress Control Update

- Replaced text-only status line with a composite icon button: Phosphor `circle` ring as the persistent base, with a smaller inner icon that changes by state - `cloud-arrow-down` (pulsing blue) for data loading, `circle-notch` (spinning) for operation processing, empty for idle/success/error (color-only feedback)
- Icon-only on mobile; icon + text label on desktop; clicking either opens the expanded history panel
- Expanded panel gains `max-width: calc(100vw - 130px)` to prevent overlap with attribution/scalebar on narrow screens
- New icons: `circle.ts`, `cloud-arrow-down.ts` added to `src/scripts/icons/`

### Progress Control History Improvements

- **Clear history button**: trash icon button added to the expanded panel header (left of the minimize button); clears all history entries in place without closing the panel; hover turns the icon red
- **Horizontal scrolling**: history entries were already `white-space: nowrap`; history container changed from `overflow-x: hidden` to `overflow-x: auto` so long lines (error messages, full URLs) scroll rather than being clipped
- **Desktop text truncation**: `.progress-status-text` gains `max-width: 300px`; the existing `overflow: hidden` + `text-overflow: ellipsis` now fires correctly on long messages in the collapsed status row

### Landing Page Update

- Removed the hero section (title, subtitle, top CTA); the live demo map now opens the page directly
- Replaced the "View config" expandable code block with a controls guide: a 3-column icon grid describing each map control (Load data, View config, Layers, Storage, Basemap, Status)
- Moved the demo caption below the map
- Removed `.hero`, `.demo-code-details`, and related CSS; added `.controls-grid` and `.control-card-icon`

### Dataset Loader Icon

- Replaced `mapPinIcon` with `cloudArrowDownIcon` on the `DataControl` toggle button to better reflect loading data from the web

### View Config Map Control

- **`ConfigControl`** (`src/scripts/config-control.ts`): new `IControl` added to all map pages at `top-right`, below `DataControl`; button uses the `codeBlockIcon`; clicking opens a floating panel with Shiki-highlighted YAML
- **Floating panel**: centered on desktop (~480px wide, `position: fixed`, drop shadow); full-width bottom-anchored on mobile (`max-width: 767px` breakpoint); same component and styling on both; dismissed via X button or ESC key; panel appended to the map container (not the control group) so it overlays the map freely
- **Build-time highlighting**: each Astro page (`app.astro`, `index.astro`, `test.astro`, `[slug].astro`, `examples/index.astro`) runs `codeToHtml()` in its frontmatter and injects highlighted HTML into a hidden `<div id="config-highlighted" data-config-filename="...">` element; `ConfigControl.buildPanel()` reads this at runtime - no client-side Shiki bundle needed
- **ExampleLayout cleanup**: removed the examples-only `examples-config-btn` button, `examples-sheet` bottom sheet, toggle JS, and all related CSS; config viewing now handled entirely by `ConfigControl` like every other page
- **`.config-viewer-*` CSS classes** added to `global.css` (replaces removed `.examples-sheet-*` and `.examples-config-btn`)

### Move Basemap Control

- **Relocated** `BasemapControl` from `bottom-right` to `top-left`, below `StorageControl`; now participates in mutual-exclusion with `LayerToggleControl` and `StorageControl` via `closePanel()` / `setOnPanelOpen()`
- **Icon button**: replaced the text label button (`"CARTO Dark ▲"`) with a `control-btn` icon button using new `mapTrifoldIcon`; new icon file `src/scripts/icons/map-trifold.ts`
- **Drop-down panel**: uses shared `control-panel control-panel--left` classes (opens to the right of the button); old drop-up menu and text-button CSS removed; MapLibre's `.maplibregl-ctrl-group button` overrides countered with `.maplibregl-ctrl .basemap-option` specificity and `!important` on `padding`, `height`, `width`, and `display`

### Progress Control Bug Fix

- Fixed progress control stuck on "Processing session..." on `/app` when OPFS data existed but no config datasets were defined; `scheduleIdle()` was only called inside the config pipeline, which never runs on the blank-slate app config

### Async Error Messaging

- Config load failures (bad YAML, network error, validation error) are now surfaced in the progress control instead of silently falling back to defaults; error message is stored before the progress control DOM exists and emitted immediately after all controls are added to the map
- Manual dataset restore failures during OPFS session restore now show a per-dataset error entry in the progress control alongside the existing `console.warn`; previously the user would see fewer layers than expected with no explanation

### Attribution

- **Artemyx attribution**: `customAttribution` added to the MapLibre map constructor pointing to `artemyx.org`; `compact: true` forces the toggle button on all layout widths
- **Auto-collapse**: on wide layouts (>640px) the attribution starts expanded and auto-collapses after 4 seconds; on narrow/mobile it collapses immediately
- **Dark theme**: CSS overrides on `.maplibregl-ctrl-attrib` force background, text, and link colors to match the app's dark theme, preventing clashes when the browser's `prefers-color-scheme` is dark

### Scale Bar

- **Scale bar** (`src/scripts/scale-control.ts`): `ScaleBarControl` renders a distance scale bar in the bottom-right corner, below the basemap picker; updates on every map move using `map.unproject()` + `LngLat.distanceTo()` (Haversine), matching MapLibre's internal approach; displays a classic three-sided bracket bar with a distance label (e.g. `500 km`)
- **Metric/imperial toggle**: a muted unit button (showing the inactive unit) sits inline with the bar; clicking switches between metric (`m`/`km`) and imperial (`ft`/`mi`); sub-kilometre and sub-mile thresholds handled automatically

### Mobile Bottom UX

- **`100dvh` viewport fix**: `body` and `body.examples` updated from `height: 100vh` to `height: 100dvh`; resolves iOS Safari clipping the bottom of the app behind the browser chrome (address bar and bottom tab bar)
- **Progress panel detached from MapLibre control group**: `ProgressControl`'s expanded history panel is now appended directly to `map.getContainer()` instead of the control's container element; gives the panel its own `position: absolute; z-index: 10` so it floats above all MapLibre control groups (scale bar, attribution, basemap), resolving overlap on expansion
- **Persistent toggle button**: the collapsed status row (icon + text) now stays visible when the history panel is open; clicking it again closes the panel, matching the open/close affordance of other controls; the panel's minimize button remains as a secondary dismiss path
- **Responsive panel width on mobile**: `.progress-expanded-panel` gains a `@media (max-width: 767px)` override setting `width: calc(100vw - 30px)`; previously the fixed `450px` width could extend beyond the viewport on narrow screens, cutting off the minimize button

---

## v0.4.0 - 2026-03-01

### Format Loader Module

Multi-format data loading via a loader dispatch layer. Existing GeoJSON behavior is unchanged.

- New `src/scripts/loaders/` directory: `types.ts` (FormatLoader interface, DetectedFormat/ConfigFormat unions, LoaderOptions), `detect.ts` (format detection by URL extension then Content-Type), `columns.ts` (shared lat/lng column detection with common aliases), and `index.ts` (dispatch function)
- **GeoJSON loader** (`loaders/geojson.ts`): normalizes raw Feature, raw geometry, plain Feature array, and FeatureCollection; used as the default for all existing configs
- **CSV loader** (`loaders/csv.ts`): parses CSV text (quoted fields, CRLF); auto-detects lat/lng columns via common aliases (`lat/lng`, `latitude/longitude`, `y/x`, etc.); builds a GeoJSON Point FeatureCollection with all other columns as properties; rows with invalid coordinates are skipped; delimiter auto-detection and `geoColumn` support added in subsequent pass (see below)
- **GeoParquet loader** (`loaders/geoparquet.ts`): fetches as ArrayBuffer; registers with DuckDB via `registerFileBuffer()`; auto-detects WKB geometry column by name and BLOB type; queries via `read_parquet() + ST_GeomFromWKB() + ST_AsGeoJSON()`; virtual file cleaned up after query
- **JSON array loader** (`loaders/json-array.ts`): handles plain JSON arrays of objects with coordinate properties; reuses column detection from `columns.ts`; applied as automatic fallback when a JSON response is not valid GeoJSON
- `geojson-actions/` renamed to `data-actions/`; `geojson-control.ts` renamed to `data-control.ts` (class `DataControl`, placeholder updated to reflect multi-format support); `loadGeoJSONFromUrl` renamed to `loadDataFromUrl`
- `format`, `latColumn`, and `lngColumn` optional fields added to `DatasetConfig` in `config/types.ts` and validated in `parser.ts`; `format` accepts `geojson | csv | geoparquet` as an explicit override when detection is ambiguous; `latColumn`/`lngColumn` override auto-detection for non-standard headers
- `test-config.yaml`: `streets` annotated with `format: geojson` and `greenways` with `format: geoparquet`; combined with the existing `format: csv` on `parks_csv`, all three valid format values are exercised as explicit overrides; `parks_json` intentionally has no `format` field to keep the auto-detect fallback path covered

---

### CSV Loader Robustness

Fixes found during real-data testing against Vancouver open data (OpenDataSoft portal).

- **Delimiter auto-detection** (`loaders/csv.ts`): `detectDelimiter()` counts occurrences of `,`, `;`, `\t`, and `|` in the header line (outside quoted fields) and picks the highest; `parseCSVRow()` now accepts a delimiter argument instead of hardcoding comma; removes the need to normalize URLs to comma-separated output before loading
- **Combined coordinate column** (`geoColumn`): new optional `geoColumn` field on `DatasetConfig` for datasets where both coordinates are stored in a single column as `"lat, lng"` (e.g. OpenDataSoft `GoogleMapDest`, `geo_point_2d`); `parseGeoPoint()` splits on `,` and parses both halves; `rowsFromGeoColumn()` builds the FeatureCollection from the combined value; `geoColumn` validated in `parser.ts` as mutually exclusive with `latColumn`/`lngColumn`; parallel implementation added to `loaders/json-array.ts` (`arrayFromGeoColumn()`)
- `geoColumn` added to `LoaderOptions` in `loaders/types.ts`; wired through `LoadDataOptions` in `data-actions/load.ts` and forwarded to the loader dispatch
- `test-config.yaml`: Vancouver Parks CSV dataset added (`parks_csv`) as a live test case - semicolon-delimited, `geoColumn: GoogleMapDest`

---

### GeoParquet Loader Robustness

Fixes found during real-data testing against Vancouver Open Data (OpenDataSoft portal, 67,097 features).

- **Extensionless URL detection** (`loaders/detect.ts`): added `SEGMENT_MAP` keyword check between the extension and Content-Type detection steps; handles OpenDataSoft-style paths like `/exports/parquet`, `/exports/csv`, `/exports/geojson` where the last path segment names the format without a dot; `getUrlExtension()` returns `''` for these paths so they previously fell through to Content-Type (unreliable) or defaulted to GeoJSON; the segment check catches them reliably before Content-Type is consulted
- **Native `GEOMETRY` column support** (`loaders/geoparquet.ts`): DuckDB may report a GeoParquet geometry column as type `GEOMETRY` (already decoded) rather than `BLOB` (raw WKB) depending on the file producer; wrapping a `GEOMETRY` value with `ST_GeomFromWKB()` throws a binder error; `findGeometryColumn()` now returns `{ name, type }` instead of a plain string; when type is `GEOMETRY`, the query uses `ST_AsGeoJSON("geom")` directly; when type is `BLOB` or `WKB_GEOMETRY`, the existing `ST_AsGeoJSON(ST_GeomFromWKB("geom"))` path runs
- **`BigInt` property serialization** (`loaders/geoparquet.ts`): DuckDB-WASM returns Arrow integer columns (e.g. large ID fields) as JS `BigInt`; `JSON.stringify()` throws on `BigInt` values; property values are now checked with `typeof val === 'bigint'` and coerced to `Number` when within `Number.MIN_SAFE_INTEGER`-`Number.MAX_SAFE_INTEGER`, or `String` for values that exceed safe integer range

---

### JSON Array Loader Robustness

Fixes found during real-data testing against Vancouver Open Data (OpenDataSoft portal, parks polygon dataset).

- **Embedded geometry column detection** (`loaders/json-array.ts`): new third detection path in `tryLoadJsonArray()` after lat/lng column detection fails; `findGeoShapeColumn()` scans object properties for any value that parses as a GeoJSON geometry; `arrayFromGeoShape()` builds a FeatureCollection using the detected column; handles polygon, line, and point data - not just coordinate-column point data
- **Feature wrapper unwrapping** (`loaders/json-array.ts`): `parseGeoShape()` handles both raw geometry objects (`{"type": "Polygon", "coordinates": [...]}`) and Feature wrappers (`{"type": "Feature", "geometry": {...}}`); extracts the inner geometry from the wrapper; OpenDataSoft JSON exports embed geometry as a Feature wrapper in a `geom` field rather than a bare geometry
- **Stringified geometry support** (`loaders/json-array.ts`): `parseGeoShape()` also accepts JSON strings that parse to a geometry or Feature; handles portals that serialize geometries as JSON strings rather than nested objects
- `test-config.yaml`: Vancouver Parks polygon dataset added (`parks_json`) as a live test case - auto-detected from the `/exports/json` URL segment (no explicit `format` override needed), Feature-wrapped polygon geometry in `geom` field

---

### GUI Control Format Transparency

The data loader control now handles all supported formats (GeoJSON, CSV, GeoParquet) from the URL input without a format selector or config overrides.

- **CSV combined coordinate column auto-detection** (`loaders/csv.ts`): `detectGeoColumn()` added as a fallback when separate lat/lng column detection fails; checks known combined-column aliases (`googlemapdest`, `geo_point_2d`, `latlng`, `lat_lng`, `latlong`, `coordinates`, `location`, `geolocation`, `geo_point`, `point`) first, then scans all column values against `parseGeoPoint()` for any `"lat, lng"` formatted value; datasets like the Vancouver parks CSV with `GoogleMapDest` now load from the GUI without requiring a config `geoColumn` override
- Error message in `columns.ts` no longer says "Use latColumn/lngColumn in config" - the hint is now generic since detection runs from both config and GUI paths

---

### Hover Tooltips

- Hovering over any feature shows a compact tooltip with the dataset or layer display name; config layers can add `tooltip: field_name` (or an array) to also show a property value
- Single shared popup and a single `mousemove` handler per map - `queryRenderedFeatures` with the full registered layer list returns features in stacking order; only the topmost result gets a tooltip
- Clicking a feature opens the full property popup and dismisses the hover tooltip
- `attachFeatureHoverHandlers()` added to `popup.ts` with a module-level registry and shared `maplibregl.Popup`; `attachFeatureClickHandlers()` updated to accept an optional hover popup for dismissal
- `tooltip` field added to `LayerConfig` in `types.ts`; validated in `parser.ts` (string or non-empty string array)
- `onLayersCreated` callback added to `OperationContext` in `operations/index.ts`; implemented in `executor.ts` to centralize handler wiring for all operation outputs and the OPFS restore path; all 8 operation files updated to use the callback instead of calling click handlers directly
- `load.ts` and `map.ts` wired to call hover handlers on manual loads, config layers, and OPFS restores; `sourceNameMap` in `map.ts` resolves dataset and operation IDs to display names matching the layer panel
- `.hover-tooltip` styles added to `global.css` (compact, semi-transparent, no tip arrow, `pointer-events: none`)

---

### `attribute` Operation

New unary operation for attribute-based filtering on a single dataset. Complements MapLibre filter expressions with data-level filtering - downstream operations and exports see only the matched features, not the full source.

**Two authoring modes:**
- **Structured** (`property`, `operator`, `value`): simple equality and comparison filters; no SQL knowledge required; operator defaults to `=` when omitted; numeric values are automatically cast for numeric comparisons
- **Advanced** (`where`): raw DuckDB SQL WHERE clause for multi-condition logic, `IN` lists, or expressions requiring JSON extraction that can't be expressed as a single property/value pair; mutually exclusive with structured params; config YAML is trusted input

**Implementation:**
- `operations/attribute.ts`: new unary operation file following the centroid pattern; `buildStructuredWhere()` compiles structured params to `json_extract_string(properties, '$.key') <op> value` with automatic `CAST ... AS DOUBLE` for numeric values; string values get single-quote escaping; raw `where` path interpolates the SQL fragment directly into the query template
- `config/types.ts`: `'attribute'` added to `UnaryOperationType`; new `AttributeOperator` type (`=`, `!=`, `>`, `>=`, `<`, `<=`); new `AttributeParams` interface with mutually exclusive `property/operator/value` vs `where` fields
- `config/parser.ts`: `'attribute'` added to `UNARY_OPERATIONS`; `validateAttributeParams()` enforces mutual exclusivity between structured and `where` modes, operator allowlist, non-empty `property`/`value` requirements, and that `params` is always present (unlike centroid which has no params)
- `config/executor.ts`: `case 'attribute':` dispatch added with unary guard
- `config/operations/index.ts`: `executeAttribute` re-exported

**Example:**
- `public/examples/configs/attribute.yaml`: Vancouver cycling network - full bikeways loaded as a hidden source; advanced `where` filter selects Local Streets and Protected Bike Lanes; 200m buffer dissolves that subset into a walkshed; structured filter selects Protected Bike Lanes only as a highlighted overlay; registered in `registry.ts` under Advanced Workflows

---

### Layer Fallback and Hidden Datasets

Fixes a silent breakage where datasets defined in config but not referenced by any `layers` entry would load into DuckDB, appear in the layer panel, but render nothing - leaving them invisible and un-interactable.

**Coverage-check fix:**
- Replaced the blanket `hasExplicitLayers = layers !== undefined` flag (which skipped auto-layer creation for ALL datasets the moment any `layers` section was present) with a per-source coverage check
- `coveredSources = new Set(layers?.map(l => l.source) ?? [])` computed once per pipeline; each dataset and operation output is checked individually
- Sources explicitly covered by a `layers` entry still skip auto-layer creation (existing behavior)
- Sources NOT covered by any `layers` entry now receive fallback default fill/line/circle layers, making them visible and fully interactable in the panel
- `shouldSkipAutoLayers(outputId, layers?)` helper added to `operations/index.ts` and used across all 7 operation files; replaces duplicated inline logic in each
- Same fix applied to the OPFS restore path in `executor.ts`

**`hidden: true` on datasets:**
- Optional `hidden` field added to `DatasetConfig` in `config/types.ts`
- When set, the dataset is loaded into DuckDB (so operations can reference it) but no MapLibre source or layer is created and it is excluded from the layer panel
- Intended for source-only datasets that feed spatial operations without needing direct visibility
- `hidden` persisted to the `datasets` table in DuckDB so OPFS restore respects it across sessions
- Parser validates `hidden` as an optional boolean
- `SCHEMA_VERSION` bumped to `'2'` - existing OPFS sessions are automatically wiped on next load

---

### Operation Naming

- Optional `name` field added to all operation types in config (`UnaryOperation` and `BinaryOperation` via `OperationBase`)
- When set, the friendly name is used as the dataset display name in the layer panel and as the label in progress control messages; falls back to the `output` ID when omitted
- Parser validates `name` as an optional string (same pattern as dataset `name`)
- `displayName` variable introduced in all 7 operation files (`buffer`, `centroid`, `intersection`, `union`, `difference`, `contains`, `distance`) - cleanly separates user-facing display from the internal `outputId` used for DB and MapLibre source IDs
- OPFS restore and error progress messages in `executor.ts` also use `op.name || op.output`
- All existing configs without `name` fields continue to work unchanged

### TypeScript Fix

- Fixed `core.ts` type error: `cdnBundles.eh` is typed as optional in the DuckDB-WASM `getJsDelivrBundles()` return type; now guarded with a conditional (`cdnBundles.eh ? { ... } : undefined`) matching the existing pattern used for `cdnBundles.coi`

---

### Responsive Header with Hamburger Menu

- Extracted shared `Header.astro` component - logo, inline nav, and hamburger button in one place; replaces duplicated header markup across `index.astro`, `app.astro`, `test.astro`, and `ExampleLayout.astro`
- Below 768px the inline nav collapses and a hamburger button appears in its place
- On examples pages the hamburger opens the existing left sidebar; About, App, and GitHub links added to the sidebar bottom (below a separator) so the header nav is fully accessible from mobile
- On all other pages the hamburger opens a consistent slide-in sidebar with the four nav links; close button and link-click both dismiss it
- Removes the temporary flush-edge pull-tab toggle introduced in v0.3.3

---

## v0.3.4 - 2026-02-27

### Advanced Workflow + Styling Examples

- Interpolate expression styling example (Vancouver): parks polygon dataset colored by `area_ha` using a 5-stop green ramp (0 / 2 / 10 / 40 / 100 hectares); demonstrates `interpolate` + `linear` paint expressions on polygon fill layers
- Match expression styling example (Victoria): road centreline network colored by `Class` field (ART, SART, COL, SCOL, LOC, RES, STR, LANE, TRA, WLK, REC) with hierarchy-aware line widths - arterials rendered thickest, local streets thinnest; demonstrates `match` expressions on both `line-color` and `line-width`
- Multi-dataset layers example (Surrey, Burnaby, New Westminster): 7 datasets across 3 municipalities - parks (polygon fills), trails (cool teal/cyan/purple palettes per city), and bike routes (warm amber/orange palette with infrastructure-type-aware line widths); demonstrates multi-source composition with expression styling and no operations
- Multi-step workflow example (Edmonton): schools + transit - union, buffer, and intersection chained to find dual-access zones

---

## v0.3.3 - 2026-02-26

### Examples UX Polish

- Added close button (X) inside the mobile sidebar overlay - previously, the sidebar could only be dismissed by tapping a navigation link; the close button appears in the top-right corner of the sidebar, visible only below 768px
- Repositioned the hamburger toggle from top-left corner (where it overlapped MapLibre layer controls) to mid-left as a flush edge tab - vertically centered via `top: 50%; transform: translateY(-50%)`, no left border, right-side-only rounded corners (28x44px pull-tab shape)

---

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
