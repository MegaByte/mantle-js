// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// occlusionCullOverrideSmoke.mjs — the occlusion cull must not outlive the condition it assumed.
//
// occlusionCull removes a shape from the draw list entirely (bundle.js) when a LATER plain-
// opaque shape provably covers it. That containment is computed ONCE, from static em-space
// geometry, at bundle build. Per-shape OVERRIDES then move / hide / fade shapes at draw time —
// so an occluder can stop occluding after the cull was decided. If nothing re-checks, the shape
// underneath stays culled and silently never draws.
//
// A whole-bundle worldMatrix is safe (an affine map preserves containment), and streaming
// geometry reverts to drawListUnculled (streamGeometry.js). Per-shape overrides are
// the gap this guards.
//
// Scene: small BLUE square fully inside a large RED square that is drawn AFTER it. Baseline: red
// covers blue, blue is culled. Then, via overrides, make the occluder stop covering:
//   1. visibility 0        — occluder hidden
//   2. localPosition       — occluder moved away
//   3. localScale          — occluder shrunk off the blue
// In each case blue MUST become visible.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const N = 128;

// blue first (underneath), red second (on top, fully covering) — both plain opaque solids.
const SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${N}" height="${N}">` +
  `<rect id="under" x="48" y="48" width="32" height="32" fill="#0000ff"/>` +
  `<rect id="over"  x="24" y="24" width="80" height="80" fill="#ff0000"/>` +
  `</svg>`;

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, createOverrideTable } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders = await loadShaders(new URL('/src/shaders/',location.href).href);
const r = createRenderer(gl, shaders, {}); r.setViewport(${N}, ${N});
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)}, { preserveViewport: true }));
r.prepareBundle && r.prepareBundle(bundle);
if (r.awaitLbReady) await r.awaitLbReady(bundle);
const ov = createOverrideTable(gl, bundle);
// The general containment cull runs OFF-THREAD (bundle.js:800 requestOcclusionCull) and only the
// cheap 'coincident' pass runs inline at build. Wait for the full pass to land, or this test is
// vacuous — the shape under the occluder is not culled until then.
for (let i = 0; i < 400 && !(bundle._cullGen > 0); i++) await new Promise(r => setTimeout(r, 10));

// Color at the center — where the blue square lives, under the red one.
const center = () => {
  const px = new Uint8Array(4);
  gl.readPixels(${N >> 1}, ${N >> 1}, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  if (px[2] > 180 && px[0] < 80) return 'blue';
  if (px[0] > 180 && px[2] < 80) return 'red';
  if (px[0] > 200 && px[1] > 200 && px[2] > 200) return 'white';
  return 'other(' + px[0] + ',' + px[1] + ',' + px[2] + ')';
};
const paint = (useOv) => {
  r.beginFrame([1,1,1,1]);
  r.drawBundle(bundle, useOv ? { overrides: ov } : {});
  r.endFrame();
  return center();
};
const out = {};
// GUARD AGAINST A VACUOUS TEST: if the cull never fired, every assertion below passes for the
// wrong reason. Require that 'under' really was culled out of the draw list.
out.culled = Array.from(bundle._culledShapes || []);
out.numShapes = bundle.numShapes;
out.drawListLen = bundle.drawList ? bundle.drawList.length : -1;
out.unculledLen = bundle.drawListUnculled ? bundle.drawListUnculled.length : -1;
out.baseline = paint(false);                       // red on top => 'red'
// The occluder is CULLED-AWAY-FROM in three different ways; blue must appear each time.
ov.set('over', { visibility: 0 });                 out.hidden = paint(true);
ov.set('over', { localPosition: [200, 200] });     out.moved  = paint(true);
ov.set('over', { localScale: [0.05, 0.05] });      out.shrunk = paint(true);
ov.set('over', {});                                out.restored = paint(true);   // back to covering
// Whole-bundle transform is affine => containment preserved => culling stays valid.
r.beginFrame([1,1,1,1]);
r.drawBundle(bundle, { worldMatrix: [1,0,0, 0,1,0, 0,0,1] });
r.endFrame();
out.worldMatrixIdentity = center();
window.__out = out; window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  try {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }
    const p = decodeURIComponent(req.url.split('?')[0]);
    res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[page-err]', e.message));
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 60000 });
// 120s: the page waits on the ASYNC occlusion cull, which is real CPU-bound
// work rather than navigation.
//
// A timeout here is not by itself a renderer defect. This smoke is
// memory-heavy, and on a host under memory pressure it slows by more than an
// order of magnitude while light smokes stay at 1-2s — it then fails at any
// timeout. Check free swap first.
await page.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 100 });
const out = await page.evaluate(() => window.__out);
await browser.close();
server.close();

let fail = 0;
console.log(
  `  cull state: culledShapes=[${out.culled}] of ${out.numShapes} shapes; ` +
    `drawList=${out.drawListLen} vs unculled=${out.unculledLen}`,
);
if (!out.culled.length) {
  console.log(
    'FAIL the occlusion cull never fired — this test would pass vacuously. ' +
      'Make the occluder cover the shape more decisively, or the guard below proves nothing.',
  );
  process.exit(1);
}
const expect = (name, got, want, why) => {
  if (got === want) console.log('ok', name, '=', got);
  else {
    console.log(`FAIL ${name} — got ${got}, want ${want}${why ? ' (' + why + ')' : ''}`);
    fail++;
  }
};
expect('baseline: occluder covers', out.baseline, 'red');
expect(
  'occluder hidden by override → covered shape appears',
  out.hidden,
  'blue',
  'the shape under a now-invisible occluder is still culled',
);
expect(
  'occluder moved by override → covered shape appears',
  out.moved,
  'blue',
  'the shape under a now-moved occluder is still culled',
);
expect(
  'occluder shrunk by override → covered shape appears',
  out.shrunk,
  'blue',
  'the shape under a now-shrunken occluder is still culled',
);
expect('override cleared → occluder covers again', out.restored, 'red');
expect('whole-bundle worldMatrix keeps culling valid', out.worldMatrixIdentity, 'red');

if (fail) {
  console.log(`\nOCCLUSION-CULL-OVERRIDE FAIL (${fail})`);
  process.exit(1);
}
console.log('\nOCCLUSION-CULL-OVERRIDE PASS');
