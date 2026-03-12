/**
 * Detect Safari browser (excluding Chrome/Android which include "Safari" in UA).
 * Used to gate DuckDB-WASM initialization — Safari's per-tab memory limits
 * cause stability crashes with our worker + WASM stack.
 */
export function isSafari(): boolean {
	if (typeof navigator === 'undefined') return false;
	return /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
}
