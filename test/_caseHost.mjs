// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _caseHost.mjs — one HTTP server and one browser for a smoke made of several cases.
//
// Launching Chrome, loading the module graph and creating a renderer cost about a second per smoke,
// so related smokes run as cases of one file. Each case still gets its OWN page (its own GL
// context, renderer, workers and module instances), so no case sees another's state; only the
// browser process is shared. Tests whose assertions depend on a fresh program compile in a fresh
// browser must not be cases here: ANGLE's in-browser program cache would turn their fresh arms
// into cache hits.
//
//   const host = await openCaseHost(ROOT);
//   const failures = await runCases(host, [['blend', blendCase], ...]);
//
// A case is `async (host) => failureCount`. It registers its page with `host.page(html)`, which
// returns the page's URL, opens it on `await host.browser.newPage()` and closes that page when done.
// Everything else is served from the package root, with the content types a page needs.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { launchBrowser } from './_launch.mjs';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.glsl': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.wasm': 'application/wasm',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};
const typeOf = (p) => TYPES[path.extname(p).toLowerCase()] || 'application/octet-stream';

/** The lane's GPU switches: Metal through ANGLE by default, SwiftShader under MANTLE_TEST_GL=swiftshader. */
export const gpuArgs = () =>
  process.env.MANTLE_TEST_GL === 'swiftshader'
    ? ['--enable-unsafe-swiftshader', '--no-sandbox']
    : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'];

/**
 * Start the server and the browser.
 * @param {string} root package root the server reads files from
 * @param {object} [launch] options for launchBrowser (default: headless, the lane's GPU switches)
 * @param {{ deny?: (path: string) => boolean }} [opts] `deny`: answer 404 for these paths (the GPU
 *   harnesses refuse the generated shader cache, so the shaders come from the workspace sources)
 */
export async function openCaseHost(
  root,
  launch = { headless: 'new', args: gpuArgs() },
  { deny } = {},
) {
  const pages = new Map();
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pages.has(p)) {
      res.writeHead(200, { 'content-type': TYPES['.html'] });
      res.end(pages.get(p));
      return;
    }
    // The browser asks once for an icon; a 404 there would print as a console error on whichever
    // case's page happened to be first.
    if (p === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    let body;
    try {
      if (deny && deny(p)) throw new Error('denied');
      body = readFileSync(path.join(root, p));
    } catch {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': typeOf(p) });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  let browser;
  try {
    browser = await launchBrowser(launch);
  } catch (e) {
    server.close();
    throw e;
  }
  return {
    browser,
    /** Serve `html` as a page of its own and return its URL (a root-level path, so relative URLs resolve as from `/`). */
    page(html) {
      const p = `/case-${pages.size + 1}.html`;
      pages.set(p, html);
      return base + p.slice(1);
    },
    /** URL of a file under the package root, e.g. url('mantleDemo.html?svg=x'). */
    url: (rel = '') => base + rel,
    async close() {
      try {
        await browser.close();
      } finally {
        server.close();
      }
    },
  };
}

/**
 * Run the cases in order, each under a header line, and close the host. A case that throws counts
 * as one failure and the next case still runs. Each case ends with a line giving its wall time, so
 * a slow file says which case the time went to. Returns the total failure count.
 * @param {Awaited<ReturnType<typeof openCaseHost>>} host
 * @param {Array<[string, (host: any) => Promise<number>]>} cases
 */
export async function runCases(host, cases) {
  let failures = 0;
  try {
    for (const [name, run] of cases) {
      console.log(`\n-- ${name}`);
      const t0 = Date.now();
      try {
        failures += (await run(host)) | 0;
      } catch (e) {
        failures++;
        console.error(`FAIL ${name}: the case threw: ${(e && e.stack) || e}`);
      }
      console.log(`   (${name}: ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    }
  } finally {
    await host.close();
  }
  return failures;
}
