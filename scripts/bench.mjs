#!/usr/bin/env node
/**
 * Headless benchmark (no rendering): `npm run bench`.
 *
 *  1. Neighbour search alone, spatial hash vs naive all-pairs, at constant
 *     density. The hash grows linearly with N; the naive scan quadratically.
 *  2. Full simulation step at constant density (bigger world for more agents),
 *     with the ecosystem off (pure flocking, fixed populations) and on (food
 *     field, grazing, metabolism, births and deaths, at the default densities).
 *     µs per agent stays flat, i.e. O(N).
 *  3. Full step on a fixed phone-sized world (412 × 839 CSS px), where
 *     density rises with N. The K-nearest cap keeps per-agent work bounded.
 */
import { CONFIG_SCHEMA, createConfig } from '../src/config.js';
import { NeighborBuffer, ToroidalSpatialHash } from '../src/core/spatial-hash.js';
import { Random } from '../src/core/rng.js';
import { scaleForArea } from '../src/presets.js';
import { MAX_NEIGHBORS, Simulation } from '../src/sim/simulation.js';

const PHONE = { width: 412, height: 839 };
const PHONE_DENSITY = 300 / (PHONE.width * PHONE.height);

/**
 * Population split in the default ratio (160 : 40 : 100).
 * @param {number} n
 */
function mix(n) {
  const a = Math.round((n * 160) / 300);
  const b = Math.round((n * 40) / 300);
  return { countSpecies1: a, countSpecies2: b, countSpecies3: n - a - b };
}

/**
 * @param {() => void} fn
 * @param {number} minMs Run at least this long.
 * @returns {number} Mean ms per call.
 */
function time(fn, minMs = 400) {
  fn(); // warm-up
  let calls = 0;
  const start = performance.now();
  let now = start;
  while (now - start < minMs) {
    fn();
    calls++;
    now = performance.now();
  }
  return (now - start) / calls;
}

console.log('1) Neighbour search (radius 40 px, constant density, K = %d)', MAX_NEIGHBORS);
const searchRows = [];
for (const n of [500, 1000, 2000, 4000, 8000]) {
  const side = Math.sqrt(n / PHONE_DENSITY);
  const rng = new Random(n);
  const xs = Float64Array.from({ length: n }, () => rng.range(0, side));
  const ys = Float64Array.from({ length: n }, () => rng.range(0, side));
  const grid = new ToroidalSpatialHash();
  const buf = new NeighborBuffer(MAX_NEIGHBORS);
  const hashMs = time(() => {
    grid.configure(side, side, 20);
    grid.build(xs, ys, n);
    for (let i = 0; i < n; i++) grid.query(xs[i], ys[i], 40, i, buf);
  });
  const naiveMs =
    n > 4000
      ? NaN
      : time(() => {
          let found = 0;
          for (let i = 0; i < n; i++) {
            for (let j = 0; j < n; j++) {
              if (i === j) continue;
              let dx = xs[j] - xs[i];
              dx -= side * Math.round(dx / side);
              let dy = ys[j] - ys[i];
              dy -= side * Math.round(dy / side);
              if (dx * dx + dy * dy < 1600) found++;
            }
          }
          if (found < 0) console.log(found);
        });
  searchRows.push({
    agents: n,
    'spatial hash (ms)': hashMs.toFixed(3),
    'naive O(N²) (ms)': Number.isNaN(naiveMs) ? 'skipped' : naiveMs.toFixed(2),
    speedup: Number.isNaN(naiveMs) ? '' : `${(naiveMs / hashMs).toFixed(0)}×`,
  });
}
console.table(searchRows);

/**
 * Mean cost of one simulation step.
 * @param {number} n Prey.
 * @param {number} width
 * @param {number} height
 * @param {boolean} ecosystem Off: pure flocking with fixed populations. On:
 *   food and lifecycle, with capacity and food scaled to the world area like
 *   the app does (clamped to the config ranges).
 * @returns {{ agents: number, ms: number }}
 */
function stepCost(n, width, height, ecosystem) {
  const area = (width * height) / (PHONE.width * PHONE.height);
  const ecology = ecosystem
    ? scaleForArea(
        { carryingCapacity: CONFIG_SCHEMA.carryingCapacity.default, foodSpawnRate: CONFIG_SCHEMA.foodSpawnRate.default },
        area,
      )
    : {};
  const config = createConfig({ ...mix(n), ...ecology, ecosystem }, { warn: () => {} });
  const sim = new Simulation({ config, width, height, seed: 7 });
  for (let k = 0; k < 240; k++) sim.step(); // let schools form
  const ms = time(() => sim.step(), 600);
  return { agents: sim.prey.count, ms };
}

/**
 * @param {number} n
 * @param {number} width
 * @param {number} height
 */
function row(n, width, height) {
  const flocking = stepCost(n, width, height, false);
  const full = stepCost(n, width, height, true);
  return {
    agents: n,
    'flocking ms/step': flocking.ms.toFixed(3),
    'flocking µs/agent': ((flocking.ms * 1000) / flocking.agents).toFixed(2),
    'ecosystem ms/step': full.ms.toFixed(3),
    'ecosystem µs/agent': ((full.ms * 1000) / full.agents).toFixed(2),
  };
}

console.log('\n2) Full simulation step, constant density (world grows with N)');
console.table(
  [300, 1000, 2500, 5000].map((n) => {
    const scale = Math.sqrt(n / 300);
    return row(n, PHONE.width * scale, PHONE.height * scale);
  }),
);

console.log('\n3) Full simulation step, fixed phone-sized world (density grows with N)');
console.table([300, 600, 1000, 2000].map((n) => row(n, PHONE.width, PHONE.height)));
console.log('A 60 Hz frame has a 16.7 ms budget; phones run JavaScript roughly 2–6× slower than a desktop.');
