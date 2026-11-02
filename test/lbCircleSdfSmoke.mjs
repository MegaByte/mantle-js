// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbCircleSdfSmoke.mjs — a filled CIRCLE renders through the exact circular-SDF
// primitive (kind 7), not per-≤90° rquad crescents, so it's SEAM-FREE and matches
// Slug's coverage everywhere — including the horizontal/vertical tangents where
// crescent seams (at the arc-split points) under-cover by up to ~0.24.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SVG = readFileSync(
  new URL('../examples/smoke/lbCircleSdf__SVG.svg', import.meta.url),
  'utf8',
);

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="160" height="160"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders, { staticUnified: true }); renderer.setViewport(160, 160);
// REFERENCE = AAC (exact signed-area coverage), not Slug. Slug and LB share the same
// exactBoxCov kernel, so "LB matches Slug" does not prove either is right.
const refR = createRenderer(gl, shaders, { staticUnified: true, aacFill: true }); refR.setViewport(160, 160); refR.setLoopBlinnFill('off');
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)})); renderer.prepareBundle(bundle); await renderer.awaitLbReady(bundle);
const read = () => { const px = new Uint8Array(160*160*4); gl.readPixels(0,0,160,160,gl.RGBA,gl.UNSIGNED_BYTE,px); return px; };
const cov = (px,x,y) => { const q = ((159-y)*160+x)*4; return (255-px[q])/255; };
const draw = (m) => { renderer.setLoopBlinnFill(m); const r = renderer.debugStats.loopBlinnRouteCount;
  renderer.beginFrame([1,1,1,1]); renderer.drawBundle(bundle); renderer.endFrame(); return { px: read(), routed: renderer.debugStats.loopBlinnRouteCount - r }; };
const drawRef = () => { refR.beginFrame([1,1,1,1]); refR.drawBundle(bundle); refR.endFrame(); return { px: read(), routed: 1 }; };
const slug = drawRef(), lb = draw('on');
// center from boundary-pixel bbox, then worst per-pixel coverage error around the ring
let x0=1e9,x1=-1e9,y0=1e9,y1=-1e9;
for (let y=0;y<160;y++) for (let x=0;x<160;x++){ const s=cov(slug.px,x,y); if (s>0.02&&s<0.98){ if(x<x0)x0=x;if(x>x1)x1=x;if(y<y0)y0=y;if(y>y1)y1=y; } }
let worst=0, n=0, sum=0, nBad=0;
for (let y=0;y<160;y++) for (let x=0;x<160;x++){ const s=cov(slug.px,x,y), l=cov(lb.px,x,y);
  if ((s>0.02&&s<0.98)||(l>0.02&&l<0.98)){ const e=Math.abs(s-l); if(e>worst)worst=e; if(e>0.1)nBad++; sum+=e; n++; } }
window.__out = { lbRouted: lb.routed, worst:+worst.toFixed(3), nBad, mean:+(sum/Math.max(n,1)).toFixed(3) };
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
  await openReady(page, `http://127.0.0.1:${port}/`, { ready: 'flag' });
} catch (e) {
  fail('setup: ' + e.message);
  await browser.close();
  server.close();
  process.exit(1);
}

const o = await page.evaluate(() => window.__out);
console.log('  ', JSON.stringify(o));
if (o.lbRouted) ok('circle routes through LB');
else fail('circle did NOT route to LB');
// Crescent seams would give worst ~0.24-0.37 and a large MEAN. The circular SDF holds every
// boundary pixel within a hair of the exact reference, so the mean is the real guard.
// `worst` is an OUTLIER COUNT: a handful of grazing pixels — where the reference engine's
// ray is nearly tangent to the circle and it falls back to its blended combiner — can swing
// wide without meaning anything. A seam defect moves the mean and floods nBad.
if (o.mean <= 0.01) ok('mean boundary coverage error ' + o.mean + ' — seam-free SDF');
else fail('mean boundary error too high (' + o.mean + ') — crescent seams?');
if (o.nBad <= 6) ok('only ' + o.nBad + ' outlier pixel(s) (grazing rays), worst ' + o.worst);
else fail(o.nBad + ' pixels diverge >0.1 (worst ' + o.worst + ') — crescent seams?');

await browser.close();
server.close();
if (failures) {
  console.error('\\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  '\\nlbCircleSdfSmoke: filled circle is seam-free (kind-7 SDF), matches the exact reference',
);
