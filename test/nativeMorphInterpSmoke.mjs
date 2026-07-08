// nativeMorphInterpSmoke.mjs — proves the native morph truly interpolates
// geometry every frame, rather than snapping between keyframes. It sweeps t
// in fine steps and asserts the decoded path geometry advances in small
// monotonic increments — only true if per-frame curve lerp is real.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// poseA rect at x=20, poseB rect at x=220 — a 200px slide. A real tween
// moves the left edge linearly; keyframe snapping would jump.
const SHEET = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 100" width="300" height="100">'
  + '<g id="poseA"><rect id="ra" x="20" y="20" width="60" height="60" fill="#ff0000"/></g>'
  + '<g id="poseB"><rect id="rb" x="220" y="20" width="60" height="60" fill="#0000ff"/></g></svg>';

const HTML = `<!DOCTYPE html><html><body>
<div id="host"></div>
<script type="module">
import { importSvg, createNativeScene, createNativeMorph } from '/src/index.js';

const sheet = await importSvg(${JSON.stringify(SHEET)}, { retainSource: true });
const scene = createNativeScene(document.getElementById('host'));
scene.setViewport(300, 100);
const morph = createNativeMorph(sheet, sheet, { srcSprite: 'poseA', dstSprite: 'poseB' });

// Parse the morphing rect's left-edge x out of its decoded path d. The
// rect decodes to M<x> <y> L… ; the smallest x in the d is the left edge.
function leftEdgeX(d) {
  if (!d) return null;
  const nums = d.match(/-?\\d+(?:\\.\\d+)?/g);
  if (!nums) return null;
  // d is "M x y L x y …": x coords are even indices (0,2,4,…).
  let minX = Infinity;
  for (let i = 0; i < nums.length; i += 2) minX = Math.min(minX, parseFloat(nums[i]));
  return isFinite(minX) ? minX : null;
}

window.__sweep = (steps) => {
  const xs = [];
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    morph.setT(t);
    scene.beginFrame([1,1,1,1]);
    scene.drawBundle(morph.bundle, { overrides: morph.overrides });
    scene.endFrame();
    // ids are namespaced per-clone (ra → ra_b<seq>); authored id is on data-oid.
    const el = scene.svg.querySelector('#ra,[data-oid="ra"]');
    const d = el ? el.getAttribute('d') : null;
    xs.push({ t, x: leftEdgeX(d), isPath: !!(el && el.tagName.toLowerCase() === 'path') });
  }
  return xs;
};

// Id-less morph: two single-<path> SVGs with no id attributes (real
// exported artwork). The morph's pathD must reach the shape positionally
// (the importer gives it a synthetic shape_N_* id that doesn't exist in the
// markup), or the geometry never moves.
const IDLESS_A = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M10 50L20 50L20 60L10 60Z" fill="#3a3"/></svg>';
const IDLESS_B = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M70 50L80 50L80 60L70 60Z" fill="#3a3"/></svg>';
const idlessA = await importSvg(IDLESS_A, { retainSource: true });
const idlessB = await importSvg(IDLESS_B, { retainSource: true });
const idlessScene = createNativeScene(document.createElement('div'));
idlessScene.setViewport(100, 100);
const idlessMorph = createNativeMorph(idlessA, idlessB);
window.__idlessInfo = {
  ids: idlessA.shapeIds, matched: idlessMorph.plan.matched.length,
};
window.__idlessSweep = (steps) => {
  const xs = [];
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    idlessMorph.setT(t);
    idlessScene.beginFrame([1,1,1,1]);
    idlessScene.drawBundle(idlessMorph.bundle, { overrides: idlessMorph.overrides });
    idlessScene.endFrame();
    const el = idlessScene.svg.querySelector('path');
    xs.push(leftEdgeX(el ? el.getAttribute('d') : null));
  }
  return xs;
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

const STEPS = 20;
const xs = await page.evaluate((n) => window.__sweep(n), STEPS);

// All frames must produce a real <path> with a parseable left edge.
const bad = xs.filter(r => r.x == null || !r.isPath);
if (bad.length === 0) ok('all ' + (STEPS + 1) + ' sweep frames decoded a <path d> (geometry rewritten per frame)');
else fail('frames without a decoded path: ' + JSON.stringify(bad.slice(0, 3)));

// Endpoints: t=0 ≈ 20 (poseA), t=1 ≈ 220 (poseB).
const x0 = xs[0].x, x1 = xs[xs.length - 1].x;
if (Math.abs(x0 - 20) < 2) ok('t=0 left edge at poseA (' + x0 + ' ≈ 20)'); else fail('t=0 not at poseA: ' + x0);
if (Math.abs(x1 - 220) < 2) ok('t=1 left edge at poseB (' + x1 + ' ≈ 220)'); else fail('t=1 not at poseB: ' + x1);

// The KEY test: intermediate t values land at DISTINCT, monotonically
// increasing positions — not collapsed onto 20 or 220 (which is what
// "keyframe snapping" would produce). Check monotonic + small steps.
let monotonic = true, maxStep = 0, distinct = new Set();
for (let i = 1; i < xs.length; i++) {
  const dx = xs[i].x - xs[i - 1].x;
  if (dx < -0.5) monotonic = false;
  maxStep = Math.max(maxStep, Math.abs(dx));
  distinct.add(Math.round(xs[i].x));
}
const expectedStep = 200 / STEPS;             // ~10px per step for a linear tween
if (monotonic) ok('left edge advances monotonically poseA→poseB across the sweep'); else fail('non-monotonic sweep (snapping?): ' + xs.map(r => r.x).join(','));
if (distinct.size >= STEPS - 2) ok('sweep hits ' + distinct.size + ' DISTINCT positions over ' + STEPS + ' steps (true interpolation, not keyframes)');
else fail('only ' + distinct.size + ' distinct positions — geometry is snapping to keyframes, not tweening: ' + [...distinct].sort((a,b)=>a-b).join(','));
if (maxStep < expectedStep * 2.5) ok('max per-step jump ' + maxStep.toFixed(1) + 'px ≈ linear ' + expectedStep.toFixed(1) + 'px (no keyframe jumps)');
else fail('a step jumped ' + maxStep.toFixed(1) + 'px (expected ~' + expectedStep.toFixed(1) + ') — keyframe snapping');

// Sample the midpoint explicitly: t=0.5 must be near x=120 (halfway), NOT
// at 20 or 220.
const mid = xs[Math.round(STEPS / 2)];
if (Math.abs(mid.x - 120) < 12) ok('t=0.5 left edge at the MIDPOINT (' + mid.x + ' ≈ 120), not snapped to a pose');
else fail('t=0.5 not at midpoint: ' + mid.x + ' (snapped to a keyframe?)');

// Id-less morph: the synthetic-id shape must still receive its tweened
// pathD via positional addressing, or every id-less morph freezes on native.
const idInfo = await page.evaluate(() => window.__idlessInfo);
const synthetic = (idInfo.ids || []).every((id) => /^shape_\d+_(fill|stroke)$/.test(id));
if (synthetic) ok('id-less bundle has only synthetic shape ids (' + JSON.stringify(idInfo.ids) + ')');
else fail('fixture not id-less: ' + JSON.stringify(idInfo.ids));
if (idInfo.matched >= 1) ok('id-less morph matched ' + idInfo.matched + ' shape(s)');
else fail('id-less morph matched nothing: ' + idInfo.matched);
const il = await page.evaluate((n) => window.__idlessSweep(n), STEPS);
const ilDistinct = new Set(il.map((x) => x == null ? 'null' : Math.round(x))).size;
if (!il.includes(null) && ilDistinct >= STEPS - 2)
  ok('ID-LESS morph geometry INTERPOLATES (' + ilDistinct + ' distinct x over ' + STEPS + ' steps, ' + il[0] + '→' + il[il.length-1] + ')');
else fail('ID-LESS MORPH FROZEN — pathD not reaching the shape positionally: ' + JSON.stringify(il));

await browser.close();
server.close();
if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nnativeMorphInterpSmoke: all checks passed');
