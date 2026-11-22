import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.js';
import { Simulation, FIXED_DT } from '../src/sim/simulation.js';
import { interceptTime } from '../src/sim/predator.js';
import { Random } from '../src/core/rng.js';

const dt = FIXED_DT;

test('interceptTime solves |r + v·t| = s·t for the earliest meeting', () => {
  // Stationary target: t = d / s.
  assert.ok(Math.abs(interceptTime(100, 0, 0, 0, 50, 10) - 2) < 1e-9);
  // Target fleeing straight away at 30 from 100 ahead, pursuer at 50: closes at 20.
  assert.ok(Math.abs(interceptTime(100, 0, 30, 0, 50, 10) - 5) < 1e-9);
  // Target coming head-on at 30: closes at 80.
  assert.ok(Math.abs(interceptTime(100, 0, -30, 0, 50, 10) - 1.25) < 1e-9);
  // Equal speeds (linear case a = 0), target approaching obliquely: t = 10000 / 6000.
  const t = interceptTime(100, 0, -30, 40, 50, 10);
  assert.ok(Math.abs(t - 10000 / 6000) < 1e-9);
  assert.ok(Math.abs(Math.hypot(100 - 30 * t, 40 * t) - 50 * t) < 1e-9);
  // Equal speeds, target crossing at right angles: never reachable → |r| / s.
  assert.ok(Math.abs(interceptTime(100, 0, 0, 50, 50, 10) - 2) < 1e-9);
  // Faster target receding: no solution → Reynolds estimate |r| / s.
  assert.ok(Math.abs(interceptTime(100, 0, 80, 0, 50, 10) - 2) < 1e-9);
  // Capped look-ahead.
  assert.equal(interceptTime(1e6, 0, 0, 0, 1, 1.5), 1.5);

  // Property: uncapped, a faster pursuer always has an exact solution:
  // the aim point is exactly reachable at speed s in time t.
  const rng = new Random(4);
  for (let k = 0; k < 2000; k++) {
    const rx = rng.range(-300, 300);
    const ry = rng.range(-300, 300);
    const vx = rng.range(-100, 100);
    const vy = rng.range(-100, 100);
    const s = rng.range(Math.hypot(vx, vy) + 1, 400);
    const tt = interceptTime(rx, ry, vx, vy, s, Infinity);
    assert.ok(tt > 0);
    const miss = Math.hypot(rx + vx * tt, ry + vy * tt) - s * tt;
    assert.ok(Math.abs(miss) < 1e-6 * Math.max(1, s * tt), `miss ${miss}`);
  }
});

/** @param {Record<string, unknown>} overrides */
function huntScenario(overrides) {
  const config = createConfig(
    { countSpecies1: 0, countSpecies2: 0, countSpecies3: 0, predatorCount: 1, ...overrides },
    { warn: () => {} },
  );
  // No warm-up step: the constructor already spawned everyone, and stepping
  // here could start a hunt before the test positions the agents.
  const sim = new Simulation({ config, width: 800, height: 800, seed: 21 });
  const p = sim.predators[0];
  p.x = 300;
  p.y = 400;
  p.vx = 80;
  p.vy = 0;
  p.stamina = 1;
  return { sim, config, p };
}

test('predator cycles patrol → pursue → strike → catch → rest → patrol', () => {
  // Fixed populations: a catch respawns the prey elsewhere.
  const { sim, config, p } = huntScenario({ countSpecies2: 1, predatorAggression: 1, ecosystem: false });
  // A lone manta ahead of the predator (isolated, slow: the ideal target).
  const m = 0;
  sim.prey.x[m] = 420;
  sim.prey.y[m] = 400;
  config.countSpecies2 = 1;

  /** @type {string[]} */
  const states = ['patrol'];
  /** @type {{ prey: number }[]} */
  const catches = [];
  sim.on('predatorState', (e) => states.push(e.to));
  sim.on('catch', (e) => catches.push(e));
  let minPursuitStamina = 1;
  for (let k = 0; k < 60 * 30 && states.at(-1) !== 'patrol' || k < 10; k++) {
    sim.step(dt);
    if (p.state === 'pursue') minPursuitStamina = Math.min(minPursuitStamina, p.stamina);
    if (states.length > 12) break;
  }
  assert.deepEqual(states.slice(0, 3), ['patrol', 'pursue', 'strike']);
  assert.ok(catches.length >= 1, `expected a catch, states: ${states.join(' → ')}`);
  assert.ok(states.includes('rest'), 'rests after the catch');
  assert.equal(states.at(-1), 'patrol', 'recovers and patrols again');
  assert.ok(minPursuitStamina < 1, 'pursuit costs stamina');
  assert.ok(p.stamina >= sim.predatorRuntime.recoverThreshold - 1e-9, 'stamina recovered before patrolling');
  assert.equal(sim.prey.count, 1, 'caught prey respawns: population is preserved');
  assert.notEqual(sim.prey.id[0], 1, 'respawned prey is a new individual');
});

test('an exhausted predator gives up and rests instead of chasing forever', () => {
  const { sim, config, p } = huntScenario({ countSpecies1: 1, predatorAggression: 0.5 });
  // A dartfish is faster and far more agile than the predator.
  config.countSpecies1 = 1;
  sim.prey.x[0] = 400;
  sim.prey.y[0] = 400;
  /** @type {string[]} */
  const states = [];
  sim.on('predatorState', (e) => states.push(e.to));
  let maxHunt = 0;
  for (let k = 0; k < 60 * 40; k++) {
    sim.step(dt);
    maxHunt = Math.max(maxHunt, p.huntTime);
  }
  assert.ok(states.includes('pursue'), 'hunts');
  assert.ok(states.includes('rest'), `rests (${states.join(' → ')})`);
  assert.ok(maxHunt <= sim.predatorRuntime.giveUpTime + 1, `hunt length bounded (${maxHunt.toFixed(2)} s)`);
});

test('prey flee from an approaching predator', () => {
  const { sim, config, p } = huntScenario({ countSpecies3: 30, predatorCount: 1 });
  config.countSpecies3 = 30;
  sim.step(dt);
  p.x = 400;
  p.y = 400;
  p.state = 'pursue';
  // Place foragers 60–100 px around the predator.
  for (let i = 0; i < sim.prey.count; i++) {
    const a = (i / sim.prey.count) * Math.PI * 2;
    sim.prey.x[i] = 400 + Math.cos(a) * 80;
    sim.prey.y[i] = 400 + Math.sin(a) * 80;
  }
  const dist = () => {
    let sum = 0;
    for (let i = 0; i < sim.prey.count; i++) sum += Math.hypot(sim.prey.x[i] - p.x, sim.prey.y[i] - p.y);
    return sum / sim.prey.count;
  };
  const before = dist();
  p.speedLimit = 0; // freeze the predator in place so only prey motion counts
  for (let k = 0; k < 40; k++) {
    sim.step(dt);
    p.vx = 0;
    p.vy = 0;
    p.x = 400;
    p.y = 400;
  }
  assert.ok(dist() > before + 40, `mean distance ${before.toFixed(0)} → ${dist().toFixed(0)}`);
  let panicked = 0;
  for (let i = 0; i < sim.prey.count; i++) if (sim.prey.panic[i] > 0.3) panicked++;
  assert.ok(panicked > sim.prey.count * 0.8, `panicked ${panicked}/${sim.prey.count}`);
});

test('a predator drops a target that was removed from the pool', () => {
  const { sim, config, p } = huntScenario({ countSpecies2: 3, predatorAggression: 1 });
  config.countSpecies2 = 3;
  sim.step(dt);
  for (let i = 0; i < 3; i++) {
    sim.prey.x[i] = 360 + i * 40;
    sim.prey.y[i] = 400;
  }
  for (let k = 0; k < 30 && p.state !== 'pursue'; k++) sim.step(dt);
  assert.equal(p.state, 'pursue');
  const targetId = p.targetId;
  // Remove the targeted individual; another agent moves into its slot.
  config.countSpecies2 = 2;
  const idx = p.target;
  sim.prey.removeAt(idx);
  sim.step(dt);
  assert.notEqual(p.targetId, targetId, 'stale target dropped');
  if (p.target >= 0) assert.equal(sim.prey.id[p.target], p.targetId, 'new target is valid');
});
