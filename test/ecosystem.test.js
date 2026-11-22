import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig } from '../src/config.js';
import { FIXED_DT, Simulation } from '../src/sim/simulation.js';
import { ECOLOGY, mutate } from '../src/sim/ecology.js';
import { FOOD } from '../src/sim/food.js';

const dt = FIXED_DT;
const MANTA = 1;
const DART = 0;

/**
 * A quiet ecosystem: no predators, no food unless a test adds it.
 * @param {Record<string, unknown>} overrides
 */
function makeSim(overrides = {}, seed = 5, width = 800, height = 800) {
  const config = createConfig(
    { countSpecies1: 0, countSpecies2: 0, countSpecies3: 0, predatorCount: 0, foodSpawnRate: 0, ...overrides },
    { warn: () => {} },
  );
  const sim = new Simulation({ config, width, height, seed });
  sim.food.clear();
  return { sim, config };
}

test('energy drains as basal + speed² metabolism', () => {
  const { sim } = makeSim({ countSpecies2: 1 });
  const prey = sim.prey;
  prey.energy[0] = 0.5;
  sim.step(dt);
  const P = sim.speciesRuntime[MANTA];
  const rel = (prey.vx[0] ** 2 + prey.vy[0] ** 2) / P.cruiseSpeed ** 2;
  const expected = 0.5 - P.metabolism * (ECOLOGY.basalMetabolism + (1 - ECOLOGY.basalMetabolism) * rel) * dt;
  assert.ok(Math.abs(prey.energy[0] - expected) < 1e-12, `${prey.energy[0]} vs ${expected}`);

  // A sprinter pays more than a cruiser.
  const slow = P.metabolism * (ECOLOGY.basalMetabolism + (1 - ECOLOGY.basalMetabolism) * 1);
  const fast = P.metabolism * (ECOLOGY.basalMetabolism + (1 - ECOLOGY.basalMetabolism) * 1.5 ** 2);
  assert.ok(fast > slow * 1.5);
});

test('energyDecay scales metabolism', () => {
  const a = makeSim({ countSpecies2: 1, energyDecay: 1 }).sim;
  const b = makeSim({ countSpecies2: 1, energyDecay: 2.5 }).sim;
  a.prey.energy[0] = b.prey.energy[0] = 0.5;
  a.step(dt);
  b.step(dt);
  assert.ok(Math.abs((0.5 - b.prey.energy[0]) / (0.5 - a.prey.energy[0]) - 2.5) < 1e-9);
});

test('grazing a food particle restores energy and consumes it', () => {
  const { sim } = makeSim({ countSpecies2: 1 });
  const prey = sim.prey;
  prey.energy[0] = 0.3;
  sim.food.add(prey.x[0] + 3, prey.y[0], 40, 0);
  sim.step(dt);
  assert.ok(prey.energy[0] > 0.3 + FOOD.nutrition - 0.01, `energy ${prey.energy[0]}`);
  assert.equal(sim.stats.grazed, 1);
  sim.step(dt);
  assert.equal(sim.food.count, 0, 'eaten particle removed on the next update');
});

test('hungry prey steer towards food they can sense', () => {
  const { sim } = makeSim({ countSpecies3: 1 });
  const prey = sim.prey;
  prey.energy[0] = 0.05;
  prey.vx[0] = 50;
  prey.vy[0] = 0;
  sim.food.add(prey.x[0], prey.y[0] + 60, 40, 0); // straight below
  sim.step(dt);
  assert.ok(prey.foodTarget[0] === 0, 'food targeted');
  assert.ok(prey.ay[0] > 0, `steering towards the food (ay=${prey.ay[0]})`);
});

test('full prey divide: energy is split and the daughter inherits mutated genes', () => {
  const { sim, config } = makeSim({ countSpecies1: 1, carryingCapacity: 2000 });
  /** @type {any[]} */
  const births = [];
  sim.on('birth', (e) => births.push(e));
  sim.species[DART].fertility = 1e9; // divide on the first eligible step
  const prey = sim.prey;
  prey.energy[0] = 1;
  prey.geneSpeed[0] = 1.1;
  prey.genePerception[0] = 0.9;
  sim.step(dt);
  assert.equal(prey.count, 2);
  assert.equal(config.countSpecies1, 2, 'live count published to the config');
  assert.ok(Math.abs(prey.energy[0] - prey.energy[1]) < 1e-12, 'energy split evenly');
  assert.ok(prey.energy[0] > 0.47 && prey.energy[0] < 0.5);
  assert.equal(prey.generation[1], 1);
  for (const [child, parent] of [[prey.geneSpeed[1], 1.1], [prey.genePerception[1], 0.9]]) {
    const drift = Math.abs(Math.log(child / parent));
    assert.ok(drift > 0 && drift < 6 * ECOLOGY.mutation, `gene drift ${drift}`);
  }
  assert.equal(births.length, 1);
  assert.equal(births[0].parent, prey.id[0]);
});

test('mutation stays within the viable gene range', () => {
  assert.equal(mutate(1.39, 100), ECOLOGY.geneMax);
  assert.equal(mutate(0.71, -100), ECOLOGY.geneMin);
  assert.ok(Math.abs(mutate(1, 0) - 1) < 1e-12);
});

test('carrying capacity damps births to zero when a species is full', () => {
  const { sim, config } = makeSim({ countSpecies1: 40, carryingCapacity: 50 }); // dartfish share: 25
  sim.species[DART].fertility = 1e9;
  for (let i = 0; i < sim.prey.count; i++) sim.prey.energy[i] = 1;
  sim.step(dt);
  assert.equal(sim.stats.births, 0);
  assert.equal(config.countSpecies1, 40);
});

test('starving prey die and the live count is published', () => {
  const { sim, config } = makeSim({ countSpecies3: 3 });
  /** @type {any[]} */
  const deaths = [];
  sim.on('death', (e) => deaths.push(e));
  sim.prey.energy[1] = 1e-9;
  sim.step(dt);
  assert.equal(sim.prey.count, 2);
  assert.equal(config.countSpecies3, 2);
  assert.equal(sim.stats.starvations, 1);
  assert.equal(deaths[0].cause, 'starved');
  assert.equal(sim.effects.filter((e) => e.kind === 'starve').length, 1);
});

/** A predator mid-pursuit with a dartfish right in front of it. */
function contactScenario() {
  const { sim, config } = makeSim({ countSpecies1: 1, predatorCount: 1 });
  const p = sim.predators[0];
  const prey = sim.prey;
  p.x = 400;
  p.y = 400;
  p.vx = 100;
  p.vy = 0;
  p.state = 'pursue';
  p.target = 0;
  p.targetId = prey.id[0];
  p.energy = 0.4;
  prey.x[0] = 405;
  prey.y[0] = 400;
  prey.vx[0] = 1;
  prey.vy[0] = 0;
  return { sim, config, p };
}

test('a hunting predator eats prey on contact and gains energy', () => {
  const { sim, config, p } = contactScenario();
  /** @type {any[]} */
  const deaths = [];
  sim.on('death', (e) => deaths.push(e));
  sim.step(dt);
  assert.equal(sim.prey.count, 0, 'prey eaten, not respawned');
  assert.equal(config.countSpecies1, 0);
  assert.equal(deaths[0].cause, 'eaten');
  assert.ok(p.energy > 0.4 + sim.speciesRuntime[DART].nutrition - 0.01, `predator energy ${p.energy}`);
  assert.equal(p.state, 'rest');
});

test('with the life cycle off, catches respawn prey instead', () => {
  const { sim, config, p } = contactScenario();
  config.ecosystem = false;
  sim.step(dt);
  assert.equal(sim.prey.count, 1);
  assert.equal(sim.stats.catches, 1);
  assert.equal(p.energy, 0.4, 'no energy bookkeeping without the life cycle');
});

test('predators starve and despawn; well-fed predators divide', () => {
  const { sim, config } = makeSim({ countSpecies2: 200, predatorCount: 2, carryingCapacity: 2000 });
  /** @type {string[]} */
  const log = [];
  sim.on('predatorDeath', () => log.push('death'));
  sim.on('predatorBirth', () => log.push('birth'));
  sim.predators[0].energy = 1e-9;
  sim.predators[1].energy = 1;
  sim.predatorProfile.fertility = 1e9;
  sim.step(dt);
  assert.deepEqual(log.sort(), ['birth', 'death']);
  assert.equal(sim.predators.length, 2);
  assert.equal(config.predatorCount, 2);
  assert.ok(sim.predators.every((p) => p.energy > 0.45 && p.energy < 0.5), 'energy split on division');
});

test('outside population changes apply immediately, even with the life cycle on', () => {
  const { sim, config } = makeSim({ countSpecies2: 10 });
  for (let i = 0; i < sim.prey.count; i++) sim.prey.energy[i] = 0.5;
  config.countSpecies2 = 25; // e.g. a UI stepper
  sim.step(dt);
  assert.equal(sim.prey.countBySpecies[MANTA], 25);
  config.countSpecies2 = 4;
  sim.step(dt);
  assert.equal(sim.prey.countBySpecies[MANTA], 4);
});

test('an extinct species the user still wants is re-seeded by migrants', () => {
  const { sim, config } = makeSim({ countSpecies2: 3, countSpecies3: 5 });
  /** @type {any[]} */
  const arrivals = [];
  sim.on('immigration', (e) => arrivals.push(e));
  for (let i = 0; i < sim.prey.count; i++) if (sim.prey.species[i] === MANTA) sim.prey.energy[i] = 1e-9;
  sim.step(dt);
  assert.equal(config.countSpecies2, 0, 'mantas starved out');
  config.countSpecies3 = 0; // the user removes foragers on purpose
  for (let k = 0; k < Math.ceil(ECOLOGY.immigrationDelay / dt) + 2; k++) sim.step(dt);
  assert.deepEqual(arrivals.map((e) => [e.kind, e.species]), [['prey', MANTA]]);
  assert.ok(config.countSpecies2 >= ECOLOGY.immigrantSchool - 1, 'migrant school arrived');
  assert.equal(config.countSpecies3, 0, 'species removed by the user stays gone');
});

test('food blooms in clusters, drifts smoothly and respects the cap', () => {
  const { sim } = makeSim({ foodSpawnRate: 60 }, 3, 412, 839);
  for (let k = 0; k < 60 * 30; k++) sim.step(dt);
  assert.ok(sim.food.count <= FOOD.maxParticles && sim.food.count > FOOD.maxParticles * 0.8, `capped: ${sim.food.count}`);

  sim.food.clear();
  sim.config.foodSpawnRate = 15;
  for (let k = 0; k < 60 * 12; k++) sim.step(dt);
  const food = sim.food;
  assert.ok(food.count > 100, `food count ${food.count}`);
  // Smooth drift: positions change by about driftSpeed·dt per step, never jump.
  const x0 = Array.from(food.x.subarray(0, food.count));
  const ids = Array.from(food.id.subarray(0, food.count));
  sim.step(dt);
  let maxStep = 0;
  for (let i = 0; i < food.count; i++) {
    const k = ids.indexOf(food.id[i]);
    if (k < 0) continue;
    let d = Math.abs(food.x[i] - x0[k]);
    d = Math.min(d, 412 - d);
    maxStep = Math.max(maxStep, d);
  }
  assert.ok(maxStep < FOOD.driftSpeed * 3 * dt, `max drift step ${maxStep}`);
  // Clustered: the mean nearest-neighbour distance is far below a uniform scatter.
  let sum = 0;
  for (let i = 0; i < food.count; i++) {
    let best = Infinity;
    for (let j = 0; j < food.count; j++) {
      if (i !== j) best = Math.min(best, Math.hypot(food.x[i] - food.x[j], food.y[i] - food.y[j]));
    }
    sum += best;
  }
  const uniform = 0.5 * Math.sqrt((412 * 839) / food.count);
  assert.ok(sum / food.count < 0.7 * uniform, `clustering: ${(sum / food.count).toFixed(1)} vs ${uniform.toFixed(1)}`);
});

test('a birth that outgrows the prey pool keeps every energy update', () => {
  const { sim } = makeSim({ carryingCapacity: 2000 });
  const prey = sim.prey;
  sim.addPrey(DART, prey.capacity - prey.count); // exactly full: the first birth reallocates
  const n = prey.count;
  assert.equal(n, prey.capacity);
  sim.species[DART].fertility = 1e9; // everyone divides this step…
  sim.species[DART].capacityShare = 1; // …with room for all the daughters
  for (let i = 0; i < n; i++) prey.energy[i] = 1;
  sim.step(dt);
  assert.equal(prey.count, 2 * n, 'every agent divided');
  for (let i = 0; i < prey.count; i++) {
    // Metabolism was paid before the split: exactly 0.5 would mean a lost write.
    assert.ok(prey.energy[i] < 0.5 && prey.energy[i] > 0.49, `agent ${i}: ${prey.energy[i]}`);
  }
});

test('extinction events report die-offs, not populations the user removed', () => {
  const { sim, config } = makeSim({ countSpecies2: 5, countSpecies3: 5, predatorCount: 2 });
  /** @type {string[]} */
  const events = [];
  sim.on('extinction', (e) => events.push(`${e.kind}:${e.species}`));
  // The user removes foragers and one predator: no event.
  config.$set({ countSpecies3: 0, predatorCount: 1 });
  sim.step(dt);
  assert.deepEqual(events, []);
  // Mantas and the last predator starve: one event each.
  for (let i = 0; i < sim.prey.count; i++) if (sim.prey.species[i] === MANTA) sim.prey.energy[i] = 1e-9;
  for (const p of sim.predators) p.energy = 1e-9;
  sim.step(dt);
  assert.deepEqual(events.sort(), ['predator:-1', `prey:${MANTA}`]);
  // Removing a population that is already gone stays quiet too.
  config.$set({ countSpecies2: 0, predatorCount: 0 });
  sim.step(dt);
  assert.equal(events.length, 2);
});

test('turning the life cycle off fades the remaining food out', () => {
  const { sim, config } = makeSim({ foodSpawnRate: 20 }, 3, 412, 839);
  for (let k = 0; k < 60 * 8; k++) sim.step(dt);
  sim.food.startBloom(200, 400, FOOD.bloomMax);
  assert.ok(sim.food.count > 50, `food present: ${sim.food.count}`);
  config.ecosystem = false;
  sim.step(dt);
  assert.equal(sim.food.blooms.length, 0, 'pending blooms dropped');
  for (let i = 0; i < sim.food.count; i++) {
    assert.ok(sim.food.life[i] - sim.food.age[i] <= FOOD.fadeTime + 1e-9, 'every particle is fading');
  }
  for (let k = 0; k < Math.ceil(FOOD.fadeTime / dt) + 2; k++) sim.step(dt);
  assert.equal(sim.food.count, 0, 'gone after one fade time');
  config.ecosystem = true;
  for (let k = 0; k < 60 * 3; k++) sim.step(dt);
  assert.ok(sim.food.count > 0, 'blooms resume when the life cycle is back on');
});

test('the life cycle keeps speed and force limits intact', () => {
  const { sim } = makeSim({ countSpecies1: 120, countSpecies2: 30, countSpecies3: 80, predatorCount: 3, foodSpawnRate: 30 });
  for (let k = 0; k < 600; k++) {
    const before = new Map();
    for (let i = 0; i < sim.prey.count; i++) before.set(sim.prey.id[i], [sim.prey.vx[i], sim.prey.vy[i]]);
    sim.step(dt);
    for (let i = 0; i < sim.prey.count; i++) {
      const v = Math.hypot(sim.prey.vx[i], sim.prey.vy[i]);
      assert.ok(v <= sim.prey.speedLimit[i] + 1e-9);
      const old = before.get(sim.prey.id[i]);
      if (old) {
        const dv = Math.hypot(sim.prey.vx[i] - old[0], sim.prey.vy[i] - old[1]);
        assert.ok(dv <= sim.prey.forceLimit[i] * dt + 1e-9, `|dv| ${dv}`);
      }
    }
  }
});
