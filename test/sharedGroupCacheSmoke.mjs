// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Shared-group cache smoke: handles of the same asset with a matching
// instanceGroupKey share one target. The first member bakes it and siblings
// adopt the result without re-baking.
// Assertions:
//   1. Both handles resolve to CacheLevel.SharedGroup.
//   2. Both handles' cache go valid, sharing ONE group RT (hA.cacheTex ===
//      hB.cacheTex, non-null).
//   3. The second handle finds the GROUP cache valid after the first baked it.
//   4. both handles render the asset's color (the adopting member must blit
//      the shared RT, not render blank) — the failure this guards.

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

const SVG_GREEN = readFileSync(
  new URL('../examples/smoke/sharedGroupCache__SVG_GREEN.svg', import.meta.url),
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
await page.setViewport({ width: 200, height: 200 });
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
page.on('console', (m) => {
  const t = m.text();
  if (/error|fail|warn/i.test(t)) console.log('  [console]', t);
});
await page.goto(url, { waitUntil: 'load', timeout: 10000 });
await page.waitForFunction(() => window.__mantleRenderer && window.__mantleGl, {
  timeout: 10000,
  polling: 100,
});

const results = await page.evaluate(async (svgGreen) => {
  const { importSvg, createBundle, CacheStrategy, CacheLevel } = await import('/src/index.js');
  const gl = window.__mantleGl;
  const renderer = window.__mantleRenderer;
  const cnv = document.getElementById('glcanvas');

  // Two handles of the same asset in one shared cache group.
  const bA = createBundle(gl, await importSvg(svgGreen));
  const bB = createBundle(gl, await importSvg(svgGreen));
  const grp = {
    staticCache: { strategy: CacheStrategy.ForceSharedGroup, instanceGroupKey: 'grp-x' },
  };
  const hA = renderer.createBundleHandle(bA, grp);
  const hB = renderer.createBundleHandle(bB, grp);

  function center() {
    const w = cnv.width,
      h = cnv.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const i = ((h >> 1) * w + (w >> 1)) * 4;
    return [px[i], px[i + 1], px[i + 2]];
  }

  // Frame 1: draw A (owner) — bakes the group RT.
  renderer.beginFrame([1, 1, 1, 1]);
  hA.draw();
  renderer.endFrame();
  const aPixel = center();
  const aLevel = hA.staticCache.resolvedLevel;
  const aValid = hA.staticCache.isCacheValid;

  // Before B draws: the GROUP cache should already be valid (A baked it),
  // even though B's own cache hasn't been touched.
  const bGroupValidBeforeDraw = hB.staticCache.isGroupCacheValid();
  const bOwnValidBeforeDraw = hB.staticCache.isCacheValid;

  // Frame 2: draw B — should ADOPT A's bake and blit the shared RT.
  renderer.beginFrame([1, 1, 1, 1]);
  hB.draw();
  renderer.endFrame();
  const bPixel = center();
  const bLevel = hB.staticCache.resolvedLevel;
  const bValid = hB.staticCache.isCacheValid;

  const sharedRt = !!hA.cacheTex && hA.cacheTex === hB.cacheTex;

  // Resize the backing store. The first member rebuilds and bakes the group
  // target; the stale sibling must adopt it rather than invalidate it or blit
  // the retired target.
  const oldRt = hB.cacheTex;
  cnv.width = 160;
  cnv.height = 120;
  renderer.beginFrame([1, 1, 1, 1]);
  hB.draw();
  renderer.endFrame();
  const resizedBPixel = center();
  const resizedRt = hB.cacheTex;
  renderer.beginFrame([1, 1, 1, 1]);
  hA.draw();
  renderer.endFrame();
  const resizedAPixel = center();
  const sharedAfterResize = !!resizedRt && hA.cacheTex === resizedRt;
  const targetReallocated = !!resizedRt && resizedRt !== oldRt;

  hA.dispose();
  hB.dispose();
  bA.dispose();
  bB.dispose();
  return {
    aPixel,
    aLevel,
    aValid,
    bGroupValidBeforeDraw,
    bOwnValidBeforeDraw,
    bPixel,
    bLevel,
    bValid,
    sharedRt,
    resizedBPixel,
    resizedAPixel,
    sharedAfterResize,
    targetReallocated,
    SharedGroup: CacheLevel.SharedGroup,
  };
}, SVG_GREEN);

await browser.close();
server.close();

// ---- Assertions ----
const r = results;
const near = (a, e, t = 24) =>
  Math.abs(a[0] - e[0]) <= t && Math.abs(a[1] - e[1]) <= t && Math.abs(a[2] - e[2]) <= t;
const GREEN = [0, 200, 0];

if (r.aLevel === r.SharedGroup) ok('owner resolves to SharedGroup');
else fail(`owner level ${r.aLevel} != SharedGroup (${r.SharedGroup})`);
if (r.bLevel === r.SharedGroup) ok('member resolves to SharedGroup');
else fail(`member level ${r.bLevel} != SharedGroup`);
if (near(r.aPixel, GREEN)) ok(`owner A renders green ${JSON.stringify(r.aPixel)}`);
else fail(`A pixel ${JSON.stringify(r.aPixel)} not green`);
if (r.aValid) ok('A cache valid after bake');
else fail('A cache should be valid after its bake');
if (r.bGroupValidBeforeDraw && !r.bOwnValidBeforeDraw)
  ok('B sees the GROUP cache valid (A baked) before its own draw');
else
  fail(
    `B group-valid=${r.bGroupValidBeforeDraw} own-valid=${r.bOwnValidBeforeDraw} before draw (want group-valid, own-invalid)`,
  );
if (near(r.bPixel, GREEN))
  ok(`member B renders green via shared-RT blit ${JSON.stringify(r.bPixel)}`);
else
  fail(
    `B pixel ${JSON.stringify(r.bPixel)} not green — adopting member rendered blank (bake-once/blit-twice broken)`,
  );
if (r.sharedRt) ok('both members share one cache target');
else fail('members did not share the cache target');
if (r.targetReallocated) ok('resize reallocates the shared target');
else fail('resize kept the old shared target');
if (near(r.resizedBPixel, GREEN) && near(r.resizedAPixel, GREEN))
  ok('both members render from the resized shared target');
else
  fail(`resized pixels B=${JSON.stringify(r.resizedBPixel)} A=${JSON.stringify(r.resizedAPixel)}`);
if (r.sharedAfterResize) ok('stale sibling adopts the resized target');
else fail('sibling did not adopt resized target');

console.log(failures ? `\nSHARED-GROUP-CACHE FAIL (${failures})` : '\nSHARED-GROUP-CACHE PASS');
process.exit(failures ? 1 : 0);
