// nativeMorphPerfSmoke.mjs — quantifies the morph hot-path cost of the
// native fallback reconciler. Morph re-applies a `d` (and friends) to the
// SAME shapes every frame; the reconciler must do that WITHOUT a per-shape
// querySelector tree-walk and WITHOUT redundant DOM writes, or frames drop.
//
// We instrument the cloned subtree's Element prototype to COUNT
// setAttribute / removeAttribute calls and the scene <svg>'s querySelectorAll
// calls, then drive a multi-shape morph for many frames and assert:
//   • querySelectorAll runs O(1) total (id index built once), not per frame.
//   • a CHANGING morph costs ~1 setAttribute per shape per frame (the new
//     `d`), not 2 (revert-then-set).
//   • a PAUSED morph (same `d` re-applied) costs ZERO writes (value diff).
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { emitFixture } from './_fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// A bundle whose shapes are <path>s with ids, so morph rewrites `d` directly
// (no primitive→path swap to muddy the per-frame write count). N shapes.
const N = 12;
let shapes = '';
for (let i = 0; i < N; i++) {
  const x = (i % 4) * 25, y = Math.floor(i / 4) * 25;
  shapes += `<path id="s${i}" d="M${x} ${y}h20v20h-20Z" fill="#3366cc"/>`;
}
const PREFAB = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">${shapes}</svg>`;
emitFixture('nativeMorphPerf__PREFAB', PREFAB);

const HTML = `<!DOCTYPE html><html><body>
<div id="host"></div>
<script type="module">
import { importSvg, createNativeScene, createNativeOverrideTable } from '/src/index.js';

const N = ${N};
const prefab = await importSvg(${JSON.stringify(PREFAB)}, { retainSource: true });
const scene = createNativeScene(document.getElementById('host'), { coordinateSpace: 'viewport' });
scene.setViewport(100, 100);

// Instrument the prototypes the reconciler mutates through. We count calls
// on ELEMENTS INSIDE the scene svg (the cloned glyph/shape subtree) and
// querySelectorAll on the svg root. Counters are reset per measurement.
const counts = { setAttr: 0, removeAttr: 0, qsa: 0 };
const EP = Element.prototype;
const origSet = EP.setAttribute, origRemove = EP.removeAttribute, origQsa = EP.querySelectorAll;
const inScene = (el) => { const s = scene.svg; return el !== s && s.contains(el); };
EP.setAttribute = function (...a) { if (inScene(this)) counts.setAttr++; return origSet.apply(this, a); };
EP.removeAttribute = function (...a) { if (inScene(this)) counts.removeAttr++; return origRemove.apply(this, a); };
EP.querySelectorAll = function (...a) { if (this === scene.svg || inScene(this)) counts.qsa++; return origQsa.apply(this, a); };
const reset = () => { counts.setAttr = 0; counts.removeAttr = 0; counts.qsa = 0; };

// A morph-like override table: every shape gets a fresh d each frame.
const table = createNativeOverrideTable(prefab);
const ids = prefab.shapeIds || [];
function setFrame(t) {
  for (let i = 0; i < N; i++) {
    const x = (i % 4) * 25 + Math.round(t * 5), y = Math.floor(i / 4) * 25;
    table.set('s' + i, { pathD: 'M' + x + ' ' + y + 'h20v20h-20Z' });
  }
}
function drawOnce(t) {
  setFrame(t);
  scene.beginFrame([0,0,0,0]);
  scene.drawBundle(prefab, { overrides: table });
  scene.endFrame();
}

// Warm up (frame 1 clones + indexes; we measure steady state).
drawOnce(0); drawOnce(0.1);

window.__changingMorph = () => {
  // 10 frames, each with a DIFFERENT d per shape.
  reset();
  const FRAMES = 10;
  for (let f = 0; f < FRAMES; f++) drawOnce(0.2 + f * 0.07);
  return { ...counts, frames: FRAMES, shapes: N };
};

window.__pausedMorph = () => {
  // Re-apply the SAME d 10 frames running — should be ~zero shape writes.
  drawOnce(0.5);          // establish the value
  reset();
  for (let f = 0; f < 10; f++) drawOnce(0.5);
  return { ...counts, frames: 10, shapes: N };
};

window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(HTML); return; }
  let p = decodeURIComponent(req.url.split('?')[0]);
  try { const b = readFileSync(path.join(ROOT, p)); res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); res.end(b); }
  catch { if (!res.headersSent) res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => { failures++; console.error('FAIL: ' + m); };

const browser = await puppeteer.launch({ headless: 'new', args: ['--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage();
page.on('pageerror', e => console.error('  [page-err]', e.message));
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 15000 });
  await page.waitForFunction(() => window.__ready === true, { timeout: 10000 });
} catch (e) { fail('setup: ' + e.message); await browser.close(); server.close(); process.exit(1); }

const cm = await page.evaluate(() => window.__changingMorph());
// querySelectorAll must NOT scale with frames — index is built once (during
// warmup), so steady-state frames do zero subtree walks.
if (cm.qsa === 0) ok('changing morph: ZERO querySelectorAll over ' + cm.frames + ' frames (id index reused)');
else fail('querySelectorAll ran ' + cm.qsa + 'x in steady state — per-frame tree-walk not eliminated');
// ~1 write per shape per frame (the new d). Allow a little slack but it must
// be well under the 2x that revert-then-set would cost.
const perFrame = cm.setAttr / cm.frames;
if (perFrame <= cm.shapes * 1.2) ok('changing morph: ' + cm.setAttr + ' writes / ' + cm.frames + ' frames = ' + perFrame.toFixed(1) + '/frame (~1 per ' + cm.shapes + ' shapes, no revert-then-set)');
else fail('too many writes: ' + perFrame.toFixed(1) + '/frame for ' + cm.shapes + ' shapes (revert-then-set not eliminated?)');
if (cm.removeAttr === 0) ok('changing morph: zero removeAttribute churn'); else fail('unexpected removeAttribute: ' + cm.removeAttr);

const pm = await page.evaluate(() => window.__pausedMorph());
if (pm.setAttr === 0 && pm.removeAttr === 0) ok('paused morph: ZERO DOM writes over ' + pm.frames + ' identical frames (value diff)');
else fail('paused morph wrote to DOM: setAttr=' + pm.setAttr + ' removeAttr=' + pm.removeAttr + ' (unchanged d should be a no-op)');

await browser.close();
server.close();
if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nnativeMorphPerfSmoke: all checks passed');
