// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// shapeResolve — make a contour set SIMPLE, before any engine decides how to draw it.
//
// Resolving a self-intersection is a fact about the geometry, not about an engine: it takes
// contours that cross themselves and returns contours that do not, under a given fill rule. It
// lived inside Loop-Blinn's fast-mesh module, where only Loop-Blinn could reach it — and CPatch,
// which assumes simple input, had no equivalent and filled a pentagram's center solid (6096 wrong
// pixels) rather than leaving it hollow.
//
// Nothing in it is Loop-Blinn's. It reads the shared segment form and its two real dependencies,
// unionPaths and intersectSegments, already live in the engine-neutral pathBoolean tree.
//
// lbFastMesh re-exports it, so every existing importer is untouched.
import {
  SEG_LINE,
  SEG_QUAD,
  SEG_CUBIC,
  SEG_RQUAD,
  mkLine,
  mkQuad,
  mkCubic,
} from '../primitives/seg.js';
import { unionPaths, canonicalScale, scaleSegBy } from '../svg/pathBoolean/union.js';
import { intersectSegments } from '../svg/pathBoolean/intersect/index.js';
import { intersectSegmentsExact } from '../svg/pathBoolean/intersect/exact.js';
import { exactCrossings } from '../geom/cpatchGraph.js';
import { segSlice } from '../geom/cpatchImplicit.js';

const fromTP = (c) =>
  c.t === 'line'
    ? mkLine(c.P[0], c.P[1])
    : c.t === 'quad'
      ? mkQuad(c.P[0], c.P[1], c.P[2])
      : mkCubic(c.P[0], c.P[1], c.P[2], c.P[3]);

///
/// The "unchanged" contract is preserved by IDENTITY: callers test `out !== contours` to learn
/// whether anything was resolved, so an untouched result hands back the caller's own array rather
/// than a scaled copy of it.
export function resolveSelfOverlap(contours, fillRule) {
  const _f = canonicalScale(contours);
  if (_f === 1) return _resolveSelfOverlapAt(contours, fillRule);
  const scaled = contours.map((c) => c.map((sg) => scaleSegBy(sg, _f)));
  const out = _resolveSelfOverlapAt(scaled, fillRule);
  if (out === scaled) return contours;
  return out ? out.map((c) => c.map((sg) => scaleSegBy(sg, 1 / _f))) : out;
}

function _resolveSelfOverlapAt(contours, fillRule) {
  // Rational arcs (ellipses/lenses/rings) legitimately produce chord-sag geometry the
  // crossing tests misread, and their overlap pathologies aren't the TT-quad abutment
  // class this exists for — skip them (their own SDF/annulus machinery applies).
  for (const c of contours) for (const sg of c) if (sg.type === SEG_RQUAD) return contours;
  const share = (p, q) => Math.abs(p[0] - q[0]) < 1e-12 && Math.abs(p[1] - q[1]) < 1e-12;
  // exact self-intersection detection — no flattening.

  // The path-boolean pipeline already carries an exact intersection kernel for
  // every type pair (line/quad/cubic/arc), which is what the union step itself
  // uses. Use it here too: one source of truth, exact at any scale.
  //
  // Callers reach this only after the share() guard drops segments meeting at a
  // shared endpoint, so ANY intersection that survives is a genuine self-
  // intersection — including an endpoint of one segment lying on another
  // (a T-junction), which a strict test would miss.
  /** @type {Array<{sg:any,ci:number,a:number[],b:number[],x0:number,x1:number,y0:number,y1:number,cuts?:Array<{t:number,p:number[]}>}>} */
  const segsAll9 = [];
  let ci9 = 0;
  for (const c of contours) {
    ci9++;
    for (const sg of c) {
      const pN = sg.type === SEG_LINE ? sg.p2 : sg.type === SEG_CUBIC ? sg.p4 : sg.p3;
      let x0 = Math.min(sg.p1[0], pN[0]),
        x1 = Math.max(sg.p1[0], pN[0]);
      let y0 = Math.min(sg.p1[1], pN[1]),
        y1 = Math.max(sg.p1[1], pN[1]);
      if (sg.type !== SEG_LINE) {
        for (const cp of [sg.p2, sg.p3])
          if (cp) {
            x0 = Math.min(x0, cp[0]);
            x1 = Math.max(x1, cp[0]);
            y0 = Math.min(y0, cp[1]);
            y1 = Math.max(y1, cp[1]);
          }
      }
      segsAll9.push({ sg, ci: ci9, a: sg.p1, b: pN, x0, x1, y0, y1 });
    }
  }

  let jx0 = Infinity,
    jy0 = Infinity,
    jx1 = -Infinity,
    jy1 = -Infinity;
  for (const S9 of segsAll9) {
    if (S9.x0 < jx0) jx0 = S9.x0;
    if (S9.x1 > jx1) jx1 = S9.x1;
    if (S9.y0 < jy0) jy0 = S9.y0;
    if (S9.y1 > jy1) jy1 = S9.y1;
  }
  const jointEps = 1e-6 * (Math.hypot(jx1 - jx0, jy1 - jy0) || 1);
  let crossing = false;

  const toTP = (sg) => ({
    t: sg.type === SEG_LINE ? 'line' : sg.type === SEG_CUBIC ? 'cubic' : 'quad',
    P: [sg.p1, sg.p2, sg.p3, sg.p4].filter(Boolean),
  });
  let anyCut = false;
  // x-sweep: sorted by x0, the inner scan stops at the first j whose x0 exceeds
  // SI.x1 — pair enumeration drops from N²/2 to N·overlap (flat N² spends
  // whole seconds on organic many-hundred-segment shapes).
  segsAll9.sort((a9, b9) => a9.x0 - b9.x0);
  outer: for (let i = 0; i < segsAll9.length; i++) {
    const SI = segsAll9[i];
    for (let j = i + 1; j < segsAll9.length; j++) {
      const SJ = segsAll9[j];
      if (SJ.x0 > SI.x1) break;
      if (SI.y1 < SJ.y0 || SJ.y1 < SI.y0) continue;
      if (SI.sg.type !== SEG_LINE && SJ.sg.type !== SEG_LINE) {
        // only the crossings the clipper does NOT report are cut in (exactCrossings drops the
        // ones it does, by position); the ones it does, the union already handles
        let hits0 = null;
        try {
          hits0 = intersectSegments(SI.sg, SJ.sg);
        } catch {
          hits0 = null;
        }
        let extra = null;
        // not for a pair answered as one curve: see intersect/exact.js
        if (!(hits0 && hits0.some((h) => h.sameCurve)))
          try {
            extra = exactCrossings(toTP(SI.sg), toTP(SJ.sg), hits0);
          } catch {
            extra = null;
          }
        if (extra && extra.length) {
          for (const e of extra) {
            (SI.cuts || (SI.cuts = [])).push({ t: e.tA, p: [e.x, e.y] });
            (SJ.cuts || (SJ.cuts = [])).push({ t: e.tB, p: [e.x, e.y] });
            anyCut = true;
            crossing = true;
          }
        }
      }
      if (crossing && !anyCut) continue; // already decided; only cuts are still being collected
      // Segments that MEET at a shared vertex are not thereby self-intersecting —
      // but they may still CROSS somewhere else, and skipping the pair outright
      // misses that. The S-cubic `M16 64 C16 16 112 112 112 64 Z` is exactly this:
      // its curve and its closing chord share both endpoints and also cross at
      // (64,64), so the blanket skip declared it simple. It then kept ONE
      // interiorSign for a boundary whose fill side flips at the crossing, and the
      // chord rim over-filled the concave lobe — 1272 of 1621 px, max 1.00, at
      // every scale from 16 to 512.
      //
      // With exact intersections available, filter precisely: ignore hits that
      // land ON a shared endpoint, count everything else.
      const shared = [];
      if (share(SI.a, SJ.a)) shared.push(SI.a);
      if (share(SI.a, SJ.b)) shared.push(SI.a);
      if (share(SI.b, SJ.a)) shared.push(SI.b);
      if (share(SI.b, SJ.b)) shared.push(SI.b);
      let hits;
      try {
        hits = intersectSegments(SI.sg, SJ.sg);
      } catch {
        hits = null;
      }
      if (!hits || !hits.length) continue;
      for (const h of hits) {
        let atShared = false;
        for (const sp of shared)
          if (Math.abs(h.x - sp[0]) < jointEps && Math.abs(h.y - sp[1]) < jointEps) {
            atShared = true;
            break;
          }
        if (!atShared) {
          crossing = true;
          break;
        }
      }
    }
  }
  if (!crossing) return contours;
  if (anyCut) {
    // Split every segment at the crossings the clipper missed, both pieces ending on the one
    // polished point. Contour order and segment order are preserved.
    const cutsOf = new Map();
    for (const S9 of segsAll9) if (S9.cuts) cutsOf.set(S9.sg, S9.cuts);
    contours = contours.map((c) => {
      const out = [];
      for (const sg of c) {
        const cuts = cutsOf.get(sg);
        if (!cuts) {
          out.push(sg);
          continue;
        }
        const tp = toTP(sg);
        const ts = cuts.slice().sort((u, v) => u.t - v.t);
        let prev = 0,
          prevP = null;
        for (const cut of ts) {
          if (cut.t - prev < 1e-9) continue;
          const piece = segSlice(tp, prev, cut.t);
          if (prevP) piece.P[0] = prevP;
          piece.P[piece.P.length - 1] = cut.p;
          out.push(fromTP(piece));
          prev = cut.t;
          prevP = cut.p;
        }
        const last = segSlice(tp, prev, 1);
        if (prevP) last.P[0] = prevP;
        out.push(fromTP(last));
      }
      return out;
    });
  }

  let flat;
  try {
    flat = unionPaths([{ segs: contours.flat(), fillRule: fillRule || 'nonzero' }], {
      intersect: intersectSegmentsExact,
    });
  } catch {
    flat = null;
  }
  if (!flat || !flat.length) return null;
  // The union must not lose the shape.

  // A failed resolve is already an understood outcome here — `!flat.length`
  // returns null and the caller falls back to Slug, which is correct, just
  // slower. A collapsed resolve is the same failure and gets the same answer.
  // The test is for COLLAPSE, not for precision: a self-union legitimately
  // changes area (a bowtie's union differs from its signed area), so this only
  // fires when essentially nothing survives relative to the input's own extent.
  {
    //
    // 5% is deliberately far below anything legitimate. A self-union CAN shrink
    // the area honestly, because a signed traversal double-counts overlap: a path
    // doubled back on itself has |signed| = 2x its union, a tripled one 3x. So the
    // honest floor is ~1/3, and 5% only ever fires on a genuine collapse.
    const eo9 = (sg) => (sg.type === SEG_LINE ? sg.p2 : sg.type === SEG_CUBIC ? sg.p4 : sg.p3);
    const shoe = (list) => {
      let A2 = 0;
      for (const sg of list) {
        const a2 = sg.p1,
          b2 = eo9(sg);
        A2 += a2[0] * b2[1] - b2[0] * a2[1];
      }
      return Math.abs(A2) / 2;
    };
    const inA = shoe(contours.flat());
    if (inA > 0 && shoe(flat) < 0.05 * inA) return null; // collapsed -> Slug
  }
  const out = [];
  let cur = [];
  const endOf = (sg) => (sg.type === SEG_LINE ? sg.p2 : sg.type === SEG_CUBIC ? sg.p4 : sg.p3);
  // SPLITTING THE UNION OUTPUT NEEDS A GEOMETRIC TOLERANCE, not share()'s 1e-12.

  let bx0 = Infinity,
    by0 = Infinity,
    bx1 = -Infinity,
    by1 = -Infinity;
  for (const sg of flat) {
    for (const p of [sg.p1, endOf(sg)]) {
      if (p[0] < bx0) bx0 = p[0];
      if (p[0] > bx1) bx1 = p[0];
      if (p[1] < by0) by0 = p[1];
      if (p[1] > by1) by1 = p[1];
    }
  }
  const diag = Math.hypot(bx1 - bx0, by1 - by0) || 1;
  const eps = 1e-6 * diag;
  const chained = (p, q) => Math.abs(p[0] - q[0]) <= eps && Math.abs(p[1] - q[1]) <= eps;
  // CONSECUTIVE PIECES SHARE ONE VERTEX, exactly. The union computes each piece's endpoints on
  // its own, so two pieces meeting at a crossing agree only to rounding -- 1e-13 apart on a
  // glyph-scale shape at x = 12, exactly equal at the origin -- and the partition downstream
  // keys points by identity. Snapping a piece's start to the previous piece's end (and the
  // cycle's last end to its first start) is what makes the resolved outline the same outline
  // wherever the shape sits (lbTranslationInvarianceSmoke).
  for (const sg of flat) {
    if (cur.length) {
      const prevEnd = endOf(cur[cur.length - 1]);
      if (!chained(prevEnd, sg.p1)) {
        closeCycle(cur);
        out.push(cur);
        cur = [];
      } else sg.p1 = prevEnd;
    }
    cur.push(sg);
  }
  if (cur.length) {
    closeCycle(cur);
    out.push(cur);
  }
  return out;
  function closeCycle(c) {
    const last = c[c.length - 1],
      first = c[0];
    const e = endOf(last);
    if (!chained(e, first.p1)) return;
    if (last.type === SEG_LINE) last.p2 = first.p1;
    else if (last.type === SEG_CUBIC) last.p4 = first.p1;
    else last.p3 = first.p1;
  }
}
