// lbSplitRouteSmoke.mjs — when a bundle has a loop/cusp SENTINEL that a later LB shape
// paints over (so it can't be deferred past the one-draw combined batch), the analytic
// route must NOT fall to a per-shape draw storm, and must NOT bail the whole bundle to
// Slug when the run count is small. It takes the SPLIT route: each contiguous run of LB
// shapes is ONE batched combined-VBO segment, and each contiguous run of sentinels is ONE
// Slug pass, interleaved in painter order. This asserts (a) the split path actually ran
// (bundle._lbSplitVbo is built), and (b) it matches Slug's ink (the sentinel + LB fills
// all present, no drop/double-paint). Non-vacuous on swiftshader.
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import puppeteer from 'puppeteer';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const N = 200;
// A self-crossing loop (sentinel) between LB quads, with a later LB quad that overlaps the
// loop's fill bbox → the sentinel is NON-deferrable, so the combined route bails and the
// split takes over. runs (2) + sentinel-runs (1) = 3 ≤ the bail crossover → keep LB.
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}">
  <path d="M20,60 L45,60 L45,85 L20,85 Z" fill="#101010"/>
  <path d="M50,30 L50,150 C190,30 190,150 50,30 Z" fill="#303030"/>
  <path d="M95,70 L135,70 L135,110 L95,110 Z" fill="#404040"/>
</svg>`;
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, depth: true, stencil: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders); renderer.setViewport(${N}, ${N});
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)}));
renderer.prepareBundle(bundle); await renderer.awaitLbReady(bundle);
const read = () => { const px = new Uint8Array(${N} * ${N} * 4); gl.readPixels(0, 0, ${N}, ${N}, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
const ink = (px) => { let n = 0; for (let i = 0; i < ${N} * ${N}; i++) { const o = i * 4; if (!(px[o] > 245 && px[o + 1] > 245 && px[o + 2] > 245)) n++; } return n; };
const draw = (m) => { renderer.setLoopBlinnFill(m); const r = renderer.debugStats.loopBlinnRouteCount;
  renderer.beginFrame([1, 1, 1, 1]); renderer.drawBundle(bundle); renderer.endFrame();
  return { ink: ink(read()), routed: renderer.debugStats.loopBlinnRouteCount - r }; };
// LB FIRST (a Slug pass sets bundle._geomGen, which vetoes the static LB route after).
const lb = draw('on');
const splitRan = !!(bundle._lbSplitVbo && bundle._lbSplitVbo.vbo);
const slug = draw('off');
window.__out = { slugInk: slug.ink, lbInk: lb.ink, lbRouted: lb.routed, splitRan, hasSlug: !!bundle._lbHasSlug };
window.__ready = true;
</script></body></html>`;
const server = http.createServer((req, res) => { try {
  if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(HTML); return; }
  const p = decodeURIComponent(req.url.split('?')[0]);
  res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' }); res.end(readFileSync(path.join(ROOT, p)));
} catch { if (!res.headersSent) res.writeHead(404); res.end(); } });
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
const o = await page.evaluate(() => window.__out);
console.log('  ', JSON.stringify(o));
if (o.hasSlug) ok('the loop is a sentinel'); else fail('expected a loop/cusp sentinel');
if (o.lbRouted) ok('bundle routed through the analytic path'); else fail('did NOT route to LB');
if (o.splitRan) ok('the SPLIT route ran (batched LB runs + interleaved sentinel)'); else fail('split route did NOT run (fell to combined/per-shape/Slug)');
if (o.lbInk >= o.slugInk * 0.95 && o.lbInk <= o.slugInk * 1.05) ok('split ink matches Slug (' + o.lbInk + ' vs ' + o.slugInk + ')');
else fail('split ink ' + o.lbInk + ' diverges from Slug ' + o.slugInk + ' — a dropped or double-painted run');
await browser.close();
server.close();
if (failures) { console.error('\n' + failures + ' failure(s)'); process.exit(1); }
console.log('\nlbSplitRouteSmoke: non-deferrable sentinel → batched split (runs + interleaved sentinels), Slug-matching ink');
