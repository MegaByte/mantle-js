// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _engineDataSize — how much DEVICE MEMORY each fill engine's data costs for the
// same asset. Draw speed has been priced repeatedly; this is the other axis, and
// it is the one that decides what can ship to a phone.
//
//   Slug   : the curve plane + the band plane, both uploaded as RGBA32F
//   LB     : the packed triangle mesh (stride 24 floats)
//   CPatch : curve texels + its own stride-24 mesh (measured separately in
//            _cpatchDataSize; reported here for the same bundle)
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = (process.env.FILES || 'examples/tiger.svg').split(',');
const SRC = {};
for (const f of FILES) {
  try {
    SRC[path.basename(f)] = readFileSync(path.isAbsolute(f) ? f : path.join(ROOT, f), 'utf8');
  } catch {
    console.error('skip', f);
  }
}
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="512" height="512"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
// Two renderers: the default (per-curve coefficient TEXTURE on) and one with it
// off. The difference in the uploaded stream IS the coefficient block the texture
// removes from every vertex — measured, rather than read off a counter that lives
// on the internal context and not the facade.
const r=createRenderer(gl,shaders,{});
const rWide=createRenderer(gl,shaders,{unifiedFillCurveTex:false});
window.__run=async(src)=>{
  const out=[];
  for(const [name,svg] of Object.entries(src)){
    const sec=await importSvg(svg,{preserveViewport:true});
    // WIDE arm first, so its numbers are not perturbed by the narrow arm's caches.
    let wideStream=0;
    { const bw=createBundle(gl,sec);
      if(rWide.prepareBundle) rWide.prepareBundle(bw);
      if(rWide.awaitLbReady) await rWide.awaitLbReady(bw);
      rWide.setViewport(512,512); gl.viewport(0,0,512,512);
      rWide.beginFrame([1,1,1,1]); rWide.drawBundle(bw); rWide.endFrame();
      const q=new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,q);
      wideStream=(rWide.debugStats.unifiedStreamBytesFreed|0);
      bw.dispose(); }
    const b=createBundle(gl,sec);
    if(r.prepareBundle) r.prepareBundle(b);
    if(r.awaitLbReady) await r.awaitLbReady(b);
    r.setViewport(512,512); gl.viewport(0,0,512,512);
    r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame();
    const p=new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p);
    const f4=(a)=>a?a.length*4:0;
    // Slug's resident planes.
    const curveB=f4(b.curveFloats), bandB=f4(b.bandFloats||b.bandData||null), metaB=f4(b.metaFloats);
    // LB's meshes.
    let lbB=0, lbVerts=0, lbShapes=0, slugShapes=0;
    for(const m of (b._lbMeshes||[])){
      if(!m) continue;
      if(m.slug){ slugShapes++; continue; }
      if(!m.verts) continue;
      lbShapes++; lbVerts+=m.vertexCount|0; lbB+=m.verts.length*4;
    }
    // WHAT IS ACTUALLY RESIDENT for the unified draw, as opposed to the per-shape
    // STAGING meshes in _lbMeshes. The unified route builds a narrower stream (the
    // per-curve coefficients live in their own texture) and frees the CPU copy, so
    // _lbMeshes bytes overstate what the GPU holds.
    // BAND MEMBERSHIP DUPLICATION. Each entry is 2 floats (loc, break) and two
    // entries share a texel, so per-entry overhead is already minimal — the plane's
    // size is how many BANDS each segment is listed in, which trades directly
    // against walk length. Counting it says whether there is anything left to win.
    const bandTexels=(b.bandFloats?b.bandFloats.length:0)/4;
    const bandEntries=bandTexels*2;
    let segCount=0;
    { const cf=b.curveFloats; if(cf){ let h=0;
        while(h+4<=cf.length){ const t=(cf[h]|0)&3; segCount++;
          h += (t===0) ? 12 : 16; } } }
    const st=r.debugStats||{};
    const uniStream=(st.unifiedStreamBytesFreed|0), uniCoef=(r._uniCoefBytes|0);
    out.push({name, curveB, bandB, metaB, lbB, lbVerts, lbShapes, slugShapes,
              uniStream, uniCoef, wideStream, bandEntries, segCount,
              shapes:(b._lbMeshes||[]).length});
    b.dispose();
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
const br = await launchBrowser({ headless: 'new', args: ['--no-sandbox'] });
const pg = await br.newPage();
pg.on('pageerror', (e) => console.error(' [err]', String(e.message).slice(0, 200)));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 90000 });
await pg.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 50 });
const o = await pg.evaluate((s) => window.__run(s), SRC);
await br.close();
server.close();
const KB = (b) => (b / 1024).toFixed(1);
console.log('\nresident data per engine, same bundle\n');
console.log(
  '  asset            |  svg KB | SLUG curve+band |    LB mesh | LB verts | shapes (lb/slug)',
);
for (const r of o) {
  const svgKB = Buffer.byteLength(SRC[r.name]) / 1024;
  console.log(
    `  ${r.name.padEnd(16)} | ${svgKB.toFixed(1).padStart(7)} | ${(KB(r.curveB) + '+' + KB(r.bandB)).padStart(15)} | ${KB(r.lbB).padStart(10)} | ${String(r.lbVerts).padStart(8)} | ${r.lbShapes}/${r.slugShapes} of ${r.shapes}`,
  );
  console.log(
    `  ${''.padEnd(16)} |         | slug planes ${KB(r.curveB + r.bandB)}KB = ${((r.curveB + r.bandB) / 1024 / svgKB).toFixed(1)}x svg`,
  );
  console.log(
    `  ${''.padEnd(16)} |         | band plane: ${r.bandEntries} entries for ~${r.segCount} segs = ${(r.bandEntries / Math.max(r.segCount, 1)).toFixed(1)} bands/seg (2 floats each, 2 per texel)`,
  );
  console.log(`  ${''.padEnd(16)} |         | LB staging (_lbMeshes, stride 24) ${KB(r.lbB)}KB`);
  console.log(
    `  ${''.padEnd(16)} |         | LB stream WIDE (coeffs in the vertex) ${KB(r.wideStream)}KB`,
  );
  console.log(
    `  ${''.padEnd(16)} |         | LB stream NARROW (coeff texture, DEFAULT) ${KB(r.uniStream)}KB  ->  ${(r.wideStream / Math.max(r.uniStream, 1)).toFixed(2)}x smaller, ${(r.uniStream / 1024 / svgKB).toFixed(1)}x svg`,
  );
}
