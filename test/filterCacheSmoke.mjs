// Filter result cache. A bundle with a blurred shape (filter graph) +
// a plain sibling shape. Asserts:
//   1. Static re-renders reuse the filter output — filterEvalCount stays
//      1 across multiple frames (the eval, incl. the multi-pass blur, is
//      skipped). The composite still re-runs (backdrop may change).
//   2. Animating the SIBLING (not the filtered shape) does NOT
//      re-evaluate the filter — its feedShapeMask shape is unchanged.
//   3. Animating the FILTERED shape DOES re-evaluate.
//   4. Output stays visually correct throughout (blur present).
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Two shapes with ids so the override table can target them:
//   #blurred — a red rect with a feTurbulence filter. feTurbulence forces
//              the composable filter-graph path (filterGraphId), which is
//              what the cache wraps. (A lone feGaussianBlur reduces to the
//              single-kind fast path.)
//   #plain   — a green rect, no filter (the animating sibling)
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
  <defs><filter id="b" x="0" y="0" width="100%" height="100%">
    <feTurbulence type="fractalNoise" baseFrequency="0.05" numOctaves="2" result="n"/>
    <feComposite in="n" in2="SourceGraphic" operator="in"/>
  </filter></defs>
  <rect id="blurred" x="20" y="20" width="120" height="120" fill="#ff0000" filter="url(#b)"/>
  <rect id="plain"   x="150" y="150" width="40" height="40" fill="#00ff00"/>
</svg>`;

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="200" height="200"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, createOverrideTable } from '/src/index.js';
const cnv = document.getElementById('c');
const gl = cnv.getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
const sections = await importSvg(${JSON.stringify(SVG)});
const bundle = createBundle(gl, sections);
const ovr = createOverrideTable(gl, bundle);
const id = new Float32Array([1,0,0, 0,1,0, 0,0,1]);
window.__r = renderer; window.__gl = gl;
window.__hasGraph = !!(bundle.filterGraphs && bundle.filterGraphs.length);
window.__frame = (useOvr) => {
  renderer.setViewport(200, 200);
  renderer.beginFrame([0,0,0,1]);
  renderer.drawBundle(bundle, useOvr ? { worldMatrix: id, overrides: ovr } : { worldMatrix: id });
  renderer.endFrame();
};
window.__animate = (shapeId, dx) => { ovr.set(shapeId, { localPosition: [dx, 0] }); };
window.__sample = (x, yTop) => { const b = new Uint8Array(4); gl.readPixels(x, 200-1-yTop, 1,1, gl.RGBA, gl.UNSIGNED_BYTE, b); return [b[0],b[1],b[2],b[3]]; };
window.__evals = () => renderer.debugStats.filterEvalCount;
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(HTML); return; }
  let p = decodeURIComponent(req.url.split('?')[0]);
  const ct = p.endsWith('.glsl') ? 'text/plain' : 'text/javascript';
  try { res.writeHead(200, { 'content-type': ct + '; charset=utf-8' }); res.end(readFileSync(path.join(ROOT, p))); }
  catch { if (!res.headersSent) res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => { failures++; console.error('FAIL: ' + m); };

const browser = await puppeteer.launch({ headless: 'new', args: ['--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage();
page.on('pageerror', e => console.error('  [page-err]', e.message));
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 15000 });
  await page.waitForFunction(() => window.__ready === true, { timeout: 10000 });
} catch (e) { fail('setup: ' + e.message); await browser.close(); server.close(); process.exit(1); }

if (await page.evaluate(() => window.__hasGraph)) ok('fixture produced a filter graph');
else fail('no filter graph — test vacuous (filter may have reduced to single-kind path)');

// Frame 1 + correctness: blur edge is soft (a pixel just outside the
// rect's hard edge should still have some red from the blur).
const r1 = await page.evaluate(() => {
  window.__frame(false);
  return { edge: window.__sample(60, 60), evals: window.__evals() };
});
if (r1.evals === 1) ok('frame 1 evaluated the filter once'); else fail('eval count after frame 1: ' + r1.evals);
if (r1.edge[3] > 8) ok('filtered (turbulence) content present inside rect (a=' + r1.edge[3] + ')'); else fail('no filtered content: ' + r1.edge);

// 4 more static frames → no more evals (cache hit).
const r2 = await page.evaluate(() => { for (let i=0;i<4;i++) window.__frame(false); return window.__evals(); });
if (r2 === 1) ok('4 static frames: filter NOT re-evaluated (count still 1)'); else fail('filter re-evaluated on static re-render: ' + r2);

// Animate the SIBLING (plain) — filter must NOT re-evaluate.
const r3 = await page.evaluate(() => {
  window.__animate('plain', 5); window.__frame(true);
  window.__animate('plain', 10); window.__frame(true);
  return { evals: window.__evals(), halo: window.__sample(60, 60) };
});
if (r3.evals === 1) ok('sibling animates → filter NOT re-evaluated (count still 1 — the headline win)'); else fail('sibling animation re-evaluated filter: ' + r3.evals);
if (r3.halo[3] > 8) ok('filtered output still present after sibling animation'); else fail('filter output lost: ' + r3.halo);

// Animate the FILTERED shape — filter MUST re-evaluate.
const r4 = await page.evaluate(() => {
  window.__animate('blurred', 8); window.__frame(true);
  return window.__evals();
});
if (r4 === 2) ok('filtered shape animates → filter re-evaluated (count→2)'); else fail('filtered shape animation did not re-evaluate: ' + r4);

// ---- Single-kind path (lone feGaussianBlur — the COMMON case) ----
// A lone blur reduces to the single-kind filter path, not the graph
// path. Verify it caches the same way: static no re-eval, sibling no
// re-eval, filtered shape re-evals, and the cached output is identical.
{
  const blurSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200"><defs><filter id="bb"><feGaussianBlur stdDeviation="5"/></filter></defs><rect id="bl" x="40" y="40" width="100" height="100" fill="#ff0000" filter="url(#bb)"/><rect id="pl" x="160" y="160" width="30" height="30" fill="#00ff00"/></svg>`;
  await page.evaluate(async (svg) => {
    const { importSvg, createBundle, createRenderer, loadShaders, createOverrideTable } = await import('/src/index.js');
    const cnv = document.getElementById('c');
    const gl = cnv.getContext('webgl2', { premultipliedAlpha: true, preserveDrawingBuffer: true });
    const sh = await loadShaders(new URL('/src/shaders/', location.href).href);
    const r = createRenderer(gl, sh); const b = createBundle(gl, await importSvg(svg));
    const ovr = createOverrideTable(gl, b); const id = new Float32Array([1,0,0,0,1,0,0,0,1]);
    window.__bHasGraph = !!(b.filterGraphs && b.filterGraphs.length);
    window.__bframe = (o) => { r.setViewport(200,200); r.beginFrame([0,0,0,1]); r.drawBundle(b, o?{worldMatrix:id,overrides:ovr}:{worldMatrix:id}); r.endFrame(); };
    window.__ban = (s,d) => ovr.set(s,{localPosition:[d,0]});
    window.__bev = () => r.debugStats.filterEvalCount;
    window.__bcore = () => { const x=new Uint8Array(4); gl.readPixels(90,200-1-90,1,1,gl.RGBA,gl.UNSIGNED_BYTE,x); return x[0]; };
  }, blurSvg);
  const sk = await page.evaluate(() => {
    const base = window.__bev();
    window.__bframe(false); const e1 = window.__bev() - base, c1 = window.__bcore();
    for (let i=0;i<4;i++) window.__bframe(false); const e2 = window.__bev() - base;
    window.__ban('pl', 10); window.__bframe(true); const e3 = window.__bev() - base;
    window.__ban('bl', 8);  window.__bframe(true); const e4 = window.__bev() - base;
    const c2 = window.__bcore();
    return { graph: window.__bHasGraph, e1, e2, e3, e4, c1, c2 };
  });
  if (sk.graph === false) ok('single-kind: lone blur uses the single-kind path (not graph)'); else fail('lone blur unexpectedly produced a graph');
  if (sk.e1 === 1) ok('single-kind: frame 1 evaluated once'); else fail('single-kind eval after f1: ' + sk.e1);
  if (sk.e2 === 1) ok('single-kind: static re-renders cache hit (no re-eval)'); else fail('single-kind re-eval on static: ' + sk.e2);
  if (sk.e3 === 1) ok('single-kind: sibling animates → no re-eval'); else fail('single-kind sibling re-eval: ' + sk.e3);
  if (sk.e4 === 2) ok('single-kind: filtered shape animates → re-eval'); else fail('single-kind filtered no re-eval: ' + sk.e4);
  if (sk.c1 > 200 && sk.c2 === sk.c1) ok('single-kind: cached blur output identical (core red ' + sk.c1 + ')'); else fail('single-kind output changed: ' + sk.c1 + ' vs ' + sk.c2);
}

await browser.close();
server.close();
if (failures === 0) console.log('\nFILTER-CACHE PASS');
else console.log(`\nFILTER-CACHE FAIL (${failures})`);
process.exit(failures ? 1 : 0);
