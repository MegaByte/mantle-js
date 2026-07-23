// lbSentinelDeferralSmoke — the one-draw combined route may DEFER loop/cusp
// sentinel shapes (drawn via Slug) past the combined LB draw, but only when that
// cannot change the picture.
//
// A sentinel moved later in paint order is a no-op for every shape it does not
// overlap. So:
//   DISJOINT   sentinel + a later LB shape that misses it  → combined route taken,
//              sentinel deferred, pixels identical to all-Slug.
//   OVERLAPPED sentinel with a later LB shape ON TOP of it → deferring would paint
//              the sentinel over that shape. Must BAIL to the per-shape route, and
//              the pixels must still match all-Slug.
//
// The second case is the one that matters: it is the only thing standing between
// this optimization and a silent painter-order corruption. It asserts on the pixel
// where the later LB shape covers the sentinel — under a wrong deferral that pixel
// takes the sentinel's colour instead of the top shape's.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { emitFixture } from './_fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const N = 200;

// A SELF-INTERSECTING (loop) cubic is the Slug sentinel in both scenes.
//
// This used to be a CUSP cubic — until svg/path.js started splitting cubics at their cusp, so
// a cusp is now an ordinary segment endpoint and LB builds a real analytic mesh for it (this
// smoke caught that: it went red because its "sentinel" had stopped being one, which is the
// good news). A loop cubic still defeats the CDT and still falls back, so the deferral
// machinery this smoke exists to protect is still reachable, and still tested.
const SENTINEL = (fill) => `<path d="M 70 120 C 170 40, 30 40, 130 120 Z" fill="${fill}"/>`;

// (a) sentinel first, later LB diamond BELOW it — disjoint bboxes.
// NB: the sentinel's bbox is its CONTROL HULL (x 30..170, y 40..120), not the outline's, so
// the diamond is separated in Y — no x is far enough clear of the hull inside the viewBox.
const SVG_DISJOINT = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${N}" height="${N}">
  ${SENTINEL('#3366cc')}
  <path d="M100 145 L140 175 L100 195 L60 175 Z" fill="#cc3333"/>
</svg>`;
emitFixture('lbSentinelDeferral__SVG_DISJOINT', SVG_DISJOINT);

// (b) sentinel first, later LB square sitting ON TOP of it — bboxes overlap.
const SVG_OVERLAP = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${N}" height="${N}">
  ${SENTINEL('#3366cc')}
  <path d="M55 55 L145 55 L145 115 L55 115 Z" fill="#cc3333"/>
</svg>`;
emitFixture('lbSentinelDeferral__SVG_OVERLAP', SVG_OVERLAP);

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
const N = ${N};
const readAll = () => { const px = new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,px); return Array.from(px); };
const at = (px, x, yTop) => { const o = ((N-1-yTop)*N + x)*4; return [px[o], px[o+1], px[o+2]]; };

window.__run = async (svg) => {
  const bundle = createBundle(gl, await importSvg(svg));
  renderer.prepareBundle(bundle);
  const draw = () => { renderer.setViewport(N,N); renderer.beginFrame([0,0,0,1]); renderer.drawBundle(bundle, {}); renderer.endFrame(); };

  renderer.setLoopBlinnFill(false); draw(); const slug = readAll();
  renderer.setLoopBlinnFill('on');  draw(); const lb   = readAll();

  // LB and Slug legitimately disagree by a few LSBs on AA edge pixels, so compare
  // the MEAN channel difference (as lbPerShapeFallbackParitySmoke does), not maxima.
  let maxDiff = 0, sum = 0, nBig = 0;
  for (let i = 0; i < slug.length; i++) {
    const d = Math.abs(slug[i] - lb[i]);
    if (d > maxDiff) maxDiff = d;
    if (d > 64) nBig++;
    sum += d;
  }
  const meanDiff = sum / slug.length;
  return {
    hasSlug: !!bundle._lbHasSlug,
    combined: !!bundle._lbCombined,
    deferred: (bundle._lbDeferredSlug || []).length,
    maxDiff, meanDiff, nBig,
    // centre of the overlap scene: the later red square must win there
    centreLb: at(lb, 100, 100), centreSlug: at(slug, 100, 100),
  };
};
window.__ready = true;
</script></body></html>`;

const server = http.createServer((q, res) => {
  try {
    if (q.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); return; }
    const pp = decodeURIComponent(q.url.split('?')[0]);
    res.writeHead(200, { 'content-type': pp.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, pp)));
  } catch { if (!res.headersSent) res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const br = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const pg = await br.newPage();
pg.on('pageerror', (e) => console.error(' [err]', e.message));
await pg.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 90000 });
await pg.waitForFunction(() => window.__ready === true, { timeout: 90000 });
const dis = await pg.evaluate((s) => window.__run(s), SVG_DISJOINT);
const ovl = await pg.evaluate((s) => window.__run(s), SVG_OVERLAP);
await br.close(); server.close();

let fail = 0;
const ok = (c, msg) => c ? console.log('  ok ' + msg) : (fail++, console.error('  FAIL ' + msg));

console.log('[disjoint sentinel — deferral is safe]');
ok(dis.hasSlug, 'the self-intersecting loop is a Slug sentinel');
ok(dis.combined, 'combined one-draw route TAKEN (sentinel deferred)');
ok(dis.deferred === 1, `exactly 1 shape deferred (got ${dis.deferred})`);
ok(dis.meanDiff <= 1.0, `pixels match all-Slug (meanDiff=${dis.meanDiff.toFixed(4)}, maxDiff=${dis.maxDiff})`);

console.log('[overlapped sentinel — deferral would corrupt painter order]');
ok(ovl.hasSlug, 'the self-intersecting loop is a Slug sentinel');
ok(!ovl.combined, 'combined route BAILED (must not defer under a later shape)');
ok(ovl.deferred === 0, `nothing deferred (got ${ovl.deferred})`);
ok(ovl.meanDiff <= 1.0, `pixels match all-Slug (meanDiff=${ovl.meanDiff.toFixed(4)}, maxDiff=${ovl.maxDiff})`);
const red = ovl.centreLb[0] > ovl.centreLb[2];
ok(red, `centre shows the LATER red square, not the sentinel (lb=${ovl.centreLb}, slug=${ovl.centreSlug})`);

console.log(fail ? `\nLB-SENTINEL-DEFERRAL FAIL (${fail})` : '\nLB-SENTINEL-DEFERRAL PASS');
process.exit(fail ? 1 : 0);
