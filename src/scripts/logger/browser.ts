import type { ProgressControl } from '../controls/progress-control';
import type { Logger, ProgressStatus } from './types';

export class BrowserLogger implements Logger {
	constructor(private progressControl: ProgressControl) {}

	info(prefix: string, message: string, ...args: unknown[]): void {
		console.log(`[${prefix}]`, message, ...args);
	}

	warn(prefix: string, message: string, ...args: unknown[]): void {
		console.warn(`[${prefix}]`, message, ...args);
	}

	error(prefix: string, message: string, ...args: unknown[]): void {
		console.error(`[${prefix}]`, message, ...args);
	}

	progress(operation: string, status: ProgressStatus, message?: string): void {
		this.progressControl.updateProgress(operation, status, message);
	}

	scheduleIdle(delay: number): void {
		this.progressControl.scheduleIdle(delay);
	}
}
