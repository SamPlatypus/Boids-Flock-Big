/**
 * Config-bound controls. Each control writes to the reactive config and
 * subscribes to it, so changes from anywhere (presets, the console, live
 * population counts) are reflected immediately. Each factory returns
 * `{ element, dispose }`.
 *
 * @module ui/controls
 */

import { normalizeHex } from '../core/color.js';
import { h } from './dom.js';

/** @typedef {import('../config.js').ReactiveConfig} ReactiveConfig */
/** @typedef {import('../config.js').ConfigKey} ConfigKey */
/** @typedef {import('../config.js').ParamSpec} ParamSpec */
/** @typedef {{ element: HTMLElement, dispose: () => void }} Control */

let uid = 0;

/**
 * Subscribe to changes of one key; calls `apply` now and on every change.
 * @param {ReactiveConfig} config
 * @param {ConfigKey} key
 * @param {(value: any) => void} apply
 */
function bind(config, key, apply) {
  apply(config[key]);
  return config.$subscribe((k, value) => {
    if (k === key) apply(value);
  });
}

/**
 * Human-readable value for a parameter.
 * @param {ParamSpec} spec
 * @param {number} value
 */
export function formatValue(spec, value) {
  const step = spec.step ?? 1;
  const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  const text = value.toFixed(decimals);
  if (!spec.unit) return text;
  return spec.unit === '×' ? `${text}×` : `${text} ${spec.unit}`;
}

/**
 * Range slider with a live value readout.
 * @param {ReactiveConfig} config
 * @param {ConfigKey} key
 * @param {{ label?: string, format?: (value: number) => string }} [options]
 * @returns {Control}
 */
export function slider(config, key, options = {}) {
  const spec = config.$schema[key];
  const id = `ctl-${key}-${uid++}`;
  const format = options.format ?? ((/** @type {number} */ v) => formatValue(spec, v));
  const min = spec.min ?? 0;
  const max = spec.max ?? 1;
  const input = h('input', { type: 'range', id, min, max, step: spec.step ?? 'any' });
  const output = h('output', { class: 'ctl-value', for: id });
  const element = h(
    'div',
    { class: 'ctl ctl-slider' },
    h('div', { class: 'ctl-head' }, h('label', { for: id, text: options.label ?? spec.label }), output),
    input,
  );
  element.title = spec.description;
  input.addEventListener('input', () => {
    config[key] = /** @type {never} */ (input.value);
  });
  const dispose = bind(config, key, (value) => {
    input.value = String(value);
    output.textContent = format(value);
    input.style.setProperty('--fill', `${((value - min) / (max - min)) * 100}%`);
  });
  return { element, dispose };
}

/**
 * On/off switch.
 * @param {ReactiveConfig} config
 * @param {ConfigKey} key
 * @param {{ label?: string, note?: string }} [options]
 * @returns {Control}
 */
export function toggle(config, key, options = {}) {
  const spec = config.$schema[key];
  const id = `ctl-${key}-${uid++}`;
  const label = h('span', { class: 'ctl-label', id }, options.label ?? spec.label, options.note ? h('small', { text: options.note }) : null);
  const button = h('button', { type: 'button', class: 'switch', role: 'switch', 'aria-labelledby': id });
  button.addEventListener('click', () => {
    config[key] = /** @type {never} */ (!config[key]);
  });
  const element = h('div', { class: 'ctl ctl-toggle' }, label, button);
  const dispose = bind(config, key, (value) => button.setAttribute('aria-checked', String(Boolean(value))));
  return { element, dispose };
}

/**
 * − count + stepper. Press and hold repeats, accelerating.
 * @param {ReactiveConfig} config
 * @param {ConfigKey} key
 * @param {{ label?: string, step: number, color?: () => string }} options
 * @returns {Control}
 */
export function stepper(config, key, options) {
  const spec = config.$schema[key];
  const label = options.label ?? spec.label;
  const dot = h('i', { class: 'swatch-dot' });
  const count = h('output', { class: 'step-count', 'aria-live': 'off' });
  const minus = h('button', { type: 'button', class: 'step-btn', 'aria-label': `Fewer ${label}`, text: '−' });
  const plus = h('button', { type: 'button', class: 'step-btn', 'aria-label': `More ${label}`, text: '+' });
  const element = h(
    'div',
    { class: 'ctl ctl-stepper' },
    h('span', { class: 'ctl-label' }, dot, label),
    minus,
    count,
    plus,
  );

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  let repeats = 0;
  /** @param {number} direction */
  const nudge = (direction) => {
    const factor = repeats > 12 ? 5 : repeats > 5 ? 2 : 1;
    config[key] = /** @type {never} */ (Number(config[key]) + direction * options.step * factor);
  };
  const stop = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  /**
   * @param {HTMLButtonElement} button
   * @param {number} direction
   */
  const wire = (button, direction) => {
    button.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      repeats = 0;
      nudge(direction);
      const repeat = () => {
        repeats++;
        nudge(direction);
        timer = setTimeout(repeat, 70);
      };
      stop();
      timer = setTimeout(repeat, 380);
    });
    for (const type of ['pointerup', 'pointerleave', 'pointercancel']) button.addEventListener(type, stop);
    // Keyboard activation (Enter / Space) arrives as a click with detail 0.
    button.addEventListener('click', (e) => {
      if (e.detail === 0) nudge(direction);
    });
  };
  wire(minus, -1);
  wire(plus, 1);

  const disposeValue = bind(config, key, (value) => {
    count.textContent = String(value);
    minus.disabled = value <= (spec.min ?? 0);
    plus.disabled = value >= (spec.max ?? Infinity);
  });
  const refreshColor = () => {
    if (options.color) dot.style.color = dot.style.background = options.color();
  };
  refreshColor();
  const disposeColor = config.$subscribe((k) => {
    if (k.startsWith('color')) refreshColor();
  });
  return {
    element,
    dispose: () => {
      stop();
      disposeValue();
      disposeColor();
    },
  };
}

/**
 * Segmented single-choice control for an enum parameter.
 * @param {ReactiveConfig} config
 * @param {ConfigKey} key
 * @param {{ label: string, value: string }[]} choices
 * @returns {Control}
 */
export function segmented(config, key, choices) {
  const spec = config.$schema[key];
  const group = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': spec.label });
  const buttons = choices.map((choice) => {
    const button = h('button', { type: 'button', role: 'radio', text: choice.label });
    button.addEventListener('click', () => {
      config[key] = /** @type {never} */ (choice.value);
    });
    group.append(button);
    return button;
  });
  const element = h('div', { class: 'ctl' }, h('div', { class: 'ctl-head' }, h('span', { class: 'ctl-label', text: spec.label })), group);
  const dispose = bind(config, key, (value) => {
    buttons.forEach((button, i) => button.setAttribute('aria-checked', String(choices[i].value === value)));
  });
  return { element, dispose };
}

/**
 * Colour field: native picker swatch plus a hex text input.
 * @param {ReactiveConfig} config
 * @param {ConfigKey} key
 * @param {{ label?: string }} [options]
 * @returns {Control}
 */
export function colorField(config, key, options = {}) {
  const spec = config.$schema[key];
  const label = options.label ?? spec.label;
  const picker = h('input', { type: 'color', 'aria-label': `${label} colour picker` });
  const hex = h('input', {
    type: 'text',
    class: 'hex-input',
    inputmode: 'text',
    maxlength: 7,
    spellcheck: 'false',
    autocomplete: 'off',
    'aria-label': `${label} hex colour`,
  });
  const element = h(
    'div',
    { class: 'ctl ctl-color' },
    h('span', { class: 'ctl-label', text: label }),
    h('span', { class: 'color-swatch' }, picker),
    hex,
  );
  picker.addEventListener('input', () => {
    config[key] = /** @type {never} */ (picker.value);
  });
  const commit = () => {
    const value = normalizeHex(hex.value);
    if (value) {
      hex.setAttribute('aria-invalid', 'false');
      config[key] = /** @type {never} */ (value);
    } else {
      hex.setAttribute('aria-invalid', 'true');
    }
  };
  hex.addEventListener('input', () => {
    if (normalizeHex(hex.value) && hex.value.replace('#', '').length === 6) commit();
    else hex.setAttribute('aria-invalid', String(!normalizeHex(hex.value)));
  });
  hex.addEventListener('change', commit);
  hex.addEventListener('blur', () => {
    hex.value = String(config[key]);
    hex.setAttribute('aria-invalid', 'false');
  });
  const dispose = bind(config, key, (value) => {
    picker.value = value;
    if (document.activeElement !== hex) hex.value = value;
  });
  return { element, dispose };
}
