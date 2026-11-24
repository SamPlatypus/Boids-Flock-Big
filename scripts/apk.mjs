#!/usr/bin/env node
/**
 * Build the Android app: `npm run apk` → dist/boids.apk (+ dist/boids.apk.json).
 *
 * The APK is a WebView showing dist/boids.html, bundled as an asset. Its
 * manifest requests no permissions, so Android blocks all network access.
 * See android/.
 *
 * Needs a JDK and the Android build tools: aapt2, d8 (or the older dx),
 * zipalign, apksigner and a platform android.jar. They are found under
 * $ANDROID_HOME (newest build-tools and platform), or Ubuntu's open-source
 * packages (`apt install android-sdk-build-tools android-sdk-platform-23
 * apksigner zipalign dalvik-exchange`) under /usr/lib/android-sdk.
 *
 * Signing: set BOIDS_KEYSTORE and BOIDS_KEYSTORE_PASSWORD (key alias
 * "boids") to sign with your own key. Otherwise a new key is generated for
 * this build. An installed copy can only be replaced by an APK signed with
 * the same key; with a new key, uninstall first.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ANDROID = join(ROOT, 'android');
const BUILD = join(ROOT, 'android', 'build');
const OUTPUT = join(ROOT, 'dist', 'boids.apk');
const PACKAGE = 'io.github.samplatypus.boids';
const MIN_SDK = 24; // Android 7.0
const TARGET_SDK = 34;
const VERSION_CODE = 1;
const VERSION_NAME = '1.0';

/** @param {string} dir */
async function newestChild(dir) {
  if (!existsSync(dir)) return null;
  const names = (await readdir(dir)).filter((n) => /^(?:\d+(?:\.\d+)*|android-\d+)$/.test(n));
  names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return names.length ? join(dir, names[names.length - 1]) : null;
}

/** Locate the Android tools. */
async function tools() {
  const sdk = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, '/usr/lib/android-sdk'].find((d) => d && existsSync(d));
  if (!sdk) throw new Error('Android build tools not found: set ANDROID_HOME (see the header of this script)');
  const buildTools = await newestChild(join(sdk, 'build-tools'));
  const platform = await newestChild(join(sdk, 'platforms'));
  if (!buildTools || !platform) throw new Error(`no build-tools or platform under ${sdk}`);
  /** @param {string} name */
  const tool = (name) => [join(buildTools, name), `/usr/bin/${name}`].find((p) => existsSync(p)) ?? null;
  const found = { aapt2: tool('aapt2'), d8: tool('d8'), dx: tool('dx'), zipalign: tool('zipalign'), apksigner: tool('apksigner'), androidJar: join(platform, 'android.jar') };
  for (const name of ['aapt2', 'zipalign', 'apksigner']) if (!found[/** @type {'aapt2'} */ (name)]) throw new Error(`${name} not found in ${buildTools}`);
  if (!found.d8 && !found.dx) throw new Error(`neither d8 nor dx found in ${buildTools}`);
  return found;
}

/**
 * @param {string} command
 * @param {string[]} args
 */
const run = (command, args) => execFileSync(command, args, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });

/** @param {string | Buffer} data */
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** @param {string} dir @returns {Promise<string[]>} */
async function files(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await files(path)));
    else out.push(path);
  }
  return out;
}

const t = await tools();
await rm(BUILD, { recursive: true, force: true });
await mkdir(join(BUILD, 'assets'), { recursive: true });
await mkdir(join(BUILD, 'classes'), { recursive: true });
await mkdir(join(BUILD, 'dex'), { recursive: true });

// 1. The app itself: the single-file build, as the WebView's page.
const html = await readFile(join(ROOT, 'dist', 'boids.html'));
await copyFile(join(ROOT, 'dist', 'boids.html'), join(BUILD, 'assets', 'index.html'));

// 2. Resources and manifest.
run(t.aapt2, ['compile', '--dir', join(ANDROID, 'res'), '-o', join(BUILD, 'resources.zip')]);
run(t.aapt2, [
  'link', '-o', join(BUILD, 'unsigned.apk'),
  '-I', t.androidJar,
  '--manifest', join(ANDROID, 'AndroidManifest.xml'),
  '--min-sdk-version', String(MIN_SDK),
  '--target-sdk-version', String(TARGET_SDK),
  '--version-code', String(VERSION_CODE),
  '--version-name', VERSION_NAME,
  '-A', join(BUILD, 'assets'),
  join(BUILD, 'resources.zip'),
]);

// 3. Code: compile and convert to Dalvik bytecode.
const sources = (await files(join(ANDROID, 'src'))).filter((f) => f.endsWith('.java'));
run('javac', ['--release', '8', '-Xlint:-options', '-classpath', t.androidJar, '-d', join(BUILD, 'classes'), ...sources]);
const classes = (await files(join(BUILD, 'classes'))).filter((f) => f.endsWith('.class'));
if (t.d8) run(t.d8, ['--release', '--min-api', String(MIN_SDK), '--lib', t.androidJar, '--output', join(BUILD, 'dex'), ...classes]);
else run(/** @type {string} */ (t.dx), ['--dex', `--min-sdk-version=${MIN_SDK}`, `--output=${join(BUILD, 'dex', 'classes.dex')}`, join(BUILD, 'classes')]);
run('zip', ['-q', '-j', '-X', join(BUILD, 'unsigned.apk'), join(BUILD, 'dex', 'classes.dex')]);

// 4. Align and sign.
run(t.zipalign, ['-p', '-f', '4', join(BUILD, 'unsigned.apk'), join(BUILD, 'aligned.apk')]);
let keystore = process.env.BOIDS_KEYSTORE;
let password = process.env.BOIDS_KEYSTORE_PASSWORD;
if (!keystore || !password) {
  keystore = join(BUILD, 'throwaway.keystore');
  password = sha256(String(Math.random()) + Date.now()).slice(0, 24);
  run('keytool', [
    '-genkeypair', '-keystore', keystore, '-storetype', 'PKCS12', '-alias', 'boids',
    '-keyalg', 'RSA', '-keysize', '3072', '-validity', '36500', '-dname', 'CN=Boids',
    '-storepass', password, '-keypass', password,
  ]);
  console.log('Signed with a key generated for this build (set BOIDS_KEYSTORE to use your own).');
}
await mkdir(join(ROOT, 'dist'), { recursive: true });
run(t.apksigner, [
  'sign', '--ks', keystore, '--ks-key-alias', 'boids',
  '--ks-pass', `pass:${password}`, '--key-pass', `pass:${password}`,
  '--min-sdk-version', String(MIN_SDK), '--out', OUTPUT, join(BUILD, 'aligned.apk'),
]);
const certs = run(t.apksigner, ['verify', '--print-certs', OUTPUT]);
const permissions = [...run(t.aapt2, ['dump', 'permissions', OUTPUT]).matchAll(/uses-permission: name='([^']+)'/g)].map((m) => m[1]);
await rm(`${OUTPUT}.idsig`, { force: true });

// 5. Record what was built, so a test can tell when the APK is out of date.
const apk = await readFile(OUTPUT);
const info = {
  package: PACKAGE,
  versionName: VERSION_NAME,
  versionCode: VERSION_CODE,
  minSdk: MIN_SDK,
  targetSdk: TARGET_SDK,
  app: { file: 'dist/boids.html', sha256: sha256(html) },
  apk: { bytes: apk.length, sha256: sha256(apk) },
  signer: certs.match(/certificate SHA-256 digest: ([0-9a-f]+)/)?.[1] ?? null,
  permissions,
};
await writeFile(join(ROOT, 'dist', 'boids.apk.json'), JSON.stringify(info, null, 2) + '\n');
await rm(BUILD, { recursive: true, force: true });
console.log(`Wrote dist/boids.apk (${((await stat(OUTPUT)).size / 1024).toFixed(1)} KiB): ${PACKAGE} ${VERSION_NAME}, permissions: ${permissions.length ? permissions.join(', ') : 'none'}.`);
