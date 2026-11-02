// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// coincidentAaSmoke.mjs — a shape hidden under an opaque one must not tint its AA edge.
//
// THE CONFLATION ARTIFACT. Two coincident shapes are each anti-aliased against what is
// already there. The lower one blends its edge with the background; the upper one then
// blends ITS edge over that — so the shared boundary is composited twice and comes out
// darker than either shape's edge alone: two identical ridges stacked under a
// translucent one show a dark fringe.
//
// The occlusion cull handles it: a shape a later OPAQUE shape fully covers contributes
// nothing, so it is dropped from the draw list and its edge never composites.
//
// "Dropped from the draw list" is the whole subtlety. Any render path that does not read
// bundle.drawList does not get the cull — and one of them doesn't.
//
// So: render a scene with a hidden duplicate, and the same scene WITHOUT the duplicate,
// through every path. Each path is compared against itself, so a path's own AA character
// cancels out and only the conflation shows.

import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { emitFixture } from './_fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(u.pathname === '/' ? '/mantleDemo.html' : u.pathname);
  const m = p.endsWith('.html')
    ? 'text/html'
    : p.endsWith('.js') || p.endsWith('.mjs')
      ? 'text/javascript'
      : p.endsWith('.glsl')
        ? 'text/plain'
        : 'application/octet-stream';
  let body;
  try {
    body = readFileSync(path.join(ROOT, p));
  } catch {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': m + '; charset=utf-8' });
  res.end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/mantleDemo.html`;

// A curved shape (so it has a long AA boundary) in a strong color on a contrasting
// background. The DUPE is the same path drawn underneath — fully covered, contributes
// nothing, and must be culled.
const SHAPE = `<path d="M60,200 C60,110 130,45 220,45 C310,45 380,110 380,200 C380,290 310,355 220,355 C130,355 60,290 60,200 Z" fill="#c0392b"/>`;
const REF = readFileSync(
  new URL('../examples/smoke/coincidentAa__REF.svg', import.meta.url),
  'utf8',
);
const DUPE = readFileSync(
  new URL('../examples/smoke/coincidentAa__DUPE.svg', import.meta.url),
  'utf8',
);

let failures = 0;
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};
const ok = (m) => console.log('ok', m);

const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 500, height: 500 });
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
// Count real instanced draws, so "it took the fast path" is measured, not assumed.
await page.evaluateOnNewDocument(() => {
  globalThis.__instCalls = 0;
  const P = WebGL2RenderingContext.prototype,
    o = P.drawArraysInstanced;
  P.drawArraysInstanced = function (...a) {
    globalThis.__instCalls++;
    return o.apply(this, a);
  };
});
await page.goto(url, { waitUntil: 'load', timeout: 20000 });
await page.waitForFunction(
  () => window.__mantleRenderer && window.__mantleGl && window.__mantleShaderSources,
  { timeout: 20000, polling: 100 },
);

const payload = await page.evaluate(
  async (REF, DUPE) => {
    const M = await import('/src/index.js');
    const gl = window.__mantleGl;
    const base = window.__mantleRenderer;
    const cnv = document.getElementById('glcanvas');
    const W = 440,
      H = 400;
    cnv.width = W;
    cnv.height = H;

    let aac = null;
    const getAac = () =>
      aac || (aac = M.createRenderer(gl, window.__mantleShaderSources, { aacFill: true }));

    const shot = () => {
      const px = new Uint8Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px;
    };

    // Each path draws ONE bundle and returns the frame.
    const PATHS = {
      'handle.draw': async (svg) => {
        const b = M.createBundle(gl, await M.importSvg(svg));
        const h = base.createBundleHandle(b);
        base.setLoopBlinnFill('auto');
        base.beginFrame([1, 1, 1, 1]);
        h.draw({});
        base.endFrame();
        const p = shot();
        h.dispose();
        b.dispose();
        return p;
      },
      drawBundle: async (svg) => {
        const b = M.createBundle(gl, await M.importSvg(svg));
        base.setLoopBlinnFill('auto');
        base.beginFrame([1, 1, 1, 1]);
        base.drawBundle(b);
        base.endFrame();
        const p = shot();
        b.dispose();
        return p;
      },
      // TWO instances, side by side. The fast path is gated on instances.length >= 2 — with a
      // single instance drawBundleInstanced quietly takes the LOOP, so a one-instance "fast
      // path" test is testing the loop twice and would miss anything the fast path gets wrong.
      'instanced FAST': async (svg) => {
        globalThis.__MANTLE_DEBUG__ = true;
        globalThis.__MANTLE_NO_INSTANCED_FAST = undefined;
        const b = M.createBundle(gl, await M.importSvg(svg));
        base.setLoopBlinnFill('off'); // keep it on the Slug instanced path
        globalThis.__instCalls = 0;
        base.beginFrame([1, 1, 1, 1]);
        base.drawBundleInstanced(b, [
          { worldMatrix: [0.5, 0, 0, 0, 0.5, 0, -0.45, 0, 1] },
          { worldMatrix: [0.5, 0, 0, 0, 0.5, 0, 0.45, 0, 1] },
        ]);
        base.endFrame();
        const p = shot();
        b.dispose();
        base.setLoopBlinnFill('auto');
        p._instanced = globalThis.__instCalls;
        return p;
      },
      'instanced LOOP': async (svg) => {
        globalThis.__MANTLE_NO_INSTANCED_FAST = true;
        const b = M.createBundle(gl, await M.importSvg(svg));
        base.setLoopBlinnFill('off');
        base.beginFrame([1, 1, 1, 1]);
        base.drawBundleInstanced(b, [
          { worldMatrix: [0.5, 0, 0, 0, 0.5, 0, -0.45, 0, 1] },
          { worldMatrix: [0.5, 0, 0, 0, 0.5, 0, 0.45, 0, 1] },
        ]);
        base.endFrame();
        const p = shot();
        b.dispose();
        globalThis.__MANTLE_NO_INSTANCED_FAST = undefined;
        base.setLoopBlinnFill('auto');
        return p;
      },
      'static cache': async (svg) => {
        const b = M.createBundle(gl, await M.importSvg(svg));
        const h = base.createBundleHandle(b, {
          staticCache: { strategy: M.CacheStrategy.ForceWholeAsset },
        });
        base.setLoopBlinnFill('auto');
        base.beginFrame([1, 1, 1, 1]);
        h.draw({});
        base.endFrame(); // bake
        base.beginFrame([1, 1, 1, 1]);
        h.draw({});
        base.endFrame(); // blit
        const p = shot();
        h.dispose();
        b.dispose();
        return p;
      },
      'Loop-Blinn': async (svg) => {
        const b = M.createBundle(gl, await M.importSvg(svg));
        const h = base.createBundleHandle(b);
        base.setLoopBlinnFill('on');
        if (base.awaitLbReady) await base.awaitLbReady(b);
        base.beginFrame([1, 1, 1, 1]);
        h.draw({});
        base.endFrame();
        const p = shot();
        h.dispose();
        b.dispose();
        base.setLoopBlinnFill('auto');
        return p;
      },
      AAC: async (svg) => {
        const r = getAac();
        const b = M.createBundle(gl, await M.importSvg(svg));
        const h = r.createBundleHandle(b);
        r.setLoopBlinnFill('off');
        r.beginFrame([1, 1, 1, 1]);
        h.draw({});
        r.endFrame();
        const p = shot();
        h.dispose();
        b.dispose();
        return p;
      },
    };

    // VACUITY GUARD. If the duplicate is not actually THERE and actually CULLED, every
    // comparison below is two identical renders of the same thing and proves nothing.
    const probe = M.createBundle(gl, await M.importSvg(DUPE));
    const probeRef = M.createBundle(gl, await M.importSvg(REF));
    const guard = {
      dupeShapes: probe.numShapes,
      refShapes: probeRef.numShapes,
      culled: probe._culledShapes ? probe._culledShapes.size : 0,
      drawOps: (probe.drawList || []).filter((o) => o.kind === 'fillShape').length,
    };
    probe.dispose();
    probeRef.dispose();

    const out = [];
    for (const [name, run] of Object.entries(PATHS)) {
      const ref = await run(REF);
      const dup = await run(DUPE);
      // Count pixels where the duplicate changed the picture, and how strongly. The
      // conflation shows only on the AA boundary — the interior is opaque either way.
      let diff = 0,
        worst = 0,
        ink = 0;
      for (let i = 0; i < ref.length; i += 4) {
        if (ref[i] < 240 || ref[i + 1] < 240 || ref[i + 2] < 240) ink++;
        const d = Math.max(
          Math.abs(ref[i] - dup[i]),
          Math.abs(ref[i + 1] - dup[i + 1]),
          Math.abs(ref[i + 2] - dup[i + 2]),
        );
        if (d > 3) diff++;
        if (d > worst) worst = d;
      }
      out.push({ name, diff, worst, ink, instanced: dup._instanced });
    }
    return { out, guard };
  },
  REF,
  DUPE,
);

const { out: res, guard } = payload;
console.log(
  `  the DUPE bundle: ${guard.dupeShapes} shapes (ref has ${guard.refShapes}), ` +
    `${guard.culled} culled, ${guard.drawOps} fill ops left in the draw list\n`,
);
if (guard.dupeShapes <= guard.refShapes) {
  fail(
    `the duplicate did not survive the import (${guard.dupeShapes} shapes vs the ref's ` +
      `${guard.refShapes}) — there is nothing hidden, so every comparison below is two ` +
      `identical renders and proves nothing`,
  );
}
if (guard.culled < 1) {
  fail(
    `NOTHING WAS CULLED (${guard.culled}) — so the 0px results below are not the cull ` +
      `working, they are something else, and this smoke would pass with the cull deleted`,
  );
}
console.log('  a fully-hidden duplicate must change NOTHING:\n');
console.log('  path              edge px changed   worst   ink');
for (const r of res) {
  const inst = r.instanced != null ? `   [${r.instanced} drawArraysInstanced]` : '';
  console.log(
    `  ${r.name.padEnd(16)} ${String(r.diff).padStart(11)}   ${String(r.worst).padStart(5)}   ${r.ink}${inst}`,
  );
}
console.log('');
const fastRow = res.find((r) => r.name === 'instanced FAST');
if (fastRow && !fastRow.instanced) {
  fail(
    `the "instanced FAST" case never issued a drawArraysInstanced — it fell back to the ` +
      `per-instance loop, so the fast path is NOT being tested here at all`,
  );
} else if (fastRow) {
  ok(`the instanced fast path is genuinely taken (${fastRow.instanced} drawArraysInstanced)`);
}
for (const r of res) {
  if (r.ink < 20000) {
    fail(
      `${r.name}: barely rendered (${r.ink}px of ink) — this path isn't drawing, so its ` +
        `comparison proves nothing`,
    );
    continue;
  }
  if (r.diff > 50) {
    fail(
      `${r.name}: a hidden duplicate changed ${r.diff} px (worst ${r.worst}). Its edge is ` +
        `being composited under the visible shape's edge — the CONFLATION artifact. The ` +
        `occlusion cull drops such shapes from bundle.drawList; a path that does not READ ` +
        `drawList never sees the cull.`,
    );
  } else {
    ok(`${r.name}: the hidden duplicate is culled (${r.diff} px changed)`);
  }
}

await browser.close();
server.close();
console.log(failures ? `\nFAILURES: ${failures}` : '\nCOINCIDENT-AA PASS');
process.exit(failures ? 1 : 0);
