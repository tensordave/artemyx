/**
 * Export the current config panel YAML as a downloadable .yaml file.
 */

/**
 * Trigger a browser download of the given YAML string as a .yaml file.
 */
export function exportConfigYaml(yaml: string, filename = 'config'): void {
	const blob = new Blob([yaml], { type: 'text/yaml' });
	const url = URL.createObjectURL(blob);

	const a = document.createElement('a');
	a.href = url;
	a.download = filename.endsWith('.yaml') ? filename : `${filename}.yaml`;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
}
