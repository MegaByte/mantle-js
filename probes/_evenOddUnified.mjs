// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _evenOddUnified — WHERE does the analytic route disagree with Slug on a shape with a HOLE?
//
// FINDING: the failure unifiedFillFeatureSmoke reports as `evenOdd` has nothing to do with the
// fill rule. Loop-Blinn loses the partial-coverage pixel at a hole's boundary — Slug paints it
// 207/255, LB paints 0 — so the hole comes out one pixel too large. It reproduces under NONZERO
// winding just as well as under evenodd, and with a true kappa circle just as well as with the
// test's fatter squircle. The outer boundary of the same shape differs by only 33, which is
// ordinary AA, so this is specific to inner contours.
//
// lbPartition bails proper-holed shapes to a legacy path it describes as pixel-tuned; that is
// where to look. Not fixed here — it is analytic coverage in a delicate area, not a test bug.
//
// unifiedFillFeatureSmoke has failed on `evenOdd` since before this session: 426 px differing at
// worst 192/255, while the CLASSIC analytic route matches Slug exactly (0px). A worst of 192 is
// not antialiasing — that is a region filled by one route and not the other — so the question is
// which region, and whether the unified route adds ink or loses it.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = +(process.env.SIZE || 256);
const D = 'M20 4 C31 4 36 9 36 20 C36 31 31 36 20 36 C9 36 4 31 4 20 C4 9 9 4 20 4 Z';
const INNER =
  'M20 12 C26 12 28 14 28 20 C28 26 26 28 20 28 C14 28 12 26 12 20 C12 14 14 12 20 12 Z';
// the same inner contour traversed the other way, so nonzero sees a hole too
const INNER_REV =
  'M20 12 C14 12 12 14 12 20 C12 26 14 28 20 28 C26 28 28 26 28 20 C28 14 26 12 20 12 Z';

const PAGE = `<!doctype html><body><canvas id=c width=${N} height=${N}></canvas><script type=module>
globalThis.__MANTLE_DEBUG__ = true;   // createRenderer's fillDefines is a test hook, read only under it
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,preserveDrawingBuffer:true,depth:true,stencil:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
// RULE is the discriminator: the same nested pair under evenodd, and under nonzero with the inner
// contour wound the other way. If both lose the hole's boundary pixel, this is hole handling in
// general rather than anything to do with the fill rule.
const RULE = ${JSON.stringify(process.env.RULE || 'evenodd')};
const SHAPE = ${JSON.stringify(process.env.SHAPE || 'squircle')};
// A square ring: every edge STRAIGHT. If the hole's boundary pixel is lost here too, the defect is
// not in the curve kernels at all but in how a hole's interior edge is covered.
const SQR_OUT = 'M4 4 L36 4 L36 36 L4 36 Z', SQR_IN = 'M12 12 L12 28 L28 28 L28 12 Z';
const CIRC_OUT = 'M20 4 C28.8365559972927 4 36 11.163444002707303 36 20 C36 28.8365559972927 28.8365559972927 36 20 36 C11.163444002707303 36 4 28.8365559972927 4 20 C4 11.163444002707303 11.163444002707303 4 20 4 Z', CIRC_IN = 'M20 12 C24.41827799864635 12 28 15.58172200135365 28 20 C28 24.41827799864635 24.41827799864635 28 20 28 C15.58172200135365 28 12 24.41827799864635 12 20 C12 15.58172200135365 15.58172200135365 12 20 12 Z';
const INNER_REV = '${INNER_REV}';
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">'
  + '<path fill="#3060c0" fill-rule="' + RULE + '" d="'
  + (SHAPE === 'square' ? (SQR_OUT + ' ' + SQR_IN)
     : SHAPE === 'circle' ? (CIRC_OUT + ' ' + CIRC_IN)
                        : ('${D} ' + (RULE === 'evenodd' ? '${INNER}' : INNER_REV))) + '"/></svg>';
const shot = async (mode) => {
  const r = createRenderer(gl, shaders, { psoWarmIdle: () => true, fillDefines: ${JSON.stringify(process.env.DEFS ? process.env.DEFS.split(',') : [])} });
  r.setViewport(${N}, ${N});
  r.setLoopBlinnFill(mode === 'slug' ? 'off' : 'on');   // 'on' is what the smoke uses
  const b = createBundle(gl, await importSvg(svg)); r.prepareBundle(b);
  if (r.awaitLbReady) { try { await r.awaitLbReady(b, 20000); } catch {} }
  for (let w = 0; w < 8; w++) { r.beginFrame([1,1,1,1]); r.drawBundle(b, {}); r.endFrame(); }
  const px = new Uint8Array(${N}*${N}*4); gl.readPixels(0,0,${N},${N},gl.RGBA,gl.UNSIGNED_BYTE,px);
  const e = (r.debugStats.engines && r.debugStats.engines.draws) || {};
  return { px, drew: Object.keys(e).filter(k=>e[k]>0).join('+'), uni: r.debugStats.unifiedFillGate };
};
const S = await shot('slug'), U = await shot('unified');
// WHAT LANDS ON THE BOUNDARY PIXEL. MANTLE_LB_FRAGDBG makes each surviving LB fragment add 1/64
// to alpha (so A*64 counts them), sum its kind into R, and flag INTERIOR in B. Cleared to
// TRANSPARENT, as that variant requires — an opaque clear pins alpha at 255.
const dbg = async () => {
  const r = createRenderer(gl, shaders, { psoWarmIdle: () => true,
    fillDefines: ['MANTLE_LB_FILL', 'MANTLE_LB_FRAGDBG ' + (${JSON.stringify(process.env.DBG_THRESH || '0.0')})] });
  r.setViewport(${N}, ${N}); r.setLoopBlinnFill('on');
  const b = createBundle(gl, await importSvg(svg)); r.prepareBundle(b);
  if (r.awaitLbReady) { try { await r.awaitLbReady(b, 20000); } catch {} }
  for (let w = 0; w < 8; w++) { r.beginFrame([0,0,0,0]); r.drawBundle(b, {}); r.endFrame(); }
  const px = new Uint8Array(${N}*${N}*4); gl.readPixels(0,0,${N},${N},gl.RGBA,gl.UNSIGNED_BYTE,px);
  return px;
};
const Dp = await dbg();
const midR = Math.round(${N}*20/40);
const ray = [];
for (let px = 0; px < ${N}/2; px++) {
  const i = ((${N}-1-midR)*${N} + (midR + px))*4;
  ray.push({ r: +(px/8).toFixed(2), frags: Math.round(Dp[i+3]/4), kindSum: Dp[i], interior: Math.round(Dp[i+2]/4),
             slug: 255 - S.px[i], lb: 255 - U.px[i] });
}
// The hole is the middle; sample it and the ring separately so "which region" is answerable.
const at = (p, x, y) => p[((${N}-1-y)*${N}+x)*4];
const mid = Math.round(${N}*20/40), ring = Math.round(${N}*8/40);
let nDiff = 0, worst = 0, addedInHole = 0, lostOnBody = 0;
for (let y = 0; y < ${N}; y++) for (let x = 0; x < ${N}; x++) {
  const i = ((${N}-1-y)*${N}+x)*4, d = Math.abs(S.px[i] - U.px[i]);
  if (d) { nDiff++; if (d > worst) worst = d; }
  // inside the inner contour = the even-odd HOLE
  const dx = x - mid, dy = y - mid, rr = Math.hypot(dx, dy);
  if (rr < ${N}*6/40) { if (U.px[i] < S.px[i] - 8) addedInHole++; }
  else if (rr < ${N}*15/40) { if (U.px[i] > S.px[i] + 8) lostOnBody++; }
}
// WHERE, radially: the inner contour's edge sits at r≈8/40 of the viewBox, the outer at ≈16/40.
// A difference concentrated at one of those is a boundary being drawn in the wrong place; one
// spread everywhere would be a different problem entirely.
const bins = new Array(10).fill(0), binWorst = new Array(10).fill(0);
for (let y = 0; y < ${N}; y++) for (let x = 0; x < ${N}; x++) {
  const i = ((${N}-1-y)*${N}+x)*4, d = Math.abs(S.px[i] - U.px[i]);
  if (!d) continue;
  const rr = Math.hypot(x - mid, y - mid) / (${N}/40);      // radius in viewBox units
  const b = Math.min(9, Math.floor(rr / 2));                 // 2-unit bins
  bins[b]++; if (d > binWorst[b]) binWorst[b] = d;
}
// A radial profile along +x through the centre: coverage as a function of radius says whether an
// edge is DISPLACED (both ramps, offset) or MIS-EVALUATED (one ramp inverted or missing).
const prof = [];
for (let px = 0; px < ${N}/2; px++) {
  const x = mid + px, y = mid;
  const i = ((${N}-1-y)*${N}+x)*4;
  prof.push([+(px / 8).toFixed(2), 255 - S.px[i], 255 - U.px[i]]);
}
window.__out = { ray, prof, bins, binWorst, drewSlug: S.drew, drewUni: U.drew, gate: U.uni, nDiff, worst,
  addedInHole, lostOnBody,
  holeSlug: at(S.px, mid, mid), holeUni: at(U.px, mid, mid),
  bodySlug: at(S.px, ring, ring), bodyUni: at(U.px, ring, ring) };
</script>`;
const mime = (p) =>
  /\.(js|mjs)$/.test(p) ? 'text/javascript' : p.endsWith('.glsl') ? 'text/plain' : 'text/html';
const server = http.createServer((q, res) => {
  try {
    const _p = q.url.split('?')[0];
    if (_p === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(PAGE);
      return;
    }
    res.writeHead(200, { 'content-type': mime(_p) + '; charset=utf-8' });
    res.end(readFileSync(path.join(ROOT, decodeURIComponent(_p))));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const args = ['--no-sandbox'];
if (process.env.GPU === '1') args.push('--use-angle=metal', '--enable-gpu');
else args.push('--enable-unsafe-swiftshader');
const br = await launchBrowser({ headless: 'new', args, protocolTimeout: 600000 });
const pg = await br.newPage();
pg.on('pageerror', (e) => console.log('[page-err]', e.message));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 60000 });
await pg.waitForFunction('window.__out', { timeout: 120000, polling: 100 });
const o = await pg.evaluate(() => window.__out);
await br.close();
server.close();
console.log(
  '\n  nested-hole fill (' + (process.env.RULE || 'evenodd') + '): unified route vs Slug',
);
console.log('    drew        slug[' + o.drewSlug + ']  unified[' + o.drewUni + ']  gate ' + o.gate);
console.log('    differing   ' + o.nDiff + ' px, worst ' + o.worst);
console.log(
  '    hole centre slug ' +
    o.holeSlug +
    '  unified ' +
    o.holeUni +
    (o.holeSlug === o.holeUni ? '  (agree)' : '  <<< DIFFER'),
);
console.log(
  '    body        slug ' +
    o.bodySlug +
    '  unified ' +
    o.bodyUni +
    (o.bodySlug === o.bodyUni ? '  (agree)' : '  <<< DIFFER'),
);
console.log('    ink ADDED inside the hole  ' + o.addedInHole + ' px');
console.log('    ink LOST on the body       ' + o.lostOnBody + ' px');
console.log('    fragments landing on each pixel along +x (A*64), near the inner edge r=8:');
for (const q of o.ray)
  if (q.r >= 7.0 && q.r <= 9.2)
    console.log(
      '      r ' +
        String(q.r).padStart(5) +
        '   frags ' +
        String(q.frags).padStart(2) +
        '   interior ' +
        String(q.interior).padStart(2) +
        '   kindSum ' +
        String(q.kindSum).padStart(3) +
        '   slug ' +
        String(q.slug).padStart(3) +
        '   lb ' +
        String(q.lb).padStart(3),
    );
console.log('    radial profile (r in viewBox units, coverage 0-255) where the two differ:');
for (const [rr, a, b] of o.prof)
  if (Math.abs(a - b) > 8)
    console.log(
      '      r ' +
        String(rr).padStart(5) +
        '   slug ' +
        String(a).padStart(3) +
        '   lb ' +
        String(b).padStart(3),
    );
console.log('    differing pixels by radius (viewBox units; inner edge ~8, outer ~16):');
for (let b = 0; b < 10; b++)
  if (o.bins[b])
    console.log(
      '      r ' +
        String(b * 2).padStart(2) +
        '-' +
        String(b * 2 + 2).padStart(2) +
        '  ' +
        String(o.bins[b]).padStart(5) +
        ' px   worst ' +
        o.binWorst[b],
    );
