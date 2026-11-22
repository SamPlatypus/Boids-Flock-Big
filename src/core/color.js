/**
 * Colour helpers shared by config validation, the renderer and the UI.
 * Colours are '#rrggbb' strings at the API boundary and [r, g, b] (0–255)
 * triples internally.
 *
 * @module core/color
 */

/** @typedef {[number, number, number]} RGB */

/**
 * Normalise a user-supplied hex colour ('#abc', 'abc', '#AABBCC', …).
 * @param {unknown} value
 * @returns {string | null} Lower-case '#rrggbb', or null if not a hex colour.
 */
export function normalizeHex(value) {
  if (typeof value !== 'string') return null;
  let hex = value.trim().toLowerCase();
  if (hex.startsWith('#')) hex = hex.slice(1);
  if (/^[0-9a-f]{3}$/.test(hex)) hex = hex.replace(/./g, (c) => c + c);
  return /^[0-9a-f]{6}$/.test(hex) ? `#${hex}` : null;
}

/**
 * @param {string} hex '#rrggbb'
 * @returns {RGB}
 */
export function hexToRgb(hex) {
  const v = parseInt(hex.slice(1, 7), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/**
 * @param {RGB} rgb
 * @returns {string} '#rrggbb'
 */
export function rgbToHex([r, g, b]) {
  const to = (/** @type {number} */ c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

/**
 * Linear blend of two colours.
 * @param {string} a
 * @param {string} b
 * @param {number} t 0 → a, 1 → b.
 * @returns {string}
 */
export function mixHex(a, b, t) {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  return rgbToHex([ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t, ca[2] + (cb[2] - ca[2]) * t]);
}

/**
 * Multiply every channel (> 1 brightens, < 1 darkens). Pure black stays black,
 * so "true OLED black" backgrounds survive vignetting.
 * @param {string} hex
 * @param {number} factor
 * @returns {string}
 */
export function scaleHex(hex, factor) {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex([r * factor, g * factor, b * factor]);
}

/**
 * @param {string} hex
 * @param {number} alpha 0–1
 * @returns {string} CSS rgba().
 */
export function rgba(hex, alpha) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${Math.min(1, Math.max(0, alpha)).toFixed(3)})`;
}

/**
 * WCAG relative luminance (0 = black, 1 = white).
 * @param {string} hex
 * @returns {number}
 */
export function luminance(hex) {
  const lin = hexToRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}
