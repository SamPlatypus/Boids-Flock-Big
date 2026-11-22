/**
 * Touch physics: tap scatter pulses and press-and-hold beacons.
 *
 * Pulse: an expanding circular shockwave. Its front travels outward at
 * `PULSE.speed`. Agents near the front receive a radial push shaped by a
 * smooth compact bump around the front and an exponential time decay:
 *
 *     push(d, t) = strength · e^(−t/τ) · (1 − u²)²,   u = (d − speed·t) / thickness
 *
 * The push enters the prey's emergency steering channel (startle) and raises
 * panic, so a tap also starts an alarm wave that spreads through the flock.
 *
 * Beacon: one per held pointer. It eases toward the finger (exponential
 * smoothing, frame-rate independent), ramps its strength in and out so it
 * never pops, and acts as an attractor or a repulsor. In 'auto' mode a single
 * held pointer attracts and two or more pointers all repel.
 *
 * Distances are toroidal, so a beacon or pulse near an edge also reaches
 * agents just across the seam.
 *
 * @module sim/interactions
 */

import { wrapCoord, wrapDelta } from '../core/torus.js';
import { expBlend, smoothstep } from '../core/math.js';

export const PULSE = Object.freeze({
  /** Wavefront speed (px/s). */
  speed: 540,
  /** Radius at which the wave dies out (px). */
  maxRadius: 260,
  /** Half-width of the wavefront bump (px). */
  thickness: 36,
  /** Exponential decay time constant of the push (s). */
  decay: 0.6,
  /** Panic induced at the crest. */
  panic: 0.9,
  /** Cap on simultaneous pulses (oldest dropped). */
  maxActive: 12,
});

export const BEACON = Object.freeze({
  /** Attractor reach (px). */
  attractRadius: 240,
  /** Inside this radius the pull fades out, so prey orbit instead of piling up (px). */
  orbitRadius: 36,
  /** Repulsor reach (px). */
  repelRadius: 150,
  /** Position smoothing time constant (s). */
  follow: 0.06,
  /** Strength ramp-in / ramp-out time (s). */
  ramp: 0.15,
  /** Panic induced by a repulsor at point blank. */
  repelPanic: 0.75,
  /** Push on predators relative to their steering limit. */
  predatorSusceptibility: 0.6,
});

/** @typedef {'auto' | 'attract' | 'repel'} BeaconMode */

export class Pulse {
  /**
   * @param {number} x
   * @param {number} y
   * @param {number} strength
   */
  constructor(x, y, strength) {
    this.x = x;
    this.y = y;
    this.strength = strength;
    this.age = 0;
  }

  /** Current wavefront radius (px). */
  get radius() {
    return PULSE.speed * this.age;
  }

  /** Time-decayed amplitude ∈ [0, strength]. */
  get amplitude() {
    return this.strength * Math.exp(-this.age / PULSE.decay);
  }

  get alive() {
    return this.radius < PULSE.maxRadius + PULSE.thickness;
  }
}

export class Beacon {
  /**
   * @param {number | string} id Pointer id.
   * @param {number} x
   * @param {number} y
   * @param {BeaconMode | null} requestedMode null = follow `config.beaconMode`.
   */
  constructor(id, x, y, requestedMode) {
    this.id = id;
    this.x = x;
    this.y = y;
    this.targetX = x;
    this.targetY = y;
    this.requestedMode = requestedMode;
    /** Resolved mode this step. @type {'attract' | 'repel'} */
    this.mode = 'attract';
    /** Ramp envelope ∈ [0, 1]. */
    this.level = 0;
    this.released = false;
    this.age = 0;
  }
}

/**
 * @typedef {object} InteractionHost
 * @property {number} width
 * @property {number} height
 * @property {Pulse[]} pulses
 * @property {Map<number | string, Beacon>} beacons
 * @property {{ beaconMode: BeaconMode, beaconStrength: number, pulseStrength: number }} config
 * @property {import('./prey-pool.js').PreyPool} prey
 * @property {import('../core/spatial-hash.js').ToroidalSpatialHash} grid
 * @property {import('../core/spatial-hash.js').NeighborBuffer} queryBuffer
 * @property {import('./predator.js').Predator[]} predators
 * @property {{ maxForce: number }} predatorRuntime
 */

/**
 * Advance beacon smoothing / ramps and pulse ages; drop finished ones.
 * @param {InteractionHost} sim
 * @param {number} dt
 */
export function updateInteractions(sim, dt) {
  const { width, height, beacons, pulses } = sim;
  let held = 0;
  for (const beacon of beacons.values()) if (!beacon.released) held++;

  const follow = expBlend(1 / BEACON.follow, dt);
  const rampStep = dt / BEACON.ramp;
  for (const [id, beacon] of beacons) {
    beacon.age += dt;
    beacon.x = wrapCoord(beacon.x + wrapDelta(beacon.targetX - beacon.x, width) * follow, width);
    beacon.y = wrapCoord(beacon.y + wrapDelta(beacon.targetY - beacon.y, height) * follow, height);
    beacon.level = beacon.released ? Math.max(0, beacon.level - rampStep) : Math.min(1, beacon.level + rampStep);
    const mode = beacon.requestedMode ?? sim.config.beaconMode;
    beacon.mode = mode === 'auto' ? (held >= 2 ? 'repel' : 'attract') : mode;
    if (beacon.released && beacon.level <= 0) beacons.delete(id);
  }

  for (const pulse of pulses) pulse.age += dt;
  for (let i = pulses.length - 1; i >= 0; i--) if (!pulses[i].alive) pulses.splice(i, 1);
}

/**
 * Accumulate pulse and beacon stimuli into the prey pool (and pushes into the
 * predators). Must run after the spatial grid is built for this step.
 * @param {InteractionHost} sim
 */
export function applyInteractionForces(sim) {
  const { prey, grid, queryBuffer: buf, predators, width, height } = sim;
  const { threatX, threatY, threat, attractX, attractY } = prey;
  const pulseGain = sim.config.pulseStrength;
  const beaconGain = sim.config.beaconStrength;
  const predatorForce = sim.predatorRuntime.maxForce;

  for (const pulse of sim.pulses) {
    const front = pulse.radius;
    const amp = pulse.amplitude * pulseGain;
    if (amp <= 1e-3) continue;
    const reach = front + PULSE.thickness;
    const count = grid.query(pulse.x, pulse.y, reach, -1, buf);
    for (let k = 0; k < count; k++) {
      const j = buf.index[k];
      const d = Math.sqrt(buf.distSq[k]);
      const u = (d - front) / PULSE.thickness;
      if (u <= -1 || u >= 1) continue;
      const bump = (1 - u * u) * (1 - u * u);
      const push = bump * amp;
      // Outward unit vector; an agent exactly at the centre is pushed along its heading.
      const ox = d > 1e-6 ? buf.dx[k] / d : prey.hx[j];
      const oy = d > 1e-6 ? buf.dy[k] / d : prey.hy[j];
      threatX[j] += ox * push;
      threatY[j] += oy * push;
      const alarm = Math.min(1, push * PULSE.panic);
      if (alarm > threat[j]) threat[j] = alarm;
    }
    for (const p of predators) {
      const dx = wrapDelta(p.x - pulse.x, width);
      const dy = wrapDelta(p.y - pulse.y, height);
      const d = Math.hypot(dx, dy);
      const u = (d - front) / PULSE.thickness;
      if (u <= -1 || u >= 1 || d < 1e-6) continue;
      const push = (1 - u * u) * (1 - u * u) * amp * predatorForce * BEACON.predatorSusceptibility;
      p.extX += (dx / d) * push;
      p.extY += (dy / d) * push;
    }
  }

  for (const beacon of sim.beacons.values()) {
    const level = beacon.level * beaconGain;
    if (level <= 1e-3) continue;
    if (beacon.mode === 'repel') {
      const R = BEACON.repelRadius;
      const count = grid.query(beacon.x, beacon.y, R, -1, buf);
      for (let k = 0; k < count; k++) {
        const j = buf.index[k];
        const d = Math.sqrt(buf.distSq[k]);
        const q = 1 - d / R;
        const u = q * q * level;
        const ox = d > 1e-6 ? buf.dx[k] / d : prey.hx[j];
        const oy = d > 1e-6 ? buf.dy[k] / d : prey.hy[j];
        threatX[j] += ox * u;
        threatY[j] += oy * u;
        const alarm = Math.min(1, u * BEACON.repelPanic);
        if (alarm > threat[j]) threat[j] = alarm;
      }
      for (const p of predators) {
        const dx = wrapDelta(p.x - beacon.x, width);
        const dy = wrapDelta(p.y - beacon.y, height);
        const d = Math.hypot(dx, dy);
        if (d >= R || d < 1e-6) continue;
        const q = 1 - d / R;
        const push = q * q * level * predatorForce * BEACON.predatorSusceptibility;
        p.extX += (dx / d) * push;
        p.extY += (dy / d) * push;
      }
    } else {
      const R = BEACON.attractRadius;
      const count = grid.query(beacon.x, beacon.y, R, -1, buf);
      for (let k = 0; k < count; k++) {
        const j = buf.index[k];
        const d = Math.sqrt(buf.distSq[k]);
        if (d < 1e-6) continue;
        // Radial profile: 0 at the centre (orbit zone), plateau, smooth fade at R.
        const u = smoothstep(0, BEACON.orbitRadius, d) * (1 - smoothstep(0.55 * R, R, d)) * level;
        attractX[j] -= (buf.dx[k] / d) * u;
        attractY[j] -= (buf.dy[k] / d) * u;
      }
    }
  }
}
