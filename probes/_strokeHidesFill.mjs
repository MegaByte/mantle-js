// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _strokeHidesFill — can a stroked shape skip its FILL's anti-aliasing?
//
// Hypothesis: an OPAQUE, UNDASHED stroke of half-width >= ~1px covers the fill's entire AA band,
// so the fill underneath may render hard-edged (no exterior strips, corner caps or cubic rings)
// and the composite is indistinguishable. If true, every stroked shape drops the band apparatus.
//
// TWO THINGS this PROBE HAD TO WORK AROUND, both of which silently produced "delta = 0.000":
//  1. LB does NOT route a stroked shape (measured: routed=0, zero LB meshes — stroked shapes take
//     the per-shape composed route with a Slug fill). So the band cannot be exercised through a
//     stroked bundle at all. Render fill and stroke separately and composite here.
//  2. The LB mesh cache is MODULE-level and keyed by shape, so toggling __LB_NO_BAND between two
//     renders in one page reuses the first mesh. Use a fresh page per setting.
//
// Everything is black-on-white, so coverage = 1 - lum/255 and OVER is exact. Controls (translucent
// and dashed strokes, and a 1px hairline) MUST fail, or the probe is measuring nothing.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const N = 192,
  SS = 8;

const discD = (n) => {
  const c = n / 2,
    r = n * 0.3,
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
const triD = (n) => `M ${0.2 * n} ${0.22 * n} L ${0.8 * n} ${0.4 * n} L ${0.34 * n} ${0.82 * n} Z`;
const svg = (n, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${n}" height="${n}">${body}</svg>`;
const path_ = (d, fill, w, op, dash) =>
  `<path d="${d}" fill="${fill}"` +
  (w
    ? ` stroke="#000000" stroke-width="${w}" stroke-opacity="${op}"` +
      (dash ? ` stroke-dasharray="${dash}"` : '')
    : '') +
  '/>';

// each case: fill-only svg, stroke-only svg, both svg (at 1x and 8x), expectation
const mkCase = (name, dOf, w, op, dashUnit, expect) => ({
  name,
  expect,
  fill: (n) => svg(n, path_(dOf(n), '#000000', 0, 1, null)),
  stroke: (n, s) =>
    svg(n, path_(dOf(n), 'none', w * s, op, dashUnit ? `${dashUnit * s} ${dashUnit * s}` : null)),
  both: (n, s) =>
    svg(
      n,
      path_(dOf(n), '#000000', w * s, op, dashUnit ? `${dashUnit * s} ${dashUnit * s}` : null),
    ),
});
const CASES = [];
for (const [sh, dOf] of [
  ['disc', discD],
  ['tri', triD],
]) {
  for (const w of [1, 2, 4]) CASES.push(mkCase(`${sh} opaque w=${w}`, dOf, w, 1, 0, w >= 2));
  CASES.push(mkCase(`${sh} translucent w=4`, dOf, 4, 0.45, 0, false));
  CASES.push(mkCase(`${sh} dashed w=4`, dOf, 4, 1, 6, false));
}

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N * SS}" height="${N * SS}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const N=${N}, SS=${SS}, IV={preserveViewport:true};
const rSlug=createRenderer(gl,shaders,{}); rSlug.setLoopBlinnFill('off');
const rLb  =createRenderer(gl,shaders,{}); rLb.setLoopBlinnFill('on');
// coverage of black-on-white
const cov=(w,h)=>{const p=new Uint8Array(w*h*4); gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,p);
  const a=new Float64Array(w*h); for(let i=0;i<w*h;i++) a[i]=1-p[i*4]/255; return a;};
const render=async(r,txt,n)=>{const b=createBundle(gl, await importSvg(txt,IV)); r.prepareBundle&&r.prepareBundle(b);
  r.setViewport(n,n); gl.viewport(0,0,n,n);
  const c0=r.debugStats.loopBlinnRouteCount;
  r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame();
  const a=cov(n,n); a.routed=r.debugStats.loopBlinnRouteCount-c0;
  let v=0; for(const m of (b._lbMeshes||[])) if(m&&m.vertexCount) v+=m.vertexCount; a.verts=v;
  b.dispose(); return a;};
const down=(hi,n,ss)=>{const lo=new Float64Array(n*n);
  for(let y=0;y<n;y++) for(let x=0;x<n;x++){ let s=0;
    for(let j=0;j<ss;j++) for(let i=0;i<ss;i++) s+=hi[(y*ss+j)*(n*ss)+(x*ss+i)];
    lo[y*n+x]=s/(ss*ss); } return lo; };
window.__run=async(cases,noBand)=>{
  globalThis.__LB_NO_BAND = noBand;   // set BEFORE any mesh is built (fresh page)
  const out=[];
  for(const c of cases){
    const ref=down(await render(rSlug,c.bothHi,N*SS),N,SS);
    const f=await render(rLb,c.fillLo,N);
    const s=await render(rSlug,c.strokeLo,N);
    // OVER: stroke over fill, both coverages of BLACK on white
    let sum=0,n=0,mx=0;
    for(let i=0;i<ref.length;i++){
      const comp=s[i]+f[i]*(1-s[i]);
      const r=ref[i];
      if(r>0.008 && r<0.992){ const d=Math.abs(comp-r)*255; sum+=d; if(d>mx)mx=d; n++; }
    }
    out.push({name:c.name, mean:sum/Math.max(1,n), max:mx, n, routed:f.routed, verts:f.verts});
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
const payload = CASES.map((c) => ({
  name: c.name,
  fillLo: c.fill(N),
  strokeLo: c.stroke(N, 1),
  bothHi: c.both(N * SS, SS),
}));

const once = async (noBand) => {
  const pg = await br.newPage();
  pg.on('pageerror', (e) => console.error(' [err]', e.message));
  await pg.goto(`http://127.0.0.1:${server.address().port}/`, {
    waitUntil: 'load',
    timeout: 90000,
  });
  await pg.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 50 });
  const r = await pg.evaluate((c, nb) => window.__run(c, nb), payload, noBand);
  await pg.close();
  return r;
};
const withBand = await once(false);
const noBand = await once(true);
await br.close();
server.close();

console.log('\n  mean |composite - 8x ref| on edge pixels, /255\n');
console.log('  case                     | band | no band | delta | verdict');
let bad = 0;
for (let i = 0; i < CASES.length; i++) {
  const a = withBand[i],
    b = noBand[i],
    d = b.mean - a.mean,
    expect = CASES[i].expect;
  const droppable = d < 0.5;
  const v = expect
    ? droppable
      ? 'YES — band droppable'
      : '*** PREDICTION FAILED'
    : droppable
      ? '*** CONTROL FAILED (should差)'
      : 'no — band needed (control ok)';
  if (expect !== droppable) bad++;
  console.log(
    `  ${a.name.padEnd(24)} | ${a.mean.toFixed(2).padStart(4)} | ${b.mean.toFixed(2).padStart(7)} | ${(d >= 0 ? '+' : '') + d.toFixed(2)} | ${v}`,
  );
}
console.log(
  `\n  LB routed on the fill: ${withBand[0].routed} (must be >0)   verts band=${withBand[0].verts} noBand=${noBand[0].verts}`,
);
console.log(
  bad ? `\n  ${bad} case(s) contradict the hypothesis` : '\n  all cases behave as predicted',
);
