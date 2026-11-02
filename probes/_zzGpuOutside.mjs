// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzGpuOutside — does the RENDERER paint outside the path?
//
// ONE SHAPE AT A TIME. The reference is rowSpans over every contour in the file, which is the
// NONZERO union -- on a multi-shape asset two shapes whose windings oppose cancel, and the spans
// stop describing the ink. Pointed at tiger it calls 41,000 of Slug's own pixels "outside", which
// is the tell: the absolute count is only meaningful where the known-good engine scores ~0, and
// the CPatch-minus-Slug comparison at the end is what survives either way. Not "does it differ from Slug", which
// classifies anything next to an edge as antialiasing and hides exactly this, and not the CPU
// model, which is only a model. Renders one shape and asks the exact path about every painted
// pixel: ink more than a filter's reach clear of the outline is ink in the wrong place.
import { readFileSync } from 'fs';
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = +(process.env.N || 512);
const FILE = process.env.SVG || '../fixtures/svg/_zzS166.svg';
const SVG = readFileSync(path.join(ROOT, FILE), 'utf8');
const CORNER = process.env.CORNER != null ? process.env.CORNER : null;
const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const cv=document.getElementById('c');
const gl=cv.getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const N=${N};
window.__run=async(svg)=>{
  if (${CORNER !== null} ) globalThis.__CP_CORNER_MITER = ${CORNER === null ? 0 : CORNER};
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
    // A TRANSPARENT CLEAR: over white, "painted white" and "not painted" are the same pixel, and
    // ink outside the shape is exactly what would be missed.
    r.beginFrame([0,0,0,0]); r.drawBundle(b); r.endFrame();
    const p=new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,p);
    const d=(r.debugStats&&r.debugStats.engines&&r.debugStats.engines.draws)||{};
    b.dispose();
    let t=''; for(let i=0;i<p.length;i+=4096) t+=String.fromCharCode.apply(null,p.subarray(i,i+4096));
    return {px:btoa(t), draws:JSON.stringify(d), built:(b._cpatchBuilt|0)};
  };
  const cp=await shot({cpatchFill:true, aacFill:false}, true);
  const sl=await shot({}, false);
  return {cp, sl, vb:sec.viewBox};
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

const sec = await importSvg(SVG, { preserveViewport: true });
const cf = sec.curves64 ? new Float64Array(sec.curves64) : new Float32Array(sec.curves);
const all = [];
for (const r of sec.curveRangesByShape || []) {
  if (!r) continue;
  const cs = contoursToConverter(curveRangeToContours(cf, r.begin | 0, r.end | 0), null);
  if (cs) for (const c of cs) for (const sg of c) all.push(sg);
}
// THE FIT, NOT THE VIEWBOX. A non-square viewBox into a square viewport is scaled UNIFORMLY and
// centered (xMidYMid meet), so a per-axis vb/N mapping is wrong in both axes at once -- and wrong
// silently: it reported Slug, which is correct by construction, as painting 5421 pixels outside
// its own path.
const vb = out.vb;
const SCALE = Math.min(N / vb[2], N / vb[3]);
const TX = (N - vb[2] * SCALE) / 2,
  TY = (N - vb[3] * SCALE) / 2;
const SC = 1 / SCALE; // em per device pixel
const armPx = {};
for (const [name, arm] of [
  ['cpatch', out.cp],
  ['slug', out.sl],
]) {
  armPx[name] = Buffer.from(arm.px, 'base64');
  const P = armPx[name];
  let ink = 0,
    outside = 0,
    worstA = 0;
  const at = [];
  for (let j = 0; j < N; j++) {
    const cy = vb[1] + (N - 1 - j + 0.5 - TY) / SCALE;
    const spans = rowSpans(all, cy) || [];
    for (let i = 0; i < N; i++) {
      const a = P[(j * N + i) * 4 + 3];
      if (a < 8) continue;
      ink++;
      const cx = vb[0] + (i + 0.5 - TX) / SCALE;
      let far = true;
      for (const sp of spans) if (cx > sp[0] - 1.5 * SC && cx < sp[1] + 1.5 * SC) far = false;
      if (!far) continue;
      outside++;
      if (a > worstA) worstA = a;
      if (at.length < 5) at.push(`(${i},${j}) alpha ${a}`);
    }
  }
  console.log(
    `${name}: draws ${arm.draws} built ${arm.built} — ${ink} inked px, ${outside} more than 1.5px` +
      ` clear of the path (worst alpha ${worstA})${at.length ? '  e.g. ' + at.join(' ') : ''}`,
  );
}

// AND THE only NUMBER THAT ISOLATES THE ENGINE: ink CPatch puts down where Slug puts none, out
// beyond the filter's reach from the path. The absolute count above still carries whatever error
// the clear-distance test has -- Slug scores almost the same on it -- so the comparison is the
// measurement and the absolute is only its scale.
{
  const C = armPx.cpatch,
    S2 = armPx.slug;
  let only = 0,
    worst = 0;
  const at = [];
  for (let j = 0; j < N; j++) {
    const cy = vb[1] + (N - 1 - j + 0.5 - TY) / SCALE;
    const spans = rowSpans(all, cy) || [];
    for (let i = 0; i < N; i++) {
      const k = (j * N + i) * 4;
      const d = C[k + 3] - S2[k + 3];
      if (d <= 8) continue;
      const cx = vb[0] + (i + 0.5 - TX) / SCALE;
      let far = true;
      for (const sp of spans) if (cx > sp[0] - 1.5 * SC && cx < sp[1] + 1.5 * SC) far = false;
      if (!far) continue;
      only++;
      if (d > worst) worst = d;
      if (at.length < 5) at.push(`(${i},${j}) +${d}`);
    }
  }
  console.log(
    `  CPatch ink where Slug has none, past the reach: ${only} px (worst +${worst})` +
      (at.length ? '  e.g. ' + at.join(' ') : ''),
  );
  // ...AND THE OTHER DIRECTION: ink Slug has that CPatch does not, well INSIDE the path. A gap in
  // the tiling shows here and nowhere else -- a dropped fragment deep in a shape is not an AA
  // difference, and the >64-vs-Slug metric classifies it as one whenever it happens to sit near
  // an edge.
  let gap = 0,
    gWorst = 0;
  const gAt = [];
  for (let j = 0; j < N; j++) {
    const cy = vb[1] + (N - 1 - j + 0.5 - TY) / SCALE;
    const spans = rowSpans(all, cy) || [];
    for (let i = 0; i < N; i++) {
      const k = (j * N + i) * 4;
      const d = S2[k + 3] - C[k + 3];
      if (d <= 8) continue;
      const cx = vb[0] + (i + 0.5 - TX) / SCALE;
      let deep = false;
      for (const sp of spans) if (cx > sp[0] + 1.5 * SC && cx < sp[1] - 1.5 * SC) deep = true;
      if (!deep) continue;
      gap++;
      if (d > gWorst) gWorst = d;
      if (gAt.length < 5) gAt.push(`(${i},${j}) -${d}`);
    }
  }
  console.log(
    `  Slug ink CPatch lacks, deep inside the path: ${gap} px (worst -${gWorst})` +
      (gAt.length ? '  e.g. ' + gAt.join(' ') : ''),
  );
}
