/**
 * Population chart: the last ten minutes of the simulation's history.
 *
 * Prey species share the left scale; predators are dashed on their own right
 * scale (a dozen predators against hundreds of prey), which makes the
 * Lotka–Volterra phase lag visible: prey peak, predators follow, prey dip,
 * predators fall. Food is drawn as a faint backdrop area. Redraws only when
 * the history has a new sample or the size changes.
 *
 * @module ui/chart
 */

import { rgba } from '../core/color.js';
import { h } from './dom.js';

/** @typedef {import('../sim/simulation.js').Simulation} Simulation */
/** @typedef {import('../config.js').SimConfig} SimConfig */

/**
 * Round up to a "nice" axis maximum (1, 2, 2.5, 5 × 10ⁿ).
 * @param {number} value
 */
function niceMax(value) {
  if (value <= 1) return 1;
  const exp = 10 ** Math.floor(Math.log10(value));
  for (const m of [1, 2, 2.5, 5, 10]) if (value <= m * exp) return m * exp;
  return 10 * exp;
}

export class PopulationChart {
  /**
   * @param {Simulation} sim
   * @param {SimConfig} config
   */
  constructor(sim, config) {
    this.sim = sim;
    this.config = config;
    this.canvas = h('canvas', { class: 'chart', role: 'img', 'aria-label': 'Population history chart' });
    this.preyMaxLabel = h('span');
    this.timeLabel = h('span', { text: 'last 10 min' });
    this.predMaxLabel = h('span');
    this.element = h(
      'div',
      {},
      this.canvas,
      h('div', { class: 'chart-caption' }, this.preyMaxLabel, this.timeLabel, this.predMaxLabel),
    );
    this.drawnKey = '';
  }

  draw() {
    const canvas = this.canvas;
    const cssWidth = canvas.clientWidth;
    const cssHeight = canvas.clientHeight;
    if (cssWidth === 0 || cssHeight === 0) return;
    const history = this.sim.history;
    const config = this.config;
    const key = `${history.version}|${cssWidth}|${cssHeight}|${config.colorSpecies1}${config.colorSpecies2}${config.colorSpecies3}${config.colorPredator}${config.colorFood}`;
    if (key === this.drawnKey) return;
    this.drawnKey = key;

    const ratio = Math.min(window.devicePixelRatio || 1, 3);
    const width = Math.round(cssWidth * ratio);
    const height = Math.round(cssHeight * ratio);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const n = history.length;
    const capacity = history.capacity;
    const pad = 3;
    const plotH = cssHeight - 2 * pad;
    // x: the newest sample sits at the right edge; the window spans `capacity` samples.
    const xAt = (/** @type {number} */ i) => cssWidth - ((n - 1 - i) / (capacity - 1)) * cssWidth;

    let preyMax = 1;
    let predMax = 1;
    let foodMax = 1;
    for (let i = 0; i < n; i++) {
      preyMax = Math.max(preyMax, history.at(0, i), history.at(1, i), history.at(2, i));
      predMax = Math.max(predMax, history.at(3, i));
      foodMax = Math.max(foodMax, history.at(4, i));
    }
    preyMax = niceMax(preyMax * 1.08);
    predMax = Math.max(4, niceMax(predMax * 1.08));
    this.preyMaxLabel.textContent = `prey ≤ ${preyMax}`;
    this.predMaxLabel.textContent = `predators ≤ ${predMax}`;
    if (n > 0) {
      const last = (/** @type {number} */ series) => Math.round(history.at(series, n - 1));
      canvas.setAttribute(
        'aria-label',
        `Population over the last 10 minutes, now ${last(0)} dartfish, ${last(1)} mantas, ` +
          `${last(2)} foragers, ${last(3)} predators and ${last(4)} food particles`,
      );
    }

    // Grid lines.
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const f of [0.25, 0.5, 0.75]) {
      const y = Math.round(pad + plotH * f) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(cssWidth, y);
    }
    ctx.stroke();
    if (n < 2) return;

    // Food backdrop.
    ctx.beginPath();
    ctx.moveTo(xAt(0), pad + plotH);
    for (let i = 0; i < n; i++) ctx.lineTo(xAt(i), pad + plotH * (1 - history.at(4, i) / (foodMax * 1.6)));
    ctx.lineTo(xAt(n - 1), pad + plotH);
    ctx.closePath();
    ctx.fillStyle = rgba(config.colorFood, 0.12);
    ctx.fill();

    /**
     * @param {number} series
     * @param {number} max
     * @param {string} color
     * @param {boolean} dashed
     */
    const line = (series, max, color, dashed) => {
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = xAt(i);
        const y = pad + plotH * (1 - history.at(series, i) / max);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.setLineDash(dashed ? [5, 4] : []);
      ctx.lineWidth = dashed ? 1.75 : 2;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = color;
      ctx.stroke();
    };
    line(0, preyMax, config.colorSpecies1, false);
    line(1, preyMax, config.colorSpecies2, false);
    line(2, preyMax, config.colorSpecies3, false);
    line(3, predMax, config.colorPredator, true);
    ctx.setLineDash([]);
  }
}
