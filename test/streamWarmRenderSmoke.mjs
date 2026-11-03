// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// streamWarmRenderSmoke -- on the GPU: a stream the app declared, or updated once before the loading call, links and builds nothing in play, and draws the geometry of its last update.
//
// The counters are the page's own: links through the context's linkProgram, pipelines first built after the load through debugStats.gpuGate, blocked draws through debugStats.needMiss. The undeclared arm
// proves those counters can read anything but 0. CPU counterparts: declareStreamSmoke, streamUpdateBeforeLoadSmoke.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { launchBrowser } from './_launch.mjs';
import { installGpuThrottle, capWallTime, gpuThrottleBanner } from './_gpuThrottle.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html>');
    return;
  }
  const f = path.resolve(root, '.' + decodeURIComponent(u.pathname));
  if (!f.startsWith(root + path.sep)) {
    res.writeHead(404).end();
    return;
  }
  try {
    res.setHeader('Content-Type', f.endsWith('.js') ? 'text/javascript' : 'text/plain');
    res.end(readFileSync(f));
  } catch {
    res.writeHead(404).end();
  }
});
let browser;
const stop = async () => {
  await browser?.close();
  await new Promise((r) => server.close(r));
};
const cap = capWallTime('streamWarmRenderSmoke', stop);
console.log(gpuThrottleBanner());
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const none = (d) => d.links === 0 && d.pipelines === 0 && d.blocked === 0;
const say = (d) => `${d.links} links, ${d.pipelines} pipelines, ${d.blocked} blocked`;
try {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  browser = await launchBrowser({
    headless: 'new',
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=metal', '--enable-gpu'],
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error(e));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await installGpuThrottle(page);
  const rows = await page.evaluate(async () => {
    const api = await import('/src/index.js');
    const shaders = await api.loadShaders(new URL('/src/shaders/', location.href));
    const svgOf = (d) =>
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M${10 + d} 10 C ${20 + d} 20 ${40 + d} 40 ${60 + d} 90 L ${10 + d} 90 L ${10 + d} 10 Z" fill="#303"/></svg>`;
    const { mkLine, mkCubic, mkQuad } = api;
    const cubic = (d) => [
      mkCubic([10 + d, 10], [20 + d, 20], [40 + d, 40], [60 + d, 90]),
      mkLine([60 + d, 90], [10 + d, 90]),
      mkLine([10 + d, 90], [10 + d, 10]),
    ];
    const quad = (d) => [
      mkQuad([10 + d, 10], [40 + d, 20], [60 + d, 90]),
      mkLine([60 + d, 90], [10 + d, 90]),
      mkLine([10 + d, 90], [10 + d, 10]),
    ];
    const size = 512,
      sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const O = { asyncShaderCompile: true, nonBlocking: true, standIns: false, strictPlay: true };
    const context = () => {
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const gl = c.getContext('webgl2', { premultipliedAlpha: true, preserveDrawingBuffer: true });
      if (!gl) throw Error('WebGL2 required');
      return gl;
    };
    const read = (gl) => {
      const p = new Uint8Array(size * size * 4);
      gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, p);
      return p;
    };
    const cmp = (a, c) => {
      let n = 0,
        big = 0,
        max = 0,
        ink = 0;
      for (let i = 0; i < a.length; i += 4) {
        let m = 0;
        for (let j = 0; j < 4; j++) m = Math.max(m, Math.abs(a[i + j] - c[i + j]));
        if (m) n++;
        if (m > 64) big++;
        max = Math.max(max, m);
        if (a[i] !== 255) ink++;
      }
      return { n, big, max, ink };
    };
    // the reference: the geometry of the last update, imported and drawn by a plain renderer, framed like the streams (viewBox, and [0,0,100,100] for the fixed box).
    const refGl = context();
    const reference = await (async () => {
      const R = api.createRenderer(refGl, shaders, O);
      await R.ready;
      R.setViewport(size, size);
      const b = api.createBundle(refGl, await api.importSvg(svgOf(6), { preserveViewport: true }));
      await R.precompileFillsAsync({});
      for (let i = 0; i < 20; i++) {
        R.beginFrame([1, 1, 1, 1]);
        R.drawBundle(b);
        R.endFrame();
        await sleep(8);
      }
      R.beginFrame([1, 1, 1, 1]);
      R.drawBundle(b);
      R.endFrame();
      const p = read(refGl);
      R.dispose();
      return p;
    })();
    const run = async ({ make, declare, before, mode }) => {
      const gl = context();
      let links = 0;
      const lp = gl.linkProgram.bind(gl);
      gl.linkProgram = (p) => {
        links++;
        lp(p);
      };
      const R = api.createRenderer(gl, shaders, O);
      await R.ready;
      R.setViewport(size, size);
      const b = api.createBundle(gl, await make());
      if (declare) R.declareStream(b);
      const update = (segs) => api.updateBundleGeometry(gl, b, [segs], mode);
      if (before) update(cubic(1));
      await R.precompileFillsAsync({});
      const frames = async (n) => {
        for (let i = 0; i < n; i++) {
          R.beginFrame([1, 1, 1, 1]);
          R.drawBundle(b);
          R.endFrame();
          await sleep(8);
        }
      };
      const mark = () => ({
        links,
        pipelines: R.debugStats.gpuGate.postReadyCount | 0,
        blocked: R.debugStats.needMiss.blocked | 0,
      });
      const since = (m) => {
        const n = mark();
        return {
          links: n.links - m.links,
          pipelines: n.pipelines - m.pipelines,
          blocked: n.blocked - m.blocked,
        };
      };
      await frames(20);
      const m0 = mark();
      const r1 = update(cubic(2));
      await frames(30);
      const first = since(m0);
      const m1 = mark();
      const r2 = update(quad(4));
      await frames(15);
      const r3 = update(cubic(6));
      await frames(15);
      const later = since(m1);
      const pix = read(gl);
      const diff = cmp(reference, pix);
      const out = {
        box: b.globalBBox && Array.from(b.globalBBox),
        ok: r1.ok && r2.ok && r3.ok,
        first,
        later,
        diff,
        err: gl.getError(),
        outside: R.debugStats.needMiss.kOutsideWarmSet | 0,
        key: (R.debugStats.drawnFillVariantKey || '').includes('MANTLE_LB_FILL')
          ? 'unified'
          : 'cover',
      };
      R.dispose();
      return out;
    };
    const imported = () => api.importSvg(svgOf(0), { preserveViewport: true });
    const lightweight = () =>
      api.buildStreamableSections(
        [{ segs: cubic(0), fill: [0x33 / 255, 0, 0x33 / 255, 1] }],
        [0, 0, 100, 100],
        { lightweight: true },
      );
    const out = {};
    out.undeclared = await run({ make: imported });
    out.declared = await run({ make: imported, declare: true });
    out.lightBefore = await run({ make: lightweight, before: true, mode: { lightweight: true } });
    out.declaredLightBefore = await run({
      make: imported,
      declare: true,
      before: true,
      mode: { lightweight: true },
    });
    out.lightInPlay = await run({ make: lightweight, mode: { lightweight: true } });
    return out;
  });
  for (const [k, r] of Object.entries(rows)) console.log(k, JSON.stringify(r));
  const U = rows.undeclared,
    D = rows.declared,
    L = rows.lightBefore,
    DL = rows.declaredLightBefore;
  ok(
    !none(U.first) || !none(U.later),
    `(the premise) an undeclared imported stream builds in play: first update ${say(U.first)}, later ${say(U.later)}`,
  );
  ok(D.ok && none(D.first), `a declared imported stream's first update: ${say(D.first)}`);
  ok(none(D.later), `and later ones, one bringing a new segment type: ${say(D.later)}`);
  ok(
    D.diff.big === 0 && D.diff.max <= 2,
    `it draws the last update's geometry: ${D.diff.n} px differ, max ${D.diff.max}/255, ${D.diff.ink} px of ink`,
  );
  ok(
    L.ok && none(L.first),
    `a lightweight stream updated once before the load, its first update in play: ${say(L.first)}`,
  );
  ok(none(L.later), `and later ones, one bringing a new segment type: ${say(L.later)}`);
  ok(
    L.diff.big <= L.diff.ink * 0.01,
    `it draws the last update's geometry: ${L.diff.big} px beyond 64/255 of ${L.diff.ink} px of ink`,
  );
  ok(
    DL.ok && none(DL.first) && none(DL.later),
    `declared imported art updated lightweight once before the load: first ${say(DL.first)}, later ${say(DL.later)}`,
  );
  ok(
    DL.diff.big <= DL.diff.ink * 0.01,
    `it draws the last update's geometry: ${DL.diff.big} px beyond 64/255 of ${DL.diff.ink} px of ink`,
  );
  console.log(
    `  (printed, not asserted) a lightweight stream first updated in play: ${say(rows.lightInPlay.first)}`,
  );
  for (const [k, r] of Object.entries(rows)) ok(r.err === 0, `${k}: no GL error (${r.err})`);
} catch (e) {
  console.error(e);
  fail++;
} finally {
  clearTimeout(cap);
  await stop();
}
console.log(fail ? `\n${fail} FAILED` : '\nPASS');
process.exit(fail ? 1 : 0);
