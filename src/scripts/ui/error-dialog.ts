import { createFocusTrap } from '../utils/focus-trap';

/**
 * Show a styled error dialog as a modal overlay.
 * Matches the dark theme styling used throughout the app.
 */
export function showErrorDialog(title: string, message: string): Promise<void> {
	return new Promise((resolve) => {
		const previousFocus = document.activeElement as HTMLElement | null;
		const overlay = document.createElement('div');
		overlay.className = 'dialog-overlay';

		const dialog = document.createElement('div');
		dialog.className = 'dialog-box';
		dialog.setAttribute('role', 'dialog');
		dialog.setAttribute('aria-modal', 'true');
		dialog.setAttribute('aria-label', title);

		const titleEl = document.createElement('div');
		titleEl.textContent = title;
		titleEl.className = 'dialog-title dialog-title--error';
		dialog.appendChild(titleEl);

		const messageEl = document.createElement('div');
		messageEl.textContent = message;
		messageEl.className = 'dialog-message';
		dialog.appendChild(messageEl);

		const okButton = document.createElement('button');
		okButton.textContent = 'OK';
		okButton.className = 'dialog-btn';

		// Close handlers
		const close = () => {
			trap.deactivate();
			document.body.removeChild(overlay);
			if (previousFocus?.isConnected) previousFocus.focus();
			resolve();
		};

		okButton.addEventListener('click', close);

		// Close on Escape key
		const handleKeydown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				document.removeEventListener('keydown', handleKeydown);
				close();
			}
		};
		document.addEventListener('keydown', handleKeydown);

		// Close on overlay click (outside dialog)
		overlay.addEventListener('click', (e) => {
			if (e.target === overlay) {
				document.removeEventListener('keydown', handleKeydown);
				close();
			}
		});

		dialog.appendChild(okButton);
		overlay.appendChild(dialog);
		document.body.appendChild(overlay);

		const trap = createFocusTrap(dialog);
		trap.activate();
		okButton.focus();
	});
}

/**
 * Show a CRS prompt dialog when projected coordinates are detected.
 * Returns the CRS string entered by the user, or null if cancelled.
 */
export function showCrsPromptDialog(): Promise<string | null> {
	return new Promise((resolve) => {
		const previousFocus = document.activeElement as HTMLElement | null;
		const overlay = document.createElement('div');
		overlay.className = 'dialog-overlay';

		const dialog = document.createElement('div');
		dialog.className = 'dialog-box';
		dialog.setAttribute('role', 'dialog');
		dialog.setAttribute('aria-modal', 'true');
		dialog.setAttribute('aria-label', 'Projected Coordinate System Detected');

		const titleEl = document.createElement('div');
		titleEl.className = 'dialog-title dialog-title--warn';
		titleEl.textContent = 'Projected Coordinate System Detected';
		dialog.appendChild(titleEl);

		const messageEl = document.createElement('div');
		messageEl.className = 'dialog-message';
		messageEl.textContent = 'This data uses coordinates outside the WGS84 range, indicating a projected coordinate system. Enter the source CRS to reproject:';
		dialog.appendChild(messageEl);

		const input = document.createElement('input');
		input.type = 'text';
		input.className = 'dialog-input';
		input.placeholder = 'EPSG:26910';
		dialog.appendChild(input);

		const hintEl = document.createElement('div');
		hintEl.className = 'dialog-hint';
		dialog.appendChild(hintEl);

		const buttonRow = document.createElement('div');
		buttonRow.className = 'dialog-button-row';

		const cancelButton = document.createElement('button');
		cancelButton.className = 'dialog-btn';
		cancelButton.textContent = 'Cancel';

		const reprojectButton = document.createElement('button');
		reprojectButton.className = 'dialog-btn dialog-btn--primary';
		reprojectButton.textContent = 'Reproject';

		const close = (result: string | null) => {
			trap.deactivate();
			document.removeEventListener('keydown', handleKeydown);
			document.body.removeChild(overlay);
			if (previousFocus?.isConnected) previousFocus.focus();
			resolve(result);
		};

		const submit = () => {
			const value = input.value.trim();
			if (!value) {
				hintEl.textContent = 'Enter a CRS code (e.g. EPSG:26910)';
				return;
			}
			if (!/^[A-Za-z]+:\S+$/.test(value)) {
				hintEl.textContent = 'Invalid format. Use AUTHORITY:CODE (e.g. EPSG:26910)';
				return;
			}
			close(value);
		};

		cancelButton.addEventListener('click', () => close(null));
		reprojectButton.addEventListener('click', submit);

		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				submit();
			}
		});

		input.addEventListener('input', () => {
			hintEl.textContent = '';
		});

		const handleKeydown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				close(null);
			}
		};
		document.addEventListener('keydown', handleKeydown);

		overlay.addEventListener('click', (e) => {
			if (e.target === overlay) close(null);
		});

		buttonRow.appendChild(cancelButton);
		buttonRow.appendChild(reprojectButton);
		dialog.appendChild(buttonRow);
		overlay.appendChild(dialog);
		document.body.appendChild(overlay);

		const trap = createFocusTrap(dialog);
		trap.activate();
		input.focus();
	});
}

/**
 * Show a file picker dialog for a missing local dataset.
 * Returns the selected File, or null if skipped.
 */
export function showFilePromptDialog(
	datasetName: string,
	filenameHint?: string
): Promise<File | null> {
	return new Promise((resolve) => {
		const previousFocus = document.activeElement as HTMLElement | null;
		const overlay = document.createElement('div');
		overlay.className = 'dialog-overlay';

		const dialog = document.createElement('div');
		dialog.className = 'dialog-box';
		dialog.setAttribute('role', 'dialog');
		dialog.setAttribute('aria-modal', 'true');
		dialog.setAttribute('aria-label', 'Missing Dataset');

		const titleEl = document.createElement('div');
		titleEl.className = 'dialog-title dialog-title--warn';
		titleEl.textContent = 'Missing Dataset';
		dialog.appendChild(titleEl);

		const messageEl = document.createElement('div');
		messageEl.className = 'dialog-message';
		const hint = filenameHint ? ` (${filenameHint})` : '';
		messageEl.textContent = `The dataset "${datasetName}" requires a local file${hint}. Select the file to load it, or skip to continue without it.`;
		dialog.appendChild(messageEl);

		// Selected file display
		const fileLabel = document.createElement('div');
		fileLabel.className = 'dialog-file-label';
		dialog.appendChild(fileLabel);

		// Hidden file input
		const fileInput = document.createElement('input');
		fileInput.type = 'file';
		fileInput.accept = '.geojson,.json,.csv,.parquet,.geoparquet';
		fileInput.style.display = 'none';
		dialog.appendChild(fileInput);

		const buttonRow = document.createElement('div');
		buttonRow.className = 'dialog-button-row';

		const skipButton = document.createElement('button');
		skipButton.className = 'dialog-btn';
		skipButton.textContent = 'Skip';

		const chooseButton = document.createElement('button');
		chooseButton.className = 'dialog-btn dialog-btn--primary';
		chooseButton.textContent = 'Choose File';

		let selectedFile: File | null = null;

		const close = (result: File | null) => {
			trap.deactivate();
			document.removeEventListener('keydown', handleKeydown);
			document.body.removeChild(overlay);
			if (previousFocus?.isConnected) previousFocus.focus();
			resolve(result);
		};

		skipButton.addEventListener('click', () => close(null));

		chooseButton.addEventListener('click', () => {
			if (selectedFile) {
				close(selectedFile);
			} else {
				fileInput.click();
			}
		});

		fileInput.addEventListener('change', () => {
			const file = fileInput.files?.[0];
			if (file) {
				selectedFile = file;
				fileLabel.textContent = file.name;
				chooseButton.textContent = 'Load';
			}
		});

		const handleKeydown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				close(null);
			}
		};
		document.addEventListener('keydown', handleKeydown);

		overlay.addEventListener('click', (e) => {
			if (e.target === overlay) close(null);
		});

		buttonRow.appendChild(skipButton);
		buttonRow.appendChild(chooseButton);
		dialog.appendChild(buttonRow);
		overlay.appendChild(dialog);
		document.body.appendChild(overlay);

		const trap = createFocusTrap(dialog);
		trap.activate();
		chooseButton.focus();
	});
}

/**
 * Show a styled confirmation dialog as a modal overlay.
 * Returns true if the user confirms, false if they cancel.
 */
export function showConfirmDialog(title: string, message: string): Promise<boolean> {
	return new Promise((resolve) => {
		const previousFocus = document.activeElement as HTMLElement | null;
		const overlay = document.createElement('div');
		overlay.className = 'dialog-overlay';

		const dialog = document.createElement('div');
		dialog.className = 'dialog-box';
		dialog.setAttribute('role', 'dialog');
		dialog.setAttribute('aria-modal', 'true');
		dialog.setAttribute('aria-label', title);

		const titleEl = document.createElement('div');
		titleEl.textContent = title;
		titleEl.className = 'dialog-title dialog-title--warn';
		dialog.appendChild(titleEl);

		const messageEl = document.createElement('div');
		messageEl.textContent = message;
		messageEl.className = 'dialog-message';
		dialog.appendChild(messageEl);

		const buttonRow = document.createElement('div');
		buttonRow.className = 'dialog-button-row';

		const cancelButton = document.createElement('button');
		cancelButton.textContent = 'Cancel';
		cancelButton.className = 'dialog-btn';

		const continueButton = document.createElement('button');
		continueButton.textContent = 'Continue';
		continueButton.className = 'dialog-btn dialog-btn--primary';

		const close = (result: boolean) => {
			trap.deactivate();
			document.body.removeChild(overlay);
			if (previousFocus?.isConnected) previousFocus.focus();
			resolve(result);
		};

		cancelButton.addEventListener('click', () => close(false));
		continueButton.addEventListener('click', () => close(true));

		const handleKeydown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				document.removeEventListener('keydown', handleKeydown);
				close(false);
			}
		};
		document.addEventListener('keydown', handleKeydown);

		overlay.addEventListener('click', (e) => {
			if (e.target === overlay) {
				document.removeEventListener('keydown', handleKeydown);
				close(false);
			}
		});

		buttonRow.appendChild(cancelButton);
		buttonRow.appendChild(continueButton);
		dialog.appendChild(buttonRow);
		overlay.appendChild(dialog);
		document.body.appendChild(overlay);

		const trap = createFocusTrap(dialog);
		trap.activate();
		cancelButton.focus();
	});
}
