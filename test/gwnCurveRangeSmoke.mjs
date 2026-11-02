// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// gwnCurveRangeSmoke — a shape's curve range must END at its curves, not at the GWN run tree.
//
// The tree's PIECE RECORDS are appended to the same curve buffer, right after each shape's curves.
// A range inferred as "up to the next shape's begin, else the end of the buffer" would, with
// importSvg({gwnTree:true}), swallow the tree as well: one tiger claw's [4,76) of real curves
// would become [4,432).
//
// Everything that reads a shape's geometry BY RANGE would then read the tree as if it were curves.
// The Loop-Blinn builder does, and on that garbage it does not come back — so prepareBundle(),
// which builds LB meshes synchronously on the main thread, would never return: a GWN render
// freezes rather than fails.
//
// Two assertions, because either alone would be easy to satisfy the wrong way: the RANGE must not
// change when a tree is requested, and prepareBundle must actually RETURN.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { emitFixture } from './_fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// A real tiger claw, lifted from examples/tiger.svg — near-degenerate cubics, which is what makes
// the LB builder choke on the tree records rather than merely producing nonsense.
const D =
  'm-122.3,84.285s0.1,1.894-0.73,1.875c-0.82-0.019-17.27-48.094-37.8-45.851,0,0,17.78-7.353,38.53,43.976z';
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-180 0 200 200" width="400" height="400"><path fill="#c8752a" d="${D}"/></svg>`;
emitFixture('gwnCurveRange__CLAW', SVG);

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="300" height="300"></canvas>
<script type="module">
globalThis.__MANTLE_DEBUG__ = true;
globalThis.__MANTLE_NO_STATIC_CACHE = true;
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias:false, premultipliedAlpha:true, preserveDrawingBuffer:true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const SVG = ${JSON.stringify(SVG)};

const plain = await importSvg(SVG, { nativeArcs: true });
const treed = await importSvg(SVG, { nativeArcs: true, gwnTree: true });
const rng = (s) => s.curveRangesByShape.map(r => [r.begin, r.end]);

// prepareBundle builds the LB meshes SYNCHRONOUSLY. If the range is wrong it never returns, so this
// is the assertion — the timing is only how we report it.
const r = createRenderer(gl, shaders, { fillDefines: ['MANTLE_GWN','MANTLE_GWN_SDF'] });
r.setLoopBlinnFill('off');
const b = createBundle(gl, treed);
const t0 = performance.now();
r.prepareBundle(b);
const prepMs = performance.now() - t0;

r.setViewport(300,300); r.beginFrame([1,1,1,1]); r.drawBundle(b, {}); r.endFrame();
const px = new Uint8Array(300*300*4); gl.readPixels(0,0,300,300,gl.RGBA,gl.UNSIGNED_BYTE,px);
let ink = 0;
for (let i = 0; i < px.length; i += 4) if (px[i+3] > 8 && (px[i] < 245 || px[i+1] < 245 || px[i+2] < 245)) ink++;

window.__out = {
  plainRange: rng(plain), treedRange: rng(treed),
  curvesPlain: plain.curves ? plain.curves.length : -1,
  curvesTreed: treed.curves ? treed.curves.length : -1,
  prepMs: Math.round(prepMs), ink,
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
// A 30s ceiling IS the stall assertion: the broken build never resolves here.
const ok0 = await pg
  .waitForFunction(() => window.__ready === true, { timeout: 30000, polling: 100 })
  .then(() => true)
  .catch(() => false);
const o = ok0 ? await pg.evaluate(() => window.__out) : null;
await br.close();
server.close();

let fail = 0;
const ok = (c, m) => (c ? console.log('  ok ' + m) : (fail++, console.error('  FAIL ' + m)));

if (!o) {
  console.error(
    '  FAIL prepareBundle never returned — the LB builder is reading the GWN tree as curves',
  );
  console.log('\nGWN-CURVE-RANGE FAIL (1)');
  process.exit(1);
}
console.log(`  curve range without a tree: ${JSON.stringify(o.plainRange)}`);
console.log(
  `  curve range WITH a tree   : ${JSON.stringify(o.treedRange)}   (prepareBundle ${o.prepMs} ms)`,
);

ok(
  JSON.stringify(o.plainRange) === JSON.stringify(o.treedRange),
  "asking for a GWN tree does not change the shape's CURVE range",
);
ok(
  o.prepMs < 2000,
  `prepareBundle returns (${o.prepMs} ms) — it built LB meshes from curves, not from tree records`,
);
ok(o.ink > 100, `and the shape still renders under GWN (ink=${o.ink})`);

console.log(fail ? `\nGWN-CURVE-RANGE FAIL (${fail})` : '\nGWN-CURVE-RANGE PASS');
process.exit(fail ? 1 : 0);
