// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// aacPointsColorMatrixGpuSmoke -- a draw's colorMatrix is painted by the point route, and an animated drawing's bucketed lists draw the
// same pixels. The same small draw goes through the point route and through the cover quads (aacPoints:false), under:
//   (a) a diagonal fog matrix + offset (a per-sprite fog), a general mat4 with a saturating channel, on fill-only, stroked and
//       TRANSLUCENT content: the engine ledger records @points, the image matches the cover quads within the route smoke's tolerance (24/255), and the
//       matrix is not vacuous (the image differs from the same draw with no matrix);
//   (b) palette / channelLerp / an alpha-making matrix keep the cover route;
//   (c) a sprite that GROWS over twelve frames through one renderer (the map changes every frame, so its lists are bucketed): every frame matches
//       its cover-quad twin, and the engine ledger counts points draws on every frame.
import http from 'http';
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const N = 128;

// A row of small glyph-like paths: a quad-bowled 'o' (with an even-odd counter), an 'l' bar of lines, a quad 'c', repeated
// with overlaps so neighbouring cover quads stack.
function glyphs(count) {
  let out = '';
  const colors = ['#000000', '#2b4c9a', '#b03030', '#207040'];
  for (let i = 0; i < count; i++) {
    const x = 2 + i * 3.1,
      y = 10,
      c = colors[i % colors.length];
    const k = i % 3;
    if (k === 0)
      out += `<path fill="${c}" fill-rule="evenodd" d="M${x} ${y} Q${x + 1.6} ${y - 2.2} ${x + 3.2} ${y} Q${x + 1.6} ${y + 2.2} ${x} ${y} Z M${x + 0.9} ${y} Q${x + 1.6} ${y - 1.1} ${x + 2.3} ${y} Q${x + 1.6} ${y + 1.1} ${x + 0.9} ${y} Z"/>`;
    else if (k === 1)
      out += `<path fill="${c}" d="M${x} ${y - 2.5} L${x + 0.9} ${y - 2.5} L${x + 0.9} ${y + 2.2} L${x} ${y + 2.2} Z"/>`;
    else
      out += `<path fill="${c}" d="M${x + 3} ${y - 1.4} Q${x + 1} ${y - 3} ${x} ${y} Q${x + 1} ${y + 3} ${x + 3} ${y + 1.4} L${x + 2.5} ${y + 0.9} Q${x + 1.2} ${y + 2} ${x + 0.8} ${y} Q${x + 1.2} ${y - 2} ${x + 2.5} ${y - 0.9} Z"/>`;
  }
  return out;
}
const SVG_FILL = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 20">${glyphs(20)}</svg>`;
const SVG_STROKE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 20">${glyphs(6)}<path fill="#999999" stroke="#000000" stroke-width="0.4" d="M40 6 L46 6 L46 12 L40 12 Z"/></svg>`;
const SVG_GSTROKE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 20"><defs><linearGradient id="g"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#f00"/></linearGradient></defs>${glyphs(6)}<path fill="#999999" stroke="url(#g)" stroke-width="0.4" d="M40 6 L46 6 L46 12 L40 12 Z"/></svg>`;

const TRANS = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 20">${glyphs(14)}<path fill="#2b4c9a" fill-opacity="0.5" stroke="#a02020" stroke-opacity="0.6" stroke-width="0.5" d="M30 4 L50 4 L50 16 L30 16 Z"/></svg>`;
// ELEMENT OPACITY (the `opacity` attribute, as a scene's shrubs stack 0.25 / 0.5 / 0.6 paths over each other): a stack of overlapping translucent paths with a fog matrix
const OPAQ = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 20">${glyphs(10)}<g>
  <path opacity="0.6" fill="#1f6f2a" d="M10 4 Q22 -2 34 6 L30 16 Q18 20 8 14 Z"/><path opacity="0.25" fill="#0d3d14" d="M16 6 Q28 0 42 8 L38 18 Q24 20 14 15 Z"/>
  <path opacity="0.5" fill="#3a9a40" d="M24 3 Q40 0 52 9 L46 17 Q34 19 22 12 Z"/><path opacity="0.078" fill="#000" d="M6 2 L58 2 L58 18 L6 18 Z"/></g></svg>`;
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const secs = { fill: await importSvg(${JSON.stringify(SVG_FILL)}, { preserveViewport: true }), stroke: await importSvg(${JSON.stringify(SVG_STROKE)}, { preserveViewport: true }), trans: await importSvg(${JSON.stringify(TRANS)}, { preserveViewport: true }), opaq: await importSvg(${JSON.stringify(OPAQ)}, { preserveViewport: true }) };
const readPx = () => { const px = new Uint8Array(${N} * ${N} * 4); gl.readPixels(0, 0, ${N}, ${N}, gl.RGBA, gl.UNSIGNED_BYTE, px); return Array.from(px); };
const inkOf = (px) => { let ink = 0; for (let i = 3; i < px.length; i += 4) if (px[i] > 8) ink++; return ink; };
const viaOf = (r) => { const v = (r.debugStats && r.debugStats.engines && r.debugStats.engines.viaRoute) || {}, o = {}; for (const k of Object.keys(v)) { const n = v[k] - ((r.__via0 || {})[k] || 0); if (n) o[k] = n; } return o; };   // draws since the loading call's own warm draws
window.__draw = (which, opts, scale, extra) => {
  const r = createRenderer(gl, shaders, opts);
  r.setLoopBlinnFill('off'); r.setViewport(${N}, ${N}); gl.viewport(0, 0, ${N}, ${N});
  const b = createBundle(gl, secs[which]); r.prewarmBundle(b); r.precompileFills(); r.__via0 = { ...((r.debugStats.engines || {}).viaRoute || {}) };   // the loading call: the point program is finished before the first draw
  r.beginFrame([0, 0, 0, 0]); r.drawBundle(b, { worldMatrix: [scale, 0, 0, 0, scale, 0, 0, 0, 1], ...extra }); r.endFrame();
  const px = readPx(); const via = viaOf(r);
  b.dispose && b.dispose(); r.dispose && r.dispose();
  return { px, via, ink: inkOf(px) };
};
// a growing sprite through ONE renderer and bundle, frame by frame
window.__grow = (which, opts, scales, extra) => {
  const r = createRenderer(gl, shaders, opts);
  r.setLoopBlinnFill('off'); r.setViewport(${N}, ${N}); gl.viewport(0, 0, ${N}, ${N});
  const b = createBundle(gl, secs[which]); r.prewarmBundle(b); r.precompileFills(); r.__via0 = { ...((r.debugStats.engines || {}).viaRoute || {}) }; const frames = [];
  for (const sc of scales) {
    const before = JSON.stringify(viaOf(r));
    r.beginFrame([0, 0, 0, 0]); r.drawBundle(b, { worldMatrix: [sc, 0, 0, 0, sc, 0, 0, 0, 1], ...extra }); r.endFrame();
    const px = readPx(); const v = viaOf(r), v0 = JSON.parse(before);
    let pts = 0; for (const k of Object.keys(v)) if (k.endsWith('@points')) pts += (v[k] | 0) - (v0[k] | 0);
    frames.push({ px, pts, ink: inkOf(px) });
  }
  b.dispose && b.dispose(); r.dispose && r.dispose();
  return frames;
};
window.__ready = true;
</script></body></html>`;
const server = http.createServer((req, res) => {
  try {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }
    const p = decodeURIComponent(req.url.split('?')[0]);
    res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

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
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') console.error('  [console]', m.text());
});
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 15000 });
  await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
} catch (e) {
  fail('setup: ' + e.message);
  await browser.close();
  server.close();
  process.exit(1);
}

const draw = (which, opts, scale, extra) =>
  page.evaluate((w, o, s, e) => window.__draw(w, o, s, e), which, opts, scale, extra || {});
const points = (v) =>
  Object.entries(v).reduce((n, [k, c]) => n + (k.endsWith('@points') ? c | 0 : 0), 0);
const cover = (v) =>
  Object.entries(v).reduce((n, [k, c]) => n + (k.endsWith('@cover') ? c | 0 : 0), 0);

const FOG = Array.from({ length: 16 }, (_, i) => (i % 5 === 0 ? 0.4 : 0));
FOG[15] = 1;
const FOGO = [0.875 * 0.6, 0.737 * 0.6, 0.314 * 0.6, 0];
const GEN = [0.9, 0.2, 0.05, 0, 0.1, 0.7, 0.3, 0, 0.3, 0.25, 1.4, 0, 0.2, 0.1, 0, 0.8],
  GENO = [0.05, -0.1, 0, 0];
const maxDiff = (a, b) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};
const ptsDraw = (which, extra, scale = 0.5) => draw(which, { aacFill: true }, scale, extra);
const covDraw = (which, extra, scale = 0.5) =>
  draw(which, { aacFill: true, aacPoints: false }, scale, extra);
for (const which of ['fill', 'stroke', 'trans', 'opaq']) {
  for (const [nm, cm, co] of [
    ['diagonal fog + offset', FOG, FOGO],
    ['general mat4', GEN, GENO],
  ]) {
    const extra = { colorMatrix: cm, colorMatrixOffset: co };
    const P = await ptsDraw(which, extra),
      C = await covDraw(which, extra),
      N0 = await ptsDraw(which, {});
    const mx = maxDiff(P.px, C.px),
      vac = maxDiff(P.px, N0.px);
    if (points(P.via) > 0) ok(`${which} + ${nm}: took the point route (${JSON.stringify(P.via)})`);
    else fail(`${which} + ${nm}: did not take the point route: ${JSON.stringify(P.via)}`);
    if (points(C.via) === 0 && mx <= 24 && Math.abs(P.ink - C.ink) <= 4)
      ok(`${which} + ${nm}: matches the cover quads (max ${mx}, ink ${P.ink} vs ${C.ink})`);
    else
      fail(
        `${which} + ${nm}: points differ from cover: max ${mx}, ink ${P.ink} vs ${C.ink}, cover via ${JSON.stringify(C.via)}`,
      );
    if (vac > 40)
      ok(`${which} + ${nm}: the matrix changes the image (max ${vac} against no matrix)`);
    else fail(`${which} + ${nm}: vacuous, the matrix moved the image by ${vac}`);
  }
}
// (b) the rest of the recolor family keeps the cover route
{
  const A = await ptsDraw('fill', {
    colorMatrix: [1, 0, 0, 0.3, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    colorMatrixOffset: [0, 0, 0, 0],
  });
  if (points(A.via) === 0 && cover(A.via) > 0)
    ok('a matrix that makes alpha from color keeps the cover route');
  else fail(`an alpha-making matrix took points: ${JSON.stringify(A.via)}`);
  const B = await ptsDraw('fill', {
    channelLerp: { primary: [1, 0, 0, 1], contrast: [0, 0, 1, 1], highlight: [1, 1, 1, 1] },
  });
  if (points(B.via) === 0) ok('channelLerp keeps the cover route');
  else fail(`channelLerp took points: ${JSON.stringify(B.via)}`);
  const I = await ptsDraw('fill', {
    colorMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    colorMatrixOffset: [0, 0, 0, 0],
  });
  const I0 = await ptsDraw('fill', {});
  if (points(I.via) > 0 && maxDiff(I.px, I0.px) === 0)
    ok('an identity matrix with a zero offset is the draw with none, pixel for pixel');
  else fail(`identity matrix: via ${JSON.stringify(I.via)}, diff ${maxDiff(I.px, I0.px)}`);
}
// (c) a growing sprite: bucketed lists, every frame equal to its cover twin
for (const [which, extra] of [
  ['fill', { colorMatrix: FOG, colorMatrixOffset: FOGO }],
  ['stroke', { colorMatrix: FOG, colorMatrixOffset: FOGO }],
  ['fill', {}],
]) {
  const scales = Array.from({ length: 12 }, (_, i) => 0.3 * Math.pow(1.045, i * 2));
  const P = await page.evaluate(
    (w, o, s, e) => window.__grow(w, o, s, e),
    which,
    { aacFill: true },
    scales,
    extra,
  );
  const C = await page.evaluate(
    (w, o, s, e) => window.__grow(w, o, s, e),
    which,
    { aacFill: true, aacPoints: false },
    scales,
    extra,
  );
  let worst = 0,
    inkd = 0,
    allPts = true;
  for (let i = 0; i < scales.length; i++) {
    worst = Math.max(worst, maxDiff(P[i].px, C[i].px));
    inkd = Math.max(inkd, Math.abs(P[i].ink - C[i].ink));
    if (P[i].pts === 0) allPts = false;
  }
  if (allPts && worst <= 24 && inkd <= 6)
    ok(
      `a growing ${which} sprite${extra.colorMatrix ? ' with fog' : ''}: all ${scales.length} frames on points and within rounding of cover (max ${worst}, ink diff ${inkd})`,
    );
  else
    fail(
      `a growing ${which} sprite${extra.colorMatrix ? ' with fog' : ''}: points on every frame ${allPts}, max ${worst}, ink diff ${inkd}`,
    );
}

await browser.close();
server.close();
if (failures) {
  console.error(`aacPointsColorMatrixGpuSmoke: ${failures} failure(s)`);
  process.exit(1);
}
console.log(
  'aacPointsColorMatrixGpuSmoke: a draw colorMatrix is painted by the point route; a growing sprite draws the same pixels as its cover twin',
);
