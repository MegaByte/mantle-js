// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzAaVisual — the frames a decision about the outline rows has to be made from. Renders tiger
// through CPatch with the rows OFF and ON, and Slug beside them, and writes the three plus the
// exact per-pixel reference so a contact sheet can put them side by side.
//
// WHY NOT JUST DIFF THE TWO: the question is not "did it change" but "is what changed WRONG in one
// and RIGHT in the other", and only the exact reference answers that. It is written out too.
import { readFileSync, writeFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { rowSpans } from '../src/renderer/cpatchConvert.js';
import { parseMetaBin } from '../src/core/metaBin.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = +(process.env.N || 512);
const OUT = process.env.OUTDIR || '/tmp/mantle-aa';
const SVG = readFileSync(process.env.SVG || '../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const cv=document.getElementById('c');
const gl=cv.getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const N=${N};
window.__run=async(svg)=>{
  const sec=await importSvg(svg,{preserveViewport:true});
  const sleepP=(ms)=>new Promise((z)=>setTimeout(z,ms));
  // ONE BUNDLE ALIVE AT A TIME: the unified route keeps one stream in a shared VBO, and two live
  // CPatch bundles make it decline them both.
  // outN >= 0 is CPatch; -1 is Slug; -2 is Loop-Blinn, FORCED, which
  // is what setLoopBlinnFill('on') is for -- left to 'auto' the route picks per shape and the arm
  // stops being one engine.
  const arm=async(outN)=>{
    const r=createRenderer(gl,shaders, outN>=0?{cpatchFill:true, aacFill:false}:{});
    if (outN === -2 && r.setLoopBlinnFill) r.setLoopBlinnFill('on');
    if (outN === -1 && r.setLoopBlinnFill) r.setLoopBlinnFill('off');
    const b=createBundle(gl,sec);
    if (r.prepareBundle) r.prepareBundle(b);
    if (outN>=0){ let w=0; while(b._cpatchConv==='pending' && w<30000){ await sleepP(5); w+=5; }
      if (r.prepareBundle) r.prepareBundle(b);
      while(b._cpatchConv==='pending' && w<30000){ await sleepP(5); w+=5; }
      if (r.prepareBundle) r.prepareBundle(b); }
    if (r.awaitLbReady) await r.awaitLbReady(b);
    r.setViewport(N,N); gl.viewport(0,0,N,N);
    const one=new Uint8Array(4), ts=[];
    for (let k=0;k<24;k++){ const t0=performance.now();
      r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame();
      gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,one); ts.push(performance.now()-t0); }
    const p=new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,p);
    ts.sort((a,b2)=>a-b2);
    b.dispose();
    let s2=''; for(let i=0;i<p.length;i+=4096) s2+=String.fromCharCode.apply(null,p.subarray(i,i+4096));
    return {px:btoa(s2), ms:ts[ts.length>>1]};
  };
  const off=await arm(0), on=await arm(6), lb=await arm(-2), slug=await arm(-1);
  return {off,on,lb,slug,vb:sec.viewBox};
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
for (const k of ['off', 'on', 'lb', 'slug'])
  writeFileSync(`${OUT}_${k}.raw`, Buffer.from(out[k].px, 'base64'));
console.log(
  `frames written; median frame: rows off ${out.off.ms.toFixed(2)} ms, on ${out.on.ms.toFixed(2)} ms,` +
    ` Slug ${out.slug.ms.toFixed(2)} ms`,
);

// ---- the exact reference, composited in document order ----
const sec = await importSvg(SVG, { preserveViewport: true });
const cf = sec.curves64 ? new Float64Array(sec.curves64) : new Float32Array(sec.curves);
const meta = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
const MF = meta.metaFloats,
  ST = meta.floatsPerShape | 0;
const vb = out.vb,
  SC = vb[2] / N;
const GL5 = [
  [-0.906179845938664, 0.2369268850561891],
  [-0.5384693101056831, 0.4786286704993665],
  [0, 0.5688888888888889],
  [0.5384693101056831, 0.4786286704993665],
  [0.906179845938664, 0.2369268850561891],
];
const shapes = [];
for (let s = 0; s < meta.numShapes; s++) {
  const o = s * ST,
    r = sec.curveRangesByShape && sec.curveRangesByShape[s];
  if (!r || !(MF[o + 7] > 0)) {
    shapes.push(null);
    continue;
  }
  let cs = null;
  try {
    cs = contoursToConverter(curveRangeToContours(cf, r.begin | 0, r.end | 0), null);
  } catch {
    cs = null;
  }
  if (!cs || !cs.length) {
    shapes.push(null);
    continue;
  }
  const all = [];
  for (const c of cs) for (const sg of c) all.push(sg);
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const sg of all)
    for (const P of sg.P) {
      if (P[0] < x0) x0 = P[0];
      if (P[0] > x1) x1 = P[0];
      if (P[1] < y0) y0 = P[1];
      if (P[1] > y1) y1 = P[1];
    }
  shapes.push({
    segs: all,
    rgb: [MF[o + 4] * 255, MF[o + 5] * 255, MF[o + 6] * 255],
    a: MF[o + 7],
    bb: [x0, y0, x1, y1],
  });
}
const ref = Buffer.alloc(N * N * 4, 255);
for (let j = 0; j < N; j++) {
  const cy = vb[1] + (N - 1 - j + 0.5) * SC;
  for (let i = 0; i < N; i++) {
    const cx = vb[0] + (i + 0.5) * SC;
    let R = 255,
      G = 255,
      B = 255;
    for (const sh of shapes) {
      if (!sh) continue;
      if (cx < sh.bb[0] - SC || cx > sh.bb[2] + SC || cy < sh.bb[1] - SC || cy > sh.bb[3] + SC)
        continue;
      let t = 0;
      for (const [q, w] of GL5) {
        const y = cy + 0.5 * SC * q;
        let c2 = 0;
        for (const sp of rowSpans(sh.segs, y) || [])
          c2 += Math.max(0, Math.min(cx + SC / 2, sp[1]) - Math.max(cx - SC / 2, sp[0]));
        t += (w * 0.5 * c2) / SC;
      }
      const a = Math.min(1, Math.max(0, t)) * sh.a;
      if (a <= 0) continue;
      R = sh.rgb[0] * a + R * (1 - a);
      G = sh.rgb[1] * a + G * (1 - a);
      B = sh.rgb[2] * a + B * (1 - a);
    }
    const k = (j * N + i) * 4;
    ref[k] = Math.round(R);
    ref[k + 1] = Math.round(G);
    ref[k + 2] = Math.round(B);
    ref[k + 3] = 255;
  }
}
writeFileSync(`${OUT}_ref.raw`, ref);
console.log(`exact reference written to ${OUT}_ref.raw (${N}x${N})`);
