// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _gwnSdfAA — can AA come from the GWN tree itself, without AAC?
// Coverage = exactBoxCov(normal, distance) of the NEAREST segment found during traversal; winding
// decides inside/outside. Scored against an 8x-supersampled reference (Slug at 8x, box-downsampled)
// so neither engine is the yardstick. Quad-only content (the kernel handles LINE + QUAD).
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 192,
  SS = 8;
const K = 8;
const flower = (n, bulge) => {
  const c = n / 2,
    r = n * 0.36;
  const P = (j) => [
    c + r * Math.cos((2 * Math.PI * j) / K),
    c + r * Math.sin((2 * Math.PI * j) / K),
  ];
  let d = `M ${P(0)[0].toFixed(4)} ${P(0)[1].toFixed(4)} `;
  for (let j = 0; j < K; j++) {
    const A = P(j),
      B = P(j + 1);
    const mx = (A[0] + B[0]) / 2 + (B[1] - A[1]) * bulge,
      my = (A[1] + B[1]) / 2 - (B[0] - A[0]) * bulge;
    d += `Q ${mx.toFixed(4)} ${my.toFixed(4)} ${B[0].toFixed(4)} ${B[1].toFixed(4)} `;
  }
  return d + 'Z';
};
const tri = (n) => `M ${0.2 * n} ${0.22 * n} L ${0.8 * n} ${0.4 * n} L ${0.34 * n} ${0.82 * n} Z`;
// holed ring: outer quad-flower + inner reversed quad-flower (multi-contour winding: the
// per-contour forest fix — a straddling far node telescopes across the contour gap)
const holed = (n) => {
  const c = n / 2;
  const ring = (r, bulge, rev) => {
    const P = (j) => [
      c + r * Math.cos((2 * Math.PI * (rev ? -j : j)) / K),
      c + r * Math.sin((2 * Math.PI * (rev ? -j : j)) / K),
    ];
    let d = `M ${P(0)[0].toFixed(4)} ${P(0)[1].toFixed(4)} `;
    for (let j = 0; j < K; j++) {
      const A = P(j),
        B = P(j + 1);
      const mx = (A[0] + B[0]) / 2 + (B[1] - A[1]) * bulge,
        my = (A[1] + B[1]) / 2 - (B[0] - A[0]) * bulge;
      d += `Q ${mx.toFixed(4)} ${my.toFixed(4)} ${B[0].toFixed(4)} ${B[1].toFixed(4)} `;
    }
    return d + 'Z ';
  };
  return ring(n * 0.4, 0.15, false) + ring(n * 0.22, 0.15, true);
};
const wrap = (d, n) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${n}" height="${n}"><path fill="#000000" d="${d}"/></svg>`;
// cubic circle (4 C segs) + arc capsule (A segs) — the piece-expanded types
const cubicCircle = (n) => {
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
const arcCapsule = (n) => {
  const a = 0.25 * n,
    b = 0.75 * n,
    r = 0.18 * n,
    m = n / 2;
  return `M ${a} ${m - r} L ${b} ${m - r} A ${r} ${r} 0 0 1 ${b} ${m + r} L ${a} ${m + r} A ${r} ${r} 0 0 1 ${a} ${m - r} Z`;
};
const SHAPES = {
  'flower (kinked joints)': (n) => flower(n, 0.35),
  'near-circle (smooth)': (n) => flower(n, 0.128),
  'triangle (lines+corners)': tri,
  'holed ring (2 contours)': holed,
  'cubic circle (4 C)': cubicCircle,
  'arc capsule (A segs)': arcCapsule,
};
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N * SS}" height="${N * SS}"></canvas>
<script type="module">
globalThis.__MANTLE_DEBUG__ = true;   // createRenderer's fillDefines is a test hook, read only under it
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const N=${N}, SS=${SS}, IV={preserveViewport:true};
const rSlug=createRenderer(gl,shaders,{}); rSlug.setLoopBlinnFill('off');
const rAac =createRenderer(gl,shaders,{aacFill:true}); rAac.setLoopBlinnFill('off');
const rSdf =createRenderer(gl,shaders,{fillDefines:['MANTLE_GWN','MANTLE_GWN_SDF']}); rSdf.setLoopBlinnFill('off');
const sync=()=>{const p=new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p); return p[0];};
const grab=(n)=>{const p=new Uint8Array(n*n*4); gl.readPixels(0,0,n,n,gl.RGBA,gl.UNSIGNED_BYTE,p);
  const a=new Float64Array(n*n); for(let i=0;i<n*n;i++) a[i]=p[i*4]; return a;};
const render=(r,sec,n)=>{const b=createBundle(gl,sec); r.setViewport(n,n); gl.viewport(0,0,n,n);
  r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame(); sync(); const a=grab(n); b.dispose(); return a;};
const timeIt=(r,sec)=>{const b=createBundle(gl,sec); r.setViewport(N,N); gl.viewport(0,0,N,N);
  const Kk=8, runs=[]; for(let rep=0;rep<7;rep++){const t0=performance.now(); r.beginFrame([1,1,1,1]);
    for(let i=0;i<Kk;i++) r.drawBundle(b); r.endFrame(); sync(); runs.push((performance.now()-t0)/Kk);}
  runs.sort((a,b)=>a-b); b.dispose(); return runs[3];};
const down=(hi,n,ss)=>{const lo=new Float64Array(n*n);
  for(let y=0;y<n;y++) for(let x=0;x<n;x++){let s=0;
    for(let j=0;j<ss;j++) for(let i=0;i<ss;i++) s+=hi[(y*ss+j)*(n*ss)+(x*ss+i)];
    lo[y*n+x]=s/(ss*ss);} return lo;};
const err=(a,ref)=>{let sum=0,nE=0,bad=0,mx=0; const worst=[];
  for(let i=0;i<a.length;i++){const r=ref[i]; if(r>2&&r<253){const d=Math.abs(a[i]-r); sum+=d; if(d>mx)mx=d; if(d>25){bad++;worst.push([i%N,(i/N)|0,Math.round(a[i]),Math.round(r)]);} nE++;}}
  return {mean:sum/Math.max(1,nE), bad, max:mx, worst:worst.slice(0,6)};};
window.__run=async(shapes)=>{
  const out=[];
  for(const [name,lo,hi] of shapes){
    const secLo=await importSvg(lo,IV), secHi=await importSvg(hi,IV);
    const secG=await importSvg(lo,{...IV,gwnTree:true});
    const ref=down(render(rSlug,secHi,N*SS),N,SS);
    const aac=render(rAac,secLo,N), sdf=render(rSdf,secG,N);
    out.push({name, aac:err(aac,ref), sdf:err(sdf,ref), tAac:timeIt(rAac,secLo), tSdf:timeIt(rSdf,secG)});
  }
  return out;
};
window.__ready=true;
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
pg.on('pageerror', (e) => console.error(' [pageerror]', e.message.slice(0, 400)));
pg.on('console', (m) => console.error(' [console]', m.text().slice(0, 400)));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 90000 });
await pg.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 50 });
const shapes = Object.entries(SHAPES).map(([k, f]) => [k, wrap(f(N), N), wrap(f(N * SS), N * SS)]);
const o = await pg.evaluate((s) => window.__run(s), shapes);
await br.close();
server.close();
console.log('\n  mean |error| vs an 8x reference, /255\n');
console.log('  shape                    |  AAC   bad |  GWN+SDF  bad |  AAC ms  SDF ms');
for (const r of o) {
  console.log(
    `  ${r.name.padEnd(24)} | ${r.aac.mean.toFixed(3).padStart(5)} ${String(r.aac.bad).padStart(4)} | ${r.sdf.mean.toFixed(3).padStart(8)} ${String(r.sdf.bad).padStart(4)} | ${r.tAac.toFixed(3)}  ${r.tSdf.toFixed(3)}`,
  );
  if (r.sdf.worst && r.sdf.worst.length)
    console.log('     sdf worst (x,y,got,ref):', r.sdf.worst.map((w) => w.join(',')).join('  '));
}
