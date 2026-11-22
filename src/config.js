/**
 * Reactive simulation configuration: the object exposed as `window.simConfig`.
 *
 * - Plain property access: `simConfig.maxSpeed = 200` takes effect on the next
 *   simulation step, since the engine reads the config every step.
 * - Validated: unknown keys (typos) are rejected, numbers are clamped to their
 *   documented range, integers are rounded, numeric strings are accepted
 *   (handy for `<input>` values and URL parameters), and colours are
 *   normalised to '#rrggbb'.
 * - Observable: `simConfig.$subscribe((key, value, previous) => …)`.
 * - Self-describing: `simConfig.$schema` carries type, range, step, unit, group
 *   and label for every parameter. The UI generates its controls from it.
 *
 * @module config
 */

import { clamp } from './core/math.js';
import { normalizeHex } from './core/color.js';

/**
 * @typedef {object} ParamSpec
 * @property {'number' | 'integer' | 'boolean' | 'enum' | 'color'} type
 * @property {number | boolean | string} default
 * @property {number} [min]
 * @property {number} [max]
 * @property {number} [step]
 * @property {readonly string[]} [options] Allowed values of an enum.
 * @property {string} [unit]
 * @property {string} group UI grouping hint.
 * @property {string} label Short human-readable name.
 * @property {string} description
 */

/**
 * @typedef {object} SimConfig
 * @property {number} separationWeight
 * @property {number} alignmentWeight
 * @property {number} cohesionWeight
 * @property {number} maxSpeed Base prey speed limit (px/s); species scale it.
 * @property {number} maxForce Base steering acceleration limit (px/s²); species scale it.
 * @property {number} perceptionRadius Base neighbourhood radius (px); species scale it.
 * @property {number} predatorSpeed Predator pursuit speed (px/s).
 * @property {number} predatorAggression 0 = lazy, 1 = relentless.
 * @property {number} panicRadius Prey alert radius around predators (px).
 * @property {number} panicScatter Multiplier on the flee / scatter response.
 * @property {boolean} ecosystem Life cycle on (food, energy, births, starvation) or fixed populations.
 * @property {number} foodSpawnRate Food particles bloomed per second.
 * @property {number} energyDecay Metabolic rate multiplier.
 * @property {number} carryingCapacity Soft limit on the total prey population.
 * @property {number} countSpecies1 Dartfish population (live: follows births and deaths).
 * @property {number} countSpecies2 Manta population.
 * @property {number} countSpecies3 Skittish Forager population.
 * @property {number} predatorCount
 * @property {'auto' | 'attract' | 'repel'} beaconMode
 * @property {number} beaconStrength
 * @property {number} pulseStrength
 * @property {number} trails Motion-trail persistence per 1/60 s (0 = crisp redraw).
 * @property {string} colorBackground
 * @property {string} colorSpecies1
 * @property {string} colorSpecies2
 * @property {string} colorSpecies3
 * @property {string} colorPredator
 * @property {string} colorFood
 * @property {boolean} paused
 * @property {number} timeScale
 * @property {number} maxPixelRatio
 * @property {boolean} showStats
 * @property {boolean} debug
 */

/** @typedef {keyof SimConfig} ConfigKey */

/**
 * @callback ConfigListener
 * @param {ConfigKey} key
 * @param {any} value New value.
 * @param {any} previous Previous value.
 * @returns {void}
 */

/**
 * @typedef {object} ConfigApi
 * @property {(listener: ConfigListener) => () => void} $subscribe Observe changes; returns an unsubscribe function.
 * @property {(patch: Partial<Record<ConfigKey, unknown>>) => void} $set Apply several values (each validated).
 * @property {(keys?: ConfigKey[]) => void} $reset Restore defaults (all keys, or the given ones).
 * @property {() => SimConfig} $snapshot Plain-object copy of the current values.
 * @property {Readonly<Record<ConfigKey, ParamSpec>>} $schema Parameter metadata.
 */

/** @typedef {SimConfig & ConfigApi} ReactiveConfig */

/** @type {Readonly<Record<ConfigKey, ParamSpec>>} */
export const CONFIG_SCHEMA = Object.freeze({
  // ── Flocking ────────────────────────────────────────────────────────────────
  separationWeight: {
    type: 'number', default: 1.5, min: 0, max: 5, step: 0.05,
    group: 'Flocking', label: 'Separation',
    description: 'Weight of the personal-space (collision avoidance) rule.',
  },
  alignmentWeight: {
    type: 'number', default: 1, min: 0, max: 5, step: 0.05,
    group: 'Flocking', label: 'Alignment',
    description: 'Weight of the velocity-matching rule.',
  },
  cohesionWeight: {
    type: 'number', default: 1, min: 0, max: 5, step: 0.05,
    group: 'Flocking', label: 'Cohesion',
    description: 'Weight of the steer-to-local-centre rule.',
  },
  maxSpeed: {
    type: 'number', default: 140, min: 20, max: 500, step: 1, unit: 'px/s',
    group: 'Flocking', label: 'Max speed',
    description: 'Base prey speed limit; each species applies its own multiplier.',
  },
  maxForce: {
    type: 'number', default: 420, min: 20, max: 3000, step: 10, unit: 'px/s²',
    group: 'Flocking', label: 'Turning force',
    description: 'Base steering acceleration (turning) limit; species apply multipliers.',
  },
  perceptionRadius: {
    type: 'number', default: 48, min: 10, max: 200, step: 1, unit: 'px',
    group: 'Flocking', label: 'Perception',
    description: 'Base neighbourhood radius for alignment, cohesion and foraging.',
  },
  // ── Predators ───────────────────────────────────────────────────────────────
  predatorSpeed: {
    type: 'number', default: 165, min: 20, max: 600, step: 1, unit: 'px/s',
    group: 'Predators', label: 'Predator speed',
    description: 'Pursuit speed. Patrol, rest and strike speeds are derived from it.',
  },
  predatorAggression: {
    type: 'number', default: 0.6, min: 0, max: 1, step: 0.01,
    group: 'Predators', label: 'Aggression',
    description: 'Detection range, hunting threshold, persistence and rest length.',
  },
  panicRadius: {
    type: 'number', default: 110, min: 0, max: 400, step: 1, unit: 'px',
    group: 'Predators', label: 'Panic radius',
    description: 'Distance at which prey detect a predator and flee.',
  },
  panicScatter: {
    type: 'number', default: 1, min: 0, max: 3, step: 0.05, unit: '×',
    group: 'Predators', label: 'Panic scatter',
    description: 'Strength of the flee response, escape memory and flash expansion.',
  },
  // ── Ecosystem ───────────────────────────────────────────────────────────────
  ecosystem: {
    type: 'boolean', default: true,
    group: 'Ecosystem', label: 'Life cycle',
    description: 'Food, energy, births and starvation. Off: fixed populations.',
  },
  foodSpawnRate: {
    type: 'number', default: 24, min: 0, max: 120, step: 0.5, unit: '/s',
    group: 'Ecosystem', label: 'Food spawn rate',
    description: 'Food particles bloomed per second.',
  },
  energyDecay: {
    type: 'number', default: 1, min: 0.2, max: 3, step: 0.05, unit: '×',
    group: 'Ecosystem', label: 'Energy decay',
    description: 'Metabolic rate. Energy drains faster at higher speed.',
  },
  carryingCapacity: {
    type: 'integer', default: 480, min: 50, max: 2000, step: 10,
    group: 'Ecosystem', label: 'Carrying capacity',
    description: 'Soft limit on total prey: births slow down as it fills.',
  },
  // ── Population ──────────────────────────────────────────────────────────────
  countSpecies1: {
    type: 'integer', default: 160, min: 0, max: 3000, step: 1,
    group: 'Population', label: 'Dartfish',
    description: 'Fast, agile, tight bait balls.',
  },
  countSpecies2: {
    type: 'integer', default: 40, min: 0, max: 1000, step: 1,
    group: 'Population', label: 'Mantas',
    description: 'Large, slow-turning, sweeping migration ribbons.',
  },
  countSpecies3: {
    type: 'integer', default: 100, min: 0, max: 3000, step: 1,
    group: 'Population', label: 'Foragers',
    description: 'Skittish: erratic bursts, exaggerated scatter when threatened.',
  },
  predatorCount: {
    type: 'integer', default: 3, min: 0, max: 40, step: 1,
    group: 'Population', label: 'Predators',
    description: 'Number of apex predators.',
  },
  // ── Interaction ─────────────────────────────────────────────────────────────
  beaconMode: {
    type: 'enum', default: 'auto', options: Object.freeze(['auto', 'attract', 'repel']),
    group: 'Interaction', label: 'Hold mode',
    description: 'Press-and-hold beacon: auto = one finger attracts, two or more fingers all repel.',
  },
  beaconStrength: {
    type: 'number', default: 1, min: 0, max: 3, step: 0.05, unit: '×',
    group: 'Interaction', label: 'Beacon strength',
    description: 'Strength of press-and-hold attractors and repulsors.',
  },
  pulseStrength: {
    type: 'number', default: 1, min: 0, max: 3, step: 0.05, unit: '×',
    group: 'Interaction', label: 'Pulse strength',
    description: 'Strength of the tap scatter shockwave.',
  },
  // ── Appearance ──────────────────────────────────────────────────────────────
  trails: {
    type: 'number', default: 0, min: 0, max: 0.95, step: 0.01,
    group: 'Appearance', label: 'Motion trails',
    description: 'Trail persistence: 0 redraws crisply, higher values leave glowing wakes.',
  },
  colorBackground: {
    type: 'color', default: '#040d1a',
    group: 'Appearance', label: 'Background',
    description: 'Canvas background colour.',
  },
  colorSpecies1: {
    type: 'color', default: '#3cf2ff',
    group: 'Appearance', label: 'Dartfish',
    description: 'Species 1 colour (also the UI accent).',
  },
  colorSpecies2: {
    type: 'color', default: '#a77bff',
    group: 'Appearance', label: 'Mantas',
    description: 'Species 2 colour.',
  },
  colorSpecies3: {
    type: 'color', default: '#b6ff3b',
    group: 'Appearance', label: 'Foragers',
    description: 'Species 3 colour.',
  },
  colorPredator: {
    type: 'color', default: '#ff2e4d',
    group: 'Appearance', label: 'Predators',
    description: 'Predator colour.',
  },
  colorFood: {
    type: 'color', default: '#ff7ad9',
    group: 'Appearance', label: 'Food',
    description: 'Food / flora colour.',
  },
  // ── Simulation ──────────────────────────────────────────────────────────────
  paused: {
    type: 'boolean', default: false,
    group: 'Simulation', label: 'Paused',
    description: 'Freeze the simulation (rendering continues).',
  },
  timeScale: {
    type: 'number', default: 1, min: 0, max: 4, step: 0.05, unit: '×',
    group: 'Simulation', label: 'Time scale',
    description: 'Slow motion (< 1) or fast forward (> 1). The physics step stays fixed.',
  },
  maxPixelRatio: {
    type: 'number', default: 3, min: 0.5, max: 4, step: 0.25, unit: '×',
    group: 'Simulation', label: 'Resolution cap',
    description: 'Upper bound on devicePixelRatio used for the canvas backing store.',
  },
  showStats: {
    type: 'boolean', default: false,
    group: 'Simulation', label: 'Performance stats',
    description: 'Show the detailed FPS / timing overlay.',
  },
  debug: {
    type: 'boolean', default: false,
    group: 'Simulation', label: 'Debug overlay',
    description: 'Draw the spatial grid, perception radii and predator state.',
  },
});

/** @type {readonly ConfigKey[]} */
export const CONFIG_KEYS = /** @type {ConfigKey[]} */ (Object.keys(CONFIG_SCHEMA));

/** Population keys in species order. */
export const COUNT_KEYS = /** @type {const} */ (['countSpecies1', 'countSpecies2', 'countSpecies3']);

/**
 * Own-property test (Object.hasOwn needs iOS 15.4+; this works everywhere).
 * @param {object} object
 * @param {PropertyKey} key
 */
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

/**
 * @param {string} key
 * @returns {key is ConfigKey} Whether `key` names a configuration parameter.
 */
export function isConfigKey(key) {
  return hasOwn(CONFIG_SCHEMA, key);
}

/**
 * @param {ParamSpec} spec
 * @param {unknown} raw
 * @returns {{ ok: true, value: number | boolean | string, clamped: boolean } | { ok: false, reason: string }}
 */
function coerce(spec, raw) {
  switch (spec.type) {
    case 'boolean':
      if (typeof raw === 'boolean') return { ok: true, value: raw, clamped: false };
      if (raw === 'true' || raw === '1' || raw === 1) return { ok: true, value: true, clamped: false };
      if (raw === 'false' || raw === '0' || raw === 0) return { ok: true, value: false, clamped: false };
      return { ok: false, reason: `expected a boolean, got ${String(raw)}` };
    case 'enum': {
      const options = spec.options ?? [];
      if (typeof raw === 'string' && options.includes(raw)) return { ok: true, value: raw, clamped: false };
      return { ok: false, reason: `expected one of ${options.join(' | ')}, got ${String(raw)}` };
    }
    case 'color': {
      const hex = normalizeHex(raw);
      if (hex) return { ok: true, value: hex, clamped: false };
      return { ok: false, reason: `expected a hex colour like #3cf2ff, got ${String(raw)}` };
    }
    case 'number':
    case 'integer': {
      const num = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
      if (typeof num !== 'number' || !Number.isFinite(num)) {
        return { ok: false, reason: `expected a finite number, got ${String(raw)}` };
      }
      const value = spec.type === 'integer' ? Math.round(num) : num;
      const clamped = clamp(value, spec.min ?? -Infinity, spec.max ?? Infinity);
      return { ok: true, value: clamped, clamped: clamped !== value };
    }
    default:
      return { ok: false, reason: 'unknown parameter type' };
  }
}

/**
 * Create a reactive configuration object.
 *
 * @param {Partial<Record<ConfigKey, unknown>>} [overrides] Initial values (validated like any write).
 * @param {{ warn?: (message: string) => void }} [options]
 * @returns {ReactiveConfig}
 */
export function createConfig(overrides = {}, { warn = (m) => console.warn(m) } = {}) {
  /** @type {Record<string, number | boolean | string>} */
  const values = {};
  for (const key of CONFIG_KEYS) values[key] = CONFIG_SCHEMA[key].default;

  /** @type {Set<ConfigListener>} */
  const listeners = new Set();

  /**
   * @param {string} key
   * @param {unknown} raw
   */
  function assign(key, raw) {
    if (!isConfigKey(key)) {
      warn(`simConfig: unknown parameter "${key}" (valid: ${CONFIG_KEYS.join(', ')})`);
      return;
    }
    const spec = CONFIG_SCHEMA[key];
    const result = coerce(spec, raw);
    if (!result.ok) {
      warn(`simConfig.${key}: ${result.reason}; keeping ${String(values[key])}`);
      return;
    }
    if (result.clamped) {
      warn(`simConfig.${key}: ${String(raw)} is outside [${spec.min}, ${spec.max}]; using ${String(result.value)}`);
    }
    const previous = values[key];
    if (Object.is(previous, result.value)) return;
    values[key] = result.value;
    for (const listener of [...listeners]) listener(/** @type {ConfigKey} */ (key), result.value, previous);
  }

  /** @type {ConfigApi} */
  const api = {
    $subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    $set(patch) {
      for (const [key, value] of Object.entries(patch)) assign(key, value);
    },
    $reset(keys = [...CONFIG_KEYS]) {
      for (const key of keys) assign(key, CONFIG_SCHEMA[key].default);
    },
    $snapshot() {
      return /** @type {SimConfig} */ (/** @type {unknown} */ ({ ...values }));
    },
    $schema: CONFIG_SCHEMA,
  };

  const proxy = new Proxy(values, {
    get(target, key) {
      if (typeof key === 'string' && hasOwn(api, key)) return api[/** @type {keyof ConfigApi} */ (key)];
      return Reflect.get(target, key);
    },
    set(_target, key, value) {
      if (typeof key !== 'string') return false;
      if (hasOwn(api, key)) {
        warn(`simConfig.${key} is read-only`);
        return true;
      }
      assign(key, value);
      return true;
    },
    deleteProperty(_target, key) {
      warn(`simConfig: parameters cannot be deleted (${String(key)}); use $reset instead`);
      return true;
    },
    defineProperty(_target, key) {
      warn(`simConfig: use plain assignment to change ${String(key)}`);
      return false;
    },
  });

  api.$set(overrides);
  return /** @type {ReactiveConfig} */ (/** @type {unknown} */ (proxy));
}
