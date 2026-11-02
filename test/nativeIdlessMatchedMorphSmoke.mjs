// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// nativeIdlessMatchedMorphSmoke.mjs — matched native morph rows must apply by
// numeric shape index when SVG leaves have no authored id. The native morph
// writes pathD/visibility with overrides.update(shapeIndex, ...); drawBundle
// reads those rows by index, then uses positional DOM addressing.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const SRC =
  '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">' +
  '<rect x="10" y="40" width="20" height="20" fill="#ff0000"/></svg>';
const DST =
  '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">' +
  '<rect x="70" y="40" width="20" height="20" fill="#ff0000"/></svg>';

const HTML = `<!DOCTYPE html><html><body style="margin:0">
<canvas id="c" width="100" height="100"></canvas>
<script type="module">
import { importSvg, createNativeScene, createNativeMorph } from '/src/index.js';
const src = await importSvg(${JSON.stringify(SRC)}, { retainSource: true });
const dst = await importSvg(${JSON.stringify(DST)}, { retainSource: true });
// The importer synthesizes a stable id (shape_N_fill) for every leaf that has
// no authored id=, so SVG rows are never literally id-less. Clear those
// synthetic ids to model a genuinely id-less bundle (programmatic / some text
// sources) — this is what forces buildMorphPlan's POSITIONAL match and the
// native drawBundle's index-based DOM addressing, the paths under test.
for (const b of [src, dst]) if (b.shapeIds) b.shapeIds = b.shapeIds.map(() => '');
const scene = createNativeScene(document.createElement('div'));
scene.setViewport(100, 100);
const morph = createNativeMorph(src, dst);
const ctx = document.getElementById('c').getContext('2d');
window.__shapeIds = src.shapeIds;
window.__render = async (t) => {
  morph.setT(t);
  scene.beginFrame([1,1,1,1]);
  scene.drawBundle(morph.bundle, { overrides: morph.overrides });
  scene.endFrame();
  const xml = new XMLSerializer().serializeToString(scene.svg);
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml); });
  ctx.clearRect(0,0,100,100); ctx.drawImage(img, 0, 0, 100, 100);
  const at = (x,y) => { const p = ctx.getImageData(x,y,1,1).data; return [p[0],p[1],p[2],p[3]]; };
  return { left: at(20, 50), right: at(80, 50) };
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
    const b = readFileSync(path.join(ROOT, p));
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    res.end(b);
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
const isRed = (p) => p[0] > 150 && p[1] < 90 && p[2] < 90 && p[3] > 120;
const isWhite = (p) => p[0] > 220 && p[1] > 220 && p[2] > 220 && p[3] > 120;

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

const ids = await page.evaluate(() => window.__shapeIds);
if (ids.length === 1 && !ids[0]) ok('fixture has one id-less shape row');
else fail('fixture unexpectedly has authored/synthetic id: ' + JSON.stringify(ids));

const r0 = await page.evaluate(() => window.__render(0));
if (isRed(r0.left) && isWhite(r0.right)) ok('t=0 red shape starts on the left');
else fail('t=0 wrong: left=' + r0.left + ' right=' + r0.right);

const r1 = await page.evaluate(() => window.__render(1));
if (isWhite(r1.left) && isRed(r1.right)) ok('t=1 id-less matched shape moved to the right');
else fail('t=1 pathD override missed: left=' + r1.left + ' right=' + r1.right);

await browser.close();
server.close();
if (failures === 0) console.log('\nNATIVE-IDLESS-MATCHED-MORPH PASS');
else console.log(`\nNATIVE-IDLESS-MATCHED-MORPH FAIL (${failures})`);
process.exit(failures ? 1 : 0);
