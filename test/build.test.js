import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildStandalone } from '../scripts/build.mjs';

const OUTPUT = fileURLToPath(new URL('../dist/boids.html', import.meta.url));

test('dist/boids.html is up to date with src/', async () => {
  const [fresh, committed] = await Promise.all([buildStandalone(), readFile(OUTPUT, 'utf8')]);
  assert.ok(committed === fresh, 'dist/boids.html is stale: run `npm run build`');
});

test('the standalone build is a single self-contained classic script', async () => {
  const html = await buildStandalone();
  assert.ok(!/<script[^>]*type="module"/.test(html), 'no module scripts');
  assert.ok(!/(?:src|href)="\.\/src\//.test(html), 'nothing loaded from src/');
  assert.ok(!/location\.replace\(\s*['"]\.\/dist\/boids\.html/.test(html), 'dev-only file:// redirect stripped');
  // Offline support registers the service worker only next to the hosted
  // manifest; the single file runs offline on its own and never registers one.
  assert.ok(!html.includes('hosted-only'), 'hosted-only blocks stripped');
  assert.ok(!html.includes('manifest.webmanifest'), 'hosted-only manifest link stripped');
  assert.ok(!/<link[^>]+stylesheet/.test(html), 'stylesheets inlined');
  assert.ok(html.includes('backdrop-filter: blur(12px)'), 'UI styles present');
  const scripts = [...html.matchAll(/<script>\n([\s\S]*?)\n\s*<\/script>/g)];
  assert.equal(scripts.length, 1, 'exactly one inline script');
  assert.doesNotThrow(() => new Function(scripts[0][1]), 'bundle parses');
});
