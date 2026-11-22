/**
 * Small scalar helpers. Vectors are passed as separate x/y numbers throughout
 * the engine so the per-agent hot loops never allocate.
 *
 * @module core/math
 */

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

/**
 * @param {number} a
 * @param {number} b
 * @param {number} t
 * @returns {number}
 */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Hermite smoothstep: 0 below edge0, 1 above edge1, C¹-continuous in between.
 *
 * @param {number} edge0
 * @param {number} edge1
 * @param {number} x
 * @returns {number}
 */
export function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Scale factor s ∈ [0, 1] such that |(x, y)| · s ≤ max. This is the
 * allocation-free form of Reynolds' `truncate(v, max)`: multiply both
 * components by the returned factor.
 *
 * @param {number} x
 * @param {number} y
 * @param {number} max Maximum allowed length (≥ 0).
 * @returns {number}
 */
export function truncationFactor(x, y, max) {
  const lengthSq = x * x + y * y;
  return lengthSq > max * max ? max / Math.sqrt(lengthSq) : 1;
}

/**
 * Per-step blend factor for exponential smoothing at `rate` (1/s):
 * value += (target − value) · expBlend(rate, dt). Frame-rate independent.
 *
 * @param {number} rate
 * @param {number} dt
 * @returns {number}
 */
export function expBlend(rate, dt) {
  return 1 - Math.exp(-rate * dt);
}

/**
 * Reynolds' prioritized acceleration allocation (Reynolds 1987; Buckland's
 * "prioritized truncated running sum").
 *
 * Steering requests are added in priority order. Each consumes budget equal to
 * its magnitude; the request that exceeds the remaining budget is truncated
 * and later ones get nothing. By the triangle inequality the resulting
 * acceleration never exceeds the initial budget, which is how `maxForce` is
 * enforced exactly. High-priority urges (fleeing, collision avoidance)
 * override low-priority ones (alignment, cohesion) when they compete.
 */
export class ForceBudget {
  constructor() {
    this.x = 0;
    this.y = 0;
    this.remaining = 0;
  }

  /** @param {number} budget Maximum total acceleration magnitude. */
  reset(budget) {
    this.x = 0;
    this.y = 0;
    this.remaining = budget > 0 ? budget : 0;
  }

  /**
   * @param {number} fx
   * @param {number} fy
   */
  add(fx, fy) {
    const remaining = this.remaining;
    if (remaining <= 0) return;
    const lengthSq = fx * fx + fy * fy;
    if (lengthSq === 0) return;
    let magnitude = Math.sqrt(lengthSq);
    if (magnitude > remaining) {
      const k = remaining / magnitude;
      fx *= k;
      fy *= k;
      magnitude = remaining;
    }
    this.x += fx;
    this.y += fy;
    this.remaining = remaining - magnitude;
  }
}

/**
 * Next speed limit for an agent whose target limit may have changed.
 *
 * Raising a limit is applied instantly. Lowering it is rate-limited to
 * `maxDrop` per step, so the agent can always decelerate to the new limit
 * without exceeding its force limit (see the integrator notes in flocking.js).
 *
 * @param {number} current Limit used on the previous step.
 * @param {number} target Desired limit for this step.
 * @param {number} maxDrop Largest allowed decrease this step (≥ 0).
 * @returns {number}
 */
export function nextSpeedLimit(current, target, maxDrop) {
  if (target >= current) return target;
  return Math.max(target, current - maxDrop);
}
