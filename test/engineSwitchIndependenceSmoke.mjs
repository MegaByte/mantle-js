// engineSwitchIndependenceSmoke — what an engine draws must not depend on WHAT YOU DREW BEFORE.
//
// This is the general form of a bug that shipped: the off-thread LB builder was registered through
// a module-level singleton, so the LAST renderer created owned it — and the moment that renderer
// was Slug-only (which is every non-LB engine: AAC, GWN, hard), no bundle created afterwards ever
// got Loop-Blinn meshes. In the demo: pick LB, it works; pick AAC; pick LB again — declined, for
// the rest of the session.
//
// Greping for singletons only finds the ones you already know about. So assert the INVARIANT
// instead: render every engine in one order, then in another, and require identical pixels. Any
// state that leaks between renderers — a hook one of them stole, a cache another poisoned, a global
// the last writer won — shows up here as a mismatch, whatever its mechanism.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { emitFixture } from './_fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const N = 200;

// A ring (even-odd hole: LB meshes it, GWN needs its tree) plus a straight-edged shape.
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
  <path fill="#3366cc" fill-rule="evenodd" d="M 150 90 C 150 56.86 123.14 30 90 30 C 56.86 30 30 56.86 30 90 C 30 123.14 56.86 150 90 150 C 123.14 150 150 123.14 150 90 Z M 120 90 C 120 73.43 106.57 60 90 60 C 73.43 60 60 73.43 60 90 C 60 106.57 73.43 120 90 120 C 106.57 120 120 106.57 120 90 Z"/>
  <path fill="#cc3333" d="M 140 160 L 190 160 L 165 195 Z"/>
</svg>`;
emitFixture('engineSwitchIndependence__SVG', SVG);

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
globalThis.__MANTLE_DEBUG__ = true;
globalThis.__MANTLE_NO_STATIC_CACHE = true;
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias:false, premultipliedAlpha:true, preserveDrawingBuffer:true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const N = ${N}, SVG = ${JSON.stringify(SVG)};

// Each engine as an app would build it: its own renderer, its own bundle (an engine can need
// different IMPORT options — GWN's run tree is baked by the importer, not the shader).
const ENGINES = {
  slug: [{},                                                   {},                 'off'],
  lb:   [{},                                                   {},                 'on'],
  aac:  [{ aacFill: true },                                    {},                 'off'],
  gwn:  [{ fillDefines: ['MANTLE_GWN','MANTLE_GWN_SDF'] },     { gwnTree: true },  'off'],
  hard: [{ fillDefines: ['MANTLE_HARD','MANTLE_GWN'] },        {},                 'off'],
};
// Renderers are CACHED per engine and kept alive, which is what an app (and this repo's demo) does
// — a renderer is expensive, so you build one per engine and switch between them. That is also what
// makes the bug reachable: the second renderer only steals the module-level LB hook if it is still
// alive when the next bundle is created. An earlier version of this smoke disposed each renderer
// after drawing, so only one ever existed, the singleton was always the current one, and the test
// passed on the broken build. It was measuring nothing.
const _cache = {};
async function draw(eng) {
  const [rOpts, impOpts, lbMode] = ENGINES[eng];
  const r = _cache[eng] || (_cache[eng] = createRenderer(gl, shaders, rOpts));
  r.setLoopBlinnFill(lbMode);
  const b = createBundle(gl, await importSvg(SVG, impOpts));
  if (lbMode !== 'off' && r.awaitLbReady) await r.awaitLbReady(b);   // NB: no prepareBundle — apps rely on the auto-build
  const c0 = r.debugStats.loopBlinnRouteCount;
  r.setViewport(N,N); r.beginFrame([1,1,1,1]); r.drawBundle(b, {}); r.endFrame();
  const routed = r.debugStats.loopBlinnRouteCount - c0;
  const px = new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,px);
  let ink = 0, h = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i+3] > 8 && (px[i] < 245 || px[i+1] < 245 || px[i+2] < 245)) ink++;
    h = (h * 31 + px[i]) >>> 0;
  }
  b.dispose();                                  // the RENDERER stays alive — see above
  return { ink, hash: h, routed, px: Array.from(px) };
}
const ORDER_A = ['slug','lb','aac','gwn','hard','lb'];   // LB, then others, then LB AGAIN
const ORDER_B = ['gwn','hard','aac','lb','slug','lb'];   // a different history entirely
const runA = {}, runB = {};
for (const e of ORDER_A) runA[e] = await draw(e);         // later visits overwrite: the LAST LB is what we keep
for (const e of ORDER_B) runB[e] = await draw(e);
window.__out = { runA, runB };
window.__ready = true;
</script></body></html>`;

const server = http.createServer((q, res) => {
  try {
    if (q.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); return; }
    const pp = decodeURIComponent(q.url.split('?')[0]);
    res.writeHead(200, { 'content-type': pp.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, pp)));
  } catch { if (!res.headersSent) res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const br = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const pg = await br.newPage();
pg.on('pageerror', (e) => console.error(' [err]', e.message));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 90000 });
// Interval polling: the default raf-based poll can stall in headless runs
// (the page finishes but rAF never fires), timing out a passing test.
await pg.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 250 });
const { runA, runB } = await pg.evaluate(() => window.__out);
await br.close(); server.close();

let fail = 0;
const ok = (c, m) => c ? console.log('  ok ' + m) : (fail++, console.error('  FAIL ' + m));

console.log('  engine   order A (ink/routed)   order B (ink/routed)');
for (const e of Object.keys(runA))
  console.log(`  ${e.padEnd(8)} ${String(runA[e].ink).padStart(7)} / ${runA[e].routed}          ${String(runB[e].ink).padStart(7)} / ${runB[e].routed}`);

for (const e of Object.keys(runA)) {
  const A = runA[e].px, B = runB[e].px;
  let nd = 0, mx = 0;
  for (let i = 0; i < A.length; i++) { const d = Math.abs(A[i]-B[i]); if (d > 0) nd++; if (d > mx) mx = d; }
  console.log(`  ${e}: ${nd} of ${A.length} bytes differ between the two orders (max delta ${mx})`);
  ok(runA[e].ink > 0, `${e} renders something (ink=${runA[e].ink})`);
  // THE INVARIANT: same engine, same asset, different history ⇒ the same PICTURE.
  //
  // Not bit-equality. AAC and GWN come back with ~20 bytes off by exactly 1 (of 160,000): the two
  // runs compile their own program objects, and the driver is free to reassociate float maths
  // differently between them. That is a single LSB and it is not a state leak. A leak — a hook one
  // renderer stole, a cache another poisoned — changes which ENGINE drew a shape, and that moves
  // whole edges, not one bit. So bound the delta, and bound how much of the image may move at all.
  ok(mx <= 1, `${e} draws the same regardless of which engines ran before it (max delta ${mx}, LSB noise only)`);
  ok(nd < A.length * 0.001, `${e}: at most a trace of the image differs across orders (${nd} bytes)`);
}
// The specific casualty of the singleton bug: LB visited AFTER a Slug-only renderer must still route.
ok(runA.lb.routed > 0, 'LB still ROUTES when visited after AAC/GWN/hard (the builder-ownership bug)');
ok(runB.lb.routed > 0, 'LB still ROUTES when other engines ran first (reverse order)');

console.log(fail ? `\nENGINE-SWITCH-INDEPENDENCE FAIL (${fail})` : '\nENGINE-SWITCH-INDEPENDENCE PASS');
process.exit(fail ? 1 : 0);
