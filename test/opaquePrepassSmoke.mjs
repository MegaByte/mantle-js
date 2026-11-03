// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// opaquePrepassSmoke -- certified opaque interiors may populate depth, but the
// visible result must remain byte-identical to the ordinary analytic fill.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const N = 512;
const blob = (x, y, c) =>
  `<path fill="${c}" d="M ${x - 120} ${y} C ${x - 120} ${y - 150} ${x + 120} ${y - 150} ${x + 120} ${y} C ${x + 120} ${y + 150} ${x - 120} ${y + 150} ${x - 120} ${y} Z"/>`;
const SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}">` +
  Array.from({ length: 12 }, (_, i) =>
    blob(256 + (i % 3) * 9, 256 + (i % 4) * 7, `hsl(${i * 29},65%,48%)`),
  ).join('') +
  `</svg>`;

const HTML = `<!DOCTYPE html><canvas id="c" width="${N}" height="${N}"></canvas><script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias:false, depth:true, stencil:true, preserveDrawingBuffer:true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const r = createRenderer(gl, shaders, { opaquePrepass: true }); r.setViewport(${N}, ${N}); r.setLoopBlinnFill('off');
const b = createBundle(gl, await importSvg(${JSON.stringify(SVG)}, { preserveViewport:true, occupancyGrid:{ grid:24 } }));
const id = new Float32Array([1,0,0, 0,1,0, 0,0,1]);
const moved = new Float32Array([0.82,0,0, 0,0.82,0, 0.08,-0.06,1]);
const tiny = new Float32Array([0.01,0,0, 0,0.01,0, 0,0,1]);
const cm = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
const grab = () => { const p = new Uint8Array(${N}*${N}*4); gl.readPixels(0,0,${N},${N},gl.RGBA,gl.UNSIGNED_BYTE,p); return p; };
const draw = (opts) => { r.beginFrame([1,1,1,1]); r.drawBundle(b, opts); r.endFrame(); return grab(); };
const diff = (a,b) => { let max=0,n=0; for(let i=0;i<a.length;i++){const d=Math.abs(a[i]-b[i]);max=Math.max(max,d);if(d)n++;} return {max,n:n/4}; };
const before = r.debugStats.opaquePrepassCount;
const pre = draw({ worldMatrix:id });
const afterPre = r.debugStats.opaquePrepassCount;
const ordinary = draw({ worldMatrix:id, colorMatrix:cm });
const movedPre = draw({ worldMatrix:moved });
const afterMovedPre = r.debugStats.opaquePrepassCount;
const movedOrdinary = draw({ worldMatrix:moved, colorMatrix:cm });
const afterOrdinary = r.debugStats.opaquePrepassCount;
const tinyPre = draw({ worldMatrix:tiny });
const afterTinyPre = r.debugStats.opaquePrepassCount;
const tinyOrdinary = draw({ worldMatrix:tiny, colorMatrix:cm });
window.__out = { hasOccupancy:b.hasOccupancy, prepassRuns:afterPre-before, movedPrepassRuns:afterMovedPre-afterPre, recolorRuns:afterOrdinary-afterMovedPre, tinyPrepassRuns:afterTinyPre-afterOrdinary, normal:diff(pre,ordinary), moved:diff(movedPre,movedOrdinary), tiny:diff(tinyPre,tinyOrdinary) };
window.__ready = true;
</script>`;

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
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await launchBrowser({
  headless: 'new',
  args: ['--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[page]', e.message));
await page.goto(`http://127.0.0.1:${server.address().port}/`, {
  waitUntil: 'load',
  timeout: 60000,
});
await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
const out = await page.evaluate(() => window.__out);
await browser.close();
server.close();

let fail = 0;
const ok = (condition, message) =>
  condition ? console.log('ok ' + message) : (fail++, console.error('FAIL ' + message));
console.log('  result:', JSON.stringify(out));
ok(out.hasOccupancy, 'occupancy grid is available (non-vacuous)');
ok(out.prepassRuns === 1, 'flat opaque fill activates the depth prepass');
ok(out.movedPrepassRuns === 1, 'whole-bundle affine transform keeps the prepass eligible');
ok(out.recolorRuns === 0, 'per-draw recolor stays on the ordinary fill path');
ok(out.tinyPrepassRuns === 0, 'sub-pixel occupancy cells stay on the ordinary AA path');
ok(out.normal.max === 0, `normal prepass output matches ordinary fill (max ${out.normal.max})`);
ok(out.moved.max === 0, `transformed prepass output matches ordinary fill (max ${out.moved.max})`);
// one byte of float noise at a rounding boundary (see occupancyRenderDiffSmoke); the prepass and the ordinary fill run the same exact kernel
ok(
  out.tiny.max <= 1 && out.tiny.n <= 8,
  `downscaled output matches ordinary fill within one byte (max ${out.tiny.max}, n ${out.tiny.n})`,
);
if (fail) process.exit(1);
console.log('opaquePrepassSmoke: PASS');
