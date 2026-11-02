// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// dashStrokeParitySmoke.mjs — DASHED strokes must match Slug on the analytic route.
//
// Every dashed stroke draws through the ubershader's in-shader band walk. Three dash
// faults this guards:
//
//   1. bisector ownership x dash — a dashed segment that cedes the wedge past its
//      bisector to a neighbor that then dashes it AWAY leaves the gap painted by
//      nobody: 653 structural px on an open two-segment path.
//   2. closed contours through the stroke-SEGMENT route — the pattern phase must be
//      continuous across the closing joint (last segment's start distance is the
//      contour length, the first's is 0), or 185 structural px go wrong.
//   3. a ONE-pixel flip at a hard dash boundary, phase- and resolution-dependent.
//
// (3) is why the tolerance below is not zero. Dash coverage is an in/out test, so a
// sub-LSB difference in path distance at a boundary flips a pixel FULLY rather than
// by one LSB — it reads as w192 while being one pixel. It appears on exactly one of
// four phase variants and vanishes on a 161px grid. A path that quantized coverage
// to 8 bits through a render target would score zero here only because the
// quantization smooths the boundary away.
//
// So: structural disagreement (>24/255) is budgeted at a couple of boundary pixels,
// NOT at zero, and the assertions that carry the weight are that budget plus
// non-vacuity — a dash must actually cut gaps. Without the gap check a blank render
// would pass every parity assertion trivially.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { pageTimeoutFor } from './_laneBudget.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const S = 160;
// Curved on purpose: a straight-line bundle builds no analytic mesh and so never
// reaches the route under test at all (it silently falls back), so a straight-line
// case would measure nothing.
// route: does this case reach the analytic route, or legitimately decline to Slug?
// Asserted per case rather than "most of them", so that a change which quietly sent
// everything down the fallback still fails instead of passing on parity alone.
const PATHS = {
  openQuad: { d: 'M6 30 Q20 2 34 30', route: true },
  openTwoQuad: { d: 'M6 30 Q13 6 20 20 Q27 34 34 10', route: true },
  // Declines with gate 'no-meshes', and that is correct: stroke-only (fill="none")
  // and self-crossing, so its implicit closure is degenerate and the mesh builder
  // produces nothing to fill. The stroke still needs no fill mesh, so the bundle
  // renders through Slug in the same one draw -- no pixels and no draws are lost.
  // If this ever starts routing that is an improvement; the note below says so
  // rather than failing.
  openCubic: { d: 'M6 28 C12 6 20 6 20 20 C20 34 28 34 34 12', route: false, gate: 'no-meshes' },
  closedQuad: { d: 'M8 20 Q20 4 32 20 Q20 36 8 20 Z', route: true },
  closedCubic: {
    d: 'M20 4 C31 4 36 9 36 20 C36 31 31 36 20 36 C9 36 4 31 4 20 C4 9 9 4 20 4 Z',
    route: true,
  },
};

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="${S}" height="${S}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const S = ${S}, PATHS = ${JSON.stringify(PATHS)};
const gl = document.getElementById('c').getContext('webgl2',
  { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);

const svg = (d, dash) => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">'
  + '<path fill="none" stroke="#3060c0" stroke-width="3"'
  + (dash ? ' stroke-dasharray="4 2"' : '') + ' d="' + d + '"/></svg>';

async function shoot(src, lbOn) {
  const r = createRenderer(gl, shaders, { aacFill: false });
  const b = createBundle(gl, await importSvg(src));
  r.setLoopBlinnFill(lbOn ? 'on' : 'off');
  try { r.prepareBundle(b); } catch (e) {}
  if (lbOn && r.awaitLbReady) { try { await r.awaitLbReady(b, 20000); } catch (e) {} }
  if (r.precompileFills) { try { r.precompileFills(); } catch (e) {} }
  const frame = () => { r.setViewport(S, S); r.beginFrame([0,0,0,1]); r.drawBundle(b, {}); r.endFrame(); };
  // The route links its variant and PSO-warms off the critical path, so spin real
  // frames until it settles instead of trusting frame 2.
  for (let i = 0; i < 60; i++) {
    frame();
    if (!lbOn || (r.debugStats.unifiedFillDraws | 0) > 0) break;
    // rAF ALONE NEVER SETTLES in a headless page with no visible work. Timeout wins if rAF stalls.
      await new Promise((res) => { const _t = setTimeout(res, 100); requestAnimationFrame(() => { clearTimeout(_t); res(); }); });
  }
  frame();
  const px = new Uint8Array(S * S * 4);
  gl.readPixels(0, 0, S, S, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const routed = (r.debugStats.loopBlinnRouteCount | 0) > 0;
  const uni = r.debugStats.unifiedFillDraws | 0;
  const gate = r.debugStats.unifiedFillGate || '?';
  try { b.dispose(); } catch (e) {}
  return { px, routed, uni, gate };
}
const inkOf = (px) => { let n = 0;
  for (let i = 0; i < S * S; i++) { const o = i * 4;
    if (px[o] > 8 || px[o+1] > 8 || px[o+2] > 8) n++; } return n; };

const out = {};
for (const [name, spec] of Object.entries(PATHS)) {
  const d = spec.d;
  const slug = await shoot(svg(d, true), false);
  const lb = await shoot(svg(d, true), true);
  const solid = await shoot(svg(d, false), false);
  let struct = 0, any = 0, worst = 0; const at = [];
  for (let i = 0; i < S * S; i++) {
    const o = i * 4;
    let dd = 0;
    for (let k = 0; k < 3; k++) dd = Math.max(dd, Math.abs(slug.px[o+k] - lb.px[o+k]));
    if (dd) any++;
    if (dd > worst) worst = dd;
    if (dd > 24) { struct++; if (at.length < 6) at.push((i % S) + ',' + (S - 1 - ((i / S) | 0))); }
  }
  out[name] = { struct, any, worst, at, routed: lb.routed, uni: lb.uni, gate: lb.gate,
                wantRoute: !!spec.route, wantGate: spec.gate || null,
                dashInk: inkOf(lb.px), slugDashInk: inkOf(slug.px), solidInk: inkOf(solid.px) };
}
window.__out = out;
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
const ok = (m) => console.log('  ok ' + m);
const fail = (m) => {
  failures++;
  console.error('  FAIL: ' + m);
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
  if (m.type() === 'error') console.error('  [console]', m.text());
});
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => window.__ready === true, {
    timeout: pageTimeoutFor(240000),
    polling: 100,
  });
} catch (e) {
  fail('setup: ' + e.message);
  await browser.close();
  server.close();
  process.exit(1);
}

const o = await page.evaluate(() => window.__out);
await browser.close();
server.close();

// A couple of boundary pixels, not zero -- see the header. The faults this guards
// against are 653 and 185 px, three orders of magnitude clear of this budget.
const STRUCT_BUDGET = 3;
for (const [name, v] of Object.entries(o)) {
  console.log(
    `   ${name.padEnd(12)} struct=${String(v.struct).padStart(4)} worst=${String(v.worst).padStart(3)}` +
      ` any=${String(v.any).padStart(5)} dashInk=${String(v.dashInk).padStart(5)}` +
      ` solidInk=${String(v.solidInk).padStart(5)} uniDraws=${v.uni} gate=${v.gate}` +
      (v.at.length ? '  at ' + v.at.join(' ') : ''),
  );
}
for (const [name, v] of Object.entries(o)) {
  if (v.wantRoute && v.routed) ok(`${name}: routes through the analytic fill`);
  else if (v.wantRoute)
    fail(
      `${name}: expected the analytic route, fell back (gate '${v.gate}') — parity below proves nothing about that route`,
    );
  else if (!v.routed && v.gate === v.wantGate)
    ok(`${name}: declines to Slug as expected (gate '${v.gate}')`);
  else if (!v.routed)
    fail(`${name}: declined for an UNEXPECTED reason — gate '${v.gate}', expected '${v.wantGate}'`);
  else
    ok(
      `${name}: routes analytically (expected to decline via '${v.wantGate}') — an improvement, retighten this case`,
    );
  // Non-vacuity, both halves: the dash must PAINT (not blank) and must CUT (not
  // solid). Parity alone would pass on two blank renders.
  if (v.dashInk > 300) ok(`${name}: dashed stroke paints (${v.dashInk} ink px)`);
  else fail(`${name}: dashed stroke barely painted (${v.dashInk} ink px)`);
  if (v.dashInk < v.solidInk * 0.9)
    ok(`${name}: dashes cut real gaps (${v.dashInk} vs solid ${v.solidInk})`);
  else fail(`${name}: dash pattern had no effect (${v.dashInk} vs solid ${v.solidInk})`);
  if (v.struct <= STRUCT_BUDGET)
    ok(`${name}: matches Slug (${v.struct} structural px, worst ${v.worst})`);
  else
    fail(
      `${name}: differs from Slug structurally — ${v.struct} px over 24/255, worst ${v.worst}, at ${v.at.join(' ')}`,
    );
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nDASH-STROKE-PARITY PASS');
