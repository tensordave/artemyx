import maplibregl from 'maplibre-gl';
import { getFeaturesAsGeoJSON, getDatasets, datasetExists } from '../db';
import type { LoadGeoJSONOptions as DBLoadOptions } from '../db/datasets';
import type { LayerToggleControl } from '../layer-control';
import type { Logger } from '../logger';
import type { DatasetConfig, LayerConfig } from '../config/types';
import { parseDatasetStyle, addDatasetToMap, fitMapToFeatures } from './shared';
import { loadDataFromUrl } from './load-url';

/** Options for loading datasets from config */
export interface ConfigLoadOptions {
	map: maplibregl.Map;
	logger: Logger;
	layerToggleControl: LayerToggleControl;
	loadedDatasets: Set<string>;
	/**
	 * Explicit layer configs from YAML.
	 * When defined, skip auto-generating default layers (the layer config handles them).
	 * When undefined, auto-generate fill/line/circle layers per dataset.
	 */
	layers?: LayerConfig[];
	/** Fallback CRS from map-level config (for formats without file metadata) */
	mapCrs?: string;
}

/** Result of loading datasets from config */
export interface ConfigLoadResult {
	/** Number of datasets successfully loaded */
	loaded: number;
	/** Number of datasets skipped (already loaded) */
	skipped: number;
	/** Number of datasets that failed to load */
	failed: number;
	/** Error messages for failed datasets */
	errors: string[];
}

/**
 * Load multiple datasets from YAML config.
 * Continues on errors, skips duplicates, fits bounds once at end.
 */
export async function loadDatasetsFromConfig(
	datasets: DatasetConfig[],
	options: ConfigLoadOptions
): Promise<ConfigLoadResult> {
	const { map, logger, layerToggleControl, loadedDatasets, layers } = options;
	const result: ConfigLoadResult = {
		loaded: 0,
		skipped: 0,
		failed: 0,
		errors: []
	};

	if (!datasets || datasets.length === 0) {
		return result;
	}

	logger.progress('config', 'loading', `Loading ${datasets.length} dataset(s) from config...`);

	// Build set of source IDs that have explicit layer entries in config.
	// Datasets covered by an explicit layer skip auto-layer creation (the layer config handles them).
	// Datasets NOT covered get fallback default layers so they're visible and interactable.
	const coveredSources = new Set(layers?.map(l => l.source) ?? []);

	for (const dataset of datasets) {
		const displayName = dataset.name || dataset.id;
		const isHidden = !!dataset.hidden;
		const skipLayers = !!layers && coveredSources.has(dataset.id);

		// Check for duplicate (by config ID)
		if (loadedDatasets.has(dataset.id)) {
			logger.progress(dataset.id, 'success', `Skipped (already loaded)`);
			result.skipped++;
			continue;
		}

		// OPFS restore: if dataset already exists in DuckDB, render from persisted data
		if (await datasetExists(dataset.id)) {
			try {
				const geoJsonData = await getFeaturesAsGeoJSON(dataset.id);
				if (geoJsonData.features && geoJsonData.features.length > 0) {
					// Hidden datasets: mark loaded but skip map rendering
					if (isHidden) {
						loadedDatasets.add(dataset.id);
						logger.progress(displayName, 'success', `Restored from session (${geoJsonData.features.length} features, hidden)`);
						result.loaded++;
						continue;
					}

					const allDatasets = await getDatasets();
					const meta = allDatasets.find((d: any) => d.id === dataset.id);
					const color = meta?.color || dataset.color || '#3388ff';
					const style = parseDatasetStyle(meta?.style);

					addDatasetToMap(map, dataset.id, color, style, geoJsonData, skipLayers);
					loadedDatasets.add(dataset.id);

					layerToggleControl.refreshPanel();

					logger.progress(displayName, 'success', `Restored from session (${geoJsonData.features.length} features)`);
					result.loaded++;
					continue;
				}
			} catch (e) {
				logger.warn('OPFS', `Failed to restore ${dataset.id}, will re-fetch:`, e);
			}
		}

		// Build config overrides from dataset config
		// Use config ID as dataset_id so operations can reference it
		const configOverrides: DBLoadOptions = {
			id: dataset.id,
			name: displayName,
			color: dataset.color,
			style: dataset.style,
			hidden: isHidden
		};

		// Load dataset with overrides, passing format and column options from config
		const success = await loadDataFromUrl(dataset.url, {
			map,
			logger,
			layerToggleControl,
			loadedDatasets,
			configOverrides,
			displayName,
			skipFitBounds: true,
			skipErrorDialog: true,
			skipLayers,
			hidden: isHidden,
			format: dataset.format,
			latColumn: dataset.latColumn,
			lngColumn: dataset.lngColumn,
			geoColumn: dataset.geoColumn,
			paginate: dataset.paginate,
			crs: dataset.crs,
			mapCrs: options.mapCrs,
		});

		if (success) {
			result.loaded++;
		} else {
			result.failed++;
			result.errors.push(`${dataset.id}: Failed to load from ${dataset.url}`);
		}
	}

	// Fit bounds to datasets that haven't opted out (fitBounds defaults to true)
	const boundsDatasets = datasets.filter(d => d.fitBounds !== false && loadedDatasets.has(d.id));
	if (boundsDatasets.length > 0) {
		try {
			const allFeatures: GeoJSON.Feature[] = [];
			for (const d of boundsDatasets) {
				const fc = await getFeaturesAsGeoJSON(d.id);
				if (fc.features) allFeatures.push(...fc.features);
			}
			if (allFeatures.length > 0) {
				fitMapToFeatures(map, { type: 'FeatureCollection', features: allFeatures });
			}
		} catch (e) {
			logger.error('Config', 'Failed to fit bounds after config load:', e);
		}
	}

	// Show summary
	const summaryParts: string[] = [];
	if (result.loaded > 0) summaryParts.push(`${result.loaded} loaded`);
	if (result.skipped > 0) summaryParts.push(`${result.skipped} skipped`);
	if (result.failed > 0) summaryParts.push(`${result.failed} failed`);

	const status = result.failed > 0 ? 'error' : 'success';
	logger.progress('config', status, summaryParts.join(', '));

	// Schedule idle - will be auto-cancelled if operations start via updateProgress()
	logger.scheduleIdle(result.failed > 0 ? 5000 : 3000);

	return result;
}
