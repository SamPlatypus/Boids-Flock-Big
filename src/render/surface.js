/**
 * Full-bleed canvas surface with devicePixelRatio-aware sizing.
 *
 * The backing store is kept at (CSS size × pixel ratio) device pixels and the
 * context transform maps one world unit to one CSS pixel. Drawing is therefore
 * sharp on every screen, and physics is identical across devices.
 *
 * Where supported, ResizeObserver's `device-pixel-content-box` gives the exact
 * device-pixel size. This avoids the slight blur of rounding CSS × DPR on
 * fractional-DPR phones (e.g. 2.625). A `resolution` media query also catches
 * DPR changes from browser zoom or moving the window to another display.
 *
 * @module render/surface
 */

export class CanvasSurface {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {() => number} getMaxPixelRatio Upper bound on the pixel ratio (performance cap).
   */
  constructor(canvas, getMaxPixelRatio) {
    // Transparent: the vignette behind the canvas is its CSS background (see
    // Renderer.updateBackdrop), so a frame starts with a cheap clearRect.
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is not supported in this browser.');
    this.canvas = canvas;
    this.ctx = ctx;
    this.getMaxPixelRatio = getMaxPixelRatio;
    /** World/CSS width and height. */
    this.width = 0;
    this.height = 0;
    /** Pixel ratio in use (device px per CSS px). */
    this.pixelRatio = 1;
    /** Exact backing-store scale per axis (device px per CSS px after rounding). */
    this.scaleX = 1;
    this.scaleY = 1;
    /** @type {((width: number, height: number) => void) | null} */
    this.onResize = null;
    /** @type {[number, number] | null} Exact device-pixel size from ResizeObserver. */
    this.devicePixelSize = null;

    this.observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      const box = entry.devicePixelContentBoxSize?.[0];
      this.devicePixelSize = box ? [box.inlineSize, box.blockSize] : null;
      this.measure();
    });
    try {
      this.observer.observe(canvas, { box: 'device-pixel-content-box' });
    } catch {
      this.observer.observe(canvas);
    }

    /** @type {MediaQueryList | null} */
    this.ratioQuery = null;
    this.onRatioChange = () => {
      this.devicePixelSize = null; // stale until the observer reports again
      this.measure();
      this.watchPixelRatio();
    };
    this.watchPixelRatio();
    this.measure();
  }

  /** Re-arm the media query that fires when devicePixelRatio changes. */
  watchPixelRatio() {
    this.ratioQuery?.removeEventListener('change', this.onRatioChange);
    this.ratioQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    this.ratioQuery.addEventListener('change', this.onRatioChange);
  }

  /** Sync the backing store with the element size; notifies `onResize` on change. */
  measure() {
    const canvas = this.canvas;
    const rect = canvas.getBoundingClientRect();
    const cssWidth = Math.max(1, rect.width);
    const cssHeight = Math.max(1, rect.height);
    const native = window.devicePixelRatio || 1;
    const ratio = Math.min(native, this.getMaxPixelRatio());

    let pixelWidth = Math.round(cssWidth * ratio);
    let pixelHeight = Math.round(cssHeight * ratio);
    // Prefer the exact device-pixel box, but only when it agrees with CSS × DPR
    // (some emulators and embedded webviews report it at the wrong scale).
    const exact = this.devicePixelSize;
    if (exact && ratio === native && Math.abs(exact[0] - pixelWidth) <= 2 && Math.abs(exact[1] - pixelHeight) <= 2) {
      [pixelWidth, pixelHeight] = exact;
    }
    pixelWidth = Math.max(1, pixelWidth);
    pixelHeight = Math.max(1, pixelHeight);
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;

    this.pixelRatio = ratio;
    this.scaleX = pixelWidth / cssWidth;
    this.scaleY = pixelHeight / cssHeight;
    const changed = cssWidth !== this.width || cssHeight !== this.height;
    this.width = cssWidth;
    this.height = cssHeight;
    if (changed) this.onResize?.(cssWidth, cssHeight);
  }

  destroy() {
    this.observer.disconnect();
    this.ratioQuery?.removeEventListener('change', this.onRatioChange);
  }
}
