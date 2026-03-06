/**
 * Paginated API detection and fetch loop.
 *
 * Detects pagination from the first response and provides an async generator
 * for fetching subsequent pages. Supports:
 * - ArcGIS REST (exceededTransferLimit + resultOffset, f=geojson only)
 * - OGC API Features (links[rel=next])
 * - Socrata (URL pattern + $offset/$limit)
 */

/** Default safety cap on number of pages to prevent runaway loops */
const DEFAULT_MAX_PAGES = 100;

export type PaginationApiType = 'arcgis' | 'ogc' | 'socrata';

export interface PaginationResult {
	/** Already-parsed JSON from the first fetch */
	firstPage: any;
	/** Whether more pages are available beyond the first */
	paginated: boolean;
	/** Async generator yielding subsequent pages as parsed JSON (undefined if not paginated) */
	pages?: AsyncGenerator<any, void, unknown>;
	/** Detected API type (undefined if not paginated) */
	apiType?: PaginationApiType;
}

export interface PaginationOptions {
	/** Maximum number of pages to fetch (including first page). Default: 100 */
	maxPages?: number;
	/** Force pagination detection even if auto-detect doesn't trigger */
	force?: boolean;
}

// ── Detection ────────────────────────────────────────────────────────

/**
 * Detect ArcGIS REST pagination.
 * Requires `exceededTransferLimit: true` in response AND `f=geojson` in the URL.
 */
function detectArcGIS(data: any, url: string): boolean {
	if (!data || typeof data !== 'object') return false;
	if (!data.exceededTransferLimit) return false;
	if (!Array.isArray(data.features)) return false;

	// Only support GeoJSON output format - we don't convert native ArcGIS format
	try {
		const params = new URL(url).searchParams;
		const format = params.get('f') || params.get('F') || '';
		return format.toLowerCase() === 'geojson';
	} catch {
		return false;
	}
}

/**
 * Detect OGC API Features pagination.
 * Looks for a `links` array containing `{ rel: "next", href: "..." }`.
 */
function detectOGC(data: any): boolean {
	if (!data || typeof data !== 'object') return false;
	if (!Array.isArray(data.links)) return false;
	return data.links.some((link: any) =>
		link && typeof link === 'object' && link.rel === 'next' && typeof link.href === 'string'
	);
}

/**
 * Extract the item count from a Socrata response.
 * Socrata .json endpoints return plain arrays; .geojson endpoints return FeatureCollections.
 * Returns 0 if the data doesn't match either shape.
 */
function socrataItemCount(data: any): number {
	if (Array.isArray(data)) return data.length;
	if (data && typeof data === 'object' && data.type === 'FeatureCollection' && Array.isArray(data.features)) {
		return data.features.length;
	}
	return 0;
}

/**
 * Detect Socrata pagination.
 * URL must contain `/resource/` (Socrata API pattern) and response must be
 * a non-empty array (.json) or a FeatureCollection with features (.geojson).
 * Pagination is signaled by the item count equaling the page limit (default 1000).
 */
function detectSocrata(data: any, url: string): boolean {
	const count = socrataItemCount(data);
	if (count === 0) return false;
	try {
		const parsed = new URL(url);
		if (!parsed.pathname.includes('/resource/')) return false;

		// Heuristic: Socrata doesn't signal "more pages". If the count equals
		// the limit (explicit $limit or default 1000), there are likely more.
		const explicitLimit = parsed.searchParams.get('$limit');
		const pageLimit = explicitLimit ? parseInt(explicitLimit, 10) : 1000;
		return count >= pageLimit;
	} catch {
		return false;
	}
}

// ── Page generators ──────────────────────────────────────────────────

/**
 * ArcGIS REST page generator.
 * Increments `resultOffset` by the feature count of each page.
 */
async function* arcgisPages(url: string, firstPageCount: number, maxPages: number): AsyncGenerator<any, void, unknown> {
	let offset = firstPageCount;
	let page = 2; // first page was already fetched

	while (page <= maxPages) {
		const pageUrl = new URL(url);
		pageUrl.searchParams.set('resultOffset', String(offset));

		console.log(`[Paginator] ArcGIS page ${page}, offset ${offset}`);
		const response = await fetch(pageUrl.toString());
		if (!response.ok) {
			throw new Error(`Pagination fetch failed: HTTP ${response.status}`);
		}

		const data = await response.json();
		yield data;

		// Stop if no more pages
		if (!data.exceededTransferLimit) break;
		if (!Array.isArray(data.features) || data.features.length === 0) break;

		offset += data.features.length;
		page++;
	}
}

/**
 * OGC API Features page generator.
 * Follows the `next` link from each response.
 */
async function* ogcPages(firstData: any, maxPages: number): AsyncGenerator<any, void, unknown> {
	let currentData = firstData;
	let page = 2;

	while (page <= maxPages) {
		const nextLink = currentData.links?.find((link: any) =>
			link && link.rel === 'next' && typeof link.href === 'string'
		);
		if (!nextLink) break;

		console.log(`[Paginator] OGC page ${page}, following next link`);
		const response = await fetch(nextLink.href);
		if (!response.ok) {
			throw new Error(`Pagination fetch failed: HTTP ${response.status}`);
		}

		const data = await response.json();
		yield data;

		// Stop if empty or no more next links
		if (!Array.isArray(data.features) || data.features.length === 0) break;

		currentData = data;
		page++;
	}
}

/**
 * Socrata page generator.
 * Increments `$offset` by the page size on each request.
 * Handles both plain arrays (.json) and FeatureCollections (.geojson).
 */
async function* socrataPages(url: string, firstPageCount: number, maxPages: number): AsyncGenerator<any, void, unknown> {
	// Determine page size from first response or existing $limit
	let pageSize: number;
	try {
		const existingLimit = new URL(url).searchParams.get('$limit');
		pageSize = existingLimit ? parseInt(existingLimit, 10) : firstPageCount;
	} catch {
		pageSize = firstPageCount;
	}
	if (!pageSize || pageSize <= 0) return;

	let offset = pageSize;
	let page = 2;

	while (page <= maxPages) {
		const pageUrl = new URL(url);
		pageUrl.searchParams.set('$offset', String(offset));
		if (!pageUrl.searchParams.has('$limit')) {
			pageUrl.searchParams.set('$limit', String(pageSize));
		}

		console.log(`[Paginator] Socrata page ${page}, offset ${offset}`);
		const response = await fetch(pageUrl.toString());
		if (!response.ok) {
			throw new Error(`Pagination fetch failed: HTTP ${response.status}`);
		}

		const data = await response.json();

		// Stop if empty response (handles both arrays and FeatureCollections)
		const count = socrataItemCount(data);
		if (count === 0) break;

		yield data;

		// Stop if we got fewer than the page size (last page)
		if (count < pageSize) break;

		offset += count;
		page++;
	}
}

// ── Main entry point ─────────────────────────────────────────────────

/**
 * Fetch a URL and detect if the response is paginated.
 *
 * Returns the first page (already parsed) and, if paginated, an async generator
 * that yields subsequent pages. The caller is responsible for normalizing each
 * page into GeoJSON features via the appropriate loader.
 */
export async function fetchWithPagination(
	url: string,
	options?: PaginationOptions
): Promise<PaginationResult> {
	const maxPages = options?.maxPages ?? DEFAULT_MAX_PAGES;

	// Fetch first page
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`HTTP error! status: ${response.status}`);
	}

	// Check Content-Type to avoid trying to parse non-JSON as paginated
	const contentType = response.headers.get('Content-Type') || '';
	const isJson = contentType.includes('json') || contentType.includes('text/plain');

	// For non-JSON responses (parquet, csv), return as non-paginated
	// The caller will handle these via the normal loader dispatch path
	if (!isJson) {
		// We can't parse this as JSON, so return the raw response for the caller
		// to handle via normal loaders. We store the response itself as firstPage.
		return { firstPage: response, paginated: false };
	}

	const data = await response.json();

	// Detect API type
	if (detectArcGIS(data, url)) {
		const featureCount = Array.isArray(data.features) ? data.features.length : 0;
		console.log(`[Paginator] Detected ArcGIS pagination (${featureCount} features in first page)`);
		return {
			firstPage: data,
			paginated: true,
			pages: arcgisPages(url, featureCount, maxPages),
			apiType: 'arcgis',
		};
	}

	if (detectOGC(data)) {
		const featureCount = Array.isArray(data.features) ? data.features.length : 0;
		console.log(`[Paginator] Detected OGC API Features pagination (${featureCount} features in first page)`);
		return {
			firstPage: data,
			paginated: true,
			pages: ogcPages(data, maxPages),
			apiType: 'ogc',
		};
	}

	if (detectSocrata(data, url)) {
		const itemCount = socrataItemCount(data);
		console.log(`[Paginator] Detected Socrata pagination (${itemCount} items in first page)`);
		return {
			firstPage: data,
			paginated: true,
			pages: socrataPages(url, itemCount, maxPages),
			apiType: 'socrata',
		};
	}

	// Force pagination if requested but auto-detect didn't trigger
	// This is a no-op for now since we don't know the API type
	if (options?.force) {
		console.warn('[Paginator] paginate: true set but no known pagination pattern detected');
	}

	return { firstPage: data, paginated: false };
}
