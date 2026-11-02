// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbQuadStripCoverageSmoke — every whole ARC of a quad crescent must get an exterior
// kind-12 band, and the result must be near-exact against an 8x reference.
//
// A kind-5 fill-side crescent is the exact (undilated) hull face of its arc, so its geometry cannot reach
// the pixels of its own AA band that lie OUTSIDE the hull. The kind-12 band exists to paint that
// exterior band. `healCracks` splits a crescent hull at interior T-junctions and gives every
// child a `tc`, and the pack's band filter skips any quad carrying one — so after healing almost
// no arc would still qualify and the rest would render with a truncated exterior ramp, its error
// all on the arc seams. So the mesh snapshots the whole-arc crescents into `bandArcs` BEFORE
// healing.
//
// Two assertions, because either alone is fooled:
//   - strip COUNT: one per arc. Catches a filter that skips arcs without a visible pixel change
//     at this raster size.
//   - absolute AA error vs the 8x reference. Catches a strip that exists but paints wrongly.
// And a DOUBLED band (strips painting over the crescent's own ramp) is over-coverage: it is held
// against the exact box coverage of the same path (probes/fillperf/cellCoverage.mjs, f64), as an
// absolute mean error and a signed bias, not as "LB is at least as accurate as Slug": that is a
// premise about the other engine, which flips whenever Slug moves a hair, with no change in LB.
//
// preserveViewport matters: importSvg otherwise fits the path-tight bbox to the viewport, and
// this shape would rasterize at a size that hides the band.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { cellCoverage } from '../probes/fillperf/cellCoverage.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const N = 192,
  SS = 8,
  K = 8; // K quadratic arcs in one contour

// A "flower" of K quadratic arcs (one contour). bulge 0.35 (vs 0.128 for a true circle arc)
// makes every joint KINKED, which is what exposed the seam class. A second, inner contour would
// route the shape through the CDT partition instead of the earcut fast mesh — a different strip
// path entirely, and the defect would go unseen.
function quadRing(n) {
  const c = n / 2,
    r = n * 0.36;
  const P = (i) => {
    const a = (i / K) * 2 * Math.PI;
    return [c + r * Math.cos(a), c + r * Math.sin(a)];
  };
  let d = `M ${P(0)[0].toFixed(4)} ${P(0)[1].toFixed(4)} `;
  for (let i = 0; i < K; i++) {
    const A = P(i),
      B = P(i + 1);
    const mx = (A[0] + B[0]) / 2 + (B[1] - A[1]) * 0.35,
      my = (A[1] + B[1]) / 2 - (B[0] - A[0]) * 0.35;
    d += `Q ${mx.toFixed(4)} ${my.toFixed(4)} ${B[0].toFixed(4)} ${B[1].toFixed(4)} `;
  }
  return d + 'Z';
}
// The exact box coverage of every pixel of the N-px raster, from the path string itself (its rounded
// coordinates), in SVG rows (row 0 at the top).
function exactRaster(d, n) {
  const v = d.match(/-?\d+(\.\d+)?/g).map(Number),
    segs = [];
  let x = v[0],
    y = v[1];
  for (let i = 2; i + 3 < v.length; i += 4) {
    segs.push({ t: 1, x0: x, y0: y, cx: v[i], cy: v[i + 1], x1: v[i + 2], y1: v[i + 3] });
    x = v[i + 2];
    y = v[i + 3];
  }
  if (x !== v[0] || y !== v[1]) segs.push({ t: 0, x0: x, y0: y, x1: v[0], y1: v[1] });
  const out = new Array(n * n);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++)
      out[j * n + i] = cellCoverage(segs, [i + 0.5, j + 0.5], [1, 1], false);
  return out;
}
const wrap = (d, n) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${n}" height="${n}"><path fill="#000000" d="${d}"/></svg>`;

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="${N * SS}" height="${N * SS}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const N = ${N}, SS = ${SS};
const IV = { preserveViewport: true };
const rSlug = createRenderer(gl, shaders, {}); rSlug.setLoopBlinnFill('off');
const rLb   = createRenderer(gl, shaders, {}); rLb.setLoopBlinnFill('on');
const grab = (w,h) => { const p = new Uint8Array(w*h*4); gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,p);
  const a = new Float64Array(w*h); for (let i=0;i<w*h;i++) a[i]=p[i*4]; return a; };
const render = async (r, sec, n) => { const b = createBundle(gl, sec);
  if (r.prepareBundle) r.prepareBundle(b);
  // prepareBundle is non-blocking by contract, and while the LB-hosting fill
  // variant links a bundle falls to the best non-LB engine rather than to the
  // classic coverage-RT routes — so the first frame would score another engine's
  // coverage as LB's. awaitLbReady is what resolves once LB can actually draw.
  if (r.awaitLbReady) await r.awaitLbReady(b);
  r.setViewport(n,n); gl.viewport(0,0,n,n);
  const c0 = r.debugStats.loopBlinnRouteCount;
  r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame();
  const a = grab(n,n); a.routed = r.debugStats.loopBlinnRouteCount - c0;
  // kind rides float 5 of the 24-float vertex; kind 12 = unified curve band
  let k12 = 0; for (const m of (b._lbMeshes || [])) if (m && m.verts)
    for (let i=0;i<m.vertexCount;i++) if (Math.floor(m.verts[i*24+5]+0.001) === 12) k12++;
  a.strips = k12 / 6;   // 6 verts per bbox band (2 tris; fat rings use 15)
  b.dispose(); return a; };
const down = (hi,n,ss) => { const lo = new Float64Array(n*n);
  for (let y=0;y<n;y++) for (let x=0;x<n;x++) { let s=0;
    for (let j=0;j<ss;j++) for (let i=0;i<ss;i++) s += hi[(y*ss+j)*(n*ss)+(x*ss+i)];
    lo[y*n+x] = s/(ss*ss); } return lo; };
window.__run = async (lo, hi, exact) => {
  const secLo = await importSvg(lo, IV), secHi = await importSvg(hi, IV);
  const ref = down(await render(rSlug, secHi, N*SS), N, SS);
  const s = await render(rSlug, secLo, N), x = await render(rLb, secLo, N);
  const err = (a) => { let sum=0, nEdge=0, nBad=0;
    for (let i=0;i<a.length;i++) { const r=ref[i]; if (r>2 && r<253) { const d=Math.abs(a[i]-r); sum+=d; if (d>25) nBad++; nEdge++; } }
    return { mean: sum/Math.max(1,nEdge), nBad, nEdge }; };
  // against the EXACT coverage: readback row r is SVG row N-1-r, and the red channel of black ink on white is
  // 255 (1 - coverage), so a positive d is over-coverage
  const vsExact = (a) => { let sum=0, bias=0, nEdge=0;
    for (let r=0;r<N;r++) for (let i=0;i<N;i++) { const e = exact[(N-1-r)*N+i]*255; if (e>2 && e<253) {
      const d = (255-a[r*N+i])-e; sum+=Math.abs(d); bias+=d; nEdge++; } }
    return { mean: sum/Math.max(1,nEdge), bias: bias/Math.max(1,nEdge), nEdge }; };
  return { slug: err(s), lb: err(x), slugX: vsExact(s), lbX: vsExact(x), routed: x.routed, strips: x.strips };
};
window.__ready = true;
</script></body></html>`;

const server = http.createServer((q, res) => {
  try {
    if (q.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(HTML);
      return;
    }
    const pp = decodeURIComponent(q.url.split('?')[0]);
    res.writeHead(200, { 'content-type': pp.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, pp)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const br = await launchBrowser({ headless: 'new', args: ['--no-sandbox'] });
const pg = await br.newPage();
pg.on('pageerror', (e) => console.error(' [err]', e.message));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 90000 });
await pg.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 50 });
const o = await pg.evaluate(
  (lo, hi, ex) => window.__run(lo, hi, ex),
  wrap(quadRing(N), N),
  wrap(quadRing(N * SS), N * SS),
  exactRaster(quadRing(N), N),
);
await br.close();
server.close();

let fail = 0;
const ok = (c, m) => (c ? console.log('  ok ' + m) : (fail++, console.error('  FAIL ' + m)));

console.log(
  `  strips=${o.strips} (arcs=${K})   slug=${o.slug.mean.toFixed(3)}  lb=${o.lb.mean.toFixed(3)} /255, bad=${o.lb.nBad}   (8x reference)`,
);
console.log(
  `  against the exact coverage over ${o.lbX.nEdge} edge px: slug ${o.slugX.mean.toFixed(3)} (bias ${o.slugX.bias.toFixed(3)})  lb ${o.lbX.mean.toFixed(3)} (bias ${o.lbX.bias.toFixed(3)}) /255`,
);
ok(o.routed > 0, `LB actually routed (${o.routed}) — else the scores below are Slug's`);
// one exterior strip per ARC, not per healed sub-triangle.
ok(o.strips >= K, `every arc gets an exterior strip (${o.strips} >= ${K})`);
// absolute, against the 8x reference.
ok(o.lb.mean < 1.0, `quad arcs near-exact (${o.lb.mean.toFixed(3)} < 1.0 /255)`);
ok(o.lb.nBad === 0, `no pixel is off by >0.1 coverage (${o.lb.nBad})`);
// the strips must not DOUBLE the band: over-coverage, held against the exact coverage, not against Slug. An 8-bit
// readback of the exact answer is off by 0.25/255 on average and unbiased; a doubled exterior band adds tens of levels
// on each of its pixels.
ok(
  o.lbX.nEdge > 400 && o.lbX.mean < 1.0,
  `LB near-exact against the exact box coverage (${o.lbX.mean.toFixed(3)} < 1.0 /255 over ${o.lbX.nEdge} edge px)`,
);
ok(
  Math.abs(o.lbX.bias) < 0.5,
  `no over-coverage: LB's mean signed error against the exact coverage is ${o.lbX.bias.toFixed(3)} /255 (|bias| < 0.5)`,
);

console.log(fail ? `\nLB-QUAD-STRIP-COVERAGE FAIL (${fail})` : '\nLB-QUAD-STRIP-COVERAGE PASS');
process.exit(fail ? 1 : 0);
