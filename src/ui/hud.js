/**
 * Glassmorphic HUD: a floating status pill that expands into a bottom drawer
 * with four tabs. Flock (behaviour sliders, touch settings), Ecosystem (live
 * metrics, population steppers, life-cycle and predator settings), Scenes
 * (one-tap presets, actions) and Style (palettes, trails, colour pickers,
 * display options).
 *
 * Isolation: pointer, touch, wheel and key events inside the HUD stop
 * propagating, so UI gestures never reach the simulation canvas or the global
 * keyboard shortcuts. The HUD root ignores pointers outside its panels, so the
 * canvas stays interactive while the drawer is open.
 *
 * @module ui/hud
 */

import { luminance } from '../core/color.js';
import { SPECIES_COUNT } from '../sim/species.js';
import { SCENARIOS, activeScenario } from '../presets.js';
import { COLOR_KEYS, PALETTES, activePalette } from '../themes.js';
import { PopulationChart } from './chart.js';
import { colorField, segmented, slider, stepper, toggle } from './controls.js';
import { h, icon } from './dom.js';

/** @typedef {import('../app.js').FlockingApp} FlockingApp */
/** @typedef {import('./controls.js').Control} Control */

const ICONS = Object.freeze({
  pause: 'M9 5v14M15 5v14',
  play: 'M8 5l11 7-11 7z',
  close: 'M6 6l12 12M18 6L6 18',
  schooling: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4',
  chaos: 'M13 2L4 14h7l-1 8 9-12h-7l1-8z',
  balance: 'M21 12a9 9 0 0 1-15.5 6.2M3 12a9 9 0 0 1 15.5-6.2M18 2v4h-4M6 22v-4h4',
  zen: 'M2 9c3-3 5-3 8 0s5 3 8 0M2 15c3-3 5-3 8 0s5 3 8 0',
});

const TABS = /** @type {const} */ ([
  { id: 'flock', label: 'Flock' },
  { id: 'eco', label: 'Ecosystem' },
  { id: 'scenes', label: 'Scenes' },
  { id: 'style', label: 'Style' },
]);

const SPECIES_LABELS = ['Dartfish', 'Mantas', 'Foragers'];
/** Config keys the simulation rewrites with live populations. */
const POPULATION_KEYS = new Set(['countSpecies1', 'countSpecies2', 'countSpecies3', 'predatorCount']);

/**
 * Write text only when it changed (avoids needless DOM mutations).
 * @param {HTMLElement} element
 * @param {string} text
 */
function setText(element, text) {
  if (element.textContent !== text) element.textContent = text;
}
const COLOR_FOR_SPECIES = /** @type {const} */ (['colorSpecies1', 'colorSpecies2', 'colorSpecies3']);
const TAB_STORAGE_KEY = 'boids:ui:tab';
const HINT_STORAGE_KEY = 'boids:ui:hint-seen';

/**
 * @param {string} key
 * @returns {string | null}
 */
function readStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * @param {string} key
 * @param {string} value
 */
function writeStorage(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode / blocked storage: preferences simply don't persist.
  }
}

/**
 * Build and mount the HUD.
 * @param {FlockingApp} app
 */
export function createHud(app) {
  const { config, sim } = app;
  /** @type {Control[]} */
  const controls = [];
  /** @type {(() => void)[]} */
  const cleanups = [];
  /** @param {Control} control */
  const use = (control) => {
    controls.push(control);
    return control.element;
  };

  // ── Pill ──────────────────────────────────────────────────────────────────
  const fpsDot = h('i', { class: 'pill-dot' });
  const fpsValue = h('b', { text: '–' });
  const boidsValue = h('b', { text: '–' });
  const predValue = h('b', { text: '–' });
  // The name stays fixed; the live numbers go in a description, which screen
  // readers read on focus without announcing every update.
  const pillStatus = h('span', { class: 'sr-only', id: 'boids-pill-status' });
  const pill = h(
    'button',
    {
      type: 'button',
      class: 'pill glass',
      'aria-expanded': 'false',
      'aria-controls': 'boids-drawer',
      'aria-label': 'Simulation controls',
      'aria-describedby': 'boids-pill-status',
    },
    fpsDot,
    h('span', { class: 'pill-item' }, fpsValue, h('span', { text: 'fps' })),
    h('i', { class: 'pill-sep' }),
    h('span', { class: 'pill-item' }, boidsValue, h('span', { text: 'boids' })),
    h('i', { class: 'pill-sep' }),
    h('span', { class: 'pill-item' }, predValue, h('span', { text: 'predators' })),
    h('i', { class: 'pill-chevron', 'aria-hidden': 'true' }),
  );

  // ── Drawer shell ─────────────────────────────────────────────────────────
  const subtitle = h('span');
  const pauseIcon = h('span');
  const pauseButton = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Pause simulation' }, pauseIcon);
  const closeButton = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close controls' }, icon(ICONS.close));
  const grab = h('div', { class: 'drawer-grab', 'aria-hidden': 'true' });
  const head = h(
    'header',
    { class: 'drawer-head' },
    h('div', { class: 'drawer-title' }, h('strong', { text: 'Boids' }), subtitle),
    pauseButton,
    closeButton,
  );
  const tabList = h('nav', { class: 'tabs', role: 'tablist', 'aria-label': 'Control sections' });
  const panels = h('div', { class: 'panels' });
  const drawer = h(
    'section',
    { class: 'drawer glass', id: 'boids-drawer', role: 'dialog', 'aria-modal': 'false', 'aria-label': 'Simulation controls' },
    grab,
    head,
    tabList,
    panels,
  );
  const toasts = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
  const root = h('div', { class: 'hud', 'data-open': 'false' }, pill, pillStatus, drawer, toasts);

  /** @type {Record<string, HTMLElement>} */
  const panelById = {};
  /** @type {Record<string, HTMLButtonElement>} */
  const tabById = {};
  for (const tab of TABS) {
    const button = h('button', {
      type: 'button',
      class: 'tab',
      role: 'tab',
      id: `boids-tab-${tab.id}`,
      'aria-controls': `boids-panel-${tab.id}`,
      text: tab.label,
    });
    const panel = h('div', { class: 'panel', role: 'tabpanel', id: `boids-panel-${tab.id}`, 'aria-labelledby': button.id });
    button.addEventListener('click', () => selectTab(tab.id));
    tabList.append(button);
    panels.append(panel);
    tabById[tab.id] = button;
    panelById[tab.id] = panel;
  }

  /**
   * @param {string} title
   * @param {...Node} children
   */
  const section = (title, ...children) =>
    h('div', { class: 'section' }, h('h3', { class: 'section-title', text: title }), h('div', { class: 'card' }, ...children));

  // ── Flock tab ────────────────────────────────────────────────────────────
  panelById.flock.append(
    section(
      'Behaviour',
      use(slider(config, 'separationWeight')),
      use(slider(config, 'alignmentWeight')),
      use(slider(config, 'cohesionWeight')),
      use(slider(config, 'maxSpeed')),
      use(slider(config, 'perceptionRadius')),
      use(slider(config, 'maxForce')),
    ),
    section(
      'Touch',
      use(
        segmented(config, 'beaconMode', [
          { label: 'Auto', value: 'auto' },
          { label: 'Attract', value: 'attract' },
          { label: 'Repel', value: 'repel' },
        ]),
      ),
      use(slider(config, 'beaconStrength')),
      use(slider(config, 'pulseStrength')),
    ),
    h('p', { class: 'hint', text: 'Tap to scatter · hold to attract · two fingers repel.' }),
  );

  // ── Ecosystem tab ────────────────────────────────────────────────────────
  const chart = new PopulationChart(sim, config);
  /** @type {{ count: HTMLElement, energy: HTMLElement, genes: HTMLElement, dot: HTMLElement }[]} */
  const speciesRows = [];
  const speciesList = h('div', { class: 'species-rows' });
  for (let s = 0; s < SPECIES_COUNT; s++) {
    const dot = h('i', { class: 'swatch-dot' });
    const count = h('span', { class: 'count' });
    const energyBar = h('i');
    const genes = h('span', { class: 'genes' });
    const row = h(
      'div',
      { class: 'species-row' },
      h('span', { class: 'name' }, dot, SPECIES_LABELS[s]),
      h('span', { class: 'energy', title: 'Mean energy' }, energyBar),
      count,
      genes,
    );
    speciesList.append(row);
    speciesRows.push({ count, energy: energyBar, genes, dot });
  }
  /** @param {string} label */
  const counter = (label) => {
    const value = h('b', { text: '0' });
    return { value, element: h('div', {}, value, h('span', { text: label })) };
  };
  const births = counter('births');
  const starved = counter('starved');
  const eaten = counter('eaten');
  const migrants = counter('migrants');
  const lifeNote = h('p', { class: 'hint' });
  panelById.eco.append(
    h(
      'div',
      { class: 'section' },
      h('h3', { class: 'section-title', text: 'Population' }),
      h(
        'div',
        { class: 'card metrics' },
        chart.element,
        speciesList,
        h('div', { class: 'counters' }, births.element, starved.element, eaten.element, migrants.element),
      ),
      lifeNote,
    ),
    section(
      'Populations',
      use(stepper(config, 'countSpecies1', { step: 10, color: () => config.colorSpecies1 })),
      use(stepper(config, 'countSpecies2', { step: 5, color: () => config.colorSpecies2 })),
      use(stepper(config, 'countSpecies3', { step: 10, color: () => config.colorSpecies3 })),
      use(stepper(config, 'predatorCount', { step: 1, color: () => config.colorPredator })),
    ),
    section(
      'Life cycle',
      use(toggle(config, 'ecosystem', { note: 'Food, energy, births and starvation' })),
      use(slider(config, 'foodSpawnRate')),
      use(slider(config, 'energyDecay')),
      use(slider(config, 'carryingCapacity')),
    ),
    section(
      'Predators',
      use(slider(config, 'predatorAggression', { format: (v) => `${Math.round(v * 100)}%` })),
      use(slider(config, 'predatorSpeed')),
      use(slider(config, 'panicRadius')),
      use(slider(config, 'panicScatter')),
    ),
  );

  // ── Scenes tab ───────────────────────────────────────────────────────────
  const scenarioGrid = h('div', { class: 'card-grid' });
  /** @type {Record<string, HTMLButtonElement>} */
  const scenarioButtons = {};
  for (const scenario of SCENARIOS) {
    const button = h(
      'button',
      { type: 'button', class: 'choice', 'aria-pressed': 'false' },
      icon(ICONS[/** @type {keyof typeof ICONS} */ (scenario.id)]),
      h('strong', { text: scenario.name }),
      h('span', { text: scenario.description }),
    );
    button.addEventListener('click', () => {
      app.applyScenario(scenario.id);
      toast(`Scene: ${scenario.name}`);
    });
    scenarioGrid.append(button);
    scenarioButtons[scenario.id] = button;
  }
  const respawn = h('button', { type: 'button', class: 'btn', text: 'Respawn' });
  respawn.addEventListener('click', () => {
    app.reset();
    toast('Fresh world spawned');
  });
  const resetAll = h('button', { type: 'button', class: 'btn', text: 'Reset all' });
  resetAll.addEventListener('click', () => {
    app.resetDefaults();
    toast('Defaults restored');
  });
  const pauseAction = h('button', { type: 'button', class: 'btn primary' });
  pauseAction.addEventListener('click', () => {
    config.paused = !config.paused;
  });
  panelById.scenes.append(
    h('div', { class: 'section' }, h('h3', { class: 'section-title', text: 'Scenarios' }), scenarioGrid),
    h('div', { class: 'section' }, h('h3', { class: 'section-title', text: 'World' }), h('div', { class: 'actions' }, pauseAction, respawn, resetAll)),
    section('Time', use(slider(config, 'timeScale'))),
  );

  // ── Style tab ────────────────────────────────────────────────────────────
  const paletteGrid = h('div', { class: 'card-grid' });
  /** @type {Record<string, HTMLButtonElement>} */
  const paletteButtons = {};
  for (const palette of PALETTES) {
    const swatches = h('span', { class: 'swatches', 'aria-hidden': 'true' });
    for (const key of COLOR_KEYS) {
      const chip = h('i');
      chip.style.background = palette.colors[key];
      swatches.append(chip);
    }
    const button = h('button', { type: 'button', class: 'choice', 'aria-pressed': 'false' }, swatches, h('strong', { text: palette.name }));
    button.addEventListener('click', () => {
      config.$set(palette.colors);
      toast(`Palette: ${palette.name}`);
    });
    paletteGrid.append(button);
    paletteButtons[palette.id] = button;
  }
  const trailsSwitch = h('button', { type: 'button', class: 'switch', role: 'switch', 'aria-label': 'Motion trails' });
  let lastTrails = config.trails > 0 ? config.trails : 0.6;
  trailsSwitch.addEventListener('click', () => {
    config.trails = config.trails > 0 ? 0 : lastTrails;
  });
  panelById.style.append(
    h('div', { class: 'section' }, h('h3', { class: 'section-title', text: 'Palettes' }), paletteGrid),
    section(
      'Motion trails',
      h('div', { class: 'ctl ctl-toggle' }, h('span', { class: 'ctl-label' }, 'Glowing wakes', h('small', { text: 'Fade frames instead of redrawing crisply' })), trailsSwitch),
      use(slider(config, 'trails', { label: 'Trail length', format: (v) => (v > 0 ? `${Math.round(v * 100)}%` : 'off') })),
    ),
    section(
      'Custom colours',
      ...COLOR_KEYS.map((key) => use(colorField(config, key))),
    ),
    section(
      'Display',
      use(toggle(config, 'showStats', { note: 'Frame and simulation timing' })),
      use(toggle(config, 'debug', { note: 'Spatial grid, radii, predator state' })),
      use(slider(config, 'maxPixelRatio')),
    ),
  );

  // ── Behaviour ────────────────────────────────────────────────────────────
  let open = false;
  /** @param {string} id */
  function selectTab(id) {
    for (const tab of TABS) {
      const selected = tab.id === id;
      tabById[tab.id].setAttribute('aria-selected', String(selected));
      tabById[tab.id].tabIndex = selected ? 0 : -1;
      panelById[tab.id].hidden = !selected;
    }
    panels.scrollTop = 0;
    writeStorage(TAB_STORAGE_KEY, id);
    refreshMetrics(true);
  }
  tabList.addEventListener('keydown', (e) => {
    const index = TABS.findIndex((t) => tabById[t.id].getAttribute('aria-selected') === 'true');
    const delta = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!delta) return;
    const next = TABS[(index + delta + TABS.length) % TABS.length].id;
    selectTab(next);
    tabById[next].focus();
  });

  /** @param {boolean} value */
  function setOpen(value) {
    open = value;
    root.dataset.open = String(value);
    pill.setAttribute('aria-expanded', String(value));
    drawer.setAttribute('aria-hidden', String(!value));
    drawer.inert = !value;
    if (value) {
      update();
      refreshMetrics(true);
      closeButton.focus({ preventScroll: true });
    } else if (root.contains(document.activeElement)) {
      pill.focus({ preventScroll: true });
    }
  }
  pill.addEventListener('click', () => setOpen(true));
  closeButton.addEventListener('click', () => setOpen(false));
  pauseButton.addEventListener('click', () => {
    config.paused = !config.paused;
  });

  // Swipe the drawer down to close (mobile layout, from the grab bar or header).
  /** @type {{ id: number, startY: number, startT: number, dy: number } | null} */
  let drag = null;
  /** @param {PointerEvent} e */
  const dragStart = (e) => {
    if (getComputedStyle(grab).display === 'none' || (e.target instanceof Element && e.target.closest('button'))) return;
    drag = { id: e.pointerId, startY: e.clientY, startT: performance.now(), dy: 0 };
    /** @type {HTMLElement} */ (e.currentTarget).setPointerCapture(e.pointerId);
    drawer.classList.add('dragging');
  };
  /** @param {PointerEvent} e */
  const dragMove = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag.dy = Math.max(0, e.clientY - drag.startY);
    drawer.style.transform = `translate(-50%, ${drag.dy}px)`;
  };
  /** @param {PointerEvent} e */
  const dragEnd = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const velocity = drag.dy / Math.max(1, performance.now() - drag.startT);
    drawer.classList.remove('dragging');
    drawer.style.transform = '';
    if (drag.dy > 80 || (drag.dy > 20 && velocity > 0.6)) setOpen(false);
    drag = null;
  };
  for (const handle of [grab, head]) {
    handle.addEventListener('pointerdown', dragStart);
    handle.addEventListener('pointermove', dragMove);
    handle.addEventListener('pointerup', dragEnd);
    handle.addEventListener('pointercancel', dragEnd);
  }

  // Keep UI interactions away from the canvas and global shortcuts.
  const isolate = (/** @type {Event} */ e) => e.stopPropagation();
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'touchstart', 'touchmove', 'touchend', 'wheel', 'contextmenu', 'click']) {
    pill.addEventListener(type, isolate, { passive: true });
    drawer.addEventListener(type, isolate, { passive: true });
  }
  root.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape' && open) setOpen(false);
  });

  // ── Toasts ───────────────────────────────────────────────────────────────
  /** @type {Map<string, number>} */
  const recentToasts = new Map();
  /** @param {string} message */
  function toast(message) {
    const now = performance.now();
    if ((recentToasts.get(message) ?? -Infinity) > now - 2500) return;
    recentToasts.set(message, now);
    while (toasts.children.length >= 3) toasts.firstElementChild?.remove();
    const el = h('div', { class: 'toast glass', text: message });
    toasts.append(el);
    setTimeout(() => {
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 300);
    }, 2600);
  }
  cleanups.push(
    sim.on('immigration', (e) => {
      toast(e.kind === 'predator' ? 'A predator migrated in' : `${e.count} ${SPECIES_LABELS[e.species]} migrated in`);
    }),
  );
  cleanups.push(
    // Only die-offs: removing a population yourself is not news.
    sim.on('extinction', (e) => {
      toast(e.kind === 'predator' ? 'The last predator starved' : `${SPECIES_LABELS[e.species]} died out. Migrants will return.`);
    }),
  );

  // ── Theme & state reflection ─────────────────────────────────────────────
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  function applyTheme() {
    const docStyle = document.documentElement.style;
    docStyle.setProperty('--accent', config.colorSpecies1);
    docStyle.setProperty('--accent-ink', luminance(config.colorSpecies1) > 0.35 ? '#08111c' : '#ffffff');
    document.body.style.background = config.colorBackground;
    themeMeta?.setAttribute('content', config.colorBackground);
    speciesRows.forEach((row, s) => {
      const color = config[COLOR_FOR_SPECIES[s]];
      row.dot.style.background = row.dot.style.color = color;
      row.energy.style.color = color;
    });
  }
  /** @type {boolean | null} */
  let shownPaused = null;
  function reflectState() {
    const paused = config.paused;
    if (paused !== shownPaused) {
      shownPaused = paused;
      pauseIcon.replaceChildren(icon(paused ? ICONS.play : ICONS.pause));
      pauseButton.setAttribute('aria-label', paused ? 'Resume simulation' : 'Pause simulation');
      pauseAction.textContent = paused ? 'Resume' : 'Pause';
    }
    const scenario = activeScenario(config);
    for (const [id, button] of Object.entries(scenarioButtons)) button.setAttribute('aria-pressed', String(id === scenario));
    const palette = activePalette(config);
    for (const [id, button] of Object.entries(paletteButtons)) button.setAttribute('aria-pressed', String(id === palette));
    trailsSwitch.setAttribute('aria-checked', String(config.trails > 0));
    if (config.trails > 0) lastTrails = config.trails;
    lifeNote.textContent = config.ecosystem
      ? 'Live: populations follow births, starvation and predation.'
      : 'Life cycle off: populations stay fixed and caught prey respawn.';
  }
  applyTheme();
  reflectState();
  cleanups.push(
    config.$subscribe((key) => {
      if (key.startsWith('color')) applyTheme();
      // Live population counts change several times a second and affect none of this.
      if (!POPULATION_KEYS.has(key)) reflectState();
    }),
  );

  // ── Live numbers ─────────────────────────────────────────────────────────
  let lastMetrics = 0;
  /** @param {boolean} [force] */
  function refreshMetrics(force = false) {
    if (!open || panelById.eco.hidden) return;
    const now = performance.now();
    if (!force && now - lastMetrics < 1000) return;
    lastMetrics = now;
    chart.draw();
    const summary = sim.speciesSummary();
    summary.forEach((s, i) => {
      const row = speciesRows[i];
      row.count.textContent = String(s.count);
      row.energy.style.width = `${Math.round(s.energy * 100)}%`;
      row.genes.textContent = s.count
        ? `gen ${s.generation} · speed ×${s.speedGene.toFixed(2)} · sight ×${s.perceptionGene.toFixed(2)}`
        : 'extinct';
    });
    births.value.textContent = String(sim.stats.births);
    starved.value.textContent = String(sim.stats.starvations);
    eaten.value.textContent = String(sim.stats.catches);
    migrants.value.textContent = String(sim.stats.immigrations);
  }

  function update() {
    const fps = Math.round(app.stats?.snapshot.fps ?? 0);
    const boids = sim.prey.count;
    const predators = sim.predators.length;
    setText(fpsValue, fps > 0 ? String(fps) : '–');
    const level = fps === 0 || fps >= 50 ? 'ok' : fps >= 30 ? 'warn' : 'bad';
    if (fpsDot.dataset.level !== level) fpsDot.dataset.level = level;
    setText(boidsValue, String(boids));
    setText(predValue, String(predators));
    setText(pillStatus, `${boids} boids, ${predators} predators, ${fps} frames per second`);
    if (open) setText(subtitle, `${fps} fps · ${boids} boids · ${predators} predators · ${sim.food.count} food`);
    refreshMetrics();
  }
  const interval = setInterval(update, 250);

  // ── Mount ────────────────────────────────────────────────────────────────
  selectTab(TABS.some((t) => t.id === readStorage(TAB_STORAGE_KEY)) ? /** @type {string} */ (readStorage(TAB_STORAGE_KEY)) : 'eco');
  setOpen(false);
  document.body.append(root);
  update();
  if (!readStorage(HINT_STORAGE_KEY)) {
    setTimeout(() => toast('Tap to scatter · hold to attract · two fingers repel'), 900);
    writeStorage(HINT_STORAGE_KEY, '1');
  }

  return {
    element: root,
    open: () => setOpen(true),
    close: () => setOpen(false),
    toast,
    destroy() {
      clearInterval(interval);
      for (const control of controls) control.dispose();
      for (const cleanup of cleanups) cleanup();
      root.remove();
    },
  };
}
