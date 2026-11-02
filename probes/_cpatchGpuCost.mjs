// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _cpatchGpuCost — is a CPatch fill actually FASTER than what we ship?
//
// probes/_cpatchProto.mjs proved the formulation fills a curved region exactly with no
// triangulation. This prices it. The CPatch fragment cost is N curve-implicit
// evaluations per covered pixel, INCLUDING interior pixels — where our LB route pays
// nothing (plain interior triangles) and Slug/AAC/GWN pay a band or tree walk.
//
// Dokter's answer to interior cost is the hierarchy: sub-tiles fully inside skip curve
// testing entirely. That needs compute (or a bake-time equivalent). This probe measures
// the NAIVE conjunction — the paper's own "naive rasterization" — so the number is a
// LOWER BOUND on CPatch performance and an UPPER BOUND on what the hierarchy must
// recover. If naive already wins, the hierarchy is upside; if it loses badly, the
// hierarchy is load-bearing and WebGL2 cannot supply it.
//
// FIVE HARNESS TRAPS this probe survives, each of which produces a confident
// wrong number. They are the reason it looks over-built:
//
//  1. HIDDEN-SURFACE REMOVAL. Apple TBDR collapses N identical OPAQUE fullscreen
//     triangles to ONE shaded pass, while the Mantle arm blends and cannot collapse —
//     so an opaque arm measures one shade against K (~100 TFLOP/s on a ~7 TFLOP part, a
//     45x error). The CPatch arm BLENDS.
//  2. COMPARING ABSOLUTES. drawBundle carries this renderer's per-draw cost; a bare
//     drawArrays does not. Take the SLOPE between two resolutions so fixed cost cancels.
//     (Binding is NOT the cost — probes/_glCallAudit records the unified route at 9 GL
//     calls/frame, 0 redundant — but comparing absolutes is still invalid.)
//  3. NO AA. `inside *= step(...)`, a binary point-in-region test, against engines computing
//     analytic COVERAGE measures "no AA vs AA". The CPatch arm computes coverage.
//  4. MISMATCHED FIT. The renderer fits the CONTENT BBOX; a shader that maps a fixed
//     range draws the same shape at a different on-screen size.
//  5. ASSUMED BBOX. R+bulge overstates it — an inscribed N-gon's bulge apex sits INSIDE
//     the vertices. Sample the curves instead.
//
// The ink gate catches 4 and 5. Traps 1 and 3 show only by asking whether the
// number is physically possible. KEEP THE INK GATE AND THE QUALITY COLUMN: an arm that
// renders nothing, or renders it hard-edged, is arbitrarily fast.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="1024" height="1024"></canvas>
<script type="module">
globalThis.__MANTLE_DEBUG__ = true;   // createRenderer's fillDefines is a test hook, read only under it
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const cv=document.getElementById('c');
const gl=cv.getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const sync=()=>{const p=new Uint8Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p);return p[0];};

// ---- CPatch arm: one quad, N curve implicits per fragment ------------------------
const VS = \`#version 300 es
layout(location=0) in vec2 aPos; out vec2 vP;
void main(){ vP = aPos*0.5+0.5; gl_Position = vec4(aPos,0.0,1.0); }\`;
// N quadratic bounding curves, klm-style: u^2 - v with (u,v) affine over the control
// triangle, exactly as the CPU prototype. Inside = intersection of all half-spaces.
const FS = (N, AA) => \`#version 300 es
precision highp float;
in vec2 vP; out vec4 o;
uniform vec2 uP0[\${N}], uP1[\${N}], uP2[\${N}];
uniform float uS[\${N}];
uniform vec4 uBB;   // content bbox (x0,y0,w,h) — match the renderer's fit
uniform vec2 uRes;
// Implicit AND its analytic screen-space gradient. u,v are affine in p, so grad(u^2-v)
// = 2u*grad(u) - grad(v) with grad(u), grad(v) constant per curve.
// WITHOUT this the arm is a binary step() — a hard-edged inside/outside test — while
// AAC/LB/Slug are all computing antialiased COVERAGE. Comparing those measures "no AA vs
// AA", not two fills.
float evAA(vec2 p, vec2 a, vec2 b, vec2 c, vec2 dpx, out float gpx){
  float det = (b.y-c.y)*(a.x-c.x) + (c.x-b.x)*(a.y-c.y);
  vec2 gwa = vec2(b.y-c.y, c.x-b.x)/det;
  vec2 gwb = vec2(c.y-a.y, a.x-c.x)/det;
  float wa = gwa.x*(p.x-c.x) + gwa.y*(p.y-c.y);
  float wb = gwb.x*(p.x-c.x) + gwb.y*(p.y-c.y);
  float u = wb*0.5 + (1.0-wa-wb);
  float v = (1.0-wa-wb);
  vec2 gu = gwb*0.5 - (gwa+gwb);
  vec2 gv = -(gwa+gwb);
  vec2 gf = 2.0*u*gu - gv;
  gpx = length(gf*dpx);
  return u*u - v;
}
void main(){
  vec2 p = uBB.xy + vP*uBB.zw;   // same on-screen geometry as the Mantle arm
  vec2 dpx = uBB.zw / uRes;      // em per device pixel, per axis
  float cov = 1.0;
  for (int i=0;i<\${N};i++){
    vec2 A = uP0[i], B = uP2[i];
    float g;
    float f = uS[i]*evAA(p, A, uP1[i], B, dpx, g);

    // EXTENSION CORRECTION. A curve's implicit zero-set is the WHOLE algebraic curve, not
    // the segment: outside the span the extension curls back and cuts the patch, which is
    // what made N=12 under-fill by 37%. The paper prunes those crossings at CONVERSION
    // time by inserting a curve; the shader-side equivalent, valid for a convex patch, is
    // to fall back OUTSIDE THE SPAN to the CHORD half-plane — globally correct the way a
    // polygon edge is — and let the neighboring curve own that region. Inside the span
    // the curve implicit refines the chord, which is the point of the patch.
    vec2 ab = B - A;
    float tproj = dot(p - A, ab) / max(dot(ab, ab), 1e-9);
    vec2 nch = uS[i] * vec2(-ab.y, ab.x);
    float fch = dot(nch, p - A);
    float gch = length(nch * dpx);
    bool inSpan = tproj > 0.0 && tproj < 1.0;
    float fu = inSpan ? f : fch;
    float gu = inSpan ? g : gch;

    // AA=0 is the BINARY conjunction - the paper's "naive rasterization". Its honest
    // counterpart is the winding-only tree (MANTLE_HARD_TREE), not the AA engines.
    float c1 = \${AA} == 1 ? clamp(0.5 + fu / max(gu, 1e-9), 0.0, 1.0) : step(0.0, fu);
    cov = min(cov, c1);
  }
  o = vec4(vec3(0.0), cov);   // premultiplied black over white, same as the Mantle arm
}\`;
function mkProg(vs,fs){
  const c=(t,s)=>{const x=gl.createShader(t);gl.shaderSource(x,s);gl.compileShader(x);
    if(!gl.getShaderParameter(x,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x)); return x;};
  const p=gl.createProgram(); gl.attachShader(p,c(gl.VERTEX_SHADER,vs)); gl.attachShader(p,c(gl.FRAGMENT_SHADER,fs));
  gl.linkProgram(p); if(!gl.getProgramParameter(p,gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}
const quadVao=(()=>{const v=gl.createVertexArray();gl.bindVertexArray(v);
  const b=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,b);
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
  gl.bindVertexArray(null);return v;})();

// Line-for-line mirror of the fragment shader's ev(): same vertex order, same weights.
function evJS(p, a, b, c){
  const det = (b[1]-c[1])*(a[0]-c[0]) + (c[0]-b[0])*(a[1]-c[1]);
  const wa = ((b[1]-c[1])*(p[0]-c[0]) + (c[0]-b[0])*(p[1]-c[1]))/det;
  const wb = ((c[1]-a[1])*(p[0]-c[0]) + (a[0]-c[0])*(p[1]-c[1]))/det;
  const u = wb*0.5 + (1-wa-wb);
  const v = (1-wa-wb);
  return u*u - v;
}

// an N-gon of outward-bulging quadratics — a valid CPatch by construction
function patch(N,R,amt){
  const C=[200,200], P0=[],P1=[],P2=[],S=[];
  const pt=(j)=>[C[0]+R*Math.cos(2*Math.PI*j/N), C[1]+R*Math.sin(2*Math.PI*j/N)];
  for(let j=0;j<N;j++){
    const a=pt(j), b=pt((j+1)%N);
    const mx=(a[0]+b[0])/2,my=(a[1]+b[1])/2; let ox=mx-C[0],oy=my-C[1];
    const L=Math.hypot(ox,oy)||1;
    const m=[mx+ox/L*amt,my+oy/L*amt];
    P0.push(a[0],a[1]); P1.push(m[0],m[1]); P2.push(b[0],b[1]);
    // Orient from the center using the EXACT function the shader evaluates. Deriving the
    // sign from a differently-ordered barycentric gave the wrong side on some curves,
    // which silently clipped the region and showed up only as an ink mismatch.
    S.push(evJS(C, a, m, b) >= 0 ? 1 : -1);
  }
  return {P0:new Float32Array(P0),P1:new Float32Array(P1),P2:new Float32Array(P2),S:new Float32Array(S)};
}
function timeCPatch(N,res,aa){
  const pr=mkProg(VS,FS(N,aa?1:0)); const pa=patch(N,150,26);
  cv.width=res; cv.height=res; gl.viewport(0,0,res,res);
  gl.useProgram(pr); gl.bindVertexArray(quadVao);
  // DEFEAT HIDDEN-SURFACE REMOVAL. This is Apple TBDR: N identical OPAQUE fullscreen
  // triangles collapse to ONE shaded pass, so the arm measured a single shade however
  // many draws were issued — which is how it produced 0.0017 ns/px, ~100 TFLOP/s on a
  // ~7 TFLOP part. The Mantle arm blends (One, OneMinusSrcAlpha) and cannot be collapsed,
  // so leaving this out compared one shade against K.
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.uniform2fv(gl.getUniformLocation(pr,'uP0'),pa.P0);
  gl.uniform2fv(gl.getUniformLocation(pr,'uP1'),pa.P1);
  gl.uniform2fv(gl.getUniformLocation(pr,'uP2'),pa.P2);
  gl.uniform1fv(gl.getUniformLocation(pr,'uS'),pa.S);
  // TRUE content bbox, sampled off the curves. Assuming R+bulge was wrong: for an
  // inscribed N-gon the edge bulge apex sits INSIDE the vertices, so that overstated the
  // box and rendered the shape under-scaled — visible only as an ink mismatch, not as a
  // wrong picture.
  let bx0=1e9,by0=1e9,bx1=-1e9,by1=-1e9;
  for(let j=0;j<N;j++){
    const a=[pa.P0[2*j],pa.P0[2*j+1]], m=[pa.P1[2*j],pa.P1[2*j+1]], b=[pa.P2[2*j],pa.P2[2*j+1]];
    for(let t=0;t<=1.0001;t+=1/64){ const u=1-t;
      const x=u*u*a[0]+2*u*t*m[0]+t*t*b[0], y=u*u*a[1]+2*u*t*m[1]+t*t*b[1];
      if(x<bx0)bx0=x; if(x>bx1)bx1=x; if(y<by0)by0=y; if(y>by1)by1=y; } }
  gl.uniform4f(gl.getUniformLocation(pr,'uBB'), bx0, by0, bx1-bx0, by1-by0);
  gl.uniform2f(gl.getUniformLocation(pr,'uRes'), res, res);
  const K=200, runs=[];
  for(let rep=0;rep<9;rep++){
    gl.drawArrays(gl.TRIANGLES,0,3); sync();
    const t0=performance.now();
    for(let i=0;i<K;i++) gl.drawArrays(gl.TRIANGLES,0,3);
    sync(); runs.push((performance.now()-t0)/K);
  }
  // CORRECTNESS GATE: an arm that renders nothing is infinitely fast. Count ink from a
  // CLEAN single draw — the timed loop blends K times over the same buffer and saturates
  // the whole canvas, which reads as 100% ink and hides a wrong region.
  gl.clearColor(1,1,1,1); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLES,0,3); sync();
  const px=new Uint8Array(res*res*4); gl.readPixels(0,0,res,res,gl.RGBA,gl.UNSIGNED_BYTE,px);
  let ink=0; for(let i=0;i<px.length;i+=4) if(px[i]<128) ink++;
  gl.disable(gl.BLEND);
  gl.bindVertexArray(null); runs.sort((a,b)=>a-b);
  return {ms:+runs[4].toFixed(4), ink};
}

// ---- Mantle arm: the same N-gon shape through our engines -------------------------
function svgFor(N){
  const C=200,R=150,amt=26; const pt=(j)=>[C+R*Math.cos(2*Math.PI*j/N), C+R*Math.sin(2*Math.PI*j/N)];
  let d='M '+pt(0).map(v=>v.toFixed(3)).join(' ')+' ';
  for(let j=0;j<N;j++){ const a=pt(j),b=pt((j+1)%N);
    const mx=(a[0]+b[0])/2,my=(a[1]+b[1])/2; let ox=mx-C,oy=my-C; const L=Math.hypot(ox,oy)||1;
    d+='Q '+(mx+ox/L*amt).toFixed(3)+' '+(my+oy/L*amt).toFixed(3)+' '+b[0].toFixed(3)+' '+b[1].toFixed(3)+' '; }
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><path d="'+d+'Z" fill="#000"/></svg>';
}
async function timeMantle(N,res,engine){
  const opts = engine==='aac' ? {aacFill:true}
             : engine==='hard' ? {fillDefines:['MANTLE_HARD','MANTLE_HARD_TREE','MANTLE_GWN']}
             : {};
  const r=createRenderer(gl,shaders,opts);
  if(engine==='lb') r.setLoopBlinnFill('on');
  const sec=await importSvg(svgFor(N), (engine==='gwn'||engine==='hard')?{gwnTree:true}:undefined);
  const b=createBundle(gl,sec); r.prepareBundle&&r.prepareBundle(b);
  if(engine==='lb'&&r.awaitLbReady) await r.awaitLbReady(b,20000).catch(()=>{});
  cv.width=res; cv.height=res; r.setViewport(res,res); gl.viewport(0,0,res,res);
  const K=8, runs=[];
  for(let rep=0;rep<9;rep++){
    r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame(); sync();
    const t0=performance.now(); r.beginFrame([1,1,1,1]);
    for(let i=0;i<K;i++) r.drawBundle(b);
    r.endFrame(); sync(); runs.push((performance.now()-t0)/K);
  }
  const px=new Uint8Array(res*res*4); gl.readPixels(0,0,res,res,gl.RGBA,gl.UNSIGNED_BYTE,px);
  let ink=0; for(let i=0;i<px.length;i+=4) if(px[i]<128) ink++;
  b.dispose(); runs.sort((a,b)=>a-b);
  return {ms:+runs[4].toFixed(4), ink};
}
// SLOPE, not absolute time. The CPatch arm times a bare drawArrays; the Mantle arm times
// drawBundle, which carries this renderer's per-draw bind overhead (~10 textures) — the
// cost that dominates a small draw. Comparing absolutes measures OUR BINDS, not
// CPatch's shading, and flatters CPatch by ~20x. Timing at two resolutions and taking
// (t_hi - t_lo) / (px_hi - px_lo) cancels the per-draw fixed cost on both arms and leaves
// the per-pixel shading cost, which is the thing actually under test.
// AA QUALITY. Speed means nothing if the coverage is worse: the CPatch arm uses a crude
// clamp(0.5+d) box ramp with a min() combiner, where AAC/LB/Slug use exact box-area
// coverage with corner combiners. Score every arm against an 8x-supersampled AAC render
// of the same shape, box-downsampled — independent of all four arms at 1x.
function down(px,N,S){ const n=N/S, out=new Float64Array(n*n);
  for(let y=0;y<n;y++)for(let x=0;x<n;x++){ let s=0;
    for(let j=0;j<S;j++)for(let i=0;i<S;i++) s+=255-px[(((y*S+j)*N)+(x*S+i))*4];
    out[y*n+x]=s/(S*S)/255; } return out; }
function grab(res){ const px=new Uint8Array(res*res*4); gl.readPixels(0,0,res,res,gl.RGBA,gl.UNSIGNED_BYTE,px); return px; }
function score(a,ref){ let s=0,c=0;
  for(let i=0;i<a.length;i++){ if(a[i]>0.004||ref[i]>0.004){ s+=Math.abs(a[i]-ref[i]); c++; } }
  return +(255*s/Math.max(c,1)).toFixed(3); }

window.__run=async(Ns,lo,hi)=>{
  const out=[];
  const dpx = hi*hi - lo*lo;
  for(const N of Ns){
    const cL=timeCPatch(N,lo,true),  cH=timeCPatch(N,hi,true);
    const nL=timeCPatch(N,lo,false), nH=timeCPatch(N,hi,false);
    const hL=await timeMantle(N,lo,'hard'), hH=await timeMantle(N,hi,'hard');
    const aL=await timeMantle(N,lo,'aac'), aH=await timeMantle(N,hi,'aac');
    const lL=await timeMantle(N,lo,'lb'),  lH=await timeMantle(N,hi,'lb');
    const sL=await timeMantle(N,lo,'slug'),sH=await timeMantle(N,hi,'slug');
    const ns=(a,b)=>+(((b.ms-a.ms)/dpx)*1e6).toFixed(4);   // ns per pixel
    const gL=await timeMantle(N,lo,'gwn'), gH=await timeMantle(N,hi,'gwn');
    // ---- quality at 256, against an 8x AAC reference ----
    const Q=256;
    await timeMantle(N,Q*8,'aac'); const ref=down(grab(Q*8),Q*8,8);
    timeCPatch(N,Q);             const qC=down(grab(Q),Q,1);
    await timeMantle(N,Q,'aac'); const qA=down(grab(Q),Q,1);
    await timeMantle(N,Q,'lb');  const qL=down(grab(Q),Q,1);
    await timeMantle(N,Q,'gwn'); const qG=down(grab(Q),Q,1);
    out.push({N, cpatch:ns(cL,cH), noaa:ns(nL,nH), hard:ns(hL,hH),
              aac:ns(aL,aH), lb:ns(lL,lH), slug:ns(sL,sH), gwn:ns(gL,gH),
              inkC:cH.ink, inkM:lH.ink, inkN:nH.ink, inkH:hH.ink,
              eC:score(qC,ref), eA:score(qA,ref), eL:score(qL,ref), eG:score(qG,ref)});
  }
  return out;
};
window.__ready=true;
</script></body></html>`;
const mime = (p) =>
  /\.(js|mjs)$/.test(p) ? 'text/javascript' : p.endsWith('.glsl') ? 'text/plain' : 'text/html';
const server = http.createServer((q, res) => {
  try {
    const _p = q.url.split('?')[0];
    if (_p === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(HTML);
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
const br = await launchBrowser({
  headless: 'new',
  args: ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
  protocolTimeout: 300000,
});
const pg = await br.newPage();
pg.on('pageerror', (e) => console.log('[page-err]', e.message));
pg.on('console', (m) => {
  if (m.type() !== 'log') console.log('[' + m.type() + ']', m.text());
});
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 60000 });
await pg.waitForFunction('window.__ready===true', { timeout: 60000 });
const rows = await pg.evaluate((ns, lo, hi) => window.__run(ns, lo, hi), [3, 5, 8, 12], 512, 2048);
console.log("per-pixel SHADING cost, ns/px — slope between 512 and 2048, so each arm's");
console.log('per-draw fixed cost cancels. Lower is better.\n');
console.log('NO-AA pair (binary conjunction vs the winding-only tree, MANTLE_HARD_TREE):');
console.log('curves   CPatch-noAA   GWN-hard   ratio | ink noAA/hard');
for (const r of rows) {
  const ok = r.inkH > 0 && Math.abs(r.inkN - r.inkH) / r.inkH < 0.15;
  console.log(
    `${String(r.N).padStart(6)} ${String(r.noaa).padStart(13)} ${String(r.hard).padStart(10)} ${(r.hard > 0 ? (r.noaa / r.hard).toFixed(3) + 'x' : 'n/a').padStart(8)} | ${String(r.inkN).padStart(8)}/${String(r.inkH).padStart(8)} ${ok ? 'OK' : 'BAD'}`,
  );
}
console.log('\nAA pair (analytic coverage both sides):');
console.log(
  'curves | ns/px: CPatch    AAC     LB   Slug    GWN | AA err /255 vs 8x: CPatch   AAC    LB   GWN | ink',
);
for (const r of rows) {
  const inkOk = r.inkM > 0 && Math.abs(r.inkC - r.inkM) / r.inkM < 0.15;
  console.log(
    `${String(r.N).padStart(6)} | ` +
      `${String(r.cpatch).padStart(11)} ${String(r.aac).padStart(6)} ${String(r.lb).padStart(6)} ${String(r.slug).padStart(6)} ${String(r.gwn).padStart(6)} | ` +
      `${String(r.eC).padStart(17)} ${String(r.eA).padStart(5)} ${String(r.eL).padStart(5)} ${String(r.eG).padStart(5)} | ${inkOk ? 'OK' : 'BAD'}`,
  );
}
await br.close();
server.close();
