// filterCacheHitSmoke.mjs — a filter-cache HIT must paint what the MISS painted.
//
// The filter graph is evaluated once and its root stashed in a per-graph texture;
// every later draw with the same key skips the evaluation and composites that
// texture instead. Two code paths, one expected image — and nothing tested that
// they agreed.
//
// It matters more now that the cached texture is sized to the filter's BBOX rather
// than to the canvas: the hit path has to remember WHERE on the canvas that texture
// belongs and composite it back there. Store the rect and drop it (or store it and
// ignore it) and the cached frame lands in the corner, or scaled — and only from the
// second frame on, which is exactly the kind of bug that reaches a game and not a
// test suite.
//
// So: draw the same filtered card twice. Frame 1 evaluates the graph (miss), frame 2
// composites the cache (hit). The frames must be identical.

import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(u.pathname === '/' ? '/mantleDemo.html' : u.pathname);
  const m = p.endsWith('.html') ? 'text/html'
    : (p.endsWith('.js') || p.endsWith('.mjs')) ? 'text/javascript'
    : p.endsWith('.glsl') ? 'text/plain' : 'application/octet-stream';
  try { res.writeHead(200, { 'content-type': m + '; charset=utf-8' }); res.end(readFileSync(path.join(ROOT, p))); }
  catch { try { res.writeHead(404); res.end(); } catch {} }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/mantleDemo.html`;

// A drop shadow decomposes to feGaussianBlur → feOffset → feFlood → feComposite →
// feMerge: five nodes, five rects, none of them the canvas.
const CARD = readFileSync(new URL('../examples/smoke/filterCacheHit__CARD.svg', import.meta.url), 'utf8');

let failures = 0;
const fail = (m) => { failures++; console.error('FAIL', m); };
const ok = (m) => console.log('ok', m);

const browser = await puppeteer.launch({
  headless: 'new', args: ['--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 500, height: 500 });
page.on('pageerror', e => console.error('  [page-err]', e.message));
await page.goto(url, { waitUntil: 'load', timeout: 20000 });
await page.waitForFunction(() => window.__mantleRenderer && window.__mantleGl, { timeout: 20000 });

const res = await page.evaluate(async (svg) => {
  const { importSvg, createBundle } = await import('/src/index.js');
  const gl = window.__mantleGl;
  const renderer = window.__mantleRenderer;
  const cnv = document.getElementById('glcanvas');
  // A big canvas and a small card — the shape the bbox RTs are for, and the shape
  // that makes a mis-placed cache texture obvious.
  const W = 900, H = 1100;
  cnv.width = W; cnv.height = H;
  const WM = [0.5, 0, 0, 0, 0.5, 0, 0.15, 0.2, 1];

  const asset = await importSvg(svg);
  const b = createBundle(gl, asset);
  const h = renderer.createBundleHandle(b);

  const shot = () => {
    const px = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  };
  const frame = () => {
    renderer.beginFrame([1, 1, 1, 1]);
    h.draw({ worldMatrix: WM });
    renderer.endFrame();
    return shot();
  };

  const miss = frame();   // evaluates the graph
  const evalsAfterMiss = renderer.debugStats.filterEvalCount;
  const hit = frame();    // must come off the cache
  const evalsAfterHit = renderer.debugStats.filterEvalCount;

  let diff = 0, worst = 0, ink = 0;
  for (let i = 0; i < miss.length; i += 4) {
    // Non-white = the card + its shadow. Guards against both frames being blank.
    if (miss[i] < 250 || miss[i + 1] < 250 || miss[i + 2] < 250) ink++;
    const d = Math.max(
      Math.abs(miss[i] - hit[i]), Math.abs(miss[i + 1] - hit[i + 1]),
      Math.abs(miss[i + 2] - hit[i + 2]), Math.abs(miss[i + 3] - hit[i + 3]));
    if (d > 0) diff++;
    if (d > worst) worst = d;
  }
  h.dispose(); b.dispose();
  return { diff, worst, ink, total: W * H, evalsAfterMiss, evalsAfterHit };
}, CARD);

console.log(`  ink ${res.ink}px   graph evals: ${res.evalsAfterMiss} after miss, ${res.evalsAfterHit} after hit`);

if (res.ink < 1000) {
  fail(`the card barely rendered (${res.ink}px of ink) — this smoke would pass on a blank frame`);
} else {
  ok(`the filtered card rendered (${res.ink}px of ink)`);
}
if (res.evalsAfterMiss < 1) {
  fail(`frame 1 never evaluated a filter graph (${res.evalsAfterMiss} evals) — the card `
     + `isn't taking the graph path at all, so nothing below is testing the filter cache`);
} else if (res.evalsAfterHit !== res.evalsAfterMiss) {
  fail(`frame 2 re-evaluated the graph (${res.evalsAfterMiss} → ${res.evalsAfterHit}) — `
     + `it never took the cache HIT, so this smoke is comparing two misses and proves nothing`);
} else {
  ok('frame 2 took the cache hit (no second graph evaluation)');
}
if (res.diff > 0) {
  fail(`the cache HIT does not match the MISS — ${res.diff}px differ (worst ${res.worst}). `
     + `The cached texture is sized to the filter's bbox; the hit path has to composite it `
     + `back at that rect, not at the canvas origin and not stretched to the canvas.`);
} else {
  ok('cache hit is byte-identical to the miss (0px differ)');
}

await browser.close();
server.close();
console.log(failures ? `\nFAILURES: ${failures}` : '\nFILTER-CACHE-HIT PASS');
process.exit(failures ? 1 : 0);
