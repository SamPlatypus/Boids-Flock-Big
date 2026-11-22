import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.js';
import { Simulation, FIXED_DT } from '../src/sim/simulation.js';
import { wrapDelta } from '../src/core/torus.js';

const W = 390;
const H = 844;
const dt = FIXED_DT;
const TOL = 1e-9;

/** @param {Record<string, unknown>} [overrides] */
function makeSim(overrides = {}, seed = 1, width = W, height = H) {
  const config = createConfig(overrides, { warn: () => {} });
  return new Simulation({ config, width, height, seed });
}

/**
 * Step once and assert the integrator invariants for every agent that existed
 * before and after the step (caught/respawned agents get a new id).
 * @param {Simulation} sim
 */
function stepChecked(sim) {
  const prey = sim.prey;
  /** @type {Map<number, [number, number]>} */
  const before = new Map();
  for (let i = 0; i < prey.count; i++) before.set(prey.id[i], [prey.vx[i], prey.vy[i]]);
  const predBefore = sim.predators.map((p) => ({ p, vx: p.vx, vy: p.vy }));

  sim.step(dt);

  for (let i = 0; i < prey.count; i++) {
    const vx = prey.vx[i];
    const vy = prey.vy[i];
    assert.ok(Number.isFinite(prey.x[i] + prey.y[i] + vx + vy), 'finite state');
    assert.ok(prey.x[i] >= 0 && prey.x[i] < sim.width && prey.y[i] >= 0 && prey.y[i] < sim.height, 'wrapped into the world');
    const speed = Math.hypot(vx, vy);
    assert.ok(speed <= prey.speedLimit[i] + TOL, `I1 |v|=${speed} > vmax=${prey.speedLimit[i]}`);
    const old = before.get(prey.id[i]);
    if (old) {
      const dv = Math.hypot(vx - old[0], vy - old[1]);
      assert.ok(dv <= prey.forceLimit[i] * dt + TOL, `I2 |dv|=${dv} > Fmax*dt=${prey.forceLimit[i] * dt}`);
    }
  }
  for (const { p, vx, vy } of predBefore) {
    if (!sim.predators.includes(p)) continue;
    const speed = Math.hypot(p.vx, p.vy);
    assert.ok(speed <= p.speedLimit + TOL, `predator speed ${speed} > ${p.speedLimit}`);
    const dv = Math.hypot(p.vx - vx, p.vy - vy);
    assert.ok(dv <= p.forceLimit * dt + TOL, `predator |dv|=${dv} > ${p.forceLimit * dt}`);
  }
}

test('maxSpeed and maxForce are never exceeded (defaults, with predators, taps and beacons)', () => {
  const sim = makeSim();
  for (let k = 0; k < 900; k++) {
    if (k === 100) sim.addPulse(200, 400);
    if (k === 200) sim.setBeacon(1, 100, 100);
    if (k > 200 && k < 400) sim.setBeacon(1, 100 + k, 100 + k / 2);
    if (k === 400) sim.releaseBeacon(1);
    if (k === 450) {
      sim.setBeacon('a', 50, 700);
      sim.setBeacon('b', 340, 700); // two pointers → both repel in auto mode
    }
    if (k === 600) {
      sim.releaseBeacon('a');
      sim.releaseBeacon('b');
    }
    stepChecked(sim);
  }
});

test('limits hold under extreme parameters and abrupt config changes', () => {
  const sim = makeSim({
    separationWeight: 5, alignmentWeight: 5, cohesionWeight: 5,
    maxSpeed: 500, maxForce: 3000, perceptionRadius: 200,
    panicRadius: 400, predatorSpeed: 600, predatorAggression: 1, predatorCount: 6,
  });
  for (let k = 0; k < 600; k++) {
    if (k === 150) sim.config.maxSpeed = 20; // speed cap collapses: agents must decelerate within F_max
    if (k === 250) sim.config.maxForce = 20; // turning becomes sluggish
    if (k === 350) sim.config.$set({ maxSpeed: 500, maxForce: 3000 });
    if (k === 400) sim.config.predatorSpeed = 20;
    if (k % 60 === 0) sim.addPulse((k * 37) % W, (k * 53) % H, 3);
    stepChecked(sim);
  }
});

test('the same seed and inputs reproduce a run exactly', () => {
  const a = makeSim({}, 1234);
  const b = makeSim({}, 1234);
  for (let k = 0; k < 300; k++) {
    if (k === 50) {
      a.addPulse(100, 100);
      b.addPulse(100, 100);
    }
    a.step(dt);
    b.step(dt);
  }
  assert.deepEqual(Array.from(a.prey.x.subarray(0, a.prey.count)), Array.from(b.prey.x.subarray(0, b.prey.count)));
  assert.deepEqual(Array.from(a.prey.vy.subarray(0, a.prey.count)), Array.from(b.prey.vy.subarray(0, b.prey.count)));
  assert.deepEqual(a.predators.map((p) => [p.x, p.y, p.state]), b.predators.map((p) => [p.x, p.y, p.state]));
});

test('populations follow the config, and removal keeps the pool consistent', () => {
  const sim = makeSim();
  assert.deepEqual(Array.from(sim.prey.countBySpecies), [160, 40, 100]);
  sim.config.$set({ countSpecies1: 10, countSpecies2: 75, countSpecies3: 0, predatorCount: 5 });
  sim.step(dt);
  assert.deepEqual(Array.from(sim.prey.countBySpecies), [10, 75, 0]);
  assert.equal(sim.prey.count, 85);
  assert.equal(sim.predators.length, 5);
  const tally = [0, 0, 0];
  const ids = new Set();
  for (let i = 0; i < sim.prey.count; i++) {
    tally[sim.prey.species[i]]++;
    ids.add(sim.prey.id[i]);
  }
  assert.deepEqual(tally, [10, 75, 0]);
  assert.equal(ids.size, sim.prey.count, 'ids stay unique after swap-removal');
  sim.config.countSpecies3 = 2500; // grows the pool past its initial capacity
  sim.config.predatorCount = 1;
  for (let k = 0; k < 5; k++) stepChecked(sim);
  assert.equal(sim.prey.countBySpecies[2], 2500);
  assert.equal(sim.predators.length, 1);
});

test('a tap pulse pushes nearby prey radially outward and alarms them', () => {
  const sim = makeSim({ countSpecies1: 0, countSpecies2: 0, countSpecies3: 0, predatorCount: 0 });
  sim.step(dt);
  const cx = 200;
  const cy = 400;
  // A ring of calm, stationary-ish foragers around the tap point.
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2;
    const i = sim.spawnPreyAt(2, cx + Math.cos(a) * 60, cy + Math.sin(a) * 60, a + Math.PI / 2, 20);
    sim.prey.wander[i] = 0;
  }
  sim.config.countSpecies3 = 24;
  sim.addPulse(cx, cy);
  for (let k = 0; k < 20; k++) sim.step(dt);
  let outward = 0;
  let alarmed = 0;
  for (let i = 0; i < sim.prey.count; i++) {
    const rx = wrapDelta(sim.prey.x[i] - cx, W);
    const ry = wrapDelta(sim.prey.y[i] - cy, H);
    const radialV = (rx * sim.prey.vx[i] + ry * sim.prey.vy[i]) / Math.hypot(rx, ry);
    if (radialV > 20) outward++;
    if (sim.prey.panic[i] > 0.3) alarmed++;
  }
  assert.ok(outward >= 20, `only ${outward}/24 moving outward`);
  assert.ok(alarmed >= 20, `only ${alarmed}/24 alarmed`);
});

/**
 * Mean toroidal distance of all prey to a point.
 * @param {Simulation} sim
 * @param {number} x
 * @param {number} y
 */
function meanDistance(sim, x, y) {
  let sum = 0;
  for (let i = 0; i < sim.prey.count; i++) {
    sum += Math.hypot(wrapDelta(sim.prey.x[i] - x, sim.width), wrapDelta(sim.prey.y[i] - y, sim.height));
  }
  return sum / sim.prey.count;
}

test('a held beacon attracts; two held beacons repel (auto mode)', () => {
  const sim = makeSim({ countSpecies1: 120, countSpecies2: 0, countSpecies3: 0, predatorCount: 0 }, 3, 500, 500);
  sim.step(dt);
  // Put everyone 80–200 px from the centre.
  for (let i = 0; i < sim.prey.count; i++) {
    const a = sim.rng.angle();
    const r = sim.rng.range(80, 200);
    sim.prey.x[i] = 250 + Math.cos(a) * r;
    sim.prey.y[i] = 250 + Math.sin(a) * r;
  }
  const start = meanDistance(sim, 250, 250);
  sim.setBeacon(7, 250, 250);
  for (let k = 0; k < 180; k++) sim.step(dt);
  const attracted = meanDistance(sim, 250, 250);
  assert.ok(attracted < start * 0.6, `attractor: mean distance ${start.toFixed(1)} → ${attracted.toFixed(1)}`);

  sim.setBeacon(8, 250, 250); // second finger: auto mode turns both into repulsors
  for (let k = 0; k < 120; k++) sim.step(dt);
  assert.equal(sim.beacons.get(7)?.mode, 'repel');
  const repelled = meanDistance(sim, 250, 250);
  assert.ok(repelled > attracted * 1.5, `repulsor: mean distance ${attracted.toFixed(1)} → ${repelled.toFixed(1)}`);

  sim.releaseBeacon(7);
  sim.releaseBeacon(8);
  for (let k = 0; k < 30; k++) sim.step(dt);
  assert.equal(sim.beacons.size, 0, 'released beacons fade out and are removed');
});

test('panic spreads through the school as a decaying wave, then subsides', () => {
  // A single file of dartfish 7 px apart, all swimming +x, in a world wide
  // enough that the line does not wrap onto itself.
  const sim = makeSim({ countSpecies1: 0, countSpecies2: 0, countSpecies3: 0, predatorCount: 0 }, 9, 2000, 300);
  sim.step(dt);
  const N = 60;
  sim.config.countSpecies1 = N;
  for (let k = 0; k < N; k++) {
    const i = sim.spawnPreyAt(0, 100 + k * 7, 150, 0, 80);
    sim.prey.wander[i] = 0;
  }
  sim.species[0].burstRate = 0;
  sim.species[0].wanderStrength = 0;
  /** first time each agent's panic exceeded 0.25 (by position in the file) */
  const arrival = new Array(N).fill(Infinity);
  let peakFar = 0;
  for (let k = 0; k < 240; k++) {
    // Startle the agent at the tail end for the first 6 steps.
    if (k < 6) {
      const tail = indexOfRank(sim, 0);
      sim.prey.panic[tail] = 1;
    }
    sim.step(dt);
    for (let r = 0; r < N; r++) {
      const i = indexOfRank(sim, r);
      if (sim.prey.panic[i] > 0.25 && arrival[r] === Infinity) arrival[r] = k;
      if (r === 15) peakFar = Math.max(peakFar, sim.prey.panic[i]);
    }
  }
  assert.ok(arrival[1] < arrival[8] && arrival[8] < arrival[15], `wave must travel: ${arrival.slice(0, 16).join(',')}`);
  assert.ok(peakFar > 0.25 && peakFar < 0.95, `wave decays with distance (peak at rank 15: ${peakFar})`);
  let maxPanic = 0;
  for (let i = 0; i < sim.prey.count; i++) maxPanic = Math.max(maxPanic, sim.prey.panic[i]);
  assert.ok(maxPanic < 0.05, `alarm subsides once the stimulus is gone (max ${maxPanic})`);
});

/**
 * Index of the agent with the r-th smallest id (stable rank in the file).
 * @param {Simulation} sim
 * @param {number} r
 */
function indexOfRank(sim, r) {
  const order = Array.from({ length: sim.prey.count }, (_, i) => i).sort((a, b) => sim.prey.id[a] - sim.prey.id[b]);
  return order[r];
}

test('neighbours interact across the seam (no edge effects)', () => {
  const sim = makeSim({ countSpecies1: 0, countSpecies2: 0, countSpecies3: 0, predatorCount: 0 }, 2, 300, 300);
  sim.step(dt);
  sim.config.countSpecies2 = 2;
  // Two mantas 6 px apart *through* the left/right seam, both heading up.
  const a = sim.spawnPreyAt(1, 2, 150, -Math.PI / 2, 60);
  const b = sim.spawnPreyAt(1, 296, 150, -Math.PI / 2, 60);
  sim.step(dt);
  // Separation must push a to +x and b to −x (away from each other across the seam).
  assert.ok(sim.prey.ax[a] > 0, `a pushed right (ax=${sim.prey.ax[a]})`);
  assert.ok(sim.prey.ax[b] < 0, `b pushed left (ax=${sim.prey.ax[b]})`);
  assert.equal(sim.prey.crowding[a], 1);
  assert.equal(sim.prey.crowding[b], 1);
});

test('resize scales positions proportionally and keeps them in the world', () => {
  const sim = makeSim();
  for (let k = 0; k < 10; k++) sim.step(dt);
  const x0 = sim.prey.x[5] / W;
  const y0 = sim.prey.y[5] / H;
  sim.resize(844, 390); // rotate to landscape
  assert.ok(Math.abs(sim.prey.x[5] / 844 - x0) < 1e-9 && Math.abs(sim.prey.y[5] / 390 - y0) < 1e-9);
  for (let k = 0; k < 60; k++) stepChecked(sim);
});
