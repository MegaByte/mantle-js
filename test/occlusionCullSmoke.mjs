// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// occlusionCullSmoke.mjs — a shape a later OPAQUE shape fully covers must not
// bleed through the antialiased boundary.
//
// A fully-occluded shape is invisible everywhere EXCEPT along a shared edge, where
// painter compositing blends each shape's coverage independently and the hidden
// color gets mixed in a second time:
//
//     truth   c·J + (1−c)·bg
//     bug     c·J + (1−c)·[ c·I + (1−c)·bg ]     ← I bleeds through
//
// Parallax-hill art that stacks two identical gold ridges and lays a 60%-alpha
// mint ridge over them would grow a gold fringe on every ridge, which reads as
// "the AA is too dark". createBundle drops such shapes
// (occlusionCull.js) — which also removes a draw.
//
// The hidden layer here is PURE RED under a gold occluder under a translucent mint,
// so the composite is green and ANY red is a leak — no thresholds to argue about.
//
// Assertions:
//   1. The occluded shape is dropped from the draw list.
//   2. No red leaks — on Slug AND on Loop-Blinn.
//   3. With opts.occlusionCull === false the red DOES leak. Without this the smoke
//      could pass on a renderer that cannot leak at all, and prove nothing.
//   4. A shape that is NOT fully covered is never culled (correctness guard).

import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { emitFixture } from './_fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function mime(p) {
  if (p.endsWith('.html')) return 'text/html; charset=utf-8';
  if (p.endsWith('.js') || p.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (p.endsWith('.svg')) return 'image/svg+xml; charset=utf-8';
  if (p.endsWith('.glsl')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(u.pathname === '/' ? '/mantleDemo.html' : u.pathname);
  try {
    res.writeHead(200, { 'content-type': mime(p) });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    try {
      res.writeHead(404);
      res.end();
    } catch {}
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/mantleDemo.html`;

// HIDDEN (red) shares its whole curved top edge with the OCCLUDER (gold) and stops
// short at the bottom — a strict subset, exactly the hills' layering. MINT at 60%
// sits on top so the visible composite is green.
const RIDGE_TOP = 'M0,150 Q100,110 200,140 Q300,170 400,130';
const HIDDEN = `${RIDGE_TOP} L400,300 L0,300 Z`;
const OCCLUDER = `${RIDGE_TOP} L400,400 L0,400 Z`;
const SVG = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">
  <path d="${HIDDEN}"   fill="#ff0000"/>
  <path d="${OCCLUDER}" fill="#DEBD4F"/>
  <path d="${OCCLUDER}" fill="#B2F2D9" fill-opacity="0.6"/>
</svg>`;
emitFixture('occlusionCull__SVG', SVG);
// A shape that pokes OUT of the would-be occluder must survive.
const NOT_COVERED = readFileSync(
  new URL('../examples/smoke/occlusionCull__NOT_COVERED.svg', import.meta.url),
  'utf8',
);

let failures = 0;
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};
const ok = (m) => console.log('ok', m);

const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 400, height: 400 });
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
await page.goto(url, { waitUntil: 'load', timeout: 20000 });
await page.waitForFunction(() => window.__mantleRenderer && window.__mantleGl, {
  timeout: 20000,
  polling: 100,
});

// A sheet with a small window, off every sample of the covered shape: the layer behind must show through it (a smoke that reads the picture, on each engine).
const WINDOW = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">
  <rect width="400" height="400" fill="#ff0000"/>
  <path fill-rule="evenodd" fill="#0000ff" d="M0 0H400V400H0Z M190 190H210V210H190Z"/>
</svg>`;
emitFixture('occlusionCull__WINDOW', WINDOW);

const results = await page.evaluate(
  async (svg, notCovered, windowSvg) => {
    const { importSvg, createBundle } = await import('/src/index.js');
    const gl = window.__mantleGl;
    const renderer = window.__mantleRenderer;
    const cnv = document.getElementById('glcanvas');
    const W = 800,
      H = 800;
    cnv.width = W;
    cnv.height = H;

    // The composite is mint-over-gold (green: r < g). Any pixel with r > g is the
    // hidden RED layer leaking through the antialiased boundary.
    const redLeak = () => {
      const px = new Uint8Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let leaked = 0,
        worst = 0;
      for (let i = 0; i < px.length; i += 4) {
        if (px[i] > 250 && px[i + 1] > 250 && px[i + 2] > 250) continue; // white bg
        const rn = px[i] - px[i + 1];
        if (rn > 4) leaked++;
        if (rn > worst) worst = rn;
      }
      return { leaked, worst };
    };

    // AAC is fixed at renderer construction, so build one lazily for that case.
    let _aacR = null;
    const aacRenderer = async () => {
      if (_aacR) return _aacR;
      const { createRenderer } = await import('/src/index.js');
      _aacR = createRenderer(gl, window.__mantleShaderSources, { aacFill: true });
      return _aacR;
    };

    const run = async (src, engine, cull) => {
      // Set the engine BEFORE createBundle: the LB mesh build is kicked off at bundle
      // creation using the mode in force at that moment, so setting it afterwards
      // leaves the bundle with no meshes and the LB assertions silently vacuous.
      // 'aac' = the analytic-area coverage engine inside the Slug cover-quad pass. It is
      // a RENDERER option, so that case gets its own renderer on the same canvas.
      const R = engine === 'aac' ? await aacRenderer() : renderer;
      R.setLoopBlinnFill(engine === 'aac' ? 'off' : engine);
      const asset = await importSvg(src);
      const b = createBundle(gl, asset, cull ? undefined : { occlusionCull: false });
      const h = R.createBundleHandle(b);
      if (engine === 'on') await R.awaitLbReady(b);
      R.beginFrame([1, 1, 1, 1]);
      h.draw();
      R.endFrame();
      const leak = redLeak();
      const draws = b.drawList.filter((o) => o.kind === 'fillShape').length;
      const shapes = b.numShapes;
      const lbRouted = Array.isArray(b._lbMeshes) && b._lbMeshes.length > 0;
      const center = new Uint8Array(4);
      gl.readPixels(W / 2, H / 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, center);
      h.dispose();
      b.dispose();
      return { ...leak, draws, shapes, lbRouted, center: Array.from(center) };
    };

    return {
      slugCull: await run(svg, 'off', true),
      lbCull: await run(svg, 'on', true),
      lbNoCull: await run(svg, 'on', false),
      notCovered: await run(notCovered, 'off', true),
      windowSlug: await run(windowSvg, 'off', true),
      windowLb: await run(windowSvg, 'on', true),
      // LAST: creating a renderer takes ownership of the global LB builder, so an
      // AAC renderer built earlier would strand awaitLbReady above.
      aacCull: await run(svg, 'aac', true),
    };
  },
  SVG,
  NOT_COVERED,
  WINDOW,
);

const { slugCull, aacCull, lbCull, lbNoCull, notCovered, windowSlug, windowLb } = results;
console.log(
  `  cull ON : draws ${slugCull.draws}/${slugCull.shapes}  redLeak slug=${slugCull.leaked}px lb=${lbCull.leaked}px`,
);
console.log(
  `  cull OFF: draws ${lbNoCull.draws}/${lbNoCull.shapes}  redLeak lb=${lbNoCull.leaked}px (worst r−g ${lbNoCull.worst})`,
);

if (slugCull.draws !== slugCull.shapes - 1)
  fail(`the occluded shape was NOT dropped (${slugCull.draws} draws of ${slugCull.shapes} shapes)`);
else ok(`the occluded shape is dropped from the draw list (${slugCull.draws}/${slugCull.shapes})`);

if (slugCull.leaked > 0)
  fail(`Slug: the hidden shape bleeds through the AA edge on ${slugCull.leaked}px`);
else ok('Slug: no bleed through the AA edge');

// The cull drops the shape from the DRAW LIST, so it never reaches any engine — the
// win is identical for Slug, AAC and LB, and costs the pixel shader nothing.
if (aacCull.draws !== aacCull.shapes - 1)
  fail(`AAC: the occluded shape was NOT dropped (${aacCull.draws}/${aacCull.shapes})`);
else if (aacCull.leaked > 0)
  fail(`AAC: the hidden shape bleeds through the AA edge on ${aacCull.leaked}px`);
else ok('AAC: shape dropped, no bleed through the AA edge');

if (!lbCull.lbRouted)
  fail('the bundle did NOT route to LB — the LB half of this smoke proves nothing');
else if (lbCull.leaked > 0)
  fail(`LB: the hidden shape bleeds through the AA edge on ${lbCull.leaked}px`);
else ok('LB: no bleed through the AA edge');

// The bug must actually be reachable, or the assertions above are vacuous.
if (lbNoCull.leaked === 0)
  fail('occlusionCull:false did NOT reproduce the bleed — this smoke cannot detect the bleed');
else ok(`occlusionCull:false still bleeds (${lbNoCull.leaked}px) — the smoke has teeth`);

if (notCovered.draws !== notCovered.shapes)
  fail(`a shape that is NOT fully covered got culled (${notCovered.draws}/${notCovered.shapes})`);
else ok('a shape that is not fully covered survives');

for (const [name, w] of [
  ['Slug', windowSlug],
  ['LB', windowLb],
]) {
  const [r, g, b] = w.center;
  if (w.draws !== w.shapes)
    fail(
      `${name}: a sheet with a small window culled the layer behind it (${w.draws}/${w.shapes})`,
    );
  else if (!(r > 250 && g < 5 && b < 5))
    fail(`${name}: the window does not show the layer behind it: rgb ${r},${g},${b}`);
  else ok(`${name}: the window shows the layer behind it`);
}

await browser.close();
server.close();
console.log(failures ? `\nFAILURES: ${failures}` : '\nPASS');
process.exit(failures ? 1 : 0);
