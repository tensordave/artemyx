/**
 * Export dataset as GeoJSON file download.
 * Queries DuckDB for the dataset features and triggers a browser download.
 */

import { getFeaturesAsGeoJSON } from '../db';

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
