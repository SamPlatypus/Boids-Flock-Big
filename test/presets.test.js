import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG_SCHEMA, createConfig } from '../src/config.js';
import { AREA_SCALED_KEYS, SCENARIOS, SCENARIO_KEYS, activeScenario, scaleForArea } from '../src/presets.js';
import { COLOR_KEYS, PALETTES, activePalette } from '../src/themes.js';
import { normalizeHex } from '../src/core/color.js';
import { loadSettings, persistSettings } from '../src/persist.js';

test('every scenario sets every scenario key with a valid value', () => {
  assert.deepEqual(
    SCENARIOS.map((s) => s.id),
    ['schooling', 'chaos', 'balance', 'zen'],
  );
  for (const scenario of SCENARIOS) {
    assert.deepEqual(Object.keys(scenario.patch).sort(), [...SCENARIO_KEYS].sort(), scenario.id);
    /** @type {string[]} */
    const warnings = [];
    createConfig(scenario.patch, { warn: (m) => warnings.push(m) });
    assert.deepEqual(warnings, [], `${scenario.id} has out-of-range values`);
  }
  const balance = SCENARIOS.find((s) => s.id === 'balance');
  for (const key of SCENARIO_KEYS) assert.equal(balance?.patch[key], CONFIG_SCHEMA[key].default, `balance.${key} is the default`);
});

test('the scenarios match their descriptions', () => {
  const byId = Object.fromEntries(SCENARIOS.map((s) => [s.id, s.patch]));
  assert.equal(byId.schooling.predatorCount, 0);
  assert.ok(Number(byId.schooling.cohesionWeight) > 2 && Number(byId.schooling.alignmentWeight) > 2);
  assert.ok(Number(byId.chaos.predatorCount) >= 8 && Number(byId.chaos.panicScatter) > 1.5);
  assert.equal(byId.balance.ecosystem, true);
  assert.ok(Number(byId.zen.maxSpeed) < 100 && Number(byId.zen.trails) > 0.8 && Number(byId.zen.alignmentWeight) > 2);
});

test('area scaling multiplies populations, capacity and food, and clamps', () => {
  const patch = { countSpecies1: 100, predatorCount: 3, carryingCapacity: 480, foodSpawnRate: 24, cohesionWeight: 1.5 };
  const scaled = scaleForArea(patch, 2.5);
  assert.deepEqual(scaled, { countSpecies1: 250, predatorCount: 8, carryingCapacity: 1200, foodSpawnRate: 60, cohesionWeight: 1.5 });
  assert.equal(scaleForArea({ foodSpawnRate: 24 }, 9).foodSpawnRate, CONFIG_SCHEMA.foodSpawnRate.max);
  assert.ok(AREA_SCALED_KEYS.every((k) => k in CONFIG_SCHEMA));
});

test('the active scenario and palette are detected from the config', () => {
  const config = createConfig({}, { warn: () => {} });
  assert.equal(activeScenario(config), 'balance');
  config.$set(scaleForArea(SCENARIOS[3].patch, 2));
  assert.equal(activeScenario(config), 'zen', 'populations may differ (area scaling)');
  config.cohesionWeight = 3.3;
  assert.equal(activeScenario(config), null);

  assert.equal(activePalette(config), 'abyss');
  config.$set(PALETTES[2].colors);
  assert.equal(activePalette(config), 'radar');
  config.colorFood = '#123456';
  assert.equal(activePalette(config), null);
});

test('palettes are complete and use valid colours', () => {
  assert.deepEqual(PALETTES.map((p) => p.id), ['abyss', 'solarpunk', 'radar', 'mono']);
  for (const palette of PALETTES) {
    assert.deepEqual(Object.keys(palette.colors).sort(), [...COLOR_KEYS].sort());
    for (const value of Object.values(palette.colors)) assert.equal(normalizeHex(value), value);
  }
  const radar = PALETTES.find((p) => p.id === 'radar');
  assert.equal(radar?.colors.colorBackground, '#000000', 'true OLED black');
  const defaults = PALETTES.find((p) => p.id === 'abyss');
  for (const key of COLOR_KEYS) assert.equal(defaults?.colors[key], CONFIG_SCHEMA[key].default);
});

test('settings persist (debounced), skip volatile keys and tolerate bad storage', async () => {
  /** @type {Map<string, string>} */
  const store = new Map();
  const g = /** @type {any} */ (globalThis);
  g.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
  try {
    const config = createConfig({}, { warn: () => {} });
    const stop = persistSettings(config, 10);
    config.$set({ cohesionWeight: 2.2, colorFood: '#00ff00', paused: true });
    await new Promise((r) => setTimeout(r, 40));
    stop();
    const loaded = loadSettings();
    assert.equal(loaded.cohesionWeight, 2.2);
    assert.equal(loaded.colorFood, '#00ff00');
    assert.equal('paused' in loaded, false, 'paused is never restored');

    // Live populations are not settings while the life cycle runs…
    assert.equal('countSpecies1' in loaded, false, 'live population not restored');
    assert.equal('predatorCount' in loaded, false, 'a crash to 0 predators must not disable the rescue');
    // …but fixed populations (life cycle off) are the user's choice.
    const fixed = createConfig({}, { warn: () => {} });
    const stopFixed = persistSettings(fixed, 10);
    fixed.$set({ ecosystem: false, countSpecies1: 77, predatorCount: 0 });
    await new Promise((r) => setTimeout(r, 40));
    stopFixed();
    assert.deepEqual(
      [loadSettings().ecosystem, loadSettings().countSpecies1, loadSettings().predatorCount],
      [false, 77, 0],
    );
    // Counts stored with the life cycle on (by an older build) are ignored.
    store.set('boids:settings:v1', JSON.stringify({ ecosystem: true, predatorCount: 0, countSpecies2: 3, trails: 0.5 }));
    assert.deepEqual(loadSettings(), { ecosystem: true, trails: 0.5 });

    store.set('boids:settings:v1', '{not json');
    assert.deepEqual(loadSettings(), {});
    g.localStorage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    assert.deepEqual(loadSettings(), {});
  } finally {
    delete g.localStorage;
  }
});
