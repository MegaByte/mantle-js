// _wgpuFillrate — does WebGPU move fill rate, or only per-draw cost?
//
// The Slug fill kernel is already storage-buffer-shaped: _coverage.glsl fakes a 1D buffer on a
// 4096-wide RGBA32F texture (`xy.y += xy.x >> 12; xy.x &= 4095`) because WebGL2 has no SSBOs.
// So "port to WebGPU" is really two independent bets, and they must be priced separately:
//
//   ms(N) = FIXED (per-draw, resolution-independent) + SLOPE * fragments(N)
//
//   SLOPE — fragment throughput. Governs the FULL-RES regime (fill bound on this device).
//   FIXED — per-draw state cost. Governs the HALF-RES regime (not fill bound → this dominates).
//
// Render the same content at N and 2N (4x fragments), solve for both. Same GPU, same Metal
// backend, same algorithm — so SLOPE is a test of whether the API layer costs fragment ALU
// anything at all, and FIXED is a test of bind groups vs 52 loose gl.uniform* + 14 texture binds.
//
// The kernel is a faithful port of the real H-ray quadratic walk (calcRootCode2's 0x2E74 table +
// the stable root pair + a box-filter accumulate), NOT a synthetic ALU loop: it keeps the band
// indirection and the dependent per-curve fetch that make the real shader memory-bound-ish.
// GLSL and WGSL are validated pixel-identical before any timing is believed — otherwise the two
// paths could simply be doing different amounts of work.
import http from 'http';
import puppeteer from 'puppeteer';

// ---- content: a many-segment quadratic ring, banded by row (mirrors the real encoder) ----
const ROWS = 64;
const SEGS = +(process.env.SEGS || 512);   // curve density sweep: is the storage win memory-bound-driven?
function buildContent(extent) {
  const cx = extent / 2, cy = extent / 2, R = extent * 0.46, r = extent * 0.30;
  const curves = [];         // each: [x0,y0,x1,y1, x2,y2,0,0]
  for (let i = 0; i < SEGS; i++) {
    const a0 = (i / SEGS) * 2 * Math.PI, a1 = ((i + 1) / SEGS) * 2 * Math.PI, am = (a0 + a1) / 2;
    const rr = (j) => (j % 2 ? r : R);
    const P = (a, rad) => [cx + rad * Math.cos(a), cy + rad * Math.sin(a)];
    const p0 = P(a0, rr(i)), p2 = P(a1, rr(i + 1));
    // control point pushed off the chord so the segment is a genuine curve (real root work)
    const mid = P(am, (rr(i) + rr(i + 1)) / 2 * 1.08);
    const p1 = [2 * mid[0] - (p0[0] + p2[0]) / 2, 2 * mid[1] - (p0[1] + p2[1]) / 2];
    curves.push([p0[0], p0[1], p1[0], p1[1], p2[0], p2[1], 0, 0]);
  }
  // band assignment: a curve belongs to every row its y-bbox spans (as the encoder does)
  const bandH = extent / ROWS;
  const lists = Array.from({ length: ROWS }, () => []);
  curves.forEach((c, i) => {
    const ys = [c[1], c[3], c[5]];
    let lo = Math.floor(Math.min(...ys) / bandH), hi = Math.floor(Math.max(...ys) / bandH);
    lo = Math.max(0, lo); hi = Math.min(ROWS - 1, hi);
    for (let rIdx = lo; rIdx <= hi; rIdx++) lists[rIdx].push(i);
  });
  const flatList = [], table = [];
  for (const L of lists) { table.push([flatList.length, L.length, 0, 0]); for (const i of L) flatList.push([i, 0, 0, 0]); }
  return {
    curveData: Float32Array.from(curves.flatMap((c) => [c[0], c[1], c[2], c[3], c[4], c[5], 0, 0])),
    bandTable: Float32Array.from(table.flat()),
    bandList: Float32Array.from(flatList.flat()),
    nCurves: curves.length, nList: flatList.length, bandH,
    avgPerBand: flatList.length / ROWS,
  };
}

// ---- the shared kernel, expressed once per language. Algorithmically identical. ----
const KERNEL_GLSL = `
uint calcRootCode2(float y1, float y2, float y3) {
  uint shift = (y1 < 0.0 ? 1u : 0u) | (y2 < 0.0 ? 2u : 0u) | (y3 < 0.0 ? 4u : 0u);
  return ((0x2E74u >> shift) & 0x0101u);
}
float walk(vec2 pos, float pxScale) {
  int row = clamp(int(pos.y / uBandH), 0, ${ROWS} - 1);
  vec4 tb = fetchBand(row);
  int off = int(tb.x), cnt = int(tb.y);
  float cov = 0.0;
  for (int i = 0; i < 4096; i++) {
    if (i >= cnt) break;
    int idx = int(fetchList(off + i).x);
    vec4 a = fetchCurve(idx * 2);
    vec4 b = fetchCurve(idx * 2 + 1);
    vec2 p0 = a.xy - pos, p1 = a.zw - pos, p2 = b.xy - pos;
    uint code = calcRootCode2(p0.y, p1.y, p2.y);
    if (code == 0u) continue;
    float ax = p0.x - 2.0 * p1.x + p2.x, ay = p0.y - 2.0 * p1.y + p2.y;
    float bx = p0.x - p1.x, by = p0.y - p1.y;
    float t1, t2;
    if (abs(ay) < 1e-5) { t1 = t2 = p0.y * 0.5 / max(abs(by), 1e-12) * sign(by); }
    else {
      float d = sqrt(max(by * by - ay * p0.y, 0.0));
      float ra = 1.0 / ay;
      t1 = (by - d) * ra; t2 = (by + d) * ra;
    }
    float x1 = (ax * t1 - 2.0 * bx) * t1 + p0.x;
    float x2 = (ax * t2 - 2.0 * bx) * t2 + p0.x;
    if ((code & 1u) != 0u) cov += clamp(x1 * pxScale + 0.5, 0.0, 1.0);
    if (code > 1u)        cov -= clamp(x2 * pxScale + 0.5, 0.0, 1.0);
  }
  return clamp(abs(cov), 0.0, 1.0);
}`;

// Two WGSL data-access modes, same kernel. This is the mechanism test:
//   'storage' — the natural port: curves/bands/list as read-only storage buffers.
//   'texture' — deliberately keeps WebGL2's texelFetch shape (textureLoad on RGBA32F).
// If 'texture' is as slow as WebGL2, the win is storage buffers (an API capability WebGL2
// cannot express). If 'texture' is still fast, the win is ANGLE's GLSL→Metal translation
// overhead, and it has nothing to do with the data model.
const KERNEL_WGSL = `
fn calcRootCode2(y1: f32, y2: f32, y3: f32) -> u32 {
  var shift: u32 = 0u;
  if (y1 < 0.0) { shift = shift | 1u; }
  if (y2 < 0.0) { shift = shift | 2u; }
  if (y3 < 0.0) { shift = shift | 4u; }
  return (0x2E74u >> shift) & 0x0101u;
}
fn walk(pos: vec2<f32>, pxScale: f32) -> f32 {
  let row = clamp(i32(pos.y / U.bandH), 0, ${ROWS} - 1);
  let tb = fetchBand(row);
  let off = i32(tb.x); let cnt = i32(tb.y);
  var cov: f32 = 0.0;
  for (var i: i32 = 0; i < cnt; i = i + 1) {
    let idx = i32(fetchList(off + i).x);
    let a = fetchCurve(idx * 2);
    let b = fetchCurve(idx * 2 + 1);
    let p0 = a.xy - pos; let p1 = a.zw - pos; let p2 = b.xy - pos;
    let code = calcRootCode2(p0.y, p1.y, p2.y);
    if (code == 0u) { continue; }
    let ax = p0.x - 2.0 * p1.x + p2.x; let ay = p0.y - 2.0 * p1.y + p2.y;
    let bx = p0.x - p1.x; let by = p0.y - p1.y;
    var t1: f32; var t2: f32;
    if (abs(ay) < 1e-5) { t1 = p0.y * 0.5 / max(abs(by), 1e-12) * sign(by); t2 = t1; }
    else {
      let d = sqrt(max(by * by - ay * p0.y, 0.0));
      let ra = 1.0 / ay;
      t1 = (by - d) * ra; t2 = (by + d) * ra;
    }
    let x1 = (ax * t1 - 2.0 * bx) * t1 + p0.x;
    let x2 = (ax * t2 - 2.0 * bx) * t2 + p0.x;
    if ((code & 1u) != 0u) { cov = cov + clamp(x1 * pxScale + 0.5, 0.0, 1.0); }
    if (code > 1u)         { cov = cov - clamp(x2 * pxScale + 0.5, 0.0, 1.0); }
  }
  return clamp(abs(cov), 0.0, 1.0);
}`;

const HTML = `<!DOCTYPE html><html><body>
<canvas id="gl"></canvas><canvas id="wg"></canvas>
<script type="module">
const ROWS = ${ROWS};
const buildContent = ${buildContent.toString()};
const KERNEL_GLSL = ${JSON.stringify(KERNEL_GLSL)};
const KERNEL_WGSL = ${JSON.stringify(KERNEL_WGSL)};
const SEGS = ${SEGS};

const VS_GL = \`#version 300 es
void main(){ vec2 p = vec2((gl_VertexID<<1)&2, gl_VertexID&2); gl_Position = vec4(p*2.0-1.0,0,1); }\`;
const FS_GL = \`#version 300 es
precision highp float; precision highp int;
uniform sampler2D uCurves, uBands, uList;
uniform float uBandH, uPxScale, uExtent;
uniform vec2 uRes;
out vec4 o;
vec4 fetchCurve(int i){ return texelFetch(uCurves, ivec2(i & 4095, i >> 12), 0); }
vec4 fetchBand(int i){ return texelFetch(uBands, ivec2(i,0), 0); }
vec4 fetchList(int i){ return texelFetch(uList, ivec2(i & 4095, i >> 12), 0); }
\${KERNEL_GLSL}
void main(){
  vec2 pos = gl_FragCoord.xy / uRes * uExtent;
  float a = walk(pos, uPxScale);
  o = vec4(a, a*0.5, 1.0-a, 1.0);
}\`;

const WGSL_DATA = {
  storage: \`
@group(0) @binding(0) var<storage, read> curves: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read> bands: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> list: array<vec4<f32>>;
fn fetchCurve(i: i32) -> vec4<f32> { return curves[i]; }
fn fetchBand(i: i32) -> vec4<f32> { return bands[i]; }
fn fetchList(i: i32) -> vec4<f32> { return list[i]; }\`,
  texture: \`
@group(0) @binding(0) var curvesT: texture_2d<f32>;
@group(0) @binding(1) var bandsT: texture_2d<f32>;
@group(0) @binding(2) var listT: texture_2d<f32>;
fn fetchCurve(i: i32) -> vec4<f32> { return textureLoad(curvesT, vec2<i32>(i & 4095, i >> 12), 0); }
fn fetchBand(i: i32) -> vec4<f32> { return textureLoad(bandsT, vec2<i32>(i, 0), 0); }
fn fetchList(i: i32) -> vec4<f32> { return textureLoad(listT, vec2<i32>(i & 4095, i >> 12), 0); }\`,
};
const wgslFor = (mode) => \`
struct Uni { bandH: f32, pxScale: f32, extent: f32, resX: f32, resY: f32, _p0: f32, _p1: f32, _p2: f32 };
\${WGSL_DATA[mode]}
@group(0) @binding(3) var<uniform> U: Uni;
@vertex fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
  var p = vec2<f32>(f32((vi << 1u) & 2u), f32(vi & 2u));
  return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}
\${KERNEL_WGSL}
@fragment fn fs(@builtin(position) fc: vec4<f32>) -> @location(0) vec4<f32> {
  // GL's gl_FragCoord.y is bottom-up; WebGPU's is top-down. Flip so both sample identically.
  let pos = vec2<f32>(fc.x / U.resX, (U.resY - fc.y) / U.resY) * U.extent;
  let a = walk(pos, U.pxScale);
  return vec4<f32>(a, a * 0.5, 1.0 - a, 1.0);
}\`;

// ---------------- WebGL2 ----------------
function makeGL(canvas, C, N){
  // Parity with WebGPU's alphaMode:'opaque': alpha:false, and NO preserveDrawingBuffer (it
  // forces extra copies and WebGPU carries no equivalent burden) — readback happens in-frame.
  const gl = canvas.getContext('webgl2',{antialias:false,alpha:false,preserveDrawingBuffer:false});
  const sh=(t,s)=>{const o=gl.createShader(t);gl.shaderSource(o,s);gl.compileShader(o);
    if(!gl.getShaderParameter(o,gl.COMPILE_STATUS)) throw new Error('GL compile: '+gl.getShaderInfoLog(o)); return o;};
  const pr=gl.createProgram(); gl.attachShader(pr,sh(gl.VERTEX_SHADER,VS_GL)); gl.attachShader(pr,sh(gl.FRAGMENT_SHADER,FS_GL));
  gl.linkProgram(pr); if(!gl.getProgramParameter(pr,gl.LINK_STATUS)) throw new Error('GL link: '+gl.getProgramInfoLog(pr));
  gl.useProgram(pr);
  const tex=(data,w,h)=>{const t=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,t);
    const px=new Float32Array(w*h*4); px.set(data.subarray(0,Math.min(data.length,px.length)));
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32F,w,h,0,gl.RGBA,gl.FLOAT,px);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);return t;};
  const nC=C.curveData.length/4, nL=C.bandList.length/4;
  const tC=tex(C.curveData, Math.min(nC,4096), Math.ceil(nC/4096));
  const tB=tex(C.bandTable, ROWS, 1);
  const tL=tex(C.bandList, Math.min(nL,4096), Math.ceil(nL/4096));
  const U={}; for(const k of ['uCurves','uBands','uList','uBandH','uPxScale','uExtent','uRes']) U[k]=gl.getUniformLocation(pr,k);
  const vao=gl.createVertexArray(); gl.bindVertexArray(vao);
  return {gl,pr,tC,tB,tL,U,
    // Minimal per-draw state on BOTH sides, so SLOPE is a clean fragment-throughput comparison.
    // NOTE: the real fill path stages ~52 gl.uniform* + 14 activeTexture/bindTexture pairs per
    // draw (fillPass.js:701-844); that lands in FIXED, not SLOPE, and is measured separately.
    bind(res, rebind){
      if(rebind){
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D,tC); gl.uniform1i(U.uCurves,0);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D,tB); gl.uniform1i(U.uBands,1);
        gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D,tL); gl.uniform1i(U.uList,2);
        gl.uniform1f(U.uBandH,C.bandH); gl.uniform1f(U.uPxScale,res/C.extentRef); gl.uniform1f(U.uExtent,C.extentRef);
        gl.uniform2f(U.uRes,res,res);
      }
    }};
}

// ---------------- WebGPU ----------------
async function makeWG(canvas, C, mode, device){
  const ctx = canvas.getContext('webgpu');
  const fmt = navigator.gpu.getPreferredCanvasFormat();
  const mod = device.createShaderModule({code: wgslFor(mode)});
  const info = await mod.getCompilationInfo();
  const errs = info.messages.filter(m=>m.type==='error');
  if(errs.length) throw new Error('WGSL['+mode+']: '+errs.map(m=>m.lineNum+':'+m.message).join(' | '));
  const uni=device.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  const pipe=device.createRenderPipeline({layout:'auto',vertex:{module:mod,entryPoint:'vs'},
    fragment:{module:mod,entryPoint:'fs',targets:[{format:fmt}]},primitive:{topology:'triangle-list'}});
  let entries;
  if(mode==='storage'){
    const buf=(arr)=>{const b=device.createBuffer({size:Math.max(arr.byteLength,16),
      usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST,mappedAtCreation:true});
      new Float32Array(b.getMappedRange()).set(arr); b.unmap(); return b;};
    entries=[{binding:0,resource:{buffer:buf(C.curveData)}},{binding:1,resource:{buffer:buf(C.bandTable)}},
             {binding:2,resource:{buffer:buf(C.bandList)}}];
  } else {
    // same RGBA32F layout + same >>12/&4095 addressing as the WebGL2 path
    const tex=(arr,w,h)=>{const t=device.createTexture({size:{width:w,height:h},format:'rgba32float',
      usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
      const px=new Float32Array(w*h*4); px.set(arr.subarray(0,Math.min(arr.length,px.length)));
      device.queue.writeTexture({texture:t},px,{bytesPerRow:w*16,rowsPerImage:h},{width:w,height:h}); return t;};
    const nC=C.curveData.length/4, nL=C.bandList.length/4;
    entries=[{binding:0,resource:tex(C.curveData,Math.min(nC,4096),Math.ceil(nC/4096)).createView()},
             {binding:1,resource:tex(C.bandTable,ROWS,1).createView()},
             {binding:2,resource:tex(C.bandList,Math.min(nL,4096),Math.ceil(nL/4096)).createView()}];
  }
  entries.push({binding:3,resource:{buffer:uni}});
  const bg=device.createBindGroup({layout:pipe.getBindGroupLayout(0),entries});
  return {device,ctx,pipe,bg,uni,fmt};
}

// Read the WebGPU canvas back so it can be diffed against WebGL2's. Without this, a WGSL
// path that quietly does less work would look like a speedup.
async function readWG(W, N){
  const bpr = Math.ceil(N*4/256)*256;
  const rb = W.device.createBuffer({size:bpr*N, usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
  const enc = W.device.createCommandEncoder();
  enc.copyTextureToBuffer({texture:W.ctx.getCurrentTexture()},{buffer:rb,bytesPerRow:bpr,rowsPerImage:N},{width:N,height:N});
  W.device.queue.submit([enc.finish()]);
  await rb.mapAsync(GPUMapMode.READ);
  const src = new Uint8Array(rb.getMappedRange());
  const out = new Uint8Array(N*N*4);
  for(let y=0;y<N;y++) out.set(src.subarray(y*bpr, y*bpr+N*4), y*N*4);
  return out;
}

// ---------------- harness ----------------
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));

async function run(){
  const out={};
  const EXTENT=1000;
  const C=buildContent(EXTENT); C.extentRef=EXTENT;
  out.content={nCurves:C.nCurves,nList:C.nList,avgPerBand:+C.avgPerBand.toFixed(1)};

  const RES=[512, 768, 1024, 1280, 1536];   // sweep → least-squares fit, not 2-point extrapolation
  const K=48;                    // draws amortized per timed frame
  const REPS=11;                  // min-of-7 kills scheduler/thermal noise

  const glCanvas=document.getElementById('gl'), wgCanvas=document.getElementById('wg');

  // ---- WebGL2 ----
  const glRes={}; let glRef=null;
  for(const N of RES){
    glCanvas.width=N; glCanvas.height=N;
    const G=makeGL(glCanvas,C,N); const gl=G.gl;
    gl.viewport(0,0,N,N);
    const fence=()=>{const p=new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p); return p[0];};
    const frame=(k)=>{ for(let i=0;i<k;i++){ G.bind(N,true); gl.drawArrays(gl.TRIANGLES,0,3); } };
    frame(4); fence();                       // warm: shader link + GPU clock ramp
    let best=1e9;
    for(let r=0;r<REPS;r++){ const t0=performance.now(); frame(K); fence(); best=Math.min(best,(performance.now()-t0)/K); }
    glRes[N]=best;
    if(N===RES[0]){ const px=new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,px); glRef=px; }
  }
  out.gl=glRes;
  {const gl=glCanvas.getContext('webgl2'); const d=gl.getExtension('WEBGL_debug_renderer_info');
   out.gpu=d?gl.getParameter(d.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);}

  // ---- WebGPU: both data-access modes on one device ----
  const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});
  const device=await adapter.requestDevice();
  out.adapter=(adapter.info&&adapter.info.architecture)||'?';
  out.wg={}; out.diff={};
  for(const mode of ['storage','texture']){
    const res={};
    const W=await makeWG(wgCanvas,C,mode,device);
    for(const N of RES){
      wgCanvas.width=N; wgCanvas.height=N;
      W.ctx.configure({device,format:W.fmt,alphaMode:'opaque',
        usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});
      device.queue.writeBuffer(W.uni,0,new Float32Array([C.bandH, N/EXTENT, EXTENT, N, N, 0,0,0]));
      const frame=(k)=>{
        const enc=device.createCommandEncoder();
        const pass=enc.beginRenderPass({colorAttachments:[{view:W.ctx.getCurrentTexture().createView(),
          loadOp:'clear',storeOp:'store',clearValue:{r:1,g:1,b:1,a:1}}]});
        pass.setPipeline(W.pipe);
        for(let i=0;i<k;i++){ pass.setBindGroup(0,W.bg); pass.draw(3); }   // idiomatic per-draw state
        pass.end(); device.queue.submit([enc.finish()]);
      };
      frame(4); await device.queue.onSubmittedWorkDone();
      let best=1e9;
      for(let r=0;r<REPS;r++){ const t0=performance.now(); frame(K); await device.queue.onSubmittedWorkDone(); best=Math.min(best,(performance.now()-t0)/K); }
      res[N]=best;
      if(N===RES[0]){
        frame(1);
        const px=await readWG(W,N);
        // GL is bottom-up + RGBA; WebGPU is top-down + (usually) BGRA. Normalize both, then diff.
        const bgra=W.fmt.startsWith('bgra');
        let maxd=0,sum=0,n=0;
        for(let y=0;y<N;y+=3) for(let x=0;x<N;x+=3){
          const gi=((N-1-y)*N+x)*4, wi=(y*N+x)*4;
          const wr=bgra?px[wi+2]:px[wi], wg2=px[wi+1], wb=bgra?px[wi]:px[wi+2];
          const d=Math.max(Math.abs(glRef[gi]-wr),Math.abs(glRef[gi+1]-wg2),Math.abs(glRef[gi+2]-wb));
          maxd=Math.max(maxd,d); sum+=d; n++;
        }
        out.diff[mode]={max:maxd, mean:+(sum/n).toFixed(3)};
      }
    }
    out.wg[mode]=res;
  }
  out.RES=RES; out.K=K; out.iso=self.crossOriginIsolated;
  return out;
}

try { window.__out = await run(); window.__ready = true; }
catch(e){ window.__err = e.message + '\\n' + (e.stack||''); window.__ready = true; }
</script></body></html>`;

// COOP/COEP make the page crossOriginIsolated, which lifts performance.now()'s 100µs clamp to
// ~5µs. Without it the per-frame times quantize to multiples of 100µs/K and the fit wobbles.
const server = http.createServer((q, s) => { s.writeHead(200, { 'content-type': 'text/html; charset=utf-8',
  'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }); s.end(HTML); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await puppeteer.launch({ headless: false, args: ['--no-sandbox', '--use-angle=metal', '--enable-unsafe-webgpu'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[page-err]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.error('[console]', m.text()); });
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__ready === true, { timeout: 120000 });
const err = await page.evaluate(() => window.__err);
const out = await page.evaluate(() => window.__out);
await browser.close(); server.close();

if (err) { console.error('FAILED:\n' + err); process.exit(1); }

const frag = (n) => n * n;
// Least-squares fit of ms(N) = FIXED + SLOPE*frag(N) over the whole sweep. Two-point
// extrapolation amplified WebGL2's run-to-run noise into a meaningless ratio; a fit over
// 5 resolutions with R² reported shows whether the linear model actually holds.
function fit(r) {
  const xs = out.RES.map(frag), ys = out.RES.map((N) => r[N]), n = xs.length;
  const mx = xs.reduce((a, b) => a + b) / n, my = ys.reduce((a, b) => a + b) / n;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  const slope = sxy / sxx, fixed = my - slope * mx;
  let ssr = 0, sst = 0;
  for (let i = 0; i < n; i++) { ssr += (ys[i] - (fixed + slope * xs[i])) ** 2; sst += (ys[i] - my) ** 2; }
  return { fixed, slope, r2: 1 - ssr / sst };
}
const g = fit(out.gl), ws = fit(out.wg.storage), wt = fit(out.wg.texture);
console.log(`GPU: ${out.gpu}   crossOriginIsolated(hi-res timer)=${out.iso}`);
console.log(`content: ${out.content.nCurves} quadratic segs, ${out.content.avgPerBand} curves/band avg, ${out.K} draws amortized, min-of-11`);
console.log(`pixel diff vs WebGL2 (must be ~0 or timings are meaningless):`);
for (const m of ['storage','texture']) console.log(`  wgpu:${m.padEnd(8)} max=${out.diff[m].max}/255  mean=${out.diff[m].mean}`);
console.log('');
console.log('  ms/draw       |  WebGL2   wgpu:storage  wgpu:texture');
for (const N of out.RES) console.log(`  ${String(N + '²').padEnd(13)} |  ${out.gl[N].toFixed(4)}   ${out.wg.storage[N].toFixed(4)}       ${out.wg.texture[N].toFixed(4)}`);
console.log('');
console.log('  term              |  WebGL2   wgpu:storage  wgpu:texture');
console.log(`  FIXED (ms/draw)   |  ${g.fixed.toFixed(4)}   ${ws.fixed.toFixed(4)}       ${wt.fixed.toFixed(4)}`);
console.log(`  SLOPE (ns/Mfrag)  |  ${(g.slope*1e6).toFixed(3)}    ${(ws.slope*1e6).toFixed(3)}        ${(wt.slope*1e6).toFixed(3)}`);
console.log(`  fit R²            |  ${g.r2.toFixed(3)}    ${ws.r2.toFixed(3)}        ${wt.r2.toFixed(3)}`);
console.log('');
console.log(`  SLOPE vs WebGL2   |   1.00×    ${(ws.slope/g.slope).toFixed(2)}×         ${(wt.slope/g.slope).toFixed(2)}×`);
console.log(`  storage vs texture WITHIN WebGPU (no API confound): ${(wt.slope/ws.slope).toFixed(2)}× faster`);
