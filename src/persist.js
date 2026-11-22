/**
 * Settings persistence in localStorage, so a home-screen PWA reopens with the
 * user's palette and tuning. Writes are debounced, and every storage access
 * tolerates private mode or blocked storage.
 *
 * @module persist
 */

import { CONFIG_KEYS, COUNT_KEYS } from './config.js';

/** @typedef {import('./config.js').ReactiveConfig} ReactiveConfig */
/** @typedef {import('./config.js').ConfigKey} ConfigKey */

const STORAGE_KEY = 'boids:settings:v1';
/** Not restored on the next launch. */
const VOLATILE = new Set(['paused']);
/**
 * With the life cycle on, populations are live simulation state that the
 * simulation writes back every step, not settings: saving them would restore
 * a crash (e.g. 0 predators, which reads as "the user removed predators" and
 * disables the extinction rescue). Each launch starts a fresh ecosystem
 * instead. With fixed populations they are the user's choice and are saved.
 */
const LIVE_WITH_ECOSYSTEM = new Set([...COUNT_KEYS, 'predatorCount']);

/**
 * Previously saved settings (unknown keys dropped), or an empty object.
 * @returns {Partial<Record<ConfigKey, unknown>>}
 */
export function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return {};
    const ecosystem = data.ecosystem !== false; // absent means the default (on)
    /** @type {Partial<Record<ConfigKey, unknown>>} */
    const settings = {};
    for (const key of CONFIG_KEYS) {
      if (VOLATILE.has(key) || (ecosystem && LIVE_WITH_ECOSYSTEM.has(key))) continue;
      if (Object.prototype.hasOwnProperty.call(data, key)) settings[key] = data[key];
    }
    return settings;
  } catch {
    return {};
  }
}

/**
 * Save the config whenever it changes (debounced).
 * @param {ReactiveConfig} config
 * @param {number} [delay] ms
 * @returns {() => void} Stop persisting.
 */
export function persistSettings(config, delay = 500) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const save = () => {
    const snapshot = /** @type {Record<string, unknown>} */ (config.$snapshot());
    for (const key of VOLATILE) delete snapshot[key];
    if (snapshot.ecosystem) for (const key of LIVE_WITH_ECOSYSTEM) delete snapshot[key];
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    } catch {
      // Storage unavailable: settings live for this session only.
    }
  };
  const unsubscribe = config.$subscribe((key) => {
    if (VOLATILE.has(key) || (config.ecosystem && LIVE_WITH_ECOSYSTEM.has(key))) return;
    clearTimeout(timer);
    timer = setTimeout(save, delay);
  });
  const flush = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
      save();
    }
  };
  // Persist pending changes when the page is hidden or closed (browser only).
  // Mobile browsers may kill a backgrounded app without `pagehide`;
  // `visibilitychange` to hidden is the last reliable moment.
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') flush();
  };
  const canListen = typeof globalThis.addEventListener === 'function' && typeof document !== 'undefined';
  if (canListen) {
    globalThis.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibility);
  }
  return () => {
    unsubscribe();
    if (canListen) {
      globalThis.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
    }
    clearTimeout(timer);
  };
}
