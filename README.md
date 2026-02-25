# artemyx

A declarative GIS application using MapLibre GL JS with client-side data processing via DuckDB-WASM.

## Overview

This project demonstrates:
- **Mapping:** MapLibre GL JS with WebGL-based rendering for smooth panning/zooming
- **Data Storage:** DuckDB-WASM with spatial extension for in-browser SQL queries
- **Data Loading:** Fetch GeoJSON from public API endpoints, store in DuckDB-WASM, then visualize

## Key Features

- Interactive mapping with switchable basemaps (CARTO, Satellite)
- Multi-dataset support with layer management UI (visibility, color, rename, delete)
- YAML-driven configuration for declarative map setup and spatial operations
- Spatial operations via DuckDB-WASM (buffer, intersection, union, difference, contains, distance, centroid)
- Multi-geometry rendering (Point, LineString, Polygon, Multi* variants)
- Feature inspection with property popups
- Fully client-side - no backend required

## Tech Stack

- **Astro** - Static site generator
- **MapLibre GL JS** - Open-source WebGL mapping library
- **DuckDB-WASM** - In-browser analytical SQL database with spatial extension
- **TypeScript** - Type-safe development

## Architecture

```
src/scripts/
├── config/            # YAML parsing, validation, operations graph
│   ├── parser.ts      # Config loading and validation
│   ├── types.ts       # MapConfig, DatasetConfig, OperationConfig
│   ├── operations-graph.ts  # Dependency resolution, topological sort
│   └── executor.ts    # Spatial operation execution
├── db/                # DuckDB-WASM initialization and queries
│   ├── core.ts        # DB init, spatial extension loading
│   ├── datasets.ts    # Dataset CRUD operations
│   └── features.ts    # Feature queries, GeoJSON export
├── geojson-actions/   # Data loading pipeline
│   └── load.ts        # URL fetch, validation, MapLibre layer creation
├── layer-actions/     # Layer control UI handlers
│   ├── context-menu.ts      # Menu positioning, click-outside
│   ├── color.ts, delete.ts, visibility.ts  # Action handlers
│   └── layer-row.ts   # Row DOM, inline rename
├── ui/                # Reusable UI components
│   └── error-dialog.ts
├── map.ts             # MapLibre init + config loading (entry point)
├── *-control.ts       # Custom MapLibre controls (layer, geojson, basemap, progress)
├── basemaps.ts        # Basemap tile configurations
└── popup.ts           # Feature popup utilities
```

Data flows through: **YAML config** -> **DuckDB-WASM** (storage + spatial ops) -> **MapLibre** (rendering)

## Development

```sh
npm install
npm run dev
```

Visit `localhost:4321` to view the application.

## Build

```sh
npm run build
```

Production site outputs to `./dist/`.

## Testing

```sh
npm test            # Run tests once
npm run test:watch  # Watch mode (re-runs on file changes)
```

Tests use Vitest and are co-located with source files (`*.test.ts`). Currently covers operations graph module (dependency resolution, topological sort, cycle detection).

## Configuration

Create a YAML config file in `public/` (e.g., `my-config.yaml`) and reference it via `data-config` on the `#map` element:

```yaml
map:
  center: [-123.1207, 49.2827]  # [longitude, latitude]
  zoom: 12                       # 0-22
  basemap: carto-dark            # carto-dark | carto-light | carto-voyager | esri-satellite

datasets:
  - id: bikeways                 # Unique identifier
    url: "https://..."           # GeoJSON URL (HTTPS required)
    name: Vancouver Bikeways     # Display name (optional)
    color: "#22c55e"             # Hex color (optional)
    style:                       # Style overrides (optional)
      lineWidth: 3
      fillOpacity: 0.3
      pointRadius: 6

operations:
  - type: buffer
    input: bikeways
    output: bikeway_buffer
    params:
      distance: 200
      units: meters
      dissolve: true

# Explicit layer definitions (optional - auto-generated if omitted)
# Layers render in order: first = bottom, last = top
layers:
  - id: buffer-fill
    source: bikeway_buffer
    type: fill
    paint:
      fill-color: "#f59e0b"
      fill-opacity: 0.15

  - id: bikeways-line
    source: bikeways
    type: line
    paint:
      # MapLibre expressions for data-driven styling
      line-color:
        - interpolate
        - ["linear"]
        - ["get", "speed_limit"]   # Property name (case-sensitive)
        - 30
        - "#22c55e"                # Green at 30
        - 50
        - "#ef4444"                # Red at 50
      line-width: 2.5
```

Layers support full MapLibre paint/layout properties including expressions (`match` for categories, `interpolate` for gradients).

## Status

**Current version:** v0.3.1 - Sandbox mode, OPFS persistence, full spatial operations suite, expression-driven layer styling

**Next up:** Per-operation examples (v0.3.2)

See [CHANGELOG.md](CHANGELOG.md) for release history and [ROADMAP.md](ROADMAP.md) for planned work.
