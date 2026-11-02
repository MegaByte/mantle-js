// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzOrderAttrib — of the pixels where Slug and CPatch paint different colors in flat interior,
// WHICH ONE IS RIGHT? Both engines are approximations; comparing them to each other only says they
// differ. This composites the document exactly on the CPU -- document order, Gauss-Legendre exact
// coverage per shape, OVER -- and asks that reference which engine matches.
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
import { parseMetaBin } from '../src/core/metaBin.js';
import { rowSpans } from '../src/renderer/cpatchConvert.js';
import { segPt } from '../src/geom/cpatchImplicit.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = +(process.env.N || 512);
const SRC = process.env.SVG || '../MantleSamples/Assets/Mantle/tiger.svg';
const SVG = readFileSync(SRC, 'utf8')
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
    let s=''; for(let i=0;i<px.length;i+=4096) s+=String.fromCharCode.apply(null,px.subarray(i,i+4096));
    return btoa(s);
  };
  const cp=await shot({cpatchFill:true, aacFill:false},true);
  const sl=await shot({},false);
  return {cp,sl,vb:sec.viewBox};
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
const port = srv.address().port;
const browser = await launchBrowser({
  headless: 'new',
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-webgpu', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR ' + e.message));
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle0' });
await page.waitForFunction('!!window.__run', { timeout: 60000 });
const out = await page.evaluate((s) => window.__run(s), SVG);
await browser.close();
srv.close();
const CP = Buffer.from(out.cp, 'base64'),
  SL = Buffer.from(out.sl, 'base64');

// ---- the exact CPU reference ----
const sec = await importSvg(SVG, { preserveViewport: true });
// THE FLOAT64 PLANE, which is what the build converts (cpatchCurvePlane). Converting the
// float32 wire plane instead rounds the inputs first and gives a DIFFERENT decomposition -- so a
// probe that reads it is modelling a shape the renderer never packed.
const cf = sec.curves64 ? new Float64Array(sec.curves64) : new Float32Array(sec.curves);
const parsed = parseMetaBin(sec.meta, sec.metaFloatsPerShave || sec.metaFloatsPerShape);
const MF = parsed.metaFloats,
  ST = parsed.floatsPerShape | 0,
  NS = parsed.numShapes | 0;
const vb = out.vb || [0, 0, 900, 900];
const SC = vb[2] / N; // em per device pixel (uniform, meet, square viewBox)
const shapes = [];
for (let s = 0; s < NS; s++) {
  const o = s * ST;
  const a = MF[o + 7];
  const r2 = sec.curveRangesByShape && sec.curveRangesByShape[s];
  if (!r2) {
    shapes.push(null);
    continue;
  }
  let cs = null;
  try {
    cs = contoursToConverter(curveRangeToContours(cf, r2.begin | 0, r2.end | 0), null);
  } catch {
    cs = null;
  }
  if (!cs || !cs.length) {
    shapes.push(null);
    continue;
  }
  const all = [];
  for (const c of cs) {
    for (const sg of c) all.push(sg);
    const p = segPt(c[0], 0),
      q = segPt(c[c.length - 1], 1);
    if (Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-9) all.push({ t: 'line', P: [q, p] });
  }
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
    rgba: [MF[o + 4], MF[o + 5], MF[o + 6], a],
    evenOdd: MF[o + 13] > 0.5,
    grad: MF[o + 28] | 0,
    bb: [x0, y0, x1, y1],
  });
}
const GL5 = [
  [-0.906179845938664, 0.2369268850561891],
  [-0.5384693101056831, 0.4786286704993665],
  [0, 0.5688888888888889],
  [0.5384693101056831, 0.4786286704993665],
  [0.906179845938664, 0.2369268850561891],
];
function covAt(sh, cx, cy, em) {
  let t = 0;
  for (const [q, w] of GL5) {
    const y = cy + 0.5 * em * q;
    let c2 = 0;
    for (const sp of rowSpans(sh.segs, y) || [])
      c2 += Math.max(0, Math.min(cx + em / 2, sp[1]) - Math.max(cx - em / 2, sp[0]));
    t += (w * 0.5 * c2) / em;
  }
  return Math.max(0, Math.min(1, t));
}
function refAt(i, j) {
  // j is bottom-up, as readPixels gives it
  const cx = vb[0] + (i + 0.5) * SC,
    cy = vb[1] + (N - 1 - j + 0.5) * SC;
  let R = 255,
    G = 255,
    B2 = 255,
    stack = [];
  for (let s = 0; s < shapes.length; s++) {
    const sh = shapes[s];
    if (!sh) continue;
    if (sh.rgba[3] <= 0 && !sh.grad) continue;
    if (cx < sh.bb[0] - SC || cx > sh.bb[2] + SC || cy < sh.bb[1] - SC || cy > sh.bb[3] + SC)
      continue;
    const c = covAt(sh, cx, cy, SC);
    if (c <= 0) continue;
    const a = c * sh.rgba[3];
    R = sh.rgba[0] * 255 * a + R * (1 - a);
    G = sh.rgba[1] * 255 * a + G * (1 - a);
    B2 = sh.rgba[2] * 255 * a + B2 * (1 - a);
    stack.push(
      `s${s}:${c.toFixed(2)}:${(sh.rgba[0] * 255) | 0},${(sh.rgba[1] * 255) | 0},${(sh.rgba[2] * 255) | 0}${sh.grad ? '(grad)' : ''}`,
    );
  }
  return { rgb: [R, G, B2], stack };
}
const lum = (P, k) => 0.299 * P[k * 4] + 0.587 * P[k * 4 + 1] + 0.114 * P[k * 4 + 2];
// sanity: does the reference agree with SLUG on a random flat sample?
{
  let n = 0,
    agree = 0,
    worst = 0;
  const miss = new Map();
  for (let t = 0; t < 4000; t++) {
    const i = 3 + ((t * 8191) % (N - 6)),
      j = 3 + ((t * 5147) % (N - 6));
    const k = j * N + i;
    let flat = true;
    for (let dj = -1; dj <= 1 && flat; dj++)
      for (let di = -1; di <= 1; di++)
        if (Math.abs(lum(SL, (j + dj) * N + (i + di)) - lum(SL, k)) > 2) {
          flat = false;
          break;
        }
    if (!flat) continue;
    const r = refAt(i, j);
    n++;
    const d = Math.max(
      Math.abs(r.rgb[0] - SL[k * 4]),
      Math.abs(r.rgb[1] - SL[k * 4 + 1]),
      Math.abs(r.rgb[2] - SL[k * 4 + 2]),
    );
    if (d <= 8) agree++;
    else {
      if (d > worst) worst = d;
      const key = `ref ${r.rgb.map((v) => v | 0).join(',')} vs slug ${SL[k * 4]},${SL[k * 4 + 1]},${SL[k * 4 + 2]}`;
      miss.set(key, (miss.get(key) | 0) + 1);
    }
  }
  console.log(
    `reference vs SLUG on ${n} flat random px: ${agree} agree within 8 (worst miss ${worst.toFixed(0)})`,
  );
  for (const [kk, vv] of [...miss].sort((a, b) => b[1] - a[1]).slice(0, 8))
    console.log(`    ${String(vv).padStart(5)}  ${kk}`);
}
// the population under test
let flat = 0,
  refSlug = 0,
  refCp = 0,
  refNeither = 0;
const samples = [];
for (let j = 1; j < N - 1; j++)
  for (let i = 1; i < N - 1; i++) {
    const k = j * N + i;
    if (SL[k * 4 + 3] < 128 || CP[k * 4 + 3] < 128) continue;
    const d = Math.max(
      Math.abs(CP[k * 4] - SL[k * 4]),
      Math.abs(CP[k * 4 + 1] - SL[k * 4 + 1]),
      Math.abs(CP[k * 4 + 2] - SL[k * 4 + 2]),
    );
    if (d <= 64) continue;
    let same = true;
    for (let dj = -1; dj <= 1 && same; dj++)
      for (let di = -1; di <= 1; di++)
        if (Math.abs(lum(SL, (j + dj) * N + (i + di)) - lum(SL, k)) > 8) {
          same = false;
          break;
        }
    if (!same) continue;
    flat++;
    const r = refAt(i, j);
    const ds = Math.max(
      Math.abs(r.rgb[0] - SL[k * 4]),
      Math.abs(r.rgb[1] - SL[k * 4 + 1]),
      Math.abs(r.rgb[2] - SL[k * 4 + 2]),
    );
    const dc = Math.max(
      Math.abs(r.rgb[0] - CP[k * 4]),
      Math.abs(r.rgb[1] - CP[k * 4 + 1]),
      Math.abs(r.rgb[2] - CP[k * 4 + 2]),
    );
    if (ds <= 24 && dc > 24) refSlug++;
    else if (dc <= 24 && ds > 24) refCp++;
    else refNeither++;
    if (samples.length < 14 && (i * 13 + j) % 17 === 0)
      samples.push(
        `  (${i},${j})  ref ${r.rgb.map((v) => v | 0).join(',')}  slug ${SL[k * 4]},${SL[k * 4 + 1]},${SL[k * 4 + 2]}  cpatch ${CP[k * 4]},${CP[k * 4 + 1]},${CP[k * 4 + 2]}\n      ${r.stack.join(' | ')}`,
      );
  }
console.log(`flat-interior wrong color: ${flat}`);
console.log(
  `  the exact reference agrees with SLUG ${refSlug}, with CPATCH ${refCp}, with NEITHER ${refNeither}`,
);
console.log(samples.join('\n'));
