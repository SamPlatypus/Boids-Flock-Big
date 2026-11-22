/**
 * Touch / pointer gestures → simulation API.
 *
 * - Tap (released before the hold delay without moving): scatter pulse.
 * - Press and hold, or drag: a beacon that follows the finger smoothly.
 * - Multi-touch: every pointer is independent. In 'auto' beacon mode one
 *   finger attracts and two or more fingers all become repulsors.
 * - Mouse: left button follows `config.beaconMode`; right button or Shift
 *   forces a repulsor.
 *
 * Uses Pointer Events with pointer capture, so a drag that leaves the canvas
 * keeps tracking. Hold detection is polled from the frame loop (`update`)
 * instead of using timers.
 *
 * @module input/pointer-input
 */

/** @typedef {import('../sim/simulation.js').Simulation} Simulation */
/** @typedef {import('../sim/interactions.js').BeaconMode} BeaconMode */

export const GESTURE = Object.freeze({
  /** A press becomes a beacon after this long (ms). Shorter presses are taps. */
  holdDelayMs: 180,
  /** Movement (CSS px) beyond which a press becomes a drag immediately. */
  tapSlop: 10,
});

/**
 * @typedef {object} TrackedPointer
 * @property {number} id
 * @property {number} startX
 * @property {number} startY
 * @property {number} x
 * @property {number} y
 * @property {number} downTime performance.now() at press.
 * @property {boolean} beacon Whether the press has turned into a beacon.
 * @property {BeaconMode | undefined} mode Forced mode (undefined → config).
 */

export class PointerInput {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {Simulation} sim
   */
  constructor(canvas, sim) {
    this.canvas = canvas;
    this.sim = sim;
    /** @type {Map<number, TrackedPointer>} */
    this.pointers = new Map();

    /** @param {PointerEvent} e */
    this.onDown = (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 2) return;
      e.preventDefault();
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        // Capture can fail for synthetic events; tracking still works.
      }
      const { x, y } = this.toWorld(e);
      const forceRepel = e.pointerType === 'mouse' && (e.button === 2 || e.shiftKey);
      this.pointers.set(e.pointerId, {
        id: e.pointerId,
        startX: x,
        startY: y,
        x,
        y,
        downTime: performance.now(),
        beacon: false,
        mode: forceRepel ? 'repel' : undefined,
      });
    };

    /** @param {PointerEvent} e */
    this.onMove = (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      e.preventDefault();
      const { x, y } = this.toWorld(e);
      p.x = x;
      p.y = y;
      if (!p.beacon && Math.hypot(x - p.startX, y - p.startY) > GESTURE.tapSlop) this.activate(p);
      if (p.beacon) sim.setBeacon(p.id, x, y, p.mode);
    };

    /** @param {PointerEvent} e */
    this.onUp = (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      this.pointers.delete(e.pointerId);
      if (p.beacon) sim.releaseBeacon(p.id);
      else sim.addPulse(p.x, p.y);
    };

    /** @param {PointerEvent} e */
    this.onCancel = (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      this.pointers.delete(e.pointerId);
      if (p.beacon) sim.releaseBeacon(p.id);
    };

    /** @param {Event} e */
    this.onContextMenu = (e) => e.preventDefault();

    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onCancel);
    canvas.addEventListener('lostpointercapture', this.onCancel);
    canvas.addEventListener('contextmenu', this.onContextMenu);
  }

  /**
   * Promote presses held past the hold delay into beacons. Call once per frame.
   * @param {number} now performance.now()
   */
  update(now) {
    for (const p of this.pointers.values()) {
      if (!p.beacon && now - p.downTime >= GESTURE.holdDelayMs) this.activate(p);
    }
  }

  /** @param {TrackedPointer} p */
  activate(p) {
    p.beacon = true;
    this.sim.setBeacon(p.id, p.x, p.y, p.mode);
  }

  /**
   * Client coordinates → world coordinates (CSS px of the canvas).
   * @param {PointerEvent} e
   */
  toWorld(e) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / Math.max(1, rect.width)) * this.sim.width,
      y: ((e.clientY - rect.top) / Math.max(1, rect.height)) * this.sim.height,
    };
  }

  destroy() {
    const canvas = this.canvas;
    canvas.removeEventListener('pointerdown', this.onDown);
    canvas.removeEventListener('pointermove', this.onMove);
    canvas.removeEventListener('pointerup', this.onUp);
    canvas.removeEventListener('pointercancel', this.onCancel);
    canvas.removeEventListener('lostpointercapture', this.onCancel);
    canvas.removeEventListener('contextmenu', this.onContextMenu);
    for (const p of this.pointers.values()) if (p.beacon) this.sim.releaseBeacon(p.id);
    this.pointers.clear();
  }
}
