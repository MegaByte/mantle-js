// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// aacPointsRouteSmoke — AAC's small-shape POINT route (renderer/aacPointsDraw.js) draws what the cover-quad route draws, and
// takes exactly the draws it should.
//
// The route exists because AAC's per-segment kernel serializes when hundreds of tiny glyph quads overlap in a few tiles
// (roboto text 64 px wide ~9 ms per draw); the same kernel in the vertex stage runs in ~0.9 ms. It must be a pure route
// choice: same kernel, same inputs, so the image may differ only by rounding.
//
// Asserts, on a line of tiny glyph-like shapes (quads and lines, nonzero and even-odd, several colors, overlapping):
//   (a) small draw: the engine ledger records aac@points, and the image matches aacPoints:false (aac@cover) within AA rounding --
//       no pixel off by more than 24/255 and ink equal to within a few pixels;
//   (b) the same content drawn LARGE stays on the cover quads (the size gate);
//   (c) a STROKED shape takes the point route too (the point shader runs the fill shader's stroke pass) and
//       matches its own cover quads within the same rounding; a GRADIENT stroke keeps render() (points paint flat color);
//   (d) the default draw (Slug's engine, which is the exact walk -- the kernel the point route runs) takes the
//       point route too, recorded as slug@points, and matches its own cover quads within the same rounding;
//   (e) aacFill:'auto' takes points for the small draw (points beat Slug on time AND accuracy there) and not for the large one.
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

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const fillSec = await importSvg(${JSON.stringify(SVG_FILL)}, { preserveViewport: true });
const strokeSec = await importSvg(${JSON.stringify(SVG_STROKE)}, { preserveViewport: true });
const gstrokeSec = await importSvg(${JSON.stringify(SVG_GSTROKE)}, { preserveViewport: true });
window.__draw = (which, opts, scale) => {
  const r = createRenderer(gl, shaders, opts);
  r.setLoopBlinnFill('off');
  r.setViewport(${N}, ${N}); gl.viewport(0, 0, ${N}, ${N});
  const b = createBundle(gl, which === 'stroke' ? strokeSec : which === 'gstroke' ? gstrokeSec : fillSec); r.prewarmBundle(b); r.precompileFills();   // the loading call: the point program is finished there, not at the first draw
  const via0 = { ...((r.debugStats && r.debugStats.engines && r.debugStats.engines.viaRoute) || {}) };   // (the loading call's warm draws are counted too)
  const before = JSON.stringify((r.debugStats && r.debugStats.engines && r.debugStats.engines.viaRoute) || {});
  const wm = [scale, 0, 0, 0, scale, 0, 0, 0, 1];
  r.beginFrame([0, 0, 0, 0]); r.drawBundle(b, { worldMatrix: wm }); r.endFrame();
  const px = new Uint8Array(${N} * ${N} * 4); gl.readPixels(0, 0, ${N}, ${N}, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const via = {}; { const v1 = (r.debugStats && r.debugStats.engines && r.debugStats.engines.viaRoute) || {}; for (const k of Object.keys(v1)) { const d = v1[k] - (via0[k] || 0); if (d) via[k] = d; } }
  let ink = 0; for (let i = 3; i < px.length; i += 4) if (px[i] > 8) ink++;
  b.dispose && b.dispose(); r.dispose && r.dispose();
  return { px: Array.from(px), via, ink, before };
};
window.__gates = async () => {
  const sec = await importSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 40"><path d="M3 32 L12 4 L20 32 L28 4" fill="none" stroke="#205080" stroke-opacity=".6" stroke-width="2" stroke-linejoin="miter"/><path d="M30 6 Q48 36 60 8" fill="none" stroke="#a02020" stroke-opacity=".5" stroke-width="1.3" stroke-linecap="square"/><path d="M4 34 C12 12 22 50 28 25" fill="none" stroke="#20a050" stroke-width="1.1" stroke-dasharray="3 2" stroke-linecap="round"/><path d="M32 26 A9 6 20 0 1 56 32" fill="none" stroke="#703090" stroke-opacity=".7" stroke-width="1.6" stroke-linecap="round"/></svg>', { preserveViewport: true });
  const r = createRenderer(gl, shaders, { aacFill: true }); if (r.ready) await r.ready;
  r.setLoopBlinnFill('off'); r.setViewport(128, 128);
  const b = createBundle(gl, sec), values = [], rows = []; r.prewarmBundle(b); r.precompileFills({ futureStates: true });   // (rotated and skewed maps are among the states drawn below)   // the loading call: the point program is finished there, not at the first draw
  const original = gl.drawArraysInstanced;
  gl.drawArraysInstanced = function(mode, ...args) {
    if (mode === gl.POINTS) { const pr = gl.getParameter(gl.CURRENT_PROGRAM), u = gl.getUniformLocation(pr, 'uStrokeGates'); values.push(u ? gl.getUniform(pr, u) : null); }
    return original.call(this, mode, ...args);
  };
  try {
    for (const wm of [[.5,0,0,0,.5,0,0,0,1],[.6,0,0,0,.2,0,.07,-.09,1],[.4,.2,0,-.1,.5,0,0,0,1]]) {
      const shots=[];
      for (const on of [true,false,true]) {
        r.setStrokeGates(on); const before=values.length;
        r.beginFrame([.2,.3,.4,1]); r.drawBundle(b,{worldMatrix:wm}); r.endFrame();
        const px=new Uint8Array(128*128*4); gl.readPixels(0,0,128,128,gl.RGBA,gl.UNSIGNED_BYTE,px);
        if(values.length===before)throw Error('Stroke gate fixture missed point route');
        if(values.slice(before).some(v=>v!==(on?1:0)))throw Error('Point program did not bind stroke gates '+on);
        shots.push(px);
      }
      let diff=0,repeat=0;for(let i=0;i<shots[0].length;i++){if(shots[0][i]!==shots[1][i])diff++;if(shots[0][i]!==shots[2][i])repeat++;}
      rows.push({diff,repeat});
    }
    return rows;
  } finally { gl.drawArraysInstanced=original;b.dispose();r.dispose(); }
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

const draw = (which, opts, scale) =>
  page.evaluate((w, o, s) => window.__draw(w, o, s), which, opts, scale);
const points = (v) =>
  Object.entries(v).reduce((n, [k, c]) => n + (k.endsWith('@points') ? c | 0 : 0), 0);
const cover = (v) =>
  Object.entries(v).reduce((n, [k, c]) => n + (k.endsWith('@cover') ? c | 0 : 0), 0);

// (a) small: points vs cover, same image within rounding. Fitted to the canvas the glyphs are ~6-9 px, over the route's 8 px
// gate, so draw them at half scale (~3-5 px).
{
  const P = await draw('fill', { aacFill: true }, 0.5);
  const C = await draw('fill', { aacFill: true, aacPoints: false }, 0.5);
  if (points(P.via) > 0) ok(`small AAC draw took the point route (${JSON.stringify(P.via)})`);
  else fail(`small AAC draw did not take the point route: ${JSON.stringify(P.via)}`);
  if (points(C.via) === 0 && cover(C.via) > 0) ok('aacPoints:false keeps the cover quads');
  else fail(`aacPoints:false did not draw with cover quads: ${JSON.stringify(C.via)}`);
  let mx = 0,
    n1 = 0;
  for (let i = 0; i < P.px.length; i++) {
    const d = Math.abs(P.px[i] - C.px[i]);
    if (d > mx) mx = d;
    if (d > 1) n1++;
  }
  if (P.ink > 30) ok(`small draw has ink (${P.ink} px)`);
  else fail(`small draw is nearly blank (${P.ink} px)`);
  if (mx <= 24 && Math.abs(P.ink - C.ink) <= 4)
    ok(
      `points match cover within rounding (max ${mx}, ${n1} channels >1, ink ${P.ink} vs ${C.ink})`,
    );
  else fail(`points differ from cover: max ${mx}, ${n1} channels >1, ink ${P.ink} vs ${C.ink}`);
}
// (b) large: stays on cover quads
{
  const L = await draw('fill', { aacFill: true }, 24);
  if (points(L.via) === 0) ok('a large draw stays on the cover quads');
  else fail(`a large draw took the point route: ${JSON.stringify(L.via)}`);
}
// (c) stroked content: the point route, matching its own cover quads; a gradient stroke is sampled in the point program (aacPointsPipeParitySmoke proves the colors)
{
  const S = await draw('stroke', { aacFill: true }, 0.5),
    SC = await draw('stroke', { aacFill: true, aacPoints: false }, 0.5);
  if (points(S.via) > 0)
    ok(`a bundle with a stroke takes the point route (${JSON.stringify(S.via)})`);
  else fail(`a stroked bundle did not take the point route: ${JSON.stringify(S.via)}`);
  let mx = 0;
  for (let i = 0; i < S.px.length; i++) mx = Math.max(mx, Math.abs(S.px[i] - SC.px[i]));
  if (points(SC.via) === 0 && mx <= 24 && Math.abs(S.ink - SC.ink) <= 4)
    ok(`...and matches its cover quads within rounding (max ${mx}, ink ${S.ink} vs ${SC.ink})`);
  else
    fail(
      `the stroked draw's points differ from its cover quads: max ${mx}, ink ${S.ink} vs ${SC.ink}, cover via ${JSON.stringify(SC.via)}`,
    );
  const GS = await draw('gstroke', { aacFill: true }, 0.5),
    GC = await draw('gstroke', { aacFill: true, aacPoints: false }, 0.5);
  if (points(GS.via) > 0 && points(GC.via) === 0)
    ok(`a bundle with a gradient stroke takes the point route (${JSON.stringify(GS.via)})`);
  else
    fail(
      `a gradient-stroked bundle: points ${JSON.stringify(GS.via)}, cover ${JSON.stringify(GC.via)}`,
    );
  let gm = 0;
  for (let i = 0; i < GS.px.length; i++) gm = Math.max(gm, Math.abs(GS.px[i] - GC.px[i]));
  if (gm <= 24 && Math.abs(GS.ink - GC.ink) <= 4)
    ok(`...and matches its cover quads within rounding (max ${gm})`);
  else
    fail(
      `the gradient stroke's points differ from its cover quads: max ${gm}, ink ${GS.ink} vs ${GC.ink}`,
    );
}
// (d) the default draw takes points too: its kernel is the exact walk the point route runs
{
  const G = await draw('fill', {}, 0.5),
    GC = await draw('fill', { aacPoints: false }, 0.5);
  if ((G.via['slug@points'] | 0) > 0)
    ok(`the default draw took the point route (${JSON.stringify(G.via)})`);
  else fail(`the default draw did not take the point route: ${JSON.stringify(G.via)}`);
  let mx = 0;
  for (let i = 0; i < G.px.length; i++) mx = Math.max(mx, Math.abs(G.px[i] - GC.px[i]));
  if (points(GC.via) === 0 && mx <= 24 && Math.abs(G.ink - GC.ink) <= 4)
    ok(`...and matches its own cover quads within rounding (max ${mx}, ink ${G.ink} vs ${GC.ink})`);
  else
    fail(
      `the default draw's points differ from its cover quads: max ${mx}, ink ${G.ink} vs ${GC.ink}, cover via ${JSON.stringify(GC.via)}`,
    );
}
// (e) 'auto': small draws take points, large ones follow the size thresholds
{
  const A = await draw('fill', { aacFill: 'auto' }, 0.5);
  if (points(A.via) > 0)
    ok(`aacFill:'auto' takes points for a small draw (${JSON.stringify(A.via)})`);
  else fail(`aacFill:'auto' did not take points for a small draw: ${JSON.stringify(A.via)}`);
  const AL = await draw('fill', { aacFill: 'auto' }, 24);
  if (points(AL.via) === 0)
    ok(`aacFill:'auto' keeps a large draw off the point route (${JSON.stringify(AL.via)})`);
  else fail(`aacFill:'auto' took points for a large draw: ${JSON.stringify(AL.via)}`);
}

try {
  const rows = await page.evaluate(() => window.__gates());
  if (rows.some((r) => r.diff || r.repeat))
    fail('Point stroke gates changed pixels: ' + JSON.stringify(rows));
  else
    ok(
      'Point stroke gates bind on/off and preserve translucent line/quad/cubic/arc pixels across three affine maps',
    );
} catch (e) {
  fail('Point stroke gates: ' + e.message);
}

await browser.close();
server.close();
if (failures) {
  console.error(`aacPointsRouteSmoke: ${failures} failure(s)`);
  process.exit(1);
}
console.log(
  'aacPointsRouteSmoke: small antialiased draws, strokes included, take the vertex-stage point route and match the cover quads',
);
