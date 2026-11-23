#!/usr/bin/env node
/**
 * Assemble the static site that GitHub Pages serves: `node scripts/site.mjs [outDir]`
 * (default `_site/`).
 *
 * It contains the hosted app (index.html, the ES modules, the service worker,
 * the manifest, icons and the install-dialog screenshots) plus the single-file
 * build at dist/boids.html. Tests, scripts and package files stay out.
 *
 * Fails if any file the service worker saves for offline use is missing or
 * differs from the hash in sw.js: the worker verifies every file, so one bad
 * file would stop every visitor's offline copy from installing.
 */
import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ENTRIES = ['index.html', 'sw.js', 'manifest.webmanifest', 'icons', 'screenshots', 'src', 'dist'];
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
const files = [...sw.matchAll(/^ {2}'(\.\/[^']+)': '([^']+)',$/gm)];
if (files.length === 0) throw new Error('sw.js lists no files: run npm run build');
const problems = [];
for (const [, path, hash] of files) {
  try {
    const bytes = await readFile(join(out, path));
    if (createHash('sha256').update(bytes).digest('base64') !== hash) problems.push(`${path}: differs from sw.js (run npm run build)`);
  } catch {
    problems.push(`${path}: missing`);
  }
}
if (problems.length) throw new Error(`the offline copy would fail to install:\n  ${problems.join('\n  ')}`);
console.log(`Site ready in ${out}: ${ENTRIES.join(', ')} (${files.length} offline files verified).`);
