// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cpatchMorphSwitchBackRenderSmoke -- a morph drawn pinned to CPatch, then switched to another engine, draws what a renderer that
// never pinned CPatch draws.
//
// A CPatch morph owns its bundle's fill meshes, posed at the last t it drew. Switching the renderer to the default route or to
// Loop-Blinn must release that claim: left in place, no other engine can take the bundle, and the unified route keeps drawing the
// posed CPatch stream (the pose of the last CPatch frame, its unplanned rows on whatever program the row count picked), or the
// classic Slug pass, while the request says LB.
//
// Six glyphs of real text (three with two contours) morph under a scale and a shift. A renderer created with cpatchFill draws them at
// t = 0.3 (with and without awaitLbReady), is switched to the default route (route 'auto', not committed) or to route 'lb', and draws
// t = 0.3 and t = 0.7. Each frame is compared with a fresh renderer created with that setting, settled the same way: at most BAR px may
// differ by more than 32/255, the ink must match within 1%, the engines that drew must be the fresh renderer's, and CPatch must not
// draw; under route 'lb', Loop-Blinn must draw.
import http from 'http';
import { fileURLToPath } from 'url';
import path from 'path';
import { readFileSync } from 'fs';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const W = 576,
  H = 208,
  BAR = 12,
  PIN_T = 0.3,
  TS = [0.3, 0.7];
const GLYPHS = [
  'M0.57373 0.36621 L0.34521 0.36621 L0.34521 1 L0.25195 1 L0.25195 0.36621 L0.02393 0.36621 L0.02393 0.28906 L0.57373 0.28906 L0.57373 0.36621 Z',
  'M0.75537 0.53564 Q0.81543 0.46191 0.91162 0.46191 Q1.0791 0.46191 1.08057 0.65088 L1.08057 1 L0.99023 1 L0.99023 0.65039 Q0.98975 0.59326 0.96411 0.56592 Q0.93848 0.53857 0.88428 0.53857 Q0.84033 0.53857 0.80713 0.56201 Q0.77393 0.58545 0.75537 0.62354 L0.75537 1 L0.66504 1 L0.66504 0.25 L0.75537 0.25 L0.75537 0.53564 Z',
  'M1.43506 1.00977 Q1.32764 1.00977 1.26025 0.93921 Q1.19287 0.86865 1.19287 0.75049 L1.19287 0.73389 Q1.19287 0.65527 1.2229 0.59351 Q1.25293 0.53174 1.30688 0.49683 Q1.36084 0.46191 1.42383 0.46191 Q1.52686 0.46191 1.58398 0.52979 Q1.64111 0.59766 1.64111 0.72412 L1.64111 0.76172 L1.2832 0.76172 Q1.28516 0.83984 1.32886 0.88794 Q1.37256 0.93604 1.43994 0.93604 Q1.48779 0.93604 1.521 0.9165 Q1.5542 0.89697 1.5791 0.86475 L1.63428 0.90771 Q1.56787 1.00977 1.43506 1.00977 Z M1.42383 0.53613 Q1.36914 0.53613 1.33203 0.57593 Q1.29492 0.61572 1.28613 0.6875 L1.55078 0.6875 L1.55078 0.68066 Q1.54688 0.61182 1.51367 0.57397 Q1.48047 0.53613 1.42383 0.53613 Z',
  'M1.97119 0.73145 Q1.97119 0.60693 2.02832 0.53442 Q2.08545 0.46191 2.18164 0.46191 Q2.27539 0.46191 2.32959 0.5249 L2.3335 0.47168 L2.4165 0.47168 L2.4165 1.20313 L2.32617 1.20313 L2.32617 0.95117 Q2.27148 1.00977 2.18066 1.00977 Q2.08496 1.00977 2.02808 0.9353 Q1.97119 0.86084 1.97119 0.73779 L1.97119 0.73145 Z M2.06152 0.7417 Q2.06152 0.83252 2.09985 0.88428 Q2.13818 0.93604 2.20313 0.93604 Q2.28369 0.93604 2.32617 0.86475 L2.32617 0.60596 Q2.2832 0.53613 2.2041 0.53613 Q2.13867 0.53613 2.1001 0.58813 Q2.06152 0.64014 2.06152 0.7417 Z',
  'M2.8877 0.94775 Q2.83496 1.00977 2.73291 1.00977 Q2.64844 1.00977 2.60425 0.96069 Q2.56006 0.91162 2.55957 0.81543 L2.55957 0.47168 L2.6499 0.47168 L2.6499 0.81299 Q2.6499 0.93311 2.74756 0.93311 Q2.85107 0.93311 2.88525 0.85596 L2.88525 0.47168 L2.97559 0.47168 L2.97559 1 L2.88965 1 L2.8877 0.94775 Z',
  'M3.21094 1 L3.12061 1 L3.12061 0.47168 L3.21094 0.47168 L3.21094 1 Z M3.11328 0.33154 Q3.11328 0.30957 3.12671 0.29443 Q3.14014 0.2793 3.1665 0.2793 Q3.19287 0.2793 3.20654 0.29443 Q3.22021 0.30957 3.22021 0.33154 Q3.22021 0.35352 3.20654 0.36816 Q3.19287 0.38281 3.1665 0.38281 Q3.14014 0.38281 3.12671 0.36816 Q3.11328 0.35352 3.11328 0.33154 Z',
];
const M = [1.03, 0, 0, 1.03, 0.12, 0.04];
const VB = '-0.15 0.1 3.6 1.3';
const MARKS = '<path d="M-0.15 0.1h0.02v0.02h-0.02Z"/><path d="M3.43 1.38h0.02v0.02h-0.02Z"/>';
const body = GLYPHS.map((d) => `<path d="${d}"/>`).join('');
const doc = (m) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VB}" fill="#111">${m ? `<g transform="matrix(${m.join(' ')})">${body}</g>` : body}${MARKS}</svg>`;
const A = doc(null),
  B = doc(M);
const TARGETS = { default: { route: 'auto', commit: false }, lb: { route: 'lb' } };

const HTML = `<!DOCTYPE html><html><body style="margin:0"><script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, createShapeMorph } from '/src/index.js';
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const W = ${W}, H = ${H};
async function side(opts, sel, a, b) {
  const c = document.createElement('canvas'); c.width = W; c.height = H; document.body.appendChild(c);
  const gl = c.getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
  const R = createRenderer(gl, shaders, opts);
  if (R.ready) await R.ready;
  R.setViewport(W, H);
  if (sel) R.setFillEngine(sel);
  const m = createShapeMorph(gl, createBundle(gl, await importSvg(a)), createBundle(gl, await importSvg(b)));
  return { c, gl, R, m };
}
function draw(S, t) {
  S.m.setT(t);
  const before = Object.assign({}, (S.R.debugStats.engines || {}).draws || {});
  S.R.beginFrame([1, 1, 1, 1]); S.R.drawBundle(S.m); S.R.endFrame();
  const after = (S.R.debugStats.engines || {}).draws || {}, drew = {};
  for (const k of Object.keys(after)) { const n = (after[k] | 0) - (before[k] | 0); if (n) drew[k] = n; }
  const px = new Uint8Array(W * H * 4);
  S.gl.readPixels(0, 0, W, H, S.gl.RGBA, S.gl.UNSIGNED_BYTE, px);
  return { px, drew };
}
// The same settling for both renderers: a draw, the analytic build awaited, the variant warmed, then the frame that counts.
async function settle(S, t) {
  draw(S, t);
  await S.R.awaitLbReady(S.m, 20000);
  S.R.prewarmBundle(S.m);
  if (S.R.precompileFills) S.R.precompileFills();
  draw(S, t);
  return draw(S, t);
}
function close(S) { try { S.R.dispose(); } catch {} S.gl.getExtension('WEBGL_lose_context')?.loseContext(); S.c.remove(); }
window.__run = async (a, b, target, lbReady, pinT, ts) => {
  const S = await side({ cpatchFill: true }, null, a, b);
  draw(S, pinT);
  const pinned = await S.R.awaitEngine(S.m, 'cpatch');
  if (lbReady) await S.R.awaitLbReady(S.m, 20000);
  const atPin = draw(S, pinT);
  S.R.setFillEngine(target);
  const out = [];
  for (const t of ts) {
    const got = await settle(S, t);
    const F = await side({}, target.route === 'auto' ? null : target, a, b);
    const want = await settle(F, t);
    close(F);
    out.push({ t, pinned, pinDrew: atPin.drew, drew: got.drew, refDrew: want.drew, got: Array.from(got.px), want: Array.from(want.px) });
  }
  close(S);
  return out;
};
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  try {
    const u = req.url.split('?')[0];
    if (u === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }
    const p = decodeURIComponent(u);
    res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => fail('page: ' + e.message));
try {
  await openReady(page, 'http://127.0.0.1:' + server.address().port + '/', {
    name: 'cpatchMorphSwitchBackRenderSmoke',
  });
  for (const [name, target] of Object.entries(TARGETS))
    for (const lbReady of [false, true]) {
      const res = await page.evaluate(
        (a, b, tg, lr, pt, ts) => window.__run(a, b, tg, lr, pt, ts),
        A,
        B,
        target,
        lbReady,
        PIN_T,
        TS,
      );
      for (const r of res) {
        let off = 0,
          inkA = 0,
          inkB = 0;
        for (let i = 0; i < r.got.length; i += 4) {
          let d = 0;
          for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(r.got[i + c] - r.want[i + c]));
          if (d > 32) off++;
          if (r.got[i] < 250) inkA++;
          if (r.want[i] < 250) inkB++;
        }
        const engines = (d) => Object.keys(d).sort().join('+');
        const tag = `pinned CPatch (${lbReady ? 'awaitLbReady' : 'no awaitLbReady'}), switched to ${name}, t=${r.t}: ${off} px differ by >32/255, ink ${inkA} vs ${inkB}, drew ${engines(r.drew)} vs fresh ${engines(r.refDrew)}`;
        if (!r.pinned || !r.pinDrew.cpatch)
          fail(
            tag + ` (the pinned renderer did not draw CPatch first: ${JSON.stringify(r.pinDrew)})`,
          );
        else if (r.drew.cpatch) fail(tag + ' (CPatch still draws after the switch)');
        else if (engines(r.drew) !== engines(r.refDrew))
          fail(tag + ' (not the engines a fresh renderer draws)');
        else if (name === 'lb' && !r.drew.lb) fail(tag + ' (route lb did not draw Loop-Blinn)');
        else if (off > BAR || Math.abs(inkA - inkB) > 0.01 * Math.max(inkA, inkB, 1))
          fail(tag + ' (not the fresh picture)');
        else ok(tag);
      }
    }
} finally {
  await browser.close();
  server.close();
}
if (failures) {
  console.error(failures + ' failure(s)');
  process.exit(1);
}
console.log('cpatchMorphSwitchBackRenderSmoke ok');
