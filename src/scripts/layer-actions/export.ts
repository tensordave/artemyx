/**
 * Export dataset as GeoJSON file download.
 * Queries DuckDB for the dataset features and triggers a browser download.
 */

import { getFeaturesAsGeoJSON, exportAsGeoJSON, exportAsCSV, exportAsParquet, exportAsPMTiles } from '../db';

/**
 * Sanitize a dataset name into a safe filename.
 * Replaces non-alphanumeric characters (except hyphens) with hyphens, lowercases, trims edges.
 */
export function toFilename(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		|| 'dataset';
}

/**
 * Export a dataset as a GeoJSON file download.
 * Fetches features from DuckDB via the worker and triggers a browser download.
 */
export async function exportDatasetAsGeoJSON(datasetId: string, datasetName: string): Promise<void> {
	const fc = await getFeaturesAsGeoJSON(datasetId);
	const json = JSON.stringify(fc);
	const blob = new Blob([json], { type: 'application/geo+json' });
	const url = URL.createObjectURL(blob);

	const a = document.createElement('a');
	a.href = url;
	a.download = `${toFilename(datasetName)}.geojson`;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
}

export type ExportFormat = 'geojson' | 'csv' | 'parquet' | 'pmtiles';

const MIME_TYPES: Record<ExportFormat, string> = {
	geojson: 'application/geo+json',
	csv: 'text/csv',
	parquet: 'application/octet-stream',
	pmtiles: 'application/octet-stream',
};

/**
 * Export a dataset in the specified format via worker RPC and trigger a browser download.
 * PMTiles uses default zoom range (0-14); for custom params use the Outputs Helper.
 */
export async function exportDatasetAs(datasetId: string, datasetName: string, format: ExportFormat): Promise<void> {
	let buffer: Uint8Array;
	switch (format) {
		case 'geojson':
			buffer = await exportAsGeoJSON(datasetId);
			break;
		case 'csv':
			buffer = await exportAsCSV(datasetId);
			break;
		case 'parquet':
			buffer = await exportAsParquet(datasetId);
			break;
		case 'pmtiles':
			buffer = await exportAsPMTiles(datasetId, { minzoom: 0, maxzoom: 14 });
			break;
	}

	const blob = new Blob([buffer as BlobPart], { type: MIME_TYPES[format] });
	const url = URL.createObjectURL(blob);

	const a = document.createElement('a');
	a.href = url;
	a.download = `${toFilename(datasetName)}.${format}`;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
}
