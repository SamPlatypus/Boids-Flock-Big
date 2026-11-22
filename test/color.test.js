import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hexToRgb, luminance, mixHex, normalizeHex, rgbToHex, rgba, scaleHex } from '../src/core/color.js';

test('hex parsing, formatting and normalisation round-trip', () => {
  assert.deepEqual(hexToRgb('#3cf2ff'), [60, 242, 255]);
  assert.equal(rgbToHex([60, 242, 255]), '#3cf2ff');
  assert.equal(rgbToHex([300, -5, 127.6]), '#ff0080', 'channels clamp and round');
  assert.equal(normalizeHex(' #FfF '), '#ffffff');
  assert.equal(normalizeHex('0a0b0c'), '#0a0b0c');
  for (const bad of ['', '#12', '#12345', 'blue', '#ggghhh', null, 7]) assert.equal(normalizeHex(bad), null);
});

test('mixing, scaling and luminance behave at the extremes', () => {
  assert.equal(mixHex('#000000', '#ffffff', 0.5), '#808080');
  assert.equal(mixHex('#102030', '#405060', 0), '#102030');
  assert.equal(mixHex('#102030', '#405060', 1), '#405060');
  assert.equal(scaleHex('#000000', 1.6), '#000000', 'black stays black (OLED backgrounds)');
  assert.equal(scaleHex('#204060', 0.5), '#102030');
  assert.equal(rgba('#ff0000', 0.25), 'rgba(255, 0, 0, 0.250)');
  assert.equal(luminance('#000000'), 0);
  assert.ok(Math.abs(luminance('#ffffff') - 1) < 1e-9);
});
