// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzHullRowsAB — what do the cover-hull plane rows buy, given a converter that does not invent
// area? They stop a patch painting through its own quad's 1.5px dilation. Both arms in ONE page,
// interleaved: a cross-run timing on this machine drifts 30-40%.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = +(process.env.N || 512);
const SVG = readFileSync(process.env.SVG || '../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
// An arm is `hullRows` or `hullRows:samples` -- the second is how many directions the hull
// ROWS are sampled in (the quad always keeps the full hull).
const ARMS = (process.env.ARMS || '0,2:1,2:2,2:4,2:8,2:16').split(',');
const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const cv=document.getElementById('c');
const gl=cv.getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const N=${N}, ARMS=${JSON.stringify(ARMS)};
window.__run=async(svg)=>{
  const sec=await importSvg(svg,{preserveViewport:true});
  const sleepP=(ms)=>new Promise((z)=>setTimeout(z,ms));
  // ONE BUNDLE ALIVE AT A TIME. The unified fill route keeps ONE stream in a shared VBO, so two
  // live CPatch bundles thrash the ownership and the route declines them both -- which reads as a
  // clean A/B where every arm quietly drew Slug. Arms run in sequence in ONE page instead: same
  // process, same GPU state, same driver warm-up, which is what a within-run comparison needs.
  // 'lb' is Loop-Blinn FORCED, 'slug' is Slug; both ignore the CPatch fields. Forced, because on
  // 'auto' the route picks per shape and the arm stops being one engine.
  const arm=async(spec)=>{
    if (spec === 'lb' || spec === 'slug') {
      const r2=createRenderer(gl,shaders,{});
      if (r2.setLoopBlinnFill) r2.setLoopBlinnFill(spec === 'lb' ? 'on' : 'off');
      const b2=createBundle(gl,sec);
      if (r2.prepareBundle) r2.prepareBundle(b2);
      if (r2.awaitLbReady) await r2.awaitLbReady(b2);
      r2.setViewport(N,N); gl.viewport(0,0,N,N);
      const one2=new Uint8Array(4), ts2=[];
      for (let k=0;k<24;k++){ const t0=performance.now();
        r2.beginFrame([1,1,1,1]); r2.drawBundle(b2); r2.endFrame();
        gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,one2); ts2.push(performance.now()-t0); }
      const p2=new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,p2);
      ts2.sort((a,b3)=>a-b3);
      const d2=(r2.debugStats&&r2.debugStats.engines&&r2.debugStats.engines.draws)||{};
      const o2={ ms:ts2[ts2.length>>1], px:Array.from(p2), built:0, draws:JSON.stringify(d2), blocks:0 };
      b2.dispose(); return o2;
    }
    const hr = spec === '-1' ? -1 : +String(spec).split(':')[0];
    const sm = String(spec).split(':')[1];
    // (The spec has two fields; there are no outline-row knobs.)
    globalThis.__MANTLE_DEBUG__ = true;   // the row knobs below are test hooks, read only under it
    if (hr >= 0) globalThis.__CP_HULL_ROWS=hr; else delete globalThis.__CP_HULL_ROWS;
    if (sm != null) globalThis.__CP_HULL_ROW_SAMPLES=+sm; else delete globalThis.__CP_HULL_ROW_SAMPLES;
    // pool:false CONVERTS IN-THREAD. The pooled conversion hands work to a worker pool, and after the
    // first arm the next arm's conversion never resolved -- it sat at 'pending' past the budget and
    // the bundle drew Slug with built 0, which reads exactly like a route decline. Conversion is
    // build-time, so what is MEASURED here does not change.
    const r=createRenderer(gl,shaders, hr>=0?{cpatchFill:true, aacFill:false, cpatchOpts:{pool:false}}:{});
    const b=createBundle(gl,sec);
    if (r.prepareBundle) r.prepareBundle(b);
    if (hr>=0){ let w=0; while(b._cpatchConv==='pending' && w<30000){ await sleepP(5); w+=5; }
      if (r.prepareBundle) r.prepareBundle(b);
      while(b._cpatchConv==='pending' && w<30000){ await sleepP(5); w+=5; }
      if (r.prepareBundle) r.prepareBundle(b); }
    if (r.awaitLbReady) await r.awaitLbReady(b);
    r.setViewport(N,N); gl.viewport(0,0,N,N);
    const one=new Uint8Array(4), ts=[];
    for (let k=0;k<24;k++){
      const t0=performance.now();
      r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame();
      gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,one);
      ts.push(performance.now()-t0);
    }
    const p=new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,p);
    ts.sort((x,y)=>x-y);
    const d=(r.debugStats&&r.debugStats.engines&&r.debugStats.engines.draws)||{};
    const out={ ms:ts[ts.length>>1], px:Array.from(p), built:(b._cpatchBuilt|0),
                draws:JSON.stringify(d), blocks:(b._cpatchBlocks|0) };
    b.dispose();
    return out;
  };
  // TWICE THROUGH, INTERLEAVED: the first pass over any arm pays the driver's warm-up, so a single
  // sweep charges it to whichever arm ran first. The second pass is what is reported.
  const res={};
  for (const pass of [0,1]) for (const hr of ARMS) res[hr]=await arm(hr);
  const slug=await arm('-1');
  return {res, slug};
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
const SL = out.slug.px;
const lum = (P, k) => 0.299 * P[k * 4] + 0.587 * P[k * 4 + 1] + 0.114 * P[k * 4 + 2];
console.log(`slug: ${out.slug.ms.toFixed(2)} ms  draws ${out.slug.draws}`);
for (const hr of ARMS) {
  const A = out.res[hr],
    P = A.px;
  let d64 = 0,
    flat = 0,
    sum = 0,
    n = 0,
    worst = 0;
  for (let j = 1; j < N - 1; j++)
    for (let i = 1; i < N - 1; i++) {
      const k2 = j * N + i;
      const d = Math.max(
        Math.abs(P[k2 * 4] - SL[k2 * 4]),
        Math.abs(P[k2 * 4 + 1] - SL[k2 * 4 + 1]),
        Math.abs(P[k2 * 4 + 2] - SL[k2 * 4 + 2]),
      );
      n++;
      sum += d;
      if (d > worst) worst = d;
      if (d <= 64) continue;
      d64++;
      let same = true;
      for (let dj = -1; dj <= 1 && same; dj++)
        for (let di = -1; di <= 1; di++)
          if (Math.abs(lum(SL, (j + dj) * N + (i + di)) - lum(SL, k2)) > 8) {
            same = false;
            break;
          }
      if (same) flat++;
    }
  console.log(
    `arm ${String(hr).padEnd(5)}: ${A.ms.toFixed(2)} ms  built ${A.built}  draws ${A.draws}` +
      `   >64 ${d64} (flat interior ${flat})  worst ${worst}  mean |d| ${(sum / n).toFixed(3)}`,
  );
}
