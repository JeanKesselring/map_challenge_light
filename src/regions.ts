export type RegionId = 'zurich' | 'switzerland';

export interface Region {
  id: RegionId;
  /** Label for the switcher. */
  name: string;
  /** Used in headings, titles and descriptions. */
  title: string;
  /** Relative to the site base; ends with a slash. */
  terrainPath: string;
  /** Where the Sun and Moon are calculated; mirrors terrain.sources.json. */
  observer: { latitude: number; longitude: number; heightMeters: number };
}

export const REGIONS: Record<RegionId, Region> = {
  zurich: {
    id: 'zurich', name: 'Zurich', title: 'Canton of Zurich', terrainPath: 'terrain/zurich/',
    observer: { latitude: 47.41, longitude: 8.65, heightMeters: 500 },
  },
  switzerland: {
    id: 'switzerland', name: 'Switzerland', title: 'Switzerland', terrainPath: 'terrain/',
    observer: { latitude: 46.8, longitude: 8.2, heightMeters: 500 },
  },
};

export const DEFAULT_REGION: RegionId = 'zurich';
