// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Verify conservative cover geometry and physical-GPU pixels for authored
// circular pause-icon rings. Cover chunks can contain a triangulated polygon,
// so the check does not require one axis-aligned quad.

import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Committed synthetic pause icons (three 64 x 64 buttons): an authored radius-32 disc centered at (32, 32), drawn as arc commands, with the
// icon detail well inside it. The disc touches all four edges of the viewBox, which is what puts its extreme pixels on the cover's corners.
const DISC = 'M0 32A32 32 0 1 1 64 32A32 32 0 1 1 0 32Z';
const SVG_ICONS = {
  'soundfx-on':
    `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><path d="${DISC}" fill="#32A8EA"/>` +
    '<path d="M18 26H25L33 19V45L25 38H18Z" fill="#FFFFFF"/><path d="M38 24Q44 32 38 40" fill="none" stroke="#FFFFFF" stroke-width="3"/></svg>',
  'soundfx-off':
    `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><path d="${DISC}" fill="#9B9B9B"/>` +
    '<path d="M18 26H25L33 19V45L25 38H18Z" fill="#FFFFFF"/><path d="M40 24L52 40M52 24L40 40" fill="none" stroke="#FFFFFF" stroke-width="3"/></svg>',
  'music-on':
    `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><path d="${DISC}" fill="#32A8EA"/>` +
    '<path d="M28 18L44 14V38A5 5 0 1 1 40 33V24L32 26V42A5 5 0 1 1 28 37Z" fill="#FFFFFF"/></svg>',
};

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="64" height="64"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
import { COVER_QUAD_STRIDE } from '/src/bundle/layout.js';
const cnv = document.getElementById('c');
const gl = cnv.getContext('webgl2', { stencil: true, antialias: false, depth: true, preserveDrawingBuffer: true });
const renderer=createRenderer(gl,await loadShaders(new URL('/src/shaders/',location.href)));
renderer.setViewport(64,64);renderer.setFillEngine({route:'none',kernel:'slug',commit:false});
const debug=gl.getExtension('WEBGL_debug_renderer_info');
const device=debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);
if(/swiftshader|llvmpipe|software/i.test(device))throw Error('Physical GPU required: '+device);
window.__device=device;
const SVGS = ${JSON.stringify(SVG_ICONS)};
const out = {};
for (const name of Object.keys(SVGS)) {
  const sections = await importSvg(SVGS[name],{preserveViewport:true});
  const bundle = createBundle(gl, sections);
  const shapes = bundle.chunkByShape.map((c, shapeIdx) => {
    const triangles = [];
    for (let v = 0; v < c.count; v += 3) {
      triangles.push([0,1,2].map(i => {
        const off=(c.start+v+i)*COVER_QUAD_STRIDE;
        return [bundle.coverQuadFloats[off],bundle.coverQuadFloats[off+1]];
      }));
    }
    return {shapeIdx, triangles};
  });
  renderer.prepareBundle(bundle);renderer.prewarmBundle(bundle);renderer.precompileFills();
  for(let i=0;i<4;i++){renderer.beginFrame([0,0,0,0]);renderer.drawBundle(bundle);renderer.endFrame();}
  const rgba=new Uint8Array(64*64*4);gl.readPixels(0,0,64,64,gl.RGBA,gl.UNSIGNED_BYTE,rgba);
  const samples=[[0,32],[63,32],[32,0],[32,63]].map(([x,y])=>({x,y,alpha:rgba[((63-y)*64+x)*4+3]}));
  if(gl.getError())throw Error('GL error '+name);
  out[name]={shapes,samples,ink:rgba.some(x=>x)};
  bundle.dispose();
}
window.__result = out;
renderer.dispose();window.__done = true;
</script>
</body></html>`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/' || u.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  let p = decodeURIComponent(u.pathname);
  const mime =
    p.endsWith('.js') || p.endsWith('.mjs')
      ? 'text/javascript'
      : p.endsWith('.glsl')
        ? 'text/plain'
        : 'application/octet-stream';
  try {
    res.writeHead(200, { 'content-type': mime + '; charset=utf-8' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    try {
      res.writeHead(404);
      res.end();
    } catch {}
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
await page.setViewport({ width: 200, height: 200 });
await page.goto(url, { waitUntil: 'load', timeout: 10000 });
await page.waitForFunction(() => window.__done === true, { timeout: 15000, polling: 100 });
const results = await page.evaluate(() => window.__result);
const device = await page.evaluate(() => window.__device);
console.log('GPU ' + device);
await browser.close();
server.close();

let failures = 0;
const ok = (m) => console.log('ok', m);
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};

function contains(triangles, p) {
  return triangles.some((t) => {
    const cross = t.map((a, i) => {
      const b = t[(i + 1) % 3];
      return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    });
    return cross.every((x) => x >= -1e-2) || cross.every((x) => x <= 1e-2);
  });
}

for (const iconName of Object.keys(results)) {
  const { shapes, samples, ink } = results[iconName];
  if (!ink) fail(iconName + ': blank GPU image');
  // Find the outer ring by the bounds of its entire triangulated cover.
  const ringShapes = shapes.filter((s) => {
    const xs = s.triangles.flat().map((v) => v[0]);
    const ys = s.triangles.flat().map((v) => v[1]);
    const w = Math.max(...xs) - Math.min(...xs);
    const h = Math.max(...ys) - Math.min(...ys);
    return w > 50 && h > 50;
  });
  if (ringShapes.length === 0) {
    fail(`${iconName}: no full-bbox shape found`);
    continue;
  }
  // The authored outer boundary is the radius-32 circle centered at (32,32).
  // At these four extreme pixels the inner ring and icon detail cannot reach.
  // Its exact intersection with a unit box is the integral of 1-x_boundary.
  const F = (y) => 0.5 * (y * Math.sqrt(32 * 32 - y * y) + 32 * 32 * Math.asin(y / 32));
  const area = F(1) - F(0) - 31;
  for (const sample of samples) {
    const error = Math.abs(sample.alpha - 255 * area);
    if (error <= 1)
      ok(iconName + ': GPU outer-ring pixel ' + sample.x + ',' + sample.y + ' within 1 alpha byte');
    else
      fail(
        iconName +
          ': GPU outer-ring pixel ' +
          sample.x +
          ',' +
          sample.y +
          ' ' +
          sample.alpha +
          ' for ' +
          255 * area +
          ' (' +
          error +
          ' bytes)',
      );
  }
  for (const shape of ringShapes) {
    const missing = [];
    for (let i = 0; i < 512; i++) {
      const angle = (2 * Math.PI * i) / 512;
      if (!contains(shape.triangles, [32 + 32 * Math.cos(angle), 32 + 32 * Math.sin(angle)]))
        missing.push(i);
    }
    if (missing.length)
      fail(
        iconName + ': ring cover misses ' + missing.length + ' of 512 authored boundary samples',
      );
    else ok(iconName + ': complete circle boundary contained by cover triangles');
  }
}

if (failures > 0) {
  console.error(`\nCIRCLE-OBB-AXIS-ALIGNED FAIL (${failures})`);
  process.exit(1);
}
console.log('\nCIRCLE-OBB-AXIS-ALIGNED PASS');
