// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// filterUnhandledNodeSmoke.mjs — a filter primitive with no registered
// handler must degrade to unfiltered, not to nothing.
//
// Handlers register themselves on import (dispatchRegistry.js), so a build
// that ships only the primitives its assets need — the whole point of the
// per-primitive split — hits the no-handler path for anything it left out.
// A path that CLEARS there silently deletes the artwork rather than degrading
// it -- and svgFilterShared.js exports a `passthrough` that really does copy, so
// a no-handler path with the same name is easy to mistake for it.
//
// A full build registers everything, so no rendering test reaches this. The
// dispatch table is just an object evaluateGraph is handed, though, so the
// case can be built directly: one node with a handler that fills red, feeding
// a second node whose type is deliberately absent from the table.
//
//   handled(red) -> UNHANDLED -> root
//
// Red root = the input was copied through. Transparent root = it was cleared,
// which is the defect.

import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const mime = (p) =>
  p.endsWith('.html')
    ? 'text/html; charset=utf-8'
    : p.endsWith('.js') || p.endsWith('.mjs')
      ? 'text/javascript; charset=utf-8'
      : p.endsWith('.glsl')
        ? 'text/plain; charset=utf-8'
        : 'application/octet-stream';
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(u.pathname === '/' ? '/mantleDemo.html' : u.pathname);
  try {
    res.writeHead(200, { 'content-type': mime(p) });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    try {
      res.writeHead(404);
      res.end();
    } catch {}
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

let failures = 0;
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};
const ok = (m) => console.log('  ok ' + m);

const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 64, height: 64 });
page.on('pageerror', (e) => console.error('  [page-err]', e.message));

try {
  await page.goto(`http://127.0.0.1:${server.address().port}/mantleDemo.html`, {
    waitUntil: 'load',
    timeout: 20000,
  });
  await page.waitForFunction(() => window.__mantleGl, { timeout: 20000, polling: 100 });

  const r = await page.evaluate(async () => {
    const { createRTPool, evaluateGraph, releaseRoot } =
      await import('/src/filterGraph/filterGraph.js');
    const gl = window.__mantleGl;
    const W = 64,
      H = 64;
    const pool = createRTPool(gl);

    // Fills its output with opaque red. Stands in for any registered handler.
    const fillRed = (node, inputs, outRT) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, outRT.fbo);
      gl.viewport(0, 0, outRT.size[0], outRT.size[1]);
      gl.disable(gl.BLEND);
      gl.clearColor(1, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    };

    const readRoot = (dispatch) => {
      const graph = {
        nodes: [
          { type: 'FillRed', inputs: [], params: null },
          // Absent from every dispatch table below.
          { type: 'NotRegistered', inputs: [0], params: null },
        ],
        rootOut: 1,
      };
      const ctx = { gl, pool, w: W, h: H };
      const root = evaluateGraph(gl, graph, pool, dispatch, ctx, W, H);
      const px = new Uint8Array(4);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, root.fbo);
      gl.readPixels(W >> 1, H >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      releaseRoot(pool, root);
      return Array.from(px);
    };

    // Control: the same graph with a handler for both nodes. Pins that the
    // harness renders red at all, so a transparent result in the real case
    // means the fallback, not a broken rig.
    const control = readRoot({ FillRed: fillRed, NotRegistered: fillRed });
    const unhandled = readRoot({ FillRed: fillRed });

    pool.invalidate();
    return { control, unhandled };
  });

  if (r.control[0] > 200 && r.control[3] > 200) {
    ok(`T1 control: both nodes handled renders red (${r.control.join(',')})`);
  } else {
    fail(`T1 control rendered ${r.control.join(',')} — the rig is broken, T2 would be meaningless`);
  }

  if (r.unhandled[3] < 40) {
    fail(
      `T2 unhandled node produced ${r.unhandled.join(',')} — the input was CLEARED, ` +
        'so a missing handler deletes the artwork (this is the bug)',
    );
  } else if (r.unhandled[0] > 200 && r.unhandled[3] > 200) {
    ok(`T2 unhandled node copies its input through (${r.unhandled.join(',')})`);
  } else {
    fail(`T2 unhandled node produced ${r.unhandled.join(',')}, expected the red input`);
  }
} catch (e) {
  fail(`drive failed: ${e.message}`);
}

await browser.close();
server.close();
console.log();
console.log(
  failures === 0 ? 'FILTER-UNHANDLED-NODE PASS' : `FILTER-UNHANDLED-NODE FAIL (${failures})`,
);
process.exit(failures === 0 ? 0 : 1);
