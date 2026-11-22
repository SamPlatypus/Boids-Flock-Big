/**
 * Minimal DOM building helpers (no framework).
 *
 * @module ui/dom
 */

/**
 * @typedef {Record<string, string | number | boolean | null | undefined> & {
 *   on?: Record<string, EventListener>,
 *   text?: string,
 *   class?: string,
 * }} Props
 */

/** @typedef {Node | string | number | null | undefined | false} Child */

/**
 * Create an element. String/number props become attributes (`class`, `aria-*`,
 * `data-*`, …), `true` sets a boolean attribute, null/false/undefined skip it,
 * `text` sets textContent and `on` attaches listeners.
 *
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {Props} [props]
 * @param {...Child} children
 * @returns {HTMLElementTagNameMap[K]}
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'on') {
      for (const [type, listener] of Object.entries(/** @type {Record<string, EventListener>} */ (value))) {
        el.addEventListener(type, listener);
      }
    } else if (key === 'text') {
      el.textContent = String(value);
    } else if (value === true) {
      el.setAttribute(key, '');
    } else if (value !== false && value !== null && value !== undefined) {
      el.setAttribute(key, String(value));
    }
  }
  append(el, children);
  return el;
}

/**
 * @param {Element} parent
 * @param {Child[]} children
 */
export function append(parent, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(typeof child === 'number' ? String(child) : child);
  }
}

/**
 * Inline SVG icon from path data (24 × 24 viewBox, stroked).
 * @param {string} d
 * @returns {SVGSVGElement}
 */
export function icon(d) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
}
