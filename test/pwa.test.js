import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildServiceWorker } from '../scripts/build.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function listModules(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listModules(path)));
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.css')) out.push(path);
  }
  return out;
}

test('sw.js lists every app file with its current hash (run `npm run build`)', async () => {
  const [fresh, committed] = await Promise.all([buildServiceWorker(), readFile(join(ROOT, 'sw.js'), 'utf8')]);
  assert.ok(committed === fresh, 'sw.js is stale: run `npm run build`');
  const files = [...committed.matchAll(/^ {2}'\.\/([^']+)': '[^']+',$/gm)].map((m) => m[1]);
  const modules = (await listModules(join(ROOT, 'src'))).map((file) => relative(ROOT, file).split(sep).join('/'));
  for (const module of modules) assert.ok(files.includes(module), `${module} is saved for offline use`);
  const manifest = JSON.parse(await readFile(join(ROOT, 'manifest.webmanifest'), 'utf8'));
  for (const icon of manifest.icons) assert.ok(files.includes(icon.src), `${icon.src} is saved for offline use`);
  for (const page of ['index.html', 'manifest.webmanifest', 'dist/boids.html', 'icons/icon-180.png']) assert.ok(files.includes(page), page);
});

test('the manifest references only files of the app, with no external URLs', async () => {
  const text = await readFile(join(ROOT, 'manifest.webmanifest'), 'utf8');
  const manifest = JSON.parse(text);
  assert.ok(manifest.icons.length >= 3);
  for (const icon of manifest.icons) await assert.doesNotReject(access(join(ROOT, icon.src)), `${icon.src} missing`);
  assert.equal(manifest.screenshots, undefined, 'nothing for the browser to fetch beyond the saved icons');
  assert.doesNotMatch(text, /https?:\/\//, 'no external URLs');
  assert.equal(manifest.id, './');
});

test('the app itself makes no network requests', async () => {
  // The SVG namespace is an identifier, never fetched.
  const allowed = ['http://www.w3.org/2000/svg'];
  const forbidden = /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|\.update\(\)|https?:\/\/[^\s'"`)]+/g;
  for (const file of [...(await listModules(join(ROOT, 'src'))), join(ROOT, 'index.html')]) {
    const source = await readFile(file, 'utf8');
    const hits = [...source.matchAll(forbidden)].map((m) => m[0]).filter((hit) => !allowed.includes(hit));
    assert.deepEqual(hits, [], `${relative(ROOT, file)} must not touch the network`);
  }
  // The service worker downloads the app once, in one place.
  const sw = await readFile(join(ROOT, 'sw.js'), 'utf8');
  assert.equal([...sw.matchAll(/\bfetch\s*\(/g)].length, 1, 'sw.js fetches only during the one-time save');
});
