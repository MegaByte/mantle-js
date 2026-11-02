// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzGpuVsModel — does the CPU model of the CPatch kernel describe what the GPU actually paints?
//
// Every quality number in this effort comes from patchCoverage, and patchCoverage is only worth
// anything if it is a model OF THE GPU. It clips against the SAMPLED cover hull with per-plane
// ramps; packCPatchContour rasterises the CONTROL-POINT hull polygon instead of emitting plane
// rows, which is a hard undilated clip at a looser hull. Two differences, and neither is visible
// from either side alone -- so this renders the real route and diffs it against the model.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = +(process.env.N || 512);
const SRC = process.env.SVG || '../MantleSamples/Assets/Mantle/tiger.svg';
// STROKES MAKE THE ROUTE DECLINE THE whole BUNDLE, so a stroked asset never exercises the CPatch
// kernel on the GPU at all -- tiger draws entirely through Slug. Stripping them is what lets the
// same geometry be compared; NOSTRIP=1 shows the decline instead.
const SVG =
  process.env.NOSTRIP === '1'
    ? readFileSync(SRC, 'utf8')
    : readFileSync(SRC, 'utf8')
        .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
        .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
globalThis.__MANTLE_DEBUG__ = true;   // createRenderer's fillDefines is a test hook, read only under it
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const cv=document.getElementById('c');
const gl=cv.getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const N=${N};
window.__run=async(svg)=>{
  // SDF PRIMITIVES OFF (NOSDF=1): a recognised circle is drawn as an exact SDF record, and the
  // engine ledger reports it as its own engine -- so if that is a separate DRAW, the shapes it takes are
  // lifted out of document order and everything they overlap composites wrongly.
  if (${process.env.NOSDF === '1'}) globalThis.__MANTLE_DEBUG__ = globalThis.__MANTLE_NO_SDF_PRIMS = true;
  // Cover-model knobs a probe needs to A/B without a rebuild; each is read by cpatchConvert /
  // cpatchPack at pack time, which happens in this page.
  if (${process.env.CORNER != null ? process.env.CORNER : 'null'} !== null) globalThis.__CP_CORNER_MITER = ${process.env.CORNER != null ? process.env.CORNER : 0};
  if (${process.env.HULLROWS != null ? process.env.HULLROWS : 'null'} !== null) globalThis.__MANTLE_DEBUG__ = true;   // a test hook, read only under it
  if (${process.env.HULLROWS != null ? process.env.HULLROWS : 'null'} !== null) globalThis.__CP_HULL_ROW_SAMPLES = ${process.env.HULLROWS != null ? process.env.HULLROWS : 6};
  const sec=await importSvg(svg,{preserveViewport:true});
  const sleepP=(ms)=>new Promise((z)=>setTimeout(z,ms));
  // TIME, WITHIN ONE RUN. Cross-run GPU timings on this machine drift 30-40%, so the only valid
  // comparison is both arms in the same page, interleaved, with a readPixels after each frame to
  // force the driver to finish rather than queue. Reports the median of the interleaved samples.
  const timeIt=async(opts,wantCp)=>{
    const r=createRenderer(gl,shaders,opts);
    const b=createBundle(gl,sec);
    if (r.prepareBundle) r.prepareBundle(b);
    if (wantCp) { let w=0;
      while(b._cpatchConv==='pending' && w<20000){ await sleepP(5); w+=5; }
      if (r.prepareBundle) r.prepareBundle(b);
      while(b._cpatchConv==='pending' && w<30000){ await sleepP(5); w+=5; }
      if (r.prepareBundle) r.prepareBundle(b); }
    if (r.awaitLbReady) await r.awaitLbReady(b);
    r.setViewport(N,N); gl.viewport(0,0,N,N);
    const one=new Uint8Array(4), ts=[];
    for (let k=0;k<24;k++){
      const t0=performance.now();
      r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame();
      gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,one);   // force the frame to finish
      ts.push(performance.now()-t0);
    }
    ts.sort((x,y)=>x-y);
    const draws=(r.debugStats&&r.debugStats.engines&&r.debugStats.engines.draws)||{};
    const mask=(r._lbKindMask?r._lbKindMask(b):(b._lbKindMask|0));
    b.dispose();
    return { ms: ts[ts.length>>1], draws: JSON.stringify(draws), mask };
  };
  // MIXED FIRST. The one-engine switch is process-wide and sticky, so once any renderer sets it
  // nothing turns it back on -- an A/B that runs one-engine first measures it twice.
  const tMix = await timeIt({cpatchFill:true, aacFill:false, mixEngines:true}, true);
  const tOne = await timeIt({cpatchFill:true, aacFill:false}, true);

  const shot=(opts,wantCp,clear)=>{
    const r=createRenderer(gl,shaders,opts);
    if (opts.slugOff) r.setLoopBlinnFill('off');
    const b=createBundle(gl,sec);
    return (async()=>{
      // THE CONVERSION IS ASYNC. prepareBundle STARTS it and reports nothing built; poll and
      // prepare again or the route silently draws through Slug and the comparison measures the
      // wrong engine entirely (226 shapes' worth, on tiger).
      if (r.prepareBundle) r.prepareBundle(b);
      if (wantCp) { let w=0;
        while(b._cpatchConv==='pending' && w<12000){ await sleepP(5); w+=5; }
        if (r.prepareBundle) r.prepareBundle(b);
        while(b._cpatchConv==='pending' && w<20000){ await sleepP(5); w+=5; }
        if (r.prepareBundle) r.prepareBundle(b); }
      if (r.awaitLbReady) await r.awaitLbReady(b);
      r.setViewport(N,N); gl.viewport(0,0,N,N);
      r.beginFrame(clear||[1,1,1,1]); r.drawBundle(b); r.endFrame();
      const p=new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,p);
      const ds=r.debugStats||{};
      // THE KIND MASK is what selects the compiled variant, so a bundle that gains ONE disc mesh
      // compiles a different program for EVERY shape in it. Three tiny primitives cannot repaint
      // 18,000 pixels by themselves; a different variant can.
      const out={ px:Array.from(p), built:(b._cpatchBuilt|0),
                  kindMask:(b._lbKindMask!==undefined?b._lbKindMask:(typeof b._lbKindMask)),
                  dropped:(b._cpatchDropped|0), unres:(b._cpatchUnresolved|0),
                  shapes:(sec.curveRangesByShape||[]).length,
                  bail:(b._cpatchBail||''), rules:(b._cpatchRules||[]).join(' '),
                  hasSlug:!!b._lbHasSlug, nMesh:(b._lbMeshes?b._lbMeshes.length:-1),
                  prim:(b._lbMeshes?b._lbMeshes.filter((m)=>m&&m.prim).length:-1),
                  primIdx:(b._lbMeshes?b._lbMeshes.map((m,i)=>m&&m.prim?i:-1).filter((i)=>i>=0).join(','):''),
                  nullMesh:(b._lbMeshes?b._lbMeshes.filter((m)=>!m).length:-1),
                  draws: ds.engines&&ds.engines.draws ? JSON.stringify(ds.engines.draws) : '(none)' };
      b.dispose(); return out;
    })();
  };
  // PIN THE KERNEL. Route and kernel are separate axes: cpatchFill picks the ROUTE, and aacFill is
  // left on 'auto', which picks a different KERNEL for the shapes CPatch does not take. Leaving it
  // free makes the comparison "CPatch + whatever else auto chose" against "Slug", and charges the
  // difference to CPatch.
  // ON A TRANSPARENT CLEAR TOO. Over white, "not painted" and "painted white" are the same pixel,
  // and a colour bug reads as missing coverage. Alpha separates them.
  const cp=await shot({cpatchFill:true, aacFill:false}, true);
  // THE DEPTH CLAIM decides the winner where shapes overlap, instead of draw order. If the residual
  // wrong-colour pixels are stacked shapes resolving differently, this is the switch that says so.
  const cpNoDepth=await shot({cpatchFill:true, aacFill:false, unifiedFillDepthClaim:false}, true, [0,0,0,0]);
  const cpA=await shot({cpatchFill:true, aacFill:false}, true, [0,0,0,0]);
  const slA=await shot({slugOff:false}, false, [0,0,0,0]);
  const sl=await shot({slugOff:false}, false);
  // THE FALLBACK ON ITS OWN. Not every shape converts, and the ones that do not draw through
  // whatever else the route picks -- so a CPatch-vs-Slug diff charges those engines' differences to
  // CPatch. Asking for the route WITHOUT awaiting the conversion builds nothing and draws the whole
  // asset through exactly those fallbacks, which is the baseline the real arm has to be read against.
  const fb=await shot({cpatchFill:true, aacFill:false}, false);
  // MANTLE_CPATCH_SHOWN paints the constraint COUNT the fragment resolved, clamped so ANY fragment
  // a CPatch quad reaches comes out non-white. It separates the two halves of "missing ink": a quad
  // that never covered the pixel, from a quad that covered it and whose kernel rejected it.
  // ON A TRANSPARENT CLEAR, so "was this fragment reached" is the ALPHA channel and not a
  // luminance threshold. SHOWN paints 0.02 for a reached fragment with no constraints, which over
  // white is luminance ~250 -- indistinguishable from unpainted, and it read as "no quad reached
  // it" for 11,029 pixels that quads did reach.
  const sh=await shot({cpatchFill:true, aacFill:false, fillDefines:['MANTLE_CPATCH_SHOWN']}, true, [0,0,0,0]);
  // THE HARD-STEP KERNEL: every constraint reduced to step(0, f), so the SIGN of each implicit
  // decides and no distance, no Newton step and no AA enters. If a region the full kernel drops
  // comes back here, the decomposition and the signs are right and the loss is in the DISTANCE.
  const hd=await shot({cpatchFill:true, aacFill:false, fillDefines:['MANTLE_CPATCH_HARD']}, true);
  // MANTLE_CPATCH_SHOWREJ paints WHICH constraint rejects, as (index+1)/8. A hole that survives
  // every data check has to be named by the kernel itself.
  // MANTLE_CPATCH_SHOWREJ IS BROKEN and its readings are noise: the variant fails to link
  // ("'cpatchCurveCov' : no matching overloaded function found"), so the arm renders through a
  // fallback and every index it reports is somebody else's. Not used.
  const rj=cp;
  // AND THE FRAMING, so a pixel index can be turned back into em and asked of the CPU model. Without
  // it the two sides cannot be compared at a POINT, only in aggregate.
  const vb = sec.viewBox || null;
  return { cp, sl, fb, sh, hd, rj, vb, cpA, slA, tOne, tMix, cpNoDepth };
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
const port = server.address().port;
const browser = await launchBrowser({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-webgpu'],
});
const page = await browser.newPage();
page.on('console', (m) => {
  if (m.type() === 'error') console.log('  page: ' + m.text());
});
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
await page.waitForFunction('window.__ready===true', { timeout: 60000 });
const out = await page.evaluate((s) => window.__run(s), SVG);
await browser.close();
server.close();
console.log(
  `CPatch: ${out.cp.draws}  ${out.cp.built} of ${out.cp.shapes} shapes built, ${out.cp.dropped} patches dropped, ${out.cp.unres} unresolved${out.cp.bail ? '  bail ' + out.cp.bail : ''}`,
);
console.log(
  `  meshes ${out.cp.nMesh}, ${out.cp.nullMesh} NULL, ${out.cp.prim} RECOGNIZED PRIMITIVES (shapes ${out.cp.primIdx || '-'})`,
);
console.log(
  `  kind mask: mixed ${out.tMix ? out.tMix.mask : '?'}   one-engine ${out.tOne ? out.tOne.mask : '?'}`,
);
console.log(`Slug  : ${out.sl.draws}`);
console.log(`Fallback (no conversion awaited): ${out.fb.draws}  ${out.fb.built} shapes built`);
console.log(
  `  frame time, interleaved in one run: one engine ${out.tOne.ms.toFixed(2)} ms ${out.tOne.draws}` +
    `   mixed ${out.tMix.ms.toFixed(2)} ms ${out.tMix.draws}`,
);
// same RENDERER, same VIEWPORT, both ON THE GPU -- so framing cannot enter the answer. Slug is the
// reference the whole engine is measured against elsewhere; this asks what CPatch costs against it.
const A = out.cp.px,
  B = out.sl.px,
  F = out.fb.px,
  H = out.sh.px,
  D = out.hd.px,
  R = out.rj.px;
const lum = (p, i) => (p[i * 4] + p[i * 4 + 1] + p[i * 4 + 2]) / 3;
let solidXor = 0,
  both = 0,
  aaSum = 0,
  aaN = 0,
  aaMax = 0,
  over64 = 0,
  over16 = 0;
for (let i = 0; i < N * N; i++) {
  const a = lum(A, i),
    b = lum(B, i);
  const d = Math.abs(a - b);
  if (d > 16) over16++;
  if (d > 64) over64++;
  if (d > aaMax) aaMax = d;
  if ((a < 40 && b > 250) || (a > 250 && b < 40)) solidXor++;
  if (a < 250 || b < 250) {
    both++;
    aaSum += d;
    aaN++;
  }
}
console.log(`  ${both} painted px:  solid-vs-empty disagreements ${solidXor}`);
console.log(
  `  vs Slug: >16 ${over16}  >64 ${over64}  worst ${aaMax}  mean |d| ${(aaSum / Math.max(1, aaN)).toFixed(3)}`,
);
// EDGE OR FILL? An engine that estimates coverage differently can only move pixels within about a
// pixel of a boundary; a pixel deep inside a region Slug paints uniformly cannot be an AA
// difference. Boundaries come from the REFERENCE's own local range, so only where the edges are
// enters the classification.
let edgeD = 0,
  fillD = 0,
  fillMax = 0,
  fillLighter = 0,
  fillDarker = 0;
for (let j = 1; j < N - 1; j++)
  for (let i = 1; i < N - 1; i++) {
    const k = j * N + i;
    const d = Math.abs(lum(A, k) - lum(B, k));
    if (!(d > 64)) continue;
    let lo = 255,
      hi = 0;
    for (let dj = -1; dj <= 1; dj++)
      for (let di = -1; di <= 1; di++) {
        const v = lum(B, (j + dj) * N + (i + di));
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    if (hi - lo > 8) edgeD++;
    else {
      fillD++;
      if (d > fillMax) fillMax = d;
      if (lum(A, k) > lum(B, k)) fillLighter++;
      else fillDarker++;
    }
  }
console.log(
  `  of the >64: ${edgeD} sit on a Slug EDGE (AA), ${fillD} sit in flat Slug FILL (worst ${fillMax})`,
);
console.log(
  `  the flat-fill ones: ${fillLighter} where CPatch is LIGHTER (under-paint), ${fillDarker} DARKER`,
);
let fb16 = 0,
  fb64 = 0,
  fbFill = 0;
for (let j = 1; j < N - 1; j++)
  for (let i = 1; i < N - 1; i++) {
    const k = j * N + i,
      d = Math.abs(lum(F, k) - lum(B, k));
    if (d > 16) fb16++;
    if (!(d > 64)) continue;
    fb64++;
    let lo = 255,
      hi = 0;
    for (let dj = -1; dj <= 1; dj++)
      for (let di = -1; di <= 1; di++) {
        const v = lum(B, (j + dj) * N + (i + di));
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    if (!(hi - lo > 8)) fbFill++;
  }
console.log(
  `  the FALLBACK alone vs Slug: >16 ${fb16}  >64 ${fb64}, of which ${fbFill} in flat fill`,
);
// WHAT SHAPE IS THE UNDER-PAINT? A flat half is the signature of a constraint reading zero distance
// (f/|grad| underflowing, say); a spread is a coverage that is merely inaccurate. Measured against
// the background, so it is a coverage ratio rather than a color difference.
const bg = 255;
const hist = new Array(10).fill(0);
for (let j = 1; j < N - 1; j++)
  for (let i = 1; i < N - 1; i++) {
    const k = j * N + i,
      a = lum(A, k),
      b = lum(B, k);
    if (!(a - b > 64)) continue;
    let lo = 255,
      hi = 0;
    for (let dj = -1; dj <= 1; dj++)
      for (let di = -1; di <= 1; di++) {
        const v = lum(B, (j + dj) * N + (i + di));
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    if (hi - lo > 8) continue;
    const want = bg - b,
      got = bg - a; // coverage of the ink, 0..1 of Slug's
    const rr = want > 1 ? got / want : 1;
    hist[Math.max(0, Math.min(9, Math.floor(rr * 10)))]++;
  }
// WHERE is it? Contiguous means an indexing or capacity limit -- the run simply stops; scattered
// means a per-patch defect. A coarse tile map answers it without an image viewer.
{
  const T = 8,
    tile = new Array(T * T).fill(0);
  for (let j = 1; j < N - 1; j++)
    for (let i = 1; i < N - 1; i++) {
      const k = j * N + i;
      if (!(lum(A, k) - lum(B, k) > 64)) continue;
      let lo = 255,
        hi = 0;
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          const v = lum(B, (j + dj) * N + (i + di));
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      if (hi - lo > 8) continue;
      tile[(((j * T) / N) | 0) * T + (((i * T) / N) | 0)]++;
    }
  console.log('  missing-ink map (top row = top of the image), counts per 64px tile:');
  for (let r = T - 1; r >= 0; r--)
    console.log(
      '    ' + Array.from({ length: T }, (_, c) => String(tile[r * T + c]).padStart(6)).join(''),
    );
}
// OF THE MISSING INK: was the pixel reached by a CPatch quad at all?
{
  let reached = 0,
    unreached = 0;
  for (let j = 1; j < N - 1; j++)
    for (let i = 1; i < N - 1; i++) {
      const k = j * N + i;
      if (!(lum(A, k) - lum(B, k) > 64)) continue;
      let lo = 255,
        hi = 0;
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          const v = lum(B, (j + dj) * N + (i + di));
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      if (hi - lo > 8) continue;
      if (H[k * 4 + 3] > 2) reached++;
      else unreached++;
    }
  console.log(
    `  of the missing flat fill: ${reached} WERE reached by a CPatch quad (the kernel rejected them),` +
      ` ${unreached} were NOT reached by any quad`,
  );
}
// HOW MUCH OF THE SHAPE DO THE QUADS REACH AT ALL? Independent of any threshold: every pixel Slug
// inks, was it inside some CPatch cover quad? A quad that does not reach a pixel can never paint it,
// whatever the kernel does.
{
  let ink = 0,
    notReached = 0;
  for (let i = 0; i < N * N; i++) {
    if (!(lum(B, i) < 250)) continue; // Slug painted something here
    ink++;
    if (H[i * 4 + 3] <= 2) notReached++; // no CPatch quad covered it
  }
  console.log(
    `  quads reach ${((100 * (ink - notReached)) / Math.max(1, ink)).toFixed(2)}% of Slug's ink` +
      `  (${notReached} of ${ink} px reached by no quad)`,
  );
}
{
  let hardOk = 0,
    hardAlso = 0;
  for (let j = 1; j < N - 1; j++)
    for (let i = 1; i < N - 1; i++) {
      const k = j * N + i;
      if (!(lum(A, k) - lum(B, k) > 64)) continue;
      let lo = 255,
        hi = 0;
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          const v = lum(B, (j + dj) * N + (i + di));
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      if (hi - lo > 8) continue;
      if (Math.abs(lum(D, k) - lum(B, k)) <= 64) hardOk++;
      else hardAlso++;
    }
  console.log(
    `  of the missing flat fill: ${hardOk} come back under the HARD-STEP kernel (the signs are right,` +
      ` the DISTANCE loses them), ${hardAlso} are missing there too (the SIGN is wrong)`,
  );
}
// NAME A FEW OF THEM IN EM, so the CPU model can be asked about the same point.
{
  const vb = out.vb;
  const pick = [];
  for (let j = 1; j < N - 1 && pick.length < 6; j++)
    for (let i = 1; i < N - 1 && pick.length < 6; i++) {
      const k = j * N + i;
      if (!(lum(A, k) - lum(B, k) > 100)) continue;
      let lo = 255,
        hi = 0;
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          const v = lum(B, (j + dj) * N + (i + di));
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      if (hi - lo > 8) continue;
      if ((i + j) % 37) continue; // spread the samples out
      pick.push([i, j]);
    }
  console.log(`  viewBox ${vb ? JSON.stringify(vb) : '(none)'}`);
  console.log(
    `  sample missing pixels (x,y in the ${N}px frame): ${pick.map((q) => q.join(',')).join('  ')}`,
  );
}
{
  // Of the pixels Slug covers, how many does CPatch cover AT ALL (alpha), and how many does it
  // cover but paint a different color?
  const CA = out.cpA.px,
    SA = out.slA.px;
  let inked = 0,
    noAlpha = 0,
    wrongCol = 0;
  for (let i = 0; i < N * N; i++) {
    if (SA[i * 4 + 3] < 128) continue;
    inked++;
    if (CA[i * 4 + 3] < 128) {
      noAlpha++;
      continue;
    }
    const d = Math.max(
      Math.abs(CA[i * 4] - SA[i * 4]),
      Math.abs(CA[i * 4 + 1] - SA[i * 4 + 1]),
      Math.abs(CA[i * 4 + 2] - SA[i * 4 + 2]),
    );
    if (d > 64) wrongCol++;
  }
  console.log(
    `  of ${inked} px Slug covers: ${noAlpha} CPatch does NOT cover, ${wrongCol} it covers` +
      ` but paints a different COLOUR`,
  );
  // WHICH color? If it is another shape's fill, this is ordering or a shape index; if it is the
  // background or black, it is the paint lookup itself.
  const pairs = new Map();
  for (let i = 0; i < N * N; i++) {
    if (SA[i * 4 + 3] < 128 || CA[i * 4 + 3] < 128) continue;
    const d = Math.max(
      Math.abs(CA[i * 4] - SA[i * 4]),
      Math.abs(CA[i * 4 + 1] - SA[i * 4 + 1]),
      Math.abs(CA[i * 4 + 2] - SA[i * 4 + 2]),
    );
    if (d <= 64) continue;
    const key = `slug ${SA[i * 4]},${SA[i * 4 + 1]},${SA[i * 4 + 2]} -> cpatch ${CA[i * 4]},${CA[i * 4 + 1]},${CA[i * 4 + 2]}`;
    pairs.set(key, (pairs.get(key) | 0) + 1);
  }
  // EDGE OR INTERIOR? A color that differs where two shapes MEET is the two engines' AA blending
  // differently, which is expected between engines. A color that differs in flat interior is a
  // shape painted in the wrong one -- ordering.
  {
    let onEdge = 0,
      inFlat = 0;
    for (let j = 1; j < N - 1; j++)
      for (let i = 1; i < N - 1; i++) {
        const k = j * N + i;
        if (SA[k * 4 + 3] < 128 || CA[k * 4 + 3] < 128) continue;
        const d = Math.max(
          Math.abs(CA[k * 4] - SA[k * 4]),
          Math.abs(CA[k * 4 + 1] - SA[k * 4 + 1]),
          Math.abs(CA[k * 4 + 2] - SA[k * 4 + 2]),
        );
        if (d <= 64) continue;
        // FLAT OVER WHITE IS NOT FLAT. These two arms clear TRANSPARENT, so a pixel at the outline
        // of the whole artwork carries the engines' coverage difference in its premultiplied RGB --
        // while over white it is a pale pixel among pale pixels and reads as flat. Slug's own ALPHA
        // is the test that separates them: a fully covered neighbourhood is interior, and a
        // disagreement there is a different WINNER; anything else is the two engines' AA.
        let same = true;
        for (let dj = -1; dj <= 1 && same; dj++)
          for (let di = -1; di <= 1; di++) {
            const q = (j + dj) * N + (i + di);
            if (SA[q * 4 + 3] < 255 || Math.abs(lum(B, q) - lum(B, k)) > 8) {
              same = false;
              break;
            }
          }
        if (same) inFlat++;
        else onEdge++;
      }
    console.log(
      `  of those: ${onEdge} where Slug itself has an EDGE (the two engines' AA), ${inFlat} in flat interior (ORDER)`,
    );
  }
  // WHERE are the flat-interior ones? Concentrated means a few shapes; spread means a systematic
  // over-reach. Named in em so the model can be asked about the same points.
  {
    const T = 8,
      tile = new Array(T * T).fill(0);
    const pick = [];
    for (let j = 1; j < N - 1; j++)
      for (let i = 1; i < N - 1; i++) {
        const k = j * N + i;
        if (SA[k * 4 + 3] < 128 || CA[k * 4 + 3] < 128) continue;
        const d = Math.max(
          Math.abs(CA[k * 4] - SA[k * 4]),
          Math.abs(CA[k * 4 + 1] - SA[k * 4 + 1]),
          Math.abs(CA[k * 4 + 2] - SA[k * 4 + 2]),
        );
        if (d <= 64) continue;
        let same = true;
        for (let dj = -1; dj <= 1 && same; dj++)
          for (let di = -1; di <= 1; di++) {
            const q = (j + dj) * N + (i + di);
            if (SA[q * 4 + 3] < 255 || Math.abs(lum(B, q) - lum(B, k)) > 8) {
              same = false;
              break;
            }
          }
        if (!same) continue;
        tile[(((j * T) / N) | 0) * T + (((i * T) / N) | 0)]++;
        if (pick.length < 6 && (i * 7 + j) % 53 === 0) pick.push([i, j]);
      }
    console.log('  flat-interior wrong color, per 64px tile (top row = top of image):');
    for (let r2 = T - 1; r2 >= 0; r2--)
      console.log(
        '    ' + Array.from({ length: T }, (_, c) => String(tile[r2 * T + c]).padStart(5)).join(''),
      );
    console.log(`  samples (x,y in the ${N}px frame): ${pick.map((q) => q.join(',')).join('  ')}`);
  }
  // The same count with the depth claim forced OFF.
  {
    const D2 = out.cpNoDepth.px;
    let flat2 = 0;
    for (let j = 1; j < N - 1; j++)
      for (let i = 1; i < N - 1; i++) {
        const k = j * N + i;
        if (SA[k * 4 + 3] < 128 || D2[k * 4 + 3] < 128) continue;
        const d = Math.max(
          Math.abs(D2[k * 4] - SA[k * 4]),
          Math.abs(D2[k * 4 + 1] - SA[k * 4 + 1]),
          Math.abs(D2[k * 4 + 2] - SA[k * 4 + 2]),
        );
        if (d <= 64) continue;
        let same = true;
        for (let dj = -1; dj <= 1 && same; dj++)
          for (let di = -1; di <= 1; di++) {
            const q = (j + dj) * N + (i + di);
            if (SA[q * 4 + 3] < 255 || Math.abs(lum(B, q) - lum(B, k)) > 8) {
              same = false;
              break;
            }
          }
        if (same) flat2++;
      }
    console.log(`  with the depth claim FORCED OFF: ${flat2} flat-interior wrong color`);
  }
  console.log('  the commonest color swaps:');
  for (const [k, v] of [...pairs].sort((a, b) => b[1] - a[1]).slice(0, 6))
    console.log(`    ${String(v).padStart(6)}  ${k}`);
}
console.log("  CPatch coverage as a fraction of Slug's, over the under-painted flat fill:");
console.log(
  '    ' +
    hist.map((v, k) => `${(k / 10).toFixed(1)}-${((k + 1) / 10).toFixed(1)}:${v}`).join('  '),
);
