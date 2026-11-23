#!/usr/bin/env node
/**
 * Zero-dependency static file server for local development.
 *
 *   node scripts/serve.mjs            → http://localhost:8080 (this machine only)
 *   node scripts/serve.mjs --lan      → also reachable from phones on the same network
 *   PORT=3000 node scripts/serve.mjs  → custom port
 *   node scripts/serve.mjs _site      → serve another directory (npm run preview)
 *
 * Serves the directory with no HTTP caching. Dotfiles (.git, .env, …) and
 * paths outside it are refused.
 *
 * Development (serving the project itself): the offline service worker is
 * replaced by one that caches nothing, so edits show up on reload, and that
 * clears what a production worker saved on this origin. `npm run preview`
 * builds the site and serves it with the real, offline-first service worker.
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const rootArg = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
const ROOT = rootArg ? resolve(rootArg) : PROJECT;
const DEV = ROOT === PROJECT;

/** Stands in for sw.js during development: no fetch handler, so nothing is cached. */
const DEV_SERVICE_WORKER = `// Development service worker (scripts/serve.mjs): caches nothing.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('boids-')).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'STATUS' && event.ports[0]) event.ports[0].postMessage({ dev: true });
});
`;
const PORT = Number(process.env.PORT) || 8080;
const LAN = process.argv.includes('--lan');
const HOST = LAN ? '0.0.0.0' : '127.0.0.1';

/** @type {Record<string, string>} */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/plain; charset=utf-8',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const relative = decodeURIComponent(url.pathname);
    if (relative.split('/').some((part) => part.startsWith('.') && part.length > 0)) {
      return send(res, 403, 'Forbidden');
    }
    if (DEV && relative === '/sw.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(DEV_SERVICE_WORKER);
    }
    let file = resolve(join(ROOT, relative));
    if (file !== ROOT && !file.startsWith(ROOT + sep)) return send(res, 403, 'Forbidden');
    let info = await stat(file).catch(() => null);
    if (info?.isDirectory()) {
      file = join(file, 'index.html');
      info = await stat(file).catch(() => null);
    }
    if (!info?.isFile()) return send(res, 404, 'Not found');
    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-cache',
    });
    createReadStream(file).pipe(res);
  } catch {
    send(res, 400, 'Bad request');
  }
});

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} body
 */
function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

server.listen(PORT, HOST, () => {
  console.log(`Serving ${ROOT}`);
  if (DEV) console.log('  Offline caching is off here, so edits show on reload. Try the offline app: npm run preview');
  console.log(`  Local:   http://localhost:${PORT}/`);
  if (LAN) {
    for (const nets of Object.values(networkInterfaces())) {
      for (const net of nets ?? []) {
        if (net.family === 'IPv4' && !net.internal) console.log(`  Network: http://${net.address}:${PORT}/`);
      }
    }
  } else {
    console.log('  (run with --lan to open it on a phone on the same network)');
  }
});
