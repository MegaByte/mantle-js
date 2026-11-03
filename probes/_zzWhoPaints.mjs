// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzWhoPaints — name the shape each engine put on a pixel.
//
// Comparing two engines' COLORS only says they differ; comparing them to a reference says which is
// wrong. Neither says WHO painted it, and on a stacked asset that is the whole question. This
// rewrites every shape's fill color to encode its own index (hi nibble in red, lo in green), so a
// single frame reads back as a map of winners -- and the two engines' maps can be differenced.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = +(process.env.N || 512);
const SRC = process.env.SVG || '../MantleSamples/Assets/Mantle/tiger.svg';
const SVG = readFileSync(SRC, 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const POOL = process.env.POOL === '0' ? 'false' : 'true';
const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, parseMetaBin } from '/src/index.js';
const cv=document.getElementById('c');
const gl=cv.getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const N=${N};
window.__run=async(svg)=>{
  const sec=await importSvg(svg,{preserveViewport:true});
  // ONE BYTE PER NIBBLE so the readback is exact: a meta fill is a float and the target is 8-bit,
  // so k/255 comes back as byte k. Alpha is left alone -- forcing it to 1 would paint every
  // fill="none" shape and change the very stacking the map is meant to show.
  const p=parseMetaBin(sec.meta, sec.metaFloatsPerShape);
  const MF=p.metaFloats, ST=p.floatsPerShape;
  for(let s=0;s<p.numShapes;s++){
    const o=s*ST;
    if (!(MF[o+7]>0)) continue;
    MF[o+4]=((s>>4)&255)/255; MF[o+5]=(s&15)/255; MF[o+6]=128/255;
  }
  const sleepP=(ms)=>new Promise((z)=>setTimeout(z,ms));
  const shot=async(opts,wantCp)=>{
    const r=createRenderer(gl,shaders,opts);
    const b=createBundle(gl,sec);
    if (r.prepareBundle) r.prepareBundle(b);
    if (wantCp){ let w=0;
      while(b._cpatchConv==='pending' && w<30000){ await sleepP(5); w+=5; }
      if (r.prepareBundle) r.prepareBundle(b);
      while(b._cpatchConv==='pending' && w<30000){ await sleepP(5); w+=5; }
      if (r.prepareBundle) r.prepareBundle(b); }
    if (r.awaitLbReady) await r.awaitLbReady(b);
    r.setViewport(N,N); gl.viewport(0,0,N,N);
    r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame();
    const px=new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,px);
    b.dispose();
    let t=''; for(let i=0;i<px.length;i+=4096) t+=String.fromCharCode.apply(null,px.subarray(i,i+4096));
    return btoa(t);
  };
  const cp=await shot({cpatchFill:true, aacFill:false, cpatchOpts:{pool:${POOL}}},true);
  const sl=await shot({},false);
  // AND THE MESHES THE RENDERER ACTUALLY BUILT. Every reconstruction of the decomposition in node
  // is a second implementation until it is checked against the one that drew the frame.
  const r2=createRenderer(gl,shaders,{cpatchFill:true, aacFill:false, cpatchOpts:{pool:${POOL}}});
  const b2=createBundle(gl,sec);
  if (r2.prepareBundle) r2.prepareBundle(b2);
  { let w=0; while(b2._cpatchConv==='pending' && w<30000){ await sleepP(5); w+=5; }
    if (r2.prepareBundle) r2.prepareBundle(b2);
    while(b2._cpatchConv==='pending' && w<30000){ await sleepP(5); w+=5; }
    if (r2.prepareBundle) r2.prepareBundle(b2); }
  const mesh={};
  for (const s of (${JSON.stringify((process.env.MESH || '13,82').split(',').map(Number))})) {
    const m=b2._lbMeshes && b2._lbMeshes[s];
    mesh[s]= m ? {vertexCount:m.vertexCount, stride:m.verts.length/m.vertexCount,
                  verts:Array.from(m.verts), cpatch:!!m.cpatch, prim:!!m.prim} : null;
  }
  b2.dispose();
  return {cp,sl,mesh};
};
</script></body></html>`;
const srv = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  if (u === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(HTML);
  }
  try {
    const p = path.join(ROOT, u);
    if (!p.startsWith(ROOT)) throw new Error('esc');
    const body = readFileSync(p);
    const ct =
      u.endsWith('.js') || u.endsWith('.mjs')
        ? 'text/javascript'
        : u.endsWith('.glsl') || u.endsWith('.wgsl')
          ? 'text/plain'
          : 'application/octet-stream';
    res.writeHead(200, { 'content-type': ct });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('no');
  }
});
await new Promise((z) => srv.listen(0, z));
const browser = await launchBrowser({
  headless: 'new',
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-webgpu', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR ' + e.message));
await page.goto(`http://127.0.0.1:${srv.address().port}/`, { waitUntil: 'networkidle0' });
await page.waitForFunction('!!window.__run', { timeout: 60000 });
const out = await page.evaluate((s) => window.__run(s), SVG);
await browser.close();
srv.close();
const CP = Buffer.from(out.cp, 'base64'),
  SL = Buffer.from(out.sl, 'base64');
{
  const SC = 900 / N;
  for (const k of Object.keys(out.mesh || {})) {
    const m = out.mesh[k];
    if (!m) {
      console.log(`  mesh s${k}: NONE`);
      continue;
    }
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (let v = 0; v < m.vertexCount; v++) {
      const o = v * m.stride;
      const x = m.verts[o] + m.verts[o + 17] + m.verts[o + 2] * 1.5 * SC,
        y = m.verts[o + 1] + m.verts[o + 18] + m.verts[o + 3] * 1.5 * SC;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    console.log(
      `  mesh s${k}: ${m.vertexCount} verts stride ${m.stride} cpatch=${m.cpatch} prim=${m.prim}` +
        `  dilated bbox [${x0.toFixed(1)}, ${y0.toFixed(1)}] .. [${x1.toFixed(1)}, ${y1.toFixed(1)}]`,
    );
    for (const q of (process.env.PTS || '257,327 258,327').split(' ')) {
      const [i, j] = q.split(',').map(Number);
      const cx = (i + 0.5) * SC,
        cy = (N - 1 - j + 0.5) * SC;
      let hit = 0,
        hitRaw = 0;
      for (let t = 0; t + 2 < m.vertexCount; t += 3) {
        for (const dil of [1.5, 0]) {
          const P = [0, 1, 2].map((u) => {
            const o = (t + u) * m.stride;
            return [
              m.verts[o] + m.verts[o + 17] + m.verts[o + 2] * dil * SC,
              m.verts[o + 1] + m.verts[o + 18] + m.verts[o + 3] * dil * SC,
            ];
          });
          const d = (a, c, e) => (c[0] - a[0]) * (e[1] - a[1]) - (e[0] - a[0]) * (c[1] - a[1]);
          const d1 = d(P[0], P[1], [cx, cy]),
            d2 = d(P[1], P[2], [cx, cy]),
            d3 = d(P[2], P[0], [cx, cy]);
          if ((d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0)) {
            if (dil) hit++;
            else hitRaw++;
          }
        }
      }
      console.log(
        `      (${i},${j}) em (${cx.toFixed(2)},${cy.toFixed(2)}): ${hit} dilated / ${hitRaw} raw triangles reach`,
      );
    }
  }
}
const who = (P, k) => (P[k * 4 + 2] === 128 ? (P[k * 4] << 4) | P[k * 4 + 1] : -1);
// Only pixels both engines paint SOLIDLY with one shape: an AA blend of two ids is not an id, and
// this is looking for a different WINNER, not a different ramp. The blue marker is the test -- a
// blend moves it off 128.
let n = 0;
const pairs = new Map(),
  byCp = new Map();
// FLAT INTERIOR ON both SIDES. An id is a color, so an AA blend of two neighbouring ids is a
// perfectly plausible third id -- the blue marker cannot see it, because both shapes carry the same
// blue. What separates a real disagreement from a ramp is that the 3x3 around it is ONE shape in
// each engine: then neither is antialiasing anything here and they simply chose differently.
const uni = (P, i, j) => {
  const v = who(P, j * N + i);
  if (v < 0) return -1;
  for (let dj = -1; dj <= 1; dj++)
    for (let di = -1; di <= 1; di++) if (who(P, (j + dj) * N + (i + di)) !== v) return -1;
  return v;
};
for (let j = 1; j < N - 1; j++)
  for (let i = 1; i < N - 1; i++) {
    const a = uni(SL, i, j),
      b = uni(CP, i, j);
    if (a < 0 || b < 0 || a === b) continue;
    n++;
    const key = `slug s${a} -> cpatch s${b}`;
    pairs.set(key, (pairs.get(key) | 0) + 1);
    const e = byCp.get(b) || { n: 0, at: [] };
    e.n++;
    if (e.at.length < 4) e.at.push(`${i},${j}`);
    byCp.set(b, e);
  }
console.log(`${n} pixels flat-interior in BOTH engines where the WINNER differs`);
console.log('  commonest:');
for (const [k, v] of [...pairs].sort((a, b) => b[1] - a[1]).slice(0, 12))
  console.log(`    ${String(v).padStart(6)}  ${k}`);
console.log('  by the shape CPatch chose:');
for (const [k, v] of [...byCp].sort((a, b) => b[1].n - a[1].n).slice(0, 12))
  console.log(`    s${k}: ${v.n} px, e.g. ${v.at.join('  ')}`);
