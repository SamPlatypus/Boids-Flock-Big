/**
 * Seeded pseudo-random numbers (mulberry32). All simulation randomness flows
 * through one instance, so a given seed plus the same inputs reproduces a run
 * exactly. That keeps the tests deterministic and makes bugs replayable.
 *
 * @module core/rng
 */

export class Random {
  /** @param {number} [seed] */
  constructor(seed = 1) {
    /** @type {number} */
    this.state = 0;
    /** @type {number} Cached second Box–Muller sample (NaN when empty). */
    this.spare = NaN;
    this.reseed(seed);
  }

  /** @param {number} seed Any number; only the low 32 bits are used. */
  reseed(seed) {
    this.state = seed >>> 0;
    this.spare = NaN;
  }

  /** @returns {number} Uniform float in [0, 1). */
  next() {
    let t = (this.state = (this.state + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * @param {number} min
   * @param {number} max
   * @returns {number} Uniform float in [min, max).
   */
  range(min, max) {
    return min + (max - min) * this.next();
  }

  /**
   * @param {number} n
   * @returns {number} Uniform integer in [0, n).
   */
  int(n) {
    return Math.floor(this.next() * n);
  }

  /** @returns {number} Uniform angle in [0, 2π). */
  angle() {
    return this.next() * Math.PI * 2;
  }

  /** @returns {number} Standard normal sample (Box–Muller, pairs cached). */
  gaussian() {
    if (!Number.isNaN(this.spare)) {
      const s = this.spare;
      this.spare = NaN;
      return s;
    }
    const u = 1 - this.next(); // (0, 1], so log(u) is finite
    const v = this.next();
    const r = Math.sqrt(-2 * Math.log(u));
    this.spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  }
}
