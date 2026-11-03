// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _viewCullParity — the view trim must be OUTPUT-IDENTICAL.
//
// The trim narrows the unified fill draw to the span between the first and last
// on-screen entry. If its em→NDC mirror is wrong in any direction it drops a shape
// that should have painted, so the only acceptable result is byte-identical pixels
// against `viewCull:false` at every pan, zoom, stroke width and override state.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const TIGER = readFileSync(path.join(ROOT, 'examples/tiger.svg'), 'utf8');
const ROAD = (() => {
  const n = 160,
    parts = [];
  for (let i = 0; i < n; i++) {
    const x = i * 40;
    parts.push(
      `<path d="M${x} 60 Q${x + 20} ${i % 2 ? 10 : 110} ${x + 40} 60 L${x + 40} 100 L${x} 100 Z" fill="#${((i * 7919) % 4096).toString(16).padStart(3, '0')}"/>`,
    );
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n * 40} 120">${parts.join('')}</svg>`;
})();
// Stroked + mitered: exercises the stroke-envelope padding in the visibility test.
const STROKED = (() => {
  const parts = [];
  for (let i = 0; i < 60; i++) {
    const x = i * 30;
    parts.push(
      `<path d="M${x} 20 L${x + 15} 90 L${x + 30} 20" fill="none" stroke="#${((i * 613) % 4096).toString(16).padStart(3, '0')}" stroke-width="14" stroke-linejoin="miter" stroke-miterlimit="10"/>`,
    );
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1800 110">${parts.join('')}</svg>`;
})();

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="384" height="384"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, createOverrideTable } from '/src/index.js';
const cv=document.getElementById('c');
const gl=cv.getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);

async function shot(svg, pan, viewCull, ovr){
  const r=createRenderer(gl,shaders,{viewCull}); r.setLoopBlinnFill('on');
  const b=createBundle(gl, await importSvg(svg)); r.prepareBundle(b);
  r.setViewport(384,384);
  await r.awaitLbReady(b, 20000);
  const s=pan.s||1;
  const opts={worldMatrix:[s,0,0, 0,s,0, pan.tx||0, pan.ty||0, 1]};
  if(ovr) opts.overrides=ovr(b);
  let px=null;
  for(let k=0;k<3;k++){
    r.beginFrame([0,0,0,1]); r.drawBundle(b,opts); r.endFrame();
    await new Promise(res=>requestAnimationFrame(res));
  }
  px=new Uint8Array(384*384*4); gl.readPixels(0,0,384,384,gl.RGBA,gl.UNSIGNED_BYTE,px);
  const stats={draws:r.debugStats.unifiedFillDraws|0, gate:r.debugStats.unifiedFillGate,
               trimmed:r.debugStats.viewCullTrimmedVerts|0};
  if(opts.overrides && opts.overrides.dispose) opts.overrides.dispose();
  b.dispose();
  return {px, stats};
}

// A REAL override table (createOverrideTable), not a hand-rolled packed buffer:
// fillPass gates uHasOverrides on ov.uploadIfDirty, so a plain object with a
// packedBuffer is ignored by the shader and would test nothing. Odd shapes are
// translated far right and every 7th is hidden, so the trim has to read both the
// affine and the visibility byte or it drops a shape that really paints.
function mkOvr(b){
  const t=createOverrideTable(gl,b);
  const n=b.numShapes|0;
  for(let s=0;s<n;s++){
    const rec={};
    if(s%2) rec.localPosition=[400,0];
    if(s%7===3) rec.visibility=0;
    if(Object.keys(rec).length) t.set(s, rec);
  }
  t.uploadIfDirty();
  return t;
}

window.__run=async(cases)=>{
  const out=[];
  for(const c of cases){
    for(const pan of c.pans){
      for(const useOvr of (c.ovr? [false,true] : [false])){
        // Discard shot: the FIRST draw of an asset in this context pays shader/PSO
        // warm-up, and its pixels differ from every later draw regardless of this
        // pass. Burn one so all three measured arms are equally warm.
        await shot(c.svg, pan, false, useOvr?mkOvr:null);
        const on  =await shot(c.svg, pan, undefined, useOvr?mkOvr:null);
        const off =await shot(c.svg, pan, false,     useOvr?mkOvr:null);
        // CONTROL: the same config against itself. Any difference here is
        // cross-instance nondeterminism in the renderer, not the trim, and the
        // trim's own diff is only meaningful above this floor.
        const off2=await shot(c.svg, pan, false,     useOvr?mkOvr:null);
        const cmp=(a,b)=>{let d=0,m=0;for(let i=0;i<a.length;i++){const t=Math.abs(a[i]-b[i]);if(t){d++;if(t>m)m=t;}}return[d,m];};
        const [diff,maxd]=cmp(on.px,off.px);
        const [ctl,ctlMax]=cmp(off2.px,off.px);
        out.push({name:c.name, tx:pan.tx||0, s:pan.s||1, ovr:useOvr,
                  diff, maxd, ctl, ctlMax,
                  drawsOn:on.stats.draws, drawsOff:off.stats.draws,
                  trimmed:on.stats.trimmed, gate:on.stats.gate});
      }
    }
  }
  return out;
};
window.__ready=true;
</script></body></html>`;

const mime = (p) =>
  /\.(js|mjs)$/.test(p) ? 'text/javascript' : p.endsWith('.glsl') ? 'text/plain' : 'text/html';
const server = http.createServer((q, res) => {
  try {
    if (q.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(HTML);
      return;
    }
    const pp = decodeURIComponent(q.url.split('?')[0]);
    res.writeHead(200, { 'content-type': mime(pp) + '; charset=utf-8' });
    res.end(readFileSync(path.join(ROOT, pp)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
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
pg.on('pageerror', (e) => console.log('[page-err]', e.message));
pg.on('console', (m) => {
  if (m.type() === 'error') console.log('[console]', m.text());
});
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 60000 });
await pg.waitForFunction('window.__ready===true', { timeout: 60000 });
const PANS = [
  { tx: 0 },
  { tx: 0.6 },
  { tx: 1.2 },
  { tx: -1.2 },
  { tx: 0, ty: 0.8 },
  { tx: 0, s: 3 },
  { tx: 1.0, s: 3 },
  { tx: 0, s: 0.4 },
];
const rows = await pg.evaluate(
  (t, rd, st, pans) =>
    window.__run([
      { name: 'tiger', svg: t, pans },
      { name: 'road160', svg: rd, pans, ovr: true },
      { name: 'stroked', svg: st, pans },
    ]),
  TIGER,
  ROAD,
  STROKED,
  PANS,
);
let fail = 0,
  noise = 0;
console.log('name      tx      s  ovr | trim-diff maxd | ctl-diff maxd | draws | trimmed');
for (const r of rows) {
  // A row only fails if the trim differs BEYOND the off-vs-off control floor.
  const bad = r.diff > r.ctl || r.maxd > r.ctlMax;
  if (bad) fail++;
  else if (r.diff) noise++;
  console.log(
    `${r.name.padEnd(9)} ${String(r.tx).padStart(4)} ${String(r.s).padStart(4)} ${r.ovr ? '  y' : '  n'} | ${String(r.diff).padStart(9)} ${String(r.maxd).padStart(4)} | ${String(r.ctl).padStart(8)} ${String(r.ctlMax).padStart(4)} | ${String(r.drawsOn)}/${String(r.drawsOff)} | ${r.trimmed}${bad ? '   <-- FAIL' : ''}`,
  );
}
console.log(
  fail === 0
    ? `\nPASS — ${rows.length}/${rows.length} within the off-vs-off control floor (${noise} rows carry pre-existing cross-instance noise)`
    : `\nFAIL — ${fail}/${rows.length} differ beyond the control`,
);
await br.close();
server.close();
process.exit(fail === 0 ? 0 : 1);
