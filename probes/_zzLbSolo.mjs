// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzLbSolo — does admitting a DECLINED shape to Loop-Blinn paint outside ITS own path?
//
// The composited frame cannot answer this. A shape's over-paint can sit under a later shape and
// read as clean, so "no wrong pixels in tiger" is not "correct" -- it is "invisible in tiger", and
// the mesh is reused at any zoom in any composition. The audit's verdict has to be judged against
// the shape ALONE.
//
// Every other shape is made invisible (fill alpha 0) and the reference is built from the shape by
// itself, so a wrong pixel is unambiguous: ink where the path has none is OVER-PAINT, and that is
// the defect the audit exists to prevent. Shapes whose bounding boxes are DISJOINT are rendered
// together -- neither can hide the other, and attribution is by which box the pixel lands in -- so
// 84 shapes cost a dozen builds rather than 84.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { rowSpans } from '../src/renderer/cpatchConvert.js';
import { parseMetaBin } from '../src/core/metaBin.js';
import { buildLoopBlinnCDT } from '../src/renderer/loopBlinn.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = +(process.env.N || 512);
const SVGP = process.env.SVG || '../MantleSamples/Assets/Mantle/tiger.svg';
// An absolute SVG= is taken as given: a generated asset does not live under the repo.
const SVG = readFileSync(path.isAbsolute(SVGP) ? SVGP : path.join(ROOT, SVGP), 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
// __lbAuditOff is a test hook, read only under __MANTLE_DEBUG__.
const ARM = process.env.ARM || '__MANTLE_DEBUG__=true;__lbAuditOff=1';
const BAD = +(process.env.SOLID_BAD || 24);

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
import { parseMetaBin } from '/src/core/metaBin.js';
// The LB mesh cache is keyed by curve bytes and outlives the bundle, so a batch built with one
// configuration would hand its meshes -- and its Slug verdicts -- to the next.
import { clearLbMeshCaches } from '/src/renderer/morphDraw.js';
const cv=document.getElementById('c');
const gl=cv.getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const N=${N};
window.__run=async(svg,batches,cfg,clears,engine)=>{
  const out=[];
  for (let bi=0; bi<batches.length; bi++) {
    const keep=batches[bi], clear=clears[bi];
    for (const k of Object.keys(globalThis)) if (/^__(CP|MANTLE|LB|lb)/.test(k)) delete globalThis[k];
    for (const kv of cfg.split(';').filter(Boolean)) { const [a,b]=kv.split('=');
      // A strict !== false gate needs a BOOLEAN, not the string 'false'. (No backticks in here:
      // this whole page is a template literal, and one would end it mid-function.)
      globalThis[a] = (b === 'false' || b === 'true') ? (b === 'true') : (/^-?[0-9.]+$/.test(b) ? +b : b); }
    clearLbMeshCaches();
    const sec=await importSvg(svg,{preserveViewport:true});
    const mm=parseMetaBin(sec.meta, sec.metaFloatsPerShape);
    const MF=mm.metaFloats, ST=mm.floatsPerShape|0, ks=new Set(keep);
    // INVISIBLE, NOT ABSENT: zeroing fill alpha leaves the geometry, the ranges and every shape
    // index exactly as the real asset has them, so the shape under test builds and draws in the
    // bundle it actually ships in.
    for (let s=0;s<mm.numShapes;s++) if (!ks.has(s)) MF[s*ST+7]=0;
    const opts = engine==='cpatch' ? {cpatchFill:true, aacFill:false} : engine==='aac' ? {aacFill:true} : {};
    // RENDERER OPTIONS FROM THE ARM TOO ('opt.unifiedFillDepthClaim=0'), which is where the
    // draw-state switches live -- a global cannot reach them.
    for (const kv of cfg.split(';').filter(Boolean)) {
      if (!kv.startsWith('opt.')) continue;
      const [k3, v3] = kv.slice(4).split('=');
      opts[k3] = v3 === '0' ? false : v3 === '1' ? true : v3;
    }
    const r=createRenderer(gl,shaders,opts);
    if (r.setLoopBlinnFill) r.setLoopBlinnFill(engine==='lb'?'on':engine==='slug'?'off':'auto');
    const b=createBundle(gl,sec); if (r.prepareBundle) r.prepareBundle(b);
    if (engine==='cpatch'){ let w=0; const sl=(ms)=>new Promise((z)=>setTimeout(z,ms));
      while(b._cpatchConv==='pending' && w<60000){ await sl(5); w+=5; }
      if (r.prepareBundle) r.prepareBundle(b);
      while(b._cpatchConv==='pending' && w<60000){ await sl(5); w+=5; }
      if (r.prepareBundle) r.prepareBundle(b); }
    if (r.awaitLbReady) await r.awaitLbReady(b);
    r.setViewport(N,N); gl.viewport(0,0,N,N);
    // NOT WHITE. Tiger's whisker shapes ARE white, and a white shape over-painting a white
    // background is invisible -- which read as "this shape paints nothing outside its path" for
    // 48 of the 84 the audit declines, and very nearly bought a loosened audit. The clear colour
    // is chosen per batch to sit far from every colour drawn in it.
    r.beginFrame([clear[0]/255, clear[1]/255, clear[2]/255, 1]); r.drawBundle(b); r.endFrame();
    const p=new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,p);
    // DID THE ARM DO WHAT ITS NAME SAYS? A shape that quietly fell back to Slug renders CORRECTLY,
    // and a probe looking only at pixels would then report the Loop-Blinn mesh as clean when Loop-
    // Blinn never drew it. The per-shape route, not just the draw tally, is the evidence.
    const dr=(r.debugStats&&r.debugStats.engines&&r.debugStats.engines.draws)||{};
    const ms2=b._lbMeshes||[]; const routes=keep.map((s)=>{ if (engine!=='lb') return engine;
      const mm2=ms2[s]; return (!mm2 || mm2.slug===true) ? 'slug' : 'lb'; });
    if (!out.length) out.bbox=Array.from(b.globalBBox);
    out.meta=(out.meta||[]); out.meta.push({draws:JSON.stringify(dr), routes});
    b.dispose();
    let s2=''; for(let i=0;i<p.length;i+=4096) s2+=String.fromCharCode.apply(null,p.subarray(i,i+4096));
    out.push(btoa(s2));
  }
  return {frames: out, bbox: out.bbox, meta: out.meta};
};
</script></body></html>`;

const srv = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  if (u === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(HTML);
  }
  try {
    const p = path.join(ROOT, u);
    if (!p.startsWith(ROOT)) throw new Error('esc');
    const body = readFileSync(p);
    res.writeHead(200, {
      'content-type': u.endsWith('.js') || u.endsWith('.mjs') ? 'text/javascript' : 'text/plain',
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('no');
  }
});
await new Promise((z) => srv.listen(0, z));

// ---- geometry, bounding boxes and the batching ----
const sec = await importSvg(SVG, { preserveViewport: true });
const cf = sec.curves64 ? new Float64Array(sec.curves64) : new Float32Array(sec.curves);
const meta = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
const MF = meta.metaFloats,
  ST = meta.floatsPerShape | 0;
const shapes = new Map();
for (let s = 0; s < meta.numShapes; s++) {
  const o = s * ST,
    r = sec.curveRangesByShape && sec.curveRangesByShape[s];
  if (!r || !(MF[o + 7] > 0)) continue;
  let cs = null;
  try {
    cs = contoursToConverter(curveRangeToContours(cf, r.begin | 0, r.end | 0), null);
  } catch {
    continue;
  }
  if (!cs || !cs.length) continue;
  const all = [];
  for (const c of cs) for (const sg of c) all.push(sg);
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const sg of all)
    for (const P of sg.P) {
      if (P[0] < x0) x0 = P[0];
      if (P[0] > x1) x1 = P[0];
      if (P[1] < y0) y0 = P[1];
      if (P[1] > y1) y1 = P[1];
    }
  shapes.set(s, {
    i: s,
    segs: all,
    rgb: [MF[o + 4] * 255, MF[o + 5] * 255, MF[o + 6] * 255],
    a: MF[o + 7],
    bb: [x0, y0, x1, y1],
  });
}
const WANT = (process.env.SHAPES || '')
  .split(',')
  .filter(Boolean)
  .map(Number)
  .filter((s) => shapes.has(s));
if (!WANT.length) {
  console.log('SHAPES= is empty (nothing to test)');
  srv.close();
  process.exit(0);
}

// The over-paint of a shape can land well outside its own box, so the boxes are dilated before the
// disjointness test and a pixel is attributed only when exactly one dilated box contains it.
const PAD = +(process.env.PAD || 0.02); // of the asset's diagonal
const gb = [Infinity, Infinity, -Infinity, -Infinity];
for (const s of WANT) {
  const b = shapes.get(s).bb;
  gb[0] = Math.min(gb[0], b[0]);
  gb[1] = Math.min(gb[1], b[1]);
  gb[2] = Math.max(gb[2], b[2]);
  gb[3] = Math.max(gb[3], b[3]);
}
const pad = PAD * Math.hypot(gb[2] - gb[0], gb[3] - gb[1]);
const box = (s) => {
  const b = shapes.get(s).bb;
  return [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
};
const hits = (a, b) => !(a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]);
const batches = [];
// SOLO1: one shape per batch, and then every pixel of the frame is judged against that shape --
// no box gating at all. Batching is an optimization that costs reach: over-paint landing beyond
// the dilated box is attributed to nobody and silently drops out of the count, which is the one
// way this probe could call a shape clean that is not.
// KEEP: one batch holding exactly the named shapes, overlapping or not. Batching normally
// separates shapes whose boxes overlap, which is the right default for attribution and the wrong
// one for asking what two shapes do to each OTHER -- a defect that appears only in the composite
// has to be reproducible with the smallest composite that shows it.
if (process.env.KEEP) batches.push(WANT.slice());
else if (process.env.SOLO1) {
  for (const s of WANT) batches.push([s]);
} else
  for (const s of WANT) {
    let placed = false;
    for (const g of batches)
      if (g.every((t) => !hits(box(s), box(t)))) {
        g.push(s);
        placed = true;
        break;
      }
    if (!placed) batches.push([s]);
  }
console.log(`${WANT.length} shapes in ${batches.length} disjoint batches`);

const browser = await launchBrowser({
  headless: 'new',
  protocolTimeout: 1800000,
  args: ['--use-gl=angle', '--use-angle=metal', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR ' + e.message));
await page.goto(`http://127.0.0.1:${srv.address().port}/`, { waitUntil: 'networkidle0' });
await page.waitForFunction('!!window.__run', { timeout: 120000 });
// A clear color far from every shape in the batch: the best of a few extremes, by the largest
// minimum channel distance. With one shape per batch this is simply the color it contrasts most.
const PAL = [
  [0, 0, 0],
  [255, 255, 255],
  [255, 0, 255],
  [0, 255, 255],
  [255, 255, 0],
];
const clears = batches.map((g) => {
  let best = PAL[0],
    bestD = -1;
  for (const c of PAL) {
    let d = Infinity;
    for (const s of g) {
      const r2 = shapes.get(s).rgb;
      d = Math.min(
        d,
        Math.max(Math.abs(c[0] - r2[0]), Math.abs(c[1] - r2[1]), Math.abs(c[2] - r2[2])),
      );
    }
    if (d > bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
});
const ENGINE = process.env.ENGINE || 'lb';
const got = await page.evaluate(
  (s, b, c, cl, e) => window.__run(s, b, c, cl, e),
  SVG,
  batches,
  ARM,
  clears,
  ENGINE,
);
await browser.close();
srv.close();

const bb = got.bbox;
const _sAR = bb[2] / bb[3];
const arX = _sAR > 1 ? 1 : _sAR,
  arY = _sAR > 1 ? 1 / _sAR : 1;
const emX = (i) => bb[0] + ((((2 * (i + 0.5)) / N - 1) / arX + 1) / 2) * bb[2];
const emY = (j) => bb[1] + ((1 - ((2 * (j + 0.5)) / N - 1) / arY) / 2) * bb[3];
const SCX = bb[2] / (arX * N),
  SCY = bb[3] / (arY * N),
  SC = Math.max(SCX, SCY);
const GL5 = [
  [-0.906179845938664, 0.2369268850561891],
  [-0.5384693101056831, 0.4786286704993665],
  [0, 0.5688888888888889],
  [0.5384693101056831, 0.4786286704993665],
  [0.906179845938664, 0.2369268850561891],
];

const over = new Map(),
  under = new Map(),
  worstAt = new Map(),
  missAt = new Map(),
  cov = new Map();
const TRN = Array.from({ length: 10 }, () => ({ n: 0, sum: 0, zero: 0, zin: 0, zout: 0 }));
const routeOf = new Map();
for (let bi = 0; bi < batches.length; bi++) {
  const mt = got.meta && got.meta[bi];
  if (mt) batches[bi].forEach((s, k) => routeOf.set(s, mt.routes[k]));
}
// AND DID IT actually DRAW? The per-shape route above is a BUILD-side fact -- it says Loop-Blinn
// produced a mesh for this shape, not that Loop-Blinn put it on the screen. A shader that fails to
// link falls the whole bundle back to Slug at DRAW time with every mesh still marked 'lb', and the
// frame then measures beautifully because it is Slug's: this probe once reported "0 of 4 shapes
// put ink outside their own path" and a threefold drop in rim error for a broken LB program. The
// draw tally is the second half of the evidence and it is not optional.
{
  const want = process.env.ENGINE || 'lb';
  const need = want === 'lb' ? 'lb' : want;
  const bad = [];
  for (let bi = 0; bi < batches.length; bi++) {
    const mt = got.meta && got.meta[bi];
    if (!mt) continue;
    const dr = JSON.parse(mt.draws || '{}');
    const drew = batches[bi].some((s) => routeOf.get(s) === want);
    if (drew && !(dr[need] > 0)) bad.push(`batch ${bi} drew ${JSON.stringify(dr)}`);
  }
  if (bad.length) {
    console.log(
      `DID NOT DRAW WITH ${need.toUpperCase()} — ${bad[0]}${bad.length > 1 ? ` (and ${bad.length - 1} more)` : ''}.`,
    );
    console.log(
      'Numbers withheld; this run measured a different engine. A shader that fails to link does this.',
    );
    process.exit(1);
  }
}
const slugged = WANT.filter((s) => routeOf.get(s) !== (process.env.ENGINE || 'lb'));
if (slugged.length)
  console.log(
    `NOT ON ${(process.env.ENGINE || 'lb').toUpperCase()} (their pixels prove nothing): ${slugged.join(',')}`,
  );
for (let bi = 0; bi < batches.length; bi++) {
  const keep = batches[bi],
    px = Buffer.from(got.frames[bi], 'base64'),
    CLR = clears[bi];
  const boxes = keep.map((s) => ({ s, b: box(s) }));
  for (let j = 0; j < N; j++) {
    const cy = emY(j);
    for (let i = 0; i < N; i++) {
      const cx = emX(i);
      // Which shape owns this pixel? Exactly one dilated box, or nobody.
      let own = -1,
        nOwn = 0;
      if (boxes.length === 1) {
        own = boxes[0].s;
        nOwn = 1;
      } else
        for (const { s, b } of boxes)
          if (cx >= b[0] && cx <= b[2] && cy >= b[1] && cy <= b[3]) {
            own = s;
            nOwn++;
          }
      if (nOwn !== 1) continue;
      const sh = shapes.get(own);
      // OUTSIDE THE SHAPE'S own BOX THE PATH COVERS nothing, exactly, so the row spans need not be
      // asked -- and asking them at every pixel of a 2048^2 frame is what made this unusable at the
      // resolutions that matter. Ink out here is over-paint by definition.
      const tb = sh.bb;
      let a;
      if (cx < tb[0] - SCX || cx > tb[2] + SCX || cy < tb[1] - SCY || cy > tb[3] + SCY) a = 0;
      else {
        let t = 0;
        for (const [q, w] of GL5) {
          const y = cy + 0.5 * SCY * q;
          let c2 = 0;
          for (const sp of rowSpans(sh.segs, y) || [])
            c2 += Math.max(0, Math.min(cx + SCX / 2, sp[1]) - Math.max(cx - SCX / 2, sp[0]));
          t += (w * 0.5 * c2) / SCX;
        }
        a = Math.min(1, Math.max(0, t)) * sh.a;
      }
      // Only pixels the path answers WITHOUT ambiguity are judged: a = 0 is outside, a = 1 is
      // inside, and the antialiased rim in between is not what this probe is about.
      const q4 = (j * N + i) * 4;
      if (a <= 0) {
        const d = Math.max(
          Math.abs(px[q4] - CLR[0]),
          Math.abs(px[q4 + 1] - CLR[1]),
          Math.abs(px[q4 + 2] - CLR[2]),
        );
        if (d > BAD) {
          over.set(own, (over.get(own) || 0) + 1);
          if (d > (worstAt.get(own) || [0])[0]) worstAt.set(own, [d, i, j, cx, cy]);
        }
      } else if (a >= 0.999) {
        const d = Math.max(
          Math.abs(px[q4] - sh.rgb[0]),
          Math.abs(px[q4 + 1] - sh.rgb[1]),
          Math.abs(px[q4 + 2] - sh.rgb[2]),
        );
        if (d > BAD) {
          under.set(own, (under.get(own) || 0) + 1);
          if (d > (missAt.get(own) || [0])[0]) missAt.set(own, [d, i, j, cx, cy]);
        }
      } else {
        // PARTIAL COVERAGE, recovered from the pixel. One shape on a contrasting ground composites
        // as clear + (fill - clear)*cov, so the coverage the engine produced is readable per
        // channel and comparable with the exact one -- which is the only way to see an
        // over-COVERED thin feature: it lands where the path does cover the pixel, just not fully,
        // so an over-PAINT count (which judges only a == 0) steps right over it.
        let got = null;
        for (let ch = 0; ch < 3; ch++) {
          const den = sh.rgb[ch] - CLR[ch];
          if (Math.abs(den) < 64) continue; // this channel cannot resolve coverage
          got = (px[q4 + ch] - CLR[ch]) / den;
          break;
        }
        if (got != null) {
          // THE TRANSFER CURVE: the coverage the engine produced against the coverage the path
          // says, binned. A count of bad rim pixels cannot tell a uniformly soft edge from an edge
          // that is simply CUT, and the two need opposite fixes. If the geometry reaches only
          // pixels whose centers are inside, everything below 0.5 reads near zero and the curve
          // has a step in it; if the AA is merely imprecise, it is a diagonal with scatter.
          const tb = Math.min(9, Math.max(0, Math.floor(a * 10)));
          const gg = Math.min(1, Math.max(0, got));
          TRN[tb].n++;
          TRN[tb].sum += gg;
          if (gg < 0.02) {
            TRN[tb].zero++;
            // WHICH SIDE the dropped pixel's center is on. An engine whose geometry stops at the
            // outline can only shade pixels whose CENTER is inside it, so every pixel the path
            // covers from the outside is lost outright. If the drops are center-outside, the band
            // is one-sided and the fix is to extend it; if they are center-inside, the geometry
            // has a hole and the fix is a different one entirely.
            let ins = false;
            for (const sp of rowSpans(sh.segs, cy) || [])
              if (cx >= sp[0] && cx <= sp[1]) {
                ins = true;
                break;
              }
            if (ins) TRN[tb].zin++;
            else TRN[tb].zout++;
          }
          const e = Math.abs(Math.min(1, Math.max(0, got)) - a);
          const cur = cov.get(own) || { sum: 0, n: 0, max: 0, at: null };
          cur.sum += e;
          cur.n++;
          if (e > cur.max) {
            cur.max = e;
            cur.at = [i, j, a, got];
          }
          cov.set(own, cur);
        }
      }
    }
  }
}
// THE CONDEMNED SAMPLES THEMSELVES, read off the frame. The audit names exact points it believes
// the mesh paints; the shape alone is on screen; so the pixel under each point settles it.
if (process.env.POINTS) {
  globalThis.__lbAuditTrace = 1;
  globalThis.__MANTLE_DEBUG__ = true;
  globalThis.__lbAuditOff = 1;
  const pxOf = (x) => Math.round((((((x - bb[0]) / bb[2]) * 2 - 1) * arX + 1) / 2) * N - 0.5);
  const pyOf = (y) => Math.round((((1 - ((y - bb[1]) / bb[3]) * 2) * arY + 1) / 2) * N - 0.5);
  for (let bi = 0; bi < batches.length; bi++) {
    if (batches[bi].length !== 1) continue;
    const s = batches[bi][0];
    if (routeOf.get(s) !== (process.env.ENGINE || 'lb')) continue;
    const r = sec.curveRangesByShape[s];
    const evenOdd = MF[s * ST + 13] > 0.5;
    globalThis.__lbAuditBad = [];
    try {
      buildLoopBlinnCDT(curveRangeToContours(cf, r.begin | 0, r.end | 0), {
        fillRule: evenOdd ? 'evenodd' : 'nonzero',
      });
    } catch {}
    const bad = (globalThis.__lbAuditBad || []).slice(0, +(process.env.POINTS_N || 6));
    if (!bad.length) continue;
    const px = Buffer.from(got.frames[bi], 'base64');
    const CLR = clears[bi];
    const sh = shapes.get(s);
    console.log(`  s${s} condemned samples, as rendered:`);
    for (const b2 of bad) {
      const i = pxOf(b2.p[0]),
        j = pyOf(b2.p[1]);
      if (i < 0 || i >= N || j < 0 || j >= N) {
        console.log(`    (${b2.p[0].toFixed(2)},${b2.p[1].toFixed(2)}) -> off-canvas`);
        continue;
      }
      const q4 = (j * N + i) * 4;
      const sp = rowSpans(sh.segs, b2.p[1]) || [];
      let inside = false;
      for (const [a2, b3] of sp) if (b2.p[0] >= a2 && b2.p[0] <= b3) inside = true;
      console.log(
        `    (${b2.p[0].toFixed(2)},${b2.p[1].toFixed(2)}) px(${i},${j}) frame rgb(${px[q4]},${px[q4 + 1]},${px[q4 + 2]}) vs clear rgb(${CLR.join(',')})  path says ${inside ? 'INK' : 'air'}  kind ${b2.kind}`,
      );
    }
  }
}
// THE RAW PIXEL, per batch, with no attribution at all. Over-paint is normally charged to a shape
// by which box it lands in, and with KEEP that test is useless -- overlapping boxes mean most
// pixels are attributed to nobody. But a defect that only appears in a COMPOSITE has to be
// bisected against the set of shapes drawn, and for that all that is needed is what color came
// out at one named pixel.
if (process.env.PIXAT) {
  const [ix, jy] = process.env.PIXAT.split(',').map(Number);
  for (let bi = 0; bi < batches.length; bi++) {
    const px = Buffer.from(got.frames[bi], 'base64'),
      q4 = (jy * N + ix) * 4;
    const CLR = clears[bi];
    const d = Math.max(
      Math.abs(px[q4] - CLR[0]),
      Math.abs(px[q4 + 1] - CLR[1]),
      Math.abs(px[q4 + 2] - CLR[2]),
    );
    console.log(
      `  PIXAT batch ${bi} (${batches[bi].length} shapes: ${batches[bi].slice(0, 12).join(',')}${batches[bi].length > 12 ? '...' : ''})` +
        `  rgb(${px[q4]},${px[q4 + 1]},${px[q4 + 2]}) vs clear rgb(${CLR.join(',')})  d=${d}`,
    );
  }
}
// THE SHAPE OF THE DEFECT, as a map. A count says how much wrong ink there is; where it sits
// relative to the path says what put it there -- a crescent beyond one arc, a band along an edge,
// or a whole region on the wrong side of a boundary are three different bugs.
if (process.env.MAP) {
  const want = new Set(process.env.MAP.split(',').map(Number));
  for (let bi = 0; bi < batches.length; bi++) {
    for (const s of batches[bi]) {
      if (!want.has(s)) continue;
      const px = Buffer.from(got.frames[bi], 'base64'),
        CLR = clears[bi],
        sh = shapes.get(s);
      // MAP_MISS centers the map on the worst MISSING pixel instead of the worst over-paint --
      // a hole and a spill are different defects and the map has to be able to show either.
      // MAP_AT centers the map on a NAMED pixel. The worst pixel is the right default, but a
      // defect found in the composite has coordinates of its own and the question is what this
      // shape does there -- which is not necessarily where its own worst pixel is.
      const w = process.env.MAP_AT
        ? [0, ...process.env.MAP_AT.split(',').map(Number)]
        : process.env.MAP_MISS
          ? missAt.get(s) || worstAt.get(s)
          : worstAt.get(s);
      if (!w) {
        console.log(`  s${s}: nothing to map`);
        continue;
      }
      const R = +(process.env.MAP_R || 28);
      console.log(
        `  s${s} around its worst over-paint @(${w[1]},${w[2]})  '#'=wrong ink  'O'=HOLE  '+'=shape ink  '.'=clear`,
      );
      for (let j = Math.min(N - 1, w[2] + R); j >= Math.max(0, w[2] - R); j--) {
        let line = '';
        for (let i = Math.max(0, w[1] - R); i <= Math.min(N - 1, w[1] + R); i++) {
          const cy = emY(j),
            cx = emX(i),
            q4 = (j * N + i) * 4;
          const tb = sh.bb;
          let a2 = 0;
          if (!(cx < tb[0] - SCX || cx > tb[2] + SCX || cy < tb[1] - SCY || cy > tb[3] + SCY)) {
            let t = 0;
            for (const [q, ww] of GL5) {
              const y = cy + 0.5 * SCY * q;
              let c2 = 0;
              for (const sp of rowSpans(sh.segs, y) || [])
                c2 += Math.max(0, Math.min(cx + SCX / 2, sp[1]) - Math.max(cx - SCX / 2, sp[0]));
              t += (ww * 0.5 * c2) / SCX;
            }
            a2 = Math.min(1, Math.max(0, t)) * sh.a;
          }
          const d = Math.max(
            Math.abs(px[q4] - CLR[0]),
            Math.abs(px[q4 + 1] - CLR[1]),
            Math.abs(px[q4 + 2] - CLR[2]),
          );
          // 'O' is a HOLE: the path covers the pixel whole and the frame did not paint it. Without
          // it a dropped pixel is drawn as ink and the map shows a clean shape.
          const dInk = Math.max(
            Math.abs(px[q4] - sh.rgb[0]),
            Math.abs(px[q4 + 1] - sh.rgb[1]),
            Math.abs(px[q4 + 2] - sh.rgb[2]),
          );
          line += a2 <= 0 ? (d > BAD ? '#' : '.') : a2 >= 0.999 ? (dInk > BAD ? 'O' : '+') : ':';
        }
        console.log('   ' + line);
      }
    }
  }
}
if (process.env.RAWPT) {
  // The frame's raw channels at explicit em points -- used with the kind-4 debug output, where
  // red carries the signed distance, green the curvature term and BLUE the coverage the kernel
  // actually computed.
  for (let bi = 0; bi < batches.length; bi++) {
    if (batches[bi].length !== 1) continue;
    const px = Buffer.from(got.frames[bi], 'base64');
    for (const q of process.env.RAWPT.split(' ')) {
      const [ex, ey] = q.split(',').map(Number);
      const i = Math.round((((((ex - bb[0]) / bb[2]) * 2 - 1) * arX + 1) / 2) * N - 0.5);
      const j = Math.round((((1 - ((ey - bb[1]) / bb[3]) * 2) * arY + 1) / 2) * N - 0.5);
      if (i < 0 || i >= N || j < 0 || j >= N) {
        console.log(`  em(${ex},${ey}) off-canvas`);
        continue;
      }
      const o = (j * N + i) * 4;
      console.log(
        `  em(${ex},${ey}) px(${i},${j}) raw rgba(${px[o]},${px[o + 1]},${px[o + 2]},${px[o + 3]})` +
          `   -> signed dist ${((px[o] / 255 - 0.5) / 0.25).toFixed(3)} px, kernel cov ${(px[o + 2] / 255).toFixed(3)}`,
      );
    }
  }
}
console.log(
  'COVERAGE TRANSFER (what the path says -> what the engine drew), over every rim pixel:',
);
for (let b = 0; b < 10; b++) {
  const t = TRN[b];
  console.log(
    `  path ${(b / 10).toFixed(1)}-${((b + 1) / 10).toFixed(1)}  n=${String(t.n).padStart(6)}  ` +
      `mean drawn ${t.n ? (t.sum / t.n).toFixed(3) : '  -  '}   drew NOTHING at all: ` +
      `${t.n ? ((100 * t.zero) / t.n).toFixed(0) : '-'}%` +
      (t.zero ? `  (centre outside the path ${t.zout}, inside ${t.zin})` : ''),
  );
}
const rows = WANT.filter((s) => routeOf.get(s) === (process.env.ENGINE || 'lb'))
  .map((s) => ({ s, o: over.get(s) || 0, u: under.get(s) || 0 }))
  .sort((a, b) => b.o - a.o || b.u - a.u);
const guilty = rows.filter((r) => r.o > 0),
  clean = rows.filter((r) => r.o === 0);
console.log(
  `OVER-PAINT alone: ${guilty.length} of ${rows.length} ${(process.env.ENGINE || 'lb').toUpperCase()}-routed shapes put ink outside their own path`,
);
for (const r of guilty.slice(0, +(process.env.TOP || 20))) {
  const w = worstAt.get(r.s);
  console.log(
    `  s${r.s}: ${r.o} px outside${r.u ? `, ${r.u} px missing` : ''}${w ? `   worst d=${w[0]} @(${w[1]},${w[2]}) em(${w[3].toFixed(2)},${w[4].toFixed(2)})` : ''}`,
  );
}
console.log(`CLEAN alone (${clean.length}): ${clean.map((r) => r.s).join(',')}`);
// Coverage accuracy on the antialiased rim, per shape, worst first.
const cr = [...cov]
  .map(([s, v]) => ({ s, mean: v.sum / Math.max(1, v.n), max: v.max, n: v.n, at: v.at }))
  .sort((a2, b2) => b2.max - a2.max);
if (cr.length) {
  console.log(`COVERAGE on the rim (exact vs rendered):`);
  for (const r of cr.slice(0, +(process.env.TOP || 12)))
    console.log(
      `  s${r.s}: max ${r.max.toFixed(3)} mean ${r.mean.toFixed(4)} over ${r.n} px` +
        (r.at
          ? `   worst @(${r.at[0]},${r.at[1]}) path ${r.at[2].toFixed(3)} -> got ${r.at[3].toFixed(3)}`
          : ''),
    );
}
const misses = clean.filter((r) => r.u > 0);
if (misses.length)
  console.log(
    `  of those, ${misses.length} UNDER-fill: ${misses.map((r) => `s${r.s}:${r.u}`).join(' ')}`,
  );
