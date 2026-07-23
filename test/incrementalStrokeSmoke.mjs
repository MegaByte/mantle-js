// incrementalStrokeSmoke.mjs — the dynamic paint-stroke path (incrementalStroke.js).
//
//   1. INCREMENTAL == WHOLE: a stroke appended point-by-point with draws
//      interleaved (exercising the partial prim-row texSubImage2D uploads, the
//      vert-tail bufferSubData, the join patches and the texture realloc)
//      renders BYTE-IDENTICAL to the same polyline handed to
//      createIncrementalStroke in one call.
//   2. PARITY vs LOADED-WHOLE: the appended stroke matches a full
//      importSvg→createBundle render of the same polyline (round caps/joins)
//      within AA tolerance — the "loaded whole" reference is the default
//      (Slug) stroke route vectorPaint renders through today.
//   3. handle.draw (the engine's mount path) matches drawBundle byte-for-byte.
//   4. A single point renders a round-cap dot; alpha modulates the composite.
//   5. PERF: append cost is O(1) per point — appending the LAST 1000 points of
//      a 6000-point stroke costs no more than a few× the SECOND 1000 (per-point
//      re-tessellation of the whole stroke would be ~5-10×).
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { emitFixture } from './_fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const W = 200, H = 200;
const PTS = [[30, 40], [80, 60], [60, 120], [140, 100], [170, 160], [120, 170]];
const COLOR = [0.8, 0.15, 0.1, 1];
const WIDTH = 12;

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <path d="M${PTS.map(p => p.join(' ')).join('L')}" fill="none" stroke="rgba(204,38,26,1)" stroke-width="${WIDTH}" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
emitFixture('incrementalStroke__SVG', SVG);

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="${W}" height="${H}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
const PTS = ${JSON.stringify(PTS)};
const COLOR = ${JSON.stringify(COLOR)};
const BBOX = [0, 0, ${W}, ${H}];

const clear = () => { renderer.setViewport(${W}, ${H}); renderer.beginFrame([0, 0, 0, 1]); };
const readAll = () => { const px = new Uint8Array(${W * H * 4}); gl.readPixels(0, 0, ${W}, ${H}, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };

// ── 1. incremental (interleaved draws) vs whole-at-once ──────────────
const inc = renderer.createIncrementalStroke({ color: COLOR, width: ${WIDTH}, bbox: BBOX });
// Dense polyline: resample PTS into ~300 points so the prim texture crosses
// row boundaries (512 texels/row, 6/seg) and the realloc path runs.
const dense = [];
for (let i = 0; i + 1 < PTS.length; i++) {
  const [ax, ay] = PTS[i], [bx, by] = PTS[i + 1];
  for (let k = 0; k < 60; k++) dense.push([ax + (bx - ax) * k / 60, ay + (by - ay) * k / 60]);
}
dense.push(PTS[PTS.length - 1]);
for (let i = 0; i < dense.length; i += 10) {
  inc.appendPoints(dense.slice(i, i + 10));
  clear(); renderer.drawBundle(inc.bundle, {}); renderer.endFrame();   // interleaved partial uploads
}
clear(); renderer.drawBundle(inc.bundle, {}); renderer.endFrame();
const pxInc = readAll();

const whole = renderer.createIncrementalStroke({ color: COLOR, width: ${WIDTH}, bbox: BBOX, points: dense });
clear(); renderer.drawBundle(whole.bundle, {}); renderer.endFrame();
const pxWhole = readAll();
let diffIncWhole = 0;
for (let i = 0; i < pxInc.length; i++) if (pxInc[i] !== pxWhole[i]) diffIncWhole++;

// ── 2. parity vs the polyline loaded whole (importSvg → default route) ──
// preserveViewport pins globalBBox to the viewBox — the vectorPaint loadSvg
// configuration, and the same mapping as the incremental stroke's pinned bbox.
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)}, { preserveViewport: true }));
renderer.prepareBundle(bundle);
clear(); renderer.drawBundle(bundle, {}); renderer.endFrame();
const pxRef = readAll();
// Sparse-vertex incremental stroke of the SAME 6 points (the reference SVG's
// own vertices — dense resampling is geometrically identical but AA-dithers).
const sparse = renderer.createIncrementalStroke({ color: COLOR, width: ${WIDTH}, bbox: BBOX, points: PTS });
clear(); renderer.drawBundle(sparse.bundle, {}); renderer.endFrame();
const pxSparse = readAll();
let inkRef = 0, inkInc = 0, hardDiff = 0, sumDiff = 0, cmpN = 0;
for (let i = 0; i < ${W * H}; i++) {
  const o = i * 4;
  const refInk = pxRef[o] > 20, incInk = pxSparse[o] > 20;
  if (refInk) inkRef++;
  if (incInk) inkInc++;
  const d = Math.abs(pxSparse[o] - pxRef[o]);
  sumDiff += d; cmpN++;
  if (d > 64) hardDiff++;   // strong disagreement (beyond AA dither)
}
const meanDiff = +(sumDiff / cmpN).toFixed(3);

// ── 3. handle.draw (engine mount path) == drawBundle ─────────────────
const handle = renderer.createBundleHandle(sparse.bundle);
clear(); handle.draw({}); renderer.endFrame();
const pxHandle = readAll();
let diffHandle = 0;
for (let i = 0; i < pxSparse.length; i++) if (pxHandle[i] !== pxSparse[i]) diffHandle++;
handle.dispose();

// ── 4. dot + alpha ────────────────────────────────────────────────────
const dot = renderer.createIncrementalStroke({ color: [0, 0.5, 1, 1], width: 20, bbox: BBOX, points: [[100, 100]] });
clear(); renderer.drawBundle(dot.bundle, {}); renderer.endFrame();
const pxDot = readAll();
const at = (px, x, yTop) => px[((${H - 1} - yTop) * ${W} + x) * 4 + 2];   // blue channel
const dotCenter = at(pxDot, 100, 100), dotOut = at(pxDot, 100, 116), dotIn = at(pxDot, 100, 106);
clear(); renderer.drawBundle(dot.bundle, { alpha: 0.5 }); renderer.endFrame();
const dotHalf = at(readAll(), 100, 100);

// ── 5. perf: append cost must not scale with stroke length ───────────
const perf = renderer.createIncrementalStroke({ color: COLOR, width: 4, bbox: BBOX });
const chunkMs = [];
let px9 = 10, py9 = 10;
for (let c = 0; c < 6; c++) {
  const t0 = performance.now();
  for (let i = 0; i < 1000; i++) {
    px9 += Math.sin(i * 0.37) * 0.9; py9 += Math.cos(i * 0.29) * 0.9;
    perf.appendPoints([[px9, py9]]);
  }
  chunkMs.push(performance.now() - t0);
}
perf.flush();
clear(); renderer.drawBundle(perf.bundle, {}); renderer.endFrame();
const perfDrew = readAll().some((v, i) => (i & 3) === 0 && v > 0);
// Compare MIN of the late chunks against MIN of the early chunks (skipping
// chunk 0's JIT warmup; min-of-two shrugs off a stray GC spike). O(1) per
// append keeps late chunks flat; O(total) per append makes them ~5-10×.
const early = Math.max(Math.min(chunkMs[1], chunkMs[2]), 0.05);
const late = Math.min(chunkMs[4], chunkMs[5]);
const perfRatio = +(late / early).toFixed(2);

const fin = sparse.finalize();
window.__out = {
  diffIncWhole, meanDiff, hardDiff, inkRef, inkInc, diffHandle,
  dotCenter, dotIn, dotOut, dotHalf,
  chunkMs: chunkMs.map(v => +v.toFixed(2)), perfRatio, perfDrew,
  finalizeHasPath: /^M30 40L80 60/.test(fin.pathD), finalizeHasSvg: fin.svg.includes('stroke-linecap="round"'),
  segs: sparse.segmentCount, drawCount: sparse.drawCount,
};
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  try {
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(HTML); return; }
    const p = decodeURIComponent(req.url.split('?')[0]);
    res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' }); res.end(readFileSync(path.join(ROOT, p)));
  } catch { if (!res.headersSent) res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => { failures++; console.error('FAIL: ' + m); };

const browser = await puppeteer.launch({ headless: 'new', args: ['--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage();
page.on('pageerror', e => console.error('  [page-err]', e.message));
page.on('console', m => { if (m.type() === 'error') console.error('  [console]', m.text()); });
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 20000 });
  await page.waitForFunction(() => window.__ready === true, { timeout: 30000 });
} catch (e) { fail('setup: ' + e.message); await browser.close(); server.close(); process.exit(1); }

const out = await page.evaluate(() => window.__out);
console.log('  stats:', JSON.stringify(out));

// 1. incremental uploads == whole-at-once, byte-identical.
if (out.diffIncWhole === 0) ok('incremental (interleaved draws) == whole-at-once: byte-identical');
else fail(`incremental vs whole differ in ${out.diffIncWhole} bytes`);

// 2. parity vs the loaded-whole reference (AA tolerance).
if (out.inkRef > 2000) ok(`reference stroke has ink (${out.inkRef}px)`);
else fail(`reference stroke barely rendered (${out.inkRef}px)`);
const inkRel = Math.abs(out.inkInc - out.inkRef) / out.inkRef;
if (inkRel < 0.04) ok(`ink coverage matches loaded-whole within 4% (${(inkRel * 100).toFixed(2)}%)`);
else fail(`ink coverage off by ${(inkRel * 100).toFixed(2)}% (inc ${out.inkInc} vs ref ${out.inkRef})`);
if (out.hardDiff < out.inkRef * 0.03) ok(`hard pixel disagreements ${out.hardDiff} < 3% of ink`);
else fail(`too many hard pixel disagreements: ${out.hardDiff} (ink ${out.inkRef})`);
if (out.meanDiff < 3) ok(`mean |diff| ${out.meanDiff} < 3`);
else fail(`mean |diff| too high: ${out.meanDiff}`);

// 3. handle.draw parity.
if (out.diffHandle === 0) ok('handle.draw == drawBundle: byte-identical');
else fail(`handle.draw differs in ${out.diffHandle} bytes`);

// 4. dot + alpha.
if (out.dotCenter > 200 && out.dotIn > 200 && out.dotOut < 30) ok(`single point renders a round dot (center ${out.dotCenter}, r8 ${out.dotIn}, r16 ${out.dotOut})`);
else fail(`dot wrong: center ${out.dotCenter}, in ${out.dotIn}, out ${out.dotOut}`);
if (out.dotHalf > out.dotCenter * 0.35 && out.dotHalf < out.dotCenter * 0.65) ok(`alpha 0.5 modulates composite (${out.dotHalf} vs ${out.dotCenter})`);
else fail(`alpha 0.5 composite off: ${out.dotHalf} vs full ${out.dotCenter}`);

// 5. perf scaling.
if (out.perfDrew) ok('6000-point stroke draws');
else fail('6000-point stroke rendered nothing');
if (out.perfRatio < 3.5) ok(`append cost flat: last-1000/second-1000 chunk ratio ${out.perfRatio} < 3.5 (${out.chunkMs.join(', ')}ms)`);
else fail(`append cost scales with stroke length: chunk ratio ${out.perfRatio} (${out.chunkMs.join(', ')}ms)`);

// finalize surface.
if (out.finalizeHasPath && out.finalizeHasSvg && out.segs === 5 && out.drawCount > 0) ok('finalize() returns pathD + svg; segment/draw counts sane');
else fail(`finalize surface wrong: ${JSON.stringify({ p: out.finalizeHasPath, s: out.finalizeHasSvg, segs: out.segs, dc: out.drawCount })}`);

await browser.close();
server.close();
if (failures) { console.error(`\n${failures} FAILURE(S)`); process.exit(1); }
console.log('\nINCREMENTAL-STROKE SMOKE PASS');
