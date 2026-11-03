// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Probe-only preparation. Polynomial control points and fixed-parameter cuts
// commute with interpolation. Native arcs/variable rational weights do not.
import { headlessCPatchBundle } from '../../src/renderer/cpatchBuild.js';
import { curveRangeToContours } from '../../src/geom/lbContour.js';
import { _toCurvesPair } from '../../src/renderer/cpatchMorphBuild.js';
import {
  convertContour,
  morphTolPx,
  framePatch,
  validatePatch,
  loopSignedArea,
} from '../../src/renderer/cpatchConvert.js';
import {
  planMorph,
  splitForMorph,
  applyLayout,
  certifyMorphClip,
  certifyMorphLeak,
} from '../../src/renderer/cpatchMorphCert.js';
import * as L from '../../src/bundle/layout.js';
import { pathData } from './serialize.mjs';
import { hullsOverlap } from '../../src/geom/cpatchGraph.js';

export const lerpPolynomialPose = (A, B, t) =>
  A.map((c, i) => ({ ...c, P: c.P.map((p, k) => p.map((v, j) => v + (B[i].P[k][j] - v) * t)) }));
export function controlBounds(...loops) {
  const P = loops.flat().flatMap((c) => c.P);
  return [
    Math.min(...P.map((p) => p[0])),
    Math.min(...P.map((p) => p[1])),
    Math.max(...P.map((p) => p[0])),
    Math.max(...P.map((p) => p[1])),
  ];
}
function positiveDirection(vectors) {
  // Every constraint is n.v > 0. Its two angular boundaries partition the
  // circle; test each open cell. Endpoint signs then hold for every lerped v.
  const tau = 2 * Math.PI,
    angles = vectors
      .flatMap((v) => [Math.atan2(v[1], v[0]) + Math.PI / 2, Math.atan2(v[1], v[0]) - Math.PI / 2])
      .map((a) => ((a % tau) + tau) % tau)
      .sort((a, b) => a - b);
  for (let i = 0; i < angles.length; i++) {
    const a = (angles[i] + (i + 1 < angles.length ? angles[i + 1] : angles[0] + tau)) / 2,
      n = [Math.cos(a), Math.sin(a)];
    if (vectors.every((v) => n[0] * v[0] + n[1] * v[1] > Math.hypot(...v) * 2 ** -38)) return n;
  }
  return null;
}
export function certifySimplePolynomialSpan(A, B) {
  for (let i = 0; i < A.length; i++) {
    const derivatives = [A[i], B[i]].flatMap((c) =>
      c.P.slice(1).map((p, k) => p.map((v, j) => v - c.P[k][j])),
    );
    if (!positiveDirection(derivatives)) throw Error('Curve injectivity is unproved over interval');
    const next = (i + 1) % A.length,
      vectors = [];
    for (const cs of [A, B]) {
      const end = cs[i].P.at(-1),
        begin = cs[next].P[0];
      if (end.some((v, k) => v !== begin[k])) throw Error('Open morph contour');
      vectors.push(
        ...cs[i].P.slice(0, -1).map((p) => end.map((v, k) => v - p[k])),
        ...cs[next].P.slice(1).map((p) => p.map((v, k) => v - end[k])),
      );
    }
    if (!positiveDirection(vectors))
      throw Error('Adjacent-curve separation is unproved over interval');
    for (let j = i + 2; j < A.length; j++) {
      if (i === 0 && j === A.length - 1) continue;
      if (hullsOverlap([...A[i].P, ...B[i].P], [...A[j].P, ...B[j].P]))
        throw Error('Nonadjacent-curve separation is unproved over interval');
    }
  }
}
const signature = (loops) =>
  loops.map((cs) => cs.map((c) => c.t + ':' + c.P.length).join(',')).join('|');
function assertCorrespondence(lo, hi, actual, u) {
  if (
    !lo ||
    !hi ||
    !actual ||
    signature(lo) !== signature(hi) ||
    signature(lo) !== signature(actual)
  )
    throw Error('Piece topology changes within interval');
  const b = controlBounds(...lo, ...hi),
    scale = Math.max(1, ...b.map(Math.abs));
  for (let i = 0; i < lo.length; i++)
    for (let j = 0; j < lo[i].length; j++)
      for (let k = 0; k < lo[i][j].P.length; k++)
        for (let axis = 0; axis < 2; axis++) {
          const a = lo[i][j].P[k][axis],
            z = hi[i][j].P[k][axis];
          if (Math.abs(actual[i][j].P[k][axis] - (a + (z - a) * u)) > scale * 2 ** -39)
            throw Error('Piece control point is not affine in morph parameter');
        }
}
function certifyCells(lo, hi, tolPx, deadline, stats) {
  for (let i = 0; i < lo.length; i++) {
    // applyLayout removes tiny cut lines. Establish over the entire interval
    // that none can vanish between sampled poses: its endpoint difference is
    // affine, so its squared length has an exact quadratic minimum.
    const b = controlBounds(lo[i], hi[i]),
      eps = Math.max(b[2] - b[0], b[3] - b[1]) * 1e-6;
    for (let j = 0; j < lo[i].length; j++)
      if (lo[i][j].t === 'line' && lo[i][j].cut) {
        const A = lo[i][j].P,
          B = hi[i][j].P,
          d = A[1].map((v, k) => v - A[0][k]),
          z = B[1].map((v, k) => v - B[0][k] - d[k]);
        const zz = z[0] * z[0] + z[1] * z[1],
          u = zz ? Math.max(0, Math.min(1, -(d[0] * z[0] + d[1] * z[1]) / zz)) : 0;
        if (Math.hypot(d[0] + z[0] * u, d[1] + z[1] * u) <= eps)
          throw Error('Cut can disappear inside morph interval');
      }
    const opts = { tolPx, deadline, maxBoxes: 1e6 };
    const clip = certifyMorphClip(lo[i], hi[i], opts);
    stats.clipBoxes += clip.boxes || 0;
    if (clip.failures.length || clip.inconclusive || clip.overTime || clip.overBudget)
      throw Error('Unproved clip interval');
    const leak = certifyMorphLeak(lo[i], hi[i], opts);
    stats.leakBoxes += leak.boxes || 0;
    if (leak.failures.length || leak.overTime || leak.overBudget)
      throw Error('Unproved leak interval');
  }
}
export function polynomialMorphShapes(sectionsA, sectionsB) {
  const a = headlessCPatchBundle(sectionsA),
    b = headlessCPatchBundle(sectionsB);
  if (a.numShapes !== b.numShapes) throw Error('Different shape counts');
  const shapes = [];
  for (let i = 0; i < a.numShapes; i++) {
    if (sectionsA.shapeIds?.[i] !== sectionsB.shapeIds?.[i])
      throw Error('Shape identity/order changes');
    const ma = a.metaFloats.subarray(i * a.metaFloatsPerShape, (i + 1) * a.metaFloatsPerShape),
      mb = b.metaFloats.subarray(i * b.metaFloatsPerShape, (i + 1) * b.metaFloatsPerShape);
    for (const k of [
      'META_STROKE_A',
      'META_FILL_GRAD',
      'META_CLIP_ID',
      'META_MASK_ID',
      'META_FILTER_ID',
      'META_BLEND_MODE',
      'META_ISOLATION',
      'META_IMAGE_ID',
      'META_COLR_GRAPH',
    ])
      if (ma[L[k]] || mb[L[k]]) throw Error('Unsupported morph paint ' + k);
    const slots = [L.META_FILL_R, L.META_FILL_G, L.META_FILL_B, L.META_FILL_A],
      color = slots.map((k) => ma[k]);
    if (slots.some((k) => ma[k] !== mb[k]))
      throw Error('Paint changes require a separate interpolation proof');
    if (!color[3]) continue;
    const ra = a.curveRangesByShape[i],
      rb = b.curveRangesByShape[i];
    const ca = curveRangeToContours(a.curveFloats, ra.begin, ra.end),
      cb = curveRangeToContours(b.curveFloats, rb.begin, rb.end);
    if (ca.length !== 1 || cb.length !== 1)
      throw Error('Multi-contour morph needs matched bridge provenance');
    const pair = _toCurvesPair(ca[0], cb[0]);
    if (
      !pair ||
      pair.A.some(
        (c, k) =>
          !['line', 'quad', 'cubic'].includes(c.t) ||
          c.t !== pair.B[k].t ||
          c.P.length !== pair.B[k].P.length,
      )
    )
      throw Error('Only matching polynomial curve types are certified');
    shapes.push({ shape: i, originalA: pair.A, originalB: pair.B, color });
  }
  if (!shapes.length) throw Error('No filled polynomial morph shapes');
  return shapes;
}
export function preparePolynomialMorph(sectionsA, sectionsB, opts = {}) {
  const start = performance.now(),
    deadline = start + (opts.maxPreparationMs ?? 15000);
  const shapes = polynomialMorphShapes(sectionsA, sectionsB),
    stats = {
      planMs: 0,
      verificationMs: 0,
      serializationMs: 0,
      clipBoxes: 0,
      leakBoxes: 0,
      plans: [],
    };
  // Validate every paint/curve first. A supported first shape must not spend
  // seconds planning before a later native arc or changed paint declines it.
  for (const s of shapes) {
    const [A, B] = splitForMorph(s.originalA, s.originalB),
      tolPx = morphTolPx(A, B),
      report = {},
      pt = performance.now();
    const convert = (cs, o) =>
      convertContour(cs, {
        maxCurves: 8,
        tolPx,
        noCurveCuts: true,
        forceBezout: true,
        leakMargin: o?.leakMargin || 0,
      });
    const plan = planMorph(A, B, convert, {
      tolPx,
      report,
      maxPlanMs: Math.max(1, Math.min(opts.maxPlanMs ?? 5000, deadline - performance.now())),
    });
    stats.planMs += performance.now() - pt;
    stats.plans.push({ shape: s.shape, ...report });
    if (!plan || plan.some((s) => s.forced))
      throw Error('No fully certified morph plan: ' + JSON.stringify(report));
    Object.assign(s, { A, B, tolPx, plan });
  }
  const cuts = [
      ...new Set([0, 1, ...shapes.flatMap((s) => s.plan.flatMap((p) => [p.t0, p.t1]))]),
    ].sort((x, y) => x - y),
    intervals = [];
  for (let ci = 0; ci + 1 < cuts.length; ci++) {
    const t0 = cuts[ci],
      t1 = cuts[ci + 1],
      groupsLo = [],
      groupsHi = [];
    for (const s of shapes) {
      const layout = s.plan.find((p) => (t0 + t1) / 2 >= p.t0 && (t0 + t1) / 2 <= p.t1)?.layout;
      if (!layout) throw Error('Gap in morph plan');
      const pose = (t) => lerpPolynomialPose(s.A, s.B, t),
        lo = applyLayout(layout, pose(t0)),
        hi = applyLayout(layout, pose(t1)),
        vt = performance.now();
      // A sum of winding integrals equals filled area only while the original
      // contour is simple. Prove that separately; CPatch cell certificates
      // alone cannot establish a morph's global fill-rule topology.
      certifySimplePolynomialSpan(
        lerpPolynomialPose(s.originalA, s.originalB, t0),
        lerpPolynomialPose(s.originalA, s.originalB, t1),
      );
      assertCorrespondence(lo, hi, lo, 0);
      certifyCells(lo, hi, s.tolPx, deadline, stats);
      // Independent static validation rejects certificate/sampling disagreement.
      for (let k = 0; k <= 16; k++) {
        if (performance.now() > deadline) throw Error('Morph preparation deadline');
        const u = k / 16,
          p = pose(t0 + (t1 - t0) * u),
          cells = applyLayout(layout, p);
        assertCorrespondence(lo, hi, cells, u);
        for (const cs of cells) {
          const f = framePatch(cs);
          if (!f || !validatePatch(f, s.tolPx).ok) throw Error('Invalid interior piece');
        }
        const area = loopSignedArea(p),
          sum = cells.reduce((v, cs) => v + loopSignedArea(cs), 0);
        if (cells.some((cs) => loopSignedArea(cs) * area <= 0))
          throw Error('Piece orientation disagrees with original contour');
        if (Math.abs(area - sum) > Math.max(1, Math.abs(area)) * 2 ** -30)
          throw Error('Pieces do not preserve signed area');
      }
      stats.verificationMs += performance.now() - vt;
      const st = performance.now(),
        pieceBboxes = lo.map((cs, i) => controlBounds(cs, hi[i])),
        bbox = controlBounds(...lo, ...hi);
      for (const [cells, groups] of [
        [lo, groupsLo],
        [hi, groupsHi],
      ])
        groups.push({
          shape: s.shape,
          pieces: cells.length,
          color: s.color,
          bbox,
          pieceBboxes,
          svg:
            '<svg xmlns="http://www.w3.org/2000/svg">' +
            cells
              .map(
                (cs, i) =>
                  `<path id="morph_${s.shape}_${i}" fill="white" fill-opacity="0.5" d="${pathData([cs])}"/>`,
              )
              .join('') +
            '</svg>',
        });
      stats.serializationMs += performance.now() - st;
    }
    intervals.push({ t0, t1, groupsLo, groupsHi });
  }
  return {
    intervals,
    stats: {
      ...stats,
      totalMs: performance.now() - start,
      intervals: intervals.length,
      shapes: shapes.length,
      maxPieces: Math.max(...intervals.map((p) => p.groupsLo.reduce((n, g) => n + g.pieces, 0))),
      scope:
        'F32 endpoint geometry, CPatch interval planning, strict recertification, 17 static/correspondence checks per interval, serialization; endpoint import and browser upload separate',
    },
  };
}
