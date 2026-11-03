// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _cpatchDrawSpeed — the actual GPU draw speed of a CPatch fill, using REAL converted patches.
//
// probes/_cpatchGpuCost.mjs times a single N-gon patch with the per-fragment chord hack for
// extension correction. That hack under-fills — its ink gate reads BAD at N>=5 — so above N=3
// it times a shape that is mostly not being drawn; only its N=3 row is valid.
//
// probes/_cpatchCutter.mjs removes the hack: it converts a contour into patches whose union is
// the region exactly. This probe draws THOSE, so the whole family is measurable:
//
//   * one drawArrays per patch, geometry = the patch's own ORIENTED bounding box. The box is
//     not tested in the shader at all — the rasterizer clips it, free, exactly as it clips a
//     Loop-Blinn control triangle.
//   * boundary curves get analytic AA (coverage from f / |grad f| in pixels); CUT seams the
//     converter introduced get a hard step. Antialiasing a seam is wrong: two patches share
//     it, and two half-coverages composited under OVER give 0.75, not 1.
//   * the orientation sign is computed in JS with the same algebra the shader evaluates, at
//     the patch's interior point. Deriving it from a differently-ordered barycentric silently
//     flips a curve and clips the region — it shows up only as an ink mismatch.
//
// WHERE THE MARGIN IS NOT. Two natural explanations for CPatch's lead were tested and both
// fail, so neither should be repeated:
//
//   DATA RESIDENCY ("CPatch reads uniforms, LB fetches textures") is false. _lbCoverage.glsl
//   contains ZERO texture fetches — Loop-Blinn's per-curve data already travels as flat
//   varyings (aC0..aC3, 16 components). LB is not paying for its curve data per fragment.
//
//   SHADER BULK ("LB drags a 78-fetch ubershader") does not account for it either. The LB-lean
//   column compiles out clip, mask, palette, recolor, color matrix and channel lerp — 62 of
//   the 78 fetch sites are already behind those guards. Ink is identical and the time is a
//   wash: 1.00 -> 0.74 ns/px at N=3, but 0.75 -> 0.81 at N=8 and 0.58 -> 0.80 at N=16. Nothing
//   like the ~0.14 CPatch holds.
//
// What the numbers do say is that LB's cost is concentrated in its CURVE fragments: its ns/px
// FALLS as N rises (1.00 -> 0.58 from 3 to 16 curves) because a rounder shape is more interior,
// and interior triangles carry no coverage math. CPatch is flat at ~0.14 because every one of
// its fragments runs the same short kernel. The residual gap is NOT isolated here, and the
// remaining candidates — the always-on meta prologue (16 unguarded uMetaTex reads of per-shape
// constants, not strippable by any current define) and overdraw from LB's decomposition — need
// a fragment counter, not another guess.
//
// Metric and gates are inherited from _cpatchGpuCost and exist for reasons recorded there:
// SLOPE between two resolutions (so per-draw fixed cost — uniform uploads here, ~10 texture
// binds on the Mantle side — cancels on both arms), an INK GATE (an arm that renders nothing
// is arbitrarily fast), and an AA QUALITY score against an 8x supersampled reference (an arm
// that renders hard-edged is also arbitrarily fast). Absolute times are printed too, since the
// slope deliberately discards the per-draw cost that a real frame still pays.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
import { convertContour } from '../src/renderer/cpatchConvert.js';
import { segPt } from '../src/geom/cpatchImplicit.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const C = 200,
  R = 150,
  AMT = 26;

const ngonCurves = (n) => {
  const pt = (j) => [
    C + R * Math.cos((2 * Math.PI * j) / n),
    C + R * Math.sin((2 * Math.PI * j) / n),
  ];
  const out = [];
  for (let j = 0; j < n; j++) {
    const a = pt(j),
      b = pt((j + 1) % n);
    const mx = (a[0] + b[0]) / 2,
      my = (a[1] + b[1]) / 2;
    let ox = mx - C,
      oy = my - C;
    const L = Math.hypot(ox, oy) || 1;
    out.push({ t: 'quad', P: [a, [mx + (ox / L) * AMT, my + (oy / L) * AMT], b] });
  }
  return out;
};
const ngonSvg = (n) => {
  const pt = (j) => [
    C + R * Math.cos((2 * Math.PI * j) / n),
    C + R * Math.sin((2 * Math.PI * j) / n),
  ];
  let d =
    'M ' +
    pt(0)
      .map((v) => v.toFixed(3))
      .join(' ') +
    ' ';
  for (let j = 0; j < n; j++) {
    const a = pt(j),
      b = pt((j + 1) % n);
    const mx = (a[0] + b[0]) / 2,
      my = (a[1] + b[1]) / 2;
    let ox = mx - C,
      oy = my - C;
    const L = Math.hypot(ox, oy) || 1;
    d += `Q ${(mx + (ox / L) * AMT).toFixed(3)} ${(my + (oy / L) * AMT).toFixed(3)} ${b[0].toFixed(3)} ${b[1].toFixed(3)} `;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><path d="${d}Z" fill="#000"/></svg>`;
};

/// Line-for-line mirror of the fragment shader's quad implicit: same vertex order, same
/// weights. The sign MUST come from this and not from the converter's own frame — they are
/// equivalent algebra in different orders, and a mismatch clips the patch silently.
function quadEvJS(p, a, b, c) {
  const det = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
  const wa = ((b[1] - c[1]) * (p[0] - c[0]) + (c[0] - b[0]) * (p[1] - c[1])) / det;
  const wb = ((c[1] - a[1]) * (p[0] - c[0]) + (a[0] - c[0]) * (p[1] - c[1])) / det;
  const wc = 1 - wa - wb;
  return (wb * 0.5 + wc) * (wb * 0.5 + wc) - wc;
}
const lineEvJS = (p, A, B) => {
  const dx = B[0] - A[0],
    dy = B[1] - A[1],
    L = Math.hypot(dx, dy) || 1;
  return (-dy / L) * (p[0] - A[0]) + (dx / L) * (p[1] - A[1]);
};

const MAXC = 8;
/// Patches → flat arrays the page can upload. kind: 0 = line drawn with AA (a real edge),
/// 1 = quadratic, 2 = line drawn HARD (a seam the converter cut).
function packPatches(curves, opts) {
  const { patches, stats } = convertContour(curves, { maxCurves: MAXC, tolPx: 0.05, ...opts });
  const out = [];
  for (const p of patches) {
    if (!p.obb || p.curves.length > MAXC) continue;
    const A = [],
      M = [],
      B = [],
      kind = [],
      sgn = [];
    for (const seg of p.curves) {
      const q = seg.P,
        at = p.inside;
      if (seg.t === 'quad') {
        A.push(q[0][0], q[0][1]);
        M.push(q[1][0], q[1][1]);
        B.push(q[2][0], q[2][1]);
        kind.push(1);
        sgn.push(quadEvJS(at, q[0], q[1], q[2]) >= 0 ? 1 : -1);
      } else {
        const a = q[0],
          b = q[q.length - 1];
        A.push(a[0], a[1]);
        M.push(0, 0);
        B.push(b[0], b[1]);
        kind.push(seg.cut ? 2 : 0);
        sgn.push(lineEvJS(at, a, b) >= 0 ? 1 : -1);
      }
    }
    out.push({ n: p.curves.length, A, M, B, kind, sgn, corners: p.obb.corners.flat() });
  }
  return { packed: out, stats, patchCount: patches.length };
}

/// Content bbox sampled off the true curves — the renderer fits the CONTENT BBOX, and assuming
/// R + bulge overstates it (an inscribed n-gon's bulge apex sits inside the vertices), which
/// renders the shape under-scaled and shows up only as an ink mismatch.
function contentBBox(curves) {
  let x0 = 1e9,
    y0 = 1e9,
    x1 = -1e9,
    y1 = -1e9;
  for (const s of curves)
    for (let i = 0; i <= 64; i++) {
      const p = segPt(s, i / 64);
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[1] > y1) y1 = p[1];
    }
  return [x0, y0, x1 - x0, y1 - y0];
}

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="1024" height="1024"></canvas>
<script type="module">
globalThis.__MANTLE_DEBUG__ = true;   // createRenderer's fillDefines is a test hook, read only under it
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const cv=document.getElementById('c');
const gl=cv.getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const sync=()=>{const p=new Uint8Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p);return p[0];};

const VS=\`#version 300 es
layout(location=0) in vec2 aPos;          // patch OBB corner, in shape space
uniform vec4 uBB; out vec2 vP;
// UNIFORM scale about the bbox center, not a stretch to the canvas. The renderer fits the
// content bbox without distorting it; stretching agrees only when the content happens to be
// square. On the 3-gon — the one non-square shape in this family — the stretch put 9% more ink
// on screen and scored 25.8/255 of "AA error" that was really a size mismatch, while every
// near-circular row scored 0.3.
void main(){
  vP=aPos;
  vec2 ctr=uBB.xy+uBB.zw*0.5;
  float s=2.0/max(uBB.z,uBB.w);
  gl_Position=vec4((aPos-ctr)*s,0.0,1.0);
}\`;

const FS=\`#version 300 es
precision highp float;
in vec2 vP; out vec4 o;
uniform vec2 uA[${MAXC}], uM[${MAXC}], uB[${MAXC}];
uniform float uKind[${MAXC}], uS[${MAXC}];
uniform int uN; uniform vec2 uDpx;
// Quadratic implicit u^2-v with (u,v) affine over the control triangle, plus its analytic
// screen-space gradient — grad(u^2-v) = 2u*grad(u) - grad(v), both constant per curve.
float quadF(vec2 p, vec2 a, vec2 b, vec2 c, out float gpx){
  float det=(b.y-c.y)*(a.x-c.x)+(c.x-b.x)*(a.y-c.y);
  vec2 gwa=vec2(b.y-c.y,c.x-b.x)/det, gwb=vec2(c.y-a.y,a.x-c.x)/det;
  float wa=dot(gwa,p-c), wb=dot(gwb,p-c), wc=1.0-wa-wb;
  float u=wb*0.5+wc, v=wc;
  vec2 gu=gwb*0.5-(gwa+gwb), gv=-(gwa+gwb);
  vec2 gf=2.0*u*gu-gv; gpx=length(gf*uDpx);
  return u*u-v;
}
void main(){
  float cov=1.0;
  for(int i=0;i<${MAXC};i++){
    if(i>=uN) break;
    float f,g;
    if(uKind[i]==1.0){ f=uS[i]*quadF(vP,uA[i],uM[i],uB[i],g); g=max(g,1e-9); }
    else { vec2 d=uB[i]-uA[i]; vec2 nr=normalize(vec2(-d.y,d.x));
           f=uS[i]*dot(nr,vP-uA[i]); g=max(length(nr*uDpx),1e-9); }
    // A CUT seam is shared by two patches: antialiasing it composites two half-coverages
    // under OVER to 0.75 instead of 1. Only real edges get a ramp.
    cov=min(cov, uKind[i]==2.0 ? step(0.0,f) : clamp(0.5+f/g,0.0,1.0));
  }
  o=vec4(vec3(0.0),cov);
}\`;
function mkProg(vs,fs){
  const c=(t,s)=>{const x=gl.createShader(t);gl.shaderSource(x,s);gl.compileShader(x);
    if(!gl.getShaderParameter(x,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x)); return x;};
  const p=gl.createProgram(); gl.attachShader(p,c(gl.VERTEX_SHADER,vs)); gl.attachShader(p,c(gl.FRAGMENT_SHADER,fs));
  gl.linkProgram(p); if(!gl.getProgramParameter(p,gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;}
// TEXTURE-RESIDENT arm. Identical geometry, identical math, identical draws — the ONLY
// difference is that the curve data is fetched from an RGBA32F texture instead of read from
// uniforms. This is not a curiosity: a patch needs ~7 floats per curve, so at N=8 it is 56
// components against the LB varying budget of 16. Any real integration MUST fetch, so if the
// win lives in uniform residency it does not survive contact with the renderer and there is
// nothing to integrate.
const FS_TEX=\`#version 300 es
precision highp float;
in vec2 vP; out vec4 o;
uniform highp sampler2D uCurves;   // 2 texels per curve: (Ax,Ay,Mx,My), (Bx,By,kind,sign)
uniform int uN, uFirst; uniform vec2 uDpx;
float quadF(vec2 p, vec2 a, vec2 b, vec2 c, out float gpx){
  float det=(b.y-c.y)*(a.x-c.x)+(c.x-b.x)*(a.y-c.y);
  vec2 gwa=vec2(b.y-c.y,c.x-b.x)/det, gwb=vec2(c.y-a.y,a.x-c.x)/det;
  float wa=dot(gwa,p-c), wb=dot(gwb,p-c), wc=1.0-wa-wb;
  float u=wb*0.5+wc, v=wc;
  vec2 gu=gwb*0.5-(gwa+gwb), gv=-(gwa+gwb);
  vec2 gf=2.0*u*gu-gv; gpx=length(gf*uDpx);
  return u*u-v;
}
void main(){
  float cov=1.0;
  for(int i=0;i<256;i++){
    if(i>=uN) break;
    int t=(uFirst+i)*2;
    vec4 e0=texelFetch(uCurves, ivec2(t&1023, t>>10), 0);
    vec4 e1=texelFetch(uCurves, ivec2((t+1)&1023, (t+1)>>10), 0);
    float kind=e1.z, sg=e1.w;
    vec2 A=e0.xy, M=e0.zw, B=e1.xy;
    float f,g;
    if(kind==1.0){ f=sg*quadF(vP,A,M,B,g); g=max(g,1e-9); }
    else { vec2 d=B-A; vec2 nr=normalize(vec2(-d.y,d.x));
           f=sg*dot(nr,vP-A); g=max(length(nr*uDpx),1e-9); }
    cov=min(cov, kind==2.0 ? step(0.0,f) : clamp(0.5+f/g,0.0,1.0));
  }
  o=vec4(vec3(0.0),cov);
}\`;
const PR=mkProg(VS,FS);
const PRT=mkProg(VS,FS_TEX);
let curveTex=null;
function uploadCurves(pk){
  const rows=[]; const first=[];
  for(const p of pk){
    first.push(rows.length/4/2);
    for(let i=0;i<p.n;i++){
      rows.push(p.A[2*i],p.A[2*i+1],p.M[2*i],p.M[2*i+1]);
      rows.push(p.B[2*i],p.B[2*i+1],p.kind[i],p.sgn[i]);
    }
  }
  const texels=rows.length/4, H=Math.max(1,Math.ceil(texels/1024));
  const data=new Float32Array(1024*H*4); data.set(rows);
  if(!curveTex) curveTex=gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D,curveTex);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,1024,H,0,gl.RGBA,gl.FLOAT,data);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
  return first;
}
function drawPatchesTex(pk,bb,res,first){
  gl.useProgram(PRT); gl.bindVertexArray(vao);
  gl.uniform4f(gl.getUniformLocation(PRT,'uBB'),bb[0],bb[1],bb[2],bb[3]);
  const sp=Math.max(bb[2],bb[3])/res;
  gl.uniform2f(gl.getUniformLocation(PRT,'uDpx'),sp,sp);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D,curveTex);
  gl.uniform1i(gl.getUniformLocation(PRT,'uCurves'),0);
  for(let k=0;k<pk.length;k++){
    const p=pk[k], c=p.corners;
    gl.bindBuffer(gl.ARRAY_BUFFER,vbo);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([c[0],c[1],c[2],c[3],c[4],c[5],c[0],c[1],c[4],c[5],c[6],c[7]]),gl.DYNAMIC_DRAW);
    gl.uniform1i(gl.getUniformLocation(PRT,'uN'),p.n);
    gl.uniform1i(gl.getUniformLocation(PRT,'uFirst'),first[k]);
    gl.drawArrays(gl.TRIANGLES,0,6);
  }
  gl.bindVertexArray(null);
}
function timeCPatchTex(pk,bb,res){
  const first=uploadCurves(pk);
  cv.width=res; cv.height=res; gl.viewport(0,0,res,res);
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
  const K=64, runs=[];
  for(let rep=0;rep<9;rep++){
    drawPatchesTex(pk,bb,res,first); sync();
    const t0=performance.now();
    for(let i=0;i<K;i++) drawPatchesTex(pk,bb,res,first);
    sync(); runs.push((performance.now()-t0)/K);
  }
  gl.clearColor(1,1,1,1); gl.clear(gl.COLOR_BUFFER_BIT);
  drawPatchesTex(pk,bb,res,first); sync();
  const px=new Uint8Array(res*res*4); gl.readPixels(0,0,res,res,gl.RGBA,gl.UNSIGNED_BYTE,px);
  let ink=0; for(let i=0;i<px.length;i+=4) if(px[i]<128) ink++;
  gl.disable(gl.BLEND); runs.sort((a,b)=>a-b);
  return {ms:+runs[4].toFixed(4), ink};
}
const U=(n)=>gl.getUniformLocation(PR,n);
const vao=gl.createVertexArray(), vbo=gl.createBuffer();
gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER,vbo);
gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0); gl.bindVertexArray(null);

function drawPatches(pk,bb,res){
  gl.useProgram(PR); gl.bindVertexArray(vao);
  gl.uniform4f(U('uBB'),bb[0],bb[1],bb[2],bb[3]);
  const sp=Math.max(bb[2],bb[3])/res;   // shape units per device pixel, both axes
  gl.uniform2f(U('uDpx'),sp,sp);
  for(const p of pk){
    const c=p.corners;
    gl.bindBuffer(gl.ARRAY_BUFFER,vbo);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([c[0],c[1],c[2],c[3],c[4],c[5],c[0],c[1],c[4],c[5],c[6],c[7]]),gl.DYNAMIC_DRAW);
    gl.uniform2fv(U('uA'),new Float32Array(p.A)); gl.uniform2fv(U('uM'),new Float32Array(p.M));
    gl.uniform2fv(U('uB'),new Float32Array(p.B));
    gl.uniform1fv(U('uKind'),new Float32Array(p.kind)); gl.uniform1fv(U('uS'),new Float32Array(p.sgn));
    gl.uniform1i(U('uN'),p.n);
    gl.drawArrays(gl.TRIANGLES,0,6);
  }
  gl.bindVertexArray(null);
}
function timeCPatch(pk,bb,res){
  cv.width=res; cv.height=res; gl.viewport(0,0,res,res);
  // The Mantle arm blends and cannot be collapsed by tile-based hidden-surface removal, so
  // this must blend too or it measures one shade against K.
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
  const K=64, runs=[];
  for(let rep=0;rep<9;rep++){
    drawPatches(pk,bb,res); sync();
    const t0=performance.now();
    for(let i=0;i<K;i++) drawPatches(pk,bb,res);
    sync(); runs.push((performance.now()-t0)/K);
  }
  gl.clearColor(1,1,1,1); gl.clear(gl.COLOR_BUFFER_BIT);
  drawPatches(pk,bb,res); sync();
  const px=new Uint8Array(res*res*4); gl.readPixels(0,0,res,res,gl.RGBA,gl.UNSIGNED_BYTE,px);
  let ink=0; for(let i=0;i<px.length;i+=4) if(px[i]<128) ink++;
  gl.disable(gl.BLEND); runs.sort((a,b)=>a-b);
  return {ms:+runs[4].toFixed(4), ink};
}
// LEAN = the same Loop-Blinn fill with every optional stage of the ubershader compiled out.
// The point is to separate two explanations of CPatch's margin: DATA RESIDENCY (uniforms and
// varyings vs texture fetches) or SHADER BULK (a 30-line kernel vs a 78-fetch ubershader that
// every fragment of every engine runs). _lbCoverage.glsl fetches NOTHING, so LB's curve data
// is already in varyings; what is left per fragment is the shared meta prologue and the paint,
// clip, mask, recolor and blend chain around it.
const LEAN=['MANTLE_NO_CLIP','MANTLE_NO_MASK','MANTLE_NO_PALETTE','MANTLE_NO_RECOLOR',
            'MANTLE_NO_COLOR_MATRIX','MANTLE_NO_CHANNEL_LERP'];
async function timeMantle(svg,res,engine){
  // Every arm sets its engine's options explicitly: a gwn arm that fell through to an empty options object (no MANTLE_GWN,
  // no MANTLE_GWN_SDF) would import a run tree and then time SLUG (or, with LB on 'auto', Loop-Blinn) walking the bands.
  // An arm is named by what it COMPILES.
  const opts = engine==='aac' ? {aacFill:true}
             : engine==='gwn' ? {fillDefines:['MANTLE_GWN','MANTLE_GWN_SDF']}
             : engine==='lblean' ? {fillDefines:LEAN}
             : engine==='aaclean' ? {aacFill:true, fillDefines:LEAN} : {};
  const r=createRenderer(gl,shaders,opts);
  if(engine==='lb'||engine==='lblean') r.setLoopBlinnFill('on');
  else if(engine==='gwn') r.setLoopBlinnFill('off');
  const sec=await importSvg(svg, engine==='gwn'?{gwnTree:true}:undefined);
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
function down(px,N,S){ const n=N/S,out=new Float64Array(n*n);
  for(let y=0;y<n;y++)for(let x=0;x<n;x++){let s=0;
    for(let j=0;j<S;j++)for(let i=0;i<S;i++) s+=255-px[(((y*S+j)*N)+(x*S+i))*4];
    out[y*n+x]=s/(S*S)/255;} return out; }
function grab(res){const px=new Uint8Array(res*res*4);gl.readPixels(0,0,res,res,gl.RGBA,gl.UNSIGNED_BYTE,px);return px;}
function score(a,ref){let s=0,c=0;
  for(let i=0;i<a.length;i++){ if(a[i]>0.004||ref[i]>0.004){s+=Math.abs(a[i]-ref[i]);c++;} }
  return +(255*s/Math.max(c,1)).toFixed(3);}

window.__run=async(cases,lo,hi)=>{
  const out=[]; const dpx=hi*hi-lo*lo;
  for(const cs of cases){
    const cL=timeCPatch(cs.packed,cs.bb,lo), cH=timeCPatch(cs.packed,cs.bb,hi);
    const tL=timeCPatchTex(cs.packed,cs.bb,lo), tH=timeCPatchTex(cs.packed,cs.bb,hi);
    const lL=await timeMantle(cs.svg,lo,'lb'),  lH=await timeMantle(cs.svg,hi,'lb');
    const nL=await timeMantle(cs.svg,lo,'lblean'), nH=await timeMantle(cs.svg,hi,'lblean');
    const aL=await timeMantle(cs.svg,lo,'aac'), aH=await timeMantle(cs.svg,hi,'aac');
    const sL=await timeMantle(cs.svg,lo,'slug'),sH=await timeMantle(cs.svg,hi,'slug');
    const ns=(a,b)=>+(((b.ms-a.ms)/dpx)*1e6).toFixed(4);
    const Q=256;
    await timeMantle(cs.svg,Q*8,'aac'); const ref=down(grab(Q*8),Q*8,8);
    timeCPatch(cs.packed,cs.bb,Q);      const qC=down(grab(Q),Q,1);
    await timeMantle(cs.svg,Q,'lb');    const qL=down(grab(Q),Q,1);
    await timeMantle(cs.svg,Q,'aac');   const qA=down(grab(Q),Q,1);
    out.push({N:cs.N, patches:cs.packed.length,
      cpatch:ns(cL,cH), ctex:ns(tL,tH), lb:ns(lL,lH), lblean:ns(nL,nH), aac:ns(aL,aH), slug:ns(sL,sH),
      absC:cH.ms, absL:lH.ms, absN:nH.ms, absA:aH.ms,
      inkC:cH.ink, inkL:lH.ink, inkN:nH.ink, inkT:tH.ink, eC:score(qC,ref), eL:score(qL,ref), eA:score(qA,ref)});
  }
  return out;
};
window.__ready=true;
</script></body></html>`;

const NS = (process.env.NS || '3,5,8,12,16').split(',').map(Number);
const cases = NS.map((N) => {
  const curves = ngonCurves(N);
  const { packed, stats, patchCount } = packPatches(curves);
  return { N, packed, bb: contentBBox(curves), svg: ngonSvg(N), stats, patchCount };
});
for (const c of cases)
  if (c.packed.length !== c.patchCount)
    console.log(
      `[warn] N=${c.N}: ${c.patchCount - c.packed.length} patch(es) dropped as unpackable`,
    );

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
  protocolTimeout: 600000,
});
const pg = await br.newPage();
pg.on('pageerror', (e) => console.log('[page-err]', e.message));
pg.on('console', (m) => {
  if (m.type() !== 'log') console.log('[' + m.type() + ']', m.text());
});
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 60000 });
await pg.waitForFunction('window.__ready===true', { timeout: 60000 });
const rows = await pg.evaluate(
  (cs, lo, hi) => window.__run(cs, lo, hi),
  cases.map(({ N, packed, bb, svg }) => ({ N, packed, bb, svg })),
  512,
  2048,
);

console.log(
  'CPatch drawn as REAL converted patches (one drawArrays each, OBB clipped by the rasterizer).',
);
console.log(
  'ns/px is the SLOPE between 512 and 2048, so per-draw fixed cost cancels on every arm.\n',
);
console.log(
  'curves patches | ns/px: CP-unif CP-tex     LB LB-lean    AAC | AA err: CP    LB | ink gate',
);
for (const r of rows) {
  const ok = r.inkL > 0 && Math.abs(r.inkC - r.inkL) / r.inkL < 0.15;
  console.log(
    `${String(r.N).padStart(6)} ${String(r.patches).padStart(7)} | ` +
      `${String(r.cpatch).padStart(14)} ${String(r.ctex).padStart(6)} ${String(r.lb).padStart(6)} ${String(r.lblean).padStart(7)} ${String(r.aac).padStart(6)} | ` +
      `${String(r.eC).padStart(10)} ${String(r.eL).padStart(5)} | ` +
      `${ok ? 'OK' : 'BAD'} ${r.inkT === r.inkC ? 'tex==unif' : 'TEX DIFFERS ' + r.inkT + '/' + r.inkC}`,
  );
}
console.log('\nabsolute ms per draw at 2048 (INCLUDES per-draw cost the slope discards):');
console.log('curves   CPatch      LB LB-lean     AAC');
for (const r of rows)
  console.log(
    `${String(r.N).padStart(6)} ${String(r.absC).padStart(8)} ${String(r.absL).padStart(7)} ${String(r.absN).padStart(7)} ${String(r.absA).padStart(7)}`,
  );
await br.close();
server.close();
