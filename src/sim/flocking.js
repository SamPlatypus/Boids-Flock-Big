/**
 * Prey steering and integration.
 *
 * Steering (per agent, one spatial-hash query):
 *
 * Every rule is a smooth function of neighbour distance, so agents entering or
 * leaving a radius never cause force discontinuities (jitter):
 *
 *   separation  s = Σ (1 − d/r)² · û_away                     (omnidirectional)
 *   alignment   a = Σ k_j (v_j − v) / (Σ k_j + c₀)            (soft mean, → 0 as Σk → 0)
 *   cohesion    c = Σ k_j Δx_j / (Σ k_j + c₀)                 (soft local centre)
 *   kernel      k_j = (1 − d²/R²)² · fov(θ_j)                 (C¹, compact support)
 *
 * The "+ c₀" counts the agent itself in the neighbourhood means, which keeps
 * them continuous when the first neighbour appears.
 *
 * Forces are combined with Reynolds' prioritized acceleration allocation
 * (`ForceBudget`):
 *
 *   1. emergency: flee threats + remembered escape heading + alarm-wave alignment
 *   2. separation
 *   3. alignment, cohesion, grazing, wander, cruise-speed control, attractor beacons
 *
 * so fleeing overrides alignment and cohesion, as panic waves require.
 *
 * Grazing (life cycle on): an agent seeks the nearest food particle within
 * perception × forageRange with weight ∝ hunger², where hunger = 1 − energy.
 * A well-fed agent stays with its school; a starving one breaks away to feed.
 * Panic suppresses grazing.
 *
 * Genes: each agent's heritable speed and perception multipliers scale its
 * speed limit, cruise speed and sensing radius.
 *
 * Panic contagion: panic_i rises toward max(direct threat, transmission × max
 * neighbour panic) with a first-order lag, then decays linearly. The lag (rise
 * rate) sets the speed of the shockwave travelling through the flock;
 * transmission < 1 makes it fade with distance. Panic is double-buffered
 * (Jacobi update), so the result does not depend on agent order.
 *
 * Integration: semi-implicit (symplectic) Euler with a fixed dt:
 *
 *   v' = clamp(v + a·dt, v_max),   x' = wrap(x + v'·dt)
 *
 * Guarantees, every agent, every step:
 *   (I1) |v'| ≤ v_max: the speed cap is a hard clamp.
 *   (I2) |v' − v| ≤ F_max·dt: the turning limit is never exceeded.
 * Proof of I2: |a| ≤ budget ≤ F_max by construction. If v_max did not drop,
 * v lies inside the disk of radius v_max and the radial clamp is a metric
 * projection onto a convex set, hence non-expansive: |v' − v| ≤ |a|·dt. If
 * v_max dropped by δ (rate-limited to ½F_max·dt), the budget is reduced to
 * F_max − δ/dt, and |v' − v| ≤ |a|·dt + δ ≤ F_max·dt.
 *
 * @module sim/flocking
 */

import { ForceBudget, clamp, expBlend, nextSpeedLimit, smoothstep, truncationFactor } from '../core/math.js';
import { wrapCoord } from '../core/torus.js';

/** @typedef {import('./simulation.js').Simulation} Simulation */

/** c₀: weight of the agent itself in the soft neighbourhood means. */
const SELF_WEIGHT = 0.6;
/** Rate (1/s) at which an agent adopts alarm; sets the shockwave speed. */
const PANIC_RISE_RATE = 16;
/** Neighbours calmer than this do not spread alarm (prevents lingering low-level noise). */
const PANIC_SOCIAL_MIN = 0.12;
/** Alarm from other species is discounted. */
const CROSS_SPECIES_ALARM = 0.7;
/** Rate (1/s) at which the remembered escape heading follows the current threat. */
const ESCAPE_MEMORY_RATE = 8;
/** Alignment reaches full force at a velocity mismatch of v_max / ALIGN_GAIN. */
const ALIGN_GAIN = 1.6;
/** Alarm-wave alignment gain (copying panicked neighbours' escape velocity). */
const ALARM_ALIGN_GAIN = 1.2;
/** Cohesion urgency saturates when the local centre is this fraction of R away. */
const COHESION_REACH = 0.5;
/** Strength of cruise-speed regulation relative to the force limit. */
const CRUISE_GAIN = 0.6;
/** Weight of attractor beacons relative to the force limit. */
const ATTRACT_WEIGHT = 1.3;
/** Adrenaline: force limit × (1 + PANIC_FORCE_BOOST · panic). */
const PANIC_FORCE_BOOST = 0.5;
/** Burst: force limit × (1 + BURST_FORCE_BOOST · burst). */
const BURST_FORCE_BOOST = 0.5;
/** Max fraction of the force budget spent tracking a falling speed limit. */
const SPEED_LIMIT_DROP = 0.5;

const budget = new ForceBudget();

/**
 * Compute steering accelerations, effective limits and next panic levels for
 * all prey. Reads only state from the previous step (Jacobi), so agent order
 * does not matter. Requires the grid to be built for this step.
 *
 * @param {Simulation} sim
 * @param {number} dt
 */
export function computePreySteering(sim, dt) {
  const prey = sim.prey;
  const n = prey.count;
  const grid = sim.grid;
  const nb = sim.neighborBuffer;
  const rng = sim.rng;
  const runtime = sim.speciesRuntime;
  const { x, y, vx, vy, hx, hy, ax, ay, species, panic, panicNext, wander, burst } = prey;
  const { speedLimit, forceLimit, escapeX, escapeY, threatX, threatY, threat, attractX, attractY, crowding } = prey;
  const { energy, geneSpeed, genePerception, foodTarget, foodTargetId } = prey;
  const food = sim.food;
  const grazing = sim.config.ecosystem && food.count > 0;
  const nbIndex = nb.index;
  const nbDx = nb.dx;
  const nbDy = nb.dy;
  const nbD2 = nb.distSq;
  const riseK = expBlend(PANIC_RISE_RATE, dt);
  const escapeK = expBlend(ESCAPE_MEMORY_RATE, dt);
  const sqrtDt = Math.sqrt(dt);

  for (let i = 0; i < n; i++) {
    const s = species[i];
    const P = runtime[s];
    foodTarget[i] = -1;
    const vxi = vx[i];
    const vyi = vy[i];
    const speed = Math.sqrt(vxi * vxi + vyi * vyi);
    let hxi = hx[i];
    let hyi = hy[i];
    if (speed > 1e-6) {
      hxi = vxi / speed; // θ = atan2(vy, vx) ⇔ (cos θ, sin θ) = v / |v|
      hyi = vyi / speed;
      hx[i] = hxi;
      hy[i] = hyi;
    }
    const p = panic[i];

    // ── Private stochastic state (never read by neighbours) ─────────────────
    // Wander: Ornstein–Uhlenbeck process with unit stationary variance.
    let w = wander[i] - P.wanderRate * wander[i] * dt + P.wanderSigma * sqrtDt * rng.gaussian();
    let b = burst[i] * P.burstDecay;
    if (P.burstRate > 0 && rng.next() < P.burstRate * (1 + 2 * p) * dt) {
      b = 1; // Poisson burst onset: sprint + sudden heading change
      w += rng.next() < 0.5 ? -P.burstKick : P.burstKick;
    }
    wander[i] = w;
    burst[i] = b;

    // ── Effective limits ────────────────────────────────────────────────────
    const fmax = P.maxForce * (1 + PANIC_FORCE_BOOST * p + BURST_FORCE_BOOST * b);
    // Heritable genes scale this individual's speed and sensing range.
    const gs = geneSpeed[i];
    const baseCruise = P.cruiseSpeed * gs;
    const vTarget = P.maxSpeed * gs * (1 + (P.frightSpeed - 1) * p) * (1 + P.burstBoost * b);
    const vPrev = speedLimit[i];
    const vmax = nextSpeedLimit(vPrev, vTarget, SPEED_LIMIT_DROP * fmax * dt);
    speedLimit[i] = vmax;
    forceLimit[i] = fmax;
    const cruise = Math.min(vmax, baseCruise * (1 + P.burstBoost * b) + (vmax - baseCruise) * p);

    // ── Neighbourhood scan ──────────────────────────────────────────────────
    const perception = P.perception * genePerception[i];
    const count = grid.query(x[i], y[i], Math.max(perception, P.separationQuery), i, nb);
    const expand = 1 + P.flashExpansion * p;
    const sepRadius = P.separationRadius;
    const R2 = perception * perception;
    const invR2 = 1 / R2;
    const fovLow = P.fovCosLow;
    const fovHigh = P.fovCosHigh;
    let sepX = 0;
    let sepY = 0;
    let aliX = 0;
    let aliY = 0;
    let cohX = 0;
    let cohY = 0;
    let kSum = 0;
    let alarm = 0;
    let alarmVx = 0;
    let alarmVy = 0;
    let alarmW = 0;
    let crowd = 0;

    for (let k = 0; k < count; k++) {
      const j = nbIndex[k];
      const dx = nbDx[k];
      const dy = nbDy[k];
      const d2 = nbD2[k];
      const sj = species[j];
      let d = -1;

      const rs = sepRadius[sj] * expand;
      if (d2 < rs * rs) {
        if (d2 > 1e-12) {
          d = Math.sqrt(d2);
          const q = 1 - d / rs;
          const wq = (q * q) / d; // (1 − d/r)² times the unit vector
          sepX -= dx * wq;
          sepY -= dy * wq;
        } else {
          // Coincident: push sideways, in opposite directions for i and j.
          const side = i < j ? 1 : -1;
          sepX -= hyi * side;
          sepY += hxi * side;
        }
      }

      if (d2 < R2) {
        crowd++;
        const pj = panic[j];
        const heard = sj === s ? pj : pj * CROSS_SPECIES_ALARM;
        if (heard > alarm) alarm = heard;
        if (sj === s) {
          if (d < 0) d = Math.sqrt(d2);
          const visible = d > 1e-9 ? smoothstep(fovLow, fovHigh, (dx * hxi + dy * hyi) / d) : 1;
          if (visible > 0) {
            const q = 1 - d2 * invR2;
            const kj = q * q * visible;
            const vxj = vx[j];
            const vyj = vy[j];
            aliX += kj * (vxj - vxi);
            aliY += kj * (vyj - vyi);
            cohX += kj * dx;
            cohY += kj * dy;
            kSum += kj;
            if (pj > 0) {
              const pk = kj * pj;
              alarmVx += pk * vxj;
              alarmVy += pk * vyj;
              alarmW += pk;
            }
          }
        }
      }
    }
    crowding[i] = crowd;

    // ── Panic contagion (written to the back buffer) ────────────────────────
    const social = alarm > PANIC_SOCIAL_MIN ? alarm * P.alarmTransmission : 0;
    const stimulus = Math.max(threat[i], social);
    panicNext[i] = stimulus > p ? p + (stimulus - p) * riseK : Math.max(stimulus, p - P.panicDecay * dt);

    // ── Prioritized force allocation ────────────────────────────────────────
    budget.reset(fmax - Math.max(0, vPrev - vmax) / dt);

    // 1. Emergency: flee + escape memory + alarm-wave alignment.
    const tx = threatX[i];
    const ty = threatY[i];
    const tMag = Math.sqrt(tx * tx + ty * ty);
    let ex = escapeX[i];
    let ey = escapeY[i];
    if (tMag > 1e-6) {
      ex += (tx / tMag - ex) * escapeK;
      ey += (ty / tMag - ey) * escapeK;
      const eMag = Math.sqrt(ex * ex + ey * ey);
      if (eMag > 1e-6) {
        ex /= eMag;
        ey /= eMag;
      }
      escapeX[i] = ex;
      escapeY[i] = ey;
    }
    let fx = P.flee * tx + P.scatter * p * ex;
    let fy = P.flee * ty + P.scatter * p * ey;
    if (alarmW > 1e-6 && p > 0.05) {
      // Copy the escape velocity of panicked neighbours: carries the threat's
      // direction beyond the distance where the threat itself is visible.
      const g = (p * ALARM_ALIGN_GAIN * (alarmW / (alarmW + SELF_WEIGHT))) / vmax;
      fx += (alarmVx / alarmW - vxi) * g;
      fy += (alarmVy / alarmW - vyi) * g;
    }
    const fk = truncationFactor(fx, fy, 1) * fmax;
    budget.add(fx * fk, fy * fk);

    // 2. Separation (collision avoidance); stronger when panicked.
    if (budget.remaining > 0 && (sepX !== 0 || sepY !== 0)) {
      const sk = truncationFactor(sepX, sepY, 1) * fmax * P.wSeparation * (1 + 0.5 * p);
      budget.add(sepX * sk, sepY * sk);
    }

    // 3. Flocking + locomotion.
    if (budget.remaining > 0) {
      let gx = 0;
      let gy = 0;
      if (kSum > 0) {
        const denom = kSum + SELF_WEIGHT;
        // Alignment: match the soft-mean neighbour velocity (suppressed by panic).
        const wAli = P.wAlignment * (1 - 0.7 * p);
        if (wAli > 0) {
          const rx = (aliX / denom) * (ALIGN_GAIN / vmax);
          const ry = (aliY / denom) * (ALIGN_GAIN / vmax);
          const ak = truncationFactor(rx, ry, 1) * fmax * wAli;
          gx += rx * ak;
          gy += ry * ak;
        }
        // Cohesion: seek the soft local centre at cruise speed; urgency grows
        // with its offset. Panic compacts (bait ball) or scatters per species.
        const wCoh = P.wCohesion * Math.max(0, 1 + P.panicCohesion * p);
        if (wCoh > 0) {
          const cx = cohX / denom;
          const cy = cohY / denom;
          const cMag = Math.sqrt(cx * cx + cy * cy);
          if (cMag > 1e-6) {
            const urgency = Math.min(1, cMag / (COHESION_REACH * perception));
            const sx = ((cx / cMag) * cruise - vxi) / vmax;
            const sy = ((cy / cMag) * cruise - vyi) / vmax;
            const ck = truncationFactor(sx, sy, 1) * fmax * wCoh * urgency;
            gx += sx * ck;
            gy += sy * ck;
          }
        }
      }
      // Wander: smooth random lateral force.
      const wf = P.wanderStrength * fmax * w;
      gx -= hyi * wf;
      gy += hxi * wf;
      // Cruise control along the heading.
      const cf = CRUISE_GAIN * fmax * clamp((cruise - speed) / (0.25 * vmax), -1, 1);
      gx += hxi * cf;
      gy += hyi * cf;
      // Grazing: hungry agents peel away from the school towards the nearest
      // food, more urgently the emptier they are (and not while panicking).
      if (grazing) {
        const hunger = 1 - energy[i];
        if (hunger > 0.02 && p < 0.5) {
          const f = food.nearest(x[i], y[i], perception * P.forageRange);
          if (f >= 0) {
            foodTarget[i] = f;
            foodTargetId[i] = food.id[f];
            const fdx = food.nearestBuffer.dx[0];
            const fdy = food.nearestBuffer.dy[0];
            const fd = Math.sqrt(fdx * fdx + fdy * fdy);
            if (fd > 1e-6) {
              const sx = ((fdx / fd) * cruise - vxi) / vmax;
              const sy = ((fdy / fd) * cruise - vyi) / vmax;
              const fk = truncationFactor(sx, sy, 1) * fmax * P.forage * hunger * hunger * (1 - 2 * p);
              gx += sx * fk;
              gy += sy * fk;
            }
          }
        }
      }
      // Attractor beacons.
      const atx = attractX[i];
      const aty = attractY[i];
      if (atx !== 0 || aty !== 0) {
        const tk = truncationFactor(atx, aty, 1) * fmax * ATTRACT_WEIGHT;
        gx += atx * tk;
        gy += aty * tk;
      }
      budget.add(gx, gy);
    }

    ax[i] = budget.x;
    ay[i] = budget.y;
  }
}

/**
 * Semi-implicit Euler step for all prey, then publish the new panic levels.
 * @param {Simulation} sim
 * @param {number} dt
 */
export function integratePrey(sim, dt) {
  const prey = sim.prey;
  const n = prey.count;
  const W = sim.width;
  const H = sim.height;
  const { x, y, vx, vy, ax, ay, speedLimit, age } = prey;
  for (let i = 0; i < n; i++) {
    let nvx = vx[i] + ax[i] * dt;
    let nvy = vy[i] + ay[i] * dt;
    const limit = speedLimit[i];
    const s2 = nvx * nvx + nvy * nvy;
    if (s2 > limit * limit) {
      const k = limit / Math.sqrt(s2);
      nvx *= k;
      nvy *= k;
    }
    vx[i] = nvx;
    vy[i] = nvy;
    x[i] = wrapCoord(x[i] + nvx * dt, W);
    y[i] = wrapCoord(y[i] + nvy * dt, H);
    age[i] += dt;
  }
  prey.swapPanic();
}
