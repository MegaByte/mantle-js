// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// spriteMorphSmoke.mjs — createSpriteMorph proof.
// One sheet with two morph-pose sprites that share per-shape topology so
// they actually curve-lerp (not just crossfade):
//   #poseA — a red rect on the left
//   #poseB — a blue rect on the right, same rect topology, different position
// Morphing poseA→poseB should slide/recolor the rect from A to B, rendering
// only the morphing sprite (the other sheet shapes hidden).
//
// Asserts:
//   1. createSpriteMorph builds from two sprites of the same sheet bundle
//      (src === dst) without self-matching (the headline same-bundle trap).
//   2. The morph renders only the sprite — non-sprite shapes are hidden.
//   3. setT(0) ≈ poseA, setT(1) ≈ poseB, setT(0.5) is between — geometry
//      interpolates, no GL error.
//   4. Cross-bundle morph (two separate sheets, same sprite id) also works.
//   5. Unknown sprite id throws; overlapping same-bundle ranges throw.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Two sprites, matched topology (both a single <rect>), different x + color.
// A third un-id'd shape (green marker) must NOT appear in the morph.
const SHEET = readFileSync(
  new URL('../examples/smoke/spriteMorph__SHEET.svg', import.meta.url),
  'utf8',
);
// A second sheet with the same sprite id 'poseA' (cross-bundle case).
const SHEET2 = readFileSync(
  new URL('../examples/smoke/spriteMorph__SHEET2.svg', import.meta.url),
  'utf8',
);

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="300" height="100"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, createSpriteMorph } from '/src/index.js';
const cnv = document.getElementById('c');
const gl = cnv.getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
const sheet  = createBundle(gl, await importSvg(${JSON.stringify(SHEET)}));
const sheet2 = createBundle(gl, await importSvg(${JSON.stringify(SHEET2)}));
const id = new Float32Array([1,0,0, 0,1,0, 0,0,1]);
window.__ranges = sheet.spriteRanges;
window.__hasFn = typeof createSpriteMorph === 'function';

// Same-bundle morph: poseA → poseB, both in sheet.
let morph = null;
window.__build = () => {
  morph = createSpriteMorph(gl, { bundle: sheet, sprite: 'poseA' }, { bundle: sheet, sprite: 'poseB' });
  return { numShapes: morph.bundle.numShapes,
           matched: morph.plan.matched.length,
           selfMatch: morph.plan.matched.some(m => m.srcIdx === m.dstIdx),
           hidden: morph.plan.hidden ? morph.plan.hidden.length : 0 };
};
window.__draw = (t) => {
  morph.setT(t);
  renderer.setViewport(300, 100);
  renderer.beginFrame([0,0,0,1]);
  renderer.drawBundle(morph.bundle, { worldMatrix: id, overrides: morph.overrides });
  renderer.endFrame();
};
window.__sample = (x, yTop) => { const b = new Uint8Array(4); gl.readPixels(x, 100-1-yTop, 1,1, gl.RGBA, gl.UNSIGNED_BYTE, b); return [b[0],b[1],b[2],b[3]]; };
window.__glErr = () => gl.getError();

// Cross-bundle: sheet.poseA → sheet2.poseA.
window.__buildCross = () => {
  const m = createSpriteMorph(gl, { bundle: sheet, sprite: 'poseA' }, { bundle: sheet2, sprite: 'poseA' });
  m.setT(0.5);
  const n = m.bundle.numShapes, matched = m.plan.matched.length;
  m.dispose();
  return { n, matched };
};
window.__throwsUnknown = () => { try { createSpriteMorph(gl, { bundle: sheet, sprite: 'nope' }, { bundle: sheet, sprite: 'poseB' }); return false; } catch { return true; } };
window.__throwsOverlap = () => { try { createSpriteMorph(gl, { bundle: sheet, sprite: 'poseA' }, { bundle: sheet, sprite: 'poseA' }); return false; } catch { return true; } };
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  let p = decodeURIComponent(req.url.split('?')[0]);
  const ct = p.endsWith('.glsl') ? 'text/plain' : 'text/javascript';
  try {
    res.writeHead(200, { 'content-type': ct + '; charset=utf-8' });
    res.end(readFileSync(path.join(ROOT, p)));
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

const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
page.on('console', (m) => {
  const t = m.text();
  if (/Mantle\]/.test(t)) console.log('  [page]', t);
});
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 15000 });
  await page.waitForFunction(() => window.__ready === true, { timeout: 10000, polling: 100 });
} catch (e) {
  fail('setup: ' + e.message);
  await browser.close();
  server.close();
  process.exit(1);
}

if (await page.evaluate(() => window.__hasFn)) ok('createSpriteMorph exported');
else fail('createSpriteMorph not exported');

const ranges = await page.evaluate(() => window.__ranges);
if (ranges && ranges.poseA && ranges.poseB)
  ok('sheet has poseA + poseB sprites: ' + JSON.stringify(ranges));
else fail('sheet sprite ranges wrong: ' + JSON.stringify(ranges));

// (1) build, same-bundle, no self-match.
const b = await page.evaluate(() => window.__build());
if (b.matched >= 1) ok("morph matched the two sprites' rects (" + b.matched + ' matched)');
else fail('no matched shapes: ' + JSON.stringify(b));
if (!b.selfMatch) ok('no self-match (src===dst handled — sprite A matched B, not itself)');
else fail('a shape matched ITSELF (same-bundle trap)');
if (b.hidden >= 1) ok('non-sprite shapes hidden (' + b.hidden + ' rows forced invisible)');
else fail('no hidden shapes — whole sheet would render: ' + JSON.stringify(b));

// (2)+(3) interpolation: at t=0 red rect at poseA (x≈50); at t=1 blue at poseB (x≈250); mid between.
const r0 = await page.evaluate(() => {
  window.__draw(0);
  return {
    a: window.__sample(50, 50),
    b: window.__sample(250, 50),
    marker: window.__sample(150, 50),
    err: window.__glErr(),
  };
});
if (r0.err === 0) ok('setT(0) no GL error');
else fail('GL error at t=0: ' + r0.err);
if (r0.a[0] > 180 && r0.a[2] < 80) ok('t=0: red rect at poseA position');
else fail('t=0 poseA wrong: ' + r0.a);
if (r0.marker[1] < 120) ok('t=0: un-id\\u2019d green marker NOT rendered (only the sprite morphs)');
else fail('foreign marker rendered: ' + r0.marker);

const r1 = await page.evaluate(() => {
  window.__draw(1);
  return { a: window.__sample(50, 50), b: window.__sample(250, 50), err: window.__glErr() };
});
if (r1.err === 0) ok('setT(1) no GL error');
else fail('GL error at t=1: ' + r1.err);
if (r1.b[2] > 180 && r1.b[0] < 80)
  ok('t=1: blue rect at poseB position (geometry + color morphed across)');
else fail('t=1 poseB wrong: ' + r1.b);
if (r1.a[0] < 120) ok('t=1: rect no longer at poseA (it moved)');
else fail('t=1 still red at poseA: ' + r1.a);

const rMid = await page.evaluate(() => {
  window.__draw(0.5);
  return {
    mid: window.__sample(150, 50),
    a: window.__sample(50, 50),
    b: window.__sample(250, 50),
    err: window.__glErr(),
  };
});
if (rMid.err === 0) ok('setT(0.5) no GL error');
else fail('GL error at t=0.5: ' + rMid.err);
// At t=0.5 the rect sits at the MIDDLE (x≈150), color halfway red↔blue
// (purple), and the two end positions are background. Geometry + color
// both interpolated.
const isPurple = (p) => p[0] > 60 && p[2] > 60 && p[1] < 80;
const isBg = (p) => p[0] < 60 && p[2] < 60;
if (isPurple(rMid.mid))
  ok('t=0.5: rect at the midpoint, color halfway red↔blue (' + rMid.mid + ')');
else fail('t=0.5 midpoint not interpolated: ' + rMid.mid);
if (isBg(rMid.a) && isBg(rMid.b))
  ok('t=0.5: the two end positions are empty (rect genuinely moved to the middle)');
else fail('t=0.5 ends not empty: a=' + rMid.a + ' b=' + rMid.b);

// (4) cross-bundle.
const cross = await page.evaluate(() => window.__buildCross());
if (cross.matched >= 1) ok('cross-bundle morph (two sheets, same sprite id) matched + built');
else fail('cross-bundle morph failed: ' + JSON.stringify(cross));

// (5) error cases.
if (await page.evaluate(() => window.__throwsUnknown())) ok('unknown sprite id throws');
else fail('unknown id did not throw');
if (await page.evaluate(() => window.__throwsOverlap())) ok('overlapping same-bundle ranges throw');
else fail('overlap did not throw');

await browser.close();
server.close();
if (failures === 0) console.log('\nSPRITE-MORPH PASS');
else console.log(`\nSPRITE-MORPH FAIL (${failures})`);
process.exit(failures ? 1 : 0);
