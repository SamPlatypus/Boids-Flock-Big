#!/usr/bin/env node
/**
 * Assemble the static site that GitHub Pages serves: `node scripts/site.mjs [outDir]`
 * (default `_site/`).
 *
 * It contains the hosted app (index.html, the ES modules, the service worker,
 * the manifest and icons) plus the single-file build at dist/boids.html. Tests,
 * scripts and package files stay out.
 *
 * Fails if any file the service worker precaches is missing from the output:
 * one missing entry stops the worker from installing, and the app from
 * working offline.
 */
import { access, cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ENTRIES = ['index.html', 'sw.js', 'manifest.webmanifest', 'icons', 'src', 'dist'];
/** Marks a directory as this script's output (hidden files are not uploaded to Pages). */
const MARKER = '.boids-site';

const out = resolve(ROOT, process.argv[2] ?? '_site');
// The output is deleted and rebuilt, so only ever replace an empty directory
// or one this script made: never the project, a parent of it, or anything else.
/** @type {string[] | null} */
let existing = null;
try {
  existing = await readdir(out);
} catch {
  // Does not exist yet.
}
if (existing && existing.length > 0 && !existing.includes(MARKER)) {
  throw new Error(`${out} is not empty and was not made by this script; refusing to replace it`);
}
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await writeFile(join(out, MARKER), '');
for (const entry of ENTRIES) await cp(join(ROOT, entry), join(out, entry), { recursive: true });

const sw = await readFile(join(ROOT, 'sw.js'), 'utf8');
const block = sw.match(/const PRECACHE = \[([\s\S]*?)\];/);
if (!block) throw new Error('PRECACHE list not found in sw.js');
const precache = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
const missing = [];
for (const entry of precache) {
  const path = entry === './' ? 'index.html' : entry;
  try {
    await access(join(out, path));
  } catch {
    missing.push(entry);
  }
}
if (missing.length) throw new Error(`precached but missing from the site: ${missing.join(', ')}`);
console.log(`Site ready in ${out}: ${ENTRIES.join(', ')} (${precache.length} precached files present).`);
