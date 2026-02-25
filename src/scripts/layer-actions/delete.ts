import maplibregl from 'maplibre-gl';
import { deleteDataset as deleteDatasetFromDB } from '../db';
import { getLayersBySource, getSourceId } from '../layers';
import { ProgressControl } from '../progress-control';
import { showErrorDialog } from '../ui/error-dialog';

/**
 * Show inline confirmation dialog within a panel
 */
export function showDeleteConfirmation(
	panel: HTMLDivElement,
	datasetName: string,
	featureCount: number,
	onRefresh: () => void
): Promise<boolean> {
	return new Promise((resolve) => {
		// Clear panel
		panel.innerHTML = '';

		// Create confirmation UI
		const confirmContainer = document.createElement('div');
		confirmContainer.className = 'delete-confirm';

		// Title
		const title = document.createElement('div');
		title.className = 'delete-confirm-title';
		title.textContent = 'Delete Dataset?';
		confirmContainer.appendChild(title);

		// Dataset info
		const info = document.createElement('div');
		info.className = 'delete-confirm-name';
		info.innerHTML = `<strong>${datasetName}</strong>`;
		confirmContainer.appendChild(info);

		// Feature count
		const count = document.createElement('div');
		count.className = 'delete-confirm-count';
		count.textContent = `${featureCount.toLocaleString()} features will be removed`;
		confirmContainer.appendChild(count);

		// Button container
		const buttonContainer = document.createElement('div');
		buttonContainer.className = 'delete-confirm-buttons';

		// Cancel button
		const cancelButton = document.createElement('button');
		cancelButton.className = 'delete-confirm-btn delete-confirm-btn--cancel';
		cancelButton.textContent = 'Cancel';

		// Delete button
		const deleteButton = document.createElement('button');
		deleteButton.className = 'delete-confirm-btn delete-confirm-btn--delete';
		deleteButton.textContent = 'Delete';

		// Button handlers
		cancelButton.addEventListener('click', () => {
			// Restore panel by refreshing
			onRefresh();
			resolve(false);
		});

		deleteButton.addEventListener('click', () => {
			// No need to refresh here - the delete handler will call onRefresh()
			resolve(true);
		});

		buttonContainer.appendChild(cancelButton);
		buttonContainer.appendChild(deleteButton);
		confirmContainer.appendChild(buttonContainer);
		panel.appendChild(confirmContainer);

		// Focus cancel button by default (safer default)
		cancelButton.focus();
	});
}

/**
 * Delete a dataset and remove all associated layers from the map
 */
export async function deleteDatasetWithLayers(
	map: maplibregl.Map,
	datasetId: string,
	datasetName: string,
	progressControl: ProgressControl,
	onRefresh: () => void
): Promise<void> {
	console.log(`[LayerDelete] Deleting dataset ${datasetId}`);

	// Show progress
	progressControl.updateProgress(datasetName, 'processing', 'Deleting dataset');

	// Delete from database
	const success = await deleteDatasetFromDB(datasetId);

	if (!success) {
		progressControl.updateProgress(datasetName, 'error', 'Failed to delete dataset');
		await showErrorDialog('Delete Failed', 'Failed to delete dataset from database.');
		progressControl.scheduleIdle(5000);
		return;
	}

	// Remove all MapLibre layers using this dataset's source
	// (dynamic discovery — works with both default and config-defined layer IDs)
	const sourceId = getSourceId(datasetId);
	const layers = getLayersBySource(map, sourceId);

	for (const layer of layers) {
		map.removeLayer(layer.id);
	}

	// Remove MapLibre source
	if (map.getSource(sourceId)) {
		map.removeSource(sourceId);
	}

	console.log(`[LayerDelete] Successfully deleted dataset ${datasetId}`);

	// Show success message
	progressControl.updateProgress(datasetName, 'success', 'Dataset deleted');
	progressControl.scheduleIdle(3000);

	// Refresh the panel to update UI
	onRefresh();
}
