/**
 * Dismissible warning banner for Safari users.
 * Shown when DuckDB-WASM is gated due to per-tab memory limits.
 */
import { warningIcon } from '../icons';

export function showSafariBanner(mapContainer: HTMLElement): void {
	const banner = document.createElement('div');
	banner.className = 'safari-banner';

	const icon = document.createElement('span');
	icon.className = 'safari-banner-icon';
	icon.innerHTML = warningIcon;

	const text = document.createElement('span');
	text.className = 'safari-banner-text';
	text.textContent =
		'Safari is not supported. DuckDB-WASM requires more memory than Safari allows per tab. Please use Chrome, Firefox, or Edge.';

	const dismiss = document.createElement('button');
	dismiss.className = 'safari-banner-dismiss';
	dismiss.textContent = 'Dismiss';
	dismiss.setAttribute('aria-label', 'Dismiss banner');
	dismiss.addEventListener('click', () => banner.remove());

	banner.appendChild(icon);
	banner.appendChild(text);
	banner.appendChild(dismiss);
	mapContainer.appendChild(banner);
}
