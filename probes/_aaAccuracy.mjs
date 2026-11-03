// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _aaAccuracy — WHICH engine antialiases most accurately? Slug, AAC, or LB?
//
// Neither engine is a reference, so build one: render at 8x and box-downsample. A box
// downsample of an 8x render approximates the exact box-filter coverage to ~1/64 of a
// pixel, which is far below the differences we are comparing (a few /255). Each engine is
// then scored by mean |error| against that reference, on CURVED edges where the engines'
// coverage models actually differ (Slug: dual-ray from f and grad-f; AAC: exact signed-area
// integral; LB: slugCov/curveCov on the implicit).
//
// Diagonal straight edges are included as a control: there all three should be ~exact, so a
// nonzero score there is measurement floor, not model error.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 192,
  SS = 8;
const wrap = (d, n) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${n}" height="${n}"><path fill="#000000" fill-rule="evenodd" d="${d}"/></svg>`;
function circle(n) {
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
}
function quadRing(n) {
  const c = n / 2,
    r = n * 0.36,
    K = 8;
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
function tri(n) {
  return `M ${0.12 * n} ${0.15 * n} L ${0.88 * n} ${0.42 * n} L ${0.3 * n} ${0.9 * n} Z`;
}
// SHARP CORNERS: a 5-point star. Two different edges meet inside one pixel at each tip, so
// the merge tolerance must NOT fuse them into a single half-plane.
function star(n) {
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
}
// HIGH CURVATURE: a tiny disc (~7px across at 1x) where the tangent line is a poor local model.
function tinyCircle(n) {
  const c = n / 2,
    r = n * 0.028,
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
}
// A cubic-approximated ELLIPSE: unlike the circle its curvature VARIES along each piece, so a
// single tangent half-plane per fragment is a worse local model near the high-curvature ends.
// (It emits kinds {0,2}, the same cubic crescents as the circle — NOT the circle/annulus SDF.)
function ellipse(n) {
  const cx = n / 2,
    cy = n / 2,
    rx = n * 0.4,
    ry = n * 0.26,
    k = 0.5523;
  const P = [
    [cx - rx, cy],
    [cx, cy - ry],
    [cx + rx, cy],
    [cx, cy + ry],
  ];
  let d = `M ${P[0][0]} ${P[0][1]} `;
  const C = [
    [
      [cx - rx, cy - ry * k],
      [cx - rx * k, cy - ry],
    ],
    [
      [cx + rx * k, cy - ry],
      [cx + rx, cy - ry * k],
    ],
    [
      [cx + rx, cy + ry * k],
      [cx + rx * k, cy + ry],
    ],
    [
      [cx - rx * k, cy + ry],
      [cx - rx, cy + ry * k],
    ],
  ];
  for (let i = 0; i < 4; i++) {
    const B = P[(i + 1) % 4];
    d += `C ${C[i][0][0].toFixed(4)} ${C[i][0][1].toFixed(4)} ${C[i][1][0].toFixed(4)} ${C[i][1][1].toFixed(4)} ${B[0]} ${B[1]} `;
  }
  return d + 'Z';
}
function evenOddRing(n) {
  const k = n / 40,
    f = (v) => (v * k).toFixed(4);
  const outer =
    `M ${f(20)} ${f(4)} C ${f(31)} ${f(4)} ${f(36)} ${f(9)} ${f(36)} ${f(20)}` +
    ` C ${f(36)} ${f(31)} ${f(31)} ${f(36)} ${f(20)} ${f(36)}` +
    ` C ${f(9)} ${f(36)} ${f(4)} ${f(31)} ${f(4)} ${f(20)}` +
    ` C ${f(4)} ${f(9)} ${f(9)} ${f(4)} ${f(20)} ${f(4)} Z`;
  const inner =
    ` M ${f(20)} ${f(12)} C ${f(26)} ${f(12)} ${f(28)} ${f(14)} ${f(28)} ${f(20)}` +
    ` C ${f(28)} ${f(26)} ${f(26)} ${f(28)} ${f(20)} ${f(28)}` +
    ` C ${f(14)} ${f(28)} ${f(12)} ${f(26)} ${f(12)} ${f(20)}` +
    ` C ${f(12)} ${f(14)} ${f(14)} ${f(12)} ${f(20)} ${f(12)} Z`;
  return outer + inner;
}
const SHAPES = {
  'circle (cubic)': circle,
  'ring (quad)': quadRing,
  'triangle (lines)': tri,
  'star (corners)': star,
  'tiny disc (r~5px)': tinyCircle,
  'ellipse (cubic)': ellipse,
  'curved counter': evenOddRing,
};
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N * SS}" height="${N * SS}"></canvas><script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const N=${N}, SS=${SS};
const mkR=(o,lb)=>{const r=createRenderer(gl,shaders,o); r.setLoopBlinnFill(lb); return r;};
const rSlug=mkR({},'off'), rAac=mkR({aacFill:true},'off'), rLb=mkR({},'on');
const rSlugX=mkR({},'off');   // (option removed: Slug IS exact now; column kept as a control)
// luminance of the black-on-white render == 255*(1-coverage)
const grab=(w,h)=>{const p=new Uint8Array(w*h*4); gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,p);
  const a=new Float64Array(w*h); for(let i=0;i<w*h;i++) a[i]=p[i*4]; return a;};
const render=async(r,svgTxt,n)=>{const b=createBundle(gl,svgTxt);
  r.prepareBundle && r.prepareBundle(b);      // LB needs its mesh, or it silently falls back to Slug
  r.setViewport(n,n); gl.viewport(0,0,n,n);
  // A MESH IS NOT ENOUGH, and waiting does not help either. While its fill variant is still linking
  // the draw falls back to the second-best engine and the gate reads 'variant-warming' — so a single
  // draw measured Slug and reported it in the LB column. Headless the idle-frame gate that would
  // catch up never accrues, so the variant has to be force-linked: draw once so the required variant
  // is known, THEN precompileFills, then measure.
  r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame();
  if (r.precompileFills) { try { r.precompileFills(); } catch {} }
  for(let i=0;i<60 && r.debugStats.unifiedFillGate==='variant-warming';i++){
    r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame();
    await new Promise(res=>requestAnimationFrame(res)); }
  const c0=r.debugStats.loopBlinnRouteCount;
  r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame();
  const routed=r.debugStats.loopBlinnRouteCount-c0;
  const a=grab(n,n); b.dispose(); a.routed=routed; a.gate=r.debugStats.unifiedFillGate||'-'; return a;};
const down=(hi,n,ss)=>{const lo=new Float64Array(n*n);
  for(let y=0;y<n;y++) for(let x=0;x<n;x++){ let s=0;
    for(let j=0;j<ss;j++) for(let i=0;i<ss;i++) s+=hi[(y*ss+j)*(n*ss)+(x*ss+i)];
    lo[y*n+x]=s/(ss*ss); } return lo; };
const err=(a,ref)=>{ let sum=0, mx=0, nEdge=0, nBad=0;
  for(let i=0;i<a.length;i++){ const r=ref[i]; if(r>2 && r<253){ const d=Math.abs(a[i]-r); sum+=d; if(d>mx)mx=d; if(d>25) nBad++; nEdge++; } }
  return {mean:sum/Math.max(1,nEdge), max:mx, nEdge, nBad}; };   // nBad: >0.1 coverage off
window.__run = async (shapes) => {
  const out=[];
  for(const [name,svgTxt,svgHi] of shapes){
    // preserveViewport: importSvg defaults to a PATH-TIGHT globalBBox, which the renderer then fits
    // to the viewport — so every shape below rasterized at the same size and the "tiny disc" case
    // silently rendered as large as the circle (ink 28961px2 for both). The high-curvature regime
    // was never actually measured. Keep the viewBox so authored size == rendered size.
    const IV = { preserveViewport: true };
    const secLo=await importSvg(svgTxt, IV), secHi=await importSvg(svgHi, IV);
    // 8x reference: Slug at 8x, box-downsampled. Geometric AA error shrinks ~1/SS.
    const refHi=await render(rSlug, secHi, N*SS); const ref=down(refHi,N,SS);
    const refHiA=await render(rAac, secHi, N*SS); const refA=down(refHiA,N,SS);
    // cross-check: the two 8x references must agree, else neither is a ground truth
    let rd=0; for(let i=0;i<ref.length;i++) rd+=Math.abs(ref[i]-refA[i]); rd/=ref.length;
    const slug=await render(rSlug, secLo, N), aac=await render(rAac, secLo, N), lb=await render(rLb, secLo, N), slugX=await render(rSlugX, secLo, N);
    // cost of the exact-edge path (order-corrected min of fwd/rev)
    const K=12, sync=()=>{const q=new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,q); return q[0];};
    const amort=(r)=>{const b=createBundle(gl,secLo); r.prepareBundle&&r.prepareBundle(b); r.setViewport(N,N); gl.viewport(0,0,N,N);
      const runs=[]; for(let rep=0;rep<7;rep++){ r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame(); sync();
        const t0=performance.now(); r.beginFrame([1,1,1,1]); for(let i=0;i<K;i++) r.drawBundle(b); r.endFrame(); sync();
        runs.push((performance.now()-t0)/K);} b.dispose(); runs.sort((x,y)=>x-y); return runs[3];};
    const f1=amort(rSlug), f2=amort(rSlugX), r2=amort(rSlugX), r1=amort(rSlug);
    const tS=Math.min(f1,r1), tX=Math.min(f2,r2);
    out.push({name, refDisagree:rd, lbRouted:lb.routed, lbGate:lb.gate, slug:err(slug,ref), aac:err(aac,ref), lb:err(lb,ref), slugX:err(slugX,ref), tS, tX});
  }
  return out;
};
window.__ready=true;</script></body></html>`;
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
await pg.waitForFunction(() => window.__ready === true, { timeout: 120000 });
const shapes = Object.entries(SHAPES).map(([k, f]) => [k, wrap(f(N), N), wrap(f(N * SS), N * SS)]);
const o = await pg.evaluate((s) => window.__run(s), shapes);
await br.close();
server.close();
console.log('shape             edgePx |  Slug: mean/max/bad(>0.1cov) |  AAC       |  LB');
for (const r of o) {
  const best = Math.min(r.slug.mean, r.aac.mean, r.lb.mean, r.slugX.mean);
  const tag = (v) => (v.mean === best ? '*' : ' ');
  console.log(
    `${r.name.padEnd(17)} ${String(r.slug.nEdge).padStart(6)} | ${r.slug.mean.toFixed(3).padStart(6)} max ${String(r.slug.max).padStart(3)} bad ${String(r.slug.nBad).padStart(4)} | aac ${r.aac.mean.toFixed(3)} bad ${String(r.aac.nBad).padStart(3)} | lb ${r.lb.mean.toFixed(3)} bad ${String(r.lb.nBad).padStart(4)}`,
  );
}
const unrouted = o.filter((r) => !r.lbRouted);
if (unrouted.length)
  console.log(
    `\n!! ${unrouted.length} row(s) did NOT route to LB (gate: ${unrouted.map((r) => r.lbGate).join(',')}) —` +
      ' their LB column is Slug, not Loop-Blinn, and must not be read as an LB score.',
  );
console.log('\n(* = most accurate. ref self-check = mean |Slug8x - AAC8x| after downsample;');
console.log(' it must be << the scores above, or the reference is not trustworthy.)');
