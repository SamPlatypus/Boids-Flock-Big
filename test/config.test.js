import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConfig, CONFIG_SCHEMA, CONFIG_KEYS } from '../src/config.js';

function quietConfig(overrides = {}) {
  /** @type {string[]} */
  const warnings = [];
  const config = createConfig(overrides, { warn: (m) => warnings.push(m) });
  return { config, warnings };
}

test('defaults come from the schema and include every required parameter', () => {
  const { config } = quietConfig();
  const required = [
    'separationWeight', 'alignmentWeight', 'cohesionWeight', 'maxSpeed', 'maxForce', 'perceptionRadius',
    'predatorSpeed', 'predatorAggression', 'panicRadius',
    'countSpecies1', 'countSpecies2', 'countSpecies3', 'predatorCount',
  ];
  for (const key of required) assert.ok(CONFIG_KEYS.includes(/** @type {any} */ (key)), `missing ${key}`);
  for (const key of CONFIG_KEYS) assert.equal(config[key], CONFIG_SCHEMA[key].default);
});

test('writes are validated, clamped and coerced', () => {
  const { config, warnings } = quietConfig();
  config.maxSpeed = 250;
  assert.equal(config.maxSpeed, 250);
  config.maxSpeed = 99999;
  assert.equal(config.maxSpeed, CONFIG_SCHEMA.maxSpeed.max);
  config.countSpecies1 = 12.7;
  assert.equal(config.countSpecies1, 13, 'integers are rounded');
  config.alignmentWeight = /** @type {any} */ ('2.5');
  assert.equal(config.alignmentWeight, 2.5, 'numeric strings are accepted');
  config.cohesionWeight = /** @type {any} */ ('lots');
  assert.equal(config.cohesionWeight, CONFIG_SCHEMA.cohesionWeight.default, 'garbage is rejected');
  config.perceptionRadius = NaN;
  assert.equal(config.perceptionRadius, CONFIG_SCHEMA.perceptionRadius.default);
  config.beaconMode = /** @type {any} */ ('explode');
  assert.equal(config.beaconMode, 'auto');
  config.beaconMode = 'repel';
  assert.equal(config.beaconMode, 'repel');
  config.paused = /** @type {any} */ ('true');
  assert.equal(config.paused, true);
  assert.ok(warnings.length >= 4, 'invalid writes produce warnings');
});

test('unknown keys are rejected instead of silently ignored', () => {
  const { config, warnings } = quietConfig();
  /** @type {any} */ (config).seperationWeight = 3; // typo
  assert.equal(/** @type {any} */ (config).seperationWeight, undefined);
  assert.match(warnings[0], /unknown parameter "seperationWeight"/);
  assert.deepEqual(Object.keys(config), [...CONFIG_KEYS], 'only parameters are enumerable');
  assert.doesNotThrow(() => JSON.stringify(config));
});

test('subscribers are notified once per actual change and can unsubscribe', () => {
  const { config } = quietConfig();
  /** @type {any[]} */
  const seen = [];
  const off = config.$subscribe((key, value, previous) => seen.push([key, value, previous]));
  config.maxForce = 500;
  config.maxForce = 500; // no-op: same value
  config.$set({ panicRadius: 150, predatorCount: 4 });
  off();
  config.maxForce = 600;
  assert.deepEqual(seen, [
    ['maxForce', 500, CONFIG_SCHEMA.maxForce.default],
    ['panicRadius', 150, CONFIG_SCHEMA.panicRadius.default],
    ['predatorCount', 4, CONFIG_SCHEMA.predatorCount.default],
  ]);
});

test('$reset restores defaults and $snapshot is a detached copy', () => {
  const { config } = quietConfig({ maxSpeed: 300, debug: true });
  assert.equal(config.maxSpeed, 300);
  const snap = config.$snapshot();
  config.$reset(['maxSpeed']);
  assert.equal(config.maxSpeed, CONFIG_SCHEMA.maxSpeed.default);
  assert.equal(config.debug, true);
  assert.equal(snap.maxSpeed, 300, 'snapshot unaffected by later writes');
  config.$reset();
  assert.equal(config.debug, false);
});

test('colour parameters are normalised to #rrggbb and garbage is rejected', () => {
  const { config, warnings } = quietConfig();
  config.colorSpecies1 = '#ABC';
  assert.equal(config.colorSpecies1, '#aabbcc');
  config.colorFood = '12ff34';
  assert.equal(config.colorFood, '#12ff34');
  config.colorPredator = 'red';
  assert.equal(config.colorPredator, CONFIG_SCHEMA.colorPredator.default);
  config.colorBackground = /** @type {any} */ (42);
  assert.equal(config.colorBackground, CONFIG_SCHEMA.colorBackground.default);
  assert.equal(warnings.length, 2);
});
