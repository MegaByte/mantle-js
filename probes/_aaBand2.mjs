// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _aaBand2 — LB unified curve band (kind 12) scored against an 8x box-downsampled
// Slug/AAC reference (the _aaAccuracy method).
//
// Shapes chosen to exercise the band's END machinery, not just its body:
//   ring (quad)      — 8 quads, tangent-DIScontinuous joints (span/bisector partitions)
//   quad-line box    — bulged square: quad sides meeting straight edges at convex corners
//                      (kind-10 cede ↔ band span-clip complementarity)
//   quad star        — quads with alternating sharp convex/reflex quad-quad corners
//                      (bisector partition + chained union/intersection)
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 192,
  SS = 8;
const wrap = (d, n) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${n}" height="${n}"><path fill="#000000" d="${d}"/></svg>`;
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
// Bulged square: quads on top/bottom, straight lines on the sides → four quad-line corners.
function quadLineBox(n) {
  const a = 0.18 * n,
    b = 0.82 * n,
    bulge = 0.14 * n,
    m = n / 2;
  return `M ${a} ${a} Q ${m} ${a - bulge} ${b} ${a} L ${b} ${b} Q ${m} ${b + bulge} ${a} ${b} Z`;
}
// Star of quads: sharp convex tips and reflex valleys, every joint quad-quad.
function quadStar(n) {
  const c = n / 2,
    R = n * 0.42,
    r = n * 0.19,
    K = 5;
  let pts = [];
  for (let i = 0; i < 2 * K; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / K,
      rad = i % 2 ? r : R;
    pts.push([c + rad * Math.cos(a), c + rad * Math.sin(a)]);
  }
  let d = `M ${pts[0][0].toFixed(4)} ${pts[0][1].toFixed(4)} `;
  for (let i = 0; i < 2 * K; i++) {
    const A = pts[i],
      B = pts[(i + 1) % (2 * K)];
    const mx = (A[0] + B[0]) / 2 + (B[1] - A[1]) * 0.12,
      my = (A[1] + B[1]) / 2 - (B[0] - A[0]) * 0.12;
    d += `Q ${mx.toFixed(4)} ${my.toFixed(4)} ${B[0].toFixed(4)} ${B[1].toFixed(4)} `;
  }
  return d + 'Z';
}
const SHAPES = { 'ring (quad)': quadRing, 'quad-line box': quadLineBox, 'quad star': quadStar };
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N * SS}" height="${N * SS}"></canvas><script type="module">
window.__MANTLE_DEBUG__=true;
window.__LB_BAND2_NOCHAIN=${!!process.env.NOCHAIN};
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const N=${N}, SS=${SS};
const mkR=(o,lb)=>{const r=createRenderer(gl,shaders,o); r.setLoopBlinnFill(lb); return r;};
// AAC reference: the Slug walker corrupts the quad-line box at 8x (apex hole + band-aligned
// coverage error — see the Slug-8x-box task); AAC's exact-area integral is clean there.
// Slug low-res stays as the low-res cross-check column.
const rSlug=mkR({},'off'), rAac=mkR({aacFill:true},'off'), rLb=mkR({},'on');
const grab=(w,h)=>{const p=new Uint8Array(w*h*4); gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,p);
  const a=new Float64Array(w*h); for(let i=0;i<w*h;i++) a[i]=p[i*4]; return a;};
const render=(r,svgTxt,n)=>{const b=createBundle(gl,svgTxt);
  r.prepareBundle && r.prepareBundle(b);
  r.setViewport(n,n); gl.viewport(0,0,n,n);
  const c0=r.debugStats.loopBlinnRouteCount;
  r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame();
  const routed=r.debugStats.loopBlinnRouteCount-c0;
  const a=grab(n,n); b.dispose(); a.routed=routed; return a;};
const down=(hi,n,ss)=>{const lo=new Float64Array(n*n);
  for(let y=0;y<n;y++) for(let x=0;x<n;x++){ let s=0;
    for(let j=0;j<ss;j++) for(let i=0;i<ss;i++) s+=hi[(y*ss+j)*(n*ss)+(x*ss+i)];
    lo[y*n+x]=s/(ss*ss); } return lo; };
const err=(a,ref)=>{ let sum=0, mx=0, nEdge=0, nBad=0; const worst=[];
  for(let i=0;i<a.length;i++){ const r=ref[i]; if(r>2 && r<253){ const d=Math.abs(a[i]-r); sum+=d; if(d>mx)mx=d; if(d>25){ nBad++; worst.push([i%${N},(i/${N})|0,Math.round(d),Math.round(a[i]),Math.round(r)]); } nEdge++; } }
  worst.sort((p,q)=>q[2]-p[2]);
  return {mean:sum/Math.max(1,nEdge), max:mx, nEdge, nBad, worst:worst.slice(0,8)}; };
window.__run = async (shapes) => {
  const out=[];
  for(const [name,svgTxt,svgHi] of shapes){
    const IV = { preserveViewport: true };
    const secLo=await importSvg(svgTxt, IV), secHi=await importSvg(svgHi, IV);
    const refHi=render(rAac, secHi, N*SS); const ref=down(refHi,N,SS);
    const lb=render(rLb, secLo, N);
    const slugLo=render(rSlug, secLo, N);   // self-check: Slug-low vs its own 8x reference
    out.push({name, lbRouted:lb.routed, lb:err(lb,ref), slug:err(slugLo,ref)});
  }
  return out;
};
window.__ready=true;</script></body></html>`;
const shapes = Object.entries(SHAPES).map(([k, f]) => [k, wrap(f(N), N), wrap(f(N * SS), N * SS)]);
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
const rows = await pg.evaluate((s) => window.__run(s), shapes);
await br.close();
server.close();
console.log('shape           | slug self-chk | LB: mean/max/bad | routed');
for (const R of rows) {
  console.log(
    `${R.name.padEnd(15)} | ${R.slug.mean.toFixed(3).padStart(6)} bad ${String(R.slug.nBad).padStart(4)} | ${R.lb.mean.toFixed(3).padStart(6)} max ${String(R.lb.max).padStart(3)} bad ${String(R.lb.nBad).padStart(4)} | ${R.lbRouted}`,
  );
  if (R.lb.worst && R.lb.worst.length)
    console.log(`   worst (x,y,d,got,ref): ${R.lb.worst.map((w) => w.join(',')).join('  ')}`);
}
