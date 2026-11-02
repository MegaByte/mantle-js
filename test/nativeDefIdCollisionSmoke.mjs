// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// nativeDefIdCollisionSmoke.mjs — cross-bundle <defs> id collision on the
// native (no-WebGL) backend.
//
// Two independent bundles each ship `<mask id="m1">` (valid in a self-
// contained SVG). The native backend hosts every bundle's markup — defs
// included — into one shared host <svg>. SVG resolves url(#m1) at document
// scope (first match wins), not within the referencing subtree, so without
// per-bundle id namespacing both bundles' `mask="url(#m1)"` bind to whichever
// m1 mounted first → wrong mask on the other. Authored ids are namespaced
// per clone (m1 → m1_b<seq>, authored id kept on data-oid) and all url(#…) /
// href refs rewritten, so each bundle masks with its own def.
//
// Fixture: bundle A = red square masked to its LEFT half; bundle B = blue
// square masked to its RIGHT half (opposite masks, same id). If they collide,
// B would be masked by A's left-half mask (or vice versa) → wrong region.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Mask shows the LEFT half (x 0..50). Red fill.
const A =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">' +
  '<mask id="m1"><rect x="0" y="0" width="50" height="100" fill="#fff"/></mask>' +
  '<rect x="0" y="0" width="100" height="100" fill="#ff0000" mask="url(&quot;#m1&quot;)"/></svg>';
// same id m1, but mask shows the RIGHT half (x 50..100). Blue fill.
const B =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">' +
  '<mask id="m1"><rect x="50" y="0" width="50" height="100" fill="#fff"/></mask>' +
  '<rect x="0" y="0" width="100" height="100" fill="#0000ff" style="mask:url(&apos;#m1&apos;)"/></svg>';

const HTML = `<!DOCTYPE html><html><body>
<div id="host"></div>
<canvas id="cv" width="100" height="100"></canvas>
<script type="module">
import { importSvg, createNativeScene } from '/src/index.js';
import { nativeResourcePixels } from '/test/_nativeResources.mjs';
window.__generatedResources = nativeResourcePixels;
const a = await importSvg(${JSON.stringify(A)}, { retainSource: true });
const b = await importSvg(${JSON.stringify(B)}, { retainSource: true });
const scene = createNativeScene(document.getElementById('host'), { coordinateSpace: 'viewport' });
scene.setViewport(100, 100);
// Place both at the SAME pixel rect (overlapping). With correct masks A fills
// the LEFT half (red), B fills the RIGHT half (blue) — together they tile the
// canvas with no overlap. A collision would put both halves on the same side.
function emToPx(s) { return new Float32Array([s,0,0, 0,s,0, 0,0,1]); }
const ctx = document.getElementById('cv').getContext('2d');
window.__run = async () => {
  scene.beginFrame([0,0,0,1]);
  scene.drawBundle(a, { worldMatrix: emToPx(1) });
  scene.drawBundle(b, { worldMatrix: emToPx(1) });
  scene.endFrame();
  // DOM: count distinct mask ids actually present.
  const masks = [...scene.svg.querySelectorAll('mask')].map(m => m.getAttribute('id'));
  const xml = new XMLSerializer().serializeToString(scene.svg);
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml); });
  ctx.clearRect(0,0,100,100); ctx.drawImage(img, 0, 0, 100, 100);
  const at = (x,y) => { const p = ctx.getImageData(x,y,1,1).data; return [p[0],p[1],p[2],p[3]]; };
  return {
    maskIds: masks,
    left:  at(25, 50),   // expect RED (bundle A's left-half mask)
    right: at(75, 50),   // expect BLUE (bundle B's right-half mask)
  };
};
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  let p = decodeURIComponent(req.url.split('?')[0]);
  try {
    const x = readFileSync(path.join(ROOT, p));
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    res.end(x);
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
const isRed = (px) => px[0] > 150 && px[1] < 90 && px[2] < 90;
const isBlue = (px) => px[2] > 150 && px[0] < 90 && px[1] < 90;

const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
try {
  await openReady(page, `http://127.0.0.1:${port}/`, { ready: 'flag' });
} catch (e) {
  fail('setup: ' + e.message);
  await browser.close();
  server.close();
  process.exit(1);
}

const r = await page.evaluate(() => window.__run());
// Two masks, UNIQUE ids (namespaced), not one shared "m1".
if (r.maskIds.length === 2 && new Set(r.maskIds).size === 2)
  ok('two bundles → two UNIQUE mask ids (' + JSON.stringify(r.maskIds) + '), no collision');
else fail('mask ids collided/missing: ' + JSON.stringify(r.maskIds));
// Each bundle masked by its own def: A shows left-red, B shows right-blue.
if (isRed(r.left)) ok('left half is RED — bundle A masked by ITS m1 (left-half) (' + r.left + ')');
else fail('left not red — A masked by wrong def: ' + r.left);
if (isBlue(r.right))
  ok('right half is BLUE — bundle B masked by ITS m1 (right-half) (' + r.right + ')');
else fail('right not blue — B bound the FIRST m1 (collision): ' + r.right);

const generated = await page.evaluate(() => window.__generatedResources());
for (const row of generated) {
  if (!row.duplicates.length && row.wrongPoints === 0)
    ok('generated resources ' + row.mode + ': unique ids and exact authored pixels');
  else fail('generated resources ' + JSON.stringify(row));
}

await browser.close();
server.close();
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nnativeDefIdCollisionSmoke: all checks passed');
