// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Does a COLRv1 text bundle reach the unified fill route, and is it SERVED?
//
// The colr-graph decline reads 0 across every COLR smoke, which looks like "inert" —
// but those smokes drive mantleDemo.html, whose path never routes, so the counter
// cannot be anything else there. Built as a real createTextBundle and drawn with the
// analytic fill on, the gate decides:
//
//   gate colr-graph, colrDeclines 8, unifiedFillDraws 0, ink 15876
//   gate on,         colrDeclines 0, lbRoute 5,          ink 15876
//
// Same pixels; with the gate on, ONE COLR glyph does not take the whole bundle off
// the route with it. Writes its font fixture to examples/ and cleans up.
//
// The colr-graph decline in unifiedFillDraw has always read 0 across the COLR
// smokes, but those never drew through drawBundle with LB on — so "inert" could
// equally mean "never routed". This builds a real COLRv1 bundle, draws it with the
// analytic fill ON, and reports the gate.
import http from 'http';
import path from 'path';
import { readFileSync, writeFileSync } from 'fs';
import { launchBrowser } from '../test/_launch.mjs';
import { buildColrTestFont } from '../test/font/_colrFontFixture.mjs';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TMP = path.join(ROOT, 'examples', '_colrProbe.ttf');
writeFileSync(TMP, Buffer.from(buildColrTestFont({ codepoint: 0x41, colrV1Rich: true })));
const S = 128;
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${S}" height="${S}"></canvas>
<script type="module">
import { createRenderer, loadShaders, createTextBundle, MantleFontAsset } from '/src/index.js';
const S=${S};
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const bytes=new Uint8Array(await (await fetch('/examples/_colrProbe.ttf')).arrayBuffer());
const font=new MantleFontAsset(bytes);
const r=createRenderer(gl,shaders); r.setViewport(S,S); r.setLoopBlinnFill('on');
const tb=await createTextBundle(gl,{font, text:'A', style:{fontSize:64, fill:[1,0,0,1]}});
const b=tb.bundle||tb;
try{ r.prepareBundle(b); }catch(e){}
if(r.awaitLbReady){try{await r.awaitLbReady(b,8000);}catch{}}
const frame=()=>{ r.beginFrame([0,0,0,1]); r.drawBundle(b,{}); r.endFrame(); };
for(let i=0;i<4;i++){ frame(); if(r.precompileFills){try{r.precompileFills();}catch{}} }
frame();
const px=new Uint8Array(S*S*4); gl.readPixels(0,0,S,S,gl.RGBA,gl.UNSIGNED_BYTE,px);
let ink=0; for(let i=0;i<S*S;i++){const o=i*4; if(px[o]>8||px[o+1]>8||px[o+2]>8) ink++;}
const st=r.debugStats;
window.out={ ink, gate: st.unifiedFillGate||'none', uni: st.unifiedFillDraws|0,
  colrDeclines: st.unifiedColrDeclines|0, lbRoute: st.loopBlinnRouteCount|0,
  colrGraphs: Array.isArray(b.colrGraphs)?b.colrGraphs.length:-1,
  meshes: Array.isArray(b._lbMeshes)?b._lbMeshes.filter(m=>m&&!m.slug&&m.vertexCount>0).length:-1,
  dlColr: (b.drawList||[]).filter(o=>o.colrGraphId).length, dl:(b.drawList||[]).length };
</script></body></html>`;
const mime = (p) =>
  /\.(js|mjs)$/.test(p)
    ? 'text/javascript'
    : p.endsWith('.glsl')
      ? 'text/plain'
      : p.endsWith('.ttf')
        ? 'font/ttf'
        : 'text/html';
const server = http.createServer((q, res) => {
  const u = new URL(q.url, 'http://l');
  if (u.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(HTML);
    return;
  }
  try {
    const buf = readFileSync(path.join(ROOT, decodeURIComponent(u.pathname)));
    const ct = mime(u.pathname);
    res.writeHead(200, { 'content-type': ct === 'font/ttf' ? ct : ct + '; charset=utf-8' });
    res.end(buf);
  } catch {
    try {
      res.writeHead(404);
    } catch {}
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const br = await launchBrowser({
  headless: 'new',
  args: ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
  protocolTimeout: 120000,
});
const pg = await br.newPage();
pg.on('pageerror', (e) => console.log('[page-err]', e.message, '\n', e.stack));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 30000 });
try {
  await pg.waitForFunction('typeof window.out!=="undefined"', { timeout: 90000 });
} catch {
  console.log('never finished');
  await br.close();
  server.close();
  process.exit(1);
}
console.log(JSON.stringify(await pg.evaluate(() => window.out)));
try {
  (await import('fs')).unlinkSync(TMP);
} catch {}
await br.close();
server.close();
