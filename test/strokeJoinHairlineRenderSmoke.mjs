// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeJoinHairlineRenderSmoke.mjs — a curved stroke must not crack open at its joins.
//
// If each segment claimed only the half-plane in front of the INCOMING segment's
// perpendicular at a join, and the incoming segment only the half behind its own,
// the two half-planes would tile the plane only when the tangents are parallel: at
// any tangent break the wedge between them is claimed by NEITHER and a hairline runs
// clean across the band. Comparing LB against Slug cannot see it: LB never routes a
// stroke, so both draw the same crack.
//
// The witness is an infinity sign (round joins, four smooth C1 cubic joins per lobe):
// such cracks open at its two lower 45-degree joins, and they get WIDER with stroke
// width.
//
// A crack is a background pixel with ink close by on both sides along both axes.
// Ordinary background fails it (no ink on both sides) and so does a lobe interior
// (too wide). Miter has no such wedge, so it is the control that proves the detector
// is not simply blind.
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { launchBrowser } from './_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const D =
  'M6 16C11 16 13 8 18 8C19.0609 8 20.0783 8.42143 20.8284 9.17157C21.5786 9.92172 22 10.9391 22 12C22 13.0609 21.5786 14.0783 20.8284 14.8284C20.0783 15.5786 19.0609 16 18 16C13 16 11 8 6 8C4.93913 8 3.92172 8.42143 3.17157 9.17157C2.42143 9.92172 2 10.9391 2 12C2 13.0609 2.42143 14.0783 3.17157 14.8284C3.92172 15.5786 4.93913 16 6 16Z';
const svgOf = (join, w) =>
  `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">` +
  `<path d="${D}" stroke="#FA6432" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="${join}"/></svg>`;
const CASES = [
  ['round join, width 2', svgOf('round', 2)],
  ['round join, width 4', svgOf('round', 4)],
  ['bevel join, width 2', svgOf('bevel', 2)],
  ['miter join, width 2 (control)', svgOf('miter', 2)],
];
const N = 512;
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const N=${N}; const r=createRenderer(gl,shaders,{});
window.__run=async(cases)=>{ const out=[];
  for(const [name,svg] of cases){
    const sec=await importSvg(svg,{preserveViewport:true}); const b=createBundle(gl,sec);
    if(r.prepareBundle) r.prepareBundle(b);
    if(r.awaitLbReady) await r.awaitLbReady(b);
    r.setViewport(N,N); gl.viewport(0,0,N,N);
    r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame();
    const p=new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,p);
    const lum=(i)=>(p[i*4]+p[i*4+1]+p[i*4+2])/3;
    const REACH=Math.max(2,Math.round(N/64));
    let cracks=0, ink=0;
    for(let i=0;i<N*N;i++) if(lum(i)<200) ink++;
    for(let y=1;y<N-1;y++) for(let x=1;x<N-1;x++){
      if(lum(y*N+x)<=245) continue;
      let l=false,rr=false,u=false,d2=false;
      for(let k=1;k<=REACH;k++){ if(lum(y*N+x-k)<200) l=true; if(lum(y*N+x+k)<200) rr=true;
                                 if(lum((y-k)*N+x)<200) u=true; if(lum((y+k)*N+x)<200) d2=true; }
      if(l&&rr&&u&&d2) cracks++;
    }
    b.dispose(); out.push({name, cracks, ink});
  } return out; };
window.__ready=true;
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
const br = await launchBrowser({ headless: 'new', args: ['--no-sandbox'] });
const pg = await br.newPage();
const errs = [];
pg.on('pageerror', (e) => errs.push(String(e.message)));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 90000 });
let o = null;
try {
  await pg.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 50 });
  o = await pg.evaluate((c) => window.__run(c), CASES);
} catch (e) {
  console.log('FAIL page never ran: ' + (errs.join(' | ') || e.message));
}
await br.close();
server.close();
if (!o) {
  console.log('STROKE-JOIN-HAIRLINE FAIL');
  process.exit(1);
}
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
for (const r of o) {
  ok(r.ink > 1000, `${r.name}: rendered (ink ${r.ink})`);
  ok(r.cracks === 0, `${r.name}: no hairline cracks at the joins (got ${r.cracks})`);
}
console.log(fail ? `\nSTROKE-JOIN-HAIRLINE FAIL (${fail})` : '\nSTROKE-JOIN-HAIRLINE PASS');
process.exit(fail ? 1 : 0);
