// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _threeWayAmortized.mjs — the HONEST 3-way: LB vs Slug vs mesh-free, all measured
// IDENTICALLY (one beginFrame/clear, K jittered draws, one readPixels hard-sync).
//
// Timing mesh-free with the frame setup AMORTIZED (K drawArrays, no per-iter clear) but
// Slug with the setup PENALIZED (beginFrame+clear+endFrame every iteration) makes mesh-free
// look an order of magnitude faster. Apples-to-oranges. Here every
// renderer draws the same O with the same amortized loop. Mesh-free also carries real
// paint work (premultiplied solid emit) so it reflects a MERGED coloring path, not a
// stripped coverage-only prototype. Gentle: K=50, N=256, browser closed on all paths.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const N = 256;

// The same holed O for all three. Renderer path: SVG arcs. Mesh-free path: the same
// two rings as exact rational-quad quarter-arcs (w = cos45), device coords filling N.
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${N}" height="${N}">
<path fill="#3366cc" d="M50 6 A44 44 0 1 0 50 94 A44 44 0 1 0 50 6 Z M50 30 A20 20 0 1 1 50 70 A20 20 0 1 1 50 30 Z"/></svg>`;
// mesh-free O in device px: center 128, outer R 120, inner 120*20/44 (same 44:20 ratio).
const Wt = Math.SQRT1_2,
  cx = 128,
  cy = 128,
  Ro = 120,
  Ri = (120 * 20) / 44;
// quarter rquad arcs of a ring; ccw outer / cw inner (opposite winding → hole)
function ring(r, ccw) {
  const O = ccw
    ? [
        [cx + r, cy],
        [cx, cy + r],
        [cx - r, cy],
        [cx, cy - r],
      ]
    : [
        [cx + r, cy],
        [cx, cy - r],
        [cx - r, cy],
        [cx, cy + r],
      ];
  const C = ccw
    ? [
        [cx + r, cy + r],
        [cx - r, cy + r],
        [cx - r, cy - r],
        [cx + r, cy - r],
      ]
    : [
        [cx + r, cy - r],
        [cx - r, cy - r],
        [cx - r, cy + r],
        [cx + r, cy + r],
      ];
  return O.map((a, i) => ({ ty: 2, w: Wt, P0: a, P1: C[i], P2: O[(i + 1) % 4], P3: [0, 0] }));
}
const segs = [...ring(Ro, true), ...ring(Ri, false)];
// each quarter arc is already y-monotonic (spans one quadrant) → pack directly
const rec = segs.flatMap((s) => [s.ty, s.w, ...s.P0, ...s.P1, ...s.P2, ...s.P3]);
const NREC = segs.length;

const HTML = `<!DOCTYPE html><html><body>
<canvas id="cr" width="${N}" height="${N}"></canvas><canvas id="cm" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const K = 50;
const sync = (ctx) => { const p = new Uint8Array(4); ctx.readPixels(0,0,1,1,ctx.RGBA,ctx.UNSIGNED_BYTE,p); return p[0]; };

// ── renderer context: LB + Slug ────────────────────────────────────────────────
const gl = document.getElementById('cr').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders = await loadShaders(new URL('/src/shaders/',location.href).href);
const renderer = createRenderer(gl, shaders); renderer.setViewport(${N},${N});
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)}));
renderer.prepareBundle(bundle);
const jit = (i)=>[1,0,0,0,1,0,(i%13)*1e-3,0,1];
function rendAmortized(mode){
  renderer.setLoopBlinnFill(mode);
  renderer.beginFrame([1,1,1,1]); for(let i=0;i<5;i++) renderer.drawBundle(bundle,{worldMatrix:jit(i)}); renderer.endFrame(); sync(gl);
  const t0=performance.now();
  renderer.beginFrame([1,1,1,1]);
  for(let i=0;i<K;i++) renderer.drawBundle(bundle,{worldMatrix:jit(i)});
  renderer.endFrame(); sync(gl);
  return (performance.now()-t0)/K;
}

// ── mesh-free context: signed-area coverage + PREMULTIPLIED paint emit ──────────
const g = document.getElementById('cm').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const REC = ${JSON.stringify(rec)}, NREC = ${NREC};
const vsrc='#version 300 es\\nin vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
const fsrc=\`#version 300 es
precision highp float;
uniform float uRec[${NREC * 10}]; uniform int uN; uniform float uH; uniform vec2 uJit; uniform vec4 uPaint; out vec4 o;
vec2 ev(int ty,float w,vec2 P0,vec2 P1,vec2 P2,vec2 P3,float t){ float u=1.-t;
  if(ty==3) return u*u*u*P0+3.*u*u*t*P1+3.*u*t*t*P2+t*t*t*P3;
  if(ty==2){ float b0=u*u,b1=2.*u*t*w,b2=t*t,d=b0+b1+b2; return (b0*P0+b1*P1+b2*P2)/d; }
  if(ty==1) return u*u*P0+2.*u*t*P1+t*t*P2;
  return P0+t*(P1-P0); }
void main(){
  float px=floor(gl_FragCoord.x)+uJit.x, py=uH-1.-floor(gl_FragCoord.y);
  float run=0.;
  for(int s=0;s<uN;s++){ int o0=s*10;
    int ty=int(uRec[o0]); float w=uRec[o0+1];
    vec2 P0=vec2(uRec[o0+2],uRec[o0+3]),P1=vec2(uRec[o0+4],uRec[o0+5]),P2=vec2(uRec[o0+6],uRec[o0+7]),P3=vec2(uRec[o0+8],uRec[o0+9]);
    float y0=ev(ty,w,P0,P1,P2,P3,0.).y, y1=ev(ty,w,P0,P1,P2,P3,1.).y;
    float ymin=min(y0,y1),ymax=max(y0,y1); float lo=max(py,ymin),hi=min(py+1.,ymax);
    if(hi<=lo) continue; bool inc=y1>y0;
    float ta,tb; { float a=0.,b=1.; for(int i=0;i<24;i++){ float m=(a+b)*.5; if((ev(ty,w,P0,P1,P2,P3,m).y<lo)==inc)a=m; else b=m;} ta=(a+b)*.5; }
    { float a=0.,b=1.; for(int i=0;i<24;i++){ float m=(a+b)*.5; if((ev(ty,w,P0,P1,P2,P3,m).y<hi)==inc)a=m; else b=m;} tb=(a+b)*.5; }
    float tlo=min(ta,tb),thi=max(ta,tb); const int M=6; float dt=(thi-tlo)/float(M);
    for(int i=0;i<M;i++){ float t=tlo+dt*(float(i)+0.5);
      float e=1e-3; vec2 p=ev(ty,w,P0,P1,P2,P3,t);
      float yp=(ev(ty,w,P0,P1,P2,P3,min(t+e,1.)).y-ev(ty,w,P0,P1,P2,P3,max(t-e,0.)).y)/(min(t+e,1.)-max(t-e,0.));
      run += clamp(px+1.-p.x,0.,1.)*yp*dt; }
  }
  float cov=min(abs(run),1.);
  o = uPaint*cov;                     // premultiplied paint·coverage — MERGED coloring path
}\`;
function sh(t,s){const x=g.createShader(t);g.shaderSource(x,s);g.compileShader(x);if(!g.getShaderParameter(x,g.COMPILE_STATUS))throw new Error(g.getShaderInfoLog(x));return x;}
const prog=g.createProgram(); g.attachShader(prog,sh(g.VERTEX_SHADER,vsrc)); g.attachShader(prog,sh(g.FRAGMENT_SHADER,fsrc)); g.linkProgram(prog);
if(!g.getProgramParameter(prog,g.LINK_STATUS)) throw new Error(g.getProgramInfoLog(prog));
g.useProgram(prog);
const buf=g.createBuffer(); g.bindBuffer(g.ARRAY_BUFFER,buf); g.bufferData(g.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),g.STATIC_DRAW);
const loc=g.getAttribLocation(prog,'p'); g.enableVertexAttribArray(loc); g.vertexAttribPointer(loc,2,g.FLOAT,false,0,0);
g.uniform1fv(g.getUniformLocation(prog,'uRec'), new Float32Array(REC));
g.uniform1i(g.getUniformLocation(prog,'uN'), NREC); g.uniform1f(g.getUniformLocation(prog,'uH'), ${N});
g.uniform4f(g.getUniformLocation(prog,'uPaint'), 0.2*0.8, 0.4*0.8, 0.8*0.8, 0.8);   // premultiplied #3366cc @ .8
const uJit=g.getUniformLocation(prog,'uJit');
function mfAmortized(){
  g.viewport(0,0,${N},${N});
  g.uniform2f(uJit,0,0); g.drawArrays(g.TRIANGLES,0,3); sync(g);        // warmup
  const t0=performance.now();
  for(let i=0;i<K;i++){ g.uniform2f(uJit,(i%13)*1e-3,0); g.drawArrays(g.TRIANGLES,0,3); }
  sync(g);
  return (performance.now()-t0)/K;
}

const dbg=gl.getExtension('WEBGL_debug_renderer_info');
window.__out={
  gpu: dbg?gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),
  lbMs: rendAmortized('on'),
  slugMs: rendAmortized('off'),
  mfMs: mfAmortized(),
  nrec: NREC,
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
let out;
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.error('  [console]', m.text());
  });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => window.__ready === true, { timeout: 30000 });
  out = await page.evaluate(() => window.__out);
} catch (e) {
  console.error('setup failed:', e.message);
  await browser.close();
  server.close();
  process.exit(1);
}
await browser.close();
server.close();

console.log(
  'GPU:',
  out.gpu,
  `@ ${N}×${N}, holed O, ALL amortized (one clear + ${'K'} draws + one sync)`,
);
console.log(`  LB   (cached mesh):       ${out.lbMs.toFixed(3)} ms/draw`);
console.log(`  Slug (ubershader/pixel):  ${out.slugMs.toFixed(3)} ms/draw`);
console.log(
  `  mesh-free (${out.nrec} segs, full-screen, no banding): ${out.mfMs.toFixed(3)} ms/draw`,
);
console.log(
  `  → mesh-free / Slug = ${(out.mfMs / out.slugMs).toFixed(2)}×   |   mesh-free / LB = ${(out.mfMs / out.lbMs).toFixed(2)}×   |   Slug / LB = ${(out.slugMs / out.lbMs).toFixed(2)}×`,
);
