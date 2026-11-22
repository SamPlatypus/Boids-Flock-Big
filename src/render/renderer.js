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
 * - Food is a pre-rendered glow sprite blitted without rotation.
 * - Nothing is allocated per agent per frame.
 * - The vignette is the canvas element's CSS background, updated only when
 *   the colour or size changes. The browser composites it every frame for
 *   free, and a frame starts with clearRect. Filling the full-screen radial
 *   gradient into the canvas every frame cost a 4× CPU-throttled phone
 *   emulation about two thirds of its frame rate (60 → 20 fps), because
 *   wherever canvas pixels are drawn by the CPU the gradient is re-evaluated
 *   for every pixel of every frame.
 *
 * Correctness:
 * - Positions are interpolated between the last two physics steps along the
 *   shortest toroidal path, so motion is smooth at 60/90/120 Hz with a fixed
 *   60 Hz simulation, and nothing streaks across the screen when wrapping.
 * - Shadow rendering: anything overlapping an edge is also drawn at its
 *   wrapped image(s), so agents slide across seams instead of popping.
 *
 * Theming: every colour derives from the six config colours (background,
 * three species, predator, food). Panic tints, strike / rest shades and UI
 * glows are mixed from them, so any custom palette stays coherent.
 *
 * Trails: with `config.trails` > 0 the frame is not cleared. The flat
 * background colour is painted translucently instead (alpha = 1 −
 * trails^(dt·60), frame-rate independent), so earlier frames fade into
 * glowing wakes and the canvas turns opaque, covering the vignette. (Additive
 * agent blending was tried and rejected: overlapping copies saturate to white
 * and species lose their colour.) Measured in Chromium, repeated translucent
 * *gradient* fills stall a few levels above their target (shader dithering),
 * and so do 'destination-out' fades towards transparency. Both leave ghost
 * trails burned into dark backgrounds, while flat source-over fills converge
 * exactly. So the vignette shows only when trails are off.
 *
 * @module render/renderer
 */

import { lerp, smoothstep } from '../core/math.js';
import { hexToRgb, mixHex, rgba, scaleHex } from '../core/color.js';
import { wrapCoord, wrapDelta } from '../core/torus.js';
import { BEACON, PULSE } from '../sim/interactions.js';
import { FOOD } from '../sim/food.js';
import { SPECIES_COUNT } from '../sim/species.js';
import { PREDATOR_SHAPE, SPECIES_SHAPES, shapeRadius } from './shapes.js';

/** @typedef {import('../sim/simulation.js').Simulation} Simulation */
/** @typedef {import('../sim/simulation.js').Effect} Effect */
/** @typedef {import('../config.js').SimConfig} SimConfig */
/** @typedef {import('./surface.js').CanvasSurface} CanvasSurface */

const PANIC_LEVELS = 4;
/** Fraction of the alarm tint mixed in at each panic level. */
const PANIC_TINT = [0, 0.38, 0.68, 1];
/** Seconds for a newborn agent to grow to full size. */
const GROW_TIME = 0.6;
/** Glow radius of a food particle (CSS px). */
const FOOD_GLOW = 7;
/** Seconds between slightly stronger fades: insurance against blend-rounding stalls on other GPUs. */
const TRAIL_CLEANUP_INTERVAL = 0.4;
const TRAIL_CLEANUP_ALPHA = 0.16;
/**
 * Seconds after trails are switched on before the background is sealed. By
 * then the crossfade from the vignette is visually complete (≥ 99.8 % at the
 * strongest trails), but blend rounding stalls the transparent pixels below
 * their target: alpha at about 253/255 and colour a few levels under the
 * background, which would leave the paths agents took (where pixels converged
 * from above, exactly) visible as a faint map forever.
 */
const TRAIL_SEAL_DELAY = 2;
const TAU = Math.PI * 2;

/**
 * @param {number} p Panic ∈ [0, 1].
 * @returns {number} Bucket 0..3.
 */
function panicLevel(p) {
  return p < 0.15 ? 0 : p < 0.4 ? 1 : p < 0.7 ? 2 : 3;
}

/**
 * @param {string} hex
 * @returns {string} 'r, g, b' for building rgba() strings.
 */
function rgbList(hex) {
  return hexToRgb(hex).join(', ');
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

/** Every drawing colour, derived from the six theme colours of the config. */
class Theme {
  constructor() {
    this.key = '';
    this.background = '#000000';
    /** Fill per (species, panic level) bucket. */
    this.bucket = new Array(SPECIES_COUNT * PANIC_LEVELS).fill('#ffffff');
    this.species = new Array(SPECIES_COUNT).fill('#ffffff');
    this.predator = '#ffffff';
    this.predatorStrike = '#ffffff';
    this.predatorRest = '#ffffff';
    this.predatorOutline = '#ffffff';
    this.food = '#ffffff';
    /** 'r, g, b' strings for translucent strokes. */
    this.pulseRgb = '255, 255, 255';
    this.attractRgb = '255, 255, 255';
    this.repelRgb = '255, 255, 255';
    this.speciesRgb = new Array(SPECIES_COUNT).fill('255, 255, 255');
    this.predatorRgb = '255, 255, 255';
    this.starveRgb = new Array(SPECIES_COUNT).fill('255, 255, 255');
  }

  /**
   * @param {SimConfig} config
   * @returns {boolean} Whether anything changed.
   */
  update(config) {
    const species = [config.colorSpecies1, config.colorSpecies2, config.colorSpecies3];
    const key = [config.colorBackground, ...species, config.colorPredator, config.colorFood].join();
    if (key === this.key) return false;
    this.key = key;
    const bg = config.colorBackground;
    this.background = bg;
    for (let s = 0; s < SPECIES_COUNT; s++) {
      const base = species[s];
      const alarm = mixHex(base, '#ffffff', 0.85);
      this.species[s] = base;
      this.speciesRgb[s] = rgbList(base);
      this.starveRgb[s] = rgbList(mixHex(base, bg, 0.5));
      for (let l = 0; l < PANIC_LEVELS; l++) this.bucket[s * PANIC_LEVELS + l] = mixHex(base, alarm, PANIC_TINT[l]);
    }
    const pred = config.colorPredator;
    this.predator = pred;
    this.predatorRgb = rgbList(pred);
    this.predatorStrike = mixHex(pred, '#ffffff', 0.88);
    this.predatorRest = mixHex(pred, bg, 0.45);
    this.predatorOutline = rgba(mixHex(pred, '#ffffff', 0.8), 0.85);
    this.food = config.colorFood;
    this.pulseRgb = rgbList(mixHex(species[0], '#ffffff', 0.7));
    this.attractRgb = rgbList(mixHex(species[0], '#ffffff', 0.25));
    this.repelRgb = rgbList(mixHex(pred, '#ffffff', 0.2));
    return true;
  }
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
    this.theme = new Theme();
    const buckets = SPECIES_COUNT * PANIC_LEVELS;
    this.bucketStart = new Int32Array(buckets + 1);
    this.bucketCursor = new Int32Array(buckets);
    this.bucketOf = new Int32Array(0);
    this.bucketItems = new Int32Array(0);
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
    /** Colour and size the CSS vignette behind the canvas was last built for. */
    this.backdropKey = '';
    /** @type {HTMLCanvasElement | null} */
    this.foodSprite = null;
    this.foodSpriteKey = '';
    this.lastTime = -1;
    this.cleanupClock = 0;
    /** Seconds since trails were switched on (−1: off). Sealed once ≥ TRAIL_SEAL_DELAY. */
    this.trailsAge = -1;
    /** Backing-store size of the last painted frame (a resize clears the canvas). */
    this.paintedWidth = -1;
    this.paintedHeight = -1;
  }

  /**
   * Draw one frame.
   * @param {number} alpha Interpolation factor ∈ [0, 1) between the last two steps.
   * @param {number} timeMs Frame timestamp (animations and trail fading).
   */
  render(alpha, timeMs) {
    const { ctx, scaleX, scaleY, canvas } = this.surface;
    const W = this.sim.width;
    const H = this.sim.height;
    const frameDt = this.lastTime < 0 ? 1 / 60 : Math.min(0.1, Math.max(0, (timeMs - this.lastTime) / 1000));
    this.lastTime = timeMs;
    this.theme.update(this.config);
    ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);
    const fresh = canvas.width !== this.paintedWidth || canvas.height !== this.paintedHeight;
    this.paintedWidth = canvas.width;
    this.paintedHeight = canvas.height;
    this.drawBackground(ctx, W, H, fresh ? 0 : frameDt, fresh);
    this.drawFood(ctx, W, H, timeMs / 1000);
    this.drawPulses(ctx, W, H);
    this.drawPrey(ctx, alpha, W, H);
    this.drawPredators(ctx, alpha, W, H);
    this.drawEffects(ctx, W, H);
    this.drawBeacons(ctx, timeMs / 1000);
    if (this.config.debug) this.drawDebug(ctx, alpha, W, H);
  }

  /**
   * Start a frame: clear to the CSS vignette behind the canvas or, with
   * trails, fade the previous frame towards the flat background colour.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} W
   * @param {number} H
   * @param {number} frameDt
   * @param {boolean} fresh The canvas was just cleared (first frame / resize).
   */
  drawBackground(ctx, W, H, frameDt, fresh) {
    const bg = this.theme.background;
    this.updateBackdrop(bg, W, H);
    const trails = this.config.trails;
    if (trails <= 0) {
      ctx.clearRect(0, 0, W, H);
      this.trailsAge = -1;
      return;
    }
    if (fresh) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);
      this.trailsAge = TRAIL_SEAL_DELAY;
      return;
    }
    if (this.trailsAge < TRAIL_SEAL_DELAY) {
      // Just switched on: the translucent fills below also fade out the
      // vignette, as transparent pixels gain opacity. Once that is complete,
      // seal: an opaque 'lighten' fill makes every pixel opaque and lifts any
      // channel that stalled below the background to exactly the background,
      // while brighter trail pixels keep their colour.
      this.trailsAge = Math.max(0, this.trailsAge) + frameDt;
      if (this.trailsAge >= TRAIL_SEAL_DELAY) {
        ctx.globalCompositeOperation = 'lighten';
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, W, H);
        ctx.globalCompositeOperation = 'source-over';
      }
    }
    let alpha = 1 - Math.pow(trails, frameDt * 60);
    this.cleanupClock += frameDt;
    if (this.cleanupClock >= TRAIL_CLEANUP_INTERVAL) {
      this.cleanupClock = 0;
      alpha = Math.max(alpha, TRAIL_CLEANUP_ALPHA);
    }
    if (alpha <= 0) return;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = bg; // flat: converges exactly (see module notes)
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 1;
  }

  /**
   * Keep the vignette behind the canvas (its CSS background) in step with the
   * background colour and the world size.
   * @param {string} bg
   * @param {number} W
   * @param {number} H
   */
  updateBackdrop(bg, W, H) {
    const key = `${bg}|${W}|${H}`;
    if (key === this.backdropKey) return;
    this.backdropKey = key;
    const r = Math.round(Math.max(W, H) * 0.8);
    const style = this.surface.canvas.style;
    style.backgroundColor = bg;
    // Multiplicative shading: pure black stays black (OLED palettes).
    style.backgroundImage =
      `radial-gradient(circle ${r}px at 50% 42%, ${scaleHex(bg, 1.7)} 0px, ` +
      `${bg} ${Math.round(r * 0.55)}px, ${scaleHex(bg, 0.5)} ${r}px)`;
  }

  /**
   * Glow sprite for food, rendered at device resolution for the current colour.
   * @returns {HTMLCanvasElement}
   */
  getFoodSprite() {
    const scale = this.surface.scaleX;
    const key = `${this.theme.food}|${scale}`;
    if (this.foodSprite && key === this.foodSpriteKey) return this.foodSprite;
    const size = Math.max(4, Math.ceil(2 * FOOD_GLOW * scale));
    const sprite = this.foodSprite ?? document.createElement('canvas');
    sprite.width = size;
    sprite.height = size;
    const g = /** @type {CanvasRenderingContext2D} */ (sprite.getContext('2d'));
    const r = size / 2;
    const gradient = g.createRadialGradient(r, r, 0, r, r, r);
    const color = this.theme.food;
    gradient.addColorStop(0, rgba(mixHex(color, '#ffffff', 0.5), 1));
    gradient.addColorStop(0.2, rgba(color, 0.95));
    gradient.addColorStop(0.45, rgba(color, 0.32));
    gradient.addColorStop(1, rgba(color, 0));
    g.clearRect(0, 0, size, size);
    g.fillStyle = gradient;
    g.fillRect(0, 0, size, size);
    this.foodSprite = sprite;
    this.foodSpriteKey = key;
    return sprite;
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} W
   * @param {number} H
   * @param {number} time Seconds (twinkle).
   */
  drawFood(ctx, W, H, time) {
    const food = this.sim.food;
    if (food.count === 0) return;
    const sprite = this.getFoodSprite();
    const { x, y, age, life, phase, eaten } = food;
    for (let i = 0; i < food.count; i++) {
      if (eaten[i]) continue;
      let k = age[i] < FOOD.growTime ? smoothstep(0, FOOD.growTime, age[i]) : 1;
      const left = life[i] - age[i];
      if (left < FOOD.fadeTime) k *= smoothstep(0, FOOD.fadeTime, left);
      k *= 1 + 0.16 * Math.sin(time * 2.4 + phase[i]);
      if (k <= 0.02) continue;
      const r = FOOD_GLOW * k;
      const fx = x[i];
      const fy = y[i];
      ctx.drawImage(sprite, fx - r, fy - r, 2 * r, 2 * r);
      if (fx < r || fx > W - r || fy < r || fy > H - r) {
        const count = wrapOffsets(fx, fy, r, W, H, this.offsets);
        for (let k2 = 1; k2 < count; k2++) {
          ctx.drawImage(sprite, fx + this.offsets[2 * k2] - r, fy + this.offsets[2 * k2 + 1] - r, 2 * r, 2 * r);
        }
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
    const palette = this.theme.bucket;
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
      ctx.fillStyle = palette[b];
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
    const theme = this.theme;
    const length = this.sim.predatorProfile.length;
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
        ctx.fillStyle = theme.predator;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.beginPath();
      traceWrapped(ctx, PREDATOR_SHAPE, rx, ry, p.hx, p.hy, kx, ky, radius, W, H);
      ctx.fillStyle = striking ? theme.predatorStrike : p.state === 'rest' ? theme.predatorRest : theme.predator;
      ctx.fill();
      ctx.lineWidth = 1.25;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = striking ? theme.predator : theme.predatorOutline;
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
      ctx.strokeStyle = `rgba(${this.theme.pulseRgb}, ${(0.6 * a).toFixed(3)})`;
      ctx.stroke();
      ctx.fillStyle = `rgba(${this.theme.pulseRgb}, ${(0.05 * a).toFixed(3)})`;
      ctx.fill();
    }
  }

  /**
   * Catch flashes, births, starvations.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} W
   * @param {number} H
   */
  drawEffects(ctx, W, H) {
    const offsets = this.offsets;
    const theme = this.theme;
    for (const e of this.sim.effects) {
      const t = e.age / e.duration;
      const fade = 1 - t;
      let r;
      let rgb;
      let opacity;
      let width;
      let filled = false;
      switch (e.kind) {
        case 'catch':
          r = lerp(4, 34, Math.sqrt(t));
          rgb = theme.predatorRgb;
          opacity = 0.9 * fade;
          width = 2.5 * fade + 0.5;
          break;
        case 'birth':
          r = lerp(2, 13, Math.sqrt(t));
          rgb = theme.speciesRgb[e.species];
          opacity = 0.75 * fade;
          width = 1.2;
          break;
        case 'starve':
          r = 4 * fade + 0.5;
          rgb = theme.starveRgb[e.species];
          opacity = 0.7 * fade;
          width = 0;
          filled = true;
          break;
        case 'predatorBirth':
          r = lerp(8, 46, Math.sqrt(t));
          rgb = theme.predatorRgb;
          opacity = 0.7 * fade;
          width = 2;
          break;
        default: // predatorStarve: implodes
          r = lerp(26, 4, t);
          rgb = theme.predatorRgb;
          opacity = 0.55 * fade;
          width = 1.5;
          break;
      }
      const count = wrapOffsets(e.x, e.y, r + width, W, H, offsets);
      ctx.beginPath();
      for (let k = 0; k < count; k++) {
        const cx = e.x + offsets[2 * k];
        const cy = e.y + offsets[2 * k + 1];
        ctx.moveTo(cx + r, cy);
        ctx.arc(cx, cy, r, 0, TAU);
      }
      const style = `rgba(${rgb}, ${opacity.toFixed(3)})`;
      if (filled) {
        ctx.fillStyle = style;
        ctx.fill();
      } else {
        ctx.lineWidth = width;
        ctx.strokeStyle = style;
        ctx.stroke();
      }
    }
  }

  /**
   * Touch beacons: attractors ripple inward, repulsors ripple outward.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} time Seconds.
   */
  drawBeacons(ctx, time) {
    for (const b of this.sim.beacons.values()) {
      const a = b.level;
      if (a <= 0.01) continue;
      const attract = b.mode === 'attract';
      const rgb = attract ? this.theme.attractRgb : this.theme.repelRgb;
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
      ctx.arc(rx, ry, rt.perception * prey.genePerception[i], 0, TAU);
      ctx.strokeStyle = this.theme.species[s];
      ctx.globalAlpha = 0.5;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(rx, ry, rt.separationRadius[s], 0, TAU);
      ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      // Energy bar.
      ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
      ctx.fillRect(rx - 10, ry + 10, 20, 3);
      ctx.fillStyle = this.theme.species[s];
      ctx.fillRect(rx - 10, ry + 10, 20 * prey.energy[i], 3);
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
      // Stamina (top) and energy (bottom) bars.
      ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
      ctx.fillRect(rx + 22, ry - 22, 44, 9);
      ctx.fillStyle = p.stamina > 0.3 ? '#7dffb2' : '#ff8a5c';
      ctx.fillRect(rx + 22, ry - 22, 44 * p.stamina, 4);
      ctx.fillStyle = '#ffd166';
      ctx.fillRect(rx + 22, ry - 17, 44 * Math.min(1, p.energy), 4);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.fillText(p.state, rx + 22, ry - 27);
    }
  }
}
