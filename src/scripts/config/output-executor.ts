import type { OutputConfig, OutputFormat } from './types';
import type { OutputResult } from './output-types';
import { exportAsGeoJSON, exportAsCSV, exportAsParquet } from '../db';

const MIME_TYPES: Record<OutputFormat, string> = {
	geojson: 'application/geo+json',
	csv: 'text/csv',
	parquet: 'application/octet-stream',
};

/**
 * Execute outputs from config.
 * Calls worker RPCs to generate export buffers, creates blob URLs for download.
 * Outputs execute sequentially to avoid memory pressure from multiple large buffers.
 */
export async function executeOutputs(
	outputs: OutputConfig[],
	onProgress?: (source: string, status: string) => void
): Promise<OutputResult[]> {
	const results: OutputResult[] = [];

	for (const output of outputs) {
		const filename = `${output.filename || output.source}.${output.format}`;
		onProgress?.(output.source, `Generating ${filename}...`);

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
				default: {
					const _exhaustive: never = output.format;
					throw new Error(`Unsupported output format: ${_exhaustive}`);
				}
			}

			const blob = new Blob([buffer.buffer as ArrayBuffer], { type: MIME_TYPES[output.format] });
			const blobUrl = URL.createObjectURL(blob);

			results.push({
				source: output.source,
				filename,
				format: output.format,
				blobUrl,
				size: blob.size,
				pending: false,
			});

			onProgress?.(output.source, `Generated ${filename}`);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			results.push({
				source: output.source,
				filename,
				format: output.format,
				blobUrl: null,
				size: 0,
				error: msg,
				pending: false,
			});

			onProgress?.(output.source, `Failed: ${msg}`);
		}
	}

	return results;
}
