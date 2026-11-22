/**
 * Struct-of-arrays storage for all prey agents (every species in one pool).
 *
 * Each per-agent quantity lives in its own typed array, indexed 0..count−1.
 * The hot loops therefore read contiguous memory and the simulation never
 * allocates per step. Removal is O(1) swap-with-last, so indices are not
 * stable. Anything that must track an individual across steps (a predator's
 * target) also stores its `id` and revalidates it.
 *
 * @module sim/prey-pool
 */

import { SPECIES_COUNT } from './species.js';

const FLOAT_FIELDS = /** @type {const} */ ([
  'x', 'y', // position (world px, wrapped into [0, W) × [0, H))
  'vx', 'vy', // velocity (px/s)
  'prevX', 'prevY', // position at the start of the last step (render interpolation)
  'hx', 'hy', // unit heading; equals v/|v| whenever |v| > 0
  'ax', 'ay', // steering acceleration computed this step (px/s²)
  'speedLimit', // effective speed cap used this step (px/s)
  'forceLimit', // effective steering limit used this step (px/s²)
  'panic', 'panicNext', // alarm level ∈ [0, 1], double-buffered for order-independent contagion
  'wander', // Ornstein–Uhlenbeck wander state (unit variance)
  'burst', // speed-burst envelope ∈ [0, 1]
  'escapeX', 'escapeY', // remembered unit escape heading
  'threatX', 'threatY', // per-step flee stimulus (dimensionless urgency vector)
  'threat', // per-step direct alarm stimulus ∈ [0, 1]
  'attractX', 'attractY', // per-step attractor stimulus (dimensionless)
  'age', // seconds since spawn (render grow-in)
]);

export class PreyPool {
  /** @param {number} [initialCapacity] */
  constructor(initialCapacity = 256) {
    this.count = 0;
    this.capacity = 0;
    this.nextId = 1;
    /** Live agents per species. */
    this.countBySpecies = new Int32Array(SPECIES_COUNT);
    /** Stable identity (survives swap-removal). */
    this.id = new Uint32Array(0);
    this.species = new Uint8Array(0);
    /** Neighbours within perception last step (predators prefer isolated prey). */
    this.crowding = new Uint16Array(0);
    this.x = new Float64Array(0);
    this.y = new Float64Array(0);
    this.vx = new Float64Array(0);
    this.vy = new Float64Array(0);
    this.prevX = new Float64Array(0);
    this.prevY = new Float64Array(0);
    this.hx = new Float64Array(0);
    this.hy = new Float64Array(0);
    this.ax = new Float64Array(0);
    this.ay = new Float64Array(0);
    this.speedLimit = new Float64Array(0);
    this.forceLimit = new Float64Array(0);
    this.panic = new Float64Array(0);
    this.panicNext = new Float64Array(0);
    this.wander = new Float64Array(0);
    this.burst = new Float64Array(0);
    this.escapeX = new Float64Array(0);
    this.escapeY = new Float64Array(0);
    this.threatX = new Float64Array(0);
    this.threatY = new Float64Array(0);
    this.threat = new Float64Array(0);
    this.attractX = new Float64Array(0);
    this.attractY = new Float64Array(0);
    this.age = new Float64Array(0);
    this.reserve(initialCapacity);
  }

  /**
   * Ensure room for at least `capacity` agents (grows geometrically).
   * @param {number} capacity
   */
  reserve(capacity) {
    if (capacity <= this.capacity) return;
    const next = Math.max(capacity, this.capacity * 2, 64);
    for (const field of FLOAT_FIELDS) {
      const grown = new Float64Array(next);
      grown.set(this[field].subarray(0, this.count));
      this[field] = grown;
    }
    const id = new Uint32Array(next);
    id.set(this.id.subarray(0, this.count));
    this.id = id;
    const species = new Uint8Array(next);
    species.set(this.species.subarray(0, this.count));
    this.species = species;
    const crowding = new Uint16Array(next);
    crowding.set(this.crowding.subarray(0, this.count));
    this.crowding = crowding;
    this.capacity = next;
  }

  /**
   * Append an agent. Velocity must respect `speedLimit`.
   *
   * @param {number} species
   * @param {number} x
   * @param {number} y
   * @param {number} vx
   * @param {number} vy
   * @param {number} speedLimit Initial speed cap (≥ |v|).
   * @param {number} forceLimit Initial steering limit.
   * @returns {number} Index of the new agent.
   */
  add(species, x, y, vx, vy, speedLimit, forceLimit) {
    if (this.count === this.capacity) this.reserve(this.count + 1);
    const i = this.count++;
    for (const field of FLOAT_FIELDS) this[field][i] = 0;
    this.id[i] = this.nextId++;
    this.species[i] = species;
    this.crowding[i] = 0;
    this.x[i] = x;
    this.y[i] = y;
    this.prevX[i] = x;
    this.prevY[i] = y;
    this.vx[i] = vx;
    this.vy[i] = vy;
    const speed = Math.hypot(vx, vy);
    this.hx[i] = speed > 0 ? vx / speed : 1;
    this.hy[i] = speed > 0 ? vy / speed : 0;
    this.speedLimit[i] = speedLimit;
    this.forceLimit[i] = forceLimit;
    this.countBySpecies[species]++;
    return i;
  }

  /**
   * Remove agent i by moving the last agent into its slot. O(1).
   * @param {number} i
   */
  removeAt(i) {
    const last = this.count - 1;
    this.countBySpecies[this.species[i]]--;
    if (i !== last) {
      for (const field of FLOAT_FIELDS) {
        const a = this[field];
        a[i] = a[last];
      }
      this.id[i] = this.id[last];
      this.species[i] = this.species[last];
      this.crowding[i] = this.crowding[last];
    }
    this.count = last;
  }

  /** Remove every agent (keeps capacity). */
  clear() {
    this.count = 0;
    this.countBySpecies.fill(0);
  }

  /** Zero the per-step stimulus accumulators of all live agents. */
  clearStimuli() {
    const n = this.count;
    this.threatX.fill(0, 0, n);
    this.threatY.fill(0, 0, n);
    this.threat.fill(0, 0, n);
    this.attractX.fill(0, 0, n);
    this.attractY.fill(0, 0, n);
  }

  /** Publish the panic levels computed this step (double-buffer swap). */
  swapPanic() {
    const t = this.panic;
    this.panic = this.panicNext;
    this.panicNext = t;
  }
}
