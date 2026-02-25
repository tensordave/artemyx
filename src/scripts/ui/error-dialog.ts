/**
 * Show a styled error dialog as a modal overlay.
 * Matches the dark theme styling used throughout the app.
 */
export function showErrorDialog(title: string, message: string): Promise<void> {
	return new Promise((resolve) => {
		// Create overlay
		const overlay = document.createElement('div');
		overlay.style.position = 'fixed';
		overlay.style.top = '0';
		overlay.style.left = '0';
		overlay.style.width = '100%';
		overlay.style.height = '100%';
		overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
		overlay.style.display = 'flex';
		overlay.style.alignItems = 'center';
		overlay.style.justifyContent = 'center';
		overlay.style.zIndex = '10000';

		// Create dialog box
		const dialog = document.createElement('div');
		dialog.style.backgroundColor = '#2a2a2a';
		dialog.style.borderRadius = '8px';
		dialog.style.padding = '16px';
		dialog.style.minWidth = '280px';
		dialog.style.maxWidth = '400px';
		dialog.style.boxShadow = '0 4px 20px rgba(0, 0, 0, 0.5)';
		dialog.style.border = '1px solid #444';

		// Title
		const titleEl = document.createElement('div');
		titleEl.textContent = title;
		titleEl.style.color = '#ff6b6b';
		titleEl.style.fontSize = '14px';
		titleEl.style.fontWeight = 'bold';
		titleEl.style.marginBottom = '10px';
		dialog.appendChild(titleEl);

		// Message
		const messageEl = document.createElement('div');
		messageEl.textContent = message;
		messageEl.style.color = '#ccc';
		messageEl.style.fontSize = '12px';
		messageEl.style.lineHeight = '1.4';
		messageEl.style.marginBottom = '16px';
		dialog.appendChild(messageEl);

		// OK button
		const okButton = document.createElement('button');
		okButton.textContent = 'OK';
		okButton.style.width = '100%';
		okButton.style.padding = '8px';
		okButton.style.backgroundColor = '#3a3a3a';
		okButton.style.color = '#fff';
		okButton.style.border = '1px solid #555';
		okButton.style.borderRadius = '4px';
		okButton.style.cursor = 'pointer';
		okButton.style.fontSize = '12px';

		// Hover effect
		okButton.addEventListener('mouseenter', () => {
			okButton.style.backgroundColor = '#4a4a4a';
		});
		okButton.addEventListener('mouseleave', () => {
			okButton.style.backgroundColor = '#3a3a3a';
		});

		// Close handlers
		const close = () => {
			document.body.removeChild(overlay);
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

		// Focus OK button
		okButton.focus();
	});
}

/**
 * Show a styled confirmation dialog as a modal overlay.
 * Returns true if the user confirms, false if they cancel.
 */
export function showConfirmDialog(title: string, message: string): Promise<boolean> {
	return new Promise((resolve) => {
		const overlay = document.createElement('div');
		overlay.style.position = 'fixed';
		overlay.style.top = '0';
		overlay.style.left = '0';
		overlay.style.width = '100%';
		overlay.style.height = '100%';
		overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
		overlay.style.display = 'flex';
		overlay.style.alignItems = 'center';
		overlay.style.justifyContent = 'center';
		overlay.style.zIndex = '10000';

		const dialog = document.createElement('div');
		dialog.style.backgroundColor = '#2a2a2a';
		dialog.style.borderRadius = '8px';
		dialog.style.padding = '16px';
		dialog.style.minWidth = '280px';
		dialog.style.maxWidth = '400px';
		dialog.style.boxShadow = '0 4px 20px rgba(0, 0, 0, 0.5)';
		dialog.style.border = '1px solid #444';

		const titleEl = document.createElement('div');
		titleEl.textContent = title;
		titleEl.style.color = '#f59e0b';
		titleEl.style.fontSize = '14px';
		titleEl.style.fontWeight = 'bold';
		titleEl.style.marginBottom = '10px';
		dialog.appendChild(titleEl);

		const messageEl = document.createElement('div');
		messageEl.textContent = message;
		messageEl.style.color = '#ccc';
		messageEl.style.fontSize = '12px';
		messageEl.style.lineHeight = '1.4';
		messageEl.style.marginBottom = '16px';
		dialog.appendChild(messageEl);

		// Button row
		const buttonRow = document.createElement('div');
		buttonRow.style.display = 'flex';
		buttonRow.style.gap = '8px';

		const makeButton = (label: string): HTMLButtonElement => {
			const btn = document.createElement('button');
			btn.textContent = label;
			btn.style.flex = '1';
			btn.style.padding = '8px';
			btn.style.backgroundColor = '#3a3a3a';
			btn.style.color = '#fff';
			btn.style.border = '1px solid #555';
			btn.style.borderRadius = '4px';
			btn.style.cursor = 'pointer';
			btn.style.fontSize = '12px';
			btn.addEventListener('mouseenter', () => { btn.style.backgroundColor = '#4a4a4a'; });
			btn.addEventListener('mouseleave', () => { btn.style.backgroundColor = '#3a3a3a'; });
			return btn;
		};

		const cancelButton = makeButton('Cancel');
		const continueButton = makeButton('Continue');

		const close = (result: boolean) => {
			document.body.removeChild(overlay);
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

		cancelButton.focus();
	});
}
