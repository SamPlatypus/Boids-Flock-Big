/**
 * Settings persistence in localStorage, so a home-screen PWA reopens with the
 * user's palette and tuning. Writes are debounced, and every storage access
 * tolerates private mode or blocked storage.
 *
 * @module persist
 */

import { CONFIG_KEYS } from './config.js';

/** @typedef {import('./config.js').ReactiveConfig} ReactiveConfig */
/** @typedef {import('./config.js').ConfigKey} ConfigKey */

const STORAGE_KEY = 'boids:settings:v1';
/** Not restored on the next launch. */
const VOLATILE = new Set(['paused']);

/**
 * Previously saved settings (unknown keys dropped), or an empty object.
 * @returns {Partial<Record<ConfigKey, unknown>>}
 */
export function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const data = JSON.parse(raw);
    /** @type {Partial<Record<ConfigKey, unknown>>} */
    const settings = {};
    for (const key of CONFIG_KEYS) {
      if (!VOLATILE.has(key) && data && Object.prototype.hasOwnProperty.call(data, key)) settings[key] = data[key];
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
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    } catch {
      // Storage unavailable: settings live for this session only.
    }
  };
  const unsubscribe = config.$subscribe((key) => {
    if (VOLATILE.has(key)) return;
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
  const canListen = typeof globalThis.addEventListener === 'function';
  if (canListen) globalThis.addEventListener('pagehide', flush);
  return () => {
    unsubscribe();
    if (canListen) globalThis.removeEventListener('pagehide', flush);
    clearTimeout(timer);
  };
}
