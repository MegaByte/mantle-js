// _scalingAmortized.mjs — the number that decides everything: how LB / Slug / mesh-free
// scale with SEGMENT COUNT. mesh-free (no banding) loops every seg per pixel = O(segs);
// Slug bands = O(segs-in-band); LB = O(1)/fragment (one cached implicit). At 8 segs
// mesh-free wins; the question is WHERE it crosses over. Star polygons (simple, no
// self-intersection → all three render them) at increasing point counts. All amortized
// identically. Gentle: K=40, N=256, browser closed on all paths.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const N = 256, cx = 128, cy = 128, Ro = 120, Ri = 70;

// star/gear polygon with P points → 2P vertices → 2P straight edges (simple polygon).
function star(P) {
  const V = [];
  for (let i = 0; i < 2 * P; i++) { const r = i % 2 ? Ri : Ro, a = i / (2 * P) * 2 * Math.PI - Math.PI / 2; V.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  return V;
}
function svgOf(V) {
  // viewBox = device px (renderer fits curve-bbox to canvas; identity here since V spans ~8..248)
  let d = `M ${V[0][0].toFixed(2)} ${V[0][1].toFixed(2)} `;
  for (let i = 1; i < V.length; i++) d += `L ${V[i][0].toFixed(2)} ${V[i][1].toFixed(2)} `;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${N}" height="${N}"><path fill="#3366cc" d="${d}Z"/></svg>`;
}
const TW = 256;   // seg texture width (texels); 3 RGBA32F texels per seg
function recsOf(V) {   // line segs (type 0) → 3 texels each: [ty,w,P0]/[P1,P2]/[P3,0,0]
  const nseg = V.length, rows = Math.ceil(nseg * 3 / TW);
  const tex = new Float32Array(TW * rows * 4);
  for (let i = 0; i < nseg; i++) {
    const a = V[i], b = V[(i + 1) % nseg], o = i * 3 * 4;
    tex[o] = 0; tex[o + 1] = 1; tex[o + 2] = a[0]; tex[o + 3] = a[1];       // ty,w,P0
    tex[o + 4] = b[0]; tex[o + 5] = b[1]; tex[o + 6] = 0; tex[o + 7] = 0;   // P1,P2
    // P3 texel stays 0
  }
  return { data: Array.from(tex), rows };
}
const POINTS = [4, 16, 48, 120];   // → 8, 32, 96, 240 edges
const CASES = POINTS.map((P) => { const V = star(P); return { edges: 2 * P, svg: svgOf(V), ...recsOf(V) }; });

const HTML = `<!DOCTYPE html><html><body>
<canvas id="cr" width="${N}" height="${N}"></canvas><canvas id="cm" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const K = 40;
const CASES = ${JSON.stringify(CASES)};
const sync = (ctx) => { const p=new Uint8Array(4); ctx.readPixels(0,0,1,1,ctx.RGBA,ctx.UNSIGNED_BYTE,p); return p[0]; };

// renderer context (LB + Slug)
const gl = document.getElementById('cr').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders = await loadShaders(new URL('/src/shaders/',location.href).href);
const renderer = createRenderer(gl, shaders); renderer.setViewport(${N},${N});
const jit=(i)=>[1,0,0,0,1,0,(i%13)*1e-3,0,1];
function rend(bundle, mode){
  renderer.setLoopBlinnFill(mode);
  renderer.beginFrame([1,1,1,1]); for(let i=0;i<4;i++) renderer.drawBundle(bundle,{worldMatrix:jit(i)}); renderer.endFrame(); sync(gl);
  const t0=performance.now();
  renderer.beginFrame([1,1,1,1]); for(let i=0;i<K;i++) renderer.drawBundle(bundle,{worldMatrix:jit(i)}); renderer.endFrame(); sync(gl);
  return (performance.now()-t0)/K;
}

// mesh-free context — MAXREC-sized uniform, uN selects the live count
const g = document.getElementById('cm').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const vsrc='#version 300 es\\nin vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
const fsrc=\`#version 300 es
precision highp float;
uniform highp sampler2D uSegs; uniform int uW; uniform int uN; uniform float uH; uniform vec2 uJit; uniform vec4 uPaint; out vec4 o;
vec4 texAt(int idx){ return texelFetch(uSegs, ivec2(idx % uW, idx / uW), 0); }
vec2 ev(int ty,float w,vec2 P0,vec2 P1,vec2 P2,vec2 P3,float t){ float u=1.-t;
  if(ty==3) return u*u*u*P0+3.*u*u*t*P1+3.*u*t*t*P2+t*t*t*P3;
  if(ty==2){ float b0=u*u,b1=2.*u*t*w,b2=t*t,d=b0+b1+b2; return (b0*P0+b1*P1+b2*P2)/d; }
  if(ty==1) return u*u*P0+2.*u*t*P1+t*t*P2;
  return P0+t*(P1-P0); }
void main(){
  float px=floor(gl_FragCoord.x)+uJit.x, py=uH-1.-floor(gl_FragCoord.y);
  float run=0.;
  for(int s=0;s<uN;s++){ int b0i=s*3;
    vec4 A=texAt(b0i), B=texAt(b0i+1), C=texAt(b0i+2);
    int ty=int(A.x); float w=A.y;
    vec2 P0=A.zw,P1=B.xy,P2=B.zw,P3=C.xy;
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
  o = uPaint*min(abs(run),1.);
}\`;
function sh(t,s){const x=g.createShader(t);g.shaderSource(x,s);g.compileShader(x);if(!g.getShaderParameter(x,g.COMPILE_STATUS))throw new Error(g.getShaderInfoLog(x));return x;}
const prog=g.createProgram(); g.attachShader(prog,sh(g.VERTEX_SHADER,vsrc)); g.attachShader(prog,sh(g.FRAGMENT_SHADER,fsrc)); g.linkProgram(prog);
if(!g.getProgramParameter(prog,g.LINK_STATUS)) throw new Error(g.getProgramInfoLog(prog));
g.useProgram(prog);
if(!g.getExtension('EXT_color_buffer_float')){}   // sampling RGBA32F via texelFetch is core WebGL2
const buf=g.createBuffer(); g.bindBuffer(g.ARRAY_BUFFER,buf); g.bufferData(g.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),g.STATIC_DRAW);
const loc=g.getAttribLocation(prog,'p'); g.enableVertexAttribArray(loc); g.vertexAttribPointer(loc,2,g.FLOAT,false,0,0);
const TW=${TW};
g.uniform1f(g.getUniformLocation(prog,'uH'), ${N});
g.uniform4f(g.getUniformLocation(prog,'uPaint'), 0.16,0.32,0.64,0.8);
g.uniform1i(g.getUniformLocation(prog,'uW'), TW);
g.uniform1i(g.getUniformLocation(prog,'uSegs'), 0);
const uN=g.getUniformLocation(prog,'uN'), uJit=g.getUniformLocation(prog,'uJit');
const segTex=g.createTexture();
function mf(rec, rows, edges){
  g.activeTexture(g.TEXTURE0); g.bindTexture(g.TEXTURE_2D, segTex);
  g.texParameteri(g.TEXTURE_2D,g.TEXTURE_MIN_FILTER,g.NEAREST); g.texParameteri(g.TEXTURE_2D,g.TEXTURE_MAG_FILTER,g.NEAREST);
  g.texParameteri(g.TEXTURE_2D,g.TEXTURE_WRAP_S,g.CLAMP_TO_EDGE); g.texParameteri(g.TEXTURE_2D,g.TEXTURE_WRAP_T,g.CLAMP_TO_EDGE);
  g.texImage2D(g.TEXTURE_2D,0,g.RGBA32F,TW,rows,0,g.RGBA,g.FLOAT,new Float32Array(rec));
  g.uniform1i(uN, edges);
  g.viewport(0,0,${N},${N});
  g.uniform2f(uJit,0,0); g.drawArrays(g.TRIANGLES,0,3); sync(g);
  // ink sanity: count non-black pixels so a blank (all-culled) render can't fake a fast time
  const px=new Uint8Array(${N}*${N}*4); g.readPixels(0,0,${N},${N},g.RGBA,g.UNSIGNED_BYTE,px);
  let ink=0; for(let i=0;i<px.length;i+=4) if(px[i]||px[i+1]||px[i+2]) ink++;
  const t0=performance.now();
  for(let i=0;i<K;i++){ g.uniform2f(uJit,(i%13)*1e-3,0); g.drawArrays(g.TRIANGLES,0,3); }
  sync(g);
  return { ms:(performance.now()-t0)/K, ink };
}

const rows=[];
for(const C of CASES){
  const bundle=createBundle(gl, await importSvg(C.svg)); renderer.prepareBundle(bundle);
  const m=mf(C.data, C.rows, C.edges);
  rows.push({ edges:C.edges, lb:rend(bundle,'on'), slug:rend(bundle,'off'), mf:m.ms, ink:m.ink });
}
const dbg=gl.getExtension('WEBGL_debug_renderer_info');
window.__out={ gpu: dbg?gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER), rows };
window.__ready=true;
</script></body></html>`;

const server = http.createServer((req,res)=>{ try{ if(req.url==='/'){res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(HTML);return;} const p=decodeURIComponent(req.url.split('?')[0]); res.writeHead(200,{'content-type':p.endsWith('.glsl')?'text/plain':'text/javascript'}); res.end(readFileSync(path.join(ROOT,p))); }catch{ if(!res.headersSent)res.writeHead(404); res.end(); } });
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const port=server.address().port;
const browser=await puppeteer.launch({headless:false,args:['--no-sandbox','--use-angle=metal']});
let out;
try{ const page=await browser.newPage(); page.on('pageerror',e=>console.error('  [page-err]',e.message)); page.on('console',m=>{if(m.type()==='error')console.error('  [console]',m.text());});
  await page.goto(`http://127.0.0.1:${port}/`,{waitUntil:'load',timeout:30000}); await page.waitForFunction(()=>window.__ready===true,{timeout:40000}); out=await page.evaluate(()=>window.__out);
}catch(e){ console.error('setup failed:',e.message); await browser.close(); server.close(); process.exit(1); }
await browser.close(); server.close();

console.log('GPU:', out.gpu, `@ ${N}×${N}, star polygons, ALL amortized (ms/draw)`);
console.log('  edges |   LB    Slug    mesh-free  |  mf/LB   mf/Slug  | mf ink px');
for(const r of out.rows){
  console.log(`  ${String(r.edges).padStart(5)} | ${r.lb.toFixed(3)}  ${r.slug.toFixed(3)}   ${r.mf.toFixed(3)}     |  ${(r.mf/r.lb).toFixed(2)}×    ${(r.mf/r.slug).toFixed(2)}×  |  ${r.ink}`);
}
