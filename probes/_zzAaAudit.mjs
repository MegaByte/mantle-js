// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzAaAudit — the four things a fill engine has to get right, measured separately.
//
//   SOLID     a pixel the reference fills completely, or not at all. The engine must agree; a
//             disagreement here is ink in the wrong place, not a filter difference.
//   AA        a pixel the boundary runs through. Scored as |cov - ref|, max and mean, because a
//             mean hides the one pixel that looks wrong.
//   MONOTONE  coverage must order the way the truth orders. Between two neighbouring pixels, the
//             one the reference covers more must not be painted less.
//
// WHAT IS LEFT OF THE INTERIOR LOSS IS A SLIT IN THE ARTWORK. Walking across one of the pixels
// that comes back at 0.59 where the shape is solid: inside, inside, inside, OUTSIDE, inside -- one
// sample wide. The contour doubles back on itself, so the fill covers the slit because it has no
// area, while two patches meet along it and each ramps its own side. Marking every curve with the
// fill on both sides as a partition moves nothing: only 18 of tiger's 4674 curves
// are slits along their whole length, and a curve is usually a slit over PART of its length -- the
// converter would have to split it there first.
//
// LETTING A PATCH SEE THE OUTLINE ITS NEIGHBOUR KEPT DOES NOT WORK. The worst
// edge pixels are over-painted by a patch whose own arcs do not bound them -- the outline changes
// hands at a seam's end -- so the obvious answer is to hand that patch the neighbour's curve as a
// coverage-only constraint. Three versions, each looser than the last: every outline
// curve of the shape (227126 interior pixels of tiger lost), only those reaching a cut endpoint,
// and only within a pixel or two of the endpoint itself (2602 lost, and the worst edge pixels
// barely move, 1558 -> 1514). A curve's half-space is not a local bound, and neither the arc box
// nor the cross-chord strip makes it one at the distances involved.
//
// THE REFERENCE IS NOT ANOTHER ENGINE and it is not a supersample. A pixel's true box coverage is
// the area of the region inside the pixel, and the region's spans on any horizontal line are known
// exactly (rowSpans solves each curve for its crossings). So the x integral is exact and only the
// y integral is quadrature: Gauss-Legendre over sub-intervals of the pixel's height, sharing one
// span solve across the whole raster row. The residual is the y quadrature's alone, and the
// straight-edge control at the bottom of the run prints it.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { packCPatchShape } from '../src/renderer/cpatchPack.js';
import { patchCoverage, curveCov, CP_AA_REACH } from '../src/renderer/cpatchCov.js';
import {
  rowSpans,
  patchBBox,
  patchCoverLines,
  segAffMin,
  insideContour,
} from '../src/renderer/cpatchConvert.js';
import { segTightBBox, packedEval, segTangent } from '../src/geom/cpatchImplicit.js';
import { segPt } from '../src/geom/cpatchImplicit.js';

const PX = +(process.env.PX || 256); // raster's long side, in pixels
const SUB = +(process.env.SUB || 8); // y sub-intervals per pixel row
const GL = 8; // Gauss-Legendre nodes per sub-interval
const ONLY = process.env.SHAPES ? new Set(process.env.SHAPES.split(',').map(Number)) : null;
const SOLID_WRONG = 0.5; // |cov-ref| that makes a solid pixel WRONG
const MONO_EPS = +(process.env.MONO_EPS || 0.02);
const BIG = !!process.env.BIG;
const ADJ = !!process.env.ADJ;
const ADJ_R = +(process.env.ADJ_R || 1.2);

// Gauss-Legendre nodes/weights on [-1,1], n=8.
const GLX = [
  -0.9602898564975363, -0.7966664774136267, -0.525532409916329, -0.1834346424956498,
  0.1834346424956498, 0.525532409916329, 0.7966664774136267, 0.9602898564975363,
];
const GLW = [
  0.1012285362903763, 0.2223810344533745, 0.3137066458778873, 0.362683783378362, 0.362683783378362,
  0.3137066458778873, 0.2223810344533745, 0.1012285362903763,
];

/// Fill spans of the shape on the line y, as [x0,x1,x0,x1,...] under the shape's own fill rule.
function spansAt(curves, y, evenOdd) {
  const s = rowSpans(curves, y, evenOdd);
  return s || [];
}

/// The length of [a,b] covered by the spans, which arrive as [lo,hi] pairs.
function spanLen(sp, a, b) {
  let L = 0;
  for (let i = 0; i < sp.length; i++) {
    const lo = Math.max(sp[i][0], a),
      hi = Math.min(sp[i][1], b);
    if (hi > lo) L += hi - lo;
  }
  return L;
}

function audit(curves, patches, evenOdd, fixedEmPerPx) {
  const bb = patchBBox(curves);
  const w = bb[2] - bb[0],
    h = bb[3] - bb[1];
  const span = Math.max(w, h);
  const pad = span * 0.04 + 1e-9;
  const x0 = bb[0] - pad,
    y0 = bb[1] - pad,
    S = span + 2 * pad;
  // ONE SCALE FOR THE whole ASSET, when asked. Rastering every shape to the same pixel count
  // magnifies the small ones: tiger's most detailed shape carries 185 curves, and at 128px a side
  // its features are sub-pixel -- which is a fine stress test and not what ships.
  const emPerPx = fixedEmPerPx || S / PX;
  const NX = fixedEmPerPx ? Math.max(4, Math.ceil(S / emPerPx)) : PX;
  const NY = NX;

  // Every outline curve, keyed by the endpoints it touches, so a patch can find the one its own
  // seam runs into.
  const byPt = new Map();
  const key = (q) => q[0] + ',' + q[1];
  if (ADJ) {
    const seen = new Set();
    for (const p of patches)
      for (let k = 0; k < p.impls.length; k++) {
        const sg = p.curves[k],
          im = p.impls[k];
        if (!im.packed || (sg && sg.cut)) continue;
        const id = sg.P.map((q) => q.join(',')).join(';');
        if (seen.has(id)) continue;
        seen.add(id);
        const a0 = segPt(sg, 0),
          a1 = segPt(sg, 1);
        const dx = a1[0] - a0[0],
          dy = a1[1] - a0[1],
          L = Math.hypot(dx, dy);
        const rec = {
          sg,
          pk: im.packed,
          box: segTightBBox(sg),
          strip:
            L > 1e-12
              ? [
                  -dy / L,
                  dx / L,
                  segAffMin(sg, -dy / L, dx / L).m,
                  -segAffMin(sg, dy / L, -dx / L).m,
                ]
              : null,
          sgn: packedEval(im.packed, p.inside[0], p.inside[1]) >= 0 ? 1 : -1,
        };
        for (const e of [a0, a1]) {
          const kk = key(e);
          if (!byPt.has(kk)) byPt.set(kk, []);
          byPt.get(kk).push(rec);
        }
      }
  }
  const adjOf = (p) => {
    if (p._auditAdj) return p._auditAdj;
    const mine = new Set(p.curves.map((sg) => sg.P.map((q) => q.join(',')).join(';')));
    const list = [];
    for (const sg of p.curves) {
      if (!sg.cut) continue;
      for (const e of [segPt(sg, 0), segPt(sg, 1)])
        for (const r of byPt.get(key(e)) || [])
          if (!mine.has(r.sg.P.map((q) => q.join(',')).join(';'))) list.push({ ...r, at: e });
    }
    p._auditAdj = list;
    return list;
  };
  const ref = new Float64Array(NX * NY);
  const cov = new Float64Array(NX * NY);
  // TWO ALTERNATIVE COMPOSITES, to attribute the error. OVER is what the frame does. SUM is what a
  // partition WANTS -- two patches splitting a pixel want a+b, and OVER gives a+b-ab, so wherever
  // SUM is right and OVER is not, the error is the compositing deficit and no per-patch coverage
  // change can reach it. MAX is the other bound: where MAX is right and OVER is not, the patches
  // are double-counting territory they both claim.
  const covSum = new Float64Array(NX * NY);
  const covMax = new Float64Array(NX * NY);
  // REFERENCE: one span solve per y node, shared across the row.
  for (let py = 0; py < NY; py++) {
    const yb = y0 + py * emPerPx;
    for (let s = 0; s < SUB; s++) {
      const ya = yb + (s / SUB) * emPerPx,
        yh = emPerPx / SUB;
      for (let g = 0; g < GL; g++) {
        const yy = ya + (yh * (GLX[g] + 1)) / 2,
          wgt = GLW[g] / 2 / SUB;
        const sp = spansAt(curves, yy, evenOdd);
        if (!sp.length) continue;
        for (let px = 0; px < NX; px++) {
          const xa = x0 + px * emPerPx;
          const L = spanLen(sp, xa, xa + emPerPx);
          if (L > 0) ref[py * NX + px] += wgt * (L / emPerPx);
        }
      }
    }
  }
  // ENGINE: the kernel's own composite, at the pixel center, at this pixel size.
  for (let py = 0; py < NY; py++) {
    const yy = y0 + (py + 0.5) * emPerPx;
    for (let px = 0; px < NX; px++) {
      const xx = x0 + (px + 0.5) * emPerPx;
      let open = 1,
        sum = 0,
        mx = 0;
      for (const p of patches) {
        let c = patchCoverage(p, xx, yy, emPerPx);
        // EXPERIMENT (ADJ=1): hand each patch the outline curve that SHARES its cut's endpoint --
        // exact adjacency, not proximity. That is the curve the outline continues along past the
        // seam, and the one whose absence makes a patch report solid where the shape is half gone.
        // AA-only: it may attenuate inside its own band and never rejects.
        if (ADJ && c > 0) {
          for (const o of adjOf(p)) {
            // only AT THE JUNCTION ITSELF. Further along its arc, the outline curls away and the
            // patch's own region can sit on the far side of this curve's half-space, where
            // attenuating it takes real ink.
            if (o.at && Math.hypot(o.at[0] - xx, o.at[1] - yy) > ADJ_R * emPerPx) continue;
            const ox = Math.max(o.box[0] - xx, xx - o.box[2], 0),
              oy = Math.max(o.box[1] - yy, yy - o.box[3], 0);
            let d = Math.hypot(ox, oy);
            if (o.strip) {
              const v = xx * o.strip[0] + yy * o.strip[1];
              d = Math.max(d, Math.max(o.strip[2] - v, v - o.strip[3], 0));
            }
            if (d > CP_AA_REACH * emPerPx) continue;
            const cc = curveCov(o.pk, o.sgn, false, o.box, xx, yy, emPerPx, {});
            if (cc > 0 && cc < c) c = cc;
          }
        }
        if (c > 0) {
          open *= 1 - Math.min(1, c);
          sum += c;
          if (c > mx) mx = c;
        }
      }
      cov[py * NX + px] = 1 - open;
      covSum[py * NX + px] = Math.min(1, sum);
      covMax[py * NX + px] = mx;
    }
  }

  const thinWhy = [];
  let over50 = 0,
    over30 = 0,
    over20 = 0,
    over10 = 0;
  const big = [];
  let thinN = 0,
    sumMax = 0,
    maxMax = 0,
    sumSum = 0,
    maxSum = 0;
  let extra = 0,
    missing = 0,
    edgeN = 0,
    aaSum = 0,
    aaMax = 0,
    solidMax = 0,
    emptyMax = 0;
  let aaMaxAt = null,
    solidAt = null,
    emptyAt = null;
  for (let i = 0; i < ref.length; i++) {
    const r = ref[i],
      c = cov[i],
      e = Math.abs(c - r);
    if (r > 1 - 1e-6) {
      if (1 - c > solidMax) {
        solidMax = 1 - c;
        solidAt = i;
      }
      if (1 - c > 0.05) {
        thinN++;
        // WHICH CONSTRAINT TOOK IT, AND HOW FAR IS ITS ARC? A curve bounding a pixel the shape
        // covers whole is either an edge the reference disagrees about -- it is not -- or an
        // implicit reporting from a distance, which is the second branch its zero set carries.
        if (thinWhy.length < 200) {
          const px2 = i % NX,
            py2 = (i / NX) | 0;
          const xx = x0 + (px2 + 0.5) * emPerPx,
            yy = y0 + (py2 + 0.5) * emPerPx;
          let worstC = 1,
            worstSeg = null,
            sdAt = NaN,
            hit = 0,
            partials = 0;
          for (const p of patches) {
            const pc = patchCoverage(p, xx, yy, emPerPx);
            if (pc <= 0) continue;
            hit++;
            if (pc < 1 - 1e-6) partials++;
            for (let k = 0; k < p.impls.length; k++) {
              const im = p.impls[k],
                sg2 = p.curves[k];
              if (!im.packed) continue;
              const sgn = packedEval(im.packed, p.inside[0], p.inside[1]) >= 0 ? 1 : -1;
              const rr = {};
              const cc = curveCov(
                im.packed,
                sgn,
                !!(sg2 && sg2.cut),
                segTightBBox(sg2),
                xx,
                yy,
                emPerPx,
                rr,
              );
              if (cc < worstC) {
                worstC = cc;
                worstSeg = sg2;
                sdAt = rr.sd != null ? rr.sd : NaN;
              }
            }
          }
          if (worstSeg) {
            let d = Infinity;
            for (let q = 0; q <= 96; q++) {
              const pt = segPt(worstSeg, q / 96);
              d = Math.min(d, Math.hypot(pt[0] - xx, pt[1] - yy));
            }
            thinWhy.push({
              d: d / emPerPx,
              cut: !!worstSeg.cut,
              c: worstC,
              hit,
              partials,
              gap: Math.abs(Math.abs(sdAt) - d / emPerPx),
              none: !(worstC < 1 - 1e-6),
            });
          } else thinWhy.push({ d: NaN, cut: false, c: 1, hit, partials, gap: NaN, none: true });
        }
      }
      if (1 - c > SOLID_WRONG) missing++;
    } else if (r < 1e-6) {
      if (c > emptyMax) {
        emptyMax = c;
        emptyAt = i;
      }
      if (c > SOLID_WRONG) extra++;
    } else {
      edgeN++;
      aaSum += e;
      if (e > 0.5) {
        over50++;
        if (BIG) big.push({ i, over: c > r });
      }
      if (e > 0.3) over30++;
      if (e > 0.2) over20++;
      if (e > 0.1) over10++;
      const eS = Math.abs(covSum[i] - r),
        eM = Math.abs(covMax[i] - r);
      sumSum += eS;
      maxSum += eM;
      if (eS > sumMax) sumMax = eS;
      if (eM > maxMax) maxMax = eM;
      if (e > aaMax) {
        aaMax = e;
        aaMaxAt = i;
      }
    }
  }
  // MONOTONE: a pixel the reference covers MORE must not be painted LESS than its neighbour.
  let monoBad = 0,
    monoWorst = 0,
    monoAt = null;
  const monoWhy = [];
  for (let py = 0; py < NY; py++)
    for (let px = 0; px < NX; px++) {
      const i = py * NX + px;
      for (const [dx, dy] of [
        [1, 0],
        [0, 1],
      ]) {
        const jx = px + dx,
          jy = py + dy;
        if (jx >= NX || jy >= NY) continue;
        const j = jy * NX + jx;
        const dR = ref[i] - ref[j],
          dC = cov[i] - cov[j];
        const bad =
          dR > MONO_EPS && dC < -MONO_EPS ? -dC : dR < -MONO_EPS && dC > MONO_EPS ? dC : 0;
        if (bad > 0) {
          monoBad++;
          if (bad > monoWorst) {
            monoWorst = bad;
            monoAt = i;
          }
          // WHY IS IT NOT MONOTONE? The pixel painted MORE than the truth allows, examined: which
          // constraint is placing the edge, and how far its own arc actually is. A constraint whose
          // signed distance disagrees with the distance to its arc is reading a second branch of
          // its zero set -- the one thing no bound here can see -- and anything else is not.
          if (monoWhy.length < 150) {
            const wi = dC > 0 ? i : j;
            const wx = x0 + ((wi % NX) + 0.5) * emPerPx,
              wy = y0 + (((wi / NX) | 0) + 0.5) * emPerPx;
            let worstC = 1,
              worstSeg = null,
              sdAt = 0;
            for (const p of patches) {
              if (patchCoverage(p, wx, wy, emPerPx) <= 0) continue;
              for (let k = 0; k < p.impls.length; k++) {
                const im = p.impls[k],
                  sg2 = p.curves[k];
                if (!im.packed) continue;
                const sgn = packedEval(im.packed, p.inside[0], p.inside[1]) >= 0 ? 1 : -1;
                const rr = {};
                const cc = curveCov(
                  im.packed,
                  sgn,
                  !!(sg2 && sg2.cut),
                  segTightBBox(sg2),
                  wx,
                  wy,
                  emPerPx,
                  rr,
                );
                if (cc < worstC) {
                  worstC = cc;
                  worstSeg = sg2;
                  sdAt = rr.sd != null ? rr.sd : NaN;
                }
              }
            }
            if (worstSeg) {
              let d = Infinity;
              for (let q = 0; q <= 96; q++) {
                const pt = segPt(worstSeg, q / 96);
                d = Math.min(d, Math.hypot(pt[0] - wx, pt[1] - wy));
              }
              monoWhy.push({
                gap: Math.abs(Math.abs(sdAt) - d / emPerPx),
                cut: !!worstSeg.cut,
                none: !(worstC < 1),
              });
            } else monoWhy.push({ gap: NaN, cut: false, none: true });
          }
        }
      }
    }
  // WHY IS this PIXEL WRONG? A pixel's coverage is a min() over the constraints that are PARTIAL
  // there and an OVER across the patches that reach it, and those two are different errors: min
  // over-counts a corner (the true area is the intersection, never the smaller of the two), and
  // OVER under-counts a seam (a+b-ab, where two half-pixels want a+b). Counting both at the worst
  // pixels says which one to go after.
  function why(i) {
    if (i == null) return '';
    const px = i % NX,
      py = (i / NX) | 0;
    const xx = x0 + (px + 0.5) * emPerPx,
      yy = y0 + (py + 0.5) * emPerPx;
    let partial = 0,
      cutPartial = 0,
      patchesHit = 0,
      partialPatches = 0;
    for (const p of patches) {
      const c = patchCoverage(p, xx, yy, emPerPx);
      if (c <= 0) continue;
      patchesHit++;
      if (c < 1 - 1e-6) partialPatches++;
      for (let k = 0; k < p.impls.length; k++) {
        const im = p.impls[k],
          seg = p.curves[k];
        if (!im.packed) continue;
        const sgn = packedEval(im.packed, p.inside[0], p.inside[1]) >= 0 ? 1 : -1;
        const cc = curveCov(
          im.packed,
          sgn,
          !!(seg && seg.cut),
          segTightBBox(seg),
          xx,
          yy,
          emPerPx,
          {},
        );
        if (cc > 1e-6 && cc < 1 - 1e-6) {
          partial++;
          if (seg && seg.cut) cutPartial++;
        }
      }
    }
    const per = [];
    for (const p of patches) {
      const c = patchCoverage(p, xx, yy, emPerPx);
      if (c > 1e-6) per.push(c.toFixed(3));
    }
    // AND WHAT THE COVER IS DOING, for the patch that dominates: each plane's margin in pixels,
    // with the kind that decides its treatment (0 bridging, 1 along a cut, 2 along an arc).
    let dom = null,
      domC = 0;
    for (const p of patches) {
      const c = patchCoverage(p, xx, yy, emPerPx);
      if (c > domC) {
        domC = c;
        dom = p;
      }
    }
    let planes = '';
    if (dom) {
      const hl = dom._auditHull || (dom._auditHull = patchCoverLines(dom.curves, 16) || []);
      const near = hl
        .map((h) => ({ k: h[3] | 0, a: (h[0] * xx + h[1] * yy + h[2]) / emPerPx }))
        .filter((q) => q.a < 1.2)
        .sort((q, w) => q.a - w.a)
        .slice(0, 4);
      planes =
        ' | tightest planes ' +
        (near.length
          ? near.map((q) => `${['bridge', 'cut', 'arc'][q.k]}:${q.a.toFixed(2)}px`).join(' ')
          : 'none within 1.2px');
    }
    return (
      `[ref ${ref[i].toFixed(3)} cov ${cov[i].toFixed(3)} | patches ${per.join('+')} ` +
      `| partial constraints ${partial}, cuts ${cutPartial}${planes}]`
    );
  }
  const at = (i) => (i == null ? '' : `(${i % NX},${(i / NX) | 0})`);
  const whyAa = process.env.WHY ? why(aaMaxAt) : '';
  const whyEmpty = process.env.WHY ? why(emptyAt) : '';
  const whySolid = process.env.WHY ? why(solidAt) : '';
  // WHAT ARE THE WORST EDGE PIXELS MADE OF? Over-paint or under-paint, how many patches reach
  // them, whether any curve constraint is mid-ramp there, and which cover plane is tightest.
  const cls = {
    over: 0,
    under: 0,
    onePatch: 0,
    manyPatch: 0,
    noPartial: 0,
    planeCut: 0,
    planeArc: 0,
    planeBridge: 0,
  };
  if (BIG)
    for (const b of big.slice(0, 400)) {
      cls[b.over ? 'over' : 'under']++;
      const px2 = b.i % NX,
        py2 = (b.i / NX) | 0;
      const xx = x0 + (px2 + 0.5) * emPerPx,
        yy = y0 + (py2 + 0.5) * emPerPx;
      let hit = 0,
        partial = 0,
        dom = null,
        domC = 0;
      for (const p of patches) {
        const c = patchCoverage(p, xx, yy, emPerPx);
        if (c <= 0) continue;
        hit++;
        if (c > domC) {
          domC = c;
          dom = p;
        }
        for (let k = 0; k < p.impls.length; k++) {
          const im = p.impls[k],
            sg2 = p.curves[k];
          if (!im.packed) continue;
          const sgn = packedEval(im.packed, p.inside[0], p.inside[1]) >= 0 ? 1 : -1;
          const cc = curveCov(
            im.packed,
            sgn,
            !!(sg2 && sg2.cut),
            segTightBBox(sg2),
            xx,
            yy,
            emPerPx,
            {},
          );
          if (cc > 1e-6 && cc < 1 - 1e-6) partial++;
        }
      }
      cls[hit > 1 ? 'manyPatch' : 'onePatch']++;
      if (!partial) cls.noPartial++;
      if (dom) {
        const hl = dom._auditHull || (dom._auditHull = patchCoverLines(dom.curves, 16) || []);
        let m = Infinity,
          mk = -1;
        for (const h of hl) {
          const a = (h[0] * xx + h[1] * yy + h[2]) / emPerPx;
          if (a < m) {
            m = a;
            mk = h[3] | 0;
          }
        }
        if (mk === 0) cls.planeBridge++;
        else if (mk === 1) cls.planeCut++;
        else if (mk === 2) cls.planeArc++;
      }
    }
  return {
    monoWhy,
    thinWhy,
    cls,
    over50,
    over30,
    over20,
    over10,
    whyAa,
    whyEmpty,
    whySolid,
    thinN,
    solidAt2: at(solidAt),
    emptyAt: at(emptyAt),
    sumMax,
    maxMax,
    sumMean: sumSum / Math.max(1, edgeN),
    maxMean: maxSum / Math.max(1, edgeN),
    extra,
    missing,
    solidMax,
    emptyMax,
    edgeN,
    aaMean: aaSum / Math.max(1, edgeN),
    aaMax,
    monoBad,
    monoWorst,
    aaAt: at(aaMaxAt),
    solidAt: at(solidAt),
    monoAt: at(monoAt),
    emPerPx,
  };
}

const file = process.argv[2];
const sections = await importSvg(readFileSync(file, 'utf8'));
const cf = new Float32Array(sections.curves);
// ASSET=<px> rasters every shape at the scale it would have in a render of the whole asset that
// size, rather than blowing each shape up to PX on its own.
let assetEm = 0;
if (process.env.ASSET) {
  let ax0 = Infinity,
    ay0 = Infinity,
    ax1 = -Infinity,
    ay1 = -Infinity;
  for (const r of sections.curveRangesByShape || []) {
    const cs = curveRangeToContours(
      cf,
      r.begin | 0,
      (r.end != null ? r.end : r.begin + r.count) | 0,
    );
    const l = contoursToConverter(cs || [], null);
    if (!l || !l.length) continue;
    const b = patchBBox(l.flat());
    ax0 = Math.min(ax0, b[0]);
    ay0 = Math.min(ay0, b[1]);
    ax1 = Math.max(ax1, b[2]);
    ay1 = Math.max(ay1, b[3]);
  }
  assetEm = Math.max(ax1 - ax0, ay1 - ay0) / +process.env.ASSET;
}
const out = [];
let built = 0,
  unbuilt = 0;
for (const [si, r] of (sections.curveRangesByShape || []).entries()) {
  if (ONLY && !ONLY.has(si)) continue;
  const cs = curveRangeToContours(cf, r.begin | 0, (r.end != null ? r.end : r.begin + r.count) | 0);
  const list = contoursToConverter(cs || [], null);
  if (!list || !list.length) continue;
  const all = [];
  for (const c of list) {
    for (const sg of c) all.push(sg);
    const a = segPt(c[0], 0),
      b = segPt(c[c.length - 1], 1);
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-6) all.push({ t: 'line', P: [b, a] });
  }
  const patches = [];
  let packed = null;
  try {
    packed = packCPatchShape(list, 0, { onPatches: (ps) => patches.push(...ps) });
  } catch {}
  if (!packed || !patches.length) {
    unbuilt++;
    continue;
  }
  built++;
  out.push({ si, n: patches.length, ...audit(all, patches, false, assetEm) });
}
out.sort((a, b) => b.extra + b.missing - (a.extra + a.missing) || b.aaMax - a.aaMax);
const sum = (k) => out.reduce((a, r) => a + r[k], 0);
const worst = (k) => out.reduce((a, r) => Math.max(a, r[k]), 0);
console.log(
  `${built} shapes audited ${assetEm ? `at the scale of a ${process.env.ASSET}px render` : `at ${PX}px each`}` +
    ` (${unbuilt} unbuilt), ${sum('edgeN')} edge px`,
);
console.log(`  SOLID   under-painted interior px (>0.05 short) ${sum('thinN')}`);
console.log(
  `  SOLID   extra ${sum('extra')}  missing ${sum('missing')}   worst empty ${worst('emptyMax').toFixed(3)}  worst solid shortfall ${worst('solidMax').toFixed(3)}`,
);
console.log(
  `  AA      over 0.5: ${sum('over50')}   over 0.3: ${sum('over30')}   over 0.2: ${sum('over20')}   over 0.1: ${sum('over10')}   of ${sum('edgeN')} edge px`,
);
console.log(
  `  AA      max ${worst('aaMax').toFixed(3)}  mean ${(out.reduce((a, r) => a + r.aaMean * r.edgeN, 0) / Math.max(1, sum('edgeN'))).toFixed(4)}`,
);
console.log(
  `  COMPOSITE  if SUM: max ${worst('sumMax').toFixed(3)} mean ${(out.reduce((a, r) => a + r.sumMean * r.edgeN, 0) / Math.max(1, sum('edgeN'))).toFixed(4)}` +
    `   if MAX: max ${worst('maxMax').toFixed(3)} mean ${(out.reduce((a, r) => a + r.maxMean * r.edgeN, 0) / Math.max(1, sum('edgeN'))).toFixed(4)}`,
);
if (BIG) {
  const t = {};
  for (const r of out) for (const k of Object.keys(r.cls || {})) t[k] = (t[k] || 0) + r.cls[k];
  console.log(
    `  WORST EDGE PIXELS (>0.5 off, up to 400 a shape): ${t.over} over-painted, ${t.under} under-painted; ` +
      `${t.onePatch} reached by one patch, ${t.manyPatch} by several; ${t.noPartial} with NO curve constraint mid-ramp`,
  );
  console.log(
    `    tightest cover plane there: along a cut ${t.planeCut}, along an arc ${t.planeArc}, bridging ${t.planeBridge}`,
  );
}
{
  const all = [];
  for (const r of out) for (const w of r.thinWhy || []) all.push(w);
  if (all.length) {
    all.sort((a, b) => a.d - b.d);
    const q = (f) => all[Math.min(all.length - 1, Math.floor(f * all.length))].d;
    const cuts = all.filter((w) => w.cut).length;
    const none = all.filter((w) => w.none).length;
    const multi = all.filter((w) => w.hit > 1).length;
    const gaps = all
      .filter((w) => Number.isFinite(w.gap))
      .map((w) => w.gap)
      .sort((a, b) => a - b);
    const far = gaps.filter((g) => g > 0.3).length;
    console.log(
      `  THE CONSTRAINT THAT TOOK AN INTERIOR PIXEL sits, from its own arc: median ` +
        `${q(0.5).toFixed(2)}px, p75 ${q(0.75).toFixed(2)}px, max ${q(1).toFixed(2)}px ` +
        `(${cuts} of ${all.length} were cuts)`,
    );
    console.log(
      `    ${none} had NO constraint mid-ramp (a cover plane or the OVER handoff took it), ` +
        `${multi} were reached by more than one patch`,
    );
    console.log(
      `    of the rest, the constraint's own distance disagrees with its arc by more than ` +
        `0.3px in ${far} of ${gaps.length} (median ${(gaps[gaps.length >> 1] || 0).toFixed(2)}px)`,
    );
  }
}
{
  const w = [];
  for (const r of out) for (const m of r.monoWhy || []) w.push(m);
  if (w.length) {
    const none = w.filter((m) => m.none).length,
      cuts = w.filter((m) => m.cut).length;
    const gaps = w
      .filter((m) => Number.isFinite(m.gap))
      .map((m) => m.gap)
      .sort((a, b) => a - b);
    const far = gaps.filter((g) => g > 0.3).length;
    console.log(
      `  MONO CAUSE (${w.length} sampled): ${none} with no constraint mid-ramp, ${cuts} a cut; ` +
        `the constraint's own distance disagrees with its arc by median ${(gaps[gaps.length >> 1] || 0).toFixed(2)}px, ` +
        `and by more than 0.3px in ${far} of ${gaps.length}`,
    );
  }
}
console.log(`  MONO    ${sum('monoBad')} violations, worst ${worst('monoWorst').toFixed(3)}`);
for (const r of out.slice(0, +(process.env.TOP || 8)))
  if (r.extra + r.missing > 0 || r.aaMax > 0.3 || r.monoBad > 0)
    console.log(
      `    shape ${String(r.si).padStart(3)} ${String(r.n).padStart(3)}p: extra ${String(r.extra).padStart(4)} missing ${String(r.missing).padStart(4)}` +
        `  empty<=${r.emptyMax.toFixed(2)} solid>=${(1 - r.solidMax).toFixed(2)}  aaMax ${r.aaMax.toFixed(3)}@${r.aaAt}  mono ${String(r.monoBad).padStart(4)}/${r.monoWorst.toFixed(2)}@${r.monoAt}\n         AA  ${r.aaAt} ${r.whyAa}\n         EMPTY ${r.emptyAt} ${r.whyEmpty}\n         SOLID ${r.solidAt2} ${r.whySolid}`,
    );
