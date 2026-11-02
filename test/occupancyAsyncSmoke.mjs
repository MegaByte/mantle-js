// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// occupancyAsyncSmoke — the async interior-grid path (default-on).
//
// A default-on import RESERVES a zeroed occupancy region + descriptor but does
// NOT build the bits synchronously (bundle.hasOccupancy starts false). An idle
// pass after createBundle fills the grid and flips hasOccupancy on. Because the
// grid is purely additive (occSkip only collapses a walk that would return 1.0),
// every frame is pixel-identical — before activation, after activation, and vs a
// grid-off render. This proves first-draw-is-immediate + output-identity.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { emitFixture } from './_fixtures.mjs';
import { pageTimeoutFor } from './_laneBudget.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const N = 512;
// One big interior-heavy blob (a superellipse-ish path) covering most of the
// canvas → passes the area gate, plenty of interior to certify.
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}"><path fill="#c0392b" d="M256 40 C400 40 472 112 472 256 C472 400 400 472 256 472 C112 472 40 400 40 256 C40 112 112 40 256 40 Z"/></svg>`;
emitFixture('occupancyAsync__SVG', SVG);

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const N = ${N};
const until = async (pred, ms) => { const t0 = performance.now(); while (!pred() && performance.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10)); return pred(); };
const r = createRenderer(gl, shaders, {}); r.setLoopBlinnFill('off');
const grab = () => { const p = new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,p); return p; };
const draw = (b) => { r.setViewport(N,N); gl.viewport(0,0,N,N); r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame(); const s=new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,s); return grab(); };
const diff = (a,b) => { let mx=0,n=0; for(let i=0;i<a.length;i++){const d=Math.abs(a[i]-b[i]); if(d>mx)mx=d; if(d>0)n++;} return {mx, n:Math.round(n/4)}; };
window.__run = async () => {
  const secOff = await importSvg('${SVG.replace(/'/g, "\\'")}', { occupancyGrid: false });
  const secDef = await importSvg('${SVG.replace(/'/g, "\\'")}');   // default → async
  const bOff = createBundle(gl, secOff);
  const bDef = createBundle(gl, secDef);
  const hadPending = !!(secDef.pendingOccupancy && secDef.pendingOccupancy.length);
  const off = draw(bOff);
  const before = draw(bDef);                       // grid still dormant
  const hasBefore = !!bDef.hasOccupancy;
  // The idle pass is a worker round trip: wait for ITS completion flag (bundle._occupancyBuildPending drops when the
  // result lands or is discarded), not for a few frames and a fixed delay.
  await until(() => !bDef._occupancyBuildPending, ${pageTimeoutFor(120000)});
  const after = draw(bDef);                         // grid should be active now
  const hasAfter = !!bDef.hasOccupancy;
  return { hadPending, hasBefore, hasAfter, dOffBefore: diff(off, before), dOffAfter: diff(off, after), dBeforeAfter: diff(before, after) };
};
window.__ready = true;
</script></body></html>`;

const server = http.createServer((q, res) => {
  try {
    if (q.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(HTML);
      return;
    }
    const pp = decodeURIComponent(q.url.split('?')[0]);
    res.writeHead(200, { 'content-type': pp.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, pp)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const br = await launchBrowser({ headless: 'new', args: ['--no-sandbox'] });
const pg = await br.newPage();
pg.on('pageerror', (e) => console.error(' [err]', e.message));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 90000 });
await pg.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 50 });
const o = await pg.evaluate(() => window.__run());
await br.close();
server.close();

let fail = 0;
const ok = (c, m) => (c ? console.log('  ok ' + m) : (fail++, console.error('  FAIL ' + m)));
console.log('  result:', JSON.stringify(o));
ok(o.hadPending, 'default-on import produced a pending (async) occupancy grid');
ok(o.hasBefore === false, 'bundle.hasOccupancy starts FALSE (dormant, first draw immediate)');
ok(
  o.dOffBefore.mx === 0,
  `first draw (dormant) is pixel-identical to grid-off (max ${o.dOffBefore.mx})`,
);
ok(o.hasAfter === true, 'bundle.hasOccupancy flips TRUE after the idle fill');
ok(o.dOffAfter.mx === 0, `activated draw is pixel-identical to grid-off (max ${o.dOffAfter.mx})`);
ok(
  o.dBeforeAfter.mx === 0,
  `before/after activation are pixel-identical (max ${o.dBeforeAfter.mx})`,
);
console.log(fail ? `\nOCCUPANCY-ASYNC FAIL (${fail})` : '\nOCCUPANCY-ASYNC PASS');
process.exit(fail ? 1 : 0);
