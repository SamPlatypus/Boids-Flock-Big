/**
 * One-tap scenario presets and the area scaling of ecosystem values.
 *
 * Ecosystem dynamics depend on density, so population, capacity and food
 * values are defined for the reference phone screen and multiplied by the
 * world's area factor (see sim/ecology.js `areaFactor`) when applied. A
 * desktop window therefore gets proportionally more agents and behaves like
 * the phone.
 *
 * @module presets
 */

import { CONFIG_SCHEMA } from './config.js';

/** @typedef {import('./config.js').ConfigKey} ConfigKey */
/** @typedef {Partial<Record<ConfigKey, number | boolean | string>>} ConfigPatch */

/** Keys whose values scale with the world area. */
export const AREA_SCALED_KEYS = /** @type {const} */ ([
  'countSpecies1',
  'countSpecies2',
  'countSpecies3',
  'predatorCount',
  'carryingCapacity',
  'foodSpawnRate',
]);

/** Behaviour keys every scenario sets, so switching scenarios is predictable. Colours are untouched. */
export const SCENARIO_KEYS = /** @type {const} */ ([
  'separationWeight',
  'alignmentWeight',
  'cohesionWeight',
  'maxSpeed',
  'maxForce',
  'perceptionRadius',
  'predatorSpeed',
  'predatorAggression',
  'panicRadius',
  'panicScatter',
  'ecosystem',
  'foodSpawnRate',
  'energyDecay',
  'carryingCapacity',
  'countSpecies1',
  'countSpecies2',
  'countSpecies3',
  'predatorCount',
  'trails',
  'timeScale',
]);

/**
 * Multiply area-dependent values by `factor`, rounding and clamping like the config would.
 * @param {ConfigPatch} patch
 * @param {number} factor
 * @returns {ConfigPatch}
 */
export function scaleForArea(patch, factor) {
  /** @type {ConfigPatch} */
  const out = { ...patch };
  for (const key of AREA_SCALED_KEYS) {
    const value = patch[key];
    if (typeof value !== 'number') continue;
    const spec = CONFIG_SCHEMA[key];
    const scaled = key === 'foodSpawnRate' ? Math.round(value * factor * 2) / 2 : Math.round(value * factor);
    out[key] = Math.min(spec.max ?? Infinity, Math.max(spec.min ?? 0, scaled));
  }
  return out;
}

/** Schema defaults for the scenario keys (reference screen). */
function defaults() {
  /** @type {ConfigPatch} */
  const patch = {};
  for (const key of SCENARIO_KEYS) patch[key] = CONFIG_SCHEMA[key].default;
  return patch;
}

/**
 * @typedef {object} Scenario
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {ConfigPatch} patch Complete over SCENARIO_KEYS, reference-screen values.
 */

/** @type {readonly Scenario[]} */
export const SCENARIOS = Object.freeze([
  {
    id: 'schooling',
    name: 'Tight Schooling',
    description: 'High cohesion and alignment, no predators: pure flocking.',
    patch: {
      ...defaults(),
      separationWeight: 1.2,
      alignmentWeight: 2.2,
      cohesionWeight: 2.4,
      maxSpeed: 150,
      maxForce: 480,
      perceptionRadius: 64,
      predatorCount: 0,
      ecosystem: false,
      countSpecies1: 200,
      countSpecies2: 50,
      countSpecies3: 120,
      trails: 0.3,
    },
  },
  {
    id: 'chaos',
    name: 'Predator Chaos',
    description: 'A pack of fast, relentless hunters and wide panic scatter.',
    patch: {
      ...defaults(),
      predatorCount: 8,
      predatorSpeed: 200,
      predatorAggression: 1,
      panicRadius: 170,
      panicScatter: 2.2,
      ecosystem: false,
      countSpecies1: 220,
      countSpecies2: 40,
      countSpecies3: 160,
      trails: 0.45,
    },
  },
  {
    id: 'balance',
    name: 'Ecosystem Balance',
    description: 'Grazing, births and starvation in a self-sustaining predator–prey cycle.',
    patch: defaults(),
  },
  {
    id: 'zen',
    name: 'Zen Drift',
    description: 'Slow, wide manta ribbons with soft glowing trails.',
    patch: {
      ...defaults(),
      separationWeight: 1.3,
      alignmentWeight: 2.6,
      cohesionWeight: 0.7,
      maxSpeed: 70,
      maxForce: 200,
      perceptionRadius: 90,
      predatorCount: 0,
      panicScatter: 0.6,
      ecosystem: false,
      countSpecies1: 90,
      countSpecies2: 110,
      countSpecies3: 40,
      trails: 0.85,
    },
  },
]);

/** Keys compared when deciding which scenario is active (populations drift, so they are ignored). */
const MATCH_KEYS = SCENARIO_KEYS.filter(
  (key) => !(/** @type {readonly string[]} */ (AREA_SCALED_KEYS)).includes(key),
);

/**
 * The scenario whose behaviour settings match the config, if any.
 * @param {Record<string, unknown>} config
 * @returns {string | null}
 */
export function activeScenario(config) {
  for (const scenario of SCENARIOS) {
    if (MATCH_KEYS.every((key) => sameValue(config[key], scenario.patch[key]))) return scenario.id;
  }
  return null;
}

/**
 * @param {unknown} a
 * @param {unknown} b
 */
function sameValue(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-6;
  return a === b;
}
