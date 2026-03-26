import type { OutputFormat } from './types';

export type OutputStatus = 'pending' | 'generating' | 'complete' | 'error';

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
	/** Lifecycle status */
	status: OutputStatus;
	/** Human-readable progress message (e.g. "Zoom 5/14: 42 tiles") */
	statusMessage?: string;
	/** Numeric progress 0-1 for determinate progress bar; undefined = indeterminate */
	progress?: number;
}

/** Callback for streaming output progress to the UI */
export type OutputProgressCallback = (index: number, result: OutputResult) => void;

/** Revoke all blob URLs in an OutputResult array */
export function revokeOutputBlobs(results: OutputResult[]): void {
	for (const r of results) {
		if (r.blobUrl) {
			URL.revokeObjectURL(r.blobUrl);
			r.blobUrl = null;
		}
	}
}
