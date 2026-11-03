// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// slugExactEdgeAASmoke — Slug's DEFAULT coverage is near-exact on straight edges, curves and corners, LB agrees with
// it, and `exactEdgeAa` is the default (accepted and ignored).
//
// This is an ABSOLUTE gate against an 8x-supersampled, box-downsampled reference, not a comparison against another
// engine. That matters: a gate asserting "LB matches Slug" stays green while both are ~7/255 wrong in the same way.
//
// Slug reconstructs 2D area from two 1D axis-ray coverages. Their center-proximity blend is exact only for axis-aligned
// edges (0.000/255 at 0 deg, mean 10.6 and max 31.9 at 45 deg against the true half-plane box area,
// probes/_slugCombinerCeiling.mjs). The DEFAULT tail is exact on such pixels -- the secant through the rays' two
// crossings, clipped at a corner pixel, and bent by the crossings' tangents on a curve -- so a separate exact half-plane
// branch for a pixel one straight edge crosses would cost frame time and be no more exact. `exactEdgeAa` is accepted and
// ignored (renderer.js), and this smoke holds:
//   * the DEFAULT near-exact: under 1/255 on the triangle (three non-axis-aligned edges), the circle (cubics) and the
//     star (sharp corners: two edges in one pixel must not be fused into one half-plane);
//   * `exactEdgeAa: true` draws the default's pixels exactly;
//   * LB near-exact on straight edges and corners, and its curve crescents bounded.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const N = 128,
  SS = 8;

// triangle: three edges at three different angles, none axis-aligned (0deg is the case Slug's
//   blend already gets right, so it would hide the effect).
// circle: cubic curves — exercises the tangent half-plane.
// star: SHARP CORNERS. Two distinct edges meet inside one pixel at each tip; the merge
//   tolerance must not fuse them into a single half-plane, which would mis-cover the tip.
const tri = (n) => `M ${0.12 * n} ${0.15 * n} L ${0.88 * n} ${0.42 * n} L ${0.3 * n} ${0.9 * n} Z`;
const circle = (n) => {
  const c = n / 2,
    r = n * 0.36,
    k = 0.5523 * r;
  const P = [
    [c - r, c],
    [c, c - r],
    [c + r, c],
    [c, c + r],
  ];
  let d = `M ${P[0][0]} ${P[0][1]} `;
  for (let i = 0; i < 4; i++) {
    const A = P[i],
      B = P[(i + 1) % 4];
    const ta = [-(A[1] - c), A[0] - c],
      tb = [-(B[1] - c), B[0] - c];
    d += `C ${(A[0] + (ta[0] / r) * k).toFixed(4)} ${(A[1] + (ta[1] / r) * k).toFixed(4)} ${(B[0] - (tb[0] / r) * k).toFixed(4)} ${(B[1] - (tb[1] / r) * k).toFixed(4)} ${B[0]} ${B[1]} `;
  }
  return d + 'Z';
};
const star = (n) => {
  const c = n / 2,
    R = n * 0.44,
    r = n * 0.17;
  let d = '';
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5,
      rad = i % 2 ? r : R;
    d +=
      (i ? 'L ' : 'M ') +
      (c + rad * Math.cos(a)).toFixed(4) +
      ' ' +
      (c + rad * Math.sin(a)).toFixed(4) +
      ' ';
  }
  return d + 'Z';
};
const wrap = (d, n) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${n}" height="${n}"><path fill="#000000" d="${d}"/></svg>`;

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="${N * SS}" height="${N * SS}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const N = ${N}, SS = ${SS};
// Pin the coverage kernels: automatic SDF recognition can switch only the
// supersampled reference and invalidate a Slug-versus-Slug measurement.
const rSlug = createRenderer(gl, shaders, {}); rSlug.setSdfPrimitives(false); rSlug.setLoopBlinnFill('off');                     // the DEFAULT
const rX    = createRenderer(gl, shaders, {}); rX.setLoopBlinnFill('on');                         // LB
const rOpt  = createRenderer(gl, shaders, { exactEdgeAa: true }); rOpt.setLoopBlinnFill('off');   // exactEdgeAa: true
const grab = (w,h) => { const p = new Uint8Array(w*h*4); gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,p);
  const a = new Float64Array(w*h); for (let i=0;i<w*h;i++) a[i]=p[i*4]; return a; };
// prepareBundle is REQUIRED for the LB renderer: without a built mesh it silently falls back
// to Slug, and every LB assertion below would compare Slug against itself.
const render = async (r, sec, n) => { const b = createBundle(gl, sec);
  if (r.prepareBundle) r.prepareBundle(b);
  if (r.awaitLbReady) await r.awaitLbReady(b);
  r.prewarmBundle(b); r.precompileFills();   // the loading call: the first frame draws the program a game has after loading   // LB builds off-thread; wait before asserting the route
  r.setViewport(n,n); gl.viewport(0,0,n,n);
  const c0 = r.debugStats.loopBlinnRouteCount;
  const before = {...r.debugStats.engines.draws};
  r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame();
  const a = grab(n,n); a.routed = r.debugStats.loopBlinnRouteCount - c0;
  a.slugDraws = (r.debugStats.engines.draws.slug || 0) - (before.slug || 0);
  a.sdfDraws = (r.debugStats.engines.draws.sdf || 0) - (before.sdf || 0); b.dispose(); return a; };
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
    const o = await render(rOpt, secLo, N);
    let optDiff = 0; for (let i = 0; i < s.length; i++) optDiff = Math.max(optDiff, Math.abs(o[i] - s[i]));
    out[name] = { slug: err(s, ref), lb: err(x, ref), lbRouted: x.routed, slugDraws: s.slugDraws, sdfDraws: s.sdfDraws, optDiff };
  }
  return out;
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
await pg.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 100 });
const shapes = [
  ['triangle', wrap(tri(N), N), wrap(tri(N * SS), N * SS)],
  ['circle', wrap(circle(N), N), wrap(circle(N * SS), N * SS)],
  ['star', wrap(star(N), N), wrap(star(N * SS), N * SS)],
];
const o = await pg.evaluate((s) => window.__run(s), shapes);
await br.close();
server.close();

let fail = 0;
const ok = (c, m) => (c ? console.log('  ok ' + m) : (fail++, console.error('  FAIL ' + m)));
const t = o.triangle,
  c = o.circle,
  st = o.star;

console.log(`  triangle: slug=${t.slug.toFixed(3)}  lb=${t.lb.toFixed(3)} /255`);
console.log(`  circle  : slug=${c.slug.toFixed(3)}  lb=${c.lb.toFixed(3)} /255`);
console.log(`  star    : slug=${st.slug.toFixed(3)}  lb=${st.lb.toFixed(3)} /255`);

ok(
  [t, c, st].every((row) => row.slugDraws > 0 && row.sdfDraws === 0),
  'Slug actually routed without SDF substitution',
);
ok(
  t.lbRouted > 0 && c.lbRouted > 0 && st.lbRouted > 0,
  `LB actually routed (${t.lbRouted}/${c.lbRouted}/${st.lbRouted}) — else its scores are Slug's`,
);
// exactEdgeAa: true is the default, pixel for pixel
ok(
  t.optDiff === 0 && c.optDiff === 0 && st.optDiff === 0,
  `exactEdgeAa: true draws the default's pixels (max diff ${t.optDiff}/${c.optDiff}/${st.optDiff})`,
);
// Slug's DEFAULT: near-exact everywhere (a center-proximity blend of the two rays scores ~6.9-7.8 on all three).
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
// hull edge, then clipped back per-fragment to the piece's own end tangents so neighbors tile.
// A 4-cubic circle reads about 1.14/255 that way. Bound it tightly; either the undilated hull
// (-14.6/255 outside) or dilation without the clip (+6.4/255) trips this.
// The clip's slack must also stay SMALL: neighboring pieces' planes coincide, so a generous
// slack double-paints the seam (0.447 -> 1.144/255 at 192, 8 bad pixels).
// (This smoke renders at N=128; probes/_aaAccuracy.mjs at 192 reads 0.45 for the same shape —
// a smaller raster puts more of the circle in the AA band, so the bound here is looser.)
ok(c.lb < 3.3, `lb curve crescents near-exact (${c.lb.toFixed(3)} < 3.3 /255)`);

console.log(fail ? `\nSLUG-EXACT-EDGE-AA FAIL (${fail})` : '\nSLUG-EXACT-EDGE-AA PASS');
process.exit(fail ? 1 : 0);
