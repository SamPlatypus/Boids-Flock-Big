/**
 * Lightweight performance readout (FPS, physics / render time, workload).
 * Updates the DOM a few times per second only.
 *
 * @module stats
 */

/** @typedef {import('./loop.js').FrameInfo} FrameInfo */
/** @typedef {import('./sim/simulation.js').Simulation} Simulation */

const REFRESH_SECONDS = 0.5;

export class StatsOverlay {
  /**
   * @param {HTMLElement} element
   * @param {Simulation} sim
   */
  constructor(element, sim) {
    this.element = element;
    this.sim = sim;
    this.frames = 0;
    this.time = 0;
    this.stepMs = 0;
    this.renderMs = 0;
    this.steps = 0;
    /** Latest averaged values, for programmatic access. */
    this.snapshot = { fps: 0, stepMs: 0, renderMs: 0 };
  }

  /** @param {boolean} visible */
  setVisible(visible) {
    this.element.hidden = !visible;
  }

  /** @param {FrameInfo} info */
  record(info) {
    this.frames++;
    this.time += info.elapsed;
    this.stepMs += info.stepMs;
    this.renderMs += info.renderMs;
    this.steps += info.steps;
    if (this.time < REFRESH_SECONDS) return;

    const fps = this.frames / this.time;
    const stepMs = this.steps > 0 ? this.stepMs / this.steps : 0;
    const renderMs = this.renderMs / this.frames;
    this.snapshot = { fps, stepMs, renderMs };
    if (!this.element.hidden) {
      const sim = this.sim;
      const hunting = sim.predators.filter((p) => p.state === 'pursue' || p.state === 'strike').length;
      this.element.textContent =
        `${fps.toFixed(0)} fps · sim ${stepMs.toFixed(2)} ms · draw ${renderMs.toFixed(2)} ms\n` +
        `${sim.prey.count} prey · ${sim.predators.length} predators (${hunting} hunting) · ${sim.stats.catches} caught\n` +
        `${(sim.stats.pairChecks / Math.max(1, sim.prey.count)).toFixed(1)} neighbour checks / agent`;
    }
    this.frames = 0;
    this.time = 0;
    this.stepMs = 0;
    this.renderMs = 0;
    this.steps = 0;
  }
}
