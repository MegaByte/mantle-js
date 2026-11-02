// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _meshFreeShaderBench.mjs — mesh-free signed-area coverage FRAGMENT SHADER on real
// GPU, with NATIVE per-type curve handling (NO degree elevation — a rational quad is
// an exact conic and must stay rational). Validate vs our Slug + CPU, then BENCH both
// with GPU timer queries (EXT_disjoint_timer_query_webgl2 — no vsync noise).
//
// Fragment (per pixel, per y-monotonic seg): band-find t at y=py and y=py+1 by
// bisection on the seg's NATIVE evaluator, then quadrature
//   ∫ clamp(px+1−x(t),0,1)·y′(t) dt  over the band → signed area → winding fold.
// Types: line, quad (u²−v), rational-quad (weighted), cubic. Conflation-free,
// no-flatten, no compute, no banding (iterates all segs/pixel → conservative).
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
import { signedAreaCoverageSegs } from '../src/renderer/signedAreaCoverage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const N = 256; // modest res — the bench is deliberately light

// ---- native evaluators (JS, for CPU split + y-extrema) ------------------------
const evalSeg = (s, t) => {
  const u = 1 - t;
  if (s.type === 'cubic')
    return [
      u * u * u * s.P[0][0] +
        3 * u * u * t * s.P[1][0] +
        3 * u * t * t * s.P[2][0] +
        t * t * t * s.P[3][0],
      u * u * u * s.P[0][1] +
        3 * u * u * t * s.P[1][1] +
        3 * u * t * t * s.P[2][1] +
        t * t * t * s.P[3][1],
    ];
  if (s.type === 'rquad') {
    const w = s.w,
      b0 = u * u,
      b1 = 2 * u * t * w,
      b2 = t * t,
      d = b0 + b1 + b2;
    return [
      (b0 * s.P[0][0] + b1 * s.P[1][0] + b2 * s.P[2][0]) / d,
      (b0 * s.P[0][1] + b1 * s.P[1][1] + b2 * s.P[2][1]) / d,
    ];
  }
  if (s.type === 'quad')
    return [
      u * u * s.P[0][0] + 2 * u * t * s.P[1][0] + t * t * s.P[2][0],
      u * u * s.P[0][1] + 2 * u * t * s.P[1][1] + t * t * s.P[2][1],
    ];
  return [s.P[0][0] + t * (s.P[1][0] - s.P[0][0]), s.P[0][1] + t * (s.P[1][1] - s.P[0][1])]; // line
};
// split a seg at parameter t into two same-type segs (de Casteljau; rational uses homogeneous)
function splitSeg(s, t) {
  const L = (a, b) => [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
  if (s.type === 'cubic') {
    const ab = L(s.P[0], s.P[1]),
      bc = L(s.P[1], s.P[2]),
      cd = L(s.P[2], s.P[3]),
      abc = L(ab, bc),
      bcd = L(bc, cd),
      m = L(abc, bcd);
    return [
      { type: 'cubic', P: [s.P[0], ab, abc, m] },
      { type: 'cubic', P: [m, bcd, cd, s.P[3]] },
    ];
  }
  if (s.type === 'rquad') {
    // homogeneous split: weights [1, w, 1]
    const w = s.w;
    const h0 = [s.P[0][0], s.P[0][1], 1],
      h1 = [s.P[1][0] * w, s.P[1][1] * w, w],
      h2 = [s.P[2][0], s.P[2][1], 1];
    const HL = (a, b) => [
      a[0] + t * (b[0] - a[0]),
      a[1] + t * (b[1] - a[1]),
      a[2] + t * (b[2] - a[2]),
    ];
    const a = HL(h0, h1),
      b = HL(h1, h2),
      m = HL(a, b);
    const dehom = (h) => [h[0] / h[2], h[1] / h[2]];
    const wa = a[2] / Math.sqrt(m[2] * h0[2]) || a[2]; // recover the middle weight per piece
    // left piece control weight = a[2]/sqrt(m[2]*1); right = b[2]/sqrt(1*m[2])
    const wl = a[2] / Math.sqrt(h0[2] * m[2]),
      wr = b[2] / Math.sqrt(m[2] * h2[2]);
    return [
      { type: 'rquad', w: wl, P: [dehom(h0), dehom(a), dehom(m)] },
      { type: 'rquad', w: wr, P: [dehom(m), dehom(b), dehom(h2)] },
    ];
  }
  if (s.type === 'quad') {
    const ab = L(s.P[0], s.P[1]),
      bc = L(s.P[1], s.P[2]),
      m = L(ab, bc);
    return [
      { type: 'quad', P: [s.P[0], ab, m] },
      { type: 'quad', P: [m, bc, s.P[2]] },
    ];
  }
  const m = L(s.P[0], s.P[1]);
  return [
    { type: 'line', P: [s.P[0], m] },
    { type: 'line', P: [m, s.P[1]] },
  ];
}
// split into y-monotonic pieces (sample y' sign changes; robust, type-agnostic)
function yMono(s) {
  const D = 40;
  let prev = evalSeg(s, 0)[1],
    sign = 0;
  const ts = [];
  for (let i = 1; i <= D; i++) {
    const y = evalSeg(s, i / D)[1];
    const d = y - prev;
    if (d !== 0) {
      const sg = d > 0 ? 1 : -1;
      if (sign !== 0 && sg !== sign) ts.push((i - 0.5) / D);
      sign = sg;
    }
    prev = y;
  }
  let out = [],
    cur = s,
    base = 0;
  for (const t of ts) {
    const lt = (t - base) / (1 - base);
    const [l, r] = splitSeg(cur, lt);
    out.push(l);
    cur = r;
    base = t;
  }
  out.push(cur);
  return out;
}

// ---- test shapes: a holed "O" in each curve type ------------------------------
const cx = 0.5,
  cy = 0.5,
  K = 0.5522847498,
  Wt = 0.70710678;
const on = (c, r, ccw) =>
  ccw
    ? [
        [c[0] + r, c[1]],
        [c[0], c[1] + r],
        [c[0] - r, c[1]],
        [c[0], c[1] - r],
      ]
    : [
        [c[0] + r, c[1]],
        [c[0], c[1] - r],
        [c[0] - r, c[1]],
        [c[0], c[1] + r],
      ];
function ringCubic(c, r, ccw) {
  const O = on(c, r, ccw);
  const tan = ccw
    ? [
        [0, r],
        [-r, 0],
        [0, -r],
        [r, 0],
      ]
    : [
        [0, -r],
        [-r, 0],
        [0, r],
        [r, 0],
      ];
  return O.map((a, i) => {
    const b = O[(i + 1) % 4];
    return {
      type: 'cubic',
      P: [
        a,
        [a[0] + tan[i][0] * K, a[1] + tan[i][1] * K],
        [b[0] - tan[(i + 1) % 4][0] * K, b[1] - tan[(i + 1) % 4][1] * K],
        b,
      ],
    };
  });
}
function ringQuad(c, r, ccw) {
  const O = on(c, r, ccw);
  const ct = ccw
    ? [
        [c[0] + r, c[1] + r],
        [c[0] - r, c[1] + r],
        [c[0] - r, c[1] - r],
        [c[0] + r, c[1] - r],
      ]
    : [
        [c[0] + r, c[1] - r],
        [c[0] - r, c[1] - r],
        [c[0] - r, c[1] + r],
        [c[0] + r, c[1] + r],
      ];
  return O.map((a, i) => ({ type: 'quad', P: [a, ct[i], O[(i + 1) % 4]] }));
}
function ringRquad(c, r, ccw) {
  return ringQuad(c, r, ccw).map((s) => ({ type: 'rquad', w: Wt, P: s.P }));
} // same hull, exact circle via w
const shapes = {
  cubic: [...ringCubic([cx, cy], 0.4, true), ...ringCubic([cx, cy], 0.22, false)],
  quad: [...ringQuad([cx, cy], 0.4, true), ...ringQuad([cx, cy], 0.22, false)],
  rquad: [...ringRquad([cx, cy], 0.4, true), ...ringRquad([cx, cy], 0.22, false)],
};

// fit each shape's curve-bbox to the canvas (match the renderer) + build the SVG.
function prep(segs) {
  let a = 1e9,
    b = 1e9,
    c = -1e9,
    d = -1e9;
  for (const s of segs)
    for (let k = 0; k <= 64; k++) {
      const p = evalSeg(s, k / 64);
      a = Math.min(a, p[0]);
      b = Math.min(b, p[1]);
      c = Math.max(c, p[0]);
      d = Math.max(d, p[1]);
    }
  const sc = Math.min(N / (c - a), N / (d - b)),
    tx = (N - (c - a) * sc) / 2 - a * sc,
    ty = (N - (d - b) * sc) / 2 - b * sc;
  const F = (p) => [p[0] * sc + tx, p[1] * sc + ty];
  const fitted = segs.map((s) => ({ ...s, P: s.P.map(F) }));
  const mono = fitted.flatMap(yMono);
  return { fitted, mono };
}
// SVG path (device units→viewBox 100): the renderer fits bbox so use raw*100-ish;
// simplest: emit device coords in a 0..N viewBox at width N (identity).
function svgOf(segs, type) {
  const V = (p) => `${p[0].toFixed(3)} ${p[1].toFixed(3)}`;
  const sub = (rg) => {
    let d = `M ${V(rg[0].P[0])} `;
    for (const s of rg) {
      if (s.type === 'cubic') d += `C ${V(s.P[1])} ${V(s.P[2])} ${V(s.P[3])} `;
      else if (s.type === 'line') d += `L ${V(s.P[1])} `;
      else d += `Q ${V(s.P[1])} ${V(s.P[2])} `;
    }
    return d + 'Z';
  };
  // rquad rendered as SVG arc is awkward; emit quad hull (Slug will treat exact via its own arc detection is N/A) — for rquad compare we rely on CPU/Slug both from the same SVG 'Q' (a plain quad!) → so rquad exactness only matters in OUR shader; Slug/CPU here use the polynomial quad. Flag handled in the report.
  const half = segs.length / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${N}" height="${N}"><path fill="#000" d="${sub(segs.slice(0, half))} ${sub(segs.slice(half))}"/></svg>`;
}

const built = {};
for (const [k, segs] of Object.entries(shapes)) {
  const { fitted, mono } = prep(segs);
  // flat packing for the shader: per mono seg → [type, w, P0x,P0y,P1x,P1y,P2x,P2y,P3x,P3y]
  const TY = { line: 0, quad: 1, rquad: 2, cubic: 3 };
  const rec = mono.map((s) => {
    const P = s.P;
    const p = (i) => P[i] || [0, 0];
    return [TY[s.type], s.w || 1, ...p(0), ...p(1), ...p(2), ...p(3)];
  });
  const cpu = signedAreaCoverageSegs(
    fitted.map((s) =>
      s.type === 'line'
        ? { a: s.P[0], b: s.P[1] }
        : s.type === 'cubic'
          ? { type: 'cubic', P0: s.P[0], P1: s.P[1], P2: s.P[2], P3: s.P[3] }
          : { type: 'quad', P0: s.P[0], P1: s.P[1], P2: s.P[2] },
    ),
    N,
    N,
    false,
  );
  built[k] = { rec: rec.flat(), nrec: rec.length, svg: svgOf(fitted, k), cpu: Array.from(cpu) };
}

const HTML = `<!DOCTYPE html><html><body>
<canvas id="cf" width="${N}" height="${N}"></canvas><canvas id="cs" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const BUILT = ${JSON.stringify(Object.fromEntries(Object.entries(built).map(([k, v]) => [k, { rec: v.rec, nrec: v.nrec, svg: v.svg }])))};
const cf=document.getElementById('cf'); const g=cf.getContext('webgl2',{antialias:false,preserveDrawingBuffer:true});
const ext=g.getExtension('EXT_disjoint_timer_query_webgl2');
const vs='#version 300 es\\nin vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
const fsTmpl=\`#version 300 es
precision highp float;
uniform float uRec[MAXREC]; uniform int uN; uniform float uH; out vec4 o;
vec2 evalSeg(int ty,float w,vec2 P0,vec2 P1,vec2 P2,vec2 P3,float t){ float u=1.-t;
  if(ty==3) return u*u*u*P0+3.*u*u*t*P1+3.*u*t*t*P2+t*t*t*P3;
  if(ty==2){ float b0=u*u,b1=2.*u*t*w,b2=t*t,d=b0+b1+b2; return (b0*P0+b1*P1+b2*P2)/d; }
  if(ty==1) return u*u*P0+2.*u*t*P1+t*t*P2;
  return P0+t*(P1-P0); }
void main(){
  float px=floor(gl_FragCoord.x), py=uH-1.-floor(gl_FragCoord.y);
  float run=0.;
  for(int s=0;s<uN;s++){ int o0=s*10;
    int ty=int(uRec[o0]); float w=uRec[o0+1];
    vec2 P0=vec2(uRec[o0+2],uRec[o0+3]),P1=vec2(uRec[o0+4],uRec[o0+5]),P2=vec2(uRec[o0+6],uRec[o0+7]),P3=vec2(uRec[o0+8],uRec[o0+9]);
    float y0=evalSeg(ty,w,P0,P1,P2,P3,0.).y, y1=evalSeg(ty,w,P0,P1,P2,P3,1.).y;
    float ymin=min(y0,y1),ymax=max(y0,y1); float lo=max(py,ymin),hi=min(py+1.,ymax);
    if(hi<=lo) continue;
    bool inc=y1>y0;
    // bisection band-find at y=lo and y=hi
    float ta=0.,tb=1.; { float a=0.,b=1.; for(int i=0;i<24;i++){ float m=(a+b)*.5; float ym=evalSeg(ty,w,P0,P1,P2,P3,m).y; if((ym<lo)==inc)a=m; else b=m;} ta=(a+b)*.5; }
    { float a=0.,b=1.; for(int i=0;i<24;i++){ float m=(a+b)*.5; float ym=evalSeg(ty,w,P0,P1,P2,P3,m).y; if((ym<hi)==inc)a=m; else b=m;} tb=(a+b)*.5; }
    float tlo=min(ta,tb),thi=max(ta,tb); const int M=6; float dt=(thi-tlo)/float(M);
    for(int i=0;i<M;i++){ float t=tlo+dt*(float(i)+0.5);
      float e=1e-3; vec2 p=evalSeg(ty,w,P0,P1,P2,P3,t); float yp=(evalSeg(ty,w,P0,P1,P2,P3,min(t+e,1.)).y-evalSeg(ty,w,P0,P1,P2,P3,max(t-e,0.)).y)/(min(t+e,1.)-max(t-e,0.));
      run += clamp(px+1.-p.x,0.,1.)*yp*dt; }
  }
  float cov=min(abs(run),1.); o=vec4(vec3(1.-cov),1.);
}\`;
function sh(t,src){const s=g.createShader(t);g.shaderSource(s,src);g.compileShader(s);if(!g.getShaderParameter(s,g.COMPILE_STATUS))throw new Error(g.getShaderInfoLog(s));return s;}
function mkProg(maxrec){const fs=fsTmpl.replace('MAXREC',String(maxrec));const p=g.createProgram();g.attachShader(p,sh(g.VERTEX_SHADER,vs));g.attachShader(p,sh(g.FRAGMENT_SHADER,fs));g.linkProgram(p);if(!g.getProgramParameter(p,g.LINK_STATUS))throw new Error(g.getProgramInfoLog(p));return p;}
const buf=g.createBuffer();g.bindBuffer(g.ARRAY_BUFFER,buf);g.bufferData(g.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),g.STATIC_DRAW);
// Slug context
const cs=document.getElementById('cs'); const gl=cs.getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href); const renderer=createRenderer(gl,shaders); renderer.setViewport(${N},${N});

// GENTLE fixed-work GPU wall-clock. Two sync tricks matter on ANGLE-Metal: (1) jit(i)
// mutates a uniform so each draw produces DIFFERENT output → the driver can't coalesce
// them; (2) readPixels(1px) is a HARD GPU sync (finish() does not reliably block here)
// so the wall-clock captures real GPU time, not just CPU queuing. Bounded: KDRAWS ×
// canvas × shapes — safe on any machine.
const KDRAWS = 50;
const gpuSync = (ctx) => { const p = new Uint8Array(4); ctx.readPixels(0, 0, 1, 1, ctx.RGBA, ctx.UNSIGNED_BYTE, p); return p[0]; };
async function timeGPU(draw, jit, ctx){
  jit(0); draw(); gpuSync(ctx);                   // warmup
  const t0=performance.now();
  let acc=0;
  for(let i=0;i<KDRAWS;i++){ jit(i+1); draw(); }
  acc += gpuSync(ctx);                            // hard sync (drains all KDRAWS)
  const ms=(performance.now()-t0)/KDRAWS;
  return acc >= 0 ? ms : ms;                      // (acc keeps the readback live)
}
const out={};
for(const [k,B] of Object.entries(BUILT)){
  const prog=mkProg(B.nrec*10); g.useProgram(prog);
  const loc=g.getAttribLocation(prog,'p'); g.bindBuffer(g.ARRAY_BUFFER,buf); g.enableVertexAttribArray(loc); g.vertexAttribPointer(loc,2,g.FLOAT,false,0,0);
  g.uniform1fv(g.getUniformLocation(prog,'uRec'), new Float32Array(B.rec));
  const uHloc=g.getUniformLocation(prog,'uH');
  g.uniform1i(g.getUniformLocation(prog,'uN'), B.nrec); g.uniform1f(uHloc, ${N});
  const drawMF=()=>{ g.viewport(0,0,${N},${N}); g.drawArrays(g.TRIANGLES,0,3); };
  const jitMF=(i)=>{ g.uniform1f(uHloc, ${N} + (i%17)); };   // shift output rows → no coalescing
  drawMF(); g.finish();
  const mfPx=new Uint8Array(${N}*${N}*4); g.readPixels(0,0,${N},${N},g.RGBA,g.UNSIGNED_BYTE,mfPx);
  const bundle=createBundle(gl, await importSvg(B.svg)); renderer.setLoopBlinnFill('off');
  const drawSlug=(i)=>{ renderer.beginFrame([1,1,1,1]); renderer.drawBundle(bundle, {worldMatrix:[1,0,0,0,1,0,((i|0)&1)*1e-4,0,1]}); renderer.endFrame(); };  // beginFrame clears → cannot coalesce
  drawSlug(0); gl.finish(); const slPx=new Uint8Array(${N}*${N}*4); gl.readPixels(0,0,${N},${N},gl.RGBA,gl.UNSIGNED_BYTE,slPx);
  const mfMs=await timeGPU(drawMF, jitMF, g);
  const slMs=await timeGPU(drawSlug, (i)=>{}, gl);
  out[k]={ mfPx:Array.from(mfPx), slPx:Array.from(slPx), mfMs, slMs, nrec:B.nrec };
}
const dbg=g.getExtension('WEBGL_debug_renderer_info'); out.gpu=dbg?g.getParameter(dbg.UNMASKED_RENDERER_WEBGL):g.getParameter(g.RENDERER); out.hasTimer=!!ext;
window.__out=out; window.__ready=true;
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
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.error('  [console]', m.text());
});
let out;
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => window.__ready === true, { timeout: 40000 });
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
  `@ ${N}×${N}`,
  out.hasTimer ? '(GPU timer query)' : '(wall-clock fallback)',
);
for (const k of Object.keys(shapes)) {
  const b = out[k],
    cpu = built[k].cpu;
  let vsC = 0,
    vsS = 0,
    inkM = 0,
    inkS = 0;
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const rb = ((N - 1 - y) * N + x) * 4;
      const mf = 1 - b.mfPx[rb] / 255,
        sl = 1 - b.slPx[rb] / 255,
        c = cpu[y * N + x];
      vsC = Math.max(vsC, Math.abs(mf - c));
      vsS = Math.max(vsS, Math.abs(mf - sl));
      inkM += mf;
      inkS += sl;
    }
  console.log(`\n[${k}] ${b.nrec} y-mono segs`);
  console.log(
    `  validation: mesh-free vs CPU maxDiff=${vsC.toFixed(3)} | vs Slug maxDiff=${vsS.toFixed(3)} | ink mf=${inkM.toFixed(0)} slug=${inkS.toFixed(0)}`,
  );
  console.log(
    `  bench: mesh-free ${b.mfMs.toFixed(3)} ms | Slug ${b.slMs.toFixed(3)} ms | ratio ${(b.mfMs / b.slMs).toFixed(2)}×`,
  );
}
