import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToroidalSpatialHash, NeighborBuffer } from '../src/core/spatial-hash.js';
import { wrapDelta } from '../src/core/torus.js';
import { Random } from '../src/core/rng.js';

/**
 * @param {Random} rng
 * @param {number} n
 * @param {number} W
 * @param {number} H
 */
function randomPoints(rng, n, W, H) {
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = rng.range(0, W);
    ys[i] = rng.range(0, H);
  }
  return { xs, ys };
}

/** Brute-force O(N) reference for one query. */
function bruteForce(xs, ys, n, x, y, r, exclude, W, H) {
  const result = new Map();
  for (let j = 0; j < n; j++) {
    if (j === exclude) continue;
    const dx = wrapDelta(xs[j] - x, W);
    const dy = wrapDelta(ys[j] - y, H);
    const d2 = dx * dx + dy * dy;
    if (d2 < r * r) result.set(j, { dx, dy, d2 });
  }
  return result;
}

const CASES = [
  // [W, H, cellSize, radius, n]
  [390, 844, 40, 40, 400], // phone portrait, radius == cell
  [1920, 1080, 35, 82, 1500], // query spans several cells
  [333.3, 211.7, 27, 30, 300], // sizes that do not divide evenly
  [100, 100, 40, 70, 150], // radius > W/2: wrap-around must not duplicate
  [50, 400, 20, 120, 200], // radius > W: whole axis covered
  [64, 64, 64, 10, 100], // single cell
  [1000, 30, 25, 18, 300], // very thin world
];

test('radius queries match brute force on a torus (no misses, no duplicates)', () => {
  const rng = new Random(42);
  for (const [W, H, cell, r, n] of CASES) {
    const { xs, ys } = randomPoints(rng, n, W, H);
    const grid = new ToroidalSpatialHash();
    grid.configure(W, H, cell);
    grid.build(xs, ys, n);
    const buf = new NeighborBuffer(n); // large enough: no truncation
    for (let q = 0; q < 200; q++) {
      const useAgent = q % 2 === 0;
      const exclude = useAgent ? rng.int(n) : -1;
      const x = useAgent ? xs[exclude] : rng.range(0, W);
      const y = useAgent ? ys[exclude] : rng.range(0, H);
      const count = grid.query(x, y, r, exclude, buf);
      const expected = bruteForce(xs, ys, n, x, y, r, exclude, W, H);
      assert.equal(count, expected.size, `count mismatch W=${W} H=${H} r=${r}`);
      const seen = new Set();
      for (let k = 0; k < count; k++) {
        const j = buf.index[k];
        assert.ok(!seen.has(j), `duplicate neighbour ${j}`);
        seen.add(j);
        const e = expected.get(j);
        assert.ok(e, `unexpected neighbour ${j}`);
        assert.ok(Math.abs(e.dx - buf.dx[k]) < 1e-9 && Math.abs(e.dy - buf.dy[k]) < 1e-9);
        assert.ok(Math.abs(e.d2 - buf.distSq[k]) < 1e-9);
      }
    }
  }
});

test('a full buffer keeps exactly the nearest neighbours', () => {
  const rng = new Random(5);
  const W = 500;
  const H = 500;
  const n = 2000;
  const { xs, ys } = randomPoints(rng, n, W, H);
  const grid = new ToroidalSpatialHash();
  grid.configure(W, H, 50);
  grid.build(xs, ys, n);
  const cap = 16;
  const small = new NeighborBuffer(cap);
  for (let q = 0; q < 50; q++) {
    const x = rng.range(0, W);
    const y = rng.range(0, H);
    const r = 80;
    const count = grid.query(x, y, r, -1, small);
    const all = [...bruteForce(xs, ys, n, x, y, r, -1, W, H).values()].map((e) => e.d2).sort((a, b) => a - b);
    assert.equal(count, Math.min(cap, all.length));
    const kept = Array.from(small.distSq.subarray(0, count)).sort((a, b) => a - b);
    assert.deepEqual(kept, all.slice(0, count));
  }
});

test('handles empty grids and points exactly on the far edge', () => {
  const grid = new ToroidalSpatialHash();
  grid.configure(100, 100, 10);
  grid.build(new Float64Array(0), new Float64Array(0), 0);
  const buf = new NeighborBuffer(8);
  assert.equal(grid.query(50, 50, 30, -1, buf), 0);

  // A coordinate a hair below W must still land in the last cell.
  const xs = new Float64Array([100 - 1e-13, 0.5]);
  const ys = new Float64Array([50, 50]);
  grid.build(xs, ys, 2);
  assert.equal(grid.query(0.25, 50, 2, -1, buf), 2, 'both points straddle the seam');
});

test('candidate checks grow linearly with N at constant density (O(N), not O(N²))', () => {
  const rng = new Random(9);
  const density = 1 / 1100; // agents per px² (≈ 300 agents on a phone screen)
  const radius = 45;
  /** @type {number[]} */
  const perAgent = [];
  for (const n of [500, 2000, 8000]) {
    const side = Math.sqrt(n / density);
    const { xs, ys } = randomPoints(rng, n, side, side);
    const grid = new ToroidalSpatialHash();
    grid.configure(side, side, radius);
    grid.build(xs, ys, n);
    const buf = new NeighborBuffer(64);
    grid.candidatesChecked = 0;
    for (let i = 0; i < n; i++) grid.query(xs[i], ys[i], radius, i, buf);
    perAgent.push(grid.candidatesChecked / n);
  }
  // Work per agent must stay flat (within noise) while N grows 16x.
  const ratio = perAgent[2] / perAgent[0];
  assert.ok(ratio > 0.8 && ratio < 1.25, `per-agent work drifted: ${perAgent.join(', ')}`);
  // And it is a tiny fraction of the naive N - 1 comparisons.
  assert.ok(perAgent[2] < 30, `too many candidates per agent: ${perAgent[2]}`);
});
