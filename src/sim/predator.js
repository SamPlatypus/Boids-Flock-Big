/**
 * Apex predator AI.
 *
 * State machine:
 *
 *     patrol ──(rested & prey in range)──▶ pursue ──(close & facing)──▶ strike
 *       ▲                                  │  ▲                            │
 *       │                       (exhausted │  └──────(missed, stamina)─────┤
 *       │                       or gave up)▼                               │
 *       └──────(recovered)────────────── rest ◀────────(caught/exhausted)──┘
 *
 * - patrol: smooth Ornstein–Uhlenbeck wander at a relaxed speed.
 * - pursue: locks onto the most vulnerable nearby prey (close, isolated, ahead,
 *   slow species) with hysteresis, steering toward the predicted intercept point.
 * - strike: short burst at 1.75× speed with a higher acceleration limit.
 * - rest: slow drift while stamina recovers; longer after a successful catch.
 *
 * Stamina drains while pursuing and much faster while striking, and recovers
 * while patrolling or resting. Aggression scales detection range, the stamina
 * needed to start a hunt, persistence and rest length.
 *
 * @module sim/predator
 */

import { wrapCoord, wrapDelta } from '../core/torus.js';
import { ForceBudget, clamp, lerp, nextSpeedLimit, truncationFactor } from '../core/math.js';

/** @typedef {'patrol' | 'pursue' | 'strike' | 'rest'} PredatorState */
/** @typedef {import('./simulation.js').Simulation} Simulation */
/** @typedef {import('./species.js').PredatorProfile} PredatorProfile */
/** @typedef {import('../config.js').SimConfig} SimConfig */

/** Longest intercept look-ahead (s). Beyond this, predictions are unreliable. */
const MAX_INTERCEPT_TIME = 1.5;
/** Look-ahead cap used by prey to predict the predator's position (s). */
const EVADE_LOOKAHEAD = 0.5;
/** Score bonus that keeps the current target unless another is clearly better. */
const TARGET_STICKINESS = 0.2;
/** A strike only launches at prey within this cone ahead (cos 40°). */
const STRIKE_CONE_COS = Math.cos((40 * Math.PI) / 180);
/** Rest-length multiplier after a successful catch (satiation). */
const SATIATION = 2.5;
/** Fraction of the force budget reserved when a speed limit drops (see flocking.js). */
const SPEED_LIMIT_DROP = 0.5;

export class PredatorRuntime {
  constructor() {
    this.pursuitSpeed = 0;
    this.patrolSpeed = 0;
    this.restSpeed = 0;
    this.strikeSpeed = 0;
    this.maxForce = 0;
    this.strikeForce = 0;
    this.huntRadius = 0;
    this.huntRadiusSq = 0;
    this.loseRadius = 0;
    this.strikeRange = 0;
    this.strikeDuration = 0;
    this.strikeCooldown = 0;
    this.catchRadius = 0;
    this.separationRadius = 0;
    this.huntThreshold = 0;
    this.recoverThreshold = 0;
    this.exhausted = 0.06;
    this.strikeMinStamina = 0.12;
    this.giveUpTime = 0;
    this.minRest = 0;
    this.patrolRegen = 0;
    this.restRegen = 0;
    this.pursuitDrain = 0;
    this.strikeDrain = 0;
    this.wanderStrength = 0;
    this.wanderRate = 0;
    this.wanderSigma = 0;
    /** @type {Record<PredatorState, number>} */
    this.threatLevel = { patrol: 0, pursue: 0, strike: 0, rest: 0 };
  }

  /**
   * @param {PredatorProfile} profile
   * @param {SimConfig} config
   */
  resolve(profile, config) {
    const a = config.predatorAggression;
    this.pursuitSpeed = config.predatorSpeed;
    this.patrolSpeed = config.predatorSpeed * profile.patrolSpeed;
    this.restSpeed = config.predatorSpeed * profile.restSpeed;
    this.strikeSpeed = config.predatorSpeed * profile.strikeSpeed;
    this.maxForce = config.maxForce * profile.agility;
    this.strikeForce = this.maxForce * profile.strikeAgility;
    this.huntRadius = profile.huntRadius * lerp(0.8, 1.3, a);
    this.huntRadiusSq = this.huntRadius * this.huntRadius;
    this.loseRadius = this.huntRadius * 1.5;
    this.strikeRange = profile.strikeRange * lerp(0.85, 1.2, a);
    this.strikeDuration = profile.strikeDuration;
    this.strikeCooldown = profile.strikeCooldown;
    this.catchRadius = profile.catchRadius;
    this.separationRadius = profile.length * 1.2;
    this.huntThreshold = lerp(0.9, 0.4, a);
    this.recoverThreshold = lerp(0.95, 0.7, a);
    this.giveUpTime = lerp(4, 12, a);
    this.minRest = lerp(3, 1, a);
    this.patrolRegen = profile.patrolRegen;
    this.restRegen = profile.restRegen;
    this.pursuitDrain = profile.pursuitDrain;
    this.strikeDrain = profile.strikeDrain;
    this.wanderStrength = profile.wanderStrength;
    this.wanderRate = profile.wanderRate;
    this.wanderSigma = Math.sqrt(2 * profile.wanderRate);
    this.threatLevel.patrol = profile.threatLevel.patrol;
    this.threatLevel.pursue = profile.threatLevel.pursue;
    this.threatLevel.strike = profile.threatLevel.strike;
    this.threatLevel.rest = profile.threatLevel.rest;
  }
}

export class Predator {
  /**
   * @param {number} id
   * @param {number} x
   * @param {number} y
   * @param {number} heading Radians.
   * @param {number} speed
   */
  constructor(id, x, y, heading, speed) {
    this.id = id;
    this.x = x;
    this.y = y;
    this.prevX = x;
    this.prevY = y;
    this.hx = Math.cos(heading);
    this.hy = Math.sin(heading);
    this.vx = this.hx * speed;
    this.vy = this.hy * speed;
    this.ax = 0;
    this.ay = 0;
    /** @type {PredatorState} */
    this.state = 'patrol';
    this.stateTime = 0;
    /** Time spent in the current hunt (pursue + strike), for giving up. */
    this.huntTime = 0;
    this.stamina = 1;
    /** Target prey index (-1 = none) and its stable id for revalidation. */
    this.target = -1;
    this.targetId = 0;
    this.targetDx = 0;
    this.targetDy = 0;
    this.targetDist = Infinity;
    /** Best target found by the latest sensing pass. */
    this.candidate = -1;
    this.wander = 0;
    this.strikeCooldown = 0;
    this.restDuration = 0;
    this.speedLimit = speed;
    this.forceLimit = 0;
    /** External push (pulses / repulsors) accumulated this step (px/s²). */
    this.extX = 0;
    this.extY = 0;
    this.catches = 0;
  }
}

/**
 * Time to intercept for a pursuer at the origin moving at `speed`, chasing a
 * target at relative position r moving with constant velocity v. Solves
 *
 *     |r + v·t| = speed · t   ⇔   (v·v − s²) t² + 2 (r·v) t + r·r = 0
 *
 * for the smallest t > 0. If no solution exists (the target is faster and
 * receding), falls back to Reynolds' pursuit estimate t = |r| / speed. The
 * result is capped at `maxTime`.
 *
 * @param {number} rx
 * @param {number} ry
 * @param {number} vx
 * @param {number} vy
 * @param {number} speed Pursuer speed (> 0).
 * @param {number} [maxTime]
 * @returns {number}
 */
export function interceptTime(rx, ry, vx, vy, speed, maxTime = MAX_INTERCEPT_TIME) {
  const a = vx * vx + vy * vy - speed * speed;
  const b = 2 * (rx * vx + ry * vy);
  const c = rx * rx + ry * ry;
  let t = -1;
  if (Math.abs(a) < 1e-9) {
    if (b < 0) t = -c / b; // linear: b·t + c = 0
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      const t1 = (-b - sq) / (2 * a);
      const t2 = (-b + sq) / (2 * a);
      const best = Math.min(t1 > 0 ? t1 : Infinity, t2 > 0 ? t2 : Infinity);
      if (Number.isFinite(best)) t = best;
    }
  }
  if (t < 0) t = Math.sqrt(c) / Math.max(speed, 1e-6);
  return Math.min(t, maxTime);
}

/**
 * Sensing pass (before prey steering): each predator applies its threat to
 * nearby prey (flee stimulus + alarm) and scores hunting candidates. One grid
 * query per predator serves both.
 *
 * @param {Simulation} sim
 */
export function sensePredators(sim) {
  const { prey, grid, queryBuffer: buf, speciesRuntime: rt, predatorRuntime: PR, width, height } = sim;
  let maxThreat = 0;
  for (const s of rt) if (s.threatRadius > maxThreat) maxThreat = s.threatRadius;

  for (const p of sim.predators) {
    // Revalidate the target: indices move when prey are removed, ids never repeat.
    if (p.target >= 0 && (p.target >= prey.count || prey.id[p.target] !== p.targetId)) {
      p.target = -1;
      p.targetId = 0;
    }
    if (p.target >= 0) {
      p.targetDx = wrapDelta(prey.x[p.target] - p.x, width);
      p.targetDy = wrapDelta(prey.y[p.target] - p.y, height);
      p.targetDist = Math.hypot(p.targetDx, p.targetDy);
    } else {
      p.targetDist = Infinity;
    }

    const level = PR.threatLevel[p.state];
    const speed = Math.hypot(p.vx, p.vy);
    const count = grid.query(p.x, p.y, Math.max(maxThreat, PR.huntRadius), -1, buf);
    let best = -1;
    let bestScore = Infinity;
    for (let k = 0; k < count; k++) {
      const j = buf.index[k];
      const dx = buf.dx[k]; // predator → prey
      const dy = buf.dy[k];
      const d2 = buf.distSq[k];
      const P = rt[prey.species[j]];
      const d = Math.sqrt(d2);

      if (level > 0 && d2 < P.threatRadiusSq) {
        // Evade: flee from where the predator will be shortly, not where it is.
        const T = Math.min(EVADE_LOOKAHEAD, d / Math.max(speed, 1));
        let fx = dx - p.vx * T;
        let fy = dy - p.vy * T;
        const fm = Math.hypot(fx, fy);
        if (fm > 1e-6) {
          fx /= fm;
          fy /= fm;
        } else {
          fx = prey.hx[j];
          fy = prey.hy[j];
        }
        const q = 1 - d / P.threatRadius;
        const urgency = q * q * (3 - 2 * q) * level; // smoothstep: zero slope at the edge
        prey.threatX[j] += fx * urgency;
        prey.threatY[j] += fy * urgency;
        const alarm = Math.min(1, urgency);
        if (alarm > prey.threat[j]) prey.threat[j] = alarm;
      }

      if (d2 < PR.huntRadiusSq) {
        // Lower is better: near, isolated (confusion effect), ahead, vulnerable species.
        const ahead = d > 1e-6 ? (dx * p.hx + dy * p.hy) / d : 1;
        let score =
          d / PR.huntRadius +
          0.5 * Math.min(1, prey.crowding[j] / 10) +
          0.15 * (1 - ahead) -
          0.35 * P.vulnerability;
        if (j === p.target) score -= TARGET_STICKINESS;
        if (score < bestScore) {
          bestScore = score;
          best = j;
        }
      }
    }
    p.candidate = best;
  }
}

/**
 * @param {Simulation} sim
 * @param {Predator} p
 * @param {PredatorState} next
 */
function transition(sim, p, next) {
  if (p.state === next) return;
  const from = p.state;
  p.state = next;
  p.stateTime = 0;
  if (next === 'patrol' || next === 'rest') {
    p.huntTime = 0;
    p.target = -1;
    p.targetId = 0;
    p.targetDist = Infinity;
  }
  sim.events.emit('predatorState', { id: p.id, from, to: next, time: sim.time });
}

/**
 * @param {Simulation} sim
 * @param {Predator} p
 * @param {number} index
 */
function lockTarget(sim, p, index) {
  p.target = index;
  p.targetId = sim.prey.id[index];
  p.targetDx = wrapDelta(sim.prey.x[index] - p.x, sim.width);
  p.targetDy = wrapDelta(sim.prey.y[index] - p.y, sim.height);
  p.targetDist = Math.hypot(p.targetDx, p.targetDy);
}

/**
 * @param {Simulation} sim
 * @param {Predator} p
 * @param {number} duration Minimum rest (s).
 */
function startRest(sim, p, duration) {
  transition(sim, p, 'rest');
  p.restDuration = duration;
}

/**
 * State transitions for one predator.
 * @param {Simulation} sim
 * @param {Predator} p
 */
function decide(sim, p) {
  const PR = sim.predatorRuntime;
  switch (p.state) {
    case 'patrol':
      if (p.stamina >= PR.huntThreshold && p.candidate >= 0) {
        lockTarget(sim, p, p.candidate);
        transition(sim, p, 'pursue');
      }
      break;
    case 'pursue': {
      if (p.target < 0 || p.targetDist > PR.loseRadius) {
        if (p.candidate >= 0) lockTarget(sim, p, p.candidate);
        else {
          transition(sim, p, 'patrol');
          break;
        }
      } else if (p.candidate >= 0 && p.candidate !== p.target) {
        // The current target already carries a stickiness bonus, so a different
        // best candidate is clearly better.
        lockTarget(sim, p, p.candidate);
      }
      if (p.stamina <= PR.exhausted || p.huntTime > PR.giveUpTime) {
        startRest(sim, p, PR.minRest);
        break;
      }
      if (p.strikeCooldown <= 0 && p.stamina > PR.strikeMinStamina && p.targetDist < PR.strikeRange) {
        const ahead = (p.targetDx * p.hx + p.targetDy * p.hy) / Math.max(p.targetDist, 1e-6);
        if (ahead > STRIKE_CONE_COS) transition(sim, p, 'strike');
      }
      break;
    }
    case 'strike':
      if (p.stateTime >= PR.strikeDuration || p.stamina <= PR.exhausted) {
        p.strikeCooldown = PR.strikeCooldown;
        if (p.stamina > PR.exhausted + 0.1 && p.huntTime <= PR.giveUpTime) transition(sim, p, 'pursue');
        else startRest(sim, p, PR.minRest);
      }
      break;
    case 'rest':
      if (p.stateTime >= p.restDuration && p.stamina >= PR.recoverThreshold) transition(sim, p, 'patrol');
      break;
  }
}

const budget = new ForceBudget();

/**
 * Think + steer: stamina, state transitions and steering acceleration.
 * @param {Simulation} sim
 * @param {number} dt
 */
export function steerPredators(sim, dt) {
  const PR = sim.predatorRuntime;
  const prey = sim.prey;
  const rng = sim.rng;
  const predators = sim.predators;
  const sqrtDt = Math.sqrt(dt);

  for (const p of predators) {
    // ── Stamina & timers ────────────────────────────────────────────────────
    let dStamina = 0;
    if (p.state === 'patrol') dStamina = PR.patrolRegen;
    else if (p.state === 'rest') dStamina = PR.restRegen;
    else if (p.state === 'pursue') dStamina = -PR.pursuitDrain;
    else dStamina = -PR.strikeDrain;
    p.stamina = clamp(p.stamina + dStamina * dt, 0, 1);
    p.stateTime += dt;
    if (p.state === 'pursue' || p.state === 'strike') p.huntTime += dt;
    p.strikeCooldown = Math.max(0, p.strikeCooldown - dt);

    decide(sim, p);

    // ── Limits for the (possibly new) state ─────────────────────────────────
    const speed = Math.hypot(p.vx, p.vy);
    if (speed > 1e-6) {
      p.hx = p.vx / speed;
      p.hy = p.vy / speed;
    }
    let vTarget = PR.patrolSpeed * 1.2;
    let fmax = PR.maxForce;
    if (p.state === 'pursue') vTarget = PR.pursuitSpeed;
    else if (p.state === 'strike') {
      vTarget = PR.strikeSpeed;
      fmax = PR.strikeForce;
    }
    const vPrev = p.speedLimit;
    const vmax = nextSpeedLimit(vPrev, vTarget, SPEED_LIMIT_DROP * fmax * dt);
    p.speedLimit = vmax;
    p.forceLimit = fmax;
    budget.reset(fmax - Math.max(0, vPrev - vmax) / dt);

    // ── Priority 1: external pushes (pulses, repulsor beacons) ──────────────
    budget.add(p.extX, p.extY);

    // ── Priority 2: keep clear of other predators ───────────────────────────
    let sx = 0;
    let sy = 0;
    const rs = PR.separationRadius;
    for (const o of predators) {
      if (o === p) continue;
      const dx = wrapDelta(p.x - o.x, sim.width);
      const dy = wrapDelta(p.y - o.y, sim.height);
      const d2 = dx * dx + dy * dy;
      if (d2 >= rs * rs || d2 < 1e-12) continue;
      const d = Math.sqrt(d2);
      const q = 1 - d / rs;
      sx += (dx / d) * q * q;
      sy += (dy / d) * q * q;
    }
    const sf = truncationFactor(sx, sy, 1) * fmax;
    budget.add(sx * sf, sy * sf);

    // ── Priority 3: state behaviour ─────────────────────────────────────────
    if ((p.state === 'pursue' || p.state === 'strike') && p.target >= 0) {
      const desiredSpeed = p.state === 'strike' ? PR.strikeSpeed : PR.pursuitSpeed;
      const tvx = prey.vx[p.target];
      const tvy = prey.vy[p.target];
      const T = interceptTime(p.targetDx, p.targetDy, tvx, tvy, desiredSpeed);
      const aimX = p.targetDx + tvx * T;
      const aimY = p.targetDy + tvy * T;
      const aim = Math.hypot(aimX, aimY);
      if (aim > 1e-6) {
        const ex = (aimX / aim) * desiredSpeed - p.vx;
        const ey = (aimY / aim) * desiredSpeed - p.vy;
        const k = truncationFactor(ex, ey, 0.5 * desiredSpeed) * (fmax / (0.5 * desiredSpeed));
        budget.add(ex * k, ey * k);
      }
    } else {
      // Patrol / rest (or a strike that lost its target): wander + cruise control.
      p.wander += -PR.wanderRate * p.wander * dt + PR.wanderSigma * sqrtDt * rng.gaussian();
      const cruise = p.state === 'rest' ? PR.restSpeed : p.state === 'strike' ? PR.strikeSpeed : PR.patrolSpeed;
      const wanderF = PR.wanderStrength * fmax * (p.state === 'rest' ? 0.4 : 1) * p.wander;
      const cruiseF = fmax * 0.6 * clamp((cruise - speed) / (0.25 * Math.max(vmax, 1)), -1, 1);
      budget.add(-p.hy * wanderF + p.hx * cruiseF, p.hx * wanderF + p.hy * cruiseF);
    }

    p.ax = budget.x;
    p.ay = budget.y;
  }
}

/**
 * Semi-implicit Euler integration for predators, then catch detection.
 * @param {Simulation} sim
 * @param {number} dt
 */
export function integratePredators(sim, dt) {
  const { width, height } = sim;
  for (const p of sim.predators) {
    let vx = p.vx + p.ax * dt;
    let vy = p.vy + p.ay * dt;
    const k = truncationFactor(vx, vy, p.speedLimit);
    vx *= k;
    vy *= k;
    p.vx = vx;
    p.vy = vy;
    p.x = wrapCoord(p.x + vx * dt, width);
    p.y = wrapCoord(p.y + vy * dt, height);
    if (p.state === 'strike') tryCatch(sim, p);
  }
}

/**
 * During a strike, catch the nearest prey within the catch radius.
 * @param {Simulation} sim
 * @param {Predator} p
 */
function tryCatch(sim, p) {
  const PR = sim.predatorRuntime;
  const buf = sim.queryBuffer;
  // Grid bins are from the start of the step; pad the search by the largest
  // per-step displacement, then test the exact radius.
  const count = sim.grid.query(p.x, p.y, PR.catchRadius + 8, -1, buf);
  const r2 = PR.catchRadius * PR.catchRadius;
  let best = -1;
  let bestD2 = r2;
  for (let k = 0; k < count; k++) {
    if (buf.distSq[k] < bestD2) {
      bestD2 = buf.distSq[k];
      best = buf.index[k];
    }
  }
  if (best < 0) return;
  const prey = sim.prey;
  const caught = { id: prey.id[best], species: prey.species[best] };
  const x = prey.x[best];
  const y = prey.y[best];
  p.catches++;
  sim.respawnPrey(best);
  sim.events.emit('catch', { predator: p.id, prey: caught.id, species: caught.species, x, y, time: sim.time });
  sim.recordCatch(x, y);
  startRest(sim, p, PR.minRest * SATIATION);
}
