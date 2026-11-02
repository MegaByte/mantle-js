// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzLbEvenOdd — does Loop-Blinn honour the fill rule? Rendered against Slug, which does.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = +(process.env.N || 384);
const SVG = readFileSync(process.env.SVG || '../fixtures/svg/_sqcirc.svg', 'utf8')
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
  const shot=async(opts,lb)=>{
    const r=createRenderer(gl,shaders,opts);
    if (lb!=null && r.setLoopBlinnFill) r.setLoopBlinnFill(lb);
    const b=createBundle(gl,sec);
    if (r.prepareBundle) r.prepareBundle(b);
    if (r.awaitLbReady) await r.awaitLbReady(b);
    r.setViewport(N,N); gl.viewport(0,0,N,N);
    r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame();
    const p=new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,p);
    const d=(r.debugStats&&r.debugStats.engines&&r.debugStats.engines.draws)||{};
    b.dispose();
    let t=''; for(let i=0;i<p.length;i+=4096) t+=String.fromCharCode.apply(null,p.subarray(i,i+4096));
    return {px:btoa(t), draws:JSON.stringify(d)};
  };
  const lb=await shot({}, 'on');
  const sl=await shot({}, 'off');
  return {lb,sl};
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
const LB = Buffer.from(out.lb.px, 'base64'),
  SL = Buffer.from(out.sl.px, 'base64');
let diff = 0,
  worst = 0;
for (let i = 0; i < N * N; i++) {
  const d = Math.max(
    Math.abs(LB[i * 4] - SL[i * 4]),
    Math.abs(LB[i * 4 + 1] - SL[i * 4 + 1]),
    Math.abs(LB[i * 4 + 2] - SL[i * 4 + 2]),
  );
  if (d > 64) diff++;
  if (d > worst) worst = d;
}
const at = (P, fx, fy) => {
  const i = (((fy * N) | 0) * N + ((fx * N) | 0)) * 4;
  return `${P[i]},${P[i + 1]},${P[i + 2]}`;
};
console.log(`LB draws ${out.lb.draws}, Slug draws ${out.sl.draws}`);
console.log(`  LB vs Slug: ${diff} px over 64 (worst ${worst}) of ${N * N}`);
console.log(`  center  LB ${at(LB, 0.5, 0.5)}   Slug ${at(SL, 0.5, 0.5)}`);
console.log(`  ring    LB ${at(LB, 0.18, 0.5)}   Slug ${at(SL, 0.18, 0.5)}`);
