// nineSliceInstanceSmoke.mjs — per-DRAW nine-slice instances.
//
// bundle.nineSliceInstance({border, worldSize}) returns a lightweight
// bundle view that carries its OWN rewritten cover-quad mesh + globalBBox
// while sharing every heavy GL resource with the base by prototype. Two
// instances of ONE base bundle must render at DIFFERENT world sizes with
// undistorted corners — simultaneously, each through its own persistent
// handle — and the base must stay un-sliced.
//
// Fixture: 100×50 em, red field + blue 10×10 top-left corner patch.
// Border [10,10,10,10]. Nine-slice keeps the blue patch 10 em square in
// EVERY target size; naive stretching would scale it with the target.
//
// Assertions (px sampled from the canvas, em→px scale = canvas/target):
//   base (100×50 on 400×200 → 4 px/em):  blue at px(30,10) [em 7.5]
//   instA (200×100 → 2 px/em): blue at px(10,10) [em 5], RED at px(30,10)
//     [em 15 — naive 2× stretch would still be blue there]
//   instB (400×200 → 1 px/em): blue at px(5,5), RED at px(15,5)
//   instA re-drawn AFTER instB: unchanged (no shared-mesh clobber — the
//     regression the per-instance API exists to fix)
//   structure: shared curveTex/metaTex identity, distinct coverQuadFloats,
//     base mesh floats untouched, base._nineSliceActive falsy
//   re-slice: instA.applyNineSlice({worldSize: [300,150]}) re-renders
//     through the SAME handle (gen bump → auto re-upload)

import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function mime(p) {
  if (p.endsWith('.html')) return 'text/html; charset=utf-8';
  if (p.endsWith('.js') || p.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (p.endsWith('.glsl')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(u.pathname === '/' ? '/mantleDemo.html' : u.pathname);
  try { res.writeHead(200, { 'content-type': mime(p) }); res.end(readFileSync(path.join(ROOT, p))); }
  catch { try { res.writeHead(404); res.end(); } catch {} }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const url  = `http://127.0.0.1:${port}/mantleDemo.html`;

const SVG = readFileSync(new URL('../examples/smoke/nineSliceInstance__SVG.svg', import.meta.url), 'utf8');

let failures = 0;
const fail = (m) => { failures++; console.error('FAIL', m); };
const ok   = (m) => console.log('ok', m);

const browser = await puppeteer.launch({
  headless: 'new', args: ['--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 400, height: 200 });
page.on('pageerror', e => console.error('  [page-err]', e.message));
await page.goto(url, { waitUntil: 'load', timeout: 10000 });
await page.waitForFunction(() => window.__mantleRenderer && window.__mantleGl, { timeout: 10000 });

const results = await page.evaluate(async (svg) => {
  const { importSvg, createBundle } = await import('/src/index.js');
  const gl = window.__mantleGl;
  const renderer = window.__mantleRenderer;
  const cnv = document.getElementById('glcanvas');
  cnv.width = 400; cnv.height = 200;
  renderer.setViewport(400, 200);

  const base = createBundle(gl, await importSvg(svg));
  if (typeof base.nineSliceInstance !== 'function') {
    return { error: 'bundle.nineSliceInstance is not a function' };
  }

  const baseFloatsBefore = Array.from(base.coverQuadFloats.slice(0, 24));
  const baseChunksBefore = base.coverQuadChunks.map(c => c.count).join(',');

  const border = [10, 10, 10, 10];
  const instA = base.nineSliceInstance({ border, worldSize: [200, 100] });
  const instB = base.nineSliceInstance({ border, worldSize: [400, 200] });

  const structure = {
    shareCurveTex: instA.curveTex === base.curveTex && instB.curveTex === base.curveTex,
    shareMetaTex:  instA.metaTex === base.metaTex,
    ownMesh: instA.coverQuadFloats !== base.coverQuadFloats
          && instB.coverQuadFloats !== base.coverQuadFloats
          && instA.coverQuadFloats !== instB.coverQuadFloats,
    baseUnsliced: !base._nineSliceActive,
    instActive: !!instA._nineSliceActive && !!instB._nineSliceActive,
    baseFloatsUntouched: Array.from(base.coverQuadFloats.slice(0, 24))
      .every((v, i) => v === baseFloatsBefore[i]),
    baseChunksUntouched: base.coverQuadChunks.map(c => c.count).join(',') === baseChunksBefore,
    instBBoxA: instA.globalBBox.slice(),
    instBBoxB: instB.globalBBox.slice(),
    baseBBox: base.globalBBox.slice(),
  };

  const hBase = renderer.createBundleHandle(base);
  const hA = renderer.createBundleHandle(instA);
  const hB = renderer.createBundleHandle(instB);

  // Sample px at (x, yFromTop) — readPixels is bottom-up.
  const px = (x, yTop) => {
    const buf = new Uint8Array(4);
    gl.readPixels(x, cnv.height - 1 - yTop, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return [buf[0], buf[1], buf[2]];
  };
  const frame = (h) => {
    renderer.beginFrame([1, 1, 1, 1]);
    h.draw();
    renderer.endFrame();
  };

  frame(hBase);
  const basePx = { corner: px(30, 10), far: px(390, 10) };

  frame(hA);
  const aPx = { blue: px(10, 10), pastCorner: px(30, 10), far: px(390, 10) };

  frame(hB);
  const bPx = { blue: px(5, 5), pastCorner: px(15, 5), far: px(395, 5) };

  // Redraw A AFTER B — per-instance meshes must not clobber each other.
  frame(hA);
  const aAgainPx = { blue: px(10, 10), pastCorner: px(30, 10) };

  // Re-slice instA to a new worldSize through the SAME handle. Target
  // 300×150 em on the 400×200 canvas → 4/3 px/em; blue spans px 0..13,
  // so px(30,10) (em 22.5) is red and px(6,6) (em 4.5) is blue.
  instA.applyNineSlice({ border, worldSize: [300, 150] });
  frame(hA);
  const aResizedPx = { blue: px(6, 6), pastCorner: px(30, 10) };

  hBase.dispose(); hA.dispose(); hB.dispose();
  instA.dispose(); instB.dispose();
  base.dispose();

  return { structure, basePx, aPx, bPx, aAgainPx, aResizedPx };
}, SVG);

await browser.close();
server.close();

if (results.error) { fail(results.error); process.exit(1); }

const s = results.structure;
if (s.shareCurveTex && s.shareMetaTex) ok('instances share curveTex/metaTex with base');
else fail(`texture sharing: ${JSON.stringify(s)}`);
if (s.ownMesh) ok('each instance owns a distinct cover-quad mesh');
else fail('instances do not own distinct meshes');
if (s.baseUnsliced && s.baseFloatsUntouched && s.baseChunksUntouched)
  ok('base bundle stays un-sliced and un-mutated');
else fail(`base mutated: ${JSON.stringify(s)}`);
if (s.instActive) ok('instances carry _nineSliceActive');
else fail('instances missing _nineSliceActive');
const bb = (a, e) => a.length === 4 && a.every((v, i) => Math.abs(v - e[i]) < 1e-4);
if (bb(s.instBBoxA, [0, 0, 200, 100]) && bb(s.instBBoxB, [0, 0, 400, 200]) && bb(s.baseBBox, [0, 0, 100, 50]))
  ok('per-instance globalBBox = target rect; base keeps native bbox');
else fail(`bboxes: A=${s.instBBoxA} B=${s.instBBoxB} base=${s.baseBBox}`);

function expectColor(actual, expected, label) {
  const d = actual.map((v, i) => Math.abs(v - expected[i]));
  if (d.some(x => x > 24)) fail(`${label}: got (${actual}), expected ~(${expected})`);
  else ok(`${label}: (${actual}) ≈ (${expected})`);
}

const RED = [255, 0, 0], BLUE = [0, 0, 255];
expectColor(results.basePx.corner,      BLUE, 'base un-sliced: px(30,10) [em 7.5] is blue');
expectColor(results.basePx.far,         RED,  'base un-sliced: far edge red');
expectColor(results.aPx.blue,           BLUE, 'instA 200×100: corner patch blue at px(10,10) [em 5]');
expectColor(results.aPx.pastCorner,     RED,  'instA 200×100: px(30,10) [em 15] red — corner NOT stretched');
expectColor(results.aPx.far,            RED,  'instA 200×100: far edge red');
expectColor(results.bPx.blue,           BLUE, 'instB 400×200: corner patch blue at px(5,5) [em 5]');
expectColor(results.bPx.pastCorner,     RED,  'instB 400×200: px(15,5) [em 15] red — corner NOT stretched');
expectColor(results.bPx.far,            RED,  'instB 400×200: far edge red');
expectColor(results.aAgainPx.blue,      BLUE, 'instA redrawn after instB: corner still blue');
expectColor(results.aAgainPx.pastCorner,RED,  'instA redrawn after instB: still un-stretched (no cross-instance clobber)');
expectColor(results.aResizedPx.blue,    BLUE, 'instA re-sliced 300×150 via same handle: corner blue at px(6,6)');
expectColor(results.aResizedPx.pastCorner, RED, 'instA re-sliced 300×150: px(30,10) [em 22.5] red');

if (failures) {
  console.error(`\nNINE-SLICE-INSTANCE FAIL (${failures})`);
  process.exit(1);
}
console.log('\nNINE-SLICE-INSTANCE PASS');
