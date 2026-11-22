/**
 * Minimal synchronous event emitter used for simulation hooks
 * (e.g. `sim.on('catch', fn)`).
 *
 * @module core/emitter
 */

/**
 * @template {Record<string, any>} Events Map of event name → payload type.
 */
export class Emitter {
  constructor() {
    /** @type {Map<keyof Events, Set<(payload: any) => void>>} */
    this.listeners = new Map();
  }

  /**
   * Subscribe to an event.
   * @template {keyof Events} K
   * @param {K} type
   * @param {(payload: Events[K]) => void} listener
   * @returns {() => void} Unsubscribe function.
   */
  on(type, listener) {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
    return () => this.off(type, listener);
  }

  /**
   * @template {keyof Events} K
   * @param {K} type
   * @param {(payload: Events[K]) => void} listener
   */
  off(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  /**
   * @template {keyof Events} K
   * @param {K} type
   * @param {Events[K]} payload
   */
  emit(type, payload) {
    const set = this.listeners.get(type);
    if (!set || set.size === 0) return;
    // Copy so listeners may unsubscribe while being notified.
    for (const listener of [...set]) listener(payload);
  }
}
