/**
 * Simulation: owns all agents and advances the world by fixed steps.
 *
 * DOM-free by design. It runs unchanged in the browser, in Node (tests,
 * benchmarks) or in a Web Worker. Rendering and input talk to it through its
 * public API: `step`, `resize`, `reset`, `addPulse`, `setBeacon`,
 * `releaseBeacon`, `on`, `speciesSummary`, plus read access to `prey`,
 * `predators`, `food`, `pulses`, `beacons`, `effects`, `history` and `stats`.
 *
 * One step (Jacobi-style: every agent reads the same consistent snapshot):
 *   1. resolve species/predator parameters from config; sync populations
 *   2. rebuild the spatial hash (counting sort, O(N)); update food (drift, blooms)
 *   3. interactions: beacon smoothing, pulse fronts → prey stimuli
 *   4. predators sense: threats → prey stimuli; score hunting targets
 *   5. prey steering (flocking + grazing + panic + prioritized allocation)
 *   6. predator state machine + steering
 *   7. integrate prey, then predators (+ catches on contact)
 *   8. life cycle: metabolism, grazing, division, starvation, immigration
 *   9. publish live population counts back to the config; record history
 *
 * Populations: `config.countSpecies*` / `predatorCount` always mirror the live
 * population. A change from outside (UI, preset, console) is applied
 * immediately by adding or removing individuals. With the life cycle on,
 * births and deaths are written back so every observer sees the live numbers.
 * With it off, the configured counts are enforced (catches respawn prey).
 *
 * @module sim/simulation
 */

import { Random } from '../core/rng.js';
import { Emitter } from '../core/emitter.js';
import { clamp } from '../core/math.js';
import { NeighborBuffer, ToroidalSpatialHash } from '../core/spatial-hash.js';
import { torusDistanceSq, wrapCoord } from '../core/torus.js';
import { CONFIG_SCHEMA } from '../config.js';
import { PREDATOR_PROFILE, SPECIES, SPECIES_COUNT, SpeciesRuntime } from './species.js';
import { PreyPool } from './prey-pool.js';
import { Predator, PredatorRuntime, integratePredators, sensePredators, steerPredators } from './predator.js';
import { Beacon, PULSE, Pulse, applyInteractionForces, updateInteractions } from './interactions.js';
import { computePreySteering, integratePrey } from './flocking.js';
import { FOOD, FoodField } from './food.js';
import { ECOLOGY, areaFactor, removeDeadPrey, updateLifecycle } from './ecology.js';
import { PopulationHistory } from './history.js';

/** @typedef {import('../config.js').SimConfig} SimConfig */
/** @typedef {import('./interactions.js').BeaconMode} BeaconMode */
/** @typedef {import('./predator.js').PredatorState} PredatorState */
/** @typedef {import('./species.js').SpeciesProfile} SpeciesProfile */
/** @typedef {import('./species.js').PredatorProfile} PredatorProfile */

/**
 * @typedef {object} SimEvents
 * @property {{ predator: number, prey: number, species: number, x: number, y: number, time: number }} catch
 * @property {{ id: number, from: PredatorState, to: PredatorState, time: number }} predatorState
 * @property {{ species: number, id: number, parent: number, generation: number, x: number, y: number, time: number }} birth
 * @property {{ species: number, cause: 'eaten' | 'starved', id: number, x: number, y: number, generation: number, time: number }} death
 * @property {{ id: number, parent: number, x: number, y: number, time: number }} predatorBirth
 * @property {{ id: number, cause: 'starved', x: number, y: number, time: number }} predatorDeath
 * @property {{ kind: 'prey' | 'predator', species: number, count: number, time: number }} immigration
 * @property {{ kind: 'prey' | 'predator', species: number, time: number }} extinction A population the
 *   user still wants died out (not emitted when the user removes it); species is −1 for predators.
 */

/** @typedef {'catch' | 'birth' | 'starve' | 'predatorBirth' | 'predatorStarve'} EffectKind */

/**
 * Short-lived visual marker (render only).
 * @typedef {object} Effect
 * @property {EffectKind} kind
 * @property {number} x
 * @property {number} y
 * @property {number} age
 * @property {number} duration
 * @property {number} species Prey species, or -1 for predators.
 */

/** Fixed physics step (s). */
export const FIXED_DT = 1 / 60;
/**
 * Neighbours considered per prey agent: the K nearest within its radius
 * (topological interaction, as in real schools). Bounds per-agent work in
 * dense schools, so a step stays O(N) as density grows.
 */
export const MAX_NEIGHBORS = 16;
/** Spatial-hash cell edge as a fraction of the smallest prey query radius. */
const CELL_FRACTION = 0.5;
const MIN_CELL_SIZE = 12;
const MAX_CELL_SIZE = 160;
/** Effect durations (s); the list is capped so mass die-offs stay cheap. */
const EFFECT_DURATION = Object.freeze({ catch: 0.6, birth: 0.45, starve: 0.9, predatorBirth: 0.8, predatorStarve: 1.4 });
const EFFECT_LIMIT = 160;

export class Simulation {
  /**
   * @param {object} options
   * @param {SimConfig} options.config Live config (read every step; population counts are written back).
   * @param {number} options.width World width (px).
   * @param {number} options.height World height (px).
   * @param {number} [options.seed] PRNG seed; the same seed and inputs reproduce a run exactly.
   */
  constructor({ config, width, height, seed = 1 }) {
    this.config = config;
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.seed = seed >>> 0;
    this.rng = new Random(this.seed);
    this.time = 0;
    this.stepCount = 0;
    /** Live, mutable species profiles: edits apply on the next step. @type {SpeciesProfile[]} */
    this.species = SPECIES.map((profile) => ({ ...profile }));
    /** Live, mutable predator profile. @type {PredatorProfile} */
    this.predatorProfile = { ...PREDATOR_PROFILE, threatLevel: { ...PREDATOR_PROFILE.threatLevel } };
    this.speciesRuntime = this.species.map(() => new SpeciesRuntime());
    this.predatorRuntime = new PredatorRuntime();
    this.prey = new PreyPool(512);
    /** @type {Predator[]} */
    this.predators = [];
    this.nextPredatorId = 1;
    this.food = new FoodField();
    /** Ten minutes of population samples (one every 2 s): spans a full predator–prey cycle. */
    this.history = new PopulationHistory(300, 2);
    this.grid = new ToroidalSpatialHash();
    this.neighborBuffer = new NeighborBuffer(MAX_NEIGHBORS);
    /** Untruncated results for predator / interaction queries (grown with the pool). */
    this.queryBuffer = new NeighborBuffer(512);
    /** @type {Pulse[]} */
    this.pulses = [];
    /** @type {Map<number | string, Beacon>} */
    this.beacons = new Map();
    this.fadingBeaconSerial = 0;
    /** @type {Effect[]} */
    this.effects = [];
    /** @type {Emitter<SimEvents>} */
    this.events = new Emitter();
    this.stats = {
      pairChecks: 0,
      catches: 0,
      births: 0,
      starvations: 0,
      grazed: 0,
      predatorBirths: 0,
      predatorStarvations: 0,
      immigrations: 0,
      maxGeneration: 0,
    };
    /** Population counts last synced with the config (detects outside changes). */
    this.syncedCounts = new Int32Array(SPECIES_COUNT);
    this.syncedPredators = 0;
    /** Whether the user wants each species / predators present (drives immigration). */
    this.wanted = new Array(SPECIES_COUNT).fill(true);
    this.wantedPredators = true;
    /** Seconds each wanted species has been extinct. */
    this.extinctTime = new Float64Array(SPECIES_COUNT);
    this.predatorExtinctTime = 0;
    this.historySample = [0, 0, 0, 0, 0];
    this.reset(this.seed);
  }

  /**
   * Subscribe to a simulation event ('catch', 'birth', 'death', …).
   * @template {keyof SimEvents} K
   * @param {K} type
   * @param {(payload: SimEvents[K]) => void} listener
   * @returns {() => void} Unsubscribe function.
   */
  on(type, listener) {
    return this.events.on(type, listener);
  }

  /**
   * Respawn every agent from the configured populations and re-seed food.
   * @param {number} [seed]
   */
  reset(seed = this.seed) {
    this.seed = seed >>> 0;
    this.rng.reseed(this.seed);
    this.time = 0;
    this.stepCount = 0;
    this.prey.clear();
    this.predators.length = 0;
    this.food.clear();
    this.history.clear();
    this.pulses.length = 0;
    this.beacons.clear();
    this.effects.length = 0;
    for (const key of /** @type {(keyof Simulation['stats'])[]} */ (Object.keys(this.stats))) this.stats[key] = 0;
    this.resolveRuntime(FIXED_DT);
    for (let s = 0; s < SPECIES_COUNT; s++) {
      const count = this.config[this.species[s].countKey];
      this.spawnSchools(s, count, true);
      this.syncedCounts[s] = count;
      this.wanted[s] = count > 0;
      this.extinctTime[s] = 0;
    }
    const prey = this.prey;
    for (let i = 0; i < prey.count; i++) {
      prey.energy[i] = this.rng.range(0.45, 0.9);
      prey.geneSpeed[i] = clamp(1 + 0.03 * this.rng.gaussian(), ECOLOGY.geneMin, ECOLOGY.geneMax);
      prey.genePerception[i] = clamp(1 + 0.03 * this.rng.gaussian(), ECOLOGY.geneMin, ECOLOGY.geneMax);
    }
    for (let k = 0; k < this.config.predatorCount; k++) this.spawnPredator();
    this.syncedPredators = this.config.predatorCount;
    this.wantedPredators = this.syncedPredators > 0;
    this.predatorExtinctTime = 0;
    this.food.maxParticles = Math.round(FOOD.maxParticles * areaFactor(this.width, this.height));
    if (this.config.ecosystem) this.food.seed(this, Math.round(this.food.maxParticles * 0.6));
    this.recordHistory();
  }

  /**
   * Change the world size. Positions scale proportionally so the scene keeps
   * its layout (e.g. on device rotation).
   * @param {number} width
   * @param {number} height
   */
  resize(width, height) {
    width = Math.max(1, width);
    height = Math.max(1, height);
    if (width === this.width && height === this.height) return;
    const sx = width / this.width;
    const sy = height / this.height;
    const prey = this.prey;
    for (let i = 0; i < prey.count; i++) {
      prey.x[i] = wrapCoord(prey.x[i] * sx, width);
      prey.y[i] = wrapCoord(prey.y[i] * sy, height);
      prey.prevX[i] = wrapCoord(prey.prevX[i] * sx, width);
      prey.prevY[i] = wrapCoord(prey.prevY[i] * sy, height);
    }
    for (const p of this.predators) {
      p.x = wrapCoord(p.x * sx, width);
      p.y = wrapCoord(p.y * sy, height);
      p.prevX = wrapCoord(p.prevX * sx, width);
      p.prevY = wrapCoord(p.prevY * sy, height);
    }
    this.food.rescale(sx, sy, width, height);
    for (const pulse of this.pulses) {
      pulse.x = wrapCoord(pulse.x * sx, width);
      pulse.y = wrapCoord(pulse.y * sy, height);
    }
    for (const effect of this.effects) {
      effect.x = wrapCoord(effect.x * sx, width);
      effect.y = wrapCoord(effect.y * sy, height);
    }
    for (const beacon of this.beacons.values()) {
      beacon.x = wrapCoord(beacon.x * sx, width);
      beacon.y = wrapCoord(beacon.y * sy, height);
      beacon.targetX = wrapCoord(beacon.targetX * sx, width);
      beacon.targetY = wrapCoord(beacon.targetY * sy, height);
    }
    this.width = width;
    this.height = height;
  }

  /**
   * Advance the world by one fixed step.
   * @param {number} [dt]
   */
  step(dt = FIXED_DT) {
    const ecosystem = this.config.ecosystem;
    this.resolveRuntime(dt);
    this.syncPopulations();

    const prey = this.prey;
    const n = prey.count;
    if (this.queryBuffer.capacity < prey.capacity) this.queryBuffer = new NeighborBuffer(prey.capacity);
    for (let i = 0; i < n; i++) {
      prey.prevX[i] = prey.x[i];
      prey.prevY[i] = prey.y[i];
    }
    for (const p of this.predators) {
      p.prevX = p.x;
      p.prevY = p.y;
      p.extX = 0;
      p.extY = 0;
    }
    prey.clearStimuli();

    this.grid.configure(this.width, this.height, this.cellSize());
    this.grid.build(prey.x, prey.y, n);
    this.grid.candidatesChecked = 0;
    this.food.maxParticles = Math.round(FOOD.maxParticles * areaFactor(this.width, this.height));
    this.food.update(this, dt, ecosystem);

    updateInteractions(this, dt);
    applyInteractionForces(this);
    sensePredators(this);
    computePreySteering(this, dt);
    steerPredators(this, dt);
    integratePrey(this, dt);
    integratePredators(this, dt);
    if (ecosystem) updateLifecycle(this, dt);
    else removeDeadPrey(this);
    this.publishPopulations();

    for (const effect of this.effects) effect.age += dt;
    for (let i = this.effects.length - 1; i >= 0; i--) {
      if (this.effects[i].age >= this.effects[i].duration) this.effects.splice(i, 1);
    }
    if (this.history.tick(dt)) this.recordHistory();

    this.stats.pairChecks = this.grid.candidatesChecked;
    this.time += dt;
    this.stepCount++;
  }

  // ── Touch / pointer API ────────────────────────────────────────────────────

  /**
   * Emit a scatter shockwave from (x, y).
   * @param {number} x
   * @param {number} y
   * @param {number} [strength]
   */
  addPulse(x, y, strength = 1) {
    if (this.pulses.length >= PULSE.maxActive) this.pulses.shift();
    this.pulses.push(new Pulse(wrapCoord(x, this.width), wrapCoord(y, this.height), strength));
  }

  /**
   * Create or move the beacon owned by a pointer. The beacon eases toward the
   * given position.
   * @param {number | string} id Pointer id.
   * @param {number} x
   * @param {number} y
   * @param {BeaconMode} [mode] Omit to follow `config.beaconMode`.
   */
  setBeacon(id, x, y, mode) {
    const tx = wrapCoord(x, this.width);
    const ty = wrapCoord(y, this.height);
    let beacon = this.beacons.get(id);
    if (beacon && beacon.released) {
      // Same pointer id pressed again while the old beacon fades: let the old
      // one finish fading under another key instead of popping it.
      this.beacons.delete(id);
      this.beacons.set(`fading:${this.fadingBeaconSerial++}`, beacon);
      beacon = undefined;
    }
    if (!beacon) {
      beacon = new Beacon(id, tx, ty, mode ?? null);
      this.beacons.set(id, beacon);
    }
    beacon.targetX = tx;
    beacon.targetY = ty;
    if (mode !== undefined) beacon.requestedMode = mode;
  }

  /**
   * Release a pointer's beacon (fades out smoothly).
   * @param {number | string} id
   */
  releaseBeacon(id) {
    const beacon = this.beacons.get(id);
    if (beacon) beacon.released = true;
  }

  /**
   * Per-species population summary (for metrics UIs). O(N); call sparingly.
   * @returns {{ count: number, energy: number, speedGene: number, perceptionGene: number, generation: number }[]}
   */
  speciesSummary() {
    const out = this.species.map(() => ({ count: 0, energy: 0, speedGene: 0, perceptionGene: 0, generation: 0 }));
    const prey = this.prey;
    for (let i = 0; i < prey.count; i++) {
      const o = out[prey.species[i]];
      o.count++;
      o.energy += prey.energy[i];
      o.speedGene += prey.geneSpeed[i];
      o.perceptionGene += prey.genePerception[i];
      if (prey.generation[i] > o.generation) o.generation = prey.generation[i];
    }
    for (const o of out) {
      if (o.count === 0) continue;
      o.energy /= o.count;
      o.speedGene /= o.count;
      o.perceptionGene /= o.count;
    }
    return out;
  }

  // ── Internals (also used by the predator and ecology modules) ─────────────

  /** @param {number} dt */
  resolveRuntime(dt) {
    for (let s = 0; s < SPECIES_COUNT; s++) this.speciesRuntime[s].resolve(s, this.species, this.config, dt);
    this.predatorRuntime.resolve(this.predatorProfile, this.config);
  }

  /**
   * Cell edge for the spatial hash: half the smallest active query radius.
   * Finer cells let the ring-ordered nearest-K search stop early in dense schools.
   */
  cellSize() {
    let size = Infinity;
    for (let s = 0; s < SPECIES_COUNT; s++) {
      if (this.prey.countBySpecies[s] > 0) size = Math.min(size, this.speciesRuntime[s].queryRadius);
    }
    return clamp(Number.isFinite(size) ? size * CELL_FRACTION : 64, MIN_CELL_SIZE, MAX_CELL_SIZE);
  }

  /** @param {number} s */
  maxPopulation(s) {
    return /** @type {number} */ (CONFIG_SCHEMA[this.species[s].countKey].max);
  }

  /** Most predators the life cycle will breed: scales with the world area. */
  maxPredators() {
    const schemaMax = /** @type {number} */ (CONFIG_SCHEMA.predatorCount.max);
    return Math.min(schemaMax, Math.round(ECOLOGY.predatorsPerScreen * areaFactor(this.width, this.height)));
  }

  /**
   * Apply population changes made from outside (UI, presets, console). With
   * the life cycle off, also enforce the configured counts.
   */
  syncPopulations() {
    const config = this.config;
    for (let s = 0; s < SPECIES_COUNT; s++) {
      const want = config[this.species[s].countKey];
      if (want !== this.syncedCounts[s]) {
        this.syncedCounts[s] = want;
        this.wanted[s] = want > 0;
        this.extinctTime[s] = 0;
        this.adjustPrey(s, want);
      } else if (!config.ecosystem && this.prey.countBySpecies[s] !== want) {
        this.adjustPrey(s, want);
      }
    }
    const wantPredators = config.predatorCount;
    if (wantPredators !== this.syncedPredators) {
      this.syncedPredators = wantPredators;
      this.wantedPredators = wantPredators > 0;
      this.predatorExtinctTime = 0;
      this.adjustPredators(wantPredators);
    } else if (!config.ecosystem && this.predators.length !== wantPredators) {
      this.adjustPredators(wantPredators);
    }
  }

  /** Write live counts (after births and deaths) back to the config. */
  publishPopulations() {
    const config = this.config;
    for (let s = 0; s < SPECIES_COUNT; s++) {
      const live = this.prey.countBySpecies[s];
      if (live !== this.syncedCounts[s]) {
        this.syncedCounts[s] = live;
        config[this.species[s].countKey] = live;
        if (live === 0 && this.wanted[s]) this.events.emit('extinction', { kind: 'prey', species: s, time: this.time });
      }
    }
    if (this.predators.length !== this.syncedPredators) {
      this.syncedPredators = this.predators.length;
      config.predatorCount = this.predators.length;
      if (this.predators.length === 0 && this.wantedPredators) {
        this.events.emit('extinction', { kind: 'predator', species: -1, time: this.time });
      }
    }
  }

  /**
   * @param {number} s
   * @param {number} want
   */
  adjustPrey(s, want) {
    const have = this.prey.countBySpecies[s];
    if (want > have) this.addPrey(s, want - have);
    else if (want < have) this.removePrey(s, have - want);
  }

  /** @param {number} want */
  adjustPredators(want) {
    while (this.predators.length < want) this.spawnPredator();
    if (this.predators.length > want) this.predators.length = want;
  }

  /**
   * Spawn agents of species s in loose schools sharing a heading.
   * @param {number} s
   * @param {number} count
   * @param {boolean} staggered Stagger the grow-in (initial spawn).
   */
  spawnSchools(s, count, staggered) {
    const rng = this.rng;
    const rt = this.speciesRuntime[s];
    let remaining = count;
    while (remaining > 0) {
      const size = Math.min(remaining, 15 + rng.int(30));
      const cx = rng.range(0, this.width);
      const cy = rng.range(0, this.height);
      const heading = rng.angle();
      const spread = this.species[s].personalSpace * Math.sqrt(size) * 0.8;
      for (let k = 0; k < size; k++) {
        const i = this.spawnPreyAt(
          s,
          cx + rng.gaussian() * spread,
          cy + rng.gaussian() * spread,
          heading + rng.gaussian() * 0.25,
          rt.cruiseSpeed * rng.range(0.85, 1.05),
        );
        if (staggered) this.prey.age[i] = -rng.range(0, 0.4);
      }
      remaining -= size;
    }
  }

  /**
   * New members join an existing school beside a random member, matching its heading.
   * @param {number} s
   * @param {number} count
   */
  addPrey(s, count) {
    const prey = this.prey;
    if (prey.countBySpecies[s] === 0) {
      this.spawnSchools(s, count, false);
      return;
    }
    const rng = this.rng;
    const personal = this.species[s].personalSpace;
    for (let k = 0; k < count; k++) {
      const anchor = this.randomMemberOf(s);
      const r = personal * rng.range(1, 2.5);
      const a = rng.angle();
      const i = this.spawnPreyAt(
        s,
        prey.x[anchor] + Math.cos(a) * r,
        prey.y[anchor] + Math.sin(a) * r,
        Math.atan2(prey.hy[anchor], prey.hx[anchor]) + rng.gaussian() * 0.2,
        Math.hypot(prey.vx[anchor], prey.vy[anchor]),
      );
      prey.geneSpeed[i] = prey.geneSpeed[anchor];
      prey.genePerception[i] = prey.genePerception[anchor];
    }
  }

  /**
   * Remove the most recently added agents of species s.
   * @param {number} s
   * @param {number} count
   */
  removePrey(s, count) {
    const prey = this.prey;
    for (let i = prey.count - 1; i >= 0 && count > 0; i--) {
      if (prey.species[i] === s) {
        prey.removeAt(i); // the slot is refilled from the (already visited) tail
        count--;
      }
    }
  }

  /**
   * @param {number} s
   * @returns {number} Index of a random live agent of species s (must exist).
   */
  randomMemberOf(s) {
    const prey = this.prey;
    for (let tries = 0; tries < 32; tries++) {
      const i = this.rng.int(prey.count);
      if (prey.species[i] === s) return i;
    }
    const start = this.rng.int(prey.count);
    for (let k = 0; k < prey.count; k++) {
      const i = (start + k) % prey.count;
      if (prey.species[i] === s) return i;
    }
    throw new Error(`no live agent of species ${s}`);
  }

  /**
   * @param {number} s
   * @param {number} x
   * @param {number} y
   * @param {number} heading
   * @param {number} speed
   * @returns {number} Index of the new agent.
   */
  spawnPreyAt(s, x, y, heading, speed) {
    const rt = this.speciesRuntime[s];
    const v = Math.min(speed, rt.maxSpeed);
    const i = this.prey.add(
      s,
      wrapCoord(x, this.width),
      wrapCoord(y, this.height),
      Math.cos(heading) * v,
      Math.sin(heading) * v,
      rt.maxSpeed,
      rt.maxForce,
    );
    this.prey.wander[i] = this.rng.gaussian();
    return i;
  }

  /** Spawn a predator at a random position. */
  spawnPredator() {
    const rng = this.rng;
    const p = this.spawnPredatorAt(rng.range(0, this.width), rng.range(0, this.height), rng.angle());
    p.stamina = rng.range(0.55, 1);
    p.energy = rng.range(0.55, 0.85);
    return p;
  }

  /**
   * @param {number} x
   * @param {number} y
   * @param {number} heading
   * @returns {Predator}
   */
  spawnPredatorAt(x, y, heading) {
    const PR = this.predatorRuntime;
    const p = new Predator(this.nextPredatorId++, wrapCoord(x, this.width), wrapCoord(y, this.height), heading, PR.patrolSpeed);
    p.speedLimit = PR.patrolSpeed * 1.2;
    p.wander = this.rng.gaussian();
    this.predators.push(p);
    return p;
  }

  /**
   * Re-initialise prey i as a new individual far from the predators (used after
   * a catch while the life cycle is off, so populations keep their size).
   * @param {number} i
   */
  respawnPrey(i) {
    const prey = this.prey;
    const rng = this.rng;
    const rt = this.speciesRuntime[prey.species[i]];
    let bestX = 0;
    let bestY = 0;
    let bestD = -1;
    for (let t = 0; t < 8; t++) {
      const cx = rng.range(0, this.width);
      const cy = rng.range(0, this.height);
      let nearest = Infinity;
      for (const p of this.predators) {
        nearest = Math.min(nearest, torusDistanceSq(cx, cy, p.x, p.y, this.width, this.height));
      }
      if (nearest > bestD) {
        bestD = nearest;
        bestX = cx;
        bestY = cy;
      }
    }
    const heading = rng.angle();
    const v = rt.cruiseSpeed;
    prey.id[i] = prey.nextId++; // new identity: predators locked on it let go
    prey.x[i] = bestX;
    prey.y[i] = bestY;
    prey.prevX[i] = bestX; // no interpolation streak across the screen
    prey.prevY[i] = bestY;
    prey.hx[i] = Math.cos(heading);
    prey.hy[i] = Math.sin(heading);
    prey.vx[i] = prey.hx[i] * v;
    prey.vy[i] = prey.hy[i] * v;
    prey.ax[i] = 0;
    prey.ay[i] = 0;
    prey.speedLimit[i] = Math.max(rt.maxSpeed, v);
    prey.panic[i] = 0;
    prey.panicNext[i] = 0;
    prey.burst[i] = 0;
    prey.escapeX[i] = 0;
    prey.escapeY[i] = 0;
    prey.wander[i] = rng.gaussian();
    prey.age[i] = 0;
    prey.foodTarget[i] = -1;
    prey.dead[i] = 0;
  }

  /**
   * @param {number} x
   * @param {number} y
   */
  recordCatch(x, y) {
    this.stats.catches++;
    this.addEffect('catch', x, y, -1);
  }

  /**
   * @param {EffectKind} kind
   * @param {number} x
   * @param {number} y
   * @param {number} species Prey species, or -1 for predators.
   */
  addEffect(kind, x, y, species) {
    if (this.effects.length >= EFFECT_LIMIT) this.effects.shift();
    this.effects.push({ kind, x, y, age: 0, duration: EFFECT_DURATION[kind], species });
  }

  recordHistory() {
    const sample = this.historySample;
    const counts = this.prey.countBySpecies;
    sample[0] = counts[0];
    sample[1] = counts[1];
    sample[2] = counts[2];
    sample[3] = this.predators.length;
    sample[4] = this.food.count;
    this.history.push(sample);
  }
}
