/**
 * Built-in colour palettes. Applying one writes the six colour keys of the
 * config, which the renderer and UI read; editing any colour afterwards
 * simply makes the palette custom.
 *
 * @module themes
 */

/** @typedef {import('./config.js').ConfigKey} ConfigKey */

/** The configurable colours, in UI order. */
export const COLOR_KEYS = /** @type {const} */ ([
  'colorBackground',
  'colorSpecies1',
  'colorSpecies2',
  'colorSpecies3',
  'colorPredator',
  'colorFood',
]);

/** @typedef {(typeof COLOR_KEYS)[number]} ColorKey */

/**
 * @typedef {object} Palette
 * @property {string} id
 * @property {string} name
 * @property {Record<ColorKey, string>} colors
 */

/** @type {readonly Palette[]} */
export const PALETTES = Object.freeze([
  {
    id: 'abyss',
    name: 'Bioluminescent Abyss',
    // Deep midnight; electric cyan, violet and neon lime; crimson hunters.
    colors: {
      colorBackground: '#040d1a',
      colorSpecies1: '#3cf2ff',
      colorSpecies2: '#a77bff',
      colorSpecies3: '#b6ff3b',
      colorPredator: '#ff2e4d',
      colorFood: '#ff7ad9',
    },
  },
  {
    id: 'solarpunk',
    name: 'Solarpunk Earth',
    // Warm slate; sage, clay amber and sunlit yellow; rust hunters; pollen food.
    colors: {
      colorBackground: '#2f3531',
      colorSpecies1: '#a8c99a',
      colorSpecies2: '#d48a5c',
      colorSpecies3: '#f5d061',
      colorPredator: '#e4572e',
      colorFood: '#f3ead8',
    },
  },
  {
    id: 'radar',
    name: 'Cyberpunk Radar',
    // True OLED black; high-visibility phosphor green and amber vectors.
    colors: {
      colorBackground: '#000000',
      colorSpecies1: '#39ff14',
      colorSpecies2: '#0bbf4d',
      colorSpecies3: '#ffb000',
      colorPredator: '#ff5e00',
      colorFood: '#1d6b2a',
    },
  },
  {
    id: 'mono',
    name: 'Minimal Monochrome',
    // Dark charcoal; crisp silver, pearl and graphite; gold accents.
    colors: {
      colorBackground: '#1b1c1e',
      colorSpecies1: '#c3c8ce',
      colorSpecies2: '#efe8dc',
      colorSpecies3: '#8c9299',
      colorPredator: '#d9b35b',
      colorFood: '#6e6a62',
    },
  },
]);

/**
 * The palette matching the current colours exactly, if any.
 * @param {Record<string, unknown>} config
 * @returns {string | null}
 */
export function activePalette(config) {
  const match = PALETTES.find((p) => COLOR_KEYS.every((key) => config[key] === p.colors[key]));
  return match ? match.id : null;
}
