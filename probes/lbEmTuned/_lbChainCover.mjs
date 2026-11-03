// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _lbChainCover — is the mesh the em-tuned-length fix produced CORRECT at scale 1?
//
// Commit "the hull chain's flatness budget is a fraction of the shape" moved 70 shapes' meshes at
// scale 1. Nothing about the triangulation moved (every one of them keeps its vertex count exactly):
// what moved is `n`, the number of pieces each curve hull's boundary polyline is cut into, and
// therefore the CHAIN each interior face clips against to compute its own coverage
// (_boxCov.glsl chainBoxCov: "area(pixel box INTERSECT fill), fill = LEFT of the local outline
// chain"). So the question "is the em-tuned mesh correct?" is exactly: how far is its polyline from
// the true curve, against how far the absolute-tolerance polyline is.
//
// This probe answers it two ways.
//
//   DEVIATION  For every hull, the true rational-quadratic arc is sampled and the maximum distance
//              from it to the n-piece polyline is measured, before and after, in em and in pixels
//              at the 512-px raster these assets are authored and reviewed at (the same nominal
//              raster cpatchCov's coverageMiss uses). This is the exact geometric quantity that
//              bounds the coverage error: a chain that misplaces the outline by d can misplace a
//              pixel's coverage by at most d / pixelSize, because the disagreement is a strip of
//              width d across the box.
//
//   COVERAGE   The same miss / over / thin contract coverageMiss defines, at 1024^2, on the OUTLINE
//              THE INTERIOR FACES SEE: the shape's own contours with each hull's arc replaced by
//              its chain polyline.
//                miss  ink the polyline outline does not reach   (center sample, |d| > half a pixel)
//                over  ink outside the true contour              (same)
//                thin  mean coverage shortfall over the interior (4x4 box supersampling)
//              SCOPE, stated because a number without its scope is worse than none: the crescents
//              (kind 5 / cubic hull triangles) cover the region between the chord and the arc and
//              are byte-identical before and after, so on a CONVEX hull -- where the chain runs
//              inside the arc -- this model's `miss` is an UPPER bound on ink the chain route drops
//              and the unchanged crescent then paints it. `over` on a CONCAVE hull is the honest
//              one: there the chain runs outside the arc and nothing else pulls it back.
//
//   node probes/lbEmTuned/_lbChainCover.mjs [--full] [file.svg#shape ...]
//     --full   run the 1024^2 coverage model too (slow; the deviation table alone is the bound)
//     N=1024   raster for the coverage model
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
const { default: importSvg } = await import('../../src/svg/importer.js');
const { curveRangeToContours, rayWinding } = await import('../../src/geom/lbContour.js');
const { buildLbShape } = await import('../../src/renderer/lbBuildCore.js');
const { parseMetaBin } = await import('../../src/core/metaBin.js');
const { SEG_QUAD, SEG_RQUAD, mkLine } = await import('../../src/primitives/seg.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const _warn = console.warn;
if (!process.env.WARN) console.warn = () => {};
const args = process.argv.slice(2);
const FULL = args.includes('--full');
const want = args.filter((a) => !a.startsWith('--'));
const N = +(process.env.N || 1024);
const OLD_TOL = 0.00025; // the absolute constant sag/n^2 is compared against in the baseline arm

// ---------------------------------------------------------------- the arc and its polyline
const qAt = (a, c, b, w, t) => {
  const u = 1 - t,
    den = u * u + 2 * u * t * w + t * t;
  return [
    (u * u * a[0] + 2 * u * t * w * c[0] + t * t * b[0]) / den,
    (u * u * a[1] + 2 * u * t * w * c[1] + t * t * b[1]) / den,
  ];
};
const polyOf = (h, n) => {
  const P = [h.a];
  for (let i = 1; i < n; i++) P.push(qAt(h.a, h.c, h.b, h.w, i / n));
  P.push(h.b);
  return P;
};
const nFor = (sag, tol, cap = 64) => {
  let n = 2;
  while (n < cap && sag / (n * n) > tol) n *= 2;
  return n;
};
const pSeg = (px, py, ax, ay, bx, by) => {
  const ex = bx - ax,
    ey = by - ay,
    L2 = ex * ex + ey * ey;
  let t = L2 > 0 ? ((px - ax) * ex + (py - ay) * ey) / L2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - ax - t * ex, py - ay - t * ey);
};
/// Max distance from the TRUE arc to the polyline (256 samples along the arc; the maximum sits at a
/// piece's own midpoint, which the sampling straddles at every n up to the cap).
const devOf = (h, P) => {
  let m = 0;
  for (let s = 0; s <= 256; s++) {
    const q = qAt(h.a, h.c, h.b, h.w, s / 256);
    let d = Infinity;
    for (let i = 0; i + 1 < P.length; i++)
      d = Math.min(d, pSeg(q[0], q[1], P[i][0], P[i][1], P[i + 1][0], P[i + 1][1]));
    if (d > m) m = d;
  }
  return m;
};

// ---------------------------------------------------------------- the polygonalized contour
/// The shape's contours with every hull arc replaced by ITS chain polyline: the outline an interior
/// face's chain actually clips against. Hulls are matched to segments by their endpoints.
function polygonalize(contours, hulls, n) {
  const kOf = (p) => p[0].toExponential(9) + ',' + p[1].toExponential(9);
  const byEnds = new Map();
  for (const h of hulls) byEnds.set(kOf(h.a) + '|' + kOf(h.b), h);
  const out = [];
  for (const c of contours) {
    const segs = [];
    for (const sg of c) {
      if (sg.type === SEG_QUAD || sg.type === SEG_RQUAD) {
        const h =
          byEnds.get(kOf(sg.p1) + '|' + kOf(sg.p3)) || byEnds.get(kOf(sg.p3) + '|' + kOf(sg.p1));
        if (h) {
          const P = polyOf(h, n(h));
          for (let i = 0; i + 1 < P.length; i++) segs.push(mkLine(P[i], P[i + 1])); // mkLine, not a literal: rayWinding reads fields only the builder sets
          continue;
        }
      }
      segs.push(sg);
    }
    out.push(segs);
  }
  return out;
}
const windOf = (cs, x, y, evenOdd) => {
  let w = 0;
  for (const c of cs) w += rayWinding(c, x, y);
  return evenOdd ? (w & 1) !== 0 : w !== 0;
};

// ---------------------------------------------------------------- corpus
let files = want.length ? [...new Set(want.map((w) => w.split('#')[0]))] : null;
if (!files) {
  const dir = (d) =>
    existsSync(path.join(ROOT, d))
      ? readdirSync(path.join(ROOT, d))
          .filter((f) => f.endsWith('.svg'))
          .sort()
          .map((f) => d + '/' + f)
      : [];
  files = [...dir('examples'), ...dir('examples/smoke')];
}
const only = want.length ? new Set(want.filter((w) => w.includes('#'))) : null;

const rows = [];
for (const f of files) {
  let svg;
  try {
    svg = readFileSync(path.resolve(ROOT, f), 'utf8');
  } catch {
    continue;
  }
  // The same import probes/_lbMeshCensus.mjs uses -- strokes kept, viewport not preserved -- so the
  // shape indices here are the ones its moved-shape list names. STRIP=1 takes _zzScaleWide's instead.
  if (process.env.STRIP)
    svg = svg
      .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
      .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
  let sec;
  try {
    sec = await importSvg(svg, process.env.STRIP ? { preserveViewport: true } : undefined);
  } catch {
    continue;
  }
  if (!sec || !sec.curves || !sec.numShapes) continue;
  const meta = parseMetaBin(sec.meta, sec.metaFloatsPerShape),
    fps = meta.floatsPerShape,
    mf = meta.metaFloats;
  const p32 = new Float32Array(sec.curves);
  for (let s = 0; s < meta.numShapes; s++) {
    if (only && !only.has(f + '#' + s)) continue;
    const r = (sec.curveRangesByShape || [])[s];
    // NO fill-alpha gate: probes/_lbMeshCensus.mjs builds every shape with a curve range, and its
    // shape numbering is what the moved-shape list is written in.
    if (!r || r.end <= r.begin) continue;
    const bb = s * fps;
    const transSolid =
      mf[bb + 7] < 0.996 &&
      Math.floor(mf[bb + 28] + 0.5) === 0 &&
      (fps < 36 || Math.floor(mf[bb + 35] + 0.5) === 0);
    const evenOdd = mf[bb + 13] > 0.5;
    const cs = curveRangeToContours(p32, r.begin, r.end);
    if (!cs) continue;
    const hulls = [];
    globalThis.__LB_HULLDUMP = (h) => hulls.push(h);
    try {
      buildLbShape(cs, transSolid, evenOdd);
    } catch {
      /* the build's own failures are not this probe's subject */
    }
    globalThis.__LB_HULLDUMP = null;
    if (!hulls.length) continue;
    const span = hulls[0].span,
      px = span / 512;
    let devOld = 0,
      devNew = 0,
      moved = 0,
      capNew = 0,
      capOld = 0,
      dArea = 0;
    for (const h of hulls) {
      const nO = nFor(h.sag, OLD_TOL),
        nN = h.n;
      if (nO !== nN) moved++;
      if (nN >= 64) capNew++;
      if (nO >= 64) capOld++;
      const dO = devOf(h, polyOf(h, nO)),
        dN = devOf(h, polyOf(h, nN));
      if (dO > devOld) devOld = dO;
      if (dN > devNew) devNew = dN;
      // area between polyline and arc, both sides: ~ (2/3) * chord * sagitta per piece
      const chord = Math.hypot(h.b[0] - h.a[0], h.b[1] - h.a[1]);
      dArea += Math.abs((2 / 3) * chord * (dN - dO));
    }
    if (!moved && !FULL) continue;
    rows.push({
      f,
      s,
      span,
      px,
      hulls: hulls.length,
      moved,
      capOld,
      capNew,
      devOld,
      devNew,
      devOldPx: devOld / px,
      devNewPx: devNew / px,
      dArea,
      _cs: cs,
      _hulls: hulls,
      _eo: evenOdd,
    });
  }
}
console.warn = _warn;

console.log(`shapes with a moved hull chain: ${rows.length}`);
console.log('');
console.log(
  'shape                                                               hulls moved  cap o/n   devOld px  devNew px   verdict',
);
const worse = [];
for (const r of rows.sort((a, b) => b.devNewPx - a.devNewPx)) {
  const v = r.devNew <= r.devOld ? 'CLOSER' : 'farther';
  if (r.devNew > r.devOld) worse.push(r);
  console.log(
    `${(r.f.replace('examples/', '') + ' #' + r.s).padEnd(66)} ${String(r.hulls).padStart(4)} ${String(r.moved).padStart(5)}  ${String(r.capOld).padStart(3)}/${String(r.capNew).padEnd(3)}  ${r.devOldPx.toExponential(2).padStart(10)} ${r.devNewPx.toExponential(2).padStart(10)}   ${v}`,
  );
}
if (process.env.OUT) {
  const byAsset = new Map();
  for (const r of rows) {
    let a9 = byAsset.get(r.f);
    if (!a9)
      byAsset.set(
        r.f,
        (a9 = {
          file: r.f,
          shapes: [],
          span: r.span,
          devOldPx: 0,
          devNewPx: 0,
          hulls: 0,
          moved: 0,
          capOld: 0,
          capNew: 0,
        }),
      );
    a9.shapes.push(r.s);
    a9.hulls += r.hulls;
    a9.moved += r.moved;
    a9.capOld += r.capOld;
    a9.capNew += r.capNew;
    a9.devOldPx = Math.max(a9.devOldPx, r.devOldPx);
    a9.devNewPx = Math.max(a9.devNewPx, r.devNewPx);
  }
  const out9 = [...byAsset.values()].sort(
    (a, b) => b.devOldPx + b.devNewPx - (a.devOldPx + a.devNewPx),
  );
  writeFileSync(process.env.OUT, JSON.stringify(out9, null, 1));
  console.log(`\nwrote ${process.env.OUT}: ${out9.length} assets`);
}
console.log('');
console.log(`closer to the curve: ${rows.length - worse.length};  farther: ${worse.length}`);
if (worse.length) {
  const mx = worse.reduce((a, b) => (b.devNewPx > a.devNewPx ? b : a));
  console.log(
    `worst farther: ${mx.f} #${mx.s}  ${mx.devOldPx.toExponential(3)} -> ${mx.devNewPx.toExponential(3)} px at 512  (${((mx.devNew / mx.span) * 65536).toFixed(2)} vertex quanta)`,
  );
}

// ---------------------------------------------------------------- the 1024^2 coverage model
if (FULL) {
  console.log('');
  console.log(`coverage model at ${N}x${N}: miss / over / thin, old chain -> new chain`);
  console.log(
    'shape                                                            miss%  old -> new     over%  old -> new     thin%  old -> new',
  );
  for (const r of rows) {
    const trueCs = r._cs;
    const oldCs = polygonalize(trueCs, r._hulls, (h) => nFor(h.sag, OLD_TOL));
    const newCs = polygonalize(trueCs, r._hulls, (h) => h.n);
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const c of trueCs)
      for (const sg of c)
        for (const p of [sg.p1, sg.p2, sg.p3, sg.p4]) {
          if (!p) continue;
          if (p[0] < x0) x0 = p[0];
          if (p[0] > x1) x1 = p[0];
          if (p[1] < y0) y0 = p[1];
          if (p[1] > y1) y1 = p[1];
        }
    const gw = (x1 - x0) * 0.15,
      gh = (y1 - y0) * 0.15;
    x0 -= gw;
    x1 += gw;
    y0 -= gh;
    y1 += gh;
    const dx = (x1 - x0) / N,
      dy = (y1 - y0) / N;
    // "within half a pixel of the contour" is the sample coverageMiss skips; here the pixel IS the
    // grid cell, so the skip is a box-supersample that is neither all-in nor all-out.
    const S = 4,
      nS = S * S;
    // NEAR-OUTLINE PREFILTER. Away from every segment the three outlines coincide and the box is
    // uniformly in or out, so one winding evaluation decides the pixel; only pixels a segment's
    // bbox (padded by the cell diagonal) reaches are supersampled three times. Exact, not a
    // sample: a box no segment's padded bbox touches cannot be crossed by any of the three.
    const boxes = [];
    for (const c of trueCs)
      for (const sg of c) {
        let bx0 = Infinity,
          by0 = Infinity,
          bx1 = -Infinity,
          by1 = -Infinity;
        for (const p of [sg.p1, sg.p2, sg.p3, sg.p4]) {
          if (!p) continue;
          if (p[0] < bx0) bx0 = p[0];
          if (p[0] > bx1) bx1 = p[0];
          if (p[1] < by0) by0 = p[1];
          if (p[1] > by1) by1 = p[1];
        }
        boxes.push([bx0 - dx, by0 - dy, bx1 + dx, by1 + dy]);
      }
    const nearOutline = (x, y) => {
      for (const b9 of boxes) if (x >= b9[0] && x <= b9[2] && y >= b9[1] && y <= b9[3]) return true;
      return false;
    };
    let tot = 0,
      missO = 0,
      missN = 0,
      overO = 0,
      overN = 0,
      thinO = 0,
      thinN = 0;
    for (let j = 0; j < N; j++) {
      const y = y0 + (j + 0.5) * dy;
      for (let i = 0; i < N; i++) {
        const x = x0 + (i + 0.5) * dx;
        let cT, cO, cN;
        if (!nearOutline(x, y)) {
          cT = windOf(trueCs, x, y, r._eo) ? nS : 0;
          cO = cT;
          cN = cT;
        } else {
          cT = 0;
          cO = 0;
          cN = 0;
          for (let b = 0; b < S; b++)
            for (let a = 0; a < S; a++) {
              const sx = x + ((a + 0.5) / S - 0.5) * dx,
                sy = y + ((b + 0.5) / S - 0.5) * dy;
              if (windOf(trueCs, sx, sy, r._eo)) cT++;
              if (windOf(oldCs, sx, sy, r._eo)) cO++;
              if (windOf(newCs, sx, sy, r._eo)) cN++;
            }
        }
        if (cT !== 0 && cT !== nS) continue; // a boundary pixel: the skip coverageMiss applies
        if (cT === nS) {
          tot++;
          if (cO < nS / 2) missO++;
          if (cN < nS / 2) missN++;
          thinO += 1 - cO / nS;
          thinN += 1 - cN / nS;
        } else {
          if (cO > nS / 2) overO++;
          if (cN > nS / 2) overN++;
        }
      }
    }
    const pc = (v) => (tot ? ((100 * v) / tot).toFixed(4) : '0');
    console.log(
      `${(r.f.replace('examples/', '') + ' #' + r.s).padEnd(62)} ${pc(missO).padStart(8)} -> ${pc(missN).padStart(8)}  ${pc(overO).padStart(8)} -> ${pc(overN).padStart(8)}  ${pc(thinO).padStart(8)} -> ${pc(thinN).padStart(8)}`,
    );
  }
}
