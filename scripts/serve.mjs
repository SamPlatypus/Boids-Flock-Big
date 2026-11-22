#!/usr/bin/env node
/**
 * Zero-dependency static file server for local development.
 *
 *   node scripts/serve.mjs            → http://localhost:8080 (this machine only)
 *   node scripts/serve.mjs --lan      → also reachable from phones on the same network
 *   PORT=3000 node scripts/serve.mjs  → custom port
 *
 * Serves the project directory with no caching. Dotfiles (.git, .env, …) and
 * paths outside the project are refused.
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
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
