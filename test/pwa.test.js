import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

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

test('the service worker precaches every module and stylesheet, and every precached file exists', async () => {
  const sw = await readFile(join(ROOT, 'sw.js'), 'utf8');
  const block = sw.match(/const PRECACHE = \[([\s\S]*?)\];/);
  assert.ok(block, 'PRECACHE array found');
  const precache = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const modules = (await listModules(join(ROOT, 'src'))).map((file) => `./${relative(ROOT, file).split(sep).join('/')}`);
  for (const module of modules) assert.ok(precache.includes(module), `sw.js PRECACHE is missing ${module}`);
  for (const entry of precache) {
    if (entry !== './') await assert.doesNotReject(access(join(ROOT, entry)), `${entry} does not exist`);
  }
});

test('every icon and screenshot referenced by the manifest exists', async () => {
  const manifest = JSON.parse(await readFile(join(ROOT, 'manifest.webmanifest'), 'utf8'));
  assert.ok(manifest.icons.length >= 3);
  for (const icon of manifest.icons) await assert.doesNotReject(access(join(ROOT, icon.src)), `${icon.src} missing`);
  // Richer install dialogs: phones show the narrow screenshots, desktops the wide ones.
  const factors = new Set(manifest.screenshots.map((/** @type {{ form_factor: string }} */ s) => s.form_factor));
  assert.deepEqual([...factors].sort(), ['narrow', 'wide']);
  for (const shot of manifest.screenshots) {
    await assert.doesNotReject(access(join(ROOT, shot.src)), `${shot.src} missing`);
    const [w, h] = shot.sizes.split('x').map(Number);
    assert.ok(Math.max(w, h) / Math.min(w, h) <= 2.3, `${shot.src}: aspect ratio too extreme for install dialogs`);
  }
  assert.equal(manifest.id, './');
});
