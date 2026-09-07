export type MapBounds = [[number, number], [number, number]];

const FOCUSED_MAP_BOUNDS: Record<string, MapBounds> = {
  "Orange County": [[33.38, -118.13], [33.99, -117.42]],
  "Los Angeles County": [[33.70, -118.95], [34.87, -117.64]],
  Both: [[33.38, -118.95], [34.87, -117.42]],
};

/**
 * Default to the populated mainland view. Official map geometry remains intact,
 * so users can still pan to offshore boundaries when they need that context.
 */
export function focusedMapBounds(county: string, fallback: MapBounds): MapBounds {
  return FOCUSED_MAP_BOUNDS[county] ?? fallback;
}

export const DEFAULT_MAP_FIT_OPTIONS = {
  padding: [10, 10] as [number, number],
  maxZoom: 11,
};
