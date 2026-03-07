export type ProgressStatus = 'idle' | 'loading' | 'processing' | 'success' | 'error';

export interface Logger {
	info(prefix: string, message: string, ...args: unknown[]): void;
	warn(prefix: string, message: string, ...args: unknown[]): void;
	error(prefix: string, message: string, ...args: unknown[]): void;
	progress(operation: string, status: ProgressStatus, message?: string): void;
	scheduleIdle(delay: number): void;
}
