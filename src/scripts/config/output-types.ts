import type { OutputFormat } from './types';

/** Result of a single output execution */
export interface OutputResult {
	/** Source dataset ID */
	source: string;
	/** Resolved filename (with extension) */
	filename: string;
	/** Output format */
	format: OutputFormat;
	/** Generated blob URL for download */
	blobUrl: string | null;
	/** File size in bytes */
	size: number;
	/** Error message if this output failed */
	error?: string;
	/** Whether this output is still being generated */
	pending: boolean;
}

/** Revoke all blob URLs in an OutputResult array */
export function revokeOutputBlobs(results: OutputResult[]): void {
	for (const r of results) {
		if (r.blobUrl) {
			URL.revokeObjectURL(r.blobUrl);
			r.blobUrl = null;
		}
	}
}
