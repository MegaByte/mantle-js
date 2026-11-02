// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cacheLbParitySmoke.mjs — a CACHED bake of an LB-routed bundle must be
// pixel-identical to that bundle's DIRECT (uncached) draw.
//
// bundleHandleCacheSmoke only compares Slug-to-Slug: its bundles are tiny
// rects, which never take the analytic (Loop-Blinn) route. Big curved content
// DOES route to LB, and LB draws into whatever framebuffer is bound — so a bake
// has to reproduce it exactly. A baked RT that keeps LB's interior triangles
// but LOSES the curve-bulge triangles leaves the fill missing in a band ALONG
// each curve (a wavy ridge bakes with the region between its chord and its
// curved top left unpainted, showing whatever is behind it).
//
// Shape: two overlapping wavy "hills" (a teal one behind, a green one in
// front) — exactly the parallax-background content that surfaced this. If the
// front hill's curve band is dropped, the teal behind shows through and the
// diff explodes.

import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

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
const port = server.address().port;
const url = `http://127.0.0.1:${port}/mantleDemo.html`;

// Two big wavy ridges. Deep cubic bulges so the curve-band triangles cover a
// lot of pixels — a dropped band is then unmissable rather than a hairline.
const SVG = readFileSync(
  new URL('../examples/smoke/cacheLbParity__SVG.svg', import.meta.url),
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

const results = await page.evaluate(async (svg) => {
  const { importSvg, createBundle, CacheStrategy } = await import('/src/index.js');
  const gl = window.__mantleGl;
  const renderer = window.__mantleRenderer;
  // Asks for LB EXPLICITLY. This smoke is about the LB machinery, not about
  // whether 'auto' would choose it, and keeping the two apart means a future
  // routing change cannot silently make it vacuous.
  renderer.setLoopBlinnFill('on');
  const cnv = document.getElementById('glcanvas');
  cnv.width = 400;
  cnv.height = 400;

  const shot = () => {
    const w = cnv.width,
      h = cnv.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  };

  const asset = await importSvg(svg);

  // DIRECT: no cache. This is the reference — what the user sees today.
  const bDirect = createBundle(gl, asset);
  const hDirect = renderer.createBundleHandle(bDirect);
  await renderer.awaitLbReady(bDirect);
  const lbRouted = Array.isArray(bDirect._lbMeshes) && bDirect._lbMeshes.length > 0;
  renderer.beginFrame([1, 1, 1, 1]);
  hDirect.draw();
  renderer.endFrame();
  const direct = shot();

  // CACHED: same content, forced through a bake + blit.
  const bCached = createBundle(gl, asset);
  const hCached = renderer.createBundleHandle(bCached, {
    staticCache: { strategy: CacheStrategy.ForceWholeAsset },
  });
  await renderer.awaitLbReady(bCached);
  renderer.beginFrame([1, 1, 1, 1]);
  hCached.draw(); // bake + blit
  renderer.endFrame();
  renderer.beginFrame([1, 1, 1, 1]);
  hCached.draw(); // blit the reused bake
  renderer.endFrame();
  const cached = shot();

  // Count pixels that differ materially. An LB curve band dropped from the
  // bake shows up as thousands of px, not as AA noise on a few hundred.
  let diff = 0,
    worst = 0;
  for (let i = 0; i < direct.length; i += 4) {
    const d = Math.max(
      Math.abs(direct[i] - cached[i]),
      Math.abs(direct[i + 1] - cached[i + 1]),
      Math.abs(direct[i + 2] - cached[i + 2]),
    );
    if (d > 16) diff++;
    if (d > worst) worst = d;
  }

  hDirect.dispose();
  hCached.dispose();
  bDirect.dispose();
  bCached.dispose();
  return { lbRouted, diff, worst, total: direct.length / 4 };
}, SVG);

console.log(
  `  lbRouted=${results.lbRouted} diff=${results.diff}/${results.total}px worst=${results.worst}`,
);

if (!results.lbRouted)
  fail('bundle did NOT route to LB — this smoke is not exercising the LB bake path');
else ok('bundle routes to LB');

// AA/rounding between a bake+blit and a direct draw can legitimately differ on
// a handful of edge pixels; a dropped curve band cannot hide in that budget.
if (results.diff > 400)
  fail(
    `cached bake differs from direct draw on ${results.diff}px (curve-band fill lost in the bake?)`,
  );
else ok(`cached bake matches direct draw (${results.diff}px differ)`);

await browser.close();
server.close();
console.log(failures ? `\nFAILURES: ${failures}` : '\nPASS');
process.exit(failures ? 1 : 0);
