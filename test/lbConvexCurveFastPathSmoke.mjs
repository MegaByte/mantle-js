// lbConvexCurveFastPathSmoke.mjs — a single-contour, opaque, CONVEX curved shape
// (no concave curve, no hole) renders through the cheap earcut MESH path instead
// of the CDT partition — and matches Slug. A shape with a CONCAVE curve must still
// fall to the CDT path (the mesh mis-threads it). Guards the routing fast path:
// buildLoopBlinnMesh flags hasConcave, so only concave curves pay the CDT cost.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// convex: ellipse (arcs) + a convex cubic "leaf". concave: a crescent (inner cubic
// bulges into the fill) — the mesh would over-fill it, so it must route to CDT.
const SHAPES = {
  ellipse:  { convex: true,  d: 'M60 20 A40 25 0 1 0 60 100 A40 25 0 1 0 60 20 Z' },
  leaf:     { convex: true,  d: 'M60 15 C95 30 95 90 60 105 C25 90 25 30 60 15 Z' },
  crescent: { convex: false, d: 'M60 15 C100 15 100 105 60 105 C90 85 90 35 60 15 Z' },
};

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="120" height="120"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders); renderer.setViewport(120, 120);
window.__run = async (d) => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="120" height="120"><path fill="#3366cc" d="' + d + '"/></svg>';
  const bundle = createBundle(gl, await importSvg(svg)); renderer.prepareBundle(bundle);
  const read = () => { const px = new Uint8Array(120*120*4); gl.readPixels(0,0,120,120,gl.RGBA,gl.UNSIGNED_BYTE,px); return px; };
  const fill = (px,i) => { const o = i*4; return px[o] < 230 || px[o+2] < 230; };
  const draw = (m) => { renderer.setLoopBlinnFill(m); const r = renderer.debugStats.loopBlinnRouteCount;
    renderer.beginFrame([1,1,1,1]); renderer.drawBundle(bundle); renderer.endFrame();
    return { px: read(), routed: renderer.debugStats.loopBlinnRouteCount - r }; };
  const slug = draw('off'), lb = draw('on');
  let ink = 0, disagree = 0;
  for (let i = 0; i < 120*120; i++) { if (fill(slug.px,i)) ink++; if (fill(slug.px,i) !== fill(lb.px,i)) disagree++; }
  return { slugInk: ink, disagree, routed: lb.routed };
};
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

for (const [name, s] of Object.entries(SHAPES)) {
  const o = await page.evaluate((d) => window.__run(d), s.d);
  console.log(`  [${name}] ` + JSON.stringify(o));
  if (o.routed) ok(`[${name}] routes through LB`); else fail(`[${name}] did NOT route to LB`);
  // disagreement with Slug: a mis-thread over/under-fills a large region (~thousands
  // of px); a correct render differs only in a thin AA band (~tens of px). The tol
  // sits well between the two so it catches a mis-thread but passes AA noise.
  const tol = Math.max(200, o.slugInk * 0.08);
  if (o.disagree <= tol) ok(`[${name}] ${s.convex ? 'convex→mesh' : 'concave→CDT'} matches Slug (disagree ${o.disagree} ≤ ${tol|0})`);
  else fail(`[${name}] disagrees with Slug by ${o.disagree}px (> ${tol|0}) — ${s.convex ? 'mesh mis-thread' : 'CDT error'}`);
}

await browser.close();
server.close();
if (failures) { console.error('\\n' + failures + ' failure(s)'); process.exit(1); }
console.log('\\nlbConvexCurveFastPathSmoke: convex curves render correct via mesh, concave via CDT');
