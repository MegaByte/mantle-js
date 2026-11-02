// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// nativeRecolorSmoke.mjs — the native (no-WebGL) fallback's per-draw
// recolor parity with the GL fill shader (mantle.frag.glsl). The native
// path applies the same color algebra to each shape's resolved fill color
// (not via a filter) — for solid-fill artwork the per-shape result equals
// the GL per-pixel result.
//
// Cases:
//   dualTint(primary=red, contrast=blue) on a red+blue SVG → identity
//     (red shape's R selects red primary, blue shape's B selects blue).
//   dualTint(primary=green, contrast=magenta) → red rect→green, blue→magenta.
//   monochrome(yellow) → both rects map to a yellow-weighted luminance.
//   channelLerp(primary=green) → red rect→green, a white shape→highlight.
//   revert: a non-recolor draw after a recolor draw is passthrough again.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Two side-by-side rects (left red, right blue). Deliberately no id
// attributes — real artwork is often id-less, so the recolor must address
// shapes positionally, not by shapeId. An id-keyed recolor pass would no-op
// on id-less art.
const SVG =
  '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">' +
  '<rect x="0" y="0" width="50" height="100" fill="#FF0000"/>' +
  '<rect x="50" y="0" width="50" height="100" fill="#0000FF"/></svg>';

const HTML = `<!DOCTYPE html><html><body style="margin:0;background:#000">
<canvas id="c" width="100" height="100"></canvas>
<script type="module">
import { importSvg, createNativeScene, createNativeOverrideTable,
  colorMatrixDualTint, colorMatrixMonochrome, channelLerpParams } from '/src/index.js';

const bundle = await importSvg(${JSON.stringify(SVG)}, { retainSource: true });
const scene = createNativeScene(document.createElement('div'));
scene.setViewport(100, 100);
const ctx = document.getElementById('c').getContext('2d');

async function drawAndSample(opts) {
  scene.beginFrame([0,0,0,1]);
  scene.drawBundle(bundle, opts || {});
  scene.endFrame();
  const xml = new XMLSerializer().serializeToString(scene.svg);
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml); });
  ctx.clearRect(0,0,100,100); ctx.drawImage(img, 0, 0, 100, 100);
  const at = (x,y) => { const p = ctx.getImageData(x,y,1,1).data; return [p[0],p[1],p[2],p[3]]; };
  return { left: at(25,50), right: at(75,50) };
}

window.__plain = () => drawAndSample({});
window.__dualIdentity = () => { const {matrix,offset} = colorMatrixDualTint([1,0,0,1],[0,0,1,1]); return drawAndSample({ colorMatrix: matrix, colorMatrixOffset: offset }); };
window.__dualSwap = () => { const {matrix,offset} = colorMatrixDualTint([0,1,0,1],[1,0,1,1]); return drawAndSample({ colorMatrix: matrix, colorMatrixOffset: offset }); };
window.__mono = () => { const {matrix,offset} = colorMatrixMonochrome([1,1,0,1]); return drawAndSample({ colorMatrix: matrix, colorMatrixOffset: offset }); };
window.__channelLerp = () => drawAndSample({ channelLerp: channelLerpParams([0,1,0,1],[0,0,1,1],[1,1,1,1]) });
// Palette LUT keyed on the RED channel: index 0 = black, index 1 = white.
// Red rect (R=1) → floor(1*2)=1 (clamped) → white; blue rect (R=0) → 0 → black.
window.__palette = () => drawAndSample({
  palette: { __nativePalette: true, entries: [[0,0,0,255],[255,255,255,255]] },
  paletteChannel: 'r',
});
window.__revertAfterRecolor = async () => {
  await drawAndSample({ colorMatrix: colorMatrixDualTint([0,1,0,1],[1,0,1,1]).matrix, colorMatrixOffset: [0,0,0,0] });
  return drawAndSample({});   // no recolor → back to authored red/blue
};

// ── Per-shape override tint RGB ───────────────────────────────────────────
// White-authored art tinted via the override table's tint (multiplicative
// RGBA, like the GL shader's vFill *= tint); a cyan tint must color a white
// bar, not leave it white. The bundle has an id so the override addresses it;
// a second white shape stays untinted to prove it's per-shape.
const WHITE = '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">'
  + '<rect id="bar" x="0" y="0" width="50" height="100" fill="#FFFFFF"/>'
  + '<rect x="50" y="0" width="50" height="100" fill="#FFFFFF"/></svg>';
const whiteBundle = await importSvg(WHITE, { retainSource: true });
async function drawWhite(setup) {
  const ov = createNativeOverrideTable(whiteBundle);
  setup(ov);
  scene.beginFrame([0.5,0.5,0.5,1]);        // gray bg so a translucent tint shows
  scene.drawBundle(whiteBundle, { overrides: ov });
  scene.endFrame();
  const xml = new XMLSerializer().serializeToString(scene.svg);
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml); });
  ctx.clearRect(0,0,100,100); ctx.drawImage(img, 0, 0, 100, 100);
  const at = (x,y) => { const p = ctx.getImageData(x,y,1,1).data; return [p[0],p[1],p[2],p[3]]; };
  return { tinted: at(25,50), untinted: at(75,50) };
}
// Cyan tint (#39BCE4, full alpha) on a white bar → cyan.
window.__tintCyan = () => drawWhite(ov => ov.set('bar', { tint: [0.224, 0.737, 0.894, 1] }));
// Translucent-black tint [0,0,0,0.502] on white over gray → darkened (≈ mid-gray).
window.__tintDarken = () => drawWhite(ov => ov.set('bar', { tint: [0, 0, 0, 0.502] }));
// Per-draw: drop the tint next frame → bar reverts to white.
window.__tintRevert = async () => {
  await drawWhite(ov => ov.set('bar', { tint: [0.224, 0.737, 0.894, 1] }));
  return drawWhite(() => {});   // empty override → authored white again
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
const near = (px, r, g, b, tol = 24) =>
  Math.abs(px[0] - r) <= tol && Math.abs(px[1] - g) <= tol && Math.abs(px[2] - b) <= tol;

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

const plain = await page.evaluate(() => window.__plain());
if (near(plain.left, 255, 0, 0) && near(plain.right, 0, 0, 255))
  ok('baseline: left red, right blue');
else fail('baseline wrong: ' + JSON.stringify(plain));

const di = await page.evaluate(() => window.__dualIdentity());
if (near(di.left, 255, 0, 0) && near(di.right, 0, 0, 255))
  ok('dualTint(red,blue) is identity for red+blue art');
else fail('dualTint identity changed colors: ' + JSON.stringify(di));

const ds = await page.evaluate(() => window.__dualSwap());
if (near(ds.left, 0, 255, 0)) ok('dualTint primary=green: red rect → GREEN (' + ds.left + ')');
else fail('left not green: ' + ds.left);
if (near(ds.right, 255, 0, 255))
  ok('dualTint contrast=magenta: blue rect → MAGENTA (' + ds.right + ')');
else fail('right not magenta: ' + ds.right);

const mo = await page.evaluate(() => window.__mono());
// monochrome(yellow): red lum=0.2126 → (0.2126*255≈54) yellow-scaled → R&G≈54, B=0.
if (mo.left[2] < 40 && mo.left[0] > 20 && Math.abs(mo.left[0] - mo.left[1]) < 24)
  ok('monochrome(yellow): red rect → yellow-weighted luminance (' + mo.left + ')');
else fail('monochrome wrong: ' + JSON.stringify(mo.left));

const cl = await page.evaluate(() => window.__channelLerp());
if (near(cl.left, 0, 255, 0)) ok('channelLerp primary=green: red rect → GREEN (' + cl.left + ')');
else fail('channelLerp left not green: ' + cl.left);
// blue rect: B=1 → contrast=blue; G=0,A=1 → k=0 → stays contrast (blue).
if (near(cl.right, 0, 0, 255))
  ok('channelLerp contrast=blue: blue rect stays blue (k=0, ' + cl.right + ')');
else fail('channelLerp right wrong: ' + cl.right);

const pal = await page.evaluate(() => window.__palette());
if (near(pal.left, 255, 255, 255))
  ok('palette[R]: red rect (R=1) → white LUT entry (' + pal.left + ')');
else fail('palette red→white failed: ' + pal.left);
if (near(pal.right, 0, 0, 0))
  ok('palette[R]: blue rect (R=0) → black LUT entry (' + pal.right + ')');
else fail('palette blue→black failed: ' + pal.right);

const rv = await page.evaluate(() => window.__revertAfterRecolor());
if (near(rv.left, 255, 0, 0) && near(rv.right, 0, 0, 255))
  ok('recolor is PER-DRAW: a plain draw after a recolor draw reverts to authored colors');
else fail('recolor stuck after dropped: ' + JSON.stringify(rv));

// ── Per-shape override tint RGB ───────────────────────────────────────────
const tc = await page.evaluate(() => window.__tintCyan());
// white #FFF × cyan #39BCE4 = cyan ≈ (57,188,228).
if (near(tc.tinted, 57, 188, 228, 30))
  ok('override tint RGB: white bar × cyan → CYAN (' + tc.tinted + '), not white');
else fail('override tint dropped RGB — bar not cyan: ' + JSON.stringify(tc.tinted));
if (near(tc.untinted, 255, 255, 255, 20))
  ok('override tint is PER-SHAPE: the un-tinted white bar stays white (' + tc.untinted + ')');
else fail('tint leaked to other shape: ' + JSON.stringify(tc.untinted));

const td = await page.evaluate(() => window.__tintDarken());
// white × [0,0,0,0.502] = black at 0.502 over gray(128) ≈ (64,64,64). Must be
// markedly darker than the untinted white half.
if (td.tinted[0] < 110 && td.tinted[1] < 110 && td.tinted[2] < 110)
  ok('override tint [0,0,0,0.502]: white pill DARKENED over gray (' + td.tinted + ')');
else fail('translucent-black tint did not darken the pill: ' + JSON.stringify(td.tinted));

const trv = await page.evaluate(() => window.__tintRevert());
if (near(trv.tinted, 255, 255, 255, 20))
  ok('override tint is PER-DRAW: dropping the tint reverts the bar to white (' + trv.tinted + ')');
else fail('override tint stuck after drop: ' + JSON.stringify(trv.tinted));

await browser.close();
server.close();
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nnativeRecolorSmoke: all checks passed');
