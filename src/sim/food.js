/**
 * Food / flora: nutrient particles that bloom in clusters and drift.
 *
 * Blooms arrive as a Poisson process (rate = foodSpawnRate / mean bloom size).
 * Each bloom releases its particles over ~1 s around a random centre, so
 * patches visibly grow. Particles ride a smooth current: the curl of a stream
 * function ψ that is periodic in W and H,
 *
 *     ψ = A₁ sin(k₁ₓx + a₁t) sin(k₁ᵧy + b₁t) + A₂ sin(k₂ₓx + a₂t) cos(k₂ᵧy + b₂t)
 *     v = (∂ψ/∂y, −∂ψ/∂x)
 *
 * The flow is divergence-free, so particles never pile up at sinks, and
 * seamless across the toroidal edges. Particles age out after ~45 s.
 * Grazers find the nearest particle with a K = 1 query on a spatial hash,
 * which usually stops after the first ring of cells.
 *
 * @module sim/food
 */

import { NeighborBuffer, ToroidalSpatialHash } from '../core/spatial-hash.js';
import { wrapCoord } from '../core/torus.js';

/** @typedef {import('./simulation.js').Simulation} Simulation */

export const FOOD = Object.freeze({
  /** Energy (of a prey's 1.0) in one particle. */
  nutrition: 0.16,
  /** Mean lifetime (s) and relative jitter. */
  lifetime: 45,
  lifetimeJitter: 0.35,
  /** Hard cap on live particles; blooms pause while it is reached. */
  maxParticles: 420,
  /** Particles per bloom (uniform range). */
  bloomMin: 6,
  bloomMax: 13,
  /** Gaussian spread of a bloom (px): tight enough to read as a patch. */
  bloomSpread: 18,
  /** Time over which a bloom releases its particles (s). */
  bloomDuration: 1,
  /** Typical current speed (px/s). */
  driftSpeed: 9,
  /** Visual grow-in and fade-out times (s). */
  growTime: 0.6,
  fadeTime: 3,
  /** Spatial-hash cell edge (px). */
  cellSize: 40,
});

const TAU = Math.PI * 2;

/** @typedef {{ x: number, y: number, remaining: number, timer: number, interval: number }} Bloom */

export class FoodField {
  /** @param {number} [initialCapacity] */
  constructor(initialCapacity = 512) {
    this.count = 0;
    this.capacity = 0;
    this.nextId = 1;
    this.id = new Uint32Array(0);
    this.eaten = new Uint8Array(0);
    this.x = new Float64Array(0);
    this.y = new Float64Array(0);
    this.age = new Float64Array(0);
    this.life = new Float64Array(0);
    this.value = new Float64Array(0);
    /** Random phase for the render twinkle. */
    this.phase = new Float64Array(0);
    /** @type {Bloom[]} */
    this.blooms = [];
    /** Clock driving the slowly evolving current. */
    this.flowTime = 0;
    /** Energy per new particle (tunable at runtime; defaults to FOOD.nutrition). @type {number} */
    this.nutrition = FOOD.nutrition;
    /** Live-particle cap; the simulation scales it with the world area. @type {number} */
    this.maxParticles = FOOD.maxParticles;
    this.grid = new ToroidalSpatialHash();
    this.nearestBuffer = new NeighborBuffer(1);
    this.reserve(initialCapacity);
  }

  /** @param {number} capacity */
  reserve(capacity) {
    if (capacity <= this.capacity) return;
    const next = Math.max(capacity, this.capacity * 2, 64);
    const grow = (/** @type {Float64Array} */ a) => {
      const b = new Float64Array(next);
      b.set(a.subarray(0, this.count));
      return b;
    };
    this.x = grow(this.x);
    this.y = grow(this.y);
    this.age = grow(this.age);
    this.life = grow(this.life);
    this.value = grow(this.value);
    this.phase = grow(this.phase);
    const id = new Uint32Array(next);
    id.set(this.id.subarray(0, this.count));
    this.id = id;
    const eaten = new Uint8Array(next);
    eaten.set(this.eaten.subarray(0, this.count));
    this.eaten = eaten;
    this.capacity = next;
  }

  clear() {
    this.count = 0;
    this.blooms.length = 0;
  }

  /**
   * @param {number} x
   * @param {number} y
   * @param {number} life Lifetime (s).
   * @param {number} phase
   * @returns {number} Index.
   */
  add(x, y, life, phase) {
    if (this.count === this.capacity) this.reserve(this.count + 1);
    const i = this.count++;
    this.id[i] = this.nextId++;
    this.eaten[i] = 0;
    this.x[i] = x;
    this.y[i] = y;
    this.age[i] = 0;
    this.life[i] = life;
    this.value[i] = this.nutrition;
    this.phase[i] = phase;
    return i;
  }

  /** @param {number} i */
  removeAt(i) {
    const last = --this.count;
    if (i === last) return;
    this.id[i] = this.id[last];
    this.eaten[i] = this.eaten[last];
    this.x[i] = this.x[last];
    this.y[i] = this.y[last];
    this.age[i] = this.age[last];
    this.life[i] = this.life[last];
    this.value[i] = this.value[last];
    this.phase[i] = this.phase[last];
  }

  /**
   * Start a bloom at (x, y) releasing `size` particles over the bloom duration.
   * @param {number} x
   * @param {number} y
   * @param {number} size
   */
  startBloom(x, y, size) {
    this.blooms.push({ x, y, remaining: size, timer: 0, interval: FOOD.bloomDuration / size });
  }

  /**
   * Populate the world with mature patches (used on reset).
   * @param {Simulation} sim
   * @param {number} particles
   */
  seed(sim, particles) {
    const rng = sim.rng;
    while (particles > 0 && this.count < this.maxParticles) {
      const cx = rng.range(0, sim.width);
      const cy = rng.range(0, sim.height);
      const size = Math.min(particles, FOOD.bloomMin + rng.int(FOOD.bloomMax - FOOD.bloomMin + 1));
      for (let k = 0; k < size && this.count < this.maxParticles; k++) {
        const i = this.add(
          wrapCoord(cx + rng.gaussian() * FOOD.bloomSpread, sim.width),
          wrapCoord(cy + rng.gaussian() * FOOD.bloomSpread, sim.height),
          this.randomLife(sim),
          rng.angle(),
        );
        this.age[i] = rng.range(FOOD.growTime, this.life[i] * 0.6);
      }
      particles -= size;
    }
  }

  /** @param {Simulation} sim */
  randomLife(sim) {
    return FOOD.lifetime * (1 + FOOD.lifetimeJitter * (2 * sim.rng.next() - 1));
  }

  /**
   * One step: compact eaten/expired particles, spawn and grow blooms, drift,
   * age, and rebuild the spatial hash.
   * @param {Simulation} sim
   * @param {number} dt
   * @param {boolean} spawning Life cycle on: blooms start and grow. Off: no
   *   one grazes, so pending blooms are dropped and the remaining particles
   *   fade out within FOOD.fadeTime instead of drifting for their full life.
   */
  update(sim, dt, spawning) {
    const rng = sim.rng;
    const W = sim.width;
    const H = sim.height;

    for (let i = this.count - 1; i >= 0; i--) {
      if (this.eaten[i] || this.age[i] >= this.life[i]) this.removeAt(i);
    }

    if (!spawning) {
      this.blooms.length = 0;
      for (let i = 0; i < this.count; i++) this.life[i] = Math.min(this.life[i], this.age[i] + FOOD.fadeTime);
    } else {
      const meanSize = (FOOD.bloomMin + FOOD.bloomMax) / 2;
      if (rng.next() < (sim.config.foodSpawnRate / meanSize) * dt) {
        const size = FOOD.bloomMin + rng.int(FOOD.bloomMax - FOOD.bloomMin + 1);
        this.startBloom(rng.range(0, W), rng.range(0, H), size);
      }
    }
    for (let b = this.blooms.length - 1; b >= 0; b--) {
      const bloom = this.blooms[b];
      bloom.timer -= dt;
      while (bloom.timer <= 0 && bloom.remaining > 0 && this.count < this.maxParticles) {
        this.add(
          wrapCoord(bloom.x + rng.gaussian() * FOOD.bloomSpread, W),
          wrapCoord(bloom.y + rng.gaussian() * FOOD.bloomSpread, H),
          this.randomLife(sim),
          rng.angle(),
        );
        bloom.remaining--;
        bloom.timer += bloom.interval;
      }
      if (bloom.remaining <= 0 || this.count >= this.maxParticles) this.blooms.splice(b, 1);
    }

    // Drift on the curl of a periodic stream function (two modes).
    this.flowTime += dt;
    const t = this.flowTime;
    const k1x = TAU / W;
    const k1y = TAU / H;
    const k2x = 2 * k1x;
    const k2y = 2 * k1y;
    const a1 = FOOD.driftSpeed / ((k1x + k1y) / 2);
    const a2 = (0.5 * FOOD.driftSpeed) / ((k2x + k2y) / 2);
    const p1x = 0.05 * t;
    const p1y = 0.037 * t;
    const p2x = -0.031 * t;
    const p2y = 0.043 * t;
    const { x, y, age } = this;
    for (let i = 0; i < this.count; i++) {
      const X1 = k1x * x[i] + p1x;
      const Y1 = k1y * y[i] + p1y;
      const X2 = k2x * x[i] + p2x;
      const Y2 = k2y * y[i] + p2y;
      const s1 = Math.sin(X1);
      const c1 = Math.cos(X1);
      const s2 = Math.sin(X2);
      const c2 = Math.cos(X2);
      const vx = a1 * k1y * s1 * Math.cos(Y1) - a2 * k2y * s2 * Math.sin(Y2);
      const vy = -a1 * k1x * c1 * Math.sin(Y1) - a2 * k2x * c2 * Math.cos(Y2);
      x[i] = wrapCoord(x[i] + vx * dt, W);
      y[i] = wrapCoord(y[i] + vy * dt, H);
      age[i] += dt;
    }

    this.grid.configure(W, H, FOOD.cellSize);
    this.grid.build(x, y, this.count);
  }

  /**
   * Nearest uneaten particle within `radius` of (x, y).
   * @param {number} x
   * @param {number} y
   * @param {number} radius
   * @returns {number} Index, or -1. The displacement is in nearestBuffer.dx/dy[0].
   */
  nearest(x, y, radius) {
    if (this.count === 0) return -1;
    const n = this.grid.query(x, y, radius, -1, this.nearestBuffer);
    if (n === 0) return -1;
    const i = this.nearestBuffer.index[0];
    return this.eaten[i] ? -1 : i;
  }

  /**
   * Mark particle i eaten (removed on the next update).
   * @param {number} i
   * @returns {number} Its nutrition.
   */
  consume(i) {
    this.eaten[i] = 1;
    return this.value[i];
  }

  /**
   * Scale positions after a world resize.
   * @param {number} sx
   * @param {number} sy
   * @param {number} width
   * @param {number} height
   */
  rescale(sx, sy, width, height) {
    for (let i = 0; i < this.count; i++) {
      this.x[i] = wrapCoord(this.x[i] * sx, width);
      this.y[i] = wrapCoord(this.y[i] * sy, height);
    }
    for (const bloom of this.blooms) {
      bloom.x = wrapCoord(bloom.x * sx, width);
      bloom.y = wrapCoord(bloom.y * sy, height);
    }
  }
}
