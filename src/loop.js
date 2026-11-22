/**
 * Fixed-timestep game loop with render interpolation ("fix your timestep").
 *
 * Physics always advances in exact `dt` steps, which keeps it deterministic
 * and keeps the speed/force guarantees exact. Rendering runs once per display
 * frame (60/90/120 Hz) and receives alpha ∈ [0, 1), the fraction of a step
 * accumulated but not yet simulated, for interpolation. Long stalls (a
 * backgrounded tab) are clamped, and when the device cannot keep up the
 * backlog is dropped instead of spiralling.
 *
 * @module loop
 */

/**
 * @typedef {object} FrameInfo
 * @property {number} elapsed Wall time since the previous frame (s, clamped).
 * @property {number} steps Physics steps taken this frame.
 * @property {number} stepMs Time spent in physics (ms).
 * @property {number} renderMs Time spent rendering (ms).
 */

const MAX_FRAME_TIME = 0.25;

export class FixedStepLoop {
  /**
   * @param {object} options
   * @param {number} options.dt Fixed physics step (s).
   * @param {number} [options.maxSubSteps] Most physics steps per frame before dropping the backlog.
   * @param {(dt: number) => void} options.step
   * @param {(alpha: number, now: number) => void} options.render
   * @param {() => boolean} [options.paused]
   * @param {() => number} [options.timeScale]
   * @param {(info: FrameInfo) => void} [options.onFrame]
   */
  constructor({ dt, maxSubSteps = 4, step, render, paused = () => false, timeScale = () => 1, onFrame }) {
    this.dt = dt;
    this.maxSubSteps = maxSubSteps;
    this.step = step;
    this.render = render;
    this.paused = paused;
    this.timeScale = timeScale;
    this.onFrame = onFrame;
    this.accumulator = 0;
    this.last = -1;
    this.rafId = 0;
    this.running = false;
    /** @param {number} now */
    this.frame = (now) => {
      if (!this.running) return;
      this.rafId = requestAnimationFrame(this.frame);
      this.tick(now);
    };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = -1;
    this.rafId = requestAnimationFrame(this.frame);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  /** @param {number} now Frame timestamp (ms). */
  tick(now) {
    const elapsed = this.last < 0 ? 0 : Math.min(MAX_FRAME_TIME, (now - this.last) / 1000);
    this.last = now;
    if (!this.paused()) this.accumulator += elapsed * this.timeScale();

    const t0 = performance.now();
    let steps = 0;
    while (this.accumulator >= this.dt && steps < this.maxSubSteps) {
      this.step(this.dt);
      this.accumulator -= this.dt;
      steps++;
    }
    // Overloaded: keep only the fractional step so interpolation stays smooth.
    if (this.accumulator >= this.dt) this.accumulator %= this.dt;
    const t1 = performance.now();
    this.render(this.accumulator / this.dt, now);
    const t2 = performance.now();
    this.onFrame?.({ elapsed, steps, stepMs: t1 - t0, renderMs: t2 - t1 });
  }
}
