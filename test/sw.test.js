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
const VERSION = /const VERSION = '([^']+)'/.exec(SOURCE)?.[1];

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
 * @param {{ offline?: boolean, tamper?: string }} [options]
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
    if (options.offline) throw new TypeError('Failed to fetch');
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
 * Load sw.js into a fresh simulated worker.
 * @param {{ fetch: Function }} net
 * @param {FakeCacheStorage} [caches]
 */
function worker(net, caches = new FakeCacheStorage()) {
  /** @type {Record<string, (event: any) => void>} */
  const listeners = {};
  const self = {
    location: new URL('sw.js', SCOPE),
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
  vm.runInContext(SOURCE, context);
  /** Dispatch an extendable event and wait for its work. */
  const fire = async (/** @type {string} */ type, /** @type {any} */ event = {}) => {
    /** @type {Promise<unknown>[]} */
    const work = [];
    event.waitUntil = (/** @type {Promise<unknown>} */ promise) => work.push(promise);
    event.respondWith = (/** @type {Promise<Response>} */ promise) => (event.response = promise);
    listeners[type](event);
    await Promise.all(work);
    return event;
  };
  /** Fetch through the worker; resolves with the response and finished background work. */
  const get = async (/** @type {string} */ path, mode = 'cors') => {
    /** @type {Promise<unknown>[]} */
    const work = [];
    const event = {
      request: { url: new URL(path, SCOPE).href, method: 'GET', mode },
      /** @type {Promise<Response> | undefined} */
      response: undefined,
      respondWith(/** @type {Promise<Response>} */ promise) {
        this.response = promise;
      },
      waitUntil(/** @type {Promise<unknown>} */ promise) {
        work.push(promise);
      },
    };
    listeners.fetch(event);
    const response = await event.response;
    await Promise.all(work);
    return response;
  };
  return { self, caches, fire, get };
}

test('sw.js lists the whole app with a version', () => {
  assert.match(VERSION ?? '', /^[0-9a-f]{10}$/);
  for (const file of ['index.html', 'manifest.webmanifest', 'dist/boids.html', 'src/main.js', 'src/offline.js', 'src/ui/ui.css', 'icons/icon-192.png']) {
    assert.ok(FILES.includes(file), `${file} is saved for offline use`);
  }
  assert.ok(!FILES.some((f) => f.startsWith('screenshots/')), 'install-dialog screenshots stay online-only');
});

test('install saves every file of the version, verified and bypassing the HTTP cache', async () => {
  const net = network();
  const sw = worker(net);
  await sw.fire('install');
  const cache = sw.caches.caches.get(`boids-${VERSION}`);
  assert.ok(cache, 'a cache named after the version');
  assert.equal(cache.entries.size, FILES.length);
  assert.ok(net.requests.every((r) => r.cache === 'reload'), 'downloads bypass the HTTP cache');
  // Stored without the (already decoded) content encoding.
  const page = /** @type {Response} */ (await cache.match(new URL('index.html', SCOPE).href));
  assert.equal(page.headers.get('Content-Encoding'), null);
  assert.equal(page.headers.get('Content-Type'), 'text/html');
});

test('a version is saved completely or not at all', async () => {
  const caches = new FakeCacheStorage();
  const broken = worker(network({ tamper: 'src/sim/flocking.js' }), caches);
  await assert.rejects(broken.fire('install'), /does not match version/);
  // A retry (e.g. after the CDN caught up) only downloads what is still missing.
  const net = network();
  await worker(net, caches).fire('install');
  assert.deepEqual(net.requests.map((r) => r.url), [new URL('src/sim/flocking.js', SCOPE).href]);
  assert.equal(caches.caches.get(`boids-${VERSION}`)?.entries.size, FILES.length);
});

test('the app runs from the saved copy: online it never waits for the network', async () => {
  const net = network();
  const sw = worker(net);
  await sw.fire('install');
  await sw.fire('activate');
  net.requests.length = 0;
  for (const path of ['', '?countSpecies1=50&seed=3', 'index.html', 'src/main.js', 'src/ui/ui.css', 'dist/boids.html']) {
    const response = await sw.get(path, path === 'src/main.js' || path.endsWith('.css') ? 'cors' : 'navigate');
    assert.equal(response.status, 200, path);
  }
  assert.equal(net.requests.length, 0, 'no request reached the network');
  const shell = await (await sw.get('?debug=1', 'navigate')).text();
  assert.match(shell, /<canvas id="sim"/, 'the start URL with parameters is the app');
});

test('offline: unknown in-app pages show the app; other files fail cleanly', async () => {
  const caches = new FakeCacheStorage();
  const online = worker(network(), caches);
  await online.fire('install');
  const offline = worker(network({ offline: true }), caches);
  assert.match(await (await offline.get('some/old/link', 'navigate')).text(), /<canvas id="sim"/);
  await assert.rejects(offline.get('screenshots/wide-zen.jpg'));
});

test('files outside the app go to the network', async () => {
  const net = network();
  const sw = worker(net);
  await sw.fire('install');
  net.requests.length = 0;
  await sw.get('screenshots/wide-zen.jpg');
  assert.deepEqual(net.requests.map((r) => r.url), [new URL('screenshots/wide-zen.jpg', SCOPE).href]);
});

test('a file missing from the saved copy is repaired when it is the right version', async () => {
  const net = network();
  const sw = worker(net);
  await sw.fire('install');
  const cache = /** @type {FakeCache} */ (sw.caches.caches.get(`boids-${VERSION}`));
  const url = new URL('src/sim/food.js', SCOPE).href;
  cache.entries.delete(url);
  assert.equal((await sw.get('src/sim/food.js')).status, 200);
  assert.ok(cache.entries.has(url), 'put back');
  // A newer file from the network is served but not mixed into the saved version.
  const tampered = worker(network({ tamper: 'src/sim/food.js' }), sw.caches);
  cache.entries.delete(url);
  assert.equal((await tampered.get('src/sim/food.js')).status, 200);
  assert.ok(!cache.entries.has(url), 'not stored: it is not this version');
});

test('activation removes only this app’s older versions', async () => {
  const caches = new FakeCacheStorage();
  await caches.open('boids-0123456789');
  await caches.open('boids-v2');
  await caches.open('another-app-on-this-origin');
  const sw = worker(network(), caches);
  await sw.fire('install');
  await sw.fire('activate');
  assert.deepEqual((await caches.keys()).sort(), ['another-app-on-this-origin', `boids-${VERSION}`]);
  assert.ok(sw.self.claimed);
});

test('the page can ask for the version and switch to a waiting update', async () => {
  const sw = worker(network());
  /** @type {unknown[]} */
  const replies = [];
  await sw.fire('message', { data: { type: 'STATUS' }, ports: [{ postMessage: (/** @type {unknown} */ m) => replies.push(m) }] });
  assert.deepEqual(JSON.parse(JSON.stringify(replies)), [{ version: VERSION, files: FILES.length }]);
  assert.equal(sw.self.skipped, false, 'an update waits by default');
  await sw.fire('message', { data: { type: 'SKIP_WAITING' }, ports: [] });
  assert.equal(sw.self.skipped, true);
});
