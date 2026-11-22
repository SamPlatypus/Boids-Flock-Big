/**
 * Simulation: owns all agents and advances the world by fixed steps.
 *
 * DOM-free by design. It runs unchanged in the browser, in Node (tests,
 * benchmarks) or in a Web Worker. Rendering and input talk to it through its
 * public API: `step`, `resize`, `reset`, `addPulse`, `setBeacon`,
 * `releaseBeacon`, `on`, plus read access to `prey`, `predators`, `pulses`,
 * `beacons`, `effects` and `stats`.
 *
 * One step (Jacobi-style: every agent reads the same consistent snapshot):
 *   1. resolve species/predator parameters from config; sync populations
 *   2. rebuild the spatial hash (counting sort, O(N))
 *   3. interactions: beacon smoothing, pulse fronts → prey stimuli
 *   4. predators sense: threats → prey stimuli; score hunting targets
 *   5. prey steering (flocking + panic + prioritized allocation)
 *   6. predator state machine + steering
 *   7. integrate prey, then predators (+ catches)
 *
 * @module sim/simulation
 */

import { Random } from '../core/rng.js';
import { Emitter } from '../core/emitter.js';
import { clamp } from '../core/math.js';
import { NeighborBuffer, ToroidalSpatialHash } from '../core/spatial-hash.js';
import { torusDistanceSq, wrapCoord } from '../core/torus.js';
import { PREDATOR_PROFILE, SPECIES, SPECIES_COUNT, SpeciesRuntime } from './species.js';
import { PreyPool } from './prey-pool.js';
import { Predator, PredatorRuntime, integratePredators, sensePredators, steerPredators } from './predator.js';
import { Beacon, PULSE, Pulse, applyInteractionForces, updateInteractions } from './interactions.js';
import { computePreySteering, integratePrey } from './flocking.js';

/** @typedef {import('../config.js').SimConfig} SimConfig */
/** @typedef {import('./interactions.js').BeaconMode} BeaconMode */
/** @typedef {import('./predator.js').PredatorState} PredatorState */
/** @typedef {import('./species.js').SpeciesProfile} SpeciesProfile */
/** @typedef {import('./species.js').PredatorProfile} PredatorProfile */

/**
 * @typedef {object} SimEvents
 * @property {{ predator: number, prey: number, species: number, x: number, y: number, time: number }} catch
 * @property {{ id: number, from: PredatorState, to: PredatorState, time: number }} predatorState
 */

/** @typedef {{ x: number, y: number, age: number, duration: number }} CatchEffect */

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
const CATCH_EFFECT_DURATION = 0.6;

export class Simulation {
  /**
   * @param {object} options
   * @param {SimConfig} options.config Live config (read every step).
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
    this.grid = new ToroidalSpatialHash();
    this.neighborBuffer = new NeighborBuffer(MAX_NEIGHBORS);
    /** Untruncated results for predator / interaction queries (grown with the pool). */
    this.queryBuffer = new NeighborBuffer(512);
    /** @type {Pulse[]} */
    this.pulses = [];
    /** @type {Map<number | string, Beacon>} */
    this.beacons = new Map();
    this.fadingBeaconSerial = 0;
    /** @type {CatchEffect[]} */
    this.effects = [];
    /** @type {Emitter<SimEvents>} */
    this.events = new Emitter();
    this.stats = { pairChecks: 0, catches: 0 };
    this.reset(this.seed);
  }

  /**
   * Subscribe to 'catch' or 'predatorState'.
   * @template {keyof SimEvents} K
   * @param {K} type
   * @param {(payload: SimEvents[K]) => void} listener
   * @returns {() => void} Unsubscribe function.
   */
  on(type, listener) {
    return this.events.on(type, listener);
  }

  /**
   * Respawn every agent from the configured populations.
   * @param {number} [seed]
   */
  reset(seed = this.seed) {
    this.seed = seed >>> 0;
    this.rng.reseed(this.seed);
    this.time = 0;
    this.stepCount = 0;
    this.prey.clear();
    this.predators.length = 0;
    this.pulses.length = 0;
    this.beacons.clear();
    this.effects.length = 0;
    this.stats.catches = 0;
    this.resolveRuntime(FIXED_DT);
    for (let s = 0; s < SPECIES_COUNT; s++) {
      this.spawnSchools(s, this.config[this.species[s].countKey], true);
    }
    for (let k = 0; k < this.config.predatorCount; k++) this.spawnPredator();
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

    updateInteractions(this, dt);
    applyInteractionForces(this);
    sensePredators(this);
    computePreySteering(this, dt);
    steerPredators(this, dt);
    integratePrey(this, dt);
    integratePredators(this, dt);

    for (const effect of this.effects) effect.age += dt;
    for (let i = this.effects.length - 1; i >= 0; i--) {
      if (this.effects[i].age >= this.effects[i].duration) this.effects.splice(i, 1);
    }

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

  // ── Internals (also used by the predator module) ───────────────────────────

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

  /** Add or remove agents so the populations match the config. */
  syncPopulations() {
    const prey = this.prey;
    for (let s = 0; s < SPECIES_COUNT; s++) {
      const want = this.config[this.species[s].countKey];
      const have = prey.countBySpecies[s];
      if (want > have) this.addPrey(s, want - have);
      else if (want < have) this.removePrey(s, have - want);
    }
    const wantPredators = this.config.predatorCount;
    while (this.predators.length < wantPredators) this.spawnPredator();
    if (this.predators.length > wantPredators) this.predators.length = wantPredators;
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
      this.spawnPreyAt(
        s,
        prey.x[anchor] + Math.cos(a) * r,
        prey.y[anchor] + Math.sin(a) * r,
        Math.atan2(prey.hy[anchor], prey.hx[anchor]) + rng.gaussian() * 0.2,
        Math.hypot(prey.vx[anchor], prey.vy[anchor]),
      );
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

  spawnPredator() {
    const rng = this.rng;
    const PR = this.predatorRuntime;
    const p = new Predator(
      this.nextPredatorId++,
      rng.range(0, this.width),
      rng.range(0, this.height),
      rng.angle(),
      PR.patrolSpeed,
    );
    p.stamina = rng.range(0.55, 1);
    p.speedLimit = PR.patrolSpeed * 1.2;
    p.wander = rng.gaussian();
    this.predators.push(p);
  }

  /**
   * Re-initialise prey i as a new individual far from the predators (used after
   * a catch, so populations stay at their configured size).
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
  }

  /**
   * @param {number} x
   * @param {number} y
   */
  recordCatch(x, y) {
    this.stats.catches++;
    this.effects.push({ x, y, age: 0, duration: CATCH_EFFECT_DURATION });
  }
}
