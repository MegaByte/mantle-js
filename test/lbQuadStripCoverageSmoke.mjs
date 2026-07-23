// lbQuadStripCoverageSmoke — every whole ARC of a quad crescent must get an exterior
// kind-12 band, and the result must be near-exact against an 8x reference.
//
// A kind-5 fill-side crescent is the exact (undilated) hull face of its arc, so its geometry cannot reach
// the pixels of its own AA band that lie OUTSIDE the hull. The kind-12 band exists to paint that
// exterior band. `healCracks` splits a crescent hull at interior T-junctions and gives every
// child a `tc`, and the pack's band filter skips any quad carrying one — so after healing almost
// no arc still qualified (a 16-arc quad ring got 4 bands) and the rest rendered with a truncated
// exterior ramp: 3.226/255 mean error, 16 bad pixels, all on the arc seams. The mesh now
// snapshots the whole-arc crescents into `bandArcs` BEFORE healing.
//
// Two assertions, because either alone is fooled:
//   - strip COUNT: one per arc. Catches the filter regressing without a visible pixel change
//     at this raster size.
//   - absolute AA error vs the 8x reference. Catches a strip that exists but paints wrongly.
//
// preserveViewport matters: importSvg otherwise fits the path-tight bbox to the viewport, and
// this shape would rasterise at a size that hides the band.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const N = 192, SS = 8, K = 8;   // K quadratic arcs in one contour

// A "flower" of K quadratic arcs (one contour). bulge 0.35 (vs 0.128 for a true circle arc)
// makes every joint KINKED, which is what exposed the seam class. A second, inner contour would
// route the shape through the CDT partition instead of the earcut fast mesh — a different strip
// path entirely, and the regression would go unseen.
function quadRing(n) {
  const c = n / 2, r = n * 0.36;
  const P = (i) => { const a = (i / K) * 2 * Math.PI; return [c + r * Math.cos(a), c + r * Math.sin(a)]; };
  let d = `M ${P(0)[0].toFixed(4)} ${P(0)[1].toFixed(4)} `;
  for (let i = 0; i < K; i++) {
    const A = P(i), B = P(i + 1);
    const mx = (A[0] + B[0]) / 2 + (B[1] - A[1]) * 0.35, my = (A[1] + B[1]) / 2 - (B[0] - A[0]) * 0.35;
    d += `Q ${mx.toFixed(4)} ${my.toFixed(4)} ${B[0].toFixed(4)} ${B[1].toFixed(4)} `;
  }
  return d + 'Z';
}
const wrap = (d, n) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${n}" height="${n}"><path fill="#000000" d="${d}"/></svg>`;

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
const render = (r, sec, n) => { const b = createBundle(gl, sec);
  if (r.prepareBundle) r.prepareBundle(b);
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
window.__run = async (lo, hi) => {
  const secLo = await importSvg(lo, IV), secHi = await importSvg(hi, IV);
  const ref = down(render(rSlug, secHi, N*SS), N, SS);
  const s = render(rSlug, secLo, N), x = render(rLb, secLo, N);
  const err = (a) => { let sum=0, nEdge=0, nBad=0;
    for (let i=0;i<a.length;i++) { const r=ref[i]; if (r>2 && r<253) { const d=Math.abs(a[i]-r); sum+=d; if (d>25) nBad++; nEdge++; } }
    return { mean: sum/Math.max(1,nEdge), nBad, nEdge }; };
  return { slug: err(s), lb: err(x), routed: x.routed, strips: x.strips };
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
const br = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const pg = await br.newPage();
pg.on('pageerror', (e) => console.error(' [err]', e.message));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 90000 });
await pg.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 50 });
const o = await pg.evaluate((lo, hi) => window.__run(lo, hi), wrap(quadRing(N), N), wrap(quadRing(N * SS), N * SS));
await br.close(); server.close();

let fail = 0;
const ok = (c, m) => c ? console.log('  ok ' + m) : (fail++, console.error('  FAIL ' + m));

console.log(`  strips=${o.strips} (arcs=${K})   slug=${o.slug.mean.toFixed(3)}  lb=${o.lb.mean.toFixed(3)} /255, bad=${o.lb.nBad}`);
ok(o.routed > 0, `LB actually routed (${o.routed}) — else the scores below are Slug's`);
// one exterior strip per ARC, not per healed sub-triangle. 4/16 was the bug.
ok(o.strips >= K, `every arc gets an exterior strip (${o.strips} >= ${K}) — was 4/16`);
// absolute, against the 8x reference. Was 3.226 with 16 bad px, all on the arc seams.
ok(o.lb.mean < 1.0, `quad arcs near-exact (${o.lb.mean.toFixed(3)} < 1.0 /255, was 3.226)`);
ok(o.lb.nBad === 0, `no pixel is off by >0.1 coverage (${o.lb.nBad}, was 16 — all on the seams)`);
// the strips must not DOUBLE the band: over-coverage would show as LB losing to Slug here
ok(o.lb.mean <= o.slug.mean, `LB is at least as accurate as Slug (${o.lb.mean.toFixed(3)} <= ${o.slug.mean.toFixed(3)})`);

console.log(fail ? `\nLB-QUAD-STRIP-COVERAGE FAIL (${fail})` : '\nLB-QUAD-STRIP-COVERAGE PASS');
process.exit(fail ? 1 : 0);
