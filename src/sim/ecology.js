/**
 * Ecosystem life cycle: energy, grazing, division (mitosis), starvation, and a
 * predator–prey loop that settles into noisy Lotka–Volterra-style cycles.
 *
 * Prey
 *  - Energy E ∈ [0, 1] drains at  m · (b + (1 − b)·(|v|/v_cruise)²)  per second:
 *    a basal share b plus a drag-like term that grows with speed², so fleeing
 *    and sprinting are expensive.
 *  - Grazing: an agent touching the particle it steered towards gains its
 *    nutrition (capped at 1).
 *  - Division: once full (E ≥ 0.95) an agent splits with rate  fertility · (1 − n/K)⁺ .
 *    The (1 − n/K) factor is the soft carrying-capacity damping: births slow
 *    smoothly as a species fills its share K of `carryingCapacity` (logistic
 *    growth). Mother and daughter each keep E/2. The daughter's speed and
 *    perception genes drift log-normally (σ = 4 %), so selection can act.
 *  - Starvation at E = 0.
 *
 * Predators
 *  - Energy drains with  metabolism + effortCost · (|v|/v_pursuit)² ; a catch
 *    restores the prey's nutrition and some stamina; hungrier predators hunt
 *    with less stamina. Once full a predator divides with rate damped by
 *    (1 − P/P_K), where P_K = prey / preyPerPredator (the food chain sets the
 *    predator capacity). At E = 0 it starves and despawns.
 *
 * The loop: prey boom on food → predators feed and multiply → prey crash →
 * predators starve → prey recover. With logistic prey growth this is the
 * Rosenzweig–MacArthur picture: oscillations around a stable equilibrium
 * that the stochastic, spatial dynamics keep excited.
 *
 * Extinction rescue: a species the user still wants (config count was > 0)
 * that dies out is re-seeded by a small school of migrants after a delay; an
 * extinct predator population is re-seeded once prey are plentiful again.
 *
 * @module sim/ecology
 */

import { clamp } from '../core/math.js';
import { wrapDelta } from '../core/torus.js';
import { DEATH } from './prey-pool.js';
import { SPECIES_COUNT } from './species.js';

/** @typedef {import('./simulation.js').Simulation} Simulation */
/** @typedef {import('./predator.js').Predator} Predator */

export const ECOLOGY = Object.freeze({
  /** Most predators the life cycle breeds per reference screen area. */
  predatorsPerScreen: 12,
  /** Share of the cruise-speed metabolic cost paid even at zero speed. */
  basalMetabolism: 0.35,
  /**
   * Energy from which an agent can divide. Slightly below the 1.0 cap: eating
   * saturates at 1 and metabolism drains every step, so a threshold of
   * exactly 1 would leave a one-step window per meal.
   */
  divisionEnergy: 0.95,
  /** σ of the log-normal gene mutation per division. */
  mutation: 0.04,
  geneMin: 0.7,
  geneMax: 1.4,
  /** Seconds a wanted species stays extinct before migrants arrive. */
  immigrationDelay: 15,
  immigrantSchool: 8,
  /** Seconds without predators (with plentiful prey) before one migrates in. */
  predatorImmigrationDelay: 20,
  /** Prey needed (fraction of carrying capacity) before a predator migrates in. */
  predatorImmigrationPrey: 0.3,
});

/**
 * World area (CSS px²) the ecosystem defaults are tuned for: a phone in
 * portrait. The dynamics depend on density, so bigger worlds need
 * proportionally more prey, predators and food to behave the same.
 */
export const REFERENCE_AREA = 412 * 839;

/**
 * Ecosystem scale of a world relative to the reference phone screen, clamped
 * to keep small screens populated and big screens fast.
 * @param {number} width
 * @param {number} height
 */
export function areaFactor(width, height) {
  return clamp((width * height) / REFERENCE_AREA, 0.6, 4);
}

/**
 * Advance the life cycle by one step (life cycle on). Runs after integration.
 * @param {Simulation} sim
 * @param {number} dt
 */
export function updateLifecycle(sim, dt) {
  updatePrey(sim, dt);
  updatePredators(sim, dt);
  updateImmigration(sim, dt);
}

/**
 * Remove prey marked dead (eaten by a predator) without running metabolism.
 * Used when the life cycle is off, where catches normally respawn prey, and
 * for prey eaten in the same step the life cycle was switched off.
 * @param {Simulation} sim
 */
export function removeDeadPrey(sim) {
  const prey = sim.prey;
  for (let i = prey.count - 1; i >= 0; i--) if (prey.dead[i]) prey.removeAt(i);
}

/**
 * @param {Simulation} sim
 * @param {number} dt
 */
function updatePrey(sim, dt) {
  const prey = sim.prey;
  const food = sim.food;
  const rng = sim.rng;
  const runtime = sim.speciesRuntime;
  const W = sim.width;
  const H = sim.height;
  const basal = ECOLOGY.basalMetabolism;
  const { vx, vy, x, y, energy, foodTarget, foodTargetId, species, dead } = prey;
  const n0 = prey.count;

  for (let i = 0; i < n0; i++) {
    if (dead[i]) continue;
    const s = species[i];
    const P = runtime[s];
    const relSpeedSq = (vx[i] * vx[i] + vy[i] * vy[i]) / (P.cruiseSpeed * P.cruiseSpeed);
    let e = energy[i] - P.metabolism * (basal + (1 - basal) * relSpeedSq) * dt;

    const f = foodTarget[i];
    if (f >= 0 && f < food.count && food.id[f] === foodTargetId[i] && !food.eaten[f] && e < 1) {
      const dx = wrapDelta(food.x[f] - x[i], W);
      const dy = wrapDelta(food.y[f] - y[i], H);
      if (dx * dx + dy * dy <= P.mouthRadius * P.mouthRadius) {
        e = Math.min(1, e + food.consume(f));
        foodTarget[i] = -1;
        sim.stats.grazed++;
      }
    }

    if (e <= 0) {
      energy[i] = 0;
      dead[i] = DEATH.starved;
      continue;
    }
    energy[i] = e;

    if (e >= ECOLOGY.divisionEnergy) {
      const count = prey.countBySpecies[s];
      const damping = 1 - count / P.capacity;
      if (damping > 0 && count < sim.maxPopulation(s) && rng.next() < P.fertility * damping * dt) divide(sim, i);
    }
  }

  // Remove the dead in descending order: swap-removal only ever moves a
  // higher-index survivor (or a newborn) into the freed slot.
  for (let i = prey.count - 1; i >= 0; i--) {
    const cause = dead[i];
    if (!cause) continue;
    const s = species[i];
    if (cause === DEATH.starved) {
      sim.stats.starvations++;
      sim.addEffect('starve', x[i], y[i], s);
    }
    sim.events.emit('death', {
      species: s,
      cause: cause === DEATH.eaten ? 'eaten' : 'starved',
      id: prey.id[i],
      x: x[i],
      y: y[i],
      generation: prey.generation[i],
      time: sim.time,
    });
    prey.removeAt(i);
  }
}

/**
 * Split prey i into two (mitosis) with mutated genes.
 * @param {Simulation} sim
 * @param {number} i
 */
function divide(sim, i) {
  const prey = sim.prey;
  const rng = sim.rng;
  const s = prey.species[i];
  const half = prey.energy[i] * 0.5;
  prey.energy[i] = half;
  const side = rng.next() < 0.5 ? -1 : 1;
  const offset = sim.species[s].personalSpace * 0.6;
  const hx = prey.hx[i];
  const hy = prey.hy[i];
  const j = sim.spawnPreyAt(
    s,
    prey.x[i] - hy * offset * side,
    prey.y[i] + hx * offset * side,
    Math.atan2(hy, hx) + rng.gaussian() * 0.35,
    Math.hypot(prey.vx[i], prey.vy[i]),
  );
  prey.energy[j] = half;
  prey.geneSpeed[j] = mutate(prey.geneSpeed[i], rng.gaussian());
  prey.genePerception[j] = mutate(prey.genePerception[i], rng.gaussian());
  prey.generation[j] = prey.generation[i] + 1;
  sim.stats.births++;
  if (prey.generation[j] > sim.stats.maxGeneration) sim.stats.maxGeneration = prey.generation[j];
  sim.addEffect('birth', prey.x[j], prey.y[j], s);
  sim.events.emit('birth', {
    species: s,
    id: prey.id[j],
    parent: prey.id[i],
    generation: prey.generation[j],
    x: prey.x[j],
    y: prey.y[j],
    time: sim.time,
  });
}

/**
 * Log-normal gene drift, clamped to a viable range.
 * @param {number} gene
 * @param {number} noise Standard normal sample.
 */
export function mutate(gene, noise) {
  return clamp(gene * Math.exp(ECOLOGY.mutation * noise), ECOLOGY.geneMin, ECOLOGY.geneMax);
}

/**
 * @param {Simulation} sim
 * @param {number} dt
 */
function updatePredators(sim, dt) {
  const PR = sim.predatorRuntime;
  const predators = sim.predators;
  const rng = sim.rng;
  const capacity = Math.max(1, sim.prey.count / sim.predatorProfile.preyPerPredator);
  const max = sim.maxPredators();

  for (let k = predators.length - 1; k >= 0; k--) {
    const p = predators[k];
    const rel = (p.vx * p.vx + p.vy * p.vy) / (PR.pursuitSpeed * PR.pursuitSpeed);
    p.energy -= (PR.metabolism + PR.effortCost * rel) * dt;
    if (p.energy <= 0) {
      predators.splice(k, 1);
      sim.stats.predatorStarvations++;
      sim.addEffect('predatorStarve', p.x, p.y, -1);
      sim.events.emit('predatorDeath', { id: p.id, cause: 'starved', x: p.x, y: p.y, time: sim.time });
      continue;
    }
    if (p.energy >= ECOLOGY.divisionEnergy && predators.length < max) {
      const damping = 1 - predators.length / capacity;
      if (damping > 0 && rng.next() < PR.fertility * damping * dt) dividePredator(sim, p);
    }
  }
}

/**
 * @param {Simulation} sim
 * @param {Predator} p
 */
function dividePredator(sim, p) {
  p.energy *= 0.5;
  const child = sim.spawnPredatorAt(p.x - p.hx * 30, p.y - p.hy * 30, Math.atan2(p.hy, p.hx) + sim.rng.gaussian() * 0.6);
  child.energy = p.energy;
  child.stamina = 0.6;
  child.generation = p.generation + 1;
  sim.stats.predatorBirths++;
  sim.addEffect('predatorBirth', child.x, child.y, -1);
  sim.events.emit('predatorBirth', { id: child.id, parent: p.id, x: child.x, y: child.y, time: sim.time });
}

/**
 * Re-seed species that went extinct while the user still wants them.
 * @param {Simulation} sim
 * @param {number} dt
 */
function updateImmigration(sim, dt) {
  const prey = sim.prey;
  for (let s = 0; s < SPECIES_COUNT; s++) {
    if (!sim.wanted[s] || prey.countBySpecies[s] > 0) {
      sim.extinctTime[s] = 0;
      continue;
    }
    sim.extinctTime[s] += dt;
    if (sim.extinctTime[s] >= ECOLOGY.immigrationDelay) {
      sim.extinctTime[s] = 0;
      sim.spawnSchools(s, ECOLOGY.immigrantSchool, false);
      sim.stats.immigrations++;
      sim.events.emit('immigration', { kind: 'prey', species: s, count: ECOLOGY.immigrantSchool, time: sim.time });
    }
  }

  const plentiful = prey.count >= ECOLOGY.predatorImmigrationPrey * sim.config.carryingCapacity;
  if (!sim.wantedPredators || sim.predators.length > 0 || !plentiful) {
    sim.predatorExtinctTime = 0;
    return;
  }
  sim.predatorExtinctTime += dt;
  if (sim.predatorExtinctTime >= ECOLOGY.predatorImmigrationDelay) {
    sim.predatorExtinctTime = 0;
    sim.spawnPredator();
    sim.stats.immigrations++;
    sim.events.emit('immigration', { kind: 'predator', species: -1, count: 1, time: sim.time });
  }
}
