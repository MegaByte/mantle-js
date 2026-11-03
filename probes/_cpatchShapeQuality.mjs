// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _cpatchShapeQuality — two per-shape questions about a CPatch decomposition, asked over the whole
// corpus in one pass, because both want the same patches and the patches are what cost.
//
//   COVER   what fraction of the shape's interior the KERNEL paints (cpatchCov.coverageMiss on the
//           patches packCPatchShape actually built, through its onPatches seam). This is the number
//           the shape-level guard thresholds: Loop-Blinn refuses a mesh that provably cannot cover
//           its shape (lbBuildCore.meshUnderCovers); without an equivalent, a CPatch decomposition
//           covering almost nothing would be accepted and drawn.
//
//   ALLSEAM how many patches have NO outline constraint at all -- every curve a cut. Such a patch
//           is a conjunction of hard steps, so it paints a flat 1.0 at every pixel whose center it
//           contains and it cannot antialias anything. Reported three ways, because only one of
//           them is a defect:
//             seam      how many there are
//             seamThin  how many are thinner than a pixel across their short axis (rotating
//                       calipers over the patch's own curves), at the nominal 512-px raster
//             seamNear  how many come within one FILTER REACH (CP_AA_REACH, 0.7072 px) of the
//                       shape's own outline. This is the bound: a hard step is exact for an
//                       all-seam patch the outline cannot reach, because every pixel it can paint
//                       is a pixel the shape covers whole. Only a patch that can share a pixel
//                       with the outline paints a flat 1.0 where the truth is a fraction.
//
// The rule matters. rowSpans is a NONZERO oracle and the even-odd region is a subset of the nonzero
// one, so scoring an even-odd shape against nonzero spans counts the region the rule excludes as
// interior the patches "missed". Both the survey and the guard pass the shape's own rule.
//
// So does CLOSING. An open subpath is filled as if closed; scored on the raw segments, tiger's #72
// reads 89.3% missed and 539% spilled and the same patches read 0.0%/0.0% with the closing edge in.
// Seven of tiger's 298 shapes are open.
//
//   node probes/_cpatchShapeQuality.mjs OUT.json [file.svg ...]
//   N=48 WHAT=cover,allseam
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { DOMParser: DP, XMLSerializer: XS } = await import('@xmldom/xmldom');
globalThis.DOMParser = globalThis.DOMParser || DP;
globalThis.XMLSerializer = globalThis.XMLSerializer || XS;
const { default: importSvg } = await import('../src/svg/importer.js');
const { headlessCPatchBundle, contoursToConverter, shapeEvenOdd, cpatchCurvePlane } =
  await import('../src/renderer/cpatchBuild.js');
const { curveRangeToContours } = await import('../src/geom/lbContour.js');
const { circleFromContours, ellipseFromContours } = await import('../src/geom/shapeRecognize.js');
const { packCPatchShape } = await import('../src/renderer/cpatchPack.js');
const { coverageMiss, distToContour, CP_AA_REACH } = await import('../src/renderer/cpatchCov.js');
const { patchBBox } = await import('../src/renderer/cpatchConvert.js');
const { segPt } = await import('../src/geom/cpatchImplicit.js');

/// The fill oracle has to close what the packer closes; see the header.
const closeAll = (contours) => {
  const out = [];
  for (const q of contours) {
    if (!q || !q.length) continue;
    for (const sg of q) out.push(sg);
    const a = segPt(q[0], 0),
      b = segPt(q[q.length - 1], 1);
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-9)
      out.push({
        t: 'line',
        P: [
          [b[0], b[1]],
          [a[0], a[1]],
        ],
      });
  }
  return out;
};

const out = process.argv[2];
if (!out) {
  console.error('usage: _cpatchShapeQuality.mjs OUT.json [file.svg ...]');
  process.exit(2);
}
const N = +(process.env.N || 48);
const WHAT = (process.env.WHAT || 'cover,allseam').split(',');
const WANT_COVER = WHAT.includes('cover'),
  WANT_SEAM = WHAT.includes('allseam');
let files = process.argv.slice(3);
if (!files.length) {
  const dir = (d) =>
    existsSync(path.join(ROOT, d))
      ? readdirSync(path.join(ROOT, d))
          .filter((f) => f.endsWith('.svg'))
          .sort()
          .map((f) => d + '/' + f)
      : [];
  files = [...dir('examples'), ...dir('examples/_bench'), ...dir('examples/smoke')];
}
const _w = console.warn;
console.warn = () => {};

/// The patch's narrowest width, by rotating calipers over its curves' sample points: the width of
/// the thinnest strip containing it. A patch thinner than a pixel cannot be told apart from a line
/// by a kernel that only steps.
function shortAxis(curves) {
  const P = [];
  for (const sg of curves) for (let k = 0; k <= 8; k++) P.push(segPt(sg, k / 8));
  if (P.length < 3) return 0;
  let best = Infinity;
  for (let i = 0; i < P.length; i++) {
    for (let j = i + 1; j < P.length; j++) {
      const dx = P[j][0] - P[i][0],
        dy = P[j][1] - P[i][1],
        L = Math.hypot(dx, dy);
      if (!(L > 0)) continue;
      const nx = -dy / L,
        ny = dx / L;
      let lo = Infinity,
        hi = -Infinity;
      for (const q of P) {
        const v = q[0] * nx + q[1] * ny;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (hi - lo < best) best = hi - lo;
    }
  }
  return Number.isFinite(best) ? best : 0;
}

const result = { n: N, assets: {} };
let tShapes = 0,
  tRefusable = 0,
  tPatches = 0,
  tSeam = 0,
  tSeamThin = 0,
  tSeamNear = 0,
  tMs = 0;
for (const rel of files) {
  let svg;
  try {
    svg = readFileSync(path.resolve(ROOT, rel), 'utf8');
  } catch {
    continue;
  }
  let bundle;
  try {
    bundle = headlessCPatchBundle(await importSvg(svg));
  } catch {
    continue;
  }
  const cf = cpatchCurvePlane(bundle);
  const ranges = bundle.curveRangesByShape || [];
  const cycleCache = new Map();
  const shapes = {};
  const t0 = performance.now();
  for (let s = 0; s < ranges.length; s++) {
    const r = ranges[s];
    if (!r) continue;
    let contours = null;
    try {
      contours = curveRangeToContours(cf, r.begin, r.end);
    } catch {
      contours = null;
    }
    if (!contours || !contours.length) continue;
    if (circleFromContours(contours) || ellipseFromContours(contours)) continue;
    const cs = contoursToConverter(contours, null);
    if (!cs) continue;
    const evenOdd = shapeEvenOdd(bundle, s);
    const patches = [];
    let m = null;
    try {
      m = packCPatchShape(cs, 0, {
        evenOdd,
        cycleCache,
        search: 'full',
        onPatches: (ps) => {
          for (const p of ps) patches.push(p);
        },
      });
    } catch {
      m = null;
    }
    if (!m) continue;
    tShapes++;
    tPatches += patches.length;
    const row = { p: patches.length, eo: evenOdd ? 1 : 0 };
    const all = closeAll(cs);
    // The nominal raster coverageMiss uses: the shape across 512 px.
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const sg of all)
      for (const q of sg.P) {
        if (q[0] < x0) x0 = q[0];
        if (q[0] > x1) x1 = q[0];
        if (q[1] < y0) y0 = q[1];
        if (q[1] > y1) y1 = q[1];
      }
    const emPerPx = Math.max(x1 - x0, y1 - y0) / 512.0 || 1e-6;
    if (WANT_COVER) {
      const cm = coverageMiss(all, patches, N, evenOdd);
      row.miss = +cm.miss.toFixed(3);
      row.over = +cm.over.toFixed(3);
      row.thin = +cm.thin.toFixed(3);
      if (cm.miss >= 50) tRefusable++;
    }
    if (WANT_SEAM) {
      let seam = 0,
        thin = 0,
        near = 0,
        worst = 0;
      for (const p of patches) {
        let allSeam = p.curves.length > 0;
        for (const sg of p.curves)
          if (!(sg && sg.cut)) {
            allSeam = false;
            break;
          }
        if (!allSeam) continue;
        seam++;
        const w = shortAxis(p.curves) / emPerPx;
        const bb = patchBBox(p.curves);
        const len = Math.max(bb[2] - bb[0], bb[3] - bb[1]) / emPerPx;
        if (w < 1) {
          thin++;
          if (len > worst) worst = len;
        }
        // HOW CLOSE THE SHAPE'S own OUTLINE COMES, over the patch's own boundary. A hard step is
        // exact for a patch the outline cannot reach; only one that can share a pixel with it
        // paints a flat 1.0 where the truth is a fraction.
        let d = Infinity;
        for (const sg of p.curves)
          for (let q = 0; q <= 6 && d > CP_AA_REACH * emPerPx; q++) {
            const pt = segPt(sg, q / 6);
            const dd = distToContour(all, pt[0], pt[1]);
            if (dd < d) d = dd;
          }
        if (d <= CP_AA_REACH * emPerPx) near++;
      }
      row.seam = seam;
      row.seamThin = thin;
      row.seamNear = near;
      row.seamThinLen = +worst.toFixed(2);
      tSeam += seam;
      tSeamThin += thin;
      tSeamNear += near;
    }
    shapes[s] = row;
  }
  const ms = performance.now() - t0;
  tMs += ms;
  result.assets[rel] = { ms: Math.round(ms), shapes };
}
console.warn = _w;
writeFileSync(out, JSON.stringify(result));
console.log(`shapes ${tShapes}, patches ${tPatches}, ${Math.round(tMs)} ms`);
if (WANT_COVER) console.log(`  miss >= 50%: ${tRefusable} shapes`);
if (WANT_SEAM) {
  console.log(
    `  all-seam patches ${tSeam} (${((100 * tSeam) / Math.max(1, tPatches)).toFixed(2)}% of ${tPatches})`,
  );
  console.log(`    thinner than a pixel across:            ${tSeamThin}`);
  console.log(
    `    within one filter reach of the outline: ${tSeamNear}   <- the only ones a hard step can get wrong`,
  );
}
console.log(`  -> ${out}`);
