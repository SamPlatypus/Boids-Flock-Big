/**
 * Simulation controller: wires config, simulation, canvas, renderer, input and
 * the frame loop into one object. This is the exportable entry point for
 * embedding the engine (the UI pass builds on it).
 *
 * @example
 *   import { createFlockingApp } from './src/app.js';
 *   const app = createFlockingApp({ canvas: document.querySelector('canvas') });
 *   app.config.cohesionWeight = 2;            // reactive
 *   app.config.$subscribe((key, value) => …); // observe
 *   app.sim.on('catch', (e) => …);            // simulation hooks
 *   app.start();
 *
 * @module app
 */

import { createConfig } from './config.js';
import { FixedStepLoop } from './loop.js';
import { PointerInput } from './input/pointer-input.js';
import { Renderer } from './render/renderer.js';
import { CanvasSurface } from './render/surface.js';
import { FIXED_DT, Simulation } from './sim/simulation.js';
import { areaFactor } from './sim/ecology.js';
import { SCENARIOS, scaleForArea } from './presets.js';
import { StatsOverlay } from './stats.js';

/** @typedef {import('./config.js').ReactiveConfig} ReactiveConfig */
/** @typedef {import('./config.js').ConfigKey} ConfigKey */

/**
 * @typedef {object} FlockingApp
 * @property {ReactiveConfig} config Reactive configuration (also `window.simConfig`).
 * @property {Simulation} sim
 * @property {Renderer} renderer
 * @property {PointerInput} input
 * @property {FixedStepLoop} loop
 * @property {CanvasSurface} surface
 * @property {StatsOverlay | null} stats
 * @property {() => void} start Start the frame loop.
 * @property {() => void} stop Stop the frame loop.
 * @property {(seed?: number) => void} reset Respawn everything (new random seed unless given).
 * @property {(steps?: number) => void} step Advance manually (e.g. while paused) and redraw.
 * @property {(id: string) => void} applyScenario Apply a preset (populations scaled to the screen area).
 * @property {() => void} resetDefaults Restore every setting to its default (scaled to the screen area).
 * @property {() => number} areaFactor Ecosystem scale of the current world relative to a phone screen.
 * @property {() => void} destroy Detach listeners and stop.
 */

/**
 * @param {object} options
 * @param {HTMLCanvasElement} options.canvas Full-bleed canvas element.
 * @param {HTMLElement | null} [options.statsElement] Element for the stats readout.
 * @param {Partial<Record<ConfigKey, unknown>>} [options.config] Initial config overrides.
 * @param {number} [options.seed] PRNG seed (random by default).
 * @returns {FlockingApp}
 */
export function createFlockingApp({ canvas, statsElement = null, config: overrides = {}, seed }) {
  // The world size is needed first: ecosystem defaults scale with its area.
  /** @type {ReactiveConfig | null} */
  let configRef = null;
  const surface = new CanvasSurface(canvas, () => (configRef ? configRef.maxPixelRatio : 3));
  const scaledDefaults = () => {
    const balance = /** @type {import('./presets.js').Scenario} */ (SCENARIOS.find((s) => s.id === 'balance'));
    return scaleForArea(balance.patch, areaFactor(surface.width, surface.height));
  };
  const config = createConfig({ ...scaledDefaults(), ...overrides });
  configRef = config;
  surface.measure();
  const sim = new Simulation({
    config,
    width: surface.width,
    height: surface.height,
    seed: seed ?? randomSeed(),
  });
  const renderer = new Renderer(surface, sim, config);
  const input = new PointerInput(canvas, sim);
  const stats = statsElement ? new StatsOverlay(statsElement, sim) : null;

  let lastAlpha = 0;
  let lastNow = 0;
  surface.onResize = (width, height) => {
    sim.resize(width, height);
    // Resizing clears the backing store; redraw now so no blank frame shows.
    renderer.render(lastAlpha, lastNow);
  };

  const loop = new FixedStepLoop({
    dt: FIXED_DT,
    maxSubSteps: 4,
    step: (dt) => sim.step(dt),
    render: (alpha, now) => {
      lastAlpha = alpha;
      lastNow = now;
      input.update(now);
      renderer.render(alpha, now);
    },
    paused: () => config.paused,
    timeScale: () => config.timeScale,
    onFrame: (info) => stats?.record(info),
  });

  const unsubscribe = config.$subscribe((key, value) => {
    if (key === 'maxPixelRatio') surface.measure();
    else if (key === 'showStats') stats?.setVisible(Boolean(value));
  });
  stats?.setVisible(config.showStats);

  return {
    config,
    sim,
    renderer,
    input,
    loop,
    surface,
    stats,
    start: () => loop.start(),
    stop: () => loop.stop(),
    reset: (newSeed) => sim.reset(newSeed ?? randomSeed()),
    applyScenario: (id) => {
      const scenario = SCENARIOS.find((s) => s.id === id);
      if (!scenario) throw new Error(`unknown scenario "${id}"`);
      config.$set({ ...scaleForArea(scenario.patch, areaFactor(sim.width, sim.height)), paused: false });
    },
    resetDefaults: () => {
      config.$reset();
      config.$set(scaledDefaults());
    },
    areaFactor: () => areaFactor(sim.width, sim.height),
    step: (steps = 1) => {
      for (let k = 0; k < steps; k++) sim.step(FIXED_DT);
      renderer.render(1, performance.now());
    },
    destroy: () => {
      loop.stop();
      input.destroy();
      surface.destroy();
      unsubscribe();
    },
  };
}

function randomSeed() {
  return (Math.random() * 2 ** 32) >>> 0;
}
