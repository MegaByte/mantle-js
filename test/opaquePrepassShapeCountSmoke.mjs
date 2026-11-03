// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// opaquePrepassShapeCountSmoke -- the prepass depth (z = 1 - shape / numShapes, written by its own vertex program) must pass the fill's depth test
// (LEQUAL, its own vertex program) for every shape count: two programs that compute the same float can differ by an ulp, and the fill of a certified
// interior then loses LEQUAL to the prepass and the interior draws hollow (flipbook frames of 13 shapes, for one).
// Sweep every shape count 6..130, the shipped art's counts and a ladder to 4096 on the cover pass with the prepass requested: the output must be byte-identical to the ordinary fill, and the prepass must run.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { pageTimeoutFor } from './_laneBudget.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const N = 512;
const blob = (x, y, c) =>
  `<path fill="${c}" d="M ${x - 120} ${y} C ${x - 120} ${y - 150} ${x + 120} ${y - 150} ${x + 120} ${y} C ${x + 120} ${y + 150} ${x - 120} ${y + 150} ${x - 120} ${y} Z"/>`;
const svgOf = (n) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}">` +
  Array.from({ length: n }, (_, i) =>
    blob(256 + (i % 3) * 9, 256 + (i % 4) * 7, `hsl(${(i * 29) % 360},65%,${40 + (i % 5) * 3}%)`),
  ).join('') +
  `</svg>`;
// Every count 6..130, the shape counts of real-world art that engages the prepass (art with at least 512 certified occupancy cells), and a
// sparse ladder up to 4096.
const ART = [
  6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
  31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54,
  55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78,
  79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 92, 93, 94, 95, 96, 97, 99, 100, 101, 102, 103,
  106, 107, 108, 110, 112, 113, 115, 116, 117, 119, 120, 121, 122, 124, 125, 127, 130, 134, 137,
  138, 143, 144, 145, 146, 147, 149, 150, 151, 152, 154, 155, 156, 157, 159, 160, 162, 164, 168,
  172, 173, 174, 175, 180, 182, 189, 192, 200, 201, 238, 267, 278, 282, 286, 372, 410, 434, 462,
  702, 716, 735, 740, 833, 857, 863, 890, 922, 952, 960, 971, 990, 1023, 1650, 1764, 1770,
];
const COUNTS = [
  ...new Set([
    ...Array.from({ length: 125 }, (_, i) => 6 + i),
    ...ART,
    150,
    200,
    256,
    300,
    400,
    512,
    640,
    768,
    1024,
    1536,
    2048,
    4096,
  ]),
].sort((a, b) => a - b);
const SVGS = COUNTS.map(svgOf);

const HTML = `<!DOCTYPE html><canvas id="c" width="${N}" height="${N}"></canvas><script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias:false, depth:true, stencil:true, preserveDrawingBuffer:true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const r = createRenderer(gl, shaders, { opaquePrepass: true }); r.setViewport(${N}, ${N}); r.setLoopBlinnFill('off');
const id = new Float32Array([1,0,0, 0,1,0, 0,0,1]);
const cm = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
const grab = () => { const p = new Uint8Array(${N}*${N}*4); gl.readPixels(0,0,${N},${N},gl.RGBA,gl.UNSIGNED_BYTE,p); return p; };
const draw = (b, opts) => { r.beginFrame([1,1,1,1]); r.drawBundle(b, opts); r.endFrame(); return grab(); };
const rows = [];
for (const [n, svg] of ${JSON.stringify(COUNTS.map((n, i) => [n, SVGS[i]]))}) {
  const b = createBundle(gl, await importSvg(svg, { preserveViewport:true, occupancyGrid:{ grid:24 } }));
  const c0 = r.debugStats.opaquePrepassCount;
  const pre = draw(b, { worldMatrix:id });
  const runs = r.debugStats.opaquePrepassCount - c0;
  const ordinary = draw(b, { worldMatrix:id, colorMatrix:cm });
  let n2 = 0; for (let i = 0; i < pre.length; i += 4) if (pre[i] !== ordinary[i] || pre[i+1] !== ordinary[i+1] || pre[i+2] !== ordinary[i+2]) n2++;
  rows.push({ n, runs, diff: n2 });
  b.dispose && b.dispose();
}
window.__out = rows;
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
await page.waitForFunction(() => window.__ready === true, {
  timeout: pageTimeoutFor(280000),
  polling: 200,
});
const out = await page.evaluate(() => window.__out);
await browser.close();
server.close();

let fail = 0;
const ok = (condition, message) =>
  condition ? console.log('ok ' + message) : (fail++, console.error('FAIL ' + message));
const notEngaged = out.filter((r) => r.runs !== 1).map((r) => r.n);
const bad = out.filter((r) => r.diff > 0);
ok(
  notEngaged.length === 0,
  `the prepass runs once for every swept shape count (not engaged: ${notEngaged.join(',') || 'none'})`,
);
ok(
  bad.length === 0,
  `prepass output is byte-identical to the ordinary fill for every shape count (differs at: ${bad.map((r) => r.n + ':' + r.diff + 'px').join(' ') || 'none'})`,
);
if (fail) process.exit(1);
console.log('opaquePrepassShapeCountSmoke: PASS');
