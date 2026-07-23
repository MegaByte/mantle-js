// slugExactEdgeAASmoke — Slug's coverage must be near-EXACT on straight edges, curves and
// corners, and LB must agree with it (both now evaluate the same closed form).
//
// This is an ABSOLUTE gate against an 8x-supersampled, box-downsampled reference, not a
// comparison against another engine. That matters: the old gates asserted "LB matches Slug",
// which stayed green while BOTH were ~7/255 wrong in the same way.
//
// Slug reconstructs 2D area from two 1D axis-ray coverages blended by a centre-proximity
// weight. That is exact only for axis-aligned edges: measured against the true half-plane
// box area (probes/_slugCombinerCeiling.mjs) it is 0.000/255 at 0deg, mean 10.6 and max 31.9
// at 45deg. That combiner — not curvature — is most of Slug's error, which is why its circle
// (7.778) scored barely worse than its triangle (6.897).
//
// A pixel cut by ONE edge uses the closed-form half-plane box area. For a
// straight segment the half-plane is built from the segment's own endpoints; for a curve it is
// built from the TANGENT at the ray crossing, so only the curvature within the pixel remains
// as error (second order) rather than the combiner's first-order one. Pixels holding two
// distinct edges (corners) or a sharply curved one record two half-planes and fall back.
//
// Scored against an 8x-supersampled, box-downsampled reference — neither engine is a
// reference, so one is constructed.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const N = 128, SS = 8;

// triangle: three edges at three different angles, none axis-aligned (0deg is the case Slug's
//   blend already gets right, so it would hide the effect).
// circle: cubic curves — exercises the tangent half-plane.
// star: SHARP CORNERS. Two distinct edges meet inside one pixel at each tip; the merge
//   tolerance must not fuse them into a single half-plane, which would mis-cover the tip.
const tri = (n) => `M ${0.12 * n} ${0.15 * n} L ${0.88 * n} ${0.42 * n} L ${0.30 * n} ${0.90 * n} Z`;
const circle = (n) => {
  const c = n / 2, r = n * 0.36, k = 0.5523 * r;
  const P = [[c - r, c], [c, c - r], [c + r, c], [c, c + r]];
  let d = `M ${P[0][0]} ${P[0][1]} `;
  for (let i = 0; i < 4; i++) {
    const A = P[i], B = P[(i + 1) % 4];
    const ta = [-(A[1] - c), (A[0] - c)], tb = [-(B[1] - c), (B[0] - c)];
    d += `C ${(A[0] + ta[0] / r * k).toFixed(4)} ${(A[1] + ta[1] / r * k).toFixed(4)} ${(B[0] - tb[0] / r * k).toFixed(4)} ${(B[1] - tb[1] / r * k).toFixed(4)} ${B[0]} ${B[1]} `;
  }
  return d + 'Z';
};
const star = (n) => { const c = n/2, R = n*0.44, r = n*0.17; let d = '';
  for (let i = 0; i < 10; i++) { const a = -Math.PI/2 + i*Math.PI/5, rad = (i%2 ? r : R);
    d += (i ? 'L ' : 'M ') + (c + rad*Math.cos(a)).toFixed(4) + ' ' + (c + rad*Math.sin(a)).toFixed(4) + ' '; }
  return d + 'Z'; };
const wrap = (d, n) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${n}" height="${n}"><path fill="#000000" d="${d}"/></svg>`;

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="${N * SS}" height="${N * SS}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const N = ${N}, SS = ${SS};
// exactEdgeAa is what this smoke is ABOUT, and it is now opt-in: the exact half-plane branch
// costs ~45% of frame time (it keeps normals + offsets live across the whole band walk, which is
// register pressure every fragment pays), and it buys accuracy only on straight edges. So the
// DEFAULT is the ray blend, and the feature must be asked for — here, by the test that measures it.
const rSlug = createRenderer(gl, shaders, { exactEdgeAa: true }); rSlug.setLoopBlinnFill('off');
const rX    = createRenderer(gl, shaders, { exactEdgeAa: true }); rX.setLoopBlinnFill('on');   // LB, same coverage kernel
const rDef  = createRenderer(gl, shaders, {}); rDef.setLoopBlinnFill('off');   // the DEFAULT: ray blend
const grab = (w,h) => { const p = new Uint8Array(w*h*4); gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,p);
  const a = new Float64Array(w*h); for (let i=0;i<w*h;i++) a[i]=p[i*4]; return a; };
// prepareBundle is REQUIRED for the LB renderer: without a built mesh it silently falls back
// to Slug, and every LB assertion below would compare Slug against itself.
const render = async (r, sec, n) => { const b = createBundle(gl, sec);
  if (r.prepareBundle) r.prepareBundle(b);
  if (r.awaitLbReady) await r.awaitLbReady(b);   // LB builds off-thread; wait before asserting the route
  r.setViewport(n,n); gl.viewport(0,0,n,n);
  const c0 = r.debugStats.loopBlinnRouteCount;
  r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame();
  const a = grab(n,n); a.routed = r.debugStats.loopBlinnRouteCount - c0; b.dispose(); return a; };
const down = (hi,n,ss) => { const lo = new Float64Array(n*n);
  for (let y=0;y<n;y++) for (let x=0;x<n;x++) { let s=0;
    for (let j=0;j<ss;j++) for (let i=0;i<ss;i++) s += hi[(y*ss+j)*(n*ss)+(x*ss+i)];
    lo[y*n+x] = s/(ss*ss); } return lo; };
const err = (a, ref) => { let sum=0, n=0;
  for (let i=0;i<a.length;i++) { const r=ref[i]; if (r>2 && r<253) { sum += Math.abs(a[i]-r); n++; } }
  return sum/Math.max(1,n); };
window.__run = async (shapes) => {
  const out = {};
  for (const [name, lo, hi] of shapes) {
    const secLo = await importSvg(lo), secHi = await importSvg(hi);
    const ref = down(await render(rSlug, secHi, N*SS), N, SS);
    const s = await render(rSlug, secLo, N), x = await render(rX, secLo, N);
    const d = await render(rDef, secLo, N);
    out[name] = { slug: err(s, ref), lb: err(x, ref), lbRouted: x.routed, def: err(d, ref) };
  }
  return out;
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
await pg.waitForFunction(() => window.__ready === true, { timeout: 120000 });
const shapes = [
  ['triangle', wrap(tri(N), N), wrap(tri(N * SS), N * SS)],
  ['circle',   wrap(circle(N), N), wrap(circle(N * SS), N * SS)],
  ['star',     wrap(star(N), N), wrap(star(N * SS), N * SS)],
];
const o = await pg.evaluate((s) => window.__run(s), shapes);
await br.close(); server.close();

let fail = 0;
const ok = (c, m) => c ? console.log('  ok ' + m) : (fail++, console.error('  FAIL ' + m));
const t = o.triangle, c = o.circle, st = o.star;

console.log(`  triangle: slug=${t.slug.toFixed(3)}  lb=${t.lb.toFixed(3)} /255`);
console.log(`  circle  : slug=${c.slug.toFixed(3)}  lb=${c.lb.toFixed(3)} /255`);
console.log(`  star    : slug=${st.slug.toFixed(3)}  lb=${st.lb.toFixed(3)} /255`);
console.log(`  DEFAULT (ray blend, exactEdgeAa off): triangle=${t.def.toFixed(3)} circle=${c.def.toFixed(3)} star=${st.def.toFixed(3)} /255`);

ok(t.lbRouted > 0 && c.lbRouted > 0 && st.lbRouted > 0,
   `LB actually routed (${t.lbRouted}/${c.lbRouted}/${st.lbRouted}) — else its scores are Slug's`);
// The DEFAULT is the ray blend, and this is what it costs: several /255 on non-axis-aligned edges,
// against under 1 with exactEdgeAa. Pinned here so the trade is a measured number in the suite and
// not a memory — and so that turning the branch back on by default would show up as this failing.
ok(t.def > 2.0 && c.def > 2.0,
   `the default (exactEdgeAa OFF) is the blend: ${t.def.toFixed(2)}/${c.def.toFixed(2)} /255 vs ${t.slug.toFixed(2)}/${c.slug.toFixed(2)} with it on`);
// Slug: near-exact everywhere. The old blended combiner scored ~6.9-7.8 on all three.
ok(t.slug < 1.0, `slug straight edges near-exact (${t.slug.toFixed(3)} < 1.0 /255)`);
ok(c.slug < 1.0, `slug curves near-exact via the tangent (${c.slug.toFixed(3)} < 1.0 /255)`);
// corners must not be fused by the merge tolerance: a wrong fuse mis-covers every star tip
ok(st.slug < 1.0, `slug corners stay accurate (${st.slug.toFixed(3)} < 1.0 /255)`);
// LB shares exactBoxCov, so its STRAIGHT edges are near-exact too. Its CURVE crescents are a
// known, separate gap (the crescent/interior decomposition, not the coverage model), so the
// curve bound here is loose on purpose and exists only to catch a blow-up.
ok(t.lb < 1.0, `lb straight edges near-exact (${t.lb.toFixed(3)} < 1.0 /255)`);
ok(st.lb < 1.5, `lb corners accurate (${st.lb.toFixed(3)} < 1.5 /255)`);
// LB's cubic crescents: the cover hull is dilated so the exterior AA ramp is not clipped by the
// hull edge, then clipped back per-fragment to the piece's own end tangents so neighbours tile.
// That took a 4-cubic circle from 7.73 to 1.14/255. Bound it tightly; a regression to either the
// undilated hull (-14.6/255 outside) or dilation without the clip (+6.4/255) trips this.
// The clip's slack must also stay SMALL: neighbouring pieces' planes coincide, so a generous
// slack double-paints the seam (0.447 -> 1.144/255 at 192, 8 bad pixels).
// (This smoke renders at N=128; probes/_aaAccuracy.mjs at 192 reads 0.45 for the same shape —
// a smaller raster puts more of the circle in the AA band, so the bound here is looser.)
ok(c.lb < 3.3, `lb curve crescents near-exact (${c.lb.toFixed(3)} < 3.3 /255, was 8.9)`);

console.log(fail ? `\nSLUG-EXACT-EDGE-AA FAIL (${fail})` : '\nSLUG-EXACT-EDGE-AA PASS');
process.exit(fail ? 1 : 0);
