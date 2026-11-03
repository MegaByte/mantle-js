// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _cpatchComposedPath — a filtered CPatch bundle draws through a program that has no CPatch kernel.
//
// With a filter attached (see _cpatchUnifiedIntegrity), unifiedFillDraws is 0 and the engine
// ledger records nothing, yet pixels appear. The composed path (clip/mask/filter over a static
// fill) does not use the ubershader -- it binds R.lbProg / R.lbProgLean, built from loopBlinn.frag
// and compiled WITHOUT MANTLE_CPATCH. A kind-14 vertex arriving there has no kernel to shade it.
//
// So: does a CPatch bundle actually reach it, and if so what does it paint? Compared against the
// same drawing with the CPatch route off, which is the picture the filter is supposed to produce.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const poly = (cx, cy, r, n) => {
  const p = [];
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    p.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return (
    'M' + p.map((q, i) => (i ? 'L' : '') + q[0].toFixed(3) + ' ' + q[1].toFixed(3)).join(' ') + ' Z'
  );
};
const svg = (b) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">${b}</svg>`;
const CASES = {
  filter: svg(
    `<defs><filter id="f"><feGaussianBlur stdDeviation="1.2"/></filter></defs>` +
      `<path d="${poly(64, 64, 42, 16)}" fill="#265b9b" filter="url(#f)"/>`,
  ),
  mask: svg(
    `<defs><mask id="m"><rect x="0" y="0" width="128" height="70" fill="#fff"/></mask></defs>` +
      `<path d="${poly(64, 64, 42, 16)}" fill="#265b9b" mask="url(#m)"/>`,
  ),
};
const HTML = `<!doctype html><html><body><script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const CASES=${JSON.stringify(CASES)};
const shot=async(SVG,route)=>{
  const c=document.createElement('canvas');c.width=256;c.height=256;document.body.appendChild(c);
  const gl=c.getContext('webgl2',{antialias:false,preserveDrawingBuffer:true,depth:true,stencil:true});
  const r=createRenderer(gl,shaders,{precompileFillsBudgetMs:5000}); await r.ready;
  r.setViewport(256,256); r.setFillEngine({route, kernel:'slug'});
  const b=createBundle(gl,await importSvg(SVG,{}));
  if(r.awaitEngine) await r.awaitEngine(b,route==='cpatch'?'cpatch':'slug',30000);
  for(let i=0;i<4;i++){ r.beginFrame([0,0,0,1]); r.drawBundle(b,{}); r.endFrame(); }
  const px=new Uint8Array(256*256*4); gl.readPixels(0,0,256,256,gl.RGBA,gl.UNSIGNED_BYTE,px);
  const E=r.debugStats.engines||{draws:{}};
  return {px:Array.from(px), built:b._cpatchBuilt|0, uni:r.debugStats.unifiedFillDraws|0,
          drew:Object.entries(E.draws||{}).map(([k,v])=>k+':'+v).join(' ')||'-'};
};
window.__run=async()=>{
  const out=[];
  for (const [name,SVG] of Object.entries(CASES)) {
    const cp=await shot(SVG,'cpatch'), sl=await shot(SVG,'none');
    let diff=0, maxd=0, inkC=0, inkS=0;
    for(let i=0;i<cp.px.length;i+=4){
      const a=cp.px[i]+cp.px[i+1]+cp.px[i+2], b2=sl.px[i]+sl.px[i+1]+sl.px[i+2];
      if(a) inkC++; if(b2) inkS++;
      const d=Math.max(Math.abs(cp.px[i]-sl.px[i]),Math.abs(cp.px[i+1]-sl.px[i+1]),Math.abs(cp.px[i+2]-sl.px[i+2]));
      if(d>8) diff++; if(d>maxd) maxd=d;
    }
    out.push({name, built:cp.built, uniC:cp.uni, drewC:cp.drew, inkC, inkS, diff, maxd});
  }
  return out;
};
window.__ready=1;
</script></body></html>`;
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
// HEADLESS EVEN ON THE GPU. Headless Chrome reaches the real GPU: ANGLE (Apple, ANGLE Metal
// Renderer) reports and TIMES the same headless or headful.
// A window is not free to the person running this: macOS CLAMPS --window-position (measured:
// screenX/Y 83,65 whatever you pass), so a headful run cannot be put out of the way and lands
// on whichever desktop is in front.
const br = await launchBrowser(
  process.env.GPU === '1'
    ? { headless: 'new', args: ['--no-sandbox', '--use-angle=metal', '--enable-gpu'] }
    : { headless: 'new', args: ['--no-sandbox'] },
);
const pg = await br.newPage();
pg.on('pageerror', (e) => console.error(' [err]', String(e.message).slice(0, 200)));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 90000 });
await pg.waitForFunction(() => window.__ready === 1, { timeout: 120000, polling: 50 });
const rows = await pg.evaluate(() => window.__run());
await br.close();
server.close();
console.log(
  '\n  case    patches  unifiedDraws  engines     ink(cpatch)  ink(slug)  diff>8  maxDiff',
);
let bad = 0;
for (const r of rows) {
  console.log(
    '  ' +
      r.name.padEnd(8) +
      String(r.built).padStart(5) +
      String(r.uniC).padStart(13) +
      '   ' +
      r.drewC.padEnd(12) +
      String(r.inkC).padStart(9) +
      String(r.inkS).padStart(11) +
      String(r.diff).padStart(8) +
      String(r.maxd).padStart(9),
  );
  if (r.diff > 200) {
    console.log('    WRONG: the CPatch route paints a different picture here');
    bad++;
  }
}
console.log(
  '\n  ' +
    (bad ? 'COMPOSED-PATH FAIL (' + bad + ')' : 'COMPOSED-PATH OK — same picture either way'),
);
process.exit(bad ? 1 : 0);
