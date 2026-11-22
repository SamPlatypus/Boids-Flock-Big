import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wrapDelta, wrapCoord, torusDistanceSq, lerpWrapped } from '../src/core/torus.js';
import { Random } from '../src/core/rng.js';

const EPS = 1e-9;

test('wrapDelta returns the minimum image in [-L/2, L/2)', () => {
  const rng = new Random(7);
  for (let k = 0; k < 20000; k++) {
    const L = rng.range(1, 2000);
    const d = rng.range(-5 * L, 5 * L);
    const w = wrapDelta(d, L);
    assert.ok(w >= -L / 2 - EPS && w < L / 2 + EPS, `range: d=${d} L=${L} w=${w}`);
    // Same point on the circle: (d - w) is an integer multiple of L.
    const turns = (d - w) / L;
    assert.ok(Math.abs(turns - Math.round(turns)) < 1e-7, `equivalence: d=${d} L=${L}`);
    // Minimal: no other image is closer.
    assert.ok(Math.abs(w) <= Math.abs(w - L) + EPS && Math.abs(w) <= Math.abs(w + L) + EPS);
  }
});

test('wrapDelta matches the spec formula and handles exact halves', () => {
  assert.equal(wrapDelta(0, 100), 0);
  assert.equal(wrapDelta(30, 100), 30);
  assert.equal(wrapDelta(70, 100), -30);
  assert.equal(wrapDelta(-70, 100), 30);
  assert.equal(wrapDelta(50, 100), -50); // half-open interval
  assert.equal(wrapDelta(-50, 100), -50);
  assert.equal(wrapDelta(250, 100), -50);
});

test('wrapCoord maps into [0, L) including floating-point edge cases', () => {
  assert.equal(wrapCoord(0, 10), 0);
  assert.equal(wrapCoord(10, 10), 0);
  assert.equal(wrapCoord(-10, 10), 0);
  assert.equal(wrapCoord(12.5, 10), 2.5);
  assert.equal(wrapCoord(-2.5, 10), 7.5);
  assert.ok(Object.is(wrapCoord(-0, 10), 0), '-0 is normalised to +0');
  // -1e-17 + 400 rounds to exactly 400 in double precision; must fold to 0.
  const tiny = wrapCoord(-1e-17, 400);
  assert.ok(tiny >= 0 && tiny < 400, `tiny negative -> ${tiny}`);
  const rng = new Random(3);
  for (let k = 0; k < 20000; k++) {
    const L = rng.range(0.5, 3000);
    const v = rng.range(-10 * L, 10 * L);
    const w = wrapCoord(v, L);
    assert.ok(w >= 0 && w < L, `v=${v} L=${L} w=${w}`);
  }
});

test('torusDistanceSq is symmetric and never exceeds the half-diagonal', () => {
  const rng = new Random(11);
  const W = 390;
  const H = 844;
  const maxSq = (W / 2) ** 2 + (H / 2) ** 2;
  for (let k = 0; k < 5000; k++) {
    const ax = rng.range(0, W);
    const ay = rng.range(0, H);
    const bx = rng.range(0, W);
    const by = rng.range(0, H);
    const d1 = torusDistanceSq(ax, ay, bx, by, W, H);
    const d2 = torusDistanceSq(bx, by, ax, ay, W, H);
    assert.ok(Math.abs(d1 - d2) < 1e-6);
    assert.ok(d1 <= maxSq + 1e-6);
  }
  // Points on opposite sides of the seam are close.
  assert.ok(Math.abs(torusDistanceSq(1, 10, W - 1, 10, W, H) - 4) < 1e-9);
});

test('lerpWrapped takes the short way across the seam', () => {
  // From 98 to 2 on a period of 100: the short path crosses the seam (+4).
  assert.ok(Math.abs(lerpWrapped(98, 2, 0.5, 100) - 0) < 1e-9);
  assert.ok(Math.abs(lerpWrapped(98, 2, 0.25, 100) - 99) < 1e-9);
  assert.ok(Math.abs(lerpWrapped(10, 20, 0.5, 100) - 15) < 1e-9);
});
