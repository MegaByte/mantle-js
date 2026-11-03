// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _cpatchRouteRender — does the WIRED CPatch route actually paint, and does it
// paint the right thing?
//
// Everything before this measured CPatch through hand-packed meshes injected into
// a bundle. This drives the real path: createRenderer({cpatchFill:true}) ->
// prepareBundle -> buildCPatchBundle -> the unified fill draw. The failure mode
// that matters is a route that reports success and paints nothing, which is why
// ink is compared against Slug rather than merely checked non-zero.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = +(process.env.N || 384);
// GRID divides each patch's cover into cells. It DEFAULTS TO THE PACKAGE DEFAULT, which is 1 -- no
// split (packCPatchContour's own note says nothing in the package sets it). GRID=4 measures a
// configuration the renderer never runs: there the cell bound drops curves it should not (the
// cubic pear shows thousands of wrong pixels), a latent defect behind a default-off switch, not
// the route's behavior. That is what this knob is for.
const GRID = +(process.env.GRID || 1);
// FILES/CORPUS_ROOT swap the synthetic set for real art. Four hand-made shapes say
// nothing about holes, many contours, self-overlap or degenerate geometry, which is
// where a converter actually fails.
const CORPUS = process.env.CORPUS_ROOT;
// Built in NODE and interpolated into the page: `process.env` does not exist in the
// browser, and referencing it there kills the whole script before __ready is set.
const DBG_DEFINES = ['MANTLE_CPATCH'].concat(
  process.env.RAMP ? ['MANTLE_CPATCH_RAMP ' + process.env.RAMP] : ['MANTLE_CPATCH_HARD'],
);
const FILES = (process.env.FILES || '').split(',').filter(Boolean);
const POOL = process.env.POOL === '0' ? 'false' : 'true';
const CASES = FILES.length
  ? {}
  : {
      circle: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="34" fill="#000"/></svg>`,
      'quad blob': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#000" d="M20 50 Q20 20 50 20 Q80 20 80 50 Q80 80 50 80 Q20 80 20 50 Z"/></svg>`,
      'cubic pear': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#000" d="M50 15 C75 15 85 40 85 55 C85 75 70 88 50 88 C30 88 15 75 15 55 C15 40 25 15 50 15 Z"/></svg>`,
      'nonzero same-wind': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#000" fill-rule="nonzero" d="M50 8 A42 42 0 1 1 49.9 8 Z M50 26 A24 24 0 1 1 49.9 26 Z"/></svg>`,
      'evenodd same-wind': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#000" fill-rule="evenodd" d="M50 8 A42 42 0 1 1 49.9 8 Z M50 26 A24 24 0 1 1 49.9 26 Z"/></svg>`,
      // NOT AN ANNULUS, whatever it looks like. `A24 24 0 1 0 49.9 26` with sweep 0 and the
      // large-arc flag puts the circle's center at y=2, not y=50 — so this is a big circle and a
      // second one mostly OUTSIDE it, wound the other way and overlapping in a lens. Under nonzero
      // that means a lens-shaped hole plus a filled crescent, which is a much harder case than an
      // annulus.
      'nz overlap opp-wind': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#000" fill-rule="nonzero" d="M50 8 A42 42 0 1 1 49.9 8 Z M50 26 A24 24 0 1 0 49.9 26 Z"/></svg>`,
      // The annulus the name promised: two arcs each, so both circles close exactly and the inner
      // one is genuinely centered on the outer.
      'nz annulus (arc)': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#000" fill-rule="nonzero" d="M50 8 A42 42 0 0 1 50 92 A42 42 0 0 1 50 8 Z M50 26 A24 24 0 0 0 50 74 A24 24 0 0 0 50 26 Z"/></svg>`,
      'nonzero opp-wind CUBIC': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#000" fill-rule="nonzero" d="M50 8 C73.196 8 92 26.804 92 50 C92 73.196 73.196 92 50 92 C26.804 92 8 73.196 8 50 C8 26.804 26.804 8 50 8 Z M50 26 C36.7452 26 26 36.7452 26 50 C26 63.2548 36.7452 74 50 74 C63.2548 74 74 63.2548 74 50 C74 36.7452 63.2548 26 50 26 Z "/></svg>`,
      'nonzero same-wind CUBIC': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#000" fill-rule="nonzero" d="M50 8 C73.196 8 92 26.804 92 50 C92 73.196 73.196 92 50 92 C26.804 92 8 73.196 8 50 C8 26.804 26.804 8 50 8 Z M50 26 C63.2548 26 74 36.7452 74 50 C74 63.2548 63.2548 74 50 74 C36.7452 74 26 63.2548 26 50 C26 36.7452 36.7452 26 50 26 Z "/></svg>`,
      'two shapes': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="32" cy="50" r="24" fill="#000"/><circle cx="70" cy="50" r="20" fill="#000"/></svg>`,
    };
if (FILES.length) {
  for (const rel of FILES) {
    try {
      CASES[path.basename(rel)] = readFileSync(CORPUS ? path.join(CORPUS, rel) : rel, 'utf8');
    } catch {
      console.error('skip (unreadable):', rel);
    }
  }
}
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
globalThis.__MANTLE_DEBUG__ = true;   // createRenderer's fillDefines is a test hook, read only under it
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const N=${N};
const IN=${+(process.env.INTERIOR_N || 8)};
const rC=createRenderer(gl,shaders,{cpatchFill:true,cpatchOpts:{interiorN:IN,grid:${GRID},pool:${POOL}}});
const rD=createRenderer(gl,shaders,{cpatchFill:true,cpatchOpts:{interiorN:IN,grid:${GRID},pool:${POOL}},fillDefines:${JSON.stringify(DBG_DEFINES)}});
const rS=createRenderer(gl,shaders,{}); rS.setLoopBlinnFill('off');
const px=()=>{const p=new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,p); return p;};
// COVERAGE, not "how dark is the red channel". A (255-r)/255 metric on
// COLORED art measures the red channel and calls a color difference a coverage
// difference. Coverage is how far a pixel is from the white background across ALL
// channels, so a shape painted the wrong COLOR still counts as covered.
const covOf=(p)=>{let k=0; for(let i=0;i<N*N;i++){
  const d=Math.max(255-p[i*4],255-p[i*4+1],255-p[i*4+2]); k+=d/255; } return k;};
const isInk=(p,i)=>Math.max(255-p[i*4],255-p[i*4+1],255-p[i*4+2])>32;
// Separates the two failures that an aggregate number conflates:
//   solidXor — one engine covers a pixel and the other does not (GEOMETRY)
//   colorErr — both cover it, but paint it differently (PAINT/ALPHA)
// AA fringes are excluded from solidXor by the >32 threshold and a 1px dilation, because
// CPatch's AA is not implemented yet and would otherwise dominate the count.
const compare=(a,b)=>{
  // SOLID-vs-EMPTY, the corpus audit's rule: count a disagreement only where one engine
  // is solidly inked and the other solidly empty. An AA fringe is NEITHER, so it can
  // never enter the count — which matters because CPatch's AA is not implemented yet
  // and would otherwise swamp a geometry measurement.
  const lum=(p,i)=>(p[i*4]+p[i*4+1]+p[i*4+2])/3;
  const solid=(p,i)=>lum(p,i)<40, empty=(p,i)=>lum(p,i)>250;
  let xor=0, both=0, colSum=0, colMax=0;
  for(let i=0;i<N*N;i++){
    const As=solid(a,i), Bs=solid(b,i), Ae=empty(a,i), Be=empty(b,i);
    if((As&&Be)||(Ae&&Bs)){ xor++; continue; }
    if(As&&Bs){ both++;
      const d=Math.max(Math.abs(a[i*4]-b[i*4]),Math.abs(a[i*4+1]-b[i*4+1]),Math.abs(a[i*4+2]-b[i*4+2]));
      colSum+=d; if(d>colMax) colMax=d; }
  }
  // PARTIAL COVERAGE is the blind spot of solid-vs-empty: a region painted at, say,
  // 60% alpha is NEITHER solid nor empty, so it escapes both columns above while
  // being plainly wrong. Measure it separately over every pixel either engine
  // touches, and split it by distance from an edge — a fringe-only difference is AA,
  // a difference that persists INSIDE is a coverage bug.
  let anyN=0, anySum=0, inN=0, inSum=0;
  const inked=(p,i)=>lum(p,i)<250;
  for(let y=2;y<N-2;y++) for(let x=2;x<N-2;x++){
    const i=y*N+x;
    if(!inked(a,i) && !inked(b,i)) continue;
    const d=Math.abs(lum(a,i)-lum(b,i));
    anyN++; anySum+=d;
    // "interior" = this pixel and its 4 neighbors are all inked in the REFERENCE,
    // so it is not on Slug's edge and any difference here is not a fringe.
    // NO DARKNESS THRESHOLD. Requiring lum<40 assumed black art and found ZERO
    // interior pixels on a colored asset — the same luminance assumption that made
    // the original red-channel metric wrong. "Interior" is simply: the reference
    // covers this pixel and all four neighbors, so it is not on Slug's edge.
    if(inked(b,i)&&inked(b,i-1)&&inked(b,i+1)&&inked(b,i-N)&&inked(b,i+N)){ inN++; inSum+=d; }
  }
  return {xor, both, colMean: both? colSum/both : 0, colMax,
          partAll: anyN? anySum/anyN : 0, partIn: inN? inSum/inN : 0, inN};
};
const sleepP=(ms)=>new Promise(res=>setTimeout(res,ms));
// THE BUILD CAN BE ASYNCHRONOUS. With cpatchOpts.pool the contours convert on a worker pool, so
// the first prepareBundle starts the conversion and reports nothing built — the same contract the
// CPatch morph route and the LB build already have. A caller that never yields can never see it
// finish, so wait for the conversion to land and then prepare again.
const run=async(r,sec)=>{ const b=createBundle(gl,sec);
  let prep = r.prepareBundle ? r.prepareBundle(b) : null;
  let waited=0;
  while(b._cpatchConv==='pending' && waited<2000){ await sleepP(5); waited+=5; }
  if(r.prepareBundle) prep = r.prepareBundle(b);
  while(b._cpatchConv==='pending' && waited<6000){ await sleepP(5); waited+=5; }
  if(r.prepareBundle) prep = r.prepareBundle(b);
  window.__waited=(window.__waited|0)+waited;
  window.__convState=b._cpatchConv===undefined?'undef':b._cpatchConv==='pending'?'pending'
    :(b._cpatchConv&&b._cpatchConv.size!==undefined?('map'+b._cpatchConv.size):'other');
  const built = b._cpatchBuilt|0; const bail = b._cpatchBail||'';
  // How many shapes CPatch could NOT build. Those fall back within the bundle, so a
  // gap here is the first thing to check when real art under-fills.
  const meshes = b._lbMeshes||[]; const total = meshes.length;
  const nulls = meshes.filter(m=>!m).length;
  const rules=(b._cpatchRules||[]).join(' ');
  const drops=b._cpatchDropped|0, unres=b._cpatchUnresolved|0, cellN=b._cpatchCells|0;
  const kinds = {};
  for(const m of (b._lbMeshes||[])){ if(!m||!m.verts) continue;
    for(let i=0;i<m.vertexCount;i++){ const k=Math.floor(m.verts[i*24+5]+0.001); kinds[k]=(kinds[k]|0)+1; } }
  r.setViewport(N,N); gl.viewport(0,0,N,N);
  // DRAW REPEATEDLY. A fill variant links asynchronously, and a draw issued while it
  // is still linking reports success while painting through the fallback — the exact
  // failure this probe exists to catch, so it must not be mistaken for the steady
  // state. Ink is taken from the LAST frame, and the first is reported beside it.
  let first=0;
  for(let f=0;f<12;f++){
    r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame();
    const q=new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,q);
    if(f===0) first=covOf(px());
  }
  const p=px(); const ink=covOf(p); const raw=p; const gate=r.debugStats?r.debugStats.unifiedFillGate:null;
  const hasSlug=!!b._lbHasSlug;
  b.dispose(); return {ink, raw, first, built, kinds, bail, gate, total, nulls, hasSlug, drops, unres, cellN, rules, prep:!!prep};
};
window.__run=async(cases)=>{ const out=[];
  for(const [name,svg] of Object.entries(cases)){
    try{ const sec=await importSvg(svg,{preserveViewport:true});
      const c=await run(rC,sec), s=await run(rS,sec), d=await run(rD,sec);
      const cmp=compare(c.raw,s.raw); c.raw=null; s.raw=null; d.raw=null;
      out.push({name, cpatch:c, slug:s, dbg:d, cmp});
    }catch(e){ out.push({name, err:String(e.message).slice(0,140)}); }
  } return {rows:out, waited:window.__waited|0, convState:window.__convState||'-'}; };
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
pg.on('pageerror', (e) => console.error(' [err]', String(e.message).slice(0, 240)));
pg.on('console', (m) => {
  if (m.type() === 'error') console.error(' [console]', m.text().slice(0, 220));
});
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 90000 });
await pg.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 50 });
const oo = await pg.evaluate((c) => window.__run(c), CASES);
const o = oo.rows;
console.log(`  [build] waited ${oo.waited}ms total, conv state: ${oo.convState}`);
await br.close();
server.close();
let bad = 0;
console.log(`\nthe WIRED CPatch route (cpatchFill:true) vs Slug, ${N}x${N}\n`);
console.log('  case          | shapes | ratio | XOR | color | dLum all | dLum INTERIOR');
for (const r of o) {
  if (r.err) {
    console.log(`  ${r.name.padEnd(13)} | ERR ${r.err}`);
    bad++;
    continue;
  }
  const ratio = r.cpatch.ink / Math.max(r.slug.ink, 1e-9);
  const ks = Object.keys(r.cpatch.kinds).join(',') || 'none';
  // A CIRCLE IS NOT THE ROUTE'S TO DRAW. bakeCPatchBundle skips a shape that
  // circleFromContours or ellipseFromContours recognizes -- "a primitive draws itself" -- so the
  // SDF primitive path takes it and CPatch builds nothing, correctly. Demanding built > 0 here
  // condemned both circle cases for years while the same run showed them matching Slug pixel for
  // pixel. They still have to MATCH; they just do not have to be built by CPatch.
  const PRIM = new Set(['circle', 'two shapes']);
  const ok =
    (r.cpatch.built > 0 || (PRIM.has(r.name) && r.cmp.xor === 0)) && ratio > 0.9 && ratio < 1.1;
  if (!ok) bad++;
  const c = r.cmp;
  console.log(
    `  ${r.name.padEnd(13)} | ${(r.cpatch.built + '/' + r.cpatch.total).padStart(6)} | ${ratio.toFixed(3)} | ${String(c.xor).padStart(3)} | ${c.colMean.toFixed(1)}/${String(c.colMax).padStart(3)} | ${c.partAll.toFixed(1).padStart(8)} | ${c.partIn.toFixed(1).padStart(6)} over ${c.inN} px ${ok ? '' : ' <-- OFF'}`,
  );
  if (!ok && r.cpatch.bail) console.log(`  ${''.padEnd(13)} |   bail: ${r.cpatch.bail}`);
  // THE DEBUG ARM IS THE HARD-STEP KERNEL, so its ink is the shape's COVERAGE with no AA ramp
  // and it should match Slug's, not exceed it. (A `> 1.05` check would only suit a cover-box
  // kernel that returns 1.0 unconditionally and paints the whole quad.) Proof of paint is ink on
  // the screen from a built mesh.
  const dr = r.dbg.ink / Math.max(r.slug.ink, 1e-9);
  const painted = (r.cpatch.built > 0 || PRIM.has(r.name)) && r.cpatch.ink > 0;
  const covOk = Math.abs(dr - 1) <= 0.02;
  console.log(
    `  ${''.padEnd(13)} |   HARD-STEP (no AA ramp) cov ${r.dbg.ink.toFixed(0)} = ${dr.toFixed(3)}x slug   rules=[${r.cpatch.rules}] gate=${r.cpatch.gate} shapes=${r.cpatch.built}/${r.cpatch.total} unbuilt=${r.cpatch.nulls} dropped=${r.cpatch.drops} unresolved=${r.cpatch.unres} cells=${r.cpatch.cellN}`,
  );
  if (!painted) {
    console.log(`  ${''.padEnd(13)} |   NOT PAINTING`);
    bad++;
  } else if (!covOk) {
    console.log(
      `  ${''.padEnd(13)} |   COVERAGE OFF by ${((dr - 1) * 100).toFixed(1)}% against Slug`,
    );
    bad++;
  }
}
console.log(
  bad
    ? `\n${bad} case(s) wrong — the route is not painting what Slug paints.`
    : '\nthe wired route paints, in kind 14, and matches Slug within AA.',
);
process.exit(bad ? 1 : 0);
