/**
 * Toroidal (periodic) geometry for a W × H world.
 *
 * The world is the flat torus [0, W) × [0, H) with opposite edges identified.
 * Every point has infinitely many images (x + kW, y + mH); the distance between
 * two points is the distance between their closest images. Along one axis the
 * closest-image ("minimum image") displacement is
 *
 *     Δ' = Δ − L · round(Δ / L),      Δ' ∈ [−L/2, L/2)
 *
 * All flocking, flee and pursuit maths goes through these helpers, so agents
 * behave identically on both sides of every edge.
 *
 * @module core/torus
 */

/**
 * Minimum-image displacement along one periodic axis.
 * `Math.round` rounds halves towards +∞, so the result is in [−L/2, L/2).
 *
 * @param {number} delta Raw difference (b − a).
 * @param {number} length Period L > 0.
 * @returns {number} The equivalent displacement of smallest magnitude.
 */
export function wrapDelta(delta, length) {
  return delta - length * Math.round(delta / length);
}

/**
 * Wrap a coordinate into the half-open interval [0, L): x mod L.
 *
 * @param {number} value Any finite coordinate.
 * @param {number} length Period L > 0.
 * @returns {number} Equivalent coordinate in [0, L).
 */
export function wrapCoord(value, length) {
  let r = value % length;
  if (r < 0) r += length;
  // For tiny negative inputs `r + length` rounds up to exactly `length`; fold it
  // back to 0. Adding 0 also normalises -0 to +0.
  return r >= length ? 0 : r + 0;
}

/**
 * Squared minimum-image distance between two points.
 *
 * @param {number} ax
 * @param {number} ay
 * @param {number} bx
 * @param {number} by
 * @param {number} width
 * @param {number} height
 * @returns {number}
 */
export function torusDistanceSq(ax, ay, bx, by, width, height) {
  const dx = wrapDelta(bx - ax, width);
  const dy = wrapDelta(by - ay, height);
  return dx * dx + dy * dy;
}

/**
 * Interpolate from a to b along the shortest path across the seam, so a value
 * that just wrapped from W−ε to +ε moves forward instead of sweeping back
 * across the whole axis.
 *
 * @param {number} a Start coordinate in [0, L).
 * @param {number} b End coordinate in [0, L).
 * @param {number} t Interpolation factor in [0, 1].
 * @param {number} length Period L.
 * @returns {number} Interpolated coordinate in [0, L).
 */
export function lerpWrapped(a, b, t, length) {
  return wrapCoord(a + wrapDelta(b - a, length) * t, length);
}
