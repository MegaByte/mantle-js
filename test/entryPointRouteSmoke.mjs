// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// entryPointRouteSmoke — a bundle draws through the same engine whichever entry point draws it.
//
// drawBundle, handle.draw and drawBundleInstanced each reach a routing decision, and each must agree with the route it
// fronts:
//   - handle.draw must not fall straight to render() when the analytic route declines, or it never reaches AAC's
//     small-shape point route that a bare drawBundle takes (an app that draws everything through handles would never run it).
//   - drawBundleInstanced asks _lbWouldServe whether to leave its fast path; restating the route's static branch there
//     drifts from it (the CPatch and forced-unified bypasses, the no-AA veto's primitive exemption), so it asks the
//     route's own gate, with one deliberate difference: with the route off, primitives alone do not pull N instances
//     off the one-draw fast path.
//
// Asserts, per case, the engine@route the engine ledger records for one frame from each entry point:
//   (a) a recognized circle with the analytic route off: sdf from drawBundle and handle.draw, while drawBundleInstanced
//       keeps its instanced fast path;
//   (b) a row of tiny AAC glyphs: aac@points from drawBundle AND handle.draw.
import http from 'http';
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const N = 128;

const CIRCLE =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="24" fill="#000000"/></svg>';
// The glyph row from aacPointsRouteSmoke: quads and lines, nonzero and even-odd, small enough at half scale for the point route.
function glyphs(count) {
  let out = '';
  for (let i = 0; i < count; i++) {
    const x = 2 + i * 3.1,
      y = 10,
      k = i % 3;
    if (k === 0)
      out += `<path fill="#000000" fill-rule="evenodd" d="M${x} ${y} Q${x + 1.6} ${y - 2.2} ${x + 3.2} ${y} Q${x + 1.6} ${y + 2.2} ${x} ${y} Z M${x + 0.9} ${y} Q${x + 1.6} ${y - 1.1} ${x + 2.3} ${y} Q${x + 1.6} ${y + 1.1} ${x + 0.9} ${y} Z"/>`;
    else if (k === 1)
      out += `<path fill="#2b4c9a" d="M${x} ${y - 2.5} L${x + 0.9} ${y - 2.5} L${x + 0.9} ${y + 2.2} L${x} ${y + 2.2} Z"/>`;
    else
      out += `<path fill="#b03030" d="M${x + 3} ${y - 1.4} Q${x + 1} ${y - 3} ${x} ${y} Q${x + 1} ${y + 3} ${x + 3} ${y + 1.4} L${x + 2.5} ${y + 0.9} Q${x + 1.2} ${y + 2} ${x + 0.8} ${y} Q${x + 1.2} ${y - 2} ${x + 2.5} ${y - 0.9} Z"/>`;
  }
  return out;
}
// A few circles among many other rows (pattern_burned: 24 circles in 228 rows): with the analytic route off the whole bundle would take the
// unified draw and walk every row on cover quads; the points answer it. A lone circle (above) keeps its SDF record.
const MIXED = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 20"><circle cx="8" cy="10" r="4" fill="#000"/><circle cx="20" cy="10" r="4" fill="#900"/>${glyphs(20)}</svg>`;
const GLYPHS = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 20">${glyphs(20)}</svg>`;

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, depth: true, stencil: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const via = (r) => Object.assign({}, (r.debugStats.engines && r.debugStats.engines.viaRoute) || {});
// What ONE frame of this entry point recorded: the engine ledger is cumulative, so take the difference.
const frame = (r, drawIt) => {
  const a = via(r);
  r.beginFrame([1, 1, 1, 1]); drawIt(); r.endFrame();
  const b = via(r), d = {};
  for (const k of Object.keys(b)) { const n = (b[k] | 0) - (a[k] | 0); if (n > 0) d[k] = n; }
  return d;
};
const out = {};
try {
  // (a) recognized primitive, analytic route off
  {
    const r = createRenderer(gl, shaders, { staticUnified: true, psoWarmIdle: () => true });
    r.setViewport(${N}, ${N}); gl.viewport(0, 0, ${N}, ${N});
    // route 'none' is forced plain cover; primitives:'on' keeps the SDF primitive this case asserts.
    r.setFillEngine({ route: 'none', primitives: 'on' });
    const b = createBundle(gl, await importSvg(${JSON.stringify(CIRCLE)}));
    r.prepareBundle(b); r.prewarmBundle(b); r.precompileFills();
    if (r.awaitEngine) { try { await r.awaitEngine(b, 'none', 30000); } catch {} }
    const bare = () => r.drawBundle(b, {});
    // Wait for the primitive to be recognized and its variant warm, not for a frame count (see enginePeerSmoke).
    for (let w = 0; w < 400 && !(frame(r, bare)['sdf@unified'] > 0); w++) await new Promise((res) => setTimeout(res, 5));
    const h = r.createBundleHandle(b);
    const s = [0.4, 0, 0, 0, 0.4, 0, 0, 0, 1];
    const inst = [{ worldMatrix: s }, { worldMatrix: [0.4, 0, 0, 0, 0.4, 0, 0.5, 0.5, 1] }, { worldMatrix: [0.4, 0, 0, 0, 0.4, 0, -0.5, -0.5, 1] }];
    out.prim = {
      bare: frame(r, bare),
      handle: frame(r, () => h.draw({})),
      instanced: frame(r, () => r.drawBundleInstanced(b, inst)),
      prims: (b._lbMeshes || []).filter((m) => m && m.prim).length,
    };
    b.dispose && b.dispose();
  }
  // (b) tiny AAC glyphs: the point route
  {
    const r = createRenderer(gl, shaders, { staticUnified: true, aacFill: true, psoWarmIdle: () => true });
    r.setViewport(${N}, ${N}); gl.viewport(0, 0, ${N}, ${N});
    r.setFillEngine({ route: 'none' });
    const b = createBundle(gl, await importSvg(${JSON.stringify(GLYPHS)}, { preserveViewport: true }));
    r.prewarmBundle(b); r.precompileFills();   // the loading call: the point program is finished there, not at the first draw
    const wm = [0.5, 0, 0, 0, 0.5, 0, 0, 0, 1];
    const h = r.createBundleHandle(b);
    out.points = { bare: frame(r, () => r.drawBundle(b, { worldMatrix: wm })), handle: frame(r, () => h.draw({ worldMatrix: wm })) };
    b.dispose && b.dispose();
  }
  // (c) a few primitives among many rows: points
  {
    const r = createRenderer(gl, shaders, { staticUnified: true, psoWarmIdle: () => true });
    r.setViewport(${N}, ${N}); gl.viewport(0, 0, ${N}, ${N});
    r.setFillEngine({ route: 'none', primitives: 'on' });
    const b = createBundle(gl, await importSvg(${JSON.stringify(MIXED)}, { preserveViewport: true }));
    r.prepareBundle(b); r.prewarmBundle(b); r.precompileFills();
    if (r.awaitEngine) { try { await r.awaitEngine(b, 'none', 30000); } catch {} }
    const wm = [0.5, 0, 0, 0, 0.5, 0, 0, 0, 1];
    let d = {};
    for (let w = 0; w < 400; w++) { d = frame(r, () => r.drawBundle(b, { worldMatrix: wm })); if ((b._lbMeshes || []).some((m) => m && m.prim) && w > 5) break; await new Promise((res) => setTimeout(res, 5)); }
    out.mixed = { d: frame(r, () => r.drawBundle(b, { worldMatrix: wm })), prims: (b._lbMeshes || []).filter((m) => m && m.prim).length };
    b.dispose && b.dispose();
  }
  out.ok = true;
} catch (e) { out.err = String((e && e.stack) || e); }
window.__out = out;
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
  if (m.type() === 'error') console.error('  [console]', m.text());
});
let o = null;
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`, {
    waitUntil: 'load',
    timeout: 15000,
  });
  await page.waitForFunction(() => window.__out !== undefined, { timeout: 90000, polling: 100 });
  o = await page.evaluate(() => window.__out);
} catch (e) {
  fail('setup: ' + e.message);
}
await browser.close();
server.close();
if (!o || !o.ok) {
  fail('did not complete: ' + (o && o.err));
  process.exit(1);
}
console.log('   ' + JSON.stringify(o));

const keys = (d) => Object.keys(d).sort().join('+') || 'nothing';
// (a)
if (o.prim.prims > 0) ok(`the circle is a recognized primitive (${o.prim.prims})`);
else fail('the circle was not recognized as a primitive');
for (const entry of ['bare', 'handle']) {
  const d = o.prim[entry];
  if (d['sdf@unified'] > 0 && !Object.keys(d).some((k) => k !== 'sdf@unified'))
    ok(`${entry}: the primitive draws as sdf@unified (${keys(d)})`);
  else fail(`${entry}: the primitive drew as ${keys(d)}, not sdf@unified alone`);
}
// With the route off, N copies stay in one instanced draw rather than N per-instance primitive draws (see _lbWouldServe).
if (o.prim.instanced['slug@instanced'] > 0)
  ok(
    `instanced: primitives keep the instanced fast path with the route off (${keys(o.prim.instanced)})`,
  );
else
  fail(
    `instanced: expected the instanced fast path (slug@instanced), drew ${keys(o.prim.instanced)}`,
  );
// (b)
for (const entry of ['bare', 'handle']) {
  const d = o.points[entry];
  if (d['aac@points'] > 0 && !d['aac@cover'])
    ok(`${entry}: tiny AAC glyphs take the point route (${keys(d)})`);
  else fail(`${entry}: tiny AAC glyphs drew as ${keys(d)}, not aac@points`);
}

{
  const d = o.mixed.d;
  if (
    o.mixed.prims > 0 &&
    Object.keys(d).some((k) => /@points$/.test(k)) &&
    !Object.keys(d).some((k) => /unified/.test(k))
  )
    ok(
      `a few primitives among many rows take the point route (${keys(d)}, ${o.mixed.prims} primitives)`,
    );
  else
    fail(
      `a few primitives among many rows drew as ${keys(d)} (${o.mixed.prims} primitives), not points`,
    );
}

if (failures) {
  console.error(`entryPointRouteSmoke: ${failures} failure(s)`);
  process.exit(1);
}
console.log(
  'entryPointRouteSmoke: drawBundle, handle.draw and drawBundleInstanced route a bundle the same way',
);
