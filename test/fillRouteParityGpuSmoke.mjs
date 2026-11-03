// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// fillRouteParityGpuSmoke — the fill route class on a real GPU (fillRouteClass.js; the fake-GL half is fillRouteClassSmoke.mjs).
//
//   1. STATIC ART draws on the cover pass under 'auto': its pixels are IDENTICAL to a renderer built with unifiedFill:false (same route, same program),
//      and agree with the forced unified route to within anti-aliasing noise (the cover pass is the more accurate of the two: tiger 0.41 vs 0.54
//      mean error against Chrome).
//   2. A MORPH keeps the unified GPU-lerp route under 'auto': unified draws > 0, the bound variant carries MANTLE_LB_MORPH, its pixels equal the forced
//      unified render exactly (same route), and its static source pose still draws on the cover pass before and after the morph exists.
//   3. The route class reports itself: debugStats.fillRouteReason is 'static-cover' / 'morph'.
// Timing parity of the morph route (auto <= forced unified + A/A, 512 px and 3456x2169) is a timing question, not this smoke's.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const blob = (cx, cy, r) =>
  `M${cx - r} ${cy} C${cx - r} ${cy - r * 1.1} ${cx + r} ${cy - r} ${cx + r} ${cy} C${cx + r} ${cy + r * 1.2} ${cx - r} ${cy + r} ${cx - r} ${cy}Z`;
const svg = (b) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${b}</svg>`;
const STATIC = svg(
  [
    [30, 30],
    [70, 30],
    [30, 70],
    [70, 70],
  ]
    .map(([x, y], i) => `<path d="${blob(x, y, 18)}" fill="hsl(${i * 80},60%,45%)"/>`)
    .join(''),
);
const MA = svg(`<path d="${blob(50, 50, 20)}" fill="#c03030"/>`),
  MB = svg(`<path d="${blob(50, 50, 34)}" fill="#c03030"/>`);

const HTML = `<!doctype html><html><body><script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, createShapeMorph } from '/src/index.js';
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const N = 1024, S = ${JSON.stringify({ STATIC, MA, MB })};
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192)); return btoa(s); };
async function run(opts, what) {
  const c = document.createElement('canvas'); c.width = N; c.height = N; document.body.appendChild(c);
  const gl = c.getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, depth: true, stencil: true });
  const r = createRenderer(gl, shaders, opts); await r.ready; r.setViewport(N, N);
  const a = createBundle(gl, await importSvg(S.MA, {})), b = createBundle(gl, await importSvg(S.MB, {}));
  const st = createBundle(gl, await importSvg(S.STATIC, {}));
  const m = createShapeMorph(gl, a, b);
  const target = what === 'morph' ? m : st;
  const out = {};
  const frame = (t) => { if (what === 'morph') m.setT(t); r.beginFrame([1, 1, 1, 1]); r.drawBundle(target); r.endFrame(); };
  for (const bd of [st, m]) { if (r.prepareBundle) r.prepareBundle(bd); try { await r.awaitLbReady(bd, 20000); } catch {} r.prewarmBundle(bd); }
  // Warm the drawn state until a whole pass (a frame, then the loading call) builds nothing, so the read frame binds its settled program.
  r.precompileFills();
  out.warmed = (await r.warmScene([{ draw: () => frame(0.5) }], { maxPasses: 16 })).complete;
  frame(0.5);
  const px = new Uint8Array(N * N * 4); gl.readPixels(0, 0, N, N, gl.RGBA, gl.UNSIGNED_BYTE, px);
  out.px = b64(px); out.routes = { ...((r.debugStats.engines || {}).routes || {}) }; out.reason = r.debugStats.fillRouteReason; out.key = r.debugStats.drawnFillVariantKey || '';
  // the source pose, drawn static after the morph exists
  r.beginFrame([1, 1, 1, 1]); r.drawBundle(a); r.endFrame(); out.sourceReason = r.debugStats.fillRouteReason;
  r.dispose && r.dispose(); c.remove();
  return out;
}
window.__run = async () => ({ staticAuto: await run({}, 'static'), staticOff: await run({ unifiedFill: false }, 'static'), staticForce: await run({ unifiedFill: 'force' }, 'static'),
  morphAuto: await run({}, 'morph'), morphForce: await run({ unifiedFill: 'force' }, 'morph') });
window.__ready = 1;
</script></body></html>`;
const server = http.createServer((q, res) => {
  try {
    if (q.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(HTML);
      return;
    }
    const pp = decodeURIComponent(q.url.split('?')[0]);
    res.writeHead(200, { 'content-type': pp.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, pp)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === 1, { timeout: 60000 });
  const R = await page.evaluate(() => window.__run());
  const px = (k) => Buffer.from(R[k].px, 'base64');
  const diff = (a, b, tol = 0) => {
    let n = 0,
      mx = 0;
    for (let i = 0; i < a.length; i += 4) {
      let d = 0;
      for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(a[i + c] - b[i + c]));
      if (d > tol) n++;
      if (d > mx) mx = d;
    }
    return { n, mx, frac: n / (a.length / 4) };
  };
  const dOff = diff(px('staticAuto'), px('staticOff'), 1),
    dForce = diff(px('staticAuto'), px('staticForce'), 0),
    dMorph = diff(px('morphAuto'), px('morphForce'), 1);
  ok(
    !(R.staticAuto.routes.unified | 0) && R.staticAuto.reason === 'static-cover',
    `(1) static art, auto: cover pass (unified draws ${R.staticAuto.routes.unified | 0}), reason '${R.staticAuto.reason}'`,
  );
  ok(
    dOff.n === 0,
    `(1) static art, auto == unifiedFill:false to within 1/255 of driver compile noise (${dOff.n} pixels differ by more than 1)`,
  );
  ok(
    dForce.n > 0 && dForce.frac < 0.02 && dForce.mx < 128,
    `(1) static art, auto vs forced unified (the forced render really took meshes: some pixels differ; anti-aliasing only): ${(dForce.frac * 100).toFixed(2)} % pixels differ, max channel delta ${dForce.mx} (anti-aliasing only)`,
  );
  ok(
    (R.morphAuto.routes.unified | 0) > 0 &&
      R.morphAuto.reason === 'morph' &&
      R.morphAuto.key.includes('MANTLE_LB_MORPH'),
    `(2) morph, auto: unified draws ${R.morphAuto.routes.unified | 0}, reason '${R.morphAuto.reason}', variant carries LB_MORPH: ${R.morphAuto.key.includes('MANTLE_LB_MORPH')}`,
  );
  ok(
    dMorph.n === 0,
    `(2) morph, auto == forced unified to within 1/255 (${dMorph.n} pixels differ by more than 1)`,
  );
  ok(
    R.morphAuto.sourceReason === 'static-cover',
    `(2) the static source pose still draws on the cover pass after the morph exists ('${R.morphAuto.sourceReason}')`,
  );
} finally {
  await browser.close();
  server.close();
}
console.log(fail ? `FAIL ${fail}` : 'PASS fillRouteParityGpuSmoke');
process.exit(fail ? 1 : 0);
