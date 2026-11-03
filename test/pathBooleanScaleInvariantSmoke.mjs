// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// pathBooleanScaleInvariantSmoke — the path-boolean kernels give the same answers at every size.
//
// THE PROPERTY. Scaling a drawing by any factor, or moving it, must scale and move the intersections
// and change nothing else. Every defect of this family broke that: an absolute epsilon compared a
// quantity that carries the drawing's scale. intersectSegments scales each PAIR to a canonical extent,
// so a uniform scale only reaches the kernels through the mantissa -- the tolerances that break are
// the ones that measure one segment against the PAIR (a short line, a small arc, a small curved quad),
// and the ones that run before the scaling. So this test moves along both axes: the whole pair (world
// scale 1e-6..1e6, with and without an origin offset) and one member against the other (shrunk about
// the crossing by up to 1e-6).
//
// (a) real pairs: every box-overlapping pair of segments within each tracked example SVG, at 1e-6,
//     1e-3, 1e3 and 1e6 with and without an offset, against scale 1 -- the crossings a consumer cuts at
//     (every hit except a shared vertex) match in count and parameters
// (b) a crossing of every kernel pair, B shrunk about it by 1..1e-6, at every world scale and offset:
//     exactly that crossing, with its parameters
// (c) a small circle far from a large one never crosses it, at any size of either
// (d) the zero polynomial has no roots rather than NaN ones, and two straight quads on one line
//     intersect with finite parameters
// (e) pointInShape classifies a small shape's points the same at every world scale
// (f) subdivideYMonotone splits a small curved quad and a small turned ellipse at their tops
//
// Pairs of quads and cubics that reach the Bezier clipper are asked through intersectSegmentsExact,
// what every union caller runs: the clipper alone drops crossings through its absolute
// controlPointsCoincide. At a shrink of 1e-6 the clipper loses the crossing and the exact supplement
// (cpatchGraph exactCrossings) is what finds it -- which needs its at-a-vertex test to be relative to
// the segment, not 1e-6 of the PAIR, which a segment that small lies inside.
// (b3) exactCrossings alone, the CPatch front end's supplement: a crossing on a segment 1e-2..1e-7 of
//     its partner, at every size and offset
// (b4) exactCrossings against the clipper's hits, at every size and offset: a hit 3e-6 of the pair off
//     its crossing (past a 1e-6 position bound) is that crossing and is not cut twice; a hairpin
//     crossing a quad twice 3.9e-7 of the pair apart keeps the crossing the clipper did not report; and a
//     hit with snapped parameters is not carried onto a crossing it is not
import { readFileSync, readdirSync } from 'fs';
import { parsePathD } from '../src/svg/path.js';
import { intersectSegments } from '../src/svg/pathBoolean/intersect/index.js';
import { intersectSegmentsExact } from '../src/svg/pathBoolean/intersect/exact.js';
import { exactCrossings } from '../src/geom/cpatchGraph.js';
import { pointInShape } from '../src/svg/pathBoolean/planar/fillRule.js';
import { solveQuadratic, solveCubic, solveQuartic } from '../src/svg/pathBoolean/polyRoots.js';
import { subdivideYMonotone } from '../src/svg/pathBoolean/subdivide.js';
import { mkArc } from '../src/svg/segment.js';

let fail = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? 'ok' : 'FAIL'} ${msg}`);
  if (!ok) fail++;
};
const SCALES = [1e-6, 1e-3, 1e3, 1e6];
const offsetFor = (f, on) => (on ? [7.3e3 * f, -2.9e4 * f] : [0, 0]);
const clipperPair = (a, b) =>
  (a.type === 1 || a.type === 2) &&
  (b.type === 1 || b.type === 2) &&
  (a.type === 2 || b.type === 2);
const isect = (a, b) =>
  clipperPair(a, b) ? intersectSegmentsExact(a, b) : intersectSegments(a, b);
// What a consumer cuts at: everything but a vertex both segments already share.
const cuts = (hits) =>
  hits.filter((h) => !((h.tA < 1e-6 || h.tA > 1 - 1e-6) && (h.tB < 1e-6 || h.tB > 1 - 1e-6)));
const xform = (s, f, o, k = 1, X = [0, 0]) => {
  const P = (p) => [(X[0] + k * (p[0] - X[0])) * f + o[0], (X[1] + k * (p[1] - X[1])) * f + o[1]];
  if (s.type === 3) {
    const c = P([s.cx, s.cy]);
    return mkArc(
      c[0],
      c[1],
      s.rx * k * f,
      s.ry * k * f,
      s.theta_start,
      s.theta_end,
      s.phi,
      s.large_arc_flag,
      s.sweep_flag,
    );
  }
  const q = { type: s.type };
  for (const key of ['p1', 'p2', 'p3', 'p4']) if (s[key]) q[key] = P(s[key]);
  return q;
};
const box = (s) => {
  if (s.type === 3) {
    const r = Math.max(s.rx, s.ry);
    return [s.cx - r, s.cy - r, s.cx + r, s.cy + r];
  }
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const p of [s.p1, s.p2, s.p3, s.p4])
    if (p) {
      x0 = Math.min(x0, p[0]);
      y0 = Math.min(y0, p[1]);
      x1 = Math.max(x1, p[0]);
      y1 = Math.max(y1, p[1]);
    }
  return [x0, y0, x1, y1];
};

// Near-endpoint crossing lost when only one implicit composition has roots.
{
  const A = {
    type: 2,
    p1: [2.8811, 42.5241],
    p2: [2.8947, 42.7599],
    p3: [2.6929, 42.909],
    p4: [2.4742, 42.8463],
  };
  const B = {
    type: 2,
    p1: [2.5258, 42.1121],
    p2: [2.7501, 42.1432],
    p3: [2.9208, 42.345],
    p4: [2.8811, 42.5242],
  };
  for (const f of [1e-6, 1e-3, 1, 1e3, 1e6])
    for (const moved of [false, true]) {
      const o = offsetFor(f, moved);
      const hits = intersectSegmentsExact(xform(A, f, o), xform(B, f, o));
      check(
        hits.length === 1 &&
          Math.abs(hits[0].tA - 0.0001122023318) < 5e-7 &&
          Math.abs(hits[0].tB - 0.9999616234276) < 5e-7,
        `near-endpoint cubic crossing at scale ${f}, translated ${moved}: one crossing at the same parameters`,
      );
    }
}

console.log('(a) real pairs, every size and offset');
{
  const root = new URL('../examples/', import.meta.url);
  const files = [];
  for (const dir of ['', 'smoke/'])
    for (const f of readdirSync(new URL(dir, root)))
      if (f.endsWith('.svg') && !f.startsWith('tiger')) files.push(dir + f);
  const pairs = [];
  let cubicPairs = 0;
  for (const f of files) {
    const segs = [];
    for (const m of readFileSync(new URL(f, root), 'utf8').matchAll(/\sd="([^"]+)"/g)) {
      try {
        for (const s of parsePathD(m[1])) segs.push(s);
      } catch {
        /* not a path this test reads */
      }
    }
    const bb = segs.map(box);
    for (let i = 0; i < segs.length; i++)
      for (let j = i + 1; j < segs.length; j++) {
        if (
          bb[i][2] < bb[j][0] ||
          bb[j][2] < bb[i][0] ||
          bb[i][3] < bb[j][1] ||
          bb[j][3] < bb[i][1]
        )
          continue;
        // Cubic pairs are most of the corpus and the slowest; every fifth keeps the run short.
        if (segs[i].type === 2 && segs[j].type === 2 && cubicPairs++ % 5) continue;
        pairs.push([segs[i], segs[j]]);
      }
  }
  const byKind = {};
  for (const [A, B] of pairs) {
    const kind = `${Math.min(A.type, B.type)}x${Math.max(A.type, B.type)}`;
    const k = byKind[kind] || (byKind[kind] = { n: 0, bad: 0 });
    k.n++;
    const ref = cuts(isect(A, B));
    let same = ref.every((h) => Number.isFinite(h.tA) && Number.isFinite(h.tB));
    const diffs = [];
    for (const f of SCALES)
      for (const on of [false, true]) {
        if (!same) break;
        const o = offsetFor(f, on);
        const got = cuts(isect(xform(A, f, o), xform(B, f, o)));
        same =
          got.length === ref.length &&
          ref.every((r) =>
            got.some((g) => Math.abs(g.tA - r.tA) <= 1e-6 && Math.abs(g.tB - r.tB) <= 1e-6),
          );
        if (!same) diffs.push({ scale: f, offset: o, got: got.map((g) => [g.tA, g.tB]) });
      }
    if (!same) {
      k.bad++;
      // Name the pair: which segments, and which sizes disagree with scale 1.
      console.log(
        `    DIFFERS ${kind}: A=${JSON.stringify(A)} B=${JSON.stringify(B)}\n      scale 1 answers ${JSON.stringify(ref.map((h) => [h.tA, h.tB]))}; ${JSON.stringify(diffs)}`,
      );
    }
  }
  const names = ['line', 'quad', 'cubic', 'arc'];
  for (const [kind, v] of Object.entries(byKind).sort()) {
    const [a, b] = kind.split('x').map(Number);
    check(
      v.bad === 0,
      `${names[a]} x ${names[b]}: ${v.n - v.bad}/${v.n} pairs answer the same at every size`,
    );
  }
  // Held as a fixed case: a 1e-4 line leaving the end of a 0.4 cubic (the corpus pair in
  // examples/smoke/unifiedFillCurveTexWideIndex__SVG.svg). Their only meeting is the shared vertex, exactly. The
  // power-form end b(1) must not be rounded by an ulp of the pair's OFFSET, which puts the root 2e-10 of the parameter
  // off s = 1 and the crossing 1e-6 of the short line off its vertex -- only once the pair sits far from the origin.
  {
    const A = {
      type: 2,
      p1: [39.5011, 22.1153],
      p2: [39.7458, 22.1301],
      p3: [39.8964, 22.2939],
      p4: [39.8916, 22.5011],
    };
    const B = { type: 0, p1: [39.8916, 22.5011], p2: [39.8916, 22.501] };
    let bad = 0,
      n = 0;
    for (const f of [1, ...SCALES])
      for (const on of [false, true]) {
        const o = offsetFor(f, on);
        const all = intersectSegments(xform(A, f, o), xform(B, f, o));
        n++;
        if (
          cuts(all).length !== 0 ||
          all.length !== 1 ||
          Math.abs(all[0].tA - 1) > 1e-9 ||
          Math.abs(all[0].tB) > 1e-9
        ) {
          bad++;
          console.log(
            `    scale ${f} offset ${o}: ${JSON.stringify(all.map((h) => [h.tA, h.tB]))}`,
          );
        }
      }
    check(
      bad === 0,
      `a short line leaving the end of a cubic: exactly the shared vertex, at ${n - bad}/${n} sizes and offsets`,
    );
  }
  // A CUBIC PAIR held here as a fixed case: a closed two-cubic lens TANGENT at one shared end (A's last control point
  // is B's first). The clipper can converge on the tangency anywhere in a stretch the curves are closer than its fat
  // line there, reporting a crossing at 0.99999 / 1.0e-5 at one size and none, or another, at other sizes. Its only meetings are its two shared ends, exactly, at every size.
  {
    const cub = (P) => ({ type: 2, p1: P[0], p2: P[1], p3: P[2], p4: P[3] });
    const A = cub([
        [40, 150],
        [60, 110],
        [140, 190],
        [160, 150],
      ]),
      B = cub([
        [160, 150],
        [140, 190],
        [60, 190],
        [40, 150],
      ]);
    let bad = 0,
      n = 0;
    for (const f of [1, ...SCALES])
      for (const on of [false, true]) {
        const o = offsetFor(f, on);
        const all = isect(xform(A, f, o), xform(B, f, o));
        const ends = all.filter(
          (h) => (h.tA === 0 && h.tB === 1) || (h.tA === 1 && h.tB === 0),
        ).length;
        n++;
        if (cuts(all).length !== 0 || ends !== 2 || all.length !== 2) bad++;
      }
    check(
      bad === 0,
      `a two-cubic lens tangent at one shared end: exactly its two shared ends and nothing to cut, at ${n - bad}/${n} sizes and offsets`,
    );
  }
}

console.log('(b) one member shrunk about the crossing, at every size');
{
  const line = (a, b) => ({ type: 0, p1: a, p2: b });
  const quad = (a, b, c) => ({ type: 1, p1: a, p2: b, p3: c });
  const cub = (a, b, c, d) => ({ type: 2, p1: a, p2: b, p3: c, p4: d });
  const at = (s, t) => {
    if (s.type === 3) {
      const th = s.theta_start + (s.theta_end - s.theta_start) * t,
        cp = Math.cos(s.phi),
        sp = Math.sin(s.phi);
      return [
        s.cx + s.rx * Math.cos(th) * cp - s.ry * Math.sin(th) * sp,
        s.cy + s.rx * Math.cos(th) * sp + s.ry * Math.sin(th) * cp,
      ];
    }
    const P = [s.p1, s.p2, s.p3, s.p4].filter(Boolean).map((p) => p.slice());
    for (let n = P.length - 1; n > 0; n--)
      for (let i = 0; i < n; i++)
        P[i] = [P[i][0] + (P[i + 1][0] - P[i][0]) * t, P[i][1] + (P[i + 1][1] - P[i][1]) * t];
    return P[0];
  };
  const As = {
    line: line([-10, -3], [10, 4]),
    quad: quad([-10, 0], [0, 9], [10, 0]),
    cubic: cub([-10, 0], [-5, 8], [5, -8], [10, 0]),
    arc: mkArc(0, 0, 10, 6, 0.3, 2.6, 0.4, 0, 1),
  };
  // B through X = A(0.37) at its own t = 0.45, across A, meeting A nowhere else.
  const through = (X, kind) => {
    if (kind === 'line') return line([X[0] - 1.8, X[1] - 2.34], [X[0] + 2.2, X[1] + 2.86]);
    const move = (s) => {
      const c = at(s, 0.45);
      const P = (p) => [p[0] - c[0] + X[0], p[1] - c[1] + X[1]];
      return s.type === 1
        ? quad(P(s.p1), P(s.p2), P(s.p3))
        : cub(P(s.p1), P(s.p2), P(s.p3), P(s.p4));
    };
    if (kind === 'quad') return move(quad([0, 0], [2, 1], [4, 5.2]));
    if (kind === 'cubic') return move(cub([0, 0], [1, 2], [3, 1], [4, 5]));
    const th = 2.54,
      cx = X[0] - 3 * Math.cos(th),
      cy = X[1] - 3 * Math.sin(th);
    return mkArc(cx, cy, 3, 3, th - 0.54, th + 0.66, 0, 0, 1);
  };
  for (const ka of Object.keys(As))
    for (const kb of Object.keys(As)) {
      const A = As[ka],
        X = at(A, 0.37),
        B = through(X, kb);
      let bad = 0,
        n = 0;
      const where = [];
      for (const f of [1].concat(SCALES))
        for (const on of [false, true])
          for (const k of [1, 1e-2, 1e-4, 1e-6]) {
            n++;
            const o = offsetFor(f, on);
            const hits = isect(xform(A, f, o), xform(B, f, o, k, X));
            const Xf = [X[0] * f + o[0], X[1] * f + o[1]];
            // Position to 1e-8 of the pair or the precision of the coordinates, parameters to match.
            const tol =
              1e-8 * 20 * f + 1e3 * Number.EPSILON * (Math.abs(Xf[0]) + Math.abs(Xf[1]) + 20 * f);
            const near = hits.filter(
              (h) => Math.hypot(h.x - Xf[0], h.y - Xf[1]) <= Math.max(tol, 1e-6 * 4 * k * f),
            );
            const ok =
              hits.length === 1 &&
              near.length === 1 &&
              Math.abs(near[0].tA - 0.37) <= 1e-6 + tol / (20 * f) &&
              Math.abs(near[0].tB - 0.45) <= 1e-6 + tol / (4 * k * f);
            if (!ok) {
              bad++;
              if (where.length < 2)
                where.push(`scale ${f}${on ? ' +offset' : ''}, B x ${k}: ${hits.length} hits`);
            }
          }
      check(
        bad === 0,
        `${ka} x ${kb}: the crossing survives ${n - bad}/${n} sizes${where.length ? ' -- ' + where.join('; ') : ''}`,
      );
    }
}

console.log('(b3) exactCrossings on a segment far smaller than its partner');
{
  const at = (P, t) => {
    P = P.map((p) => p.slice());
    for (let n = P.length - 1; n > 0; n--)
      for (let i = 0; i < n; i++)
        P[i] = [P[i][0] + (P[i + 1][0] - P[i][0]) * t, P[i][1] + (P[i + 1][1] - P[i][1]) * t];
    return P[0];
  };
  const As = {
    quad: [
      [-10, 0],
      [0, 9],
      [10, 0],
    ],
    cubic: [
      [-10, 0],
      [-5, 8],
      [5, -8],
      [10, 0],
    ],
  };
  const Bs = {
    quad: [
      [0, 0],
      [2, 1],
      [4, 5.2],
    ],
    cubic: [
      [0, 0],
      [1, 2],
      [3, 1],
      [4, 5],
    ],
  };
  const tp = (P) => ({ t: P.length === 3 ? 'quad' : 'cubic', P });
  for (const ka of Object.keys(As))
    for (const kb of Object.keys(Bs)) {
      const A = As[ka],
        X = at(A, 0.37),
        c = at(Bs[kb], 0.45),
        B0 = Bs[kb].map((p) => [p[0] - c[0] + X[0], p[1] - c[1] + X[1]]);
      let bad = 0,
        n = 0;
      const where = [];
      for (const f of [1].concat(SCALES))
        for (const on of [false, true])
          for (const k of [1e-2, 1e-4, 1e-5, 1e-6, 1e-7]) {
            n++;
            const o = offsetFor(f, on),
              W = (p) => [p[0] * f + o[0], p[1] * f + o[1]];
            const hits =
              exactCrossings(
                tp(A.map(W)),
                tp(B0.map((p) => W([X[0] + k * (p[0] - X[0]), X[1] + k * (p[1] - X[1])]))),
                null,
              ) || [];
            // tB to the precision the crossing is located to: 1e-9 of the pair, over B's length
            if (!(
              hits.length === 1 &&
              Math.abs(hits[0].tA - 0.37) <= 1e-6 &&
              Math.abs(hits[0].tB - 0.45) <= 1e-6 + (1e-9 * 20) / (4 * k)
            )) {
              bad++;
              if (where.length < 2)
                where.push(`scale ${f}${on ? ' +offset' : ''}, B x ${k}: ${hits.length} hits`);
            }
          }
      check(
        bad === 0,
        `${ka} x ${kb}: the crossing is found at ${n - bad}/${n} sizes${where.length ? ' -- ' + where.join('; ') : ''}`,
      );
    }
}

console.log(
  "(b4) exactCrossings tells the clipper's hits by the crossing they are, not by distance",
);
{
  const at = (P, t) => {
    P = P.map((p) => p.slice());
    for (let n = P.length - 1; n > 0; n--)
      for (let i = 0; i < n; i++)
        P[i] = [P[i][0] + (P[i + 1][0] - P[i][0]) * t, P[i][1] + (P[i + 1][1] - P[i][1]) * t];
    return P[0];
  };
  const tp = (P) => ({ t: P.length === 3 ? 'quad' : 'cubic', P });
  // a clipper-like hit: the crossing's parameters moved by (dA, dB), its point the midpoint of the two curve points
  const hitNear = (A, B, c, dA, dB) => {
    const tA = c.tA + dA,
      tB = c.tB + dB,
      p = at(A, tA),
      q = at(B, tB);
    return { tA, tB, x: (p[0] + q[0]) / 2, y: (p[1] + q[1]) / 2 };
  };
  const rows = { far: [], pair: [], snapped: [] };
  for (const f of [1].concat(SCALES))
    for (const on of [false, true]) {
      const o = offsetFor(f, on),
        W = (p) => [p[0] * f + o[0], p[1] * f + o[1]],
        tag = `scale ${f}${on ? ' +offset' : ''}`;
      // one crossing, and a hit off it by 3e-6 of the pair
      {
        const A = [
            [-10, 0],
            [0, 9],
            [10, 0],
          ].map(W),
          B = [
            [-3, -2],
            [-1, 9],
            [2, 1],
            [4, 8],
          ].map(W);
        const [c] = exactCrossings(tp(A), tp(B), null) || [];
        const h = c && hitNear(A, B, c, 8e-6, -5e-6),
          off = h ? Math.hypot(h.x - c.x, h.y - c.y) / (20 * f) : 0;
        const got = c ? exactCrossings(tp(A), tp(B), [h]) : null;
        if (!(c && off > 2.5e-6 && got && got.length === 0))
          rows.far.push(
            `${tag}: ${got ? got.length : 'no crossing'} returned, hit ${off.toExponential(1)} off`,
          );
        // snapped parameters: a hit at (0.2, 0) is not this crossing
        const s =
          c &&
          exactCrossings(tp(A), tp(B), [{ tA: 0.2, tB: 0, x: at(A, 0.2)[0], y: at(A, 0.2)[1] }]);
        if (!(s && s.length === 1)) rows.snapped.push(`${tag}: ${s ? s.length : 'none'}`);
      }
      // a hairpin across a shallow quad: two crossings 3.9e-7 of the pair apart, the clipper reporting one
      {
        const d = (4e-7 * 20) / 0.8;
        const A = [
            [-10, 0.2],
            [0, -0.2],
            [10, 0.2],
          ].map(W),
          B = [
            [5, 3],
            [5, -3],
            [5 + d, -3],
            [5 + d, 3],
          ].map(W);
        const all = exactCrossings(tp(A), tp(B), null) || [];
        const got =
          all.length === 2 ? exactCrossings(tp(A), tp(B), [hitNear(A, B, all[0], 3e-7, 0)]) : null;
        if (!(got && got.length === 1 && got[0].tB === all[1].tB))
          rows.pair.push(`${tag}: ${all.length} crossings, ${got ? got.length : '-'} returned`);
      }
    }
  check(
    rows.far.length === 0,
    `a hit 3e-6 of the pair off its crossing is that crossing, at every size${rows.far.length ? ' -- ' + rows.far.slice(0, 2).join('; ') : ''}`,
  );
  check(
    rows.pair.length === 0,
    `two crossings 3.9e-7 of the pair apart stay two, at every size${rows.pair.length ? ' -- ' + rows.pair.slice(0, 2).join('; ') : ''}`,
  );
  check(
    rows.snapped.length === 0,
    `a hit with snapped parameters is not another crossing, at every size${rows.snapped.length ? ' -- ' + rows.snapped.slice(0, 2).join('; ') : ''}`,
  );
}

console.log('(b2) a short line crossing a long one at one degree');
{
  // The shallow, short crossing lineLine's old parallel test (|det| < 1e-9, an area) called parallel.
  const A = { type: 0, p1: [-10, -3], p2: [10, 4] },
    X = [-10 + 20 * 0.37, -3 + 7 * 0.37];
  const ang = Math.atan2(7, 20) + Math.PI / 180,
    d = [Math.cos(ang), Math.sin(ang)];
  const B = {
    type: 0,
    p1: [X[0] - 2 * d[0], X[1] - 2 * d[1]],
    p2: [X[0] + 2 * d[0], X[1] + 2 * d[1]],
  };
  let bad = 0,
    n = 0;
  for (const f of [1].concat(SCALES))
    for (const on of [false, true])
      for (const k of [1, 1e-4, 1e-6, 1e-7]) {
        n++;
        const o = offsetFor(f, on);
        const hits = intersectSegments(xform(A, f, o), xform(B, f, o, k, X));
        // The precision the coordinates carry, which at one degree moves a crossing 57 times as far along
        // the lines, divided into each line's length.
        const floor =
          1e3 *
          Number.EPSILON *
          (Math.abs(X[0] * f + o[0]) + Math.abs(X[1] * f + o[1]) + 20 * f) *
          57;
        if (!(
          hits.length === 1 &&
          Math.abs(hits[0].tA - 0.37) <= 1e-6 + floor / (21 * f) &&
          Math.abs(hits[0].tB - 0.5) <= 1e-6 + floor / (4 * k * f)
        ))
          bad++;
      }
  check(bad === 0, `the crossing survives ${n - bad}/${n} sizes, down to a segment 4e-7 long`);
}

console.log('(c) a small circle far from a large one');
{
  let phantoms = 0;
  for (const f of [1].concat(SCALES))
    for (const k of [1, 1e-2, 1e-3, 1e-4, 1e-6]) {
      const small = mkArc(0, 0, 2 * k * f, 2 * k * f, 0, 2 * Math.PI, 0, 0, 1),
        big = mkArc(12 * f, 0, 8 * f, 8 * f, 0, 2 * Math.PI, 0, 0, 1);
      phantoms += intersectSegments(small, big).length + intersectSegments(big, small).length;
    }
  check(
    phantoms === 0,
    `no crossing reported between circles that never meet: ${phantoms} phantom(s)`,
  );
}

console.log('(d) the zero polynomial, and straight quads on one line');
{
  const roots = [solveQuadratic(0, 0, 0), solveCubic(0, 0, 0, 0), solveQuartic(0, 0, 0, 0, 0)];
  check(
    roots.every((r) => r.length === 0),
    `solveQuadratic / solveCubic / solveQuartic of zero: ${roots.map((r) => JSON.stringify(r)).join(' ')}`,
  );
  const q1 = { type: 1, p1: [11.7, 0], p2: [75.05, 0], p3: [138, 0] },
    q2 = { type: 1, p1: [138, 0], p2: [196.45, 0], p3: [254.85, 0] };
  let finite = true;
  for (const f of [1].concat(SCALES))
    for (const on of [false, true]) {
      const o = offsetFor(f, on);
      for (const h of intersectSegments(xform(q1, f, o), xform(q2, f, o)))
        if (!Number.isFinite(h.tA) || !Number.isFinite(h.tB)) finite = false;
    }
  check(finite, 'two straight quads end to end on one line: every hit has finite parameters');
}

console.log('(e) pointInShape at every size');
{
  const K = 0.5522847498307936,
    r = 1e-4;
  const disc = [
    [1, 0, 0, 1],
    [0, 1, -1, 0],
    [-1, 0, 0, -1],
    [0, -1, 1, 0],
  ].map(([ax, ay, bx, by]) => ({
    type: 2,
    p1: [ax * r, ay * r],
    p2: [(ax + K * -ay) * r, (ay + K * ax) * r],
    p3: [(bx - K * -by) * r, (by - K * bx) * r],
    p4: [bx * r, by * r],
  }));
  // The last probe's ray leaves through the vertex at (r, 0), where the on-ray test decides. It is not
  // asked with the offset: 2.9e8 radii from the origin a crossing AT a vertex is known only to ~1e-7 in
  // t, past the kernels' 1e-9 endpoint window, and one side of the vertex can drop out at any scale.
  const probes = [
    [0.3, 0.2],
    [0.9, 0.1],
    [-0.5, -0.5],
    [1.2, 0],
    [0.8, 0.8],
    [0, -0.95],
    [-0.5, 0],
  ].map(([x, y]) => [x * r, y * r]);
  const VERTEX = probes.length - 1;
  const want = probes.map((p) => Math.hypot(p[0], p[1]) < r);
  let bad = 0,
    n = 0;
  for (const f of [1].concat(SCALES))
    for (const on of [false, true]) {
      const o = offsetFor(f, on);
      const segs = disc.map((s) => xform(s, f, o));
      probes.forEach((p, i) => {
        if (on && i === VERTEX) return;
        n++;
        if (pointInShape([p[0] * f + o[0], p[1] * f + o[1]], segs, 'nonzero') !== want[i]) bad++;
      });
    }
  check(
    bad === 0,
    `a disc of radius 1e-4: ${bad} of ${n} point classifications differ from its geometry`,
  );
}

// The union calls subdivideYMonotone in its canonical frame, so a small size here is a piece small
// against the union it belongs to.
console.log('(f) y-monotone splits at every size');
{
  const X = [1.3, 1.1],
    TURN = 1e-3;
  const wantTheta = Math.atan2(Math.cos(TURN), 2 * Math.sin(TURN)); // the turned ellipse's top, rx = 2, ry = 1
  let quadBad = 0,
    arcBad = 0,
    n = 0;
  for (const f of [1].concat(SCALES))
    for (const on of [false, true])
      for (const k of [1, 1e-4, 1e-6]) {
        const o = offsetFor(f, on),
          P = (p) => [(X[0] + k * p[0]) * f + o[0], (X[1] + k * p[1]) * f + o[1]];
        n++;
        // y = 2s(1 - s) + 0.4s², the top at s = 0.625
        const q = subdivideYMonotone({ type: 1, p1: P([0, 0]), p2: P([1, 1]), p3: P([2, 0.4]) });
        const mag = Math.max(Math.abs(X[0] * f + o[0]), Math.abs(X[1] * f + o[1])),
          size = k * f;
        const top =
          q.length === 2
            ? [((q[0].p3[0] - o[0]) / f - X[0]) / k, ((q[0].p3[1] - o[1]) / f - X[1]) / k]
            : null;
        if (
          !top ||
          Math.hypot(top[0] - 1.25, top[1] - 0.625) > 1e-9 + (64 * Number.EPSILON * mag) / size
        )
          quadBad++;
        const a = subdivideYMonotone(
          mkArc(X[0] * f + o[0], X[1] * f + o[1], 2 * size, size, 0.5, 2.5, TURN, 0, 1),
        );
        if (!(a.length === 2 && Math.abs(a[0].theta_end - wantTheta) <= 1e-12)) arcBad++;
      }
  check(quadBad === 0, `a curved quad splits at its top: ${n - quadBad}/${n} sizes`);
  check(
    arcBad === 0,
    `an ellipse turned by 1e-3 splits at its top, not at theta = pi/2: ${n - arcBad}/${n} sizes`,
  );
}

if (fail) {
  console.error(`PATH-BOOLEAN SCALE-INVARIANT FAIL (${fail})`);
  process.exit(1);
}
console.log('PATH-BOOLEAN SCALE-INVARIANT PASS');
