// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// REPRO for a PRE-EXISTING blank render (lbTransformOverrideParitySmoke's reference).
//
// A bundle drawn through Slug WITH an override table renders nothing — but only
// after Loop-Blinn has prepared it and then been switched off. The three cells
// below isolate that:
//
//   offFirst             LB off from the start, no overrides        -> 6560 ink
//   preparedThenOff      prepared + awaited, LB off, no overrides   -> 6560 ink
//   preparedThenOff_ovr  prepared + awaited, LB off, WITH overrides ->    0 ink
//
// So neither the override table alone nor the prepare alone does it; it needs a
// bundle carrying built LB meshes drawn through the Slug path with overrides.
//
// NOT caused by the unified-route work — it reproduces with those changes stashed,
// and it is why lbTransformOverrideParitySmoke reports its 999 sentinel: the test's
// SLUG REFERENCE is blank, so no pixel is ink in both images and its parity ratio
// has no denominator. The mechanism is not yet found. Ruled out: the opaque
// prepass (already gated on !d.overrides), and the LB_FILL variant being bound for
// a cover-quad draw (debugStats.fillVariantKey is STALE here — it is set by the
// readiness check, which never runs with LB off, so it reports the warm's variant).
import http from 'http';
import path from 'path';
import { readFileSync } from 'fs';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SVG = readFileSync(
  path.join(ROOT, 'examples/smoke/lbTransformOverrideParity__SVG.svg'),
  'utf8',
);
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="200" height="200"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, createOverrideTable } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const sec=await importSvg(${JSON.stringify(SVG)});
const ink=()=>{const p=new Uint8Array(200*200*4); gl.readPixels(0,0,200,200,gl.RGBA,gl.UNSIGNED_BYTE,p);
  let n=0; for(let i=0;i<200*200;i++){const o=i*4; if(p[o]>20||p[o+1]>20||p[o+2]>20)n++;} return n;};
const shot=async (mkOvr, pass, lbFirst)=>{
  const r=createRenderer(gl,shaders);
  if(!lbFirst) r.setLoopBlinnFill('off');
  const b=createBundle(gl,sec); try{r.prepareBundle(b);}catch{}
  if(lbFirst===1){ r.setLoopBlinnFill(false); }                                  // prepare only
  if(lbFirst===2){ if(r.awaitLbReady){try{await r.awaitLbReady(b);}catch{}} r.setLoopBlinnFill(false); }
  if(lbFirst===3){ if(r.awaitLbReady){try{await r.awaitLbReady(b);}catch{}} }      // leave LB ON
  const o=mkOvr?createOverrideTable(gl,b):null;
  r.setViewport(200,200); r.beginFrame([0,0,0,1]); r.drawBundle(b, pass&&o?{overrides:o}:{}); r.endFrame();
  const st=r.debugStats||{};
  const n=ink(); const info={ink:n, lb:st.loopBlinnRouteCount|0, uni:st.unifiedFillDraws|0,
    gate:st.unifiedFillGate||'?', engine:st.autoEngine||'?', variant:st.fillVariantKey||''};
  try{b.dispose();}catch{} return info;
};
window.out={ await_noTable: await shot(false,false,2),
             await_tableUnused: await shot(true,false,2),
             await_tablePassed: await shot(true,true,2) };
</script></body></html>`;
const mime = (p) =>
  /\.(js|mjs)$/.test(p) ? 'text/javascript' : p.endsWith('.glsl') ? 'text/plain' : 'text/html';
const server = http.createServer((q, res) => {
  const u = new URL(q.url, 'http://l');
  if (u.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(HTML);
    return;
  }
  try {
    res.writeHead(200, { 'content-type': mime(u.pathname) + '; charset=utf-8' });
    res.end(readFileSync(path.join(ROOT, decodeURIComponent(u.pathname))));
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
  protocolTimeout: 300000,
});
const pg = await br.newPage();
pg.on('pageerror', (e) => console.log('[err]', e.message));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 30000 });
try {
  await pg.waitForFunction('typeof window.out!=="undefined"', { timeout: 120000 });
} catch {
  console.log('never finished');
  await br.close();
  server.close();
  process.exit(1);
}
console.log(JSON.stringify(await pg.evaluate(() => window.out)));
await br.close();
server.close();
