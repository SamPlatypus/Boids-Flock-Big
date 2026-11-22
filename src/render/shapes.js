/**
 * Agent silhouettes as flat [x0, y0, x1, y1, …] polygons in body coordinates:
 * +x points forward (the nose sits at x = 0.5), +y to the agent's right, and
 * one unit is one body length. The renderer rotates them onto the velocity
 * heading θ = atan2(vy, vx), using cos θ = vx/|v| and sin θ = vy/|v|, so no
 * trigonometry is needed per agent.
 *
 * @module render/shapes
 */

/** Slim, notched arrowhead: fast and agile. */
export const DART_SHAPE = Object.freeze([0.5, 0, -0.5, 0.21, -0.3, 0, -0.5, -0.21]);

/** Manta ray: cephalic fins, broad swept-back wings, concave trailing edge, whip tail. */
export const MANTA_SHAPE = Object.freeze([
  0.42, 0, 0.5, 0.09, 0.34, 0.2, 0.14, 0.44, -0.08, 0.66, -0.13, 0.48, -0.21, 0.28, -0.3, 0.09,
  -0.62, 0.015, -0.62, -0.015, -0.3, -0.09, -0.21, -0.28, -0.13, -0.48, -0.08, -0.66, 0.14, -0.44,
  0.34, -0.2, 0.5, -0.09,
]);

/** Blunt kite with a forked tail. */
export const FORAGER_SHAPE = Object.freeze([0.5, 0, 0.02, 0.27, -0.5, 0.25, -0.3, 0, -0.5, -0.25, 0.02, -0.27]);

/** Long, sharp shark silhouette: pointed snout, swept-back pectoral fins, forked tail. */
export const PREDATOR_SHAPE = Object.freeze([
  0.5, 0, 0.3, 0.075, 0.1, 0.1, -0.12, 0.27, -0.08, 0.085, -0.32, 0.05, -0.5, 0.18, -0.42, 0,
  -0.5, -0.18, -0.32, -0.05, -0.08, -0.085, -0.12, -0.27, 0.1, -0.1, 0.3, -0.075,
]);

/** Silhouette per prey species index (same order as SPECIES). */
export const SPECIES_SHAPES = Object.freeze([DART_SHAPE, MANTA_SHAPE, FORAGER_SHAPE]);

/**
 * Largest vertex distance from the origin, in body lengths. Used to decide
 * when an agent is close enough to an edge to need a wrapped ghost copy.
 * @param {readonly number[]} shape
 * @returns {number}
 */
export function shapeRadius(shape) {
  let r = 0;
  for (let i = 0; i < shape.length; i += 2) r = Math.max(r, Math.hypot(shape[i], shape[i + 1]));
  return r;
}
