// The offline service worker (sw.js), run in a simulated worker environment:
// fake Cache Storage and network, serving this repository's real files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';

const ROOT = new URL('..', import.meta.url);
const SOURCE = await readFile(new URL('sw.js', ROOT), 'utf8');
const SCOPE = 'https://example.test/app/';
const FILES = [...SOURCE.matchAll(/^ {2}'\.\/([^']+)': '[^']+',$/gm)].map((m) => m[1]);
const VERSION = /const VERSION = '([^']+)'/.exec(SOURCE)?.[1] ?? '';
const CACHE = `boids-frozen-${VERSION}`;
const MARKER = 'boids-installed';

class FakeCache {
  /** @type {Map<string, Response>} */
  entries = new Map();
  /** @param {string | { url: string }} request */
  async match(request) {
    const hit = this.entries.get(typeof request === 'string' ? request : request.url);
    return hit ? hit.clone() : undefined;
  }
  /**
   * @param {string} url
   * @param {Response} response
   */
  async put(url, response) {
    this.entries.set(url, response);
  }
}

class FakeCacheStorage {
  /** @type {Map<string, FakeCache>} */
  caches = new Map();
  /** @param {string} name */
  async open(name) {
    if (!this.caches.has(name)) this.caches.set(name, new FakeCache());
    return /** @type {FakeCache} */ (this.caches.get(name));
  }
  /** @param {string} name */
  async has(name) {
    return this.caches.has(name);
  }
  async keys() {
    return [...this.caches.keys()];
  }
  /** @param {string} name */
  async delete(name) {
    return this.caches.delete(name);
  }
}

/**
 * The network: serves the repository (the deployed site) and records requests.
 * @param {{ tamper?: string }} [options]
 */
function network(options = {}) {
  /** @type {{ url: string, cache?: string }[]} */
  const requests = [];
  /**
   * @param {string | { url: string }} input
   * @param {{ cache?: string }} [init]
   */
  const fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    requests.push({ url: url.href, cache: init.cache });
    const path = url.pathname.replace('/app/', '') || 'index.html';
    try {
      let body = await readFile(new URL(path, ROOT));
      if (path === options.tamper) body = Buffer.concat([body, Buffer.from('\n// tampered')]);
      const type = path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html';
      return new Response(body, { status: 200, headers: { 'Content-Type': type, 'Content-Encoding': 'gzip' } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  };
  return { fetch, requests };
}

/**
 * Load sw.js (optionally a variant of it) into a fresh simulated worker.
 * @param {{ fetch: Function }} net
 * @param {{ caches?: FakeCacheStorage, source?: string, active?: boolean }} [options]
 */
function worker(net, { caches = new FakeCacheStorage(), source = SOURCE, active = false } = {}) {
  /** @type {Record<string, (event: any) => void>} */
  const listeners = {};
  const self = {
    location: new URL('sw.js', SCOPE),
    registration: { active: active ? {} : null },
    skipped: false,
    claimed: false,
    /** @param {string} type @param {(event: any) => void} listener */
    addEventListener(type, listener) {
      listeners[type] = listener;
    },
    skipWaiting() {
      self.skipped = true;
      return Promise.resolve();
    },
    clients: {
      async claim() {
        self.claimed = true;
      },
    },
  };
  const context = vm.createContext({ self, caches, fetch: net.fetch, crypto: webcrypto, btoa, URL, Response, Map, Uint8Array, String, Error, Promise, Object });
  vm.runInContext(source, context);
  /** Dispatch an extendable event and wait for its work. */
  const fire = async (/** @type {string} */ type, /** @type {any} */ event = {}) => {
    /** @type {Promise<unknown>[]} */
    const work = [];
    event.waitUntil = (/** @type {Promise<unknown>} */ promise) => work.push(promise);
    listeners[type](event);
    await Promise.all(work);
    return event;
  };
  /** A request from the page, answered by the worker. */
  const get = async (/** @type {string} */ url, { mode = 'cors', method = 'GET' } = {}) => {
    /** @type {Promise<Response> | undefined} */
    let response;
    listeners.fetch({
      request: { url: new URL(url, SCOPE).href, method, mode },
      respondWith(/** @type {Promise<Response>} */ promise) {
        response = promise;
      },
    });
    assert.ok(response, 'every request is answered by the worker');
    return /** @type {Promise<Response>} */ (response);
  };
  return { self, caches, fire, get };
}

/** A device where this version was saved and activated. */
async function installed() {
  const net = network();
  const sw = worker(net);
  await sw.fire('install');
  await sw.fire('activate');
  net.requests.length = 0;
  return { net, sw };
}

test('sw.js lists the whole app with a version', () => {
  assert.match(VERSION, /^[0-9a-f]{10}$/);
  for (const file of ['index.html', 'manifest.webmanifest', 'dist/boids.html', 'src/main.js', 'src/offline.js', 'src/ui/ui.css', 'icons/icon-192.png']) {
    assert.ok(FILES.includes(file), `${file} is saved`);
  }
});

test('the first visit saves every file, verified, and freezes the device at this version', async () => {
  const net = network();
  const sw = worker(net);
  await sw.fire('install');
  const cache = sw.caches.caches.get(CACHE);
  assert.equal(cache?.entries.size, FILES.length);
  assert.ok(net.requests.every((r) => r.cache === 'reload'), 'downloads bypass the HTTP cache');
  const page = /** @type {Response} */ (await cache?.match(new URL('index.html', SCOPE).href));
  assert.equal(page.headers.get('Content-Encoding'), null, 'stored decoded, without the transfer encoding');
  assert.equal(sw.self.skipped, false, 'a first install needs no takeover');
  await sw.fire('activate');
  const marker = await (await sw.caches.open(MARKER)).match(new URL('installed-version', SCOPE).href);
  assert.equal(await marker?.text(), VERSION);
  assert.ok(sw.self.claimed);
});

test('a corrupted first download is not saved; a retry fetches only what is missing', async () => {
  const caches = new FakeCacheStorage();
  await assert.rejects(worker(network({ tamper: 'src/sim/flocking.js' }), { caches }).fire('install'), /does not match version/);
  const net = network();
  await worker(net, { caches }).fire('install');
  assert.deepEqual(net.requests.map((r) => r.url), [new URL('src/sim/flocking.js', SCOPE).href]);
});

test('zero updates: a different version refuses to install without downloading anything', async () => {
  const { sw } = await installed();
  const next = network();
  const newer = worker(next, { caches: sw.caches, active: true, source: SOURCE.replace(`const VERSION = '${VERSION}'`, "const VERSION = 'ffffffffff'") });
  await assert.rejects(newer.fire('install'), /frozen at version/);
  assert.equal(next.requests.length, 0, 'not a single file downloaded');
  assert.equal(newer.self.skipped, false);
  assert.ok(sw.caches.caches.has(CACHE), 'the frozen version is untouched');
});

test('a device on an earlier, updating build moves to this one once, immediately', async () => {
  const caches = new FakeCacheStorage();
  await caches.open('boids-v2'); // network-first build
  await caches.open('boids-0123456789'); // cache-first, updating build
  await caches.open('another-app-on-this-origin');
  const sw = worker(network(), { caches, active: true });
  await sw.fire('install');
  assert.equal(sw.self.skipped, true, 'takes over at once, so the network-using build stops');
  await sw.fire('activate');
  assert.deepEqual((await caches.keys()).sort(), ['another-app-on-this-origin', MARKER, CACHE].sort());
});

test('every request is answered from the device; none reaches the network', async () => {
  const { net, sw } = await installed();
  for (const [path, mode] of [
    ['', 'navigate'],
    ['?countSpecies1=50&seed=3', 'navigate'],
    ['index.html', 'navigate'],
    ['src/main.js', 'cors'],
    ['src/ui/ui.css', 'no-cors'],
    ['manifest.webmanifest', 'cors'],
    ['icons/icon-512.png', 'no-cors'],
    ['dist/boids.html', 'navigate'],
  ]) {
    assert.equal((await sw.get(path, { mode })).status, 200, path);
  }
  assert.match(await (await sw.get('some/old/link', { mode: 'navigate' })).text(), /<canvas id="sim"/, 'in-app links show the app');
  for (const [url, options] of /** @type {[string, { mode?: string, method?: string }][]} */ ([
    ['screenshots/wide-zen.jpg', {}],
    ['not-part-of-the-app.js', {}],
    ['https://elsewhere.example/tracker.js', {}],
    ['index.html', { method: 'POST' }],
  ])) {
    assert.equal((await sw.get(url, options)).type, 'error', `${url} gets an error, not the network`);
  }
  assert.equal(net.requests.length, 0, 'zero network requests');
});

test('if the browser deleted the saved copy, the app explains instead of going online', async () => {
  const { net, sw } = await installed();
  sw.caches.caches.get(CACHE)?.entries.clear();
  const page = await sw.get('', { mode: 'navigate' });
  assert.equal(page.status, 503);
  assert.match(await page.text(), /clear this site’s data/);
  assert.equal((await sw.get('src/main.js')).type, 'error');
  assert.equal(net.requests.length, 0);
});

test('the page can ask which version is saved', async () => {
  const sw = worker(network());
  /** @type {unknown[]} */
  const replies = [];
  await sw.fire('message', { data: { type: 'STATUS' }, ports: [{ postMessage: (/** @type {unknown} */ m) => replies.push(m) }] });
  assert.deepEqual(JSON.parse(JSON.stringify(replies)), [{ version: VERSION, files: FILES.length }]);
});
