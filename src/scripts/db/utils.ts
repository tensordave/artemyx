/**
 * Database utility functions
 */

/**
 * Convert a display name to a valid dataset ID (slug).
 * Lowercase, non-alphanumeric → underscores, collapsed, trimmed.
 */
export function slugifyDatasetId(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '')
		.slice(0, 60);
	return slug || `dataset_${Date.now().toString(16)}`;
}

/**
 * Generate a dataset ID from a source URL
 */
export function generateDatasetId(sourceUrl: string): string {
	// Simple hash function for consistent dataset IDs
	let hash = 0;
	for (let i = 0; i < sourceUrl.length; i++) {
		const char = sourceUrl.charCodeAt(i);
		hash = ((hash << 5) - hash) + char;
		hash = hash & hash; // Convert to 32-bit integer
	}
	return `dataset_${Math.abs(hash).toString(16)}`;
}

/**
 * Extract a human-readable name from a source URL
 */
export function extractDatasetName(sourceUrl: string): string {
	try {
		const url = new URL(sourceUrl);
		const pathParts = url.pathname.split('/').filter(p => p.length > 0);
		if (pathParts.length > 0) {
			const lastPart = pathParts[pathParts.length - 1];
			// Remove file extension if present
			return lastPart.replace(/\.[^/.]+$/, '');
		}
		return url.hostname;
	} catch {
		return sourceUrl.substring(0, 30);
	}
}
