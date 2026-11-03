// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _cdnServer.mjs - a static HTTP server for the UNBUNDLED package, as a CDN serves it. Test support only.
//
// Runs in a worker thread: node links modules synchronously through a module-customization hook (test/_httpEsmLoader.mjs), which
// would deadlock a server living on the thread that is waiting for its answer. Responses are application/javascript for .js, text/plain
// for GLSL, with optional CORS; every request path is logged, read back with `await cdn.log()` (GET /__log).
import { Worker, isMainThread, workerData, parentPort } from 'node:worker_threads';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(import.meta.url);
const PKG = path.resolve(path.dirname(HERE), '..');
const TYPES = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.html': 'text/html',
  '.glsl': 'text/plain',
};

if (!isMainThread && workerData && workerData.cdnServer) {
  const { cors, routes } = workerData;
  const log = [];
  const server = http.createServer((req, res) => {
    // Module identity tests do not need pooled sockets or idle-expiry races.
    res.setHeader('Connection', 'close');
    const url = new URL(req.url, 'http://x');
    const headers = {};
    if (cors) {
      headers['Access-Control-Allow-Origin'] = '*';
      headers['Cross-Origin-Resource-Policy'] = 'cross-origin';
    }
    if (url.pathname === '/__log') {
      res.writeHead(200, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(log));
      return;
    }
    log.push(url.pathname);
    const route = routes[url.pathname];
    if (route) {
      res.writeHead(200, { 'Content-Type': route.type || 'text/html', ...headers });
      res.end(route.body);
      return;
    }
    const file = path.join(PKG, decodeURIComponent(url.pathname));
    if (
      !file.startsWith(PKG + path.sep) ||
      !/^\/(src\/|package\.json$)/.test(url.pathname) ||
      !fs.existsSync(file) ||
      !fs.statSync(file).isFile()
    ) {
      res.writeHead(404, headers);
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      ...headers,
    });
    fs.createReadStream(file).pipe(res);
  });
  server.listen(0, '127.0.0.1', () => parentPort.postMessage({ port: server.address().port }));
  parentPort.on('message', (m) => {
    if (m === 'close') {
      server.closeAllConnections?.();
      server.close(() => process.exit(0));
    }
  });
}

/** @param {{ cors?: boolean, routes?: Record<string, {type?: string, body: string}> }} [o] */
export async function startCdn({ cors = false, routes = {} } = {}) {
  const worker = new Worker(HERE, { workerData: { cdnServer: true, cors, routes } });
  const port = await new Promise((ok, no) => {
    worker.once('message', (m) => ok(m.port));
    worker.once('error', no);
  });
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    port,
    log: async () => (await fetch(origin + '/__log')).json(),
    close: () =>
      new Promise((ok) => {
        worker.once('exit', ok);
        worker.postMessage('close');
      }),
  };
}
