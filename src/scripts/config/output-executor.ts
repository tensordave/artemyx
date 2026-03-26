import type { OutputConfig, OutputFormat } from './types';
import type { OutputResult, OutputProgressCallback } from './output-types';
import type { DatasetConfig } from './types';
import { exportAsGeoJSON, exportAsCSV, exportAsParquet, exportAsPMTiles, extractPMTiles, datasetExists } from '../db';

const MIME_TYPES: Record<OutputFormat, string> = {
	geojson: 'application/geo+json',
	csv: 'text/csv',
	parquet: 'application/octet-stream',
	pmtiles: 'application/octet-stream',
};

/**
 * Pre-check that all output sources exist in DuckDB.
 * Returns missing source IDs so the UI can show a clear message.
 * PMTiles extraction outputs (those with extractZoom) are skipped —
 * they resolve the URL from the config datasets, not from DuckDB.
 */
export async function checkSourcesExist(
	outputs: OutputConfig[]
): Promise<{ allExist: boolean; missing: string[] }> {
	// Extraction outputs don't need DuckDB — skip their sources
	const extractionSources = new Set(
		outputs
			.filter(o => o.format === 'pmtiles' && o.params?.extractZoom !== undefined)
			.map(o => o.source)
	);
	const uniqueSources = [...new Set(outputs.map(o => o.source))]
		.filter(id => !extractionSources.has(id));
	const checks = await Promise.all(
		uniqueSources.map(async (id) => ({ id, exists: await datasetExists(id) }))
	);
	const missing = checks.filter(c => !c.exists).map(c => c.id);
	return { allExist: missing.length === 0, missing };
}

/**
 * Execute outputs from config.
 * Calls worker RPCs to generate export buffers, creates blob URLs for download.
 * Outputs execute sequentially to avoid memory pressure from multiple large buffers.
 * The onProgress callback fires at each status transition so the UI can update live.
 *
 * @param datasets Parsed config datasets — used to resolve source URLs for PMTiles extraction
 *                 outputs that bypass DuckDB.
 */
export async function executeOutputs(
	outputs: OutputConfig[],
	onProgress?: OutputProgressCallback,
	datasets?: DatasetConfig[]
): Promise<OutputResult[]> {
	const results: OutputResult[] = [];

	for (let i = 0; i < outputs.length; i++) {
		const output = outputs[i];
		const filename = `${output.filename || output.source}.${output.format}`;

		// Notify: generating
		const generating: OutputResult = {
			source: output.source,
			filename,
			format: output.format,
			blobUrl: null,
			size: 0,
			pending: true,
			status: 'generating',
			statusMessage: 'Generating...',
		};
		onProgress?.(i, generating);

		try {
			let buffer: Uint8Array;

			switch (output.format) {
				case 'geojson':
					buffer = await exportAsGeoJSON(output.source);
					break;
				case 'csv':
					buffer = await exportAsCSV(output.source);
					break;
				case 'parquet':
					buffer = await exportAsParquet(output.source);
					break;
				case 'pmtiles':
					if (output.params?.extractZoom !== undefined) {
						const sourceDataset = datasets?.find(d => d.id === output.source);
						if (!sourceDataset?.url) {
							throw new Error(`Cannot resolve URL for PMTiles source '${output.source}'`);
						}
						buffer = await extractPMTiles(
							sourceDataset.url,
							output.params.extractZoom,
							output.params.bbox!,
							output.params.layers,
							output.params
						);
					} else {
						buffer = await exportAsPMTiles(output.source, output.params);
					}
					break;
				default: {
					const _exhaustive: never = output.format;
					throw new Error(`Unsupported output format: ${_exhaustive}`);
				}
			}

			const blob = new Blob([buffer.buffer as ArrayBuffer], { type: MIME_TYPES[output.format] });
			const blobUrl = URL.createObjectURL(blob);

			const complete: OutputResult = {
				source: output.source,
				filename,
				format: output.format,
				blobUrl,
				size: blob.size,
				pending: false,
				status: 'complete',
			};
			results.push(complete);
			onProgress?.(i, complete);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			const errResult: OutputResult = {
				source: output.source,
				filename,
				format: output.format,
				blobUrl: null,
				size: 0,
				error: msg,
				pending: false,
				status: 'error',
			};
			results.push(errResult);
			onProgress?.(i, errResult);
		}
	}

	return results;
}
