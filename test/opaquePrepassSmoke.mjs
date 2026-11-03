// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// opaquePrepassSmoke -- certified opaque interiors may populate depth, but the
// visible result must remain byte-identical to the ordinary analytic fill: one
// bundle, moved, scaled below the cell gate, and three different bundles drawn
// in every frame (each with its own prepass mesh, kept across frames).
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
// a different bundle per k: the same blobs shifted and recolored
const svgOf = (k) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}">` +
  Array.from({ length: 12 }, (_, i) =>
    blob(
      256 + ((i + k) % 3) * 9,
      256 + ((i + k) % 4) * 7,
      `hsl(${(i * 29 + k * 47) % 360},65%,${44 + k * 3}%)`,
    ),
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
const hash = (p) => { let h = 2166136261 >>> 0; for (let i = 0; i < p.length; i++) { h ^= p[i]; h = Math.imul(h, 16777619) >>> 0; } return h.toString(16); };
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
const bs = [];
for (const text of ${JSON.stringify([1, 2, 3].map(svgOf))}) bs.push(createBundle(gl, await importSvg(text, { preserveViewport:true, occupancyGrid:{ grid:24 } })));
while (bs.some((x) => x._occlusionCullPending)) await new Promise((res) => setTimeout(res, 10)); // (the cull lands before the frames compared)
// (at three quarters of full size: much smaller blobs draw as AAC points, which never reach the cover pass)
const place = [[-0.2,0.15],[0.2,0.1],[0.0,-0.15]].map(([x,y]) => new Float32Array([0.75,0,0, 0,0.75,0, x,y,1]));
const drawAll = (opts) => { r.beginFrame([1,1,1,1]); bs.forEach((x, i) => r.drawBundle(x, { worldMatrix:place[i], ...opts })); r.endFrame(); return grab(); };
const runs = []; let at = r.debugStats.opaquePrepassCount;
const tick = () => { const n = r.debugStats.opaquePrepassCount; runs.push(n - at); at = n; };
const multi1 = drawAll({}); tick();
const multi2 = drawAll({}); tick();
const multiOrdinary = drawAll({ colorMatrix:cm }); tick();
window.__out = { hasOccupancy:b.hasOccupancy, prepassRuns:afterPre-before, movedPrepassRuns:afterMovedPre-afterPre, recolorRuns:afterOrdinary-afterMovedPre, tinyPrepassRuns:afterTinyPre-afterOrdinary, normal:diff(pre,ordinary), moved:diff(movedPre,movedOrdinary), tiny:diff(tinyPre,tinyOrdinary),
  multiRuns:runs, multiFirst:diff(multi1,multiOrdinary), multiKept:diff(multi2,multiOrdinary),
  hashes:{ pre:hash(pre), moved:hash(movedPre), tiny:hash(tinyPre), multi:hash(multi2) } };
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
ok(
  out.multiRuns.join() === '3,3,0',
  `three bundles per frame run three prepasses per frame, none under a recolor (${out.multiRuns.join()})`,
);
ok(
  out.multiFirst.max === 0 && out.multiKept.max === 0,
  `three bundles' prepass output matches ordinary fill, on the frame that uploads their meshes and the next (max ${out.multiFirst.max}, ${out.multiKept.max})`,
);
if (fail) process.exit(1);
console.log('opaquePrepassSmoke: PASS');
