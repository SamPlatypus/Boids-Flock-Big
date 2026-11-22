/**
 * Browser entry point: boots the engine on the full-bleed canvas and exposes
 *   window.simConfig: reactive configuration
 *   window.sim:       the app controller (sim, renderer, loop, …)
 *
 * Any config key can be preset from the URL, e.g. `?countSpecies1=500&debug=1`,
 * and `?seed=42` makes the run reproducible.
 *
 * Desktop shortcuts: Space pause · D debug · S stats · R reset.
 *
 * @module main
 */

import { createFlockingApp } from './app.js';
import { isConfigKey } from './config.js';

const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('sim'));
const statsElement = document.getElementById('stats');

const params = new URLSearchParams(location.search);
/** @type {Record<string, string>} */
const overrides = {};
for (const [key, value] of params) if (isConfigKey(key)) overrides[key] = value;
const seedParam = params.get('seed');

const app = createFlockingApp({
  canvas,
  statsElement,
  config: overrides,
  seed: seedParam !== null && seedParam !== '' && Number.isFinite(Number(seedParam)) ? Number(seedParam) : undefined,
});

window.simConfig = app.config;
window.sim = app;
app.start();

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  switch (e.key) {
    case ' ':
      app.config.paused = !app.config.paused;
      e.preventDefault();
      break;
    case 'd':
      app.config.debug = !app.config.debug;
      break;
    case 's':
      app.config.showStats = !app.config.showStats;
      break;
    case 'r':
      app.reset();
      break;
  }
});
