// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _pageSuite.mjs: one HTTP server and one Chrome for a smoke that runs several page cases.
//
// Each case still gets a FRESH PAGE: its own document, module instances, WebGL context and renderer. What the
// cases share is the browser process, so a smoke of N cases pays one Chrome launch instead of N. Cases that must
// compile their programs in a fresh browser (an A/A protocol, a "first compile" assertion) do not belong in a
// suite: ANGLE's program cache lives in the GPU process and turns a later page's compile into a cache hit.
//
// The cases share ONE wait budget, derived from the lane's per-test cap (`pageTimeoutFor`): every navigation
// and readiness wait gets what is left of it, so a case that hangs still leaves the file time to report it and
// close down before the runner's kill, and a healthy case never waits on a fixed ceiling.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';
import { pageTimeoutFor } from './_laneBudget.mjs';

/**
 * Pass/fail bookkeeping for a smoke made of named cases. Every line carries its case's name, so a failure in a
 * merged log says which case it belongs to.
 *   `begin(name)` starts a case; `ok(m)` / `fail(m)` report in it; `caseFailures()` counts the current case's
 *   failures and `failures()` the whole file's; `run(cases, ...args)` runs `[name, fn]` pairs in order, each
 *   called with `args`, reports a case that throws as a failure of that case, and prints each case's wall time.
 */
export function tally() {
  let total = 0,
    inCase = 0,
    name = '';
  const t = {
    begin(n) {
      name = n;
      inCase = 0;
      console.log(`\n── ${n}`);
    },
    ok: (m) => console.log(`ok [${name}] ${m}`),
    fail: (m) => {
      total++;
      inCase++;
      console.error(`FAIL [${name}] ${m}`);
    },
    caseFailures: () => inCase,
    failures: () => total,
    async run(cases, ...args) {
      for (const [n, fn] of cases) {
        t.begin(n);
        const t0 = Date.now();
        try {
          await fn(...args);
        } catch (e) {
          t.fail('threw: ' + String((e && e.stack) || e));
        }
        console.log(`  (${n}: ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
      }
    },
  };
  return t;
}

/** The lane's GPU switches: Metal through ANGLE, or SwiftShader when MANTLE_TEST_GL asks for it. */
export const GPU_ARGS =
  process.env.MANTLE_TEST_GL === 'swiftshader'
    ? ['--enable-unsafe-swiftshader', '--no-sandbox']
    : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'];

const MIME = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.glsl': 'text/plain',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.wasm': 'application/wasm',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff2': 'font/woff2',
};

/**
 * Start the server and the browser.
 * @param {{ root: string, args?: string[], budgetMs?: number }} opts
 *   `root`: the directory served at `/` (the package root, so pages import `/src/index.js`). `args`: Chrome
 *   switches (default GPU_ARGS). `budgetMs`: the wait budget all cases share (default `pageTimeoutFor(280000)`).
 */
export async function openPageSuite({ root, args = GPU_ARGS, budgetMs } = {}) {
  const t0 = Date.now();
  const budget = budgetMs > 0 ? budgetMs : pageTimeoutFor(280000);
  const pages = new Map();
  const routes = new Map();
  let seq = 0;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const send = (type, body) => {
      res.writeHead(200, { 'content-type': type });
      res.end(body);
    };
    if (u.pathname === '/' && pages.has(u.searchParams.get('case')))
      return send('text/html; charset=utf-8', pages.get(u.searchParams.get('case')));
    // No icon: answered empty rather than 404, which every page would log as a console error.
    if (u.pathname === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }
    const route = routes.get(u.pathname);
    if (route) return send(route.type, route.body);
    const p = decodeURIComponent(u.pathname);
    try {
      const body = readFileSync(path.join(root, p));
      send(MIME[path.extname(p)] || 'application/octet-stream', body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await launchBrowser({ headless: 'new', args });
  } catch (e) {
    server.close();
    throw e;
  }
  /** What is left of the shared wait budget, in ms (at least 1 s, so a late case still fails loudly). */
  const left = () => Math.max(1000, budget - (Date.now() - t0));
  const suite = {
    origin,
    browser,
    left,
    /** Serve `body` at `pathname` for every page of the suite (a fixture a page fetches by URL). */
    route(pathname, type, body) {
      const had = routes.get(pathname);
      if (had && (had.type !== type || String(had.body) !== String(body)))
        throw new Error(`_pageSuite: ${pathname} is already served with other content`);
      routes.set(pathname, { type, body });
    },
    /** Register a page and return its URL. */
    url(html) {
      const id = String(++seq);
      pages.set(id, html);
      return `${origin}/?case=${id}`;
    },
    /** A fresh page that prints its uncaught errors and console errors (`logs: false` leaves that to the caller). */
    async page({ logs = true } = {}) {
      const page = await browser.newPage();
      if (logs) {
        page.on('pageerror', (e) => console.error('  [page-err]', e.message));
        page.on('console', (m) => {
          if (m.type() === 'error') console.error('  [console]', m.text());
        });
      }
      return page;
    },
    /** Navigate `page` to `html` and wait for `ready` (an `openReady` form) inside the shared budget. */
    goto(page, html, { ready = 'flag', name, waitUntil } = {}) {
      return openReady(page, suite.url(html), { ready, readyMs: left(), name, waitUntil });
    },
    /** Navigate `page` to a path served from `root` (`/mantleDemo.html?svg=...`) and wait for `ready`. */
    visit(page, url, { ready = 'flag', name, waitUntil } = {}) {
      return openReady(page, origin + url, { ready, readyMs: left(), name, waitUntil });
    },
    /** A fresh page on `html`, ready; throws (with openReady's diagnosis) if it never gets there. */
    async open(html, opts = {}) {
      const page = await suite.page(opts);
      try {
        await suite.goto(page, html, opts);
      } catch (e) {
        await page.close().catch(() => {});
        throw e;
      }
      return page;
    },
    /**
     * Run a page that publishes one result: open `html` on a fresh page, wait for `done`, return `value` evaluated
     * in the page, and close the page. A page that never finishes is reported and its partial value (often an
     * error the page caught) is still returned, or null.
     */
    async result(
      html,
      { done = () => window.__done === true, value = () => window.__r, ...opts } = {},
    ) {
      const page = await suite.page(opts);
      try {
        await suite.goto(page, html, { ...opts, ready: done });
      } catch (e) {
        console.error('  ' + String(e.message).slice(0, 3000));
      }
      try {
        return await page.evaluate(value);
      } catch {
        return null;
      } finally {
        await page.close().catch(() => {});
      }
    },
    async close() {
      try {
        await browser.close();
      } finally {
        server.close();
      }
    },
  };
  return suite;
}
