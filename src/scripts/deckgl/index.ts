/**
 * deck.gl integration module.
 * Re-exports the singleton manager API, renderer registry, and color utilities.
 */

export {
	addLayer,
	removeLayer,
	updateLayer,
	setLayerVisibility,
	destroy,
	isInitialized,
	hasLayer
} from './manager';

export type { DeckLayerEntry } from './manager';

export {
	registerLayer,
	unregisterLayer,
	getRenderer,
	isDeckGL,
	getLayersByDataset,
	clearRegistry
} from './registry';

export {
	hexToRGBA,
	rgbaToHex,
	buildDeckColorProps
} from './color';
