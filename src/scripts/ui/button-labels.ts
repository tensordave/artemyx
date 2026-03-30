const STORAGE_KEY = 'artemyx-show-labels';

const LABEL_MAP: Record<string, string> = {
	'Load Data': 'Data',
	'Upload File': 'Upload',
	'Operation Builder': 'Operations',
	'Config Editor': 'Config',
	'Toggle layers': 'Layers',
	'Switch basemap': 'Basemap',
	'Search location': 'Search',
	'Outputs': 'Outputs',
	'Storage': 'Storage',
	'Toggle button labels': 'Labels',
};

export function injectButtonLabels(container: HTMLElement): void {
	const buttons = container.querySelectorAll<HTMLButtonElement>('.control-btn');
	for (const btn of buttons) {
		if (btn.querySelector('.control-btn-label')) continue;
		const ariaLabel = btn.getAttribute('aria-label');
		if (!ariaLabel) continue;
		const text = LABEL_MAP[ariaLabel] ?? ariaLabel;
		const span = document.createElement('span');
		span.className = 'control-btn-label';
		span.textContent = text;
		btn.appendChild(span);
	}
}

export function isLabelsEnabled(): boolean {
	try {
		return localStorage.getItem(STORAGE_KEY) === 'true';
	} catch {
		return false;
	}
}

export function toggleLabels(container: HTMLElement): boolean {
	const enabled = container.classList.toggle('show-labels');
	try {
		localStorage.setItem(STORAGE_KEY, String(enabled));
	} catch {
		// Quota or private mode — toggle still works for this session
	}
	return enabled;
}
