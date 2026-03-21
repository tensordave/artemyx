import type maplibregl from 'maplibre-gl';
import { getFeaturesAsGeoJSON, getDatasetById, datasetExists, updateDatasetVisible } from '../db';
import type { LoadGeoJSONOptions as DBLoadOptions } from '../db/constants';
import type { LayerToggleControl } from '../controls/layer-control';
import type { Logger } from '../logger';
import type { DatasetConfig, LayerConfig } from '../config/types';
import { parseDatasetStyle, addDatasetToMap } from './shared';
import { loadDataFromUrl } from './load-url';
import { loadDataFromFile } from './load-file';
import { loadPMTilesDataset } from './load-pmtiles';
import { showFilePromptDialog } from '../ui/error-dialog';

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

		// PMTiles datasets bypass the DuckDB/loader pipeline entirely
		const isPMTiles = dataset.format === 'pmtiles' ||
			(!dataset.format && dataset.url && dataset.url.endsWith('.pmtiles'));

		if (isPMTiles) {
			try {
				const success = await loadPMTilesDataset(dataset, {
					map, logger, layerToggleControl, loadedDatasets, layers
				});
				if (success) {
					if (dataset.visible === false) await updateDatasetVisible(dataset.id, false);
					result.loaded++;
				} else {
					result.failed++;
					result.errors.push(`${dataset.id}: Failed to load PMTiles`);
				}
			} catch (e) {
				const msg = e instanceof Error ? e.message : 'Unknown error';
				logger.progress(displayName, 'error', msg);
				result.failed++;
				result.errors.push(`${dataset.id}: ${msg}`);
			}
			continue;
		}

		// OPFS / DuckDB restore: if dataset already exists in DuckDB, render from persisted data.
		// This handles both OPFS session restore and file-uploaded datasets (url: "")
		// that were preserved during selective teardown.
		if (await datasetExists(dataset.id)) {
			try {
				const meta = await getDatasetById(dataset.id);

				// PMTiles datasets: re-add vector source from persisted metadata
				if (meta?.format === 'pmtiles' && meta.source_url) {
					const { getSourceId, addVectorSource, addDefaultVectorLayers } = await import('../layers');
					const { attachFeatureClickHandlers, attachFeatureHoverHandlers } = await import('../controls/popup');

					const sourceId = getSourceId(dataset.id);
					addVectorSource(map, sourceId, meta.source_url);

					if (!isHidden) {
						const color = meta.color || dataset.color || '#3388ff';
						const style = parseDatasetStyle(meta.style);
						const restoredSourceLayer = meta.source_layer || dataset.sourceLayer;

						if (restoredSourceLayer && !skipLayers) {
							const layerIds = addDefaultVectorLayers(map, sourceId, dataset.id, color, style, restoredSourceLayer);
							if (layerIds.length > 0) {
								const hoverPopup = attachFeatureHoverHandlers(map, layerIds, { label: displayName });
								attachFeatureClickHandlers(map, layerIds, hoverPopup);
							}
						}
					}

					loadedDatasets.add(dataset.id);
					layerToggleControl.refreshPanel();
					logger.progress(displayName, 'success', 'Restored PMTiles from session');
					if (dataset.visible === false) await updateDatasetVisible(dataset.id, false);
					result.loaded++;
					continue;
				}

				// Hidden datasets: already in DuckDB, no rendering needed - skip GeoJSON materialization entirely
				if (isHidden) {
					loadedDatasets.add(dataset.id);
					const count = meta?.feature_count ?? 0;
					logger.progress(displayName, 'success', `Restored from session (${count} features, hidden)`);
					result.loaded++;
					continue;
				}

				let geoJsonData = await getFeaturesAsGeoJSON(dataset.id);
				if (geoJsonData.features && geoJsonData.features.length > 0) {
					const meta = await getDatasetById(dataset.id);
					const color = meta?.color || dataset.color || '#3388ff';
					const style = parseDatasetStyle(meta?.style);
					const featureCount = geoJsonData.features.length;

					addDatasetToMap(map, dataset.id, color, style, geoJsonData, skipLayers);
					// Release GeoJSON reference - MapLibre owns the data now
					geoJsonData = null as any;
					loadedDatasets.add(dataset.id);

					layerToggleControl.refreshPanel();

					logger.progress(displayName, 'success', `Restored from session (${featureCount} features)`);
					if (dataset.visible === false) await updateDatasetVisible(dataset.id, false);
					result.loaded++;
					continue;
				}
			} catch (e) {
				logger.warn('OPFS', `Failed to restore ${dataset.id}, will re-fetch:`, e);
			}
		}

		// Local dataset (file-upload placeholder or relative path) and not in DuckDB - prompt for file
		const isLocalUrl = !dataset.url || dataset.url.startsWith('./') || dataset.url.startsWith('../');
		if (isLocalUrl) {
			// Extract filename hint from sourceFile field, relative path basename, or nothing
			const filenameHint = dataset.sourceFile
				|| (dataset.url ? dataset.url.split('/').pop() : undefined);

			const file = await showFilePromptDialog(displayName, filenameHint);

			if (!file) {
				logger.progress(displayName, 'error', 'Local dataset skipped');
				result.skipped++;
				continue;
			}

			const configOverrides: DBLoadOptions = {
				id: dataset.id,
				name: displayName,
				color: dataset.color,
				style: dataset.style,
				hidden: isHidden
			};

			const success = await loadDataFromFile(file, {
				map,
				logger,
				layerToggleControl,
				loadedDatasets,
				configOverrides,
				skipFitBounds: true,
				skipErrorDialog: true,
				skipLayers,
				hidden: isHidden,
				format: dataset.format,
				crs: dataset.crs,
				latColumn: dataset.latColumn,
				lngColumn: dataset.lngColumn,
				geoColumn: dataset.geoColumn,
			});

			if (success) {
				if (dataset.visible === false) await updateDatasetVisible(dataset.id, false);
				result.loaded++;
			} else {
				result.failed++;
				result.errors.push(`${dataset.id}: Failed to load from file`);
			}
			continue;
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
			if (dataset.visible === false) await updateDatasetVisible(dataset.id, false);
			result.loaded++;
		} else {
			result.failed++;
			result.errors.push(`${dataset.id}: Failed to load from ${dataset.url}`);
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
