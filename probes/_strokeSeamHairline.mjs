// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _strokeSeamHairline — count HAIRLINE cracks inside a stroke band.
//
// A crack is a background pixel with ink close by on both sides along one axis:
// a thin gap the band should have covered. Ordinary background fails the test
// (no ink on both sides) and so does the interior of a lobe (too wide).
//
// An infinity sign drawn as two lobes shows two, at the joins
// (3.17,14.83) and (20.83,14.83) — the LOWER 45-degree point of each lobe —
// while the mirrored upper joins at y=9.17 are clean. Sweeps size and linejoin
// to separate "the join maths is wrong" from "the band is a hair too narrow".
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const D =
  'M6 16C11 16 13 8 18 8C19.0609 8 20.0783 8.42143 20.8284 9.17157C21.5786 9.92172 22 10.9391 22 12C22 13.0609 21.5786 14.0783 20.8284 14.8284C20.0783 15.5786 19.0609 16 18 16C13 16 11 8 6 8C4.93913 8 3.92172 8.42143 3.17157 9.17157C2.42143 9.92172 2 10.9391 2 12C2 13.0609 2.42143 14.0783 3.17157 14.8284C3.92172 15.5786 4.93913 16 6 16Z';
const svgOf = (join, cap, w) =>
  `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">` +
  `<path d="${D}" stroke="#FA6432" stroke-width="${w}" stroke-linecap="${cap}" stroke-linejoin="${join}"/></svg>`;
const SIZES = (process.env.SIZES || '128,256,512,1024').split(',').map(Number);
const VARIANTS = [
  ['round join / round cap', svgOf('round', 'round', 2)],
  ['miter join', svgOf('miter', 'round', 2)],
  ['bevel join', svgOf('bevel', 'round', 2)],
  ['butt cap, round join', svgOf('round', 'butt', 2)],
  ['width 4, round join', svgOf('round', 'round', 4)],
];
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="1024" height="1024"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const cv=document.getElementById('c');
const gl=cv.getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const r=createRenderer(gl,shaders,{});
window.__run=async(variants,sizes)=>{
  const out=[];
  for(const [name,svg] of variants){
    const row={name, per:{}};
    for(const N of sizes){
      const sec=await importSvg(svg,{preserveViewport:true});
      const b=createBundle(gl,sec);
      if(r.prepareBundle) r.prepareBundle(b);
      if(r.awaitLbReady) await r.awaitLbReady(b);
      r.setViewport(N,N); gl.viewport(0,0,N,N);
      r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame();
      const p=new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,p);
      const lum=(i)=>(p[i*4]+p[i*4+1]+p[i*4+2])/3;
      const isBg=(x,y)=> lum(y*N+x) > 245;
      const isInk=(x,y)=> lum(y*N+x) < 200;
      // Reach scales with the band: a crack is thin relative to stroke width.
      const REACH=Math.max(2,Math.round(N/64));
      let cracks=0; const pts=[];
      for(let y=1;y<N-1;y++) for(let x=1;x<N-1;x++){
        if(!isBg(x,y)) continue;
        let l=false,rr=false,u=false,d2=false;
        for(let k=1;k<=REACH;k++){ if(isInk(x-k,y)) l=true; if(isInk(x+k,y)) rr=true; }
        for(let k=1;k<=REACH;k++){ if(isInk(x,y-k)) u=true; if(isInk(x,y+k)) d2=true; }
        if((l&&rr)&&(u&&d2)){ cracks++; if(pts.length<6) pts.push([x, N-1-y]); }
      }
      row.per[N]={cracks, pts};
      b.dispose();
    }
    out.push(row);
  }
  return out;
};
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
await pg.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 50 });
const o = await pg.evaluate((v, s) => window.__run(v, s), VARIANTS, SIZES);
await br.close();
server.close();
console.log(
  '\nHAIRLINE CRACKS inside the stroke band (background px with ink on both sides, both axes)\n',
);
console.log('  variant                   | ' + SIZES.map((s) => String(s).padStart(7)).join(' | '));
for (const row of o) {
  console.log(
    `  ${row.name.padEnd(25)} | ` +
      SIZES.map((s) => String(row.per[s].cracks).padStart(7)).join(' | '),
  );
}
const first = o[0].per[SIZES[SIZES.length - 1]];
if (first && first.pts.length)
  console.log(
    '\n  sample crack px at N=' +
      SIZES[SIZES.length - 1] +
      ': ' +
      first.pts.map((p) => `(${p[0]},${p[1]})`).join(' '),
  );
