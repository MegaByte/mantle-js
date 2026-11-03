// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzScaleAll — scale invariance, every engine, empirically.
//
// Scaling by a POWER OF TWO is lossless through add, multiply, divide and sqrt: every coordinate,
// length and area comes out exactly 2^k times what it was, with the same mantissa. So if the whole
// pipeline is scale invariant, scaling the artwork by 2^k and the viewBox with it must render the
// IDENTICAL frame -- the fit undoes the scale exactly. Any pixel that moves is a comparison against
// a constant somewhere: an absolute epsilon, a threshold in world units, a hardcoded tolerance.
//
// That makes the audit decidable rather than a reading exercise. It finds them without knowing
// where they are, and it tells the truth about which ENGINE owns each one.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = +(process.env.N || 384);
const SRC = process.env.SVG || '../MantleSamples/Assets/Mantle/tiger.svg';
const RAW = readFileSync(path.join(ROOT, SRC), 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const KS = (process.env.KS || '-4,-3,-2,-1,0,1,2,3,4').split(',').map(Number);
const ENGINES = (process.env.ENGINES || 'slug,lb,aac,cpatch').split(',');

/// The same artwork at 2^k: content wrapped in an exact scale, viewBox scaled to match, so the
/// renderer's fit maps it back onto the same pixels.
function scaled(k) {
  const S = Math.pow(2, k);
  const m = RAW.match(/viewBox\s*=\s*"([^"]+)"/);
  const vb = m
    ? m[1]
        .trim()
        .split(/[\s,]+/)
        .map(Number)
    : [0, 0, 900, 900];
  const nvb = vb.map((v) => v * S).join(' ');
  const body = RAW.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${nvb}"><g transform="scale(${S})">${body}</g></svg>`;
}

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
// NOSDF=1 turns the circle/ellipse recognisers off, so every shape goes down the general fill.
// The disc rides BOTH engines' draws, so it has to be excluded before a residue can be blamed
// on either of them.
// NOFALLBACK=1 makes Loop-Blinn keep every shape (the over-paint audit off), so the LB route
// draws no Slug at all -- which separates a residue owned by LB's own kernels from one owned by
// the shapes it declines.
if (${process.env.NOFALLBACK ? 'true' : 'false'}) { globalThis.__MANTLE_DEBUG__ = true; globalThis.__lbAuditOff = 1; }
if (${process.env.NOSDF ? 'true' : 'false'}) {
  const m = await import('/src/geom/shapeRecognize.js');
  if (m.setSdfPrimitivesEnabled) m.setSdfPrimitivesEnabled(false);
}
const cv=document.getElementById('c');
const gl=cv.getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const N=${N};
window.__shot=async(svg,engine)=>{
  const sec=await importSvg(svg,{preserveViewport:true});
  const sleepP=(ms)=>new Promise((z)=>setTimeout(z,ms));
  const opts = engine==='cpatch' ? {cpatchFill:true, aacFill:false, cpatchOpts:{pool:false}}
             : engine==='aac'    ? {aacFill:true}
             : {};
  const r=createRenderer(gl,shaders,opts);
  if (r.setLoopBlinnFill) r.setLoopBlinnFill(engine==='lb' ? 'on' : engine==='slug' ? 'off' : 'auto');
  const b=createBundle(gl,sec);
  if (r.prepareBundle) r.prepareBundle(b);
  if (engine==='cpatch'){ let w=0;
    while(b._cpatchConv==='pending' && w<20000){ await sleepP(5); w+=5; }
    if (r.prepareBundle) r.prepareBundle(b); }
  if (r.awaitLbReady) await r.awaitLbReady(b);
  r.setViewport(N,N); gl.viewport(0,0,N,N);
  r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame();
  const p=new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,p);
  const d=(r.debugStats&&r.debugStats.engines&&r.debugStats.engines.draws)||{};
  b.dispose();
  let s=''; for(let i=0;i<p.length;i+=4096) s+=String.fromCharCode.apply(null,p.subarray(i,i+4096));
  return {px:btoa(s), draws:JSON.stringify(d)};
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
await page.waitForFunction('!!window.__shot', { timeout: 60000 });

console.log(`${path.basename(SRC)} at ${N}px, scales 2^${KS[0]} .. 2^${KS[KS.length - 1]}`);
console.log(
  `${'engine'.padEnd(8)} ${'draws'.padEnd(30)} ` + KS.map((k) => `2^${k}`.padStart(9)).join(''),
);
for (const eng of ENGINES) {
  const shots = {};
  let draws = '';
  for (const k of KS) {
    const r = await page.evaluate((s, e) => window.__shot(s, e), scaled(k), eng);
    shots[k] = Buffer.from(r.px, 'base64');
    if (k === 0) draws = r.draws;
  }
  const base = shots[0];
  const cells = KS.map((k) => {
    if (k === 0) return '        -';
    const a = shots[k];
    let n = 0;
    for (let i = 0; i < N * N; i++) {
      const d = Math.max(
        Math.abs(a[i * 4] - base[i * 4]),
        Math.abs(a[i * 4 + 1] - base[i * 4 + 1]),
        Math.abs(a[i * 4 + 2] - base[i * 4 + 2]),
      );
      if (d > 8) n++;
    }
    return String(n).padStart(9);
  });
  // WHERE they move, for the worst scale: a threshold that fires on a handful of pixels is only
  // findable if you know which pixels. Reported as components, with the frame's own colors either
  // side, because "which shape" is the question that turns this into one code path to read.
  if (process.env.WHERE) {
    let worstK = KS[0],
      worstN = -1;
    for (const k of KS) {
      if (k === 0) continue;
      const a = shots[k];
      let n = 0;
      for (let i = 0; i < N * N; i++) {
        const d = Math.max(
          Math.abs(a[i * 4] - base[i * 4]),
          Math.abs(a[i * 4 + 1] - base[i * 4 + 1]),
          Math.abs(a[i * 4 + 2] - base[i * 4 + 2]),
        );
        if (d > 8) n++;
      }
      if (n > worstN) {
        worstN = n;
        worstK = k;
      }
    }
    const a = shots[worstK];
    const seen = new Uint8Array(N * N);
    const comps = [];
    for (let i = 0; i < N * N; i++) {
      const d = Math.max(
        Math.abs(a[i * 4] - base[i * 4]),
        Math.abs(a[i * 4 + 1] - base[i * 4 + 1]),
        Math.abs(a[i * 4 + 2] - base[i * 4 + 2]),
      );
      if (d <= 8 || seen[i]) continue;
      const st = [i];
      seen[i] = 1;
      let sx = 0,
        sy = 0,
        cnt = 0,
        mx = 0;
      while (st.length) {
        const j = st.pop();
        const jx = j % N,
          jy = (j / N) | 0;
        sx += jx;
        sy += jy;
        cnt++;
        const dj = Math.max(
          Math.abs(a[j * 4] - base[j * 4]),
          Math.abs(a[j * 4 + 1] - base[j * 4 + 1]),
          Math.abs(a[j * 4 + 2] - base[j * 4 + 2]),
        );
        if (dj > mx) mx = dj;
        for (const [ox, oy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const nx = jx + ox,
            ny = jy + oy;
          if (nx < 0 || ny < 0 || nx >= N || ny >= N) continue;
          const k2 = ny * N + nx;
          if (seen[k2]) continue;
          const dk = Math.max(
            Math.abs(a[k2 * 4] - base[k2 * 4]),
            Math.abs(a[k2 * 4 + 1] - base[k2 * 4 + 1]),
            Math.abs(a[k2 * 4 + 2] - base[k2 * 4 + 2]),
          );
          if (dk > 8) {
            seen[k2] = 1;
            st.push(k2);
          }
        }
      }
      comps.push({ x: (sx / cnt) | 0, y: (sy / cnt) | 0, n: cnt, mx });
    }
    comps.sort((p1, p2) => p2.n - p1.n);
    console.log(
      `   ${eng} worst at 2^${worstK}: ${comps.length} components, biggest` +
        comps
          .slice(0, 6)
          .map((c) => ` ${c.n}px@(${c.x},${N - 1 - c.y}) d${c.mx}`)
          .join(''),
    );
  }
  console.log(`${eng.padEnd(8)} ${draws.slice(0, 30).padEnd(30)} ` + cells.join(''));
}
await browser.close();
srv.close();
console.log(
  '\ncells are pixels differing from the 2^0 frame by more than 8 levels; 0 is scale invariant',
);
