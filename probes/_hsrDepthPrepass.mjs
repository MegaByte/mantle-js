// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _hsrDepthPrepass — is the "merged bundle is 4.5x faster on overlapping opaque
// content" effect actually hidden-surface removal via the depth buffer, and if so can a
// depth PREPASS over provably-interior opaque occupancy cells recover it with BIT-IDENTICAL AA?
//
// Arms per scene:
//   base     : K bundles, 1 shape each (depth cleared between bundles)   [reference pixels]
//   merged   : 1 bundle, everything on (occlusion cull ON)               [the "4.5x" case]
//   mergedNC : 1 bundle, occlusionCull:false                            [isolates DEPTH-only HSR]
//   prepass  : mergedNC + a depth-only prepass over SOLID_IN occupancy cells of
//              plain-opaque shapes, main pass with depthMask(false)
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const N = Number(process.env.RES || 512);

const shape = (cx, cy, r, fill) =>
  `<path fill="${fill}" d="M ${cx - r} ${cy} C ${cx - r} ${cy - r * 1.3} ${cx + r} ${cy - r * 1.3} ${cx + r} ${cy} C ${cx + r} ${cy + r * 1.3} ${cx - r} ${cy + r * 1.3} ${cx - r} ${cy} Z"/>`;

// The ORIGINAL overlap layout from _atlasMultiBundle: positions repeat with period 15
// (i%3, i%5), so for K>15 many shapes are exact DUPLICATES of a later one.
const overlapParts = (K) =>
  Array.from({ length: K }, (_, i) =>
    shape(256 + (i % 3) * 8, 256 + (i % 5) * 8, 90, `hsl(${(i * 37) % 360},60%,50%)`),
  );
// DISTINCT overlapping: heavy overlap but no shape is ever contained in another, so the
// CPU occlusion culler provably cannot fire. This is the honest HSR test.
const overlapDistinctParts = (K) =>
  Array.from({ length: K }, (_, i) => {
    const a = i * 2.39996; // golden-angle spiral, all radii equal
    const rad = 26 * Math.sqrt(i / Math.max(1, K - 1));
    return shape(
      256 + Math.cos(a) * rad,
      256 + Math.sin(a) * rad,
      90,
      `hsl(${(i * 37) % 360},60%,50%)`,
    );
  });
// No overlap, but every shape is LARGE enough to clear the occupancy area gate
// (bbox >= 2% of doc area). This is the honest PURE-OVERHEAD case: the prepass builds and
// draws real cells that can never occlude anything.
const disjointBigParts = (K) => {
  const g = Math.ceil(Math.sqrt(K));
  const cell = N / g;
  const r = cell * 0.47;
  return Array.from({ length: K }, (_, i) =>
    shape(
      ((i % g) + 0.5) * cell,
      (Math.floor(i / g) + 0.5) * cell,
      r,
      `hsl(${(i * 37) % 360},60%,50%)`,
    ),
  );
};
// No overlap at all: the prepass is PURE OVERHEAD here.
const disjointParts = (K) =>
  Array.from({ length: K }, (_, i) =>
    shape(
      28 + (i % 8) * 60,
      28 + (Math.floor(i / 8) % 8) * 60,
      22,
      `hsl(${(i * 37) % 360},60%,50%)`,
    ),
  );

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true,depth:true,stencil:true});
const shaders = await loadShaders(new URL('/src/shaders/',location.href).href);
const r = createRenderer(gl, shaders, {}); r.setViewport(${N},${N});
const svgOf = (parts) => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${N}" height="${N}">'+parts.join('')+'</svg>';

let draws=0; const _da=gl.drawArrays.bind(gl), _dai=gl.drawArraysInstanced.bind(gl);
gl.drawArrays=(...a)=>{draws++;_da(...a);};
gl.drawArraysInstanced=(...a)=>{draws++;_dai(...a);};

const sync = () => { const p=new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p); return p[0]; };
const grab = () => { const p=new Uint8Array(${N}*${N}*4); gl.readPixels(0,0,${N},${N},gl.RGBA,gl.UNSIGNED_BYTE,p); return p; };

// ---------------------------------------------------------------- depth prepass program
const vsSrc = \`#version 300 es
in vec3 aXY;
void main(){ gl_Position = vec4(aXY.xy, aXY.z, 1.0); }\`;
const fsSrc = \`#version 300 es
precision highp float; out vec4 o;
void main(){ o = vec4(0.0); }\`;
function mkProg(vs,fs){
  const c=(t,s)=>{const x=gl.createShader(t);gl.shaderSource(x,s);gl.compileShader(x);
    if(!gl.getShaderParameter(x,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x)); return x;};
  const p=gl.createProgram(); gl.attachShader(p,c(gl.VERTEX_SHADER,vs)); gl.attachShader(p,c(gl.FRAGMENT_SHADER,fs));
  gl.bindAttribLocation(p,0,'aXY'); gl.linkProgram(p);
  if(!gl.getProgramParameter(p,gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}
const preProg = mkProg(vsSrc, fsSrc);
const preVbo = gl.createBuffer();
const preVao = gl.createVertexArray();
gl.bindVertexArray(preVao); gl.bindBuffer(gl.ARRAY_BUFFER, preVbo);
gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,3,gl.FLOAT,false,0,0);
gl.bindVertexArray(null);

// isPlainOpaque, mirrored from src/renderer/occlusionCull.js
function isPlainOpaque(meta, stride, s){
  const b=s*stride;
  if(meta[b+7]<0.996) return false;
  if(Math.floor(meta[b+28]+0.5)!==0) return false;
  if(Math.floor(meta[b+30]+0.5)!==0) return false;
  if(Math.floor(meta[b+31]+0.5)!==0) return false;
  if(Math.floor(meta[b+32]+0.5)!==0) return false;
  if(stride>=34&&Math.floor(meta[b+33]+0.5)!==0) return false;
  if(stride>=36&&Math.floor(meta[b+35]+0.5)!==0) return false;
  if(stride>=46&&Math.floor(meta[b+45]+0.5)!==0) return false;
  const fs=(stride>=28)?Math.floor(meta[b+27]+0.5):0;
  if(fs&(64|128|256)) return false;
  return true;
}
function arScale(bbox,vw,vh){ const cAR=vw/vh, sAR=bbox[2]/bbox[3];
  let sx=1,sy=1; if(sAR>cAR) sy=cAR/sAR; else sx=sAR/cAR; return [sx,sy]; }

// Build the prepass geometry for a bundle: for every plain-opaque shape, emit the
// SOLID_IN occupancy cells as clip-space quads at that shape's painter z.
// Occupancy bits live in the curve float plane (bundle.cFR); meta floats 20/21 hold
// (baseTexelIdx, G). 4 cells per RGBA texel. Cells are 1-cell-eroded from any boundary.
function buildPrepass(b){
  const meta=b.metaFloats, stride=b.metaFloatsPerShape, n=b.numShapes;
  const cFR=b.curveFloats||b.cFR; const gbb=b.globalBBox;
  if(!meta||!cFR||!gbb) return null;
  const [sx,sy]=arScale(gbb,${N},${N});
  const batches=[]; let totalVerts=0, cells=0, shapesWith=0, gated=0;
  for(let s=0;s<n;s++){
    if(!isPlainOpaque(meta,stride,s)) continue;
    const base=Math.floor(meta[s*stride+20]+0.5), G=Math.floor(meta[s*stride+21]+0.5);
    if(!(G>0)||!(base>0)) continue;
    const x0=meta[s*stride+0], y0=meta[s*stride+1], x1=meta[s*stride+2], y1=meta[s*stride+3];
    const cw=(x1-x0)/G, ch=(y1-y0)/G;
    // SAME AA GATE the shader applies (mantle.frag.glsl:521): a cell must exceed 1.5px of
    // em reach on both axes, so the <=1px coverage ramp can never touch a boundary >=1 cell
    // away. Without this, a sub-pixel cell's pixel is only PARTIALLY covered and is NOT
    // opaque -- writing depth for it would occlude something genuinely visible.
    const emPxX=gbb[2]/(${N}*sx), emPxY=gbb[3]/(${N}*sy);
    if(!(cw>=1.5*emPxX && ch>=1.5*emPxY)) { gated++; continue; }
    const zS=(n>0)?(1.0-s/n):0.0;
    const verts=[];
    for(let gy=0;gy<G;gy++) for(let gx=0;gx<G;gx++){
      const idx=gy*G+gx; const bit=cFR[(base+(idx>>2))*4+(idx&3)];
      if(!(bit>0.5)) continue;
      cells++;
      const ex0=x0+gx*cw, ey0=y0+gy*ch, ex1=ex0+cw, ey1=ey0+ch;
      const toClip=(ex,ey)=>{ const ux=(ex-gbb[0])/gbb[2], uy=(ey-gbb[1])/gbb[3];
        return [(ux*2-1)*sx, -((uy*2-1)*sy)]; };
      const A=toClip(ex0,ey0),B=toClip(ex1,ey0),C=toClip(ex1,ey1),D=toClip(ex0,ey1);
      verts.push(A[0],A[1],zS,B[0],B[1],zS,C[0],C[1],zS, A[0],A[1],zS,C[0],C[1],zS,D[0],D[1],zS);
    }
    if(!verts.length) continue;
    shapesWith++;
    batches.push({xy:new Float32Array(verts)});
    totalVerts+=verts.length/3;
  }
  if(!batches.length) return null;
  // z lives in the vertex attribute, so ALL shapes' cells collapse into ONE drawArrays.
  const all=new Float32Array(totalVerts*3); let off=0;
  for(const bt of batches){ all.set(bt.xy,off); off+=bt.xy.length; }
  gl.bindBuffer(gl.ARRAY_BUFFER,preVbo); gl.bufferData(gl.ARRAY_BUFFER,all,gl.STATIC_DRAW);
  return {batches,totalVerts,cells,shapesWith,gated};
}
function runPrepass(pp){
  if(!pp) return;
  gl.useProgram(preProg); gl.bindVertexArray(preVao);
  gl.colorMask(false,false,false,false);
  gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(true);
  gl.disable(gl.BLEND); gl.disable(gl.STENCIL_TEST);
  gl.drawArrays(gl.TRIANGLES,0,pp.totalVerts);
  gl.colorMask(true,true,true,true);
  gl.bindVertexArray(null);
}

function paint(bundles){
  r.beginFrame([1,1,1,1]);
  for(const b of bundles) r.drawBundle(b,{worldMatrix:[1,0,0,0,1,0,0,0,1]});
  r.endFrame();
}
// prepass arm: clear once, run depth prepass, then draw with depthMask FORCED off.
// drawBundle CLEARS DEPTH at its head (renderer.js:1416) — that would wipe the prepass,
// so strip DEPTH_BUFFER_BIT from clears for the duration of the main pass.
function paintPrepass(bundles, pp){
  r.beginFrame([1,1,1,1]);
  runPrepass(pp);
  const _dm=gl.depthMask.bind(gl), _cl=gl.clear.bind(gl);
  gl.depthMask=()=>_dm(false);
  gl.clear=(m)=>_cl(m & ~gl.DEPTH_BUFFER_BIT);
  try { for(const b of bundles) r.drawBundle(b,{worldMatrix:[1,0,0,0,1,0,0,0,1]}); }
  finally { gl.depthMask=_dm; gl.clear=_cl; }
  r.endFrame();
}

async function build(svgs, occlusionCull){
  r.setLoopBlinnFill('off');
  const bundles=[];
  for(const s of svgs) bundles.push(createBundle(gl, await importSvg(s,{preserveViewport:true,occupancyGrid:true}), {occlusionCull}));
  for(const b of bundles) r.prepareBundle && r.prepareBundle(b);
  if(r.awaitLbReady) for(const b of bundles) await r.awaitLbReady(b);
  // occupancy grids may be built OFF-THREAD; wait for them to land before reading bits
  for(let i=0;i<60;i++){ await new Promise(res=>setTimeout(res,16)); }
  paint(bundles); sync();
  draws=0; paint(bundles); sync();
  return {bundles, draws};
}
const L=20;
function sample(fn){ const t0=performance.now(); for(let i=0;i<L;i++) fn(); sync(); return (performance.now()-t0)/L; }

window.__run = async (parts) => {
  const perBundle = parts.map(p=>svgOf([p]));
  const merged    = [svgOf(parts)];
  const a  = await build(perBundle, true);      // baseline (1 shape/bundle: culler is a no-op)
  const bM = await build(merged, true);         // merged, cull ON  (the "4.5x")
  const cM = await build(merged, false);        // merged, cull OFF (depth-only)
  const pp = buildPrepass(cM.bundles[0]);
  // warm prepass arm
  paintPrepass(cM.bundles, pp); sync();
  let ppDraws; { draws=0; paintPrepass(cM.bundles, pp); sync(); ppDraws=draws; }
  // CONTROL: same path, empty prepass. Whatever this arm gains over mergedNC is the
  // stripped depth clear + depthMask(false), NOT hidden-surface removal.
  paintPrepass(cM.bundles, null); sync();

  let msA=1e9,msB=1e9,msC=1e9,msP=1e9,msCtl=1e9;
  for(let rep=0;rep<11;rep++){
    msA=Math.min(msA, sample(()=>paint(a.bundles)));
    msB=Math.min(msB, sample(()=>paint(bM.bundles)));
    msC=Math.min(msC, sample(()=>paint(cM.bundles)));
    msP=Math.min(msP, sample(()=>paintPrepass(cM.bundles, pp)));
    msCtl=Math.min(msCtl, sample(()=>paintPrepass(cM.bundles, null)));
  }
  paint(a.bundles); sync();  const pxA=grab();
  paint(bM.bundles); sync(); const pxB=grab();
  paint(cM.bundles); sync(); const pxC=grab();
  paintPrepass(cM.bundles, pp); sync(); const pxP=grab();
  for(const x of a.bundles) x.dispose();
  for(const x of bM.bundles) x.dispose();
  for(const x of cM.bundles) x.dispose();

  const diff=(X,Y)=>{ let maxd=0,nd=0,firstX=-1,firstY=-1;
    for(let p=0;p<X.length;p+=4){ let m=0;
      for(let c=0;c<4;c++) m=Math.max(m,Math.abs(X[p+c]-Y[p+c]));
      if(m){ nd++; if(m>maxd)maxd=m; if(firstX<0){ const i=p/4; firstX=i%${N}; firstY=Math.floor(i/${N}); } } }
    return {maxd,nd,firstX,firstY}; };
  return {
    drawsA:a.draws, drawsB:bM.draws, drawsC:cM.draws, drawsP:ppDraws,
    msA,msB,msC,msP,msCtl,
    ppCells: pp?pp.cells:0, ppVerts: pp?pp.totalVerts:0, ppShapes: pp?pp.shapesWith:0, ppGated: pp?pp.gated:0,
    dMerged: diff(pxA,pxB), dMergedNC: diff(pxA,pxC), dPrepass: diff(pxA,pxP),
    dPrepassVsNC: diff(pxC,pxP),
    total:${N}*${N}
  };
};
window.__ready=true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  try {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }
    const p = decodeURIComponent(req.url.split('?')[0]);
    res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
// HEADLESS EVEN ON THE GPU. Headless Chrome reaches the real GPU: ANGLE (Apple, ANGLE Metal
// Renderer) reports and TIMES the same headless or headful.
// A window is not free to the person running this: macOS CLAMPS --window-position (measured:
// screenX/Y 83,65 whatever you pass), so a headful run cannot be put out of the way and lands
// on whichever desktop is in front.
const browser = await launchBrowser({
  headless: 'new',
  args: ['--no-sandbox', '--use-angle=metal'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[page-err]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.error('[console]', m.text());
});
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__ready === true, { timeout: 120000 });

const rows = [];
const LAYOUTS = [
  ['overlapDup', overlapParts],
  ['overlapDistinct', overlapDistinctParts],
  ['disjointBig', disjointBigParts],
  ['disjointSmall', disjointParts],
];
for (const K of (process.env.KS || '8,32,64').split(',').map(Number)) {
  for (const [name, gen] of LAYOUTS) {
    const out = await page.evaluate((p) => window.__run(p), gen(K));
    rows.push([`K=${String(K).padStart(2)} ${name}`, out]);
  }
}
await browser.close();
server.close();

const f = (x) => x.toFixed(3);
console.log(`\n@ ${N}×${N}, min-of-11 runs of 20 frames, ms/frame\n`);
console.log(
  '  scene                     |  draws (base/merged/mergedNC/prepass) |    base   merged  mergedNC  prepass  | ctl   | spd(merged) spd(prepass)',
);
for (const [name, o] of rows) {
  console.log(
    `  ${name.padEnd(25)} | ${String(o.drawsA).padStart(5)} ${String(o.drawsB).padStart(6)} ${String(o.drawsC).padStart(9)} ${String(o.drawsP).padStart(8)}      | ${f(o.msA).padStart(7)} ${f(o.msB).padStart(8)} ${f(o.msC).padStart(9)} ${f(o.msP).padStart(8)} | ${f(o.msCtl).padStart(6)} | ${(o.msA / o.msB).toFixed(2)}×       ${(o.msA / o.msP).toFixed(2)}×   [prepass vs mergedNC ${(o.msC / o.msP).toFixed(2)}×, vs ctl ${(o.msCtl / o.msP).toFixed(2)}×]`,
  );
}
console.log('\n  PIXEL DIFF vs baseline   (maxΔ / differing px of ' + rows[0][1].total + ')');
console.log(
  '  scene                     |   merged(cull ON)  |  mergedNC(depth only) |     PREPASS      | prepass vs mergedNC',
);
for (const [name, o] of rows) {
  const g = (d) => `${String(d.maxd).padStart(3)}/${String(d.nd).padStart(6)}`;
  console.log(
    `  ${name.padEnd(25)} |   ${g(o.dMerged).padEnd(16)} |   ${g(o.dMergedNC).padEnd(19)} | ${g(o.dPrepass).padEnd(16)} | ${g(o.dPrepassVsNC)}`,
  );
}
console.log('\n  PREPASS cost: (opaque shapes with cells / SOLID_IN cells / verts)');
for (const [name, o] of rows)
  console.log(
    `  ${name.padEnd(25)} | ${o.ppShapes} shapes, ${o.ppCells} cells, ${o.ppVerts} verts, ${o.ppGated} AA-gated out`,
  );
