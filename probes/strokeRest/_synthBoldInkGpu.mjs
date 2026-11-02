// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _synthBoldInkGpu — render the synthetically bolded run on the GPU and count the ink.
//
//   GPU=1 node probes/strokeRest/_synthBoldInkGpu.mjs > padded.txt
//   (make emitShape in src/svg/buildContext.js size the stroke row from the path box: band pad 0,
//    cover-quad pad 0, path-tight meta bbox)
//   GPU=1 node probes/strokeRest/_synthBoldInkGpu.mjs > tight.txt
//   git checkout -- src/svg/buildContext.js
//
// _synthBoldInk.mjs predicts the DIFFERENCE from the CPU on "Hamburg" at 96 px per em, weight 700,
// with every glyph row's meta bbox growing by halfW = 1.92 px on each side. This renders the same
// run and reports the ink, so the two trees can be subtracted.
//
// REFERENCE: the difference is 724.0 device px at 96 px/em and 3,548.4 at 192, on a 0.000 A/A floor,
// byte-identical across Slug, Loop-Blinn and CPatch; the model says 746.6 and 3,548.8. See README.md
// for the model and test/synthBoldInkModelSmoke.mjs for the pin. A re-run that does not reproduce
// these is either a different placement or a real change in what the draw paints.
//
// THE DRAW CANNOT USE THE DEFAULT FIT. The bbox accumulator emitShape unions into is the PATH box,
// so the ink the padding adds lies OUTSIDE the bundle's globalBBox — and setViewport + drawBundle
// fit that box to the canvas, which would cut exactly the pixels being counted on whichever axis
// fills. The draw therefore goes through dstRect into an inset rect with clipToRect off.
import { readFileSync, existsSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../../test/_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE = path.join(ROOT, 'test/font/fixtures/roboto-regular.ttf');
if (!existsSync(FIXTURE)) {
  console.log('SKIP — roboto fixture not fetched (node scripts/fetchTestFixtures.mjs)');
  process.exit(0);
}
const N = +(process.env.N || 1024);
const TEXT = process.env.TEXT || 'Hamburg';
const PX = +(process.env.PX || 96);
const INSET = 64;

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { createBundle, createRenderer, loadShaders } from '/src/index.js';
import { MantleFontAsset } from '/src/font/fontAsset.js';
import { buildTextSections } from '/src/font/textSections.js';
const cv = document.getElementById('c');
const gl = cv.getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const N = ${N}, INSET = ${INSET};
const ttf = new Uint8Array(await (await fetch('/test/font/fixtures/roboto-regular.ttf')).arrayBuffer());
const ROUTE = { slug: 'none', lb: 'lb', cpatch: 'cpatch' };
window.__run = async (text, px, engine) => {
  const r = createRenderer(gl, shaders, { cpatchFill: engine === 'cpatch' });
  await r.ready;
  r.setFillEngine({ route: ROUTE[engine] });
  const font = new MantleFontAsset(ttf);
  const { sections } = await buildTextSections(font, text, { fontSizePx: px, weight: 700, fill: [0, 0, 0, 1] }, false);
  const b = createBundle(gl, sections);
  if (r.prepareBundle) r.prepareBundle(b);
  if (r.awaitLbReady) await r.awaitLbReady(b);
  r.setViewport(N, N); gl.viewport(0, 0, N, N);
  // ONE EM MUST BE EXACTLY px DEVICE PIXELS, or the prediction (which is an AREA) has to be
  // rescaled by the square of whatever scale the fit chose. globalBBox is in em, so the rect is
  // the box at px per em, placed with fit 'none' so no aspect letterboxing changes it.
  const gb = b.globalBBox;
  const opts = { dstRect: [INSET, INSET, gb[2] * px, gb[3] * px], fit: 'none', clipToRect: false };
  r.beginFrame([1, 1, 1, 1]); r.drawBundle(b, opts); r.endFrame();
  const p = new Uint8Array(N * N * 4);
  gl.readPixels(0, 0, N, N, gl.RGBA, gl.UNSIGNED_BYTE, p);
  // Ink = how far each pixel is from the white ground, summed. Black text on white, so this is
  // the rendered coverage and it is directly comparable between two trees at the same placement.
  let ink = 0, lit = 0, x0 = N, y0 = N, x1 = -1, y1 = -1;
  for (let i = 0, q = 0; i < p.length; i += 4, q++) {
    const d = (255 - p[i]) / 255;
    if (d > 0) {
      ink += d; lit++;
      const x = q % N, y = (N - 1 - ((q / N) | 0));
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  const st = r.debugStats || {};
  const M = r.bundleDrawMatrix ? Array.from(r.bundleDrawMatrix(b, opts) || []) : null;
  const bb = Array.from(b.globalBBox || []);
  const out = { ink, lit, box: x1 < 0 ? null : [x0, y0, x1 - x0 + 1, y1 - y0 + 1], bb, M,
    rows: b.numShapes | 0,
    draws: st.engines ? st.engines.draws : null, last: st.engines ? st.engines.last : null,
    px: Array.from(p) };
  b.dispose();
  return out;
};
window.__ready = true;
</script></body></html>`;

const TYPES = { '.glsl': 'text/plain', '.ttf': 'font/ttf', '.otf': 'font/otf' };
const server = http.createServer((q, res) => {
  try {
    if (q.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(HTML);
      return;
    }
    const pp = decodeURIComponent(q.url.split('?')[0]);
    const ext = path.extname(pp);
    res.writeHead(200, { 'content-type': TYPES[ext] || 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, pp)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const br = await launchBrowser(
  process.env.GPU === '1'
    ? { headless: 'new', args: ['--no-sandbox', '--use-angle=metal', '--enable-gpu'] }
    : { headless: 'new', args: ['--no-sandbox'] },
);
const pg = await br.newPage();
pg.on('pageerror', (e) => console.error(' [err]', String(e.message).slice(0, 300)));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 90000 });
await pg.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 50 });

console.log(
  `"${TEXT}" at ${PX} px per em, weight 700, ${N}x${N}, dstRect = globalBBox * ${PX} at` +
    ` inset ${INSET}px, fit none, clipToRect off — so one em is exactly ${PX} device pixels`,
);
const dumps = {};
for (const engine of ['slug', 'lb', 'cpatch']) {
  const R = await pg.evaluate((t, p, e) => window.__run(t, p, e), TEXT, PX, engine);
  dumps[engine] = R.px;
  console.log(
    `  ${engine.padEnd(7)} ink ${R.ink.toFixed(1).padStart(10)}  lit px ${String(R.lit).padStart(7)}` +
      `  ink box ${JSON.stringify(R.box)}  rows ${R.rows}  draws ${JSON.stringify(R.draws)}`,
  );
  console.log(`          globalBBox ${JSON.stringify(R.bb.map((v) => +v.toFixed(2)))}`);
}
// A/A: the same engine twice, so a tree-to-tree difference smaller than this floor is not evidence.
const again = await pg.evaluate((t, p, e) => window.__run(t, p, e), TEXT, PX, 'slug');
let aa = 0;
for (let i = 0; i < again.px.length; i += 4) aa += Math.abs(again.px[i] - dumps.slug[i]) / 255;
console.log(`  A/A control (slug rendered twice): ${aa.toFixed(3)} ink of difference`);

if (process.env.SAVE) {
  const { writeFileSync } = await import('fs');
  writeFileSync(process.env.SAVE, JSON.stringify({ slug: dumps.slug }));
  console.log(`  wrote ${process.env.SAVE}`);
}
await br.close();
server.close();
