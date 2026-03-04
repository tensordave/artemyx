import type { Map, IControl } from 'maplibre-gl';
import { codeBlockIcon } from './icons';

/**
 * Custom MapLibre control for viewing the active YAML config.
 * Reads pre-highlighted Shiki HTML from a hidden #config-highlighted element
 * injected at build time by each Astro page.
 */
export class ConfigControl implements IControl {
	private map: Map | null = null;
	private container: HTMLDivElement | null = null;
	private panel: HTMLDivElement | null = null;
	private isOpen = false;

	private handleEsc = (e: KeyboardEvent) => {
		if (e.key === 'Escape') this.close();
	};

	onAdd(map: Map): HTMLElement {
		this.map = map;

		this.container = document.createElement('div');
		this.container.className = 'maplibregl-ctrl config-control';

		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'control-btn';
		btn.title = 'View config';
		btn.innerHTML = codeBlockIcon;
		btn.addEventListener('click', () => this.toggle());
		this.container.appendChild(btn);

		// Build panel and append to map container (not control group)
		// so it can be positioned freely over the map
		this.panel = this.buildPanel();
		map.getContainer().appendChild(this.panel);

		return this.container;
	}

	onRemove(): void {
		document.removeEventListener('keydown', this.handleEsc);
		this.panel?.remove();
		this.container?.remove();
		this.map = null;
		this.container = null;
		this.panel = null;
	}

	private buildPanel(): HTMLDivElement {
		const sourceEl = document.getElementById('config-highlighted');

		const panel = document.createElement('div');
		panel.className = 'config-viewer';

		// Header
		const header = document.createElement('div');
		header.className = 'config-viewer-header';

		const filename = document.createElement('span');
		filename.className = 'config-viewer-filename';
		filename.textContent = sourceEl?.dataset.configFilename ?? 'config.yaml';
		header.appendChild(filename);

		const closeBtn = document.createElement('button');
		closeBtn.type = 'button';
		closeBtn.className = 'config-viewer-close';
		closeBtn.textContent = '\u00d7';
		closeBtn.addEventListener('click', () => this.close());
		header.appendChild(closeBtn);

		panel.appendChild(header);

		// Body (Shiki-highlighted content)
		const body = document.createElement('div');
		body.className = 'config-viewer-body';
		if (sourceEl) {
			body.innerHTML = sourceEl.innerHTML;
		}
		panel.appendChild(body);

		return panel;
	}

	private toggle(): void {
		if (this.isOpen) {
			this.close();
		} else {
			this.open();
		}
	}

	private open(): void {
		if (!this.panel) return;
		this.isOpen = true;
		this.panel.classList.add('config-viewer--open');
		document.addEventListener('keydown', this.handleEsc);
	}

	private close(): void {
		if (!this.panel) return;
		this.isOpen = false;
		this.panel.classList.remove('config-viewer--open');
		document.removeEventListener('keydown', this.handleEsc);
	}
}
