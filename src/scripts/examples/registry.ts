export interface Example {
	slug: string;
	name: string;
	group: string;
	description: string;
	configPath: string;
}

export const examples: Example[] = [
	// --- Core Operations ---
	{
		slug: 'buffer',
		name: 'Buffer / Dissolve',
		group: 'Core Operations',
		description: 'Vancouver bike walksheds - 200m buffer around bikeways with dissolve.',
		configPath: '/examples/configs/buffer.yaml',
	},
	{
		slug: 'intersection',
		name: 'Intersection / Clip',
		group: 'Core Operations',
		description: 'San Francisco bike routes intersected with parks - filter and clip modes compared.',
		configPath: '/examples/configs/intersection.yaml',
	},
	{
		slug: 'union',
		name: 'Union / Merge',
		group: 'Core Operations',
		description: 'Portland neighbourhoods merged with development opportunity areas - merge and dissolve modes compared.',
		configPath: '/examples/configs/union.yaml',
	},
	{
		slug: 'difference',
		name: 'Difference',
		group: 'Core Operations',
		description: 'Ottawa neighbourhoods minus parks and greenspaces - subtract and exclude modes compared.',
		configPath: '/examples/configs/difference.yaml',
	},
	{
		slug: 'contains',
		name: 'Contains / Within',
		group: 'Core Operations',
		description: 'Winnipeg cycling network checked against parks - filter and within modes compared.',
		configPath: '/examples/configs/contains.yaml',
	},
	{
		slug: 'distance-filter',
		name: 'Distance (Filter)',
		group: 'Core Operations',
		description: 'Chicago parks within walking distance of L rail stations.',
		configPath: '/examples/configs/distance-filter.yaml',
	},
	{
		slug: 'distance-annotate',
		name: 'Distance (Annotate)',
		group: 'Core Operations',
		description: 'Calgary bikeways colored by distance to nearest LRT station.',
		configPath: '/examples/configs/distance-annotate.yaml',
	},
	{
		slug: 'centroid',
		name: 'Centroid',
		group: 'Core Operations',
		description: 'Denver park polygons reduced to centroid points.',
		configPath: '/examples/configs/centroid.yaml',
	},
	// --- Labels ---
	{
		slug: 'labels',
		name: 'Labels',
		group: 'Labels',
		description: 'Calgary communities and LRT stations with text labels - style.labelField for simple labels, type: symbol for full MapLibre expression control.',
		configPath: '/examples/configs/labels.yaml',
	},
	// --- Expression Styling ---
	{
		slug: 'interpolate-styling',
		name: 'Interpolate Styling',
		group: 'Expression Styling',
		description: 'Vancouver parks colored by size - interpolate expression mapping hectares to a green color ramp.',
		configPath: '/examples/configs/interpolate-styling.yaml',
	},
	{
		slug: 'match-styling',
		name: 'Match Styling',
		group: 'Expression Styling',
		description: 'Victoria road network colored by classification - match expression mapping road classes to a color palette.',
		configPath: '/examples/configs/match-styling.yaml',
	},
	// --- Advanced Workflows ---
	{
		slug: 'multi-dataset-layers',
		name: 'Multi-Dataset Layers',
		group: 'Advanced Workflows',
		description: 'Surrey, Burnaby, and New Westminster parks and active transportation - seven datasets across three municipalities with expression styling.',
		configPath: '/examples/configs/multi-dataset-layers.yaml',
	},
	{
		slug: 'multi-step',
		name: 'Multi-Step Workflow',
		group: 'Advanced Workflows',
		description: 'Edmonton schools + transit - union, buffer, and intersection chained to find dual-access zones.',
		configPath: '/examples/configs/multi-step.yaml',
	},
	{
		slug: 'attribute',
		name: 'Attribute Filter',
		group: 'Advanced Workflows',
		description: 'Vancouver cycling network filtered by infrastructure quality - safer routes via advanced SQL filter, protected lanes via structured filter, walkshed coverage buffered from the result.',
		configPath: '/examples/configs/attribute.yaml',
	},
	// --- PMTiles ---
	{
		slug: 'pmtiles',
		name: 'PMTiles Vector Tiles',
		group: 'PMTiles',
		description: 'Protomaps worldwide vector basemap loaded as a PMTiles dataset - nine source layers styled independently with explicit layer configs.',
		configPath: '/examples/configs/pmtiles.yaml',
	},
];

/** Unique group names in display order. */
export const groups: string[] = [...new Set(examples.map((e) => e.group))];
