// nativeReconcilerSmoke.mjs — the native fallback's POSITIONAL RECONCILER.
//
// The no-GPU path keeps persistent DOM "slots" mounted across frames and,
// per frame, only UPDATES what changed instead of tearing down and re-
// cloning the whole subtree. This test pins the two properties that make
// that safe and worthwhile:
//
//   1. REUSE — the same bundle drawn in the same call-order position keeps
//      the SAME <g> element (and its already-cloned subtree) across frames.
//      No per-frame deep clone, no remove-all/append-all.
//   2. RESET — overrides/sprite-hiding mutate the reused subtree in place,
//      so they MUST revert when dropped: a shape recolored/hidden on frame
//      N returns to its authored state on frame N+1 when the override is
//      gone. Otherwise stale mutations accumulate and animations corrupt.
//   3. TRIM — drawing fewer bundles than last frame unmounts the tail.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Two addressable shapes so we can override one and watch it revert.
const PREFAB = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">'
  + '<rect id="bg" x="0" y="0" width="100" height="100" fill="#2ecc71"/>'
  + '<rect id="fg" x="25" y="25" width="50" height="50" fill="#e74c3c"/></svg>';

const HTML = `<!DOCTYPE html><html><body>
<div id="host"></div>
<script type="module">
import { importSvg, createNativeScene, createNativeOverrideTable } from '/src/index.js';

const prefab = await importSvg(${JSON.stringify(PREFAB)}, { retainSource: true });
const host = document.getElementById('host');
const scene = createNativeScene(host, { coordinateSpace: 'viewport' });
scene.setViewport(100, 100);
const svg = scene.svg;

// shapeIds the override table addresses by index. importSvg already fills
// bundle.shapeIds; assert the authored ids are present so overrides land.
window.__ids = () => (prefab.shapeIds || []).slice();

// Helpers to read the live DOM (post-frame, no rasterization needed — we
// assert on element identity and attributes directly).
// The native backend NAMESPACES authored ids per-clone (fg → fg_b<seq>) to
// avoid cross-bundle url(#id) collisions, recording the authored id on
// data-oid. So find the shape by data-oid (or the raw id if un-namespaced).
const fgEl = () => svg.querySelector('#fg,[data-oid="fg"]');
const bundleGroups = () => svg.querySelectorAll(':scope > g');

// Frame 1: override #fg to blue. Frame 2: NO override. #fg must be blue
// after f1 and back to its authored red after f2 — and it must be the
// SAME <g> and SAME #fg element both frames (reused, not recloned).
window.__overrideResetCase = () => {
  const table = createNativeOverrideTable(prefab);
  table.set('fg', { fill: [0, 0, 1, 1] });          // blue

  scene.beginFrame([0,0,0,0]);
  scene.drawBundle(prefab, { overrides: table });
  scene.endFrame();
  const g1 = bundleGroups()[0];
  const fg1 = fgEl();
  const fill1 = fg1 && fg1.getAttribute('fill');

  scene.beginFrame([0,0,0,0]);
  scene.drawBundle(prefab, {});                      // override dropped
  scene.endFrame();
  const g2 = bundleGroups()[0];
  const fg2 = fgEl();
  const fill2 = fg2 && fg2.getAttribute('fill');

  return {
    fill1, fill2,
    sameGroup: g1 === g2,        // <g> reused across frames (no reclone)
    sameFg: fg1 === fg2,         // #fg element reused (no reclone)
    groupCount2: bundleGroups().length,
  };
};

// Sprite-hide reset: draw sprite range hiding #fg, then draw full bundle.
// #fg is display:none after the ranged frame and visible after the full one.
window.__spriteHideResetCase = () => {
  // shapeRange [lo,hi] over shapeIds hides everything outside it. Hide #fg
  // by ranging to only #bg's index.
  const ids = prefab.shapeIds || [];
  const bgIdx = ids.indexOf('bg');
  const fgIdx = ids.indexOf('fg');
  if (bgIdx < 0 || fgIdx < 0) return { skipped: 'missing ids', ids };

  scene.beginFrame([0,0,0,0]);
  scene.drawBundle(prefab, { shapeRange: [bgIdx, bgIdx] });   // hide #fg
  scene.endFrame();
  const hidden = fgEl() && fgEl().style.display;

  scene.beginFrame([0,0,0,0]);
  scene.drawBundle(prefab, {});                                // no range
  scene.endFrame();
  const shown = fgEl() && fgEl().style.display;

  return { hidden, shown };
};

// Tail trim: frame with 2 bundles → frame with 1 bundle leaves exactly one
// bundle <g> mounted (the second slot is unmounted).
window.__trimCase = () => {
  scene.beginFrame([0,0,0,0]);
  scene.drawBundle(prefab, {});
  scene.drawBundle(prefab, {});
  scene.endFrame();
  const two = bundleGroups().length;

  scene.beginFrame([0,0,0,0]);
  scene.drawBundle(prefab, {});
  scene.endFrame();
  const one = bundleGroups().length;
  return { two, one };
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

const ids = await page.evaluate(() => window.__ids());
if (ids.includes('fg') && ids.includes('bg')) ok('bundle.shapeIds addresses #fg/#bg (' + JSON.stringify(ids) + ')');
else fail('shapeIds missing fg/bg: ' + JSON.stringify(ids));

const oc = await page.evaluate(() => window.__overrideResetCase());
const isBlue = (f) => f === 'rgba(0,0,255,1)' || f === 'rgb(0,0,255)' || f === '#0000ff';
const isRed  = (f) => /e74c3c/i.test(f) || f === 'rgb(231,76,60)';
if (isBlue(oc.fill1)) ok('frame 1: #fg override applied (fill=' + oc.fill1 + ')'); else fail('override not applied: ' + oc.fill1);
if (isRed(oc.fill2)) ok('frame 2: #fg reverts to AUTHORED red when override dropped (fill=' + oc.fill2 + ')');
else fail('STALE OVERRIDE — #fg did not revert: ' + oc.fill2);
if (oc.sameGroup) ok('bundle <g> is the SAME element across frames (reused, not recloned)'); else fail('<g> was recloned — reuse broken');
if (oc.sameFg) ok('#fg is the SAME element across frames (subtree reused)'); else fail('#fg was recloned — subtree not reused');
if (oc.groupCount2 === 1) ok('one bundle <g> mounted'); else fail('group count: ' + oc.groupCount2);

const sh = await page.evaluate(() => window.__spriteHideResetCase());
if (sh.skipped) fail('spriteHide: ' + sh.skipped);
else {
  if (sh.hidden === 'none') ok('sprite range hides #fg (display:none)'); else fail('#fg not hidden: ' + sh.hidden);
  if (sh.shown !== 'none') ok('#fg SHOWN again when range dropped (hide reverts: "' + sh.shown + '")');
  else fail('STALE HIDE — #fg stayed display:none: ' + sh.shown);
}

const tc = await page.evaluate(() => window.__trimCase());
if (tc.two === 2) ok('two bundles → two <g>'); else fail('expected 2 groups, got ' + tc.two);
if (tc.one === 1) ok('one bundle next frame → tail slot trimmed (one <g>)'); else fail('tail not trimmed: ' + tc.one);

await browser.close();
server.close();
if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nnativeReconcilerSmoke: all checks passed');
