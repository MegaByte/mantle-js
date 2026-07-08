// a3InstanceGroupSmoke.mjs — smoke for the A3 instance-group static cache:
// N handles of the SAME asset that opt into Strategy.ForceA3 with a matching
// instanceGroupKey share ONE cache RT. The first member to draw bakes it (the
// owner); every sibling ADOPTS that bake and blits it without re-baking —
// "bake once, blit twice".
//
// Assertions:
//   1. Both handles resolve to CacheLevel.A3.
//   2. Both handles' cache go valid, sharing ONE group RT (hA.cacheTex ===
//      hB.cacheTex, non-null) — the defining A3 property.
//   3. The second handle finds the GROUP cache valid after the first baked it.
//   4. BOTH handles render the asset's colour (the adopting member must blit
//      the shared RT, not render blank) — the regression this guards.

import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

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
  try { res.writeHead(200, { 'content-type': mime(p) }); res.end(readFileSync(path.join(ROOT, p))); }
  catch { try { res.writeHead(404); res.end(); } catch {} }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const url  = `http://127.0.0.1:${port}/mantleDemo.html`;

const SVG_GREEN = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="0" y="0" width="100" height="100" fill="#00c800"/>
</svg>`;

let failures = 0;
const fail = (m) => { failures++; console.error('FAIL', m); };
const ok   = (m) => console.log('ok', m);

const browser = await puppeteer.launch({
  headless: 'new', args: ['--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 200, height: 200 });
page.on('pageerror', e => console.error('  [page-err]', e.message));
page.on('console', m => { const t = m.text(); if (/error|fail|warn/i.test(t)) console.log('  [console]', t); });
await page.goto(url, { waitUntil: 'load', timeout: 10000 });
await page.waitForFunction(() => window.__mantleRenderer && window.__mantleGl, { timeout: 10000 });

const results = await page.evaluate(async (svgGreen) => {
  const { importSvg, createBundle, CacheStrategy, CacheLevel } = await import('/src/index.js');
  const gl = window.__mantleGl;
  const renderer = window.__mantleRenderer;
  const cnv = document.getElementById('glcanvas');

  // Two handles of the SAME asset, both in the SAME A3 instance group.
  const bA = createBundle(gl, await importSvg(svgGreen));
  const bB = createBundle(gl, await importSvg(svgGreen));
  const grp = { staticCache: { strategy: CacheStrategy.ForceA3, instanceGroupKey: 'grp-x' } };
  const hA = renderer.createBundleHandle(bA, grp);
  const hB = renderer.createBundleHandle(bB, grp);

  function centre() {
    const w = cnv.width, h = cnv.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const i = ((h >> 1) * w + (w >> 1)) * 4;
    return [px[i], px[i + 1], px[i + 2]];
  }

  // Frame 1: draw A (owner) — bakes the group RT.
  renderer.beginFrame([1, 1, 1, 1]);
  hA.draw();
  renderer.endFrame();
  const aPixel = centre();
  const aLevel = hA.staticCache.resolvedLevel;
  const aValid = hA.staticCache.isCacheValid;

  // Before B draws: the GROUP cache should already be valid (A baked it),
  // even though B's OWN cache hasn't been touched.
  const bGroupValidBeforeDraw = hB.staticCache.isGroupCacheValid();
  const bOwnValidBeforeDraw   = hB.staticCache.isCacheValid;

  // Frame 2: draw B — should ADOPT A's bake and blit the shared RT.
  renderer.beginFrame([1, 1, 1, 1]);
  hB.draw();
  renderer.endFrame();
  const bPixel = centre();
  const bLevel = hB.staticCache.resolvedLevel;
  const bValid = hB.staticCache.isCacheValid;

  const sharedRt = !!hA.cacheTex && hA.cacheTex === hB.cacheTex;

  hA.dispose(); hB.dispose(); bA.dispose(); bB.dispose();
  return {
    aPixel, aLevel, aValid,
    bGroupValidBeforeDraw, bOwnValidBeforeDraw,
    bPixel, bLevel, bValid,
    sharedRt, A3: CacheLevel.A3,
  };
}, SVG_GREEN);

await browser.close();
server.close();

// ---- Assertions ----
const r = results;
const near = (a, e, t = 24) => Math.abs(a[0] - e[0]) <= t && Math.abs(a[1] - e[1]) <= t && Math.abs(a[2] - e[2]) <= t;
const GREEN = [0, 200, 0];

if (r.aLevel === r.A3) ok('owner (A) resolves to A3'); else fail(`A level ${r.aLevel} != A3 (${r.A3})`);
if (r.bLevel === r.A3) ok('member (B) resolves to A3'); else fail(`B level ${r.bLevel} != A3`);
if (near(r.aPixel, GREEN)) ok(`owner A renders green ${JSON.stringify(r.aPixel)}`); else fail(`A pixel ${JSON.stringify(r.aPixel)} not green`);
if (r.aValid) ok('A cache valid after bake'); else fail('A cache should be valid after its bake');
if (r.bGroupValidBeforeDraw && !r.bOwnValidBeforeDraw)
  ok('B sees the GROUP cache valid (A baked) before its own draw');
else fail(`B group-valid=${r.bGroupValidBeforeDraw} own-valid=${r.bOwnValidBeforeDraw} before draw (want group-valid, own-invalid)`);
if (near(r.bPixel, GREEN)) ok(`member B renders green via shared-RT blit ${JSON.stringify(r.bPixel)}`);
else fail(`B pixel ${JSON.stringify(r.bPixel)} not green — adopting member rendered blank (bake-once/blit-twice broken)`);
if (r.sharedRt) ok('A and B share ONE group cache RT'); else fail('A.cacheTex !== B.cacheTex — A3 group did not share the RT');

console.log(failures ? `\nA3-INSTANCE-GROUP FAIL (${failures})` : '\nA3-INSTANCE-GROUP PASS');
process.exit(failures ? 1 : 0);
