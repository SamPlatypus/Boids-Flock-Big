/**
 * Fixed-size ring buffer of population samples, recorded on simulation time
 * (not wall time), so charts and tests see identical histories for identical
 * runs.
 *
 * @module sim/history
 */

/** Series stored per sample, in order. */
export const HISTORY_SERIES = /** @type {const} */ (['dartfish', 'mantas', 'foragers', 'predators', 'food']);

export class PopulationHistory {
  /**
   * @param {number} [capacity] Samples kept (oldest dropped first).
   * @param {number} [interval] Simulated seconds between samples.
   */
  constructor(capacity = 300, interval = 1) {
    this.capacity = capacity;
    this.interval = interval;
    /** One Float32Array per entry of HISTORY_SERIES. */
    this.series = HISTORY_SERIES.map(() => new Float32Array(capacity));
    this.length = 0;
    /** Slot the next sample goes into. */
    this.head = 0;
    this.elapsed = 0;
    /** Incremented on every new sample (lets consumers skip redundant redraws). */
    this.version = 0;
  }

  clear() {
    this.length = 0;
    this.head = 0;
    this.elapsed = 0;
    this.version++;
  }

  /**
   * Advance the clock; returns true when a sample is due.
   * @param {number} dt
   */
  tick(dt) {
    this.elapsed += dt;
    if (this.elapsed < this.interval) return false;
    this.elapsed -= this.interval;
    return true;
  }

  /** @param {readonly number[]} values One value per series. */
  push(values) {
    for (let s = 0; s < this.series.length; s++) this.series[s][this.head] = values[s];
    this.head = (this.head + 1) % this.capacity;
    if (this.length < this.capacity) this.length++;
    this.version++;
  }

  /**
   * @param {number} series Index into HISTORY_SERIES.
   * @param {number} i Chronological index (0 = oldest kept sample).
   * @returns {number}
   */
  at(series, i) {
    const start = (this.head - this.length + this.capacity) % this.capacity;
    return this.series[series][(start + i) % this.capacity];
  }
}
