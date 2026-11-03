// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _cpatchSeamVariants — does gating the CPatch soft seam on the depth claim COST A VARIANT?
//
// The gate is a variant define keyed on DRAW STATE (translucency / morph / claim), not on the
// bundle. That is a risky shape of change for this renderer: per-draw variants that each force a
// synchronous link freeze an app on render. So count the compiles
// directly rather than reasoning about them: draw the same bundle opaque, then translucent, then
// alternate, and report variantCompiles after each phase.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEGS = +(process.env.SEGS || 16),
  SIZE = +(process.env.SIZE || 256);
const ring = () => {
  const cx = 64,
    cy = 64,
    r = 44,
    P = [];
  for (let i = 0; i < SEGS; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / SEGS;
    P.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  let d = 'M' + P[0][0].toFixed(4) + ' ' + P[0][1].toFixed(4);
  for (let i = 0; i < SEGS; i++) {
    const p = P[i],
      q = P[(i + 1) % SEGS],
      mx = (p[0] + q[0]) / 2,
      my = (p[1] + q[1]) / 2,
      bx = cx + (mx - cx) * 1.18,
      by = cy + (my - cy) * 1.18;
    d += ' Q' + bx.toFixed(4) + ' ' + by.toFixed(4) + ' ' + q[0].toFixed(4) + ' ' + q[1].toFixed(4);
  }
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path d="' +
    d +
    ' Z" fill="#000000"/></svg>'
  );
};
const PAGE = `<!doctype html><body><canvas id=c width=${SIZE} height=${SIZE}></canvas><script type=module>
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,preserveDrawingBuffer:true,depth:true,stencil:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const r=createRenderer(gl,shaders,{cpatchFill:true});
r.setViewport(${SIZE},${SIZE}); r.setFillEngine({route:'cpatch'});
const b=createBundle(gl,await importSvg(${JSON.stringify(ring())})); r.prepareBundle(b);
if(r.awaitEngine){try{await r.awaitEngine(b,'cpatch',60000);}catch{}}
const vc=()=>r.debugStats.variantCompiles|0;
const paint=(a)=>{r.beginFrame([1,1,1,1]); r.drawBundle(b,a==null?{}:{alpha:a}); r.endFrame();};
const out={};
for(let i=0;i<30;i++) paint(null);           gl.finish(); out.afterOpaque=vc();
for(let i=0;i<30;i++) paint(0.5);            gl.finish(); out.afterTranslucent=vc();
for(let i=0;i<60;i++) paint(i%2?0.5:null);   gl.finish(); out.afterAlternating=vc();
for(let i=0;i<60;i++) paint(i%2?0.5:null);   gl.finish(); out.afterAlternating2=vc();
window.__out=out;
</script>`;
const mime = (p) =>
  /\.(js|mjs)$/.test(p) ? 'text/javascript' : p.endsWith('.glsl') ? 'text/plain' : 'text/html';
const server = http.createServer((q, res) => {
  try {
    const _p = q.url.split('?')[0];
    if (_p === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(PAGE);
      return;
    }
    res.writeHead(200, { 'content-type': mime(_p) + '; charset=utf-8' });
    res.end(readFileSync(path.join(ROOT, decodeURIComponent(_p))));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const args = ['--no-sandbox'];
if (process.env.GPU === '1') args.push('--use-angle=metal', '--enable-gpu');
else args.push('--enable-unsafe-swiftshader');
// HEADLESS EVEN ON THE GPU. Headless Chrome reaches the real GPU: ANGLE (Apple, ANGLE Metal
// Renderer) reports and TIMES the same headless or headful.
// A window is not free to the person running this: macOS CLAMPS --window-position (measured:
// screenX/Y 83,65 whatever you pass), so a headful run cannot be put out of the way and lands
// on whichever desktop is in front.
const br = await launchBrowser({ headless: 'new', args, protocolTimeout: 600000 });
const pg = await br.newPage();
pg.on('pageerror', (e) => console.log('[page-err]', e.message));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 60000 });
await pg.waitForFunction(() => window.__out, { timeout: 300000, polling: 100 });
const o = await pg.evaluate(() => window.__out);
await br.close();
server.close();
console.log('\n  fill-variant compiles, cumulative');
console.log('    after 30 opaque frames        ' + o.afterOpaque);
console.log('    after 30 translucent frames   ' + o.afterTranslucent);
console.log('    after 60 alternating          ' + o.afterAlternating);
console.log(
  '    after 60 more alternating     ' +
    o.afterAlternating2 +
    (o.afterAlternating2 === o.afterAlternating
      ? '   (stable — cached, no per-draw link)'
      : '   *** STILL COMPILING ***'),
);
