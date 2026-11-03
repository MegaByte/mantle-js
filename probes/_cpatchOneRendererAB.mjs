// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _cpatchOneRendererAB — price an output-identical CPatch kernel change, on ONE renderer.
//
// Every earlier A/B rig here gave each arm its own renderer, and that is not a controlled
// experiment. Hand three such arms a define that changes NO code and they time the same bundle
// (same cells, same ink to the pixel) at 1.633 / 2.008 / 0.933 ms -- an A/A of 1.75x. Interleaving
// the samples rather than timing arm-by-arm left it at 1.95x and rotating the arm order each
// sample at 2.19x, which rules out block drift and position both: three renderers standing on one
// GL context are simply not interchangeable.
//
// So this rig keeps ONE renderer, ONE bundle and one set of GPU resources, and switches only the
// fill VARIANT between batches (R._abDefines, resolved per draw in fillPass). Both variants
// compile and warm during setup, so a switch is a key lookup. Samples interleave, the arm order
// rotates, an A/A control runs alongside, and
// each arm's ink is counted BEFORE timing so an arm that paints nothing cannot post the best time.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEGS = +(process.env.SEGS || 64),
  FAM = process.env.FAMILY || 'cubic';
const N = +(process.env.N || 8),
  SIZE = +(process.env.SIZE || 768),
  BATCH = +(process.env.BATCH || 25);
const SAMPLES = +(process.env.SAMPLES || 9);
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
    if (FAM === 'line') d += ' L' + q[0].toFixed(4) + ' ' + q[1].toFixed(4);
    else if (FAM === 'cubic') {
      const c1 = [p[0] + (bx - p[0]) * 0.66, p[1] + (by - p[1]) * 0.66],
        c2 = [q[0] + (bx - q[0]) * 0.66, q[1] + (by - q[1]) * 0.66];
      d +=
        ' C' +
        c1[0].toFixed(4) +
        ' ' +
        c1[1].toFixed(4) +
        ' ' +
        c2[0].toFixed(4) +
        ' ' +
        c2[1].toFixed(4) +
        ' ' +
        q[0].toFixed(4) +
        ' ' +
        q[1].toFixed(4);
    } else
      d +=
        ' Q' + bx.toFixed(4) + ' ' + by.toFixed(4) + ' ' + q[0].toFixed(4) + ' ' + q[1].toFixed(4);
  }
  // STROKE=1 draws the same ring as an open STROKED path instead of a fill, for pricing the stroke
  // kernel. Open, because a stroke's per-fragment cost is its joints and this keeps them all.
  // CIRCLE=1 emits a real circle, which shapeRecognize turns into an elliptical-SDF primitive --
  // the cheapest path there is (one analytic distance, no constraint fetches at all). Needed
  // because the segment rings above are NOT recognized, so an SDF-vs-engine arm on them silently
  // compares an engine against itself.
  // MIXED=1 puts a RECOGNIZED shape and an unrecognized one in one bundle -- the case that decides
  // whether SDF is worth having as a peer. Switching engines between shapes costs when they cannot
  // batch, so what matters is not the primitive's speed in isolation but whether a bundle carrying
  // one is faster overall.
  if (process.env.MIXED) {
    const P = [];
    const cx = 100,
      cy = 64,
      r = 30;
    for (let i = 0; i < SEGS; i++) {
      const a2 = -Math.PI / 2 + (i * 2 * Math.PI) / SEGS;
      P.push([cx + r * Math.cos(a2), cy + r * Math.sin(a2)]);
    }
    let d = 'M' + P[0][0].toFixed(3) + ' ' + P[0][1].toFixed(3);
    for (let i = 0; i < SEGS; i++) {
      const p = P[i],
        q = P[(i + 1) % SEGS],
        mx = (p[0] + q[0]) / 2,
        my = (p[1] + q[1]) / 2;
      d +=
        ' Q' +
        (cx + (mx - cx) * 1.18).toFixed(3) +
        ' ' +
        (cy + (my - cy) * 1.18).toFixed(3) +
        ' ' +
        q[0].toFixed(3) +
        ' ' +
        q[1].toFixed(3);
    }
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">' +
      '<circle cx="34" cy="64" r="30" fill="#265b9b"/>' +
      '<path d="' +
      d +
      ' Z" fill="#8b3a2f"/></svg>'
    );
  }
  // SVGFILE: a REAL asset. The synthetic families answer "which engine is fastest on this shape";
  // only real artwork answers "which engine is fastest on real content", and the two can give
  // different answers.
  if (process.env.SVGFILE) return readFileSync(path.resolve(ROOT, process.env.SVGFILE), 'utf8');
  // RECT=1: the other common primitive candidate. 88 of the corpus's 532 shape elements are plain
  // rectangles against 68 circles, so if a rect is expensive today it is worth a kernel; if it is
  // already cheap there is nothing to win.
  if (process.env.RECT)
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">' +
      '<rect x="20" y="20" width="88" height="88" fill="#265b9b"/></svg>'
    );
  if (process.env.CIRCLE)
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">' +
      '<circle cx="64" cy="64" r="44" fill="#265b9b"/></svg>'
    );
  return process.env.STROKE
    ? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path d="' +
        d +
        '" fill="none" stroke="#265b9b" stroke-width="' +
        (process.env.SW || 6) +
        '" stroke-linejoin="miter"/></svg>'
    : '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path d="' +
        d +
        ' Z" fill="#265b9b"/></svg>';
};
const PAGE = `<!doctype html><body><canvas id=c width=${SIZE} height=${SIZE}></canvas><script type=module>
// YIELD BETWEEN BATCHES, or this probe takes the machine with it. Back-to-back draw loops saturate
// the GPU, WindowServer starves behind Chrome's GPU process, and the desktop stops responding --
// measured the hard way, twice. Headless does NOT help: it removes the window, not the load.
// THROTTLE_MS (default 12) is the pause after each timed batch; 0 disables it for a quiet machine.
const __throttle = ${JSON.stringify(process.env.THROTTLE_MS || '12')};
const __yield = () => new Promise(r => setTimeout(r, +__throttle || 0));
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,preserveDrawingBuffer:true,depth:true,stencil:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const svg=${JSON.stringify(ring())};
const DEF = ${JSON.stringify(process.env.DEF || 'MANTLE_CPATCH_E1_ALWAYS')};
// Arm 1 is the shipping kernel, arm 2 adds the define, arm 3 repeats arm 1 as the A/A control.
const ARMS=[['ship',[]],[DEF.replace(/^MANTLE_CPATCH_/,'').toLowerCase(),[DEF]],['shipAA',[]]];
// THE MINIMUM, NOT THE MEDIAN, IS THE ESTIMATOR. Every arm's samples come out bimodal here --
// clusters near 1.55 and near 2.2 ms in the same arm -- because something outside the kernel
// (compositor, frame pacing, another process taking the device) lands on some batches and not
// others. That contamination only ever ADDS time, so the median tracks how often it struck rather
// than what the kernel costs, and it is what left an A/A control at 0.96 while the arms' minima
// agreed to three digits. Minima are reported as the headline and the median kept alongside: if
// the two disagree about the direction, the run was too noisy to conclude anything.
const engSnap=()=>{const e=(r.debugStats.engines&&r.debugStats.engines.draws)||{};const o={};for(const k in e)o[k]=e[k]|0;return o;};
const engDelta=(now,before)=>{const o={};for(const k in now){const d=(now[k]|0)-(before[k]|0); if(d>0)o[k]=d;} return o;};
const med=(a)=>{const b=a.slice().sort((x,y)=>x-y); return b[b.length>>1];};
const mn=(a)=>Math.min.apply(null,a);
const out={med:{},ink:{},drew:{},raw:{},names:ARMS.map(a=>a[0]),cells:0};
// WHICH ENGINE'S KERNEL IS UNDER TEST. The rig is about holding everything but the fill variant
// fixed, and that is not specific to CPatch -- the same waste (a refinement computed and then
// blended or thresholded away) turns up in Loop-Blinn's corner combiners.
// NOSDF=1 disables shape recognition for the WHOLE page, before any bundle is built. The per-arm
// override does not work for this: recognition happens inside the Loop-Blinn mesh build, which does
// not necessarily run while the flag is set around createBundle -- both arms came back drawing sdf.
if (${JSON.stringify(process.env.NOSDF === '1')}) globalThis.__MANTLE_DEBUG__ = globalThis.__MANTLE_NO_SDF_PRIMS = true;
// NOINST=1 takes the INSTANCED fast path out. It has to be available, because that path builds its
// program from _instancedEngineDefines and NEVER sees __setAbDefines -- so on a bundle it claims,
// every arm runs the identical shader and the "A/B" prices nothing at all. Symptom: an arm whose
// define is not even spelled in the shader still posts 3.5x. Set it for any fill-kernel A/B whose
// content is simple enough to be instanced (one shape, repeated -- which is most of this rig's).
if (${JSON.stringify(process.env.NOINST === '1')}) { globalThis.__MANTLE_DEBUG__ = true; globalThis.__MANTLE_NO_INSTANCED_FAST = true; }
const ENG = ${JSON.stringify(process.env.ENGINE || 'cpatch')};
// RENDOPTS: extra renderer options for BOTH arms, for a flag the per-bundle override cannot carry.
// Comparing two runs is weaker than one run with two arms -- say so when reporting it -- but each
// run still carries its own A/A control, so at least each number is known to be stable.
const RENDOPTS = ${JSON.stringify(process.env.RENDOPTS ? JSON.parse(process.env.RENDOPTS) : {})};
const EOPTS = Object.assign(RENDOPTS, ENG==='cpatch' ? {cpatchFill:true} : ENG==='aac' ? {aacFill:true} : {});
const EROUTE = ENG==='cpatch' ? 'cpatch' : ENG==='lb' ? 'lb' : 'none';
const r=createRenderer(gl,shaders,Object.assign({psoWarmIdle:()=>true},EOPTS));
r.setViewport(${SIZE},${SIZE}); r.setFillEngine({route:EROUTE});
// PER-ARM BUNDLES, for a change that lives in the GEOMETRY rather than the program. Still ONE
// renderer and one context -- that is what the A/A control showed matters -- but arm 2 may build
// its bundle with different pack options. CPOPTS2 is applied to arm 2 only.
const CPOPTS2 = ${JSON.stringify(process.env.CPOPTS2 ? JSON.parse(process.env.CPOPTS2) : null)};
const mkBundle = async (extra) => {
  if (extra && extra.grid != null) { globalThis.__MANTLE_DEBUG__ = true; globalThis.__CP_GRID = extra.grid; }
  if (extra && extra.noSdf) globalThis.__MANTLE_DEBUG__ = globalThis.__MANTLE_NO_SDF_PRIMS = true;
  if (extra && extra.seamW != null) { globalThis.__MANTLE_DEBUG__ = true; globalThis.__CP_SEAM_W = extra.seamW; }   // a test hook
  const bb = createBundle(gl, await importSvg(svg));
  if (extra && extra.noCurveTex) bb._noCurveTex = true;   // per-bundle layout override
  r.prepareBundle(bb);
  if (r.awaitEngine && EROUTE !== 'none') { try { await r.awaitEngine(bb, EROUTE, 60000); } catch {} }
  globalThis.__CP_GRID = null; globalThis.__MANTLE_NO_SDF_PRIMS = false;
  globalThis.__CP_SEAM_W = null;
  return bb;
};
const b = await mkBundle(null);
const b2 = CPOPTS2 ? await mkBundle(CPOPTS2) : b;
out.cells=b._cpatchCells|0;
const paint=(defs,which)=>{r.__setAbDefines(defs); r.beginFrame([1,1,1,1]);
  for(let i=0;i<${N};i++) r.drawBundle(which||b,{}); r.endFrame();};
const arms=[];
for(const [name,defs] of ARMS){
  // Arm 2 gets the second bundle when one was built; every other arm shares the first.
  const bnd = (name === ARMS[1][0] && CPOPTS2) ? b2 : b;
  // WARM THE VARIANT ITSELF. A variant links lazily and is only USED once its pipeline is warm --
  // until then the draw silently falls back to the base program, which would time the SAME kernel
  // for both arms and report a perfect 1.00x that means nothing.
  // AND WARM UNTIL THE ARM ACTUALLY DRAWS ITS OWN ENGINE. A variant that is still linking draws
  // with a fallback -- for LB that is the best non-LB engine, i.e. SLUG -- so a short warm-up can
  // time one arm's kernel against ANOTHER ENGINE entirely and report it as a 3.6x win. Engine
  // counts are read as PER-ARM DELTAS (the cumulative map keeps every engine any earlier arm ever
  // drew, which makes a clean arm look mixed), and the warm-up repeats until this arm's draws are
  // a single engine.
  let e0=engSnap();
  for(let w=0;w<40;w++){ paint(defs,bnd); if((w&7)===7) await __yield(); }
  gl.finish();
  // AND BUILD THE ARM'S PIPELINE, SYNCHRONOUSLY. Linking the program is not enough: a lean
  // variant is only USED once its Metal pipeline is warm too, and that warm runs during frame
  // SLACK -- which a tight probe loop never gives it. So the arm kept falling back to the
  // pipeline-warm UNIVERSAL program, which carries every kernel the lean variant omits, and an
  // arm whose define changed nothing at all timed 3.2x slower than ship. precompileFills()
  // drains both queues with the idle gate bypassed, which is exactly what this rig wants.
  // Warm under THIS arm's defines, since that is what picks the variant.
  r.__setAbDefines(defs);
  if(r.precompileFills){ try{ r.precompileFills(); }catch{} }
  for(let w=0;w<40;w++){ paint(defs,bnd); if((w&7)===7) await __yield(); }
  gl.finish();
  // AND LET THIS ARM'S OWN VARIANT WARM. awaitEngine was called once at setup, for the shipping
  // variant; an arm that adds a define is a DIFFERENT variant, which has to link and have its
  // pipeline built before the route will use it -- until then Loop-Blinn serves the draw from its
  // fallback engine instead, and the arm times Slug.
  if(r.awaitEngine && EROUTE!=='none'){ try{ await r.awaitEngine(bnd,EROUTE,30000); }catch{}
    for(let w=0;w<40;w++){ paint(defs,bnd); if((w&7)===7) await __yield(); } gl.finish(); e0=engSnap(); for(let w=0;w<40;w++){ paint(defs,bnd); if((w&7)===7) await __yield(); } gl.finish(); }
  let dEng=engDelta(engSnap(),e0);
  for(let tries=0; tries<12 && Object.keys(dEng).length>1; tries++){
    e0=engSnap(); for(let w=0;w<40;w++){ paint(defs,bnd); if((w&7)===7) await __yield(); } gl.finish(); dEng=engDelta(engSnap(),e0);
  }
  paint(defs,bnd); gl.finish();
  const px=new Uint8Array(${SIZE}*${SIZE}*4); gl.readPixels(0,0,${SIZE},${SIZE},gl.RGBA,gl.UNSIGNED_BYTE,px);
  let ink=0; for(let i=0;i<px.length;i+=4) if(px[i+3]>8 && !(px[i]>247&&px[i+1]>247&&px[i+2]>247)) ink++;
  // WITH COUNTS, not just names. An arm can draw the right ENGINE through the wrong ROUTE -- one
  // batched draw against dozens of per-shape ones is a 3.5x difference that an engine NAME cannot
  // show, and this rig's whole claim is that only the program differs between arms.
  out.ink[name]=ink;
  out.drew[name]=Object.keys(dEng).map((k)=>k+':'+dEng[k]).join('+')||'none';
  out.vkey=out.vkey||{}; out.vkey[name]=(r.debugStats&&r.debugStats.fillVariantKey)||'(base)';
  console.log('arm '+name+' variantKey=['+(r.debugStats.fillVariantKey||r._lastFillVariantKey||'?')+']');
  console.log('arm '+name+' gate='+(r.debugStats.unifiedFillGate||r._unifiedFillGate||'?')
    +' noCurveTex='+(!!bnd._noCurveTex));
  console.log('arm '+name+' ready, ink '+ink+'  variants '+(r.debugStats.fillVariants||r._variantCompiles||0));
  arms.push({name,defs,bnd,samp:[]});
}
for(let s=0;s<${SAMPLES};s++) for(let k=0;k<arms.length;k++){
  const a=arms[(k+s)%arms.length];
  const t0=performance.now();
  for(let i=0;i<${BATCH};i++) paint(a.defs,a.bnd);
  const q=new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,q);   // sync the batch
  a.samp.push((performance.now()-t0)/${BATCH});
  await __yield();
}
out.min={};
for(const a of arms){ out.med[a.name]=med(a.samp); out.min[a.name]=mn(a.samp); out.raw[a.name]=a.samp.map(v=>+v.toFixed(3)); }
console.log('sampling done');
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
pg.on('console', (m) => console.log('[page]', m.text()));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 60000 });
// POLL ON A TIMER, not on rAF. waitForFunction defaults to requestAnimationFrame, and a
// headless page that has stopped compositing after its last draw stops firing it -- the
// probe then times out holding a result it already computed ("sampling done" in the log,
// no numbers).
await pg.waitForFunction('window.__out', { timeout: 590000, polling: 200 });
const o = await pg.evaluate(() => window.__out);
await br.close();
server.close();
const NM = o.names,
  A = NM[0],
  B = NM[1],
  C = NM[2];
console.log(
  `\n  ${process.env.ENGINE || 'cpatch'} · ${FAM} ring, ${SEGS} segs, ${N} instances at ${SIZE}px, ${BATCH}-frame batches x ${SAMPLES} interleaved, ${o.cells} cells`,
);
console.log(`    drew           ` + NM.map((n) => n + ' ' + o.drew[n]).join('   '));
if (o.vkey)
  console.log(`    variant        ` + NM.map((n) => n + ' [' + o.vkey[n] + ']').join('   '));
const inks = NM.map((n) => o.ink[n]);
console.log(
  `    ink            ` +
    NM.map((n) => n + ' ' + o.ink[n]).join('   ') +
    (inks.every((v) => v === inks[0]) ? '   (identical)' : '   *** DIFFERENT — not comparable ***'),
);
console.log(
  `    A/A control    min ${(o.min[A] / o.min[C]).toFixed(3)}x    median ${(o.med[A] / o.med[C]).toFixed(3)}x   (min must be ~1.00)`,
);
for (const n of NM)
  console.log(
    `    ${n.padEnd(14)} min ${o.min[n].toFixed(3)}   median ${o.med[n].toFixed(3)} ms/frame`,
  );
for (const n of NM) console.log(`      raw ${n.padEnd(12)} ${o.raw[n].join(' ')}`);
console.log(
  `    ${B} / ${A}      min ${(o.min[B] / o.min[A]).toFixed(3)}x    median ${(o.med[B] / o.med[A]).toFixed(3)}x`,
);
