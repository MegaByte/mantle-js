// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _lbCubicCircleBug — LB drops the CURVE crescents of a 4-cubic circle, drawing only
// the interior diamond through the anchors (ink == exactly the diamond's area).
// Characterize: winding, curve type, bulge, segment count.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 200,
  K = 0.5523;
// circle from 4 cubics, cw or ccw
function circCubic(cw) {
  const c = 100,
    r = 60,
    k = K * r;
  const P = [
    [c - r, c],
    [c, c - r],
    [c + r, c],
    [c, c + r],
  ]; // left, top, right, bottom (y-down)
  const pts = cw ? P : [P[0], P[3], P[2], P[1]];
  let d = `M ${pts[0][0]} ${pts[0][1]} `;
  for (let i = 0; i < 4; i++) {
    const A = pts[i],
      B = pts[(i + 1) % 4];
    // control points perpendicular to the radius, magnitude k
    const ta = [-(A[1] - c), A[0] - c],
      tb = [-(B[1] - c), B[0] - c];
    const sgn = cw ? 1 : -1;
    const c1 = [A[0] + ((sgn * ta[0]) / r) * k, A[1] + ((sgn * ta[1]) / r) * k];
    const c2 = [B[0] - ((sgn * tb[0]) / r) * k, B[1] - ((sgn * tb[1]) / r) * k];
    d += `C ${c1[0].toFixed(3)} ${c1[1].toFixed(3)} ${c2[0].toFixed(3)} ${c2[1].toFixed(3)} ${B[0]} ${B[1]} `;
  }
  return d + 'Z';
}
// circle from 4 quads (same anchors)
function circQuad(cw) {
  const c = 100,
    r = 60;
  const P = [
    [c - r, c],
    [c, c - r],
    [c + r, c],
    [c, c + r],
  ];
  const pts = cw ? P : [P[0], P[3], P[2], P[1]];
  let d = `M ${pts[0][0]} ${pts[0][1]} `;
  for (let i = 0; i < 4; i++) {
    const A = pts[i],
      B = pts[(i + 1) % 4];
    d += `Q ${A[0] + (B[0] - c) * 0 + (A[0] === c ? B[0] : A[0]) === 0 ? 0 : 0} 0 0 0 `;
  }
  return null;
}
// n-gon of cubics with controllable bulge (0 = straight lines)
function bulged(n, bulge) {
  const c = 100,
    r = 60;
  const P = (i) => {
    const a = (i / n) * 2 * Math.PI;
    return [c + r * Math.cos(a), c + r * Math.sin(a)];
  };
  let d = `M ${P(0)[0].toFixed(3)} ${P(0)[1].toFixed(3)} `;
  for (let i = 0; i < n; i++) {
    const A = P(i),
      B = P(i + 1);
    const bx = (B[1] - A[1]) * bulge,
      by = -(B[0] - A[0]) * bulge;
    const c1 = [A[0] + (B[0] - A[0]) / 3 + bx, A[1] + (B[1] - A[1]) / 3 + by];
    const c2 = [A[0] + (2 * (B[0] - A[0])) / 3 - bx, A[1] + (2 * (B[1] - A[1])) / 3 - by];
    d += `C ${c1[0].toFixed(3)} ${c1[1].toFixed(3)} ${c2[0].toFixed(3)} ${c2[1].toFixed(3)} ${B[0].toFixed(3)} ${B[1].toFixed(3)} `;
  }
  return d + 'Z';
}
const wrap = (d) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${N}" height="${N}"><path fill="#3366cc" d="${d}"/></svg>`;
const SQUIRCLE =
  'M 40 100 C 40 60 60 40 100 40 C 140 40 160 60 160 100 C 160 140 140 160 100 160 C 60 160 40 140 40 100 Z';
// quad + arc convex rings: does the fast mesh over-fill for NON-cubic curves too?
function quadRing(n, bulge) {
  const c = 100,
    r = 60;
  const P = (i) => {
    const a = (i / n) * 2 * Math.PI;
    return [c + r * Math.cos(a), c + r * Math.sin(a)];
  };
  let d = `M ${P(0)[0].toFixed(3)} ${P(0)[1].toFixed(3)} `;
  for (let i = 0; i < n; i++) {
    const A = P(i),
      B = P(i + 1);
    const mx = (A[0] + B[0]) / 2 + (B[1] - A[1]) * bulge,
      my = (A[1] + B[1]) / 2 - (B[0] - A[0]) * bulge;
    d += `Q ${mx.toFixed(3)} ${my.toFixed(3)} ${B[0].toFixed(3)} ${B[1].toFixed(3)} `;
  }
  return d + 'Z';
}
function arcRing(n) {
  const c = 100,
    r = 60;
  const P = (i) => {
    const a = (i / n) * 2 * Math.PI;
    return [c + r * Math.cos(a), c + r * Math.sin(a)];
  };
  let d = `M ${P(0)[0].toFixed(3)} ${P(0)[1].toFixed(3)} `;
  for (let i = 0; i < n; i++) {
    const A = P(i),
      B = P(i + 1);
    const rr = (Math.hypot(B[0] - A[0], B[1] - A[1]) / 2) * 1.05;
    d += `A ${rr.toFixed(3)} ${rr.toFixed(3)} 0 0 1 ${B[0].toFixed(3)} ${B[1].toFixed(3)} `;
  }
  return d + 'Z';
}
const CASES = {
  'squircle (corner ctrls)': wrap(SQUIRCLE),
  '8-quad  bulge 0.30': wrap(quadRing(8, 0.3)),
  '8-quad  bulge 0.55': wrap(quadRing(8, 0.55)),
  '8-arc   ring': wrap(arcRing(8)),
  '4-cubic circle CW': wrap(circCubic(true)),
  '4-cubic circle CCW': wrap(circCubic(false)),
  '<circle> primitive': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${N}" height="${N}"><circle cx="100" cy="100" r="60" fill="#3366cc"/></svg>`,
  '8-cubic bulge 0.55': wrap(bulged(8, 0.55)),
  '8-cubic bulge 0.30': wrap(bulged(8, 0.3)),
  '8-cubic bulge 0.00': wrap(bulged(8, 0.0)),
  '4-cubic bulge 0.55': wrap(bulged(4, 0.55)),
  '16-cubic bulge 0.55': wrap(bulged(16, 0.55)),
};
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas><script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const CASES=${JSON.stringify(CASES)}, N=${N};

const r=createRenderer(gl,shaders);
r.setLoopBlinnMeshOpts({ forceCdt: ${JSON.stringify(!!process.env.FORCE_CDT)} });
const readAll=()=>{const px=new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,px); return px;};
const inkT=(px,T)=>{let n=0; for(let i=0;i<px.length;i+=4) if(px[i]<T||px[i+1]<T||px[i+2]<T) n++; return n;};
const ink=(px)=>inkT(px,250);
const out=[];
for(const [name,svg] of Object.entries(CASES)){
  if(!svg) continue;
  const b=createBundle(gl, await importSvg(svg)); r.prepareBundle(b);
  const draw=()=>{r.setViewport(N,N); r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame();};
  r.setLoopBlinnFill('off'); draw(); const s=readAll();
  const c0=r.debugStats.loopBlinnRouteCount;
  r.setLoopBlinnFill('on'); draw(); const l=readAll();
  const routed=r.debugStats.loopBlinnRouteCount-c0;
  // which kinds does the mesh contain, and does it claim bezout?
  let kinds={}, hasBez=null;
  const M=b._lbMeshes;
  if(M && M[0] && M[0].verts){
    const V=M[0].verts, F=24;
    hasBez = M[0].hasBezout !== undefined ? M[0].hasBezout : (M[0].packed && M[0].packed.hasBezout);
    for(let i=0;i<M[0].vertexCount;i++){ const k=Math.floor(V[i*F+5]+0.001); kinds[k]=(kinds[k]||0)+1; }
  }
  out.push({name, routed, hasSlug:!!b._lbHasSlug, inkS:ink(s), inkL:ink(l), kinds, hasBez,
    r250:inkT(l,250)/Math.max(1,inkT(s,250)), r128:inkT(l,128)/Math.max(1,inkT(s,128)), r32:inkT(l,32)/Math.max(1,inkT(s,32))});
}
window.__out=out; window.__ready=true;</script></body></html>`;
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
const o = await pg.evaluate(() => window.__out);
await br.close();
server.close();
console.log('case                    routed hasSlug | inkSlug   inkLB   ratio');
for (const r of o) {
  const ratio = r.inkL / r.inkS;
  const flag = ratio < 0.97 ? '  <-- LB UNDER-FILLS' : ratio > 1.03 ? '  <-- LB OVER-FILLS' : '';
  console.log(
    `${r.name.padEnd(23)} ${String(r.routed).padStart(6)} ${String(r.hasSlug).padStart(7)} | ${String(r.inkS).padStart(7)} ${String(r.inkL).padStart(7)}  ${ratio.toFixed(3)}${flag}`,
  );
  console.log(
    `${''.padEnd(23)}   ink ratio @thresh 250=${r.r250.toFixed(3)}  128=${r.r128.toFixed(3)}  32=${r.r32.toFixed(3)}`,
  );
}
