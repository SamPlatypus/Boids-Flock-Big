// The Android app (android/, built by `npm run apk` into dist/boids.apk).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const ROOT = new URL('..', import.meta.url);
const read = (/** @type {string} */ path) => readFile(new URL(path, ROOT), 'utf8');
const sha256 = (/** @type {Buffer | string} */ data) => createHash('sha256').update(data).digest('hex');

test('the Android manifest requests no permissions, so Android blocks all network access', async () => {
  const manifest = (await read('android/AndroidManifest.xml')).replace(/<!--[\s\S]*?-->/g, '');
  assert.doesNotMatch(manifest, /<uses-permission/, 'no permissions at all (no INTERNET)');
  assert.match(manifest, /android:allowBackup="false"/, 'settings are never backed up to the cloud');
  assert.match(manifest, /WebView\.EnableSafeBrowsing" android:value="false"/, 'no Safe Browsing lookups');
  assert.match(manifest, /WebView\.MetricsOptOut" android:value="true"/, 'no WebView usage metrics');
  assert.match(manifest, /android:exported="true"[\s\S]*android\.intent\.category\.LAUNCHER/, 'a launchable activity');
});

test('the activity shows only the bundled app and never goes online', async () => {
  const activity = await read('android/src/io/github/samplatypus/boids/MainActivity.java');
  assert.match(activity, /"file:\/\/\/android_asset\/index\.html"/);
  assert.match(activity, /setBlockNetworkLoads\(true\)/);
  assert.match(activity, /shouldOverrideUrlLoading[\s\S]*?return true/, 'no navigation');
  assert.doesNotMatch(activity, /https?:\/\//, 'no web addresses');
  // The back button closes the controls through this hook.
  assert.match(await read('src/main.js'), /window\.boidsHud = createHud\(/);
  assert.match(await read('src/ui/hud.js'), /isOpen: \(\) => open/);
});

test('dist/boids.apk bundles the current app (run `npm run apk` after `npm run build`)', async () => {
  const info = JSON.parse(await read('dist/boids.apk.json'));
  const apk = await readFile(new URL('dist/boids.apk', ROOT));
  const html = await readFile(new URL('dist/boids.html', ROOT));
  assert.equal(info.apk.sha256, sha256(apk), 'dist/boids.apk.json describes dist/boids.apk');
  assert.equal(info.app.sha256, sha256(html), 'the APK is stale: run `npm run apk`');
  assert.deepEqual(info.permissions, [], 'built with no permissions');
  assert.equal(info.package, 'io.github.samplatypus.boids');
  // An APK is a zip: the bundled page sits at assets/index.html.
  assert.ok(apk.includes(Buffer.from('assets/index.html')));
});
