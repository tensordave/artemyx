/**
 * Export a "viewer config" zip: a flattened YAML config (no operations section)
 * plus GeoJSON files for all operation results and file-uploaded datasets.
 *
 * The zip structure:
 *   config.yaml          - flattened config (datasets + layers, no operations)
 *   data/<name>.geojson   - one file per operation output or file-uploaded dataset
 */

import type { Map } from 'maplibre-gl';
import yaml from 'js-yaml';
import { zipSync } from 'fflate';
import { getDatasets, getOperations, getFeaturesAsGeoJSON } from '../db';
import { DEFAULT_STYLE, DEFAULT_COLOR } from '../db/constants';
import type { StyleConfig } from '../db/constants';
import { extractLayerConfigs, diffStyle, parseStyleJson, round } from './generator';
import { toFilename } from '../layer-actions/export';

const encoder = new TextEncoder();

/**
 * Generate a unique filename, appending -2, -3, etc. on collision.
 */
function uniqueFilename(base: string, used: Set<string>): string {
	if (!used.has(base)) {
		used.add(base);
		return base;
	}
	let i = 2;
	while (used.has(`${base}-${i}`)) i++;
	const name = `${base}-${i}`;
	used.add(name);
	return name;
}

/**
 * Export a viewer config zip containing a flattened YAML and GeoJSON data files.
 *
 * @param map - MapLibre map instance (for viewport and layer extraction)
 * @param basemapId - Current basemap ID
 */
export async function exportViewerZip(map: Map, basemapId: string): Promise<void> {
	const datasets = await getDatasets();
	const operations = await getOperations();

	const operationOutputIds = new Set(operations.map(op => op.output_id));

	// Extract layers for coverage info and the layers: section
	const { layers: layerConfigs, coveredDatasetIds } = extractLayerConfigs(map);

	// Determine which dataset sources are referenced by explicit layers
	const layerReferencedSources = new Set(layerConfigs.map(l => l.source));

	// Sort datasets by layer_order ASC (getDatasets() returns DESC)
	const sorted = [...datasets].reverse();

	// Build the flattened config and collect datasets that need GeoJSON export
	const center = map.getCenter();
	const zoom = map.getZoom();

	const config: Record<string, unknown> = {
		map: {
			center: [round(center.lng, 4), round(center.lat, 4)],
			zoom: round(zoom, 1),
			basemap: basemapId,
		},
	};

	const datasetEntries: Record<string, unknown>[] = [];
	const toExport: { datasetId: string; filename: string }[] = [];
	const usedFilenames = new Set<string>();

	for (const ds of sorted) {
		const isOperationOutput = operationOutputIds.has(ds.id);
		const sourceUrl: string | null = ds.source_url;
		const isFileUpload = sourceUrl?.startsWith('file://') || !sourceUrl;
		const isHidden = !!ds.hidden;

		// Skip hidden source datasets unless they're referenced by an explicit layer
		if (isHidden && !isOperationOutput && !layerReferencedSources.has(ds.id)) {
			continue;
		}

		const entry: Record<string, unknown> = { id: ds.id };

		// Determine URL: operation outputs and file uploads get exported to zip
		if (isOperationOutput || isFileUpload) {
			const baseName = toFilename(ds.name || ds.id);
			const filename = uniqueFilename(baseName, usedFilenames);
			entry.url = `./data/${filename}.geojson`;
			toExport.push({ datasetId: ds.id, filename: `${filename}.geojson` });
		} else {
			entry.url = sourceUrl;
		}

		if (ds.name && ds.name !== ds.id) {
			entry.name = ds.name;
		}
		if (ds.color && ds.color !== DEFAULT_COLOR) {
			entry.color = ds.color;
		}
		// Hidden sources that made it past the filter above become visible in viewer config
		// (they're referenced by layers), so don't set hidden: true
		if (isHidden && !isOperationOutput) {
			entry.hidden = true;
		}
		if (ds.source_crs && !isOperationOutput) {
			entry.crs = ds.source_crs;
		}

		// Style diffing (skip if covered by explicit layers)
		if (!coveredDatasetIds.has(ds.id)) {
			const style: StyleConfig = parseStyleJson(ds.style);
			const styleDiff = diffStyle(style);
			if (styleDiff) {
				entry.style = styleDiff;
			}
		}

		datasetEntries.push(entry);
	}

	if (datasetEntries.length > 0) {
		config.datasets = datasetEntries;
	}

	// No operations section - that's the point of viewer config

	if (layerConfigs.length > 0) {
		config.layers = layerConfigs;
	}

	// Serialize YAML
	const yamlStr = yaml.dump(config, {
		lineWidth: -1,
		noRefs: true,
		quotingType: '"',
	});

	// Build zip contents
	const files: Record<string, Uint8Array> = {
		'config.yaml': encoder.encode(yamlStr),
	};

	// Export GeoJSON for each dataset that needs it
	for (const { datasetId, filename } of toExport) {
		const fc = await getFeaturesAsGeoJSON(datasetId);
		const json = JSON.stringify(fc);
		files[`data/${filename}`] = encoder.encode(json);
	}

	// Create zip and trigger download
	const zipData = zipSync(files);
	const blob = new Blob([new Uint8Array(zipData)], { type: 'application/zip' });
	const url = URL.createObjectURL(blob);

	const a = document.createElement('a');
	a.href = url;
	a.download = 'viewer-config.zip';
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
}
