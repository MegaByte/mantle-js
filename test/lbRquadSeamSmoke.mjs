// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbRquadSeamSmoke.mjs — a non-circular <ellipse> renders through rational-quadratic
// (kind-5) arc crescents. PRIMARY contract: LB must not OVER-cover the arc (the
// curvature-aware fragment coverage lands the ½-level on the true conic, not on its
// over-reaching tangent line). A VS radial dilation would close the additive-MAX
// seam notch but over-cover, so there is none. A residual seam notch (under-coverage
// where adjacent ≤90° arc crescents pinch) remains and is bounded here; it is deeper
// than the quad case (an ellipse splits into only ~4 sharp arcs) but is the lesser
// artifact vs the over-coverage, and circular arcs avoid it entirely via kind-6 SDF.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const R = 40;
const SVG = readFileSync(
  new URL('../examples/smoke/lbRquadSeam__SVG.svg', import.meta.url),
  'utf8',
);

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${R}" height="${R}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders, { staticUnified: true }); renderer.setViewport(${R}, ${R});
// REFERENCE = AAC (exact signed-area coverage). Slug and LB share the same exactBoxCov
// kernel, so "LB matches Slug" does not prove either is right.
const refR = createRenderer(gl, shaders, { staticUnified: true, aacFill: true }); refR.setViewport(${R}, ${R}); refR.setLoopBlinnFill('off');
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)})); renderer.prepareBundle(bundle); await renderer.awaitLbReady(bundle);
const read = () => { const px = new Uint8Array(${R}*${R}*4); gl.readPixels(0,0,${R},${R},gl.RGBA,gl.UNSIGNED_BYTE,px); return px; };
const cov = (px,x,y) => { const q = ((${R}-1-y)*${R}+x)*4; return (255-px[q])/255; };
const draw = (m) => { renderer.setLoopBlinnFill(m); const r = renderer.debugStats.loopBlinnRouteCount;
  renderer.beginFrame([1,1,1,1]); renderer.drawBundle(bundle); renderer.endFrame();
  return { px: read(), routed: renderer.debugStats.loopBlinnRouteCount - r }; };
const drawRef = () => { refR.beginFrame([1,1,1,1]); refR.drawBundle(bundle); refR.endFrame(); return { px: read(), routed: 1 }; };
const slug = drawRef(), lb = draw('on');
let sum=0, sgn=0, n=0, maxOver=0, maxUnder=0, notch=0;
for (let y=0;y<${R};y++) for (let x=0;x<${R};x++){ const s=cov(slug.px,x,y), l=cov(lb.px,x,y);
  if ((s>0.02&&s<0.98)||(l>0.02&&l<0.98)){ const d=l-s; sum+=Math.abs(d); sgn+=d; n++;
    if (d>maxOver) maxOver=d; if (-d>maxUnder) maxUnder=-d;
    if (s>0.1 && l<0.02) notch=Math.max(notch, s); } }
window.__out = { lbRouted: lb.routed, bias:+(sgn/Math.max(n,1)).toFixed(4), maxOver:+maxOver.toFixed(3), maxUnder:+maxUnder.toFixed(3),
  mean:+(sum/Math.max(n,1)).toFixed(4), notch:+notch.toFixed(3) };
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
  if (m.type() === 'error') console.error('  [console]', m.text());
});
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 15000 });
  await page.waitForFunction(() => window.__ready === true, { timeout: 10000, polling: 100 });
} catch (e) {
  fail('setup: ' + e.message);
  await browser.close();
  server.close();
  process.exit(1);
}

const o = await page.evaluate(() => window.__out);
console.log('  ', JSON.stringify(o));
if (o.lbRouted) ok('ellipse routes through LB');
else fail('ellipse did NOT route to LB');
// PRIMARY: no SYSTEMATIC over-coverage on the conic arc (signed band bias ≈ 0).
if (o.bias <= 0.02) ok('no systematic arc over-coverage (band bias = ' + o.bias + ')');
else
  fail(
    'LB systematically OVER-covers the rquad arc (band bias ' +
      o.bias +
      ') — tangent-line coverage?',
  );
if (o.mean <= 0.045) ok('mean boundary error ' + o.mean);
else fail('mean boundary error too high (' + o.mean + ')');
// Residual seam notch bounded (deeper than quad — only ~4 sharp arc splits).
if (o.maxUnder <= 0.45) ok('seam notch bounded (max under-coverage ' + o.maxUnder + ')');
else fail('seam notch too deep (max under-coverage ' + o.maxUnder + ')');

await browser.close();
server.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log('\nlbRquadSeamSmoke: curvature-aware coverage — no over-coverage, seam notch bounded');
