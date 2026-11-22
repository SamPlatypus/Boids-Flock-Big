/**
 * Canvas 2D renderer.
 *
 * Performance:
 * - Each prey species has one Path2D silhouette built once in body units. An
 *   agent is drawn with a single setTransform (rotation from the unit heading
 *   (cos θ, sin θ) = v/|v|, so no trigonometry, plus scale and translation)
 *   followed by fill(path). Measured against one big path per colour, this
 *   scales linearly where the big path went superlinear: heavily overlapping
 *   subpaths in dense schools are expensive to rasterise. Reusing identical
 *   geometry is also what GPU canvas backends cache best.
 * - Agents are bucketed by (species, panic level) with a counting sort, so
 *   fillStyle changes at most 12 times per frame.
 * - Nothing is allocated per agent per frame.
 *
 * Correctness:
 * - Positions are interpolated between the last two physics steps along the
 *   shortest toroidal path, so motion is smooth at 60/90/120 Hz with a fixed
 *   60 Hz simulation, and nothing streaks across the screen when wrapping.
 * - Shadow rendering: an agent whose silhouette overlaps an edge is also drawn
 *   at its wrapped image(s) on the opposite side (up to 3 extra copies near
 *   corners), so agents slide across seams instead of popping.
 *
 * @module render/renderer
 */

import { lerp, smoothstep } from '../core/math.js';
import { wrapCoord, wrapDelta } from '../core/torus.js';
import { BEACON, PULSE } from '../sim/interactions.js';
import { SPECIES_COUNT } from '../sim/species.js';
import { PREDATOR_SHAPE, SPECIES_SHAPES, shapeRadius } from './shapes.js';

/** @typedef {import('../sim/simulation.js').Simulation} Simulation */
/** @typedef {import('../config.js').SimConfig} SimConfig */
/** @typedef {import('./surface.js').CanvasSurface} CanvasSurface */

const PANIC_LEVELS = 4;
/** Fraction of the alarm colour mixed in at each panic level. */
const PANIC_TINT = [0, 0.38, 0.68, 1];
/** Seconds for a newborn agent to grow to full size. */
const GROW_TIME = 0.6;
const TAU = Math.PI * 2;

/**
 * @param {number} p Panic ∈ [0, 1].
 * @returns {number} Bucket 0..3.
 */
function panicLevel(p) {
  return p < 0.15 ? 0 : p < 0.4 ? 1 : p < 0.7 ? 2 : 3;
}

/**
 * @param {string} hex '#rrggbb'
 * @returns {[number, number, number]}
 */
function parseHex(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/**
 * @param {string} a
 * @param {string} b
 * @param {number} t
 * @returns {string} CSS rgb() colour.
 */
function mixHex(a, b, t) {
  const ca = parseHex(a);
  const cb = parseHex(b);
  const c = ca.map((v, i) => Math.round(lerp(v, cb[i], t)));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

/**
 * Append one rotated, scaled polygon as a closed subpath.
 * @param {CanvasRenderingContext2D} ctx
 * @param {readonly number[]} verts Body-space polygon.
 * @param {number} x Centre.
 * @param {number} y
 * @param {number} c cos θ (unit heading x).
 * @param {number} s sin θ (unit heading y).
 * @param {number} kx Scale along the heading (px per body length).
 * @param {number} ky Scale across the heading.
 */
function tracePolygon(ctx, verts, x, y, c, s, kx, ky) {
  let bx = verts[0] * kx;
  let by = verts[1] * ky;
  ctx.moveTo(x + bx * c - by * s, y + bx * s + by * c);
  for (let v = 2; v < verts.length; v += 2) {
    bx = verts[v] * kx;
    by = verts[v + 1] * ky;
    ctx.lineTo(x + bx * c - by * s, y + bx * s + by * c);
  }
  ctx.closePath();
}

/**
 * Trace an agent plus the wrapped ghost copies needed near edges/corners.
 * @param {CanvasRenderingContext2D} ctx
 * @param {readonly number[]} verts
 * @param {number} x
 * @param {number} y
 * @param {number} c
 * @param {number} s
 * @param {number} kx
 * @param {number} ky
 * @param {number} radius Visual radius (px) of the silhouette.
 * @param {number} W
 * @param {number} H
 */
function traceWrapped(ctx, verts, x, y, c, s, kx, ky, radius, W, H) {
  tracePolygon(ctx, verts, x, y, c, s, kx, ky);
  const ox = x < radius ? W : x > W - radius ? -W : 0;
  const oy = y < radius ? H : y > H - radius ? -H : 0;
  if (ox !== 0) tracePolygon(ctx, verts, x + ox, y, c, s, kx, ky);
  if (oy !== 0) tracePolygon(ctx, verts, x, y + oy, c, s, kx, ky);
  if (ox !== 0 && oy !== 0) tracePolygon(ctx, verts, x + ox, y + oy, c, s, kx, ky);
}

/**
 * Wrapped image offsets for a circle of radius r at (x, y). Fills `out` with
 * [dx, dy] pairs (always including [0, 0]) and returns the pair count.
 * @param {number} x
 * @param {number} y
 * @param {number} r
 * @param {number} W
 * @param {number} H
 * @param {Float64Array} out Length ≥ 8.
 * @returns {number}
 */
function wrapOffsets(x, y, r, W, H, out) {
  const ox = x - r < 0 ? W : x + r > W ? -W : 0;
  const oy = y - r < 0 ? H : y + r > H ? -H : 0;
  let n = 0;
  out[n++] = 0;
  out[n++] = 0;
  if (ox !== 0) {
    out[n++] = ox;
    out[n++] = 0;
  }
  if (oy !== 0) {
    out[n++] = 0;
    out[n++] = oy;
  }
  if (ox !== 0 && oy !== 0) {
    out[n++] = ox;
    out[n++] = oy;
  }
  return n / 2;
}

export class Renderer {
  /**
   * @param {CanvasSurface} surface
   * @param {Simulation} sim
   * @param {SimConfig} config
   */
  constructor(surface, sim, config) {
    this.surface = surface;
    this.sim = sim;
    this.config = config;
    const buckets = SPECIES_COUNT * PANIC_LEVELS;
    this.bucketStart = new Int32Array(buckets + 1);
    this.bucketCursor = new Int32Array(buckets);
    this.bucketOf = new Int32Array(0);
    this.bucketItems = new Int32Array(0);
    /** @type {string[]} fill colour per bucket */
    this.palette = new Array(buckets).fill('#fff');
    this.paletteKey = '';
    this.offsets = new Float64Array(8);
    this.shapeRadii = SPECIES_SHAPES.map(shapeRadius);
    this.predatorRadius = shapeRadius(PREDATOR_SHAPE);
    /** Silhouettes in body units, built once. */
    this.preyPaths = SPECIES_SHAPES.map((shape) => {
      const path = new Path2D();
      path.moveTo(shape[0], shape[1]);
      for (let v = 2; v < shape.length; v += 2) path.lineTo(shape[v], shape[v + 1]);
      path.closePath();
      return path;
    });
  }

  /**
   * Draw one frame.
   * @param {number} alpha Interpolation factor ∈ [0, 1) between the last two steps.
   * @param {number} timeMs Frame timestamp (animations only).
   */
  render(alpha, timeMs) {
    const { ctx, scaleX, scaleY } = this.surface;
    const W = this.sim.width;
    const H = this.sim.height;
    ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);
    ctx.clearRect(0, 0, W, H);
    this.drawPulses(ctx, W, H);
    this.drawPrey(ctx, alpha, W, H);
    this.drawPredators(ctx, alpha, W, H);
    this.drawEffects(ctx, W, H);
    this.drawBeacons(ctx, timeMs / 1000);
    if (this.config.debug) this.drawDebug(ctx, alpha, W, H);
  }

  refreshPalette() {
    const species = this.sim.species;
    const key = species.map((p) => p.color + p.alarmColor).join();
    if (key === this.paletteKey) return;
    this.paletteKey = key;
    for (let s = 0; s < SPECIES_COUNT; s++) {
      for (let l = 0; l < PANIC_LEVELS; l++) {
        this.palette[s * PANIC_LEVELS + l] = mixHex(species[s].color, species[s].alarmColor, PANIC_TINT[l]);
      }
    }
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} alpha
   * @param {number} W
   * @param {number} H
   */
  drawPrey(ctx, alpha, W, H) {
    const prey = this.sim.prey;
    const n = prey.count;
    if (n === 0) return;
    this.refreshPalette();
    if (this.bucketOf.length < n) {
      this.bucketOf = new Int32Array(prey.capacity);
      this.bucketItems = new Int32Array(prey.capacity);
    }
    const { x, y, prevX, prevY, hx, hy, species, panic, age } = prey;
    const buckets = SPECIES_COUNT * PANIC_LEVELS;
    const start = this.bucketStart;
    const cursor = this.bucketCursor;
    const bucketOf = this.bucketOf;
    const items = this.bucketItems;

    // Counting sort of agents into (species, panic) buckets.
    start.fill(0);
    for (let i = 0; i < n; i++) {
      const b = species[i] * PANIC_LEVELS + panicLevel(panic[i]);
      bucketOf[i] = b;
      start[b + 1]++;
    }
    for (let b = 0; b < buckets; b++) start[b + 1] += start[b];
    for (let b = 0; b < buckets; b++) cursor[b] = start[b];
    for (let i = 0; i < n; i++) items[cursor[bucketOf[i]]++] = i;

    const profiles = this.sim.species;
    const sx = this.surface.scaleX;
    const sy = this.surface.scaleY;
    for (let b = 0; b < buckets; b++) {
      const from = start[b];
      const to = start[b + 1];
      if (from === to) continue;
      const s = (b / PANIC_LEVELS) | 0;
      const path = this.preyPaths[s];
      const length = profiles[s].length;
      const radius = this.shapeRadii[s] * length;
      ctx.fillStyle = this.palette[b];
      for (let k = from; k < to; k++) {
        const i = items[k];
        const grow = age[i] >= GROW_TIME ? 1 : smoothstep(0, GROW_TIME, age[i]);
        if (grow <= 0) continue;
        const px = prevX[i];
        const py = prevY[i];
        const rx = wrapCoord(px + wrapDelta(x[i] - px, W) * alpha, W);
        const ry = wrapCoord(py + wrapDelta(y[i] - py, H) * alpha, H);
        // Body (bx, by) → device: [sx·size·(bx·hx − by·hy) + sx·rx, sy·size·(bx·hy + by·hx) + sy·ry].
        const size = length * grow;
        const a = sx * size * hx[i];
        const c = -sx * size * hy[i];
        const bb = sy * size * hy[i];
        const d = sy * size * hx[i];
        ctx.setTransform(a, bb, c, d, rx * sx, ry * sy);
        ctx.fill(path);
        // Shadow copies across the seams (edges and corners).
        const ox = rx < radius ? W : rx > W - radius ? -W : 0;
        const oy = ry < radius ? H : ry > H - radius ? -H : 0;
        if (ox !== 0) {
          ctx.setTransform(a, bb, c, d, (rx + ox) * sx, ry * sy);
          ctx.fill(path);
        }
        if (oy !== 0) {
          ctx.setTransform(a, bb, c, d, rx * sx, (ry + oy) * sy);
          ctx.fill(path);
          if (ox !== 0) {
            ctx.setTransform(a, bb, c, d, (rx + ox) * sx, (ry + oy) * sy);
            ctx.fill(path);
          }
        }
      }
    }
    ctx.setTransform(sx, 0, 0, sy, 0, 0);
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} alpha
   * @param {number} W
   * @param {number} H
   */
  drawPredators(ctx, alpha, W, H) {
    const profile = this.sim.predatorProfile;
    const length = profile.length;
    for (const p of this.sim.predators) {
      const rx = wrapCoord(p.prevX + wrapDelta(p.x - p.prevX, W) * alpha, W);
      const ry = wrapCoord(p.prevY + wrapDelta(p.y - p.prevY, H) * alpha, H);
      const striking = p.state === 'strike';
      const hunting = striking || p.state === 'pursue';
      // A strike visibly stretches the body along the lunge.
      const kx = length * (striking ? 1.12 : 1);
      const ky = length * (striking ? 0.92 : 1);
      const radius = this.predatorRadius * kx * 1.5;

      if (hunting) {
        // Cheap glow: an enlarged translucent silhouette (no shadowBlur).
        ctx.beginPath();
        traceWrapped(ctx, PREDATOR_SHAPE, rx, ry, p.hx, p.hy, kx * 1.45, ky * 1.6, radius, W, H);
        ctx.globalAlpha = striking ? 0.38 : 0.2;
        ctx.fillStyle = profile.color;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.beginPath();
      traceWrapped(ctx, PREDATOR_SHAPE, rx, ry, p.hx, p.hy, kx, ky, radius, W, H);
      ctx.fillStyle = striking ? profile.strikeColor : p.state === 'rest' ? profile.restColor : profile.color;
      ctx.fill();
      ctx.lineWidth = 1.25;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = striking ? profile.color : 'rgba(255, 236, 238, 0.85)';
      ctx.stroke();
    }
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} W
   * @param {number} H
   */
  drawPulses(ctx, W, H) {
    const offsets = this.offsets;
    for (const pulse of this.sim.pulses) {
      const r = pulse.radius;
      const fade = 1 - smoothstep(0.6 * PULSE.maxRadius, PULSE.maxRadius + PULSE.thickness, r);
      const a = Math.min(1, pulse.amplitude) * fade;
      if (a <= 0.01) continue;
      const width = 1 + 3 * (1 - r / (PULSE.maxRadius + PULSE.thickness));
      const count = wrapOffsets(pulse.x, pulse.y, r + width, W, H, offsets);
      ctx.beginPath();
      for (let k = 0; k < count; k++) {
        const cx = pulse.x + offsets[2 * k];
        const cy = pulse.y + offsets[2 * k + 1];
        ctx.moveTo(cx + r, cy);
        ctx.arc(cx, cy, r, 0, TAU);
      }
      ctx.lineWidth = width;
      ctx.strokeStyle = `rgba(214, 242, 255, ${(0.6 * a).toFixed(3)})`;
      ctx.stroke();
      ctx.fillStyle = `rgba(160, 220, 255, ${(0.06 * a).toFixed(3)})`;
      ctx.fill();
    }
  }

  /**
   * Catch flashes.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} W
   * @param {number} H
   */
  drawEffects(ctx, W, H) {
    const offsets = this.offsets;
    for (const e of this.sim.effects) {
      const t = e.age / e.duration;
      const r = lerp(4, 34, Math.sqrt(t));
      const count = wrapOffsets(e.x, e.y, r + 3, W, H, offsets);
      ctx.beginPath();
      for (let k = 0; k < count; k++) {
        const cx = e.x + offsets[2 * k];
        const cy = e.y + offsets[2 * k + 1];
        ctx.moveTo(cx + r, cy);
        ctx.arc(cx, cy, r, 0, TAU);
      }
      ctx.lineWidth = 2.5 * (1 - t) + 0.5;
      ctx.strokeStyle = `rgba(255, 90, 110, ${(0.9 * (1 - t)).toFixed(3)})`;
      ctx.stroke();
    }
  }

  /**
   * Touch beacons: attractors ripple inward (teal), repulsors ripple outward (orange).
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} time Seconds.
   */
  drawBeacons(ctx, time) {
    for (const b of this.sim.beacons.values()) {
      const a = b.level;
      if (a <= 0.01) continue;
      const attract = b.mode === 'attract';
      const rgb = attract ? '120, 255, 214' : '255, 140, 92';
      const reach = attract ? BEACON.orbitRadius : 0.18 * BEACON.repelRadius;
      ctx.beginPath();
      ctx.arc(b.x, b.y, 6, 0, TAU);
      ctx.fillStyle = `rgba(${rgb}, ${(0.6 * a).toFixed(3)})`;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(b.x, b.y, reach, 0, TAU);
      ctx.lineWidth = 1.75;
      ctx.strokeStyle = `rgba(${rgb}, ${(0.75 * a).toFixed(3)})`;
      ctx.stroke();
      for (let ring = 0; ring < 2; ring++) {
        const phase = (time * (attract ? 0.8 : 1.1) + ring * 0.5) % 1;
        const r = attract ? lerp(2.2 * reach, reach, phase) : lerp(reach, 3.4 * reach, phase);
        const ringAlpha = 0.5 * a * (attract ? phase : 1 - phase);
        ctx.beginPath();
        ctx.arc(b.x, b.y, r, 0, TAU);
        ctx.lineWidth = 1.25;
        ctx.strokeStyle = `rgba(${rgb}, ${ringAlpha.toFixed(3)})`;
        ctx.stroke();
      }
    }
  }

  /**
   * Debug overlay: spatial-hash lattice, sample radii, predator state.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} alpha
   * @param {number} W
   * @param {number} H
   */
  drawDebug(ctx, alpha, W, H) {
    const sim = this.sim;
    const grid = sim.grid;
    ctx.beginPath();
    for (let c = 1; c < grid.cols; c++) {
      const gx = c * grid.cellWidth;
      ctx.moveTo(gx, 0);
      ctx.lineTo(gx, H);
    }
    for (let r = 1; r < grid.rows; r++) {
      const gy = r * grid.cellHeight;
      ctx.moveTo(0, gy);
      ctx.lineTo(W, gy);
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(120, 180, 255, 0.12)';
    ctx.stroke();

    const prey = sim.prey;
    for (let s = 0; s < SPECIES_COUNT; s++) {
      let i = -1;
      for (let k = 0; k < prey.count; k++) {
        if (prey.species[k] === s) {
          i = k;
          break;
        }
      }
      if (i < 0) continue;
      const rt = sim.speciesRuntime[s];
      const rx = wrapCoord(prey.prevX[i] + wrapDelta(prey.x[i] - prey.prevX[i], W) * alpha, W);
      const ry = wrapCoord(prey.prevY[i] + wrapDelta(prey.y[i] - prey.prevY[i], H) * alpha, H);
      ctx.beginPath();
      ctx.arc(rx, ry, rt.perception, 0, TAU);
      ctx.strokeStyle = sim.species[s].color;
      ctx.globalAlpha = 0.5;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(rx, ry, rt.separationRadius[s], 0, TAU);
      ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    const PR = sim.predatorRuntime;
    let maxThreat = 0;
    for (const rt of sim.speciesRuntime) maxThreat = Math.max(maxThreat, rt.threatRadius);
    ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
    for (const p of sim.predators) {
      const rx = wrapCoord(p.prevX + wrapDelta(p.x - p.prevX, W) * alpha, W);
      const ry = wrapCoord(p.prevY + wrapDelta(p.y - p.prevY, H) * alpha, H);
      ctx.lineWidth = 1;
      for (const [radius, color] of /** @type {[number, string][]} */ ([
        [PR.huntRadius, 'rgba(255, 90, 110, 0.35)'],
        [maxThreat, 'rgba(255, 210, 90, 0.3)'],
        [PR.strikeRange, 'rgba(255, 255, 255, 0.45)'],
      ])) {
        ctx.beginPath();
        ctx.arc(rx, ry, radius, 0, TAU);
        ctx.strokeStyle = color;
        ctx.stroke();
      }
      if (p.target >= 0 && p.target < prey.count) {
        ctx.beginPath();
        ctx.moveTo(rx, ry);
        ctx.lineTo(rx + p.targetDx, ry + p.targetDy);
        ctx.strokeStyle = 'rgba(255, 90, 110, 0.8)';
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
      ctx.fillRect(rx + 22, ry - 22, 44, 5);
      ctx.fillStyle = p.stamina > 0.3 ? '#7dffb2' : '#ff8a5c';
      ctx.fillRect(rx + 22, ry - 22, 44 * p.stamina, 5);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.fillText(p.state, rx + 22, ry - 27);
    }
  }
}
