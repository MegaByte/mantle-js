// lbHoleParitySmoke.mjs — a fill WITH A HOLE (ring) must render through the LB
// route matching Slug: the hole stays EMPTY. Guards the static↔morph unification
// for holes — multi-contour CURVED-holed static shapes take the CDT partition path
// (the same one the morph route uses), because the additive single-pass mesh only
// ADDS coverage (MAX/OVER) and would fill the hole. Pre-fix this rendered ~2× ink.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// A thick ring: outer circle + concentric inner circle (the hole), one path with
// two subpaths (nonzero winding → annulus). Cubic-arc curves throughout.
const SVG = readFileSync(new URL('../examples/smoke/lbHoleParity__SVG.svg', import.meta.url), 'utf8');

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="100" height="100"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, createShapeMorph } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
renderer.setViewport(100, 100);
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)}));
renderer.prepareBundle(bundle);
await renderer.awaitLbReady(bundle);   // LB build is off-thread at load; wait for the worker before asserting the route
// Self-morph (a single-pose timeline, as games mount static art) → the MORPH
// route, which must apply signed coverage to the holed shape too.
const morph = createShapeMorph(gl, createBundle(gl, await importSvg(${JSON.stringify(SVG)})), createBundle(gl, await importSvg(${JSON.stringify(SVG)})));
morph.setT(0);
if (renderer.awaitLbReady) await renderer.awaitLbReady(morph); // morph build is off-thread — wait before asserting the route
const readAll = () => { const px = new Uint8Array(100 * 100 * 4); gl.readPixels(0, 0, 100, 100, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
const at = (px, x, yTop) => { const o = ((99 - yTop) * 100 + x) * 4; return [px[o], px[o + 1], px[o + 2]]; };
const draw = (mode) => { renderer.setLoopBlinnFill(mode); const r = renderer.debugStats.loopBlinnRouteCount;
  renderer.beginFrame([1, 1, 1, 1]); renderer.drawBundle(bundle); renderer.endFrame();
  return { px: readAll(), routed: renderer.debugStats.loopBlinnRouteCount - r }; };
const ink = (px) => { let n = 0; for (let i = 0; i < 100 * 100; i++) { const o = i * 4; if (px[o] < 230 || px[o + 1] < 230 || px[o + 2] < 230) n++; } return n; };
// interior mean diff over pixels inked in BOTH (skip AA rim)
const diff = (a, b) => { let s = 0, both = 0; for (let i = 0; i < 100 * 100; i++) { const o = i * 4;
  const ai = a[o] < 230 || a[o+2] < 230, bi = b[o] < 230 || b[o+2] < 230;
  if (ai && bi) { both++; for (let k = 0; k < 3; k++) s += Math.abs(a[o+k]-b[o+k]); } }
  return both ? +(s/(both*3)).toFixed(2) : 999; };
const drawM = (mode) => { renderer.setLoopBlinnFill(mode); const r = renderer.debugStats.loopBlinnMorphRouteCount;
  renderer.beginFrame([1, 1, 1, 1]); renderer.drawBundle(morph); renderer.endFrame();
  return { px: readAll(), routed: renderer.debugStats.loopBlinnMorphRouteCount - r }; };
const slug = draw('off');
const lb = draw('on');
const morphLb = drawM('auto');
window.__out = { slugRouted: slug.routed, lbRouted: lb.routed, slugInk: ink(slug.px), lbInk: ink(lb.px),
  center: { slug: at(slug.px, 50, 50), lb: at(lb.px, 50, 50) }, maxDiff: diff(slug.px, lb.px),
  morphRouted: morphLb.routed, morphInk: ink(morphLb.px), morphCenter: at(morphLb.px, 50, 50), morphDiff: diff(slug.px, morphLb.px) };
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  try {
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(HTML); return; }
    const p = decodeURIComponent(req.url.split('?')[0]);
    res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' }); res.end(readFileSync(path.join(ROOT, p)));
  } catch { if (!res.headersSent) res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => { failures++; console.error('FAIL: ' + m); };

const browser = await puppeteer.launch({ headless: 'new', args: ['--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage();
page.on('pageerror', e => console.error('  [page-err]', e.message));
page.on('console', m => { if (m.type() === 'error') console.error('  [console]', m.text()); });
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 15000 });
  await page.waitForFunction(() => window.__ready === true, { timeout: 10000 });
} catch (e) { fail('setup: ' + e.message); await browser.close(); server.close(); process.exit(1); }

const o = await page.evaluate(() => window.__out);
console.log('  ', JSON.stringify(o));
const isBg = c => c[0] > 230 && c[1] > 230 && c[2] > 230;

if (!o.slugRouted) ok('Slug used with LB off'); else fail('LB routed with fill off');
if (o.lbRouted) ok('ring routes through LB'); else fail('ring did NOT route to LB');
if (isBg(o.center.slug)) ok('Slug leaves the hole empty'); else fail('Slug reference filled the hole?? ' + JSON.stringify(o.center.slug));
if (isBg(o.center.lb)) ok('LB leaves the hole EMPTY (CDT partition)');
else fail('LB FILLED the hole (center ' + JSON.stringify(o.center.lb) + ') — CDT hole-removal not engaged');
if (Math.abs(o.lbInk - o.slugInk) <= o.slugInk * 0.05) ok('LB ink matches Slug within 5% (' + o.lbInk + ' vs ' + o.slugInk + ')');
else fail('LB ink != Slug (' + o.lbInk + ' vs ' + o.slugInk + ') — hole fill / overfill');
if (o.maxDiff <= 6) ok('interior fill matches Slug (mean channel diff ' + o.maxDiff + ')');
else fail('interior != Slug (mean channel diff ' + o.maxDiff + ')');
// MORPH route (single-pose timeline) must also apply signed coverage to the hole.
if (o.morphRouted) ok('ring routes through the MORPH route'); else fail('ring did NOT route to the morph route');
if (isBg(o.morphCenter)) ok('MORPH route leaves the hole EMPTY (signed)');
else fail('MORPH route FILLED the hole (center ' + JSON.stringify(o.morphCenter) + ') — multi-contour not forced signed');
if (Math.abs(o.morphInk - o.slugInk) <= o.slugInk * 0.05) ok('morph ink matches Slug (' + o.morphInk + ' vs ' + o.slugInk + ')');
else fail('morph ink != Slug (' + o.morphInk + ' vs ' + o.slugInk + ') — hole fill via morph route');

await browser.close();
server.close();
if (failures) { console.error('\\n' + failures + ' failure(s)'); process.exit(1); }
console.log('\\nlbHoleParitySmoke: a holed fill renders through the signed LB path with the hole empty');
