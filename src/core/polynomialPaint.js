// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Certify a complete polynomial paint before integrating its boundary as one
// area. Curve injectivity and pairwise control-hull separation exclude crossings;
// nesting retains and orients only boundaries where the fill state changes.
// Unresolved contact, topology or work-budget exhaustion retains the fallback.
//
// Optional native arcs use exact elliptic segment areas and quarter-turn hulls.
// Contacts between nested ellipses are allowed; other contacts decline.
import {
  arcPoint,
  arcBulge,
  arcHull,
  splitArc,
  splitArcHull,
  arcRayWinding,
  ellipseNesting,
} from './arcPaint.js';
const eq = (a, b) => a[0] === b[0] && a[1] === b[1];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const midpoint = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const margin = (a, b) => 128 * Number.EPSILON * (Math.abs(a[0] * b[0]) + Math.abs(a[1] * b[1]));
function split(P) {
  if (P.arc) return splitArcHull(P);
  const levels = [P];
  while (levels.at(-1).length > 1) {
    const q = levels.at(-1);
    levels.push(q.slice(1).map((p, i) => midpoint(q[i], p)));
  }
  return [levels.map((q) => q[0]), levels.map((q) => q.at(-1)).reverse()];
}
// Subdivision preserves the polynomial exactly. Each accepted span has a
// strictly monotone chord projection, certifying that it cannot cross itself.
// Repeated controls give a zero derivative coefficient. The nonzero chord
// and the remaining positive Bernstein coefficients still prove injectivity.
function injectiveSpans(c, depth = 0) {
  const chord = sub(c.P.at(-1), c.P[0]);
  if (
    dot(chord, chord) > 0 &&
    c.P.slice(1).every((p, i) => {
      const d = sub(p, c.P[i]);
      return (d[0] === 0 && d[1] === 0) || dot(chord, d) > margin(chord, d);
    })
  )
    return [c];
  if (depth >= 8) return null;
  const out = [];
  for (const P of split(c.P)) {
    const spans = injectiveSpans({ ...c, P }, depth + 1);
    if (!spans) return null;
    out.push(...spans);
  }
  return out;
}
function bezier(P, t) {
  let q = P;
  while (q.length > 1) q = q.slice(1).map((p, i) => q[i].map((v, j) => v + (p[j] - v) * t));
  return q[0];
}

function testAxis(nx, ny, A, B, joint, coordinateScale, extraPad) {
  if (nx === 0 && ny === 0) return false;
  for (let s = -1; s <= 1; s += 2) {
    const nn0 = nx * s,
      nn1 = ny * s;
    const absN = Math.abs(nn0) + Math.abs(nn1);
    const pad = 128 * Number.EPSILON * coordinateScale * absN;
    const xpad = pad + extraPad * absN;
    let allSep = true;
    outer: for (let ia = 0; ia < A.length; ia++) {
      const a0 = A[ia][0],
        a1 = A[ia][1];
      for (let ib = 0; ib < B.length; ib++) {
        const d0 = B[ib][0] - a0,
          d1 = B[ib][1] - a1;
        if (
          !(
            nn0 * d0 + nn1 * d1 >
            128 * Number.EPSILON * (Math.abs(nn0 * d0) + Math.abs(nn1 * d1)) + xpad
          )
        ) {
          allSep = false;
          break outer;
        }
      }
    }
    if (allSep) return true;
    if (joint) {
      const j0 = joint[0],
        j1 = joint[1];
      let ok = true;
      for (let ia = 0; ia < A.length; ia++) {
        const p = A[ia];
        if (p[0] === j0 && p[1] === j1) continue;
        const d0 = p[0] - j0,
          d1 = p[1] - j1;
        if (
          !(
            nn0 * d0 + nn1 * d1 <
            -(128 * Number.EPSILON * (Math.abs(nn0 * d0) + Math.abs(nn1 * d1))) - pad
          )
        ) {
          ok = false;
          break;
        }
      }
      if (ok) {
        for (let ib = 0; ib < B.length; ib++) {
          const p = B[ib];
          if (p[0] === j0 && p[1] === j1) continue;
          const d0 = p[0] - j0,
            d1 = p[1] - j1;
          if (
            !(
              nn0 * d0 + nn1 * d1 >
              128 * Number.EPSILON * (Math.abs(nn0 * d0) + Math.abs(nn1 * d1)) + pad
            )
          ) {
            ok = false;
            break;
          }
        }
        if (ok) return true;
      }
    }
  }
  return false;
}
function separated(A, B, joint, coordinateScale) {
  const extraPad = (A.pad || 0) + (B.pad || 0);
  for (let pass = 0; pass < 2; pass++) {
    const P = pass === 0 ? A : B;
    for (let i = 0; i < P.length; i++)
      for (let k = i + 1; k < P.length; k++) {
        const dx = P[k][0] - P[i][0],
          dy = P[k][1] - P[i][1];
        if (
          testAxis(-dy, dx, A, B, joint, coordinateScale, extraPad) ||
          testAxis(dx, dy, A, B, joint, coordinateScale, extraPad)
        )
          return true;
      }
  }
  if (joint) {
    const a = A.find((p) => !eq(p, joint)),
      b = B.find((p) => !eq(p, joint));
    const vax = a[0] - joint[0],
      vay = a[1] - joint[1],
      vbx = b[0] - joint[0],
      vby = b[1] - joint[1];
    const la = Math.hypot(vax, vay),
      lb = Math.hypot(vbx, vby);
    if (
      la &&
      lb &&
      testAxis(vbx / lb - vax / la, vby / lb - vay / la, A, B, joint, coordinateScale, extraPad)
    )
      return true;
  }
  return false;
}
function hullExtent(P) {
  let x0 = Infinity,
    x1 = -Infinity,
    y0 = Infinity,
    y1 = -Infinity;
  for (let i = 0; i < P.length; i++) {
    const x = P[i][0],
      y = P[i][1];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return Math.max(x1 - x0, y1 - y0);
}
function disjoint(A, B, joint, budget, depth = 0) {
  if (--budget.left < 0) return false;
  if (separated(A, B, joint, budget.coordinateScale)) return true;
  if (depth >= (budget.maxDepth || 16)) return false;
  if (hullExtent(A) >= hullExtent(B))
    return split(A).every((P) =>
      disjoint(P, B, joint && P.some((p) => eq(p, joint)) ? joint : null, budget, depth + 1),
    );
  return split(B).every((P) =>
    disjoint(A, P, joint && P.some((p) => eq(p, joint)) ? joint : null, budget, depth + 1),
  );
}
function roots(a, b, c) {
  if (a === 0) return b === 0 ? [] : [-c / b];
  const d = b * b - 4 * a * c;
  if (d < 0) return [];
  const q = -0.5 * (b + (b < 0 ? -1 : 1) * Math.sqrt(d));
  return q === 0 ? [-b / (2 * a)] : [q / a, c / q];
}
function winding(loop, p, fast = false) {
  let w = 0;
  for (const c of loop) {
    // Only a declining/no-op preflight uses these inexpensive ray exclusions.
    // They cannot hide a ray crossing: a Bezier stays in its control hull.
    if (
      fast &&
      !c.arc &&
      (c.P.every((q) => q[0] < p[0]) ||
        c.P.every((q) => q[1] < p[1]) ||
        c.P.every((q) => q[1] > p[1]))
    )
      continue;
    if (c.arc) {
      const r = arcRayWinding(c.arc, c.P[0], c.P[1], p, fast);
      if (r === null) return null;
      w += r;
      continue;
    }
    if (c.P.length === 4) {
      const P = c.P,
        a = -P[0][1] + 3 * P[1][1] - 3 * P[2][1] + P[3][1],
        b = 3 * (P[0][1] - 2 * P[1][1] + P[2][1]),
        z = 3 * (P[1][1] - P[0][1]);
      // Stable translated Bernstein evaluation avoids allocating de Casteljau
      // arrays at every bisection step. CPatch's original proof path is unchanged.
      const at = (t, j) => {
        if (!fast) return bezier(P, t)[j];
        const u = 1 - t,
          o = P[0][j];
        return (
          o +
          3 * u * u * t * (P[1][j] - o) +
          3 * u * t * t * (P[2][j] - o) +
          t * t * t * (P[3][j] - o)
        );
      };
      const cuts = [
        0,
        ...roots(3 * a, 2 * b, z)
          .filter((t) => t > 0 && t < 1)
          .sort((a, b) => a - b),
        1,
      ];
      for (let i = 1; i < cuts.length; i++) {
        let lo = cuts[i - 1],
          hi = cuts[i];
        const yl = at(lo, 1),
          yh = at(hi, 1);
        if (!(Math.min(yl, yh) <= p[1] && p[1] < Math.max(yl, yh))) continue;
        const up = yh > yl;
        for (let k = 0; k < 64; k++) {
          const t = (lo + hi) / 2;
          if (at(t, 1) < p[1] === up) lo = t;
          else hi = t;
        }
        const x = at((lo + hi) / 2, 0);
        if (Math.abs(x - p[0]) <= 128 * Number.EPSILON * Math.max(1, Math.abs(x), Math.abs(p[0])))
          return null;
        if (x > p[0]) w += up ? 1 : -1;
      }
      continue;
    }
    const P = c.P.length === 2 ? [c.P[0], midpoint(...c.P), c.P[1]] : c.P;
    const a = P[0][1] - 2 * P[1][1] + P[2][1],
      b = 2 * (P[1][1] - P[0][1]),
      z = P[0][1];
    const evalY = (t) => (a * t + b) * t + z,
      ext = a === 0 ? -1 : -b / (2 * a),
      cuts = ext > 0 && ext < 1 ? [0, ext, 1] : [0, 1];
    for (let i = 1; i < cuts.length; i++) {
      const lo = cuts[i - 1],
        hi = cuts[i],
        yl = evalY(lo),
        yh = evalY(hi);
      if (!(Math.min(yl, yh) <= p[1] && p[1] < Math.max(yl, yh))) continue;
      const ts = roots(a, b, z - p[1]);
      if (!ts.length) return null;
      const m = (lo + hi) / 2,
        t = ts.reduce((u, v) => (Math.abs(u - m) < Math.abs(v - m) ? u : v));
      if (t < lo - 1e-12 || t > hi + 1e-12) return null;
      const s = 1 - t,
        x = s * s * P[0][0] + 2 * s * t * P[1][0] + t * t * P[2][0];
      if (Math.abs(x - p[0]) <= 128 * Number.EPSILON * Math.max(1, Math.abs(x), Math.abs(p[0])))
        return null;
      if (x > p[0]) w += yh > yl ? 1 : -1;
    }
  }
  return w;
}
// Integrate (x dy - y dx)/2 consistently for every polynomial degree.
// Exact Bernstein moments and translation reduce cancellation; mixing Green
// forms across degrees would leave uncancelled endpoint terms.
function signedArea(loop) {
  if (!loop.length) return 0;
  const o = loop[0].P[0];
  let area = 0;
  for (const { P, arc } of loop) {
    const x0 = P[0][0] - o[0],
      y0 = P[0][1] - o[1],
      x1 = P[1][0] - o[0],
      y1 = P[1][1] - o[1];
    if (P.length === 2) {
      area += (x0 * y1 - y0 * x1) / 2 + (arc ? arcBulge(arc) : 0);
      continue;
    }
    const x2 = P[2][0] - o[0],
      y2 = P[2][1] - o[1];
    if (P.length === 3) {
      area += (2 * (x0 * y1 - y0 * x1) + (x0 * y2 - y0 * x2) + 2 * (x1 * y2 - y1 * x2)) / 6;
      continue;
    }
    const x3 = P[3][0] - o[0],
      y3 = P[3][1] - o[1];
    area +=
      (6 * (x0 * y1 - y0 * x1) +
        3 * (x0 * y2 - y0 * x2) +
        (x0 * y3 - y0 * x3) +
        3 * (x1 * y2 - y1 * x2) +
        3 * (x1 * y3 - y1 * x3) +
        6 * (x2 * y3 - y2 * x3)) /
      20;
  }
  return area;
}

function probePoints(loop, many, mids = false) {
  // Cycles extracted from an arrangement touch their neighbors at nodes, where a vertex lies on another boundary and its winding
  // is ambiguous; a curve's midpoint cannot lie on another (separated) boundary.
  if (mids) {
    const pts = [];
    for (const c of loop) {
      if (pts.length >= 12) break;
      if (!c.arc) pts.push(bezier(c.P, 0.5));
    }
    if (pts.length) return pts;
  }
  const pts = [loop[0].P[0]];
  if (!many) return pts;
  for (const c of loop) {
    if (pts.length >= 12) break;
    pts.push(c.P[0]);
    if (c.arc) pts.push(arcPoint(c.arc, (c.arc.t0 + c.arc.t1) / 2));
  }
  return pts;
}
// Return {outside, depth}, or null for uncertain or inconsistent winding.
function nesting(i, contours, sides, fast, many, mids = false) {
  for (const q of probePoints(contours[i], many, mids)) {
    let outside = 0,
      depth = 0,
      ok = true;
    for (let j = 0; j < contours.length; j++)
      if (i !== j) {
        const w = winding(contours[j], q, fast);
        if (w === null) {
          ok = false;
          break;
        }
        if (!(w === 0 || w === sides[j])) return null;
        outside += w;
        if (w) depth++;
      }
    if (ok) return { outside, depth };
  }
  return null;
}
// This is only a declining preflight: no geometry is accepted on its strength.
// Unchanged glyph boundaries avoid subdivision and pairwise proof work. Every
// proposed change below still goes through the complete certificate.
function needsBoundaryNormalization(contours, evenOdd, many, statusOut) {
  const sides = contours.map((loop) => Math.sign(signedArea(loop)));
  if (sides.some((s) => !Number.isFinite(s) || s === 0)) {
    if (statusOut) statusOut.declined = true;
    return false;
  }
  let firstDirection = null;
  for (let i = 0; i < contours.length; i++) {
    const n = nesting(i, contours, sides, true, many);
    if (!n) {
      if (statusOut) statusOut.declined = true;
      return false;
    }
    const { outside, depth } = n;
    const before = evenOdd ? depth % 2 !== 0 : outside !== 0,
      after = evenOdd ? !before : outside + sides[i] !== 0;
    if (before === after) return true;
    const reverse = (after ? 1 : -1) !== sides[i];
    if (firstDirection === null) firstDirection = reverse;
    else if (reverse !== firstDirection) return true;
  }
  return false;
}
const isArc = (c) => c.t === 'arc' && c.arc && c.P.length === 2;
// Curves that share both end nodes with another curve (a lens), each split once at its midpoint.
function splitLenses(contours) {
  const all = [];
  for (const loop of contours) for (const c of loop) all.push(c);
  const lens = new Set();
  for (let i = 0; i < all.length; i++) {
    const a = all[i];
    if (a.arc) continue;
    const a0 = a.P[0],
      a1 = a.P.at(-1);
    for (let j = i + 1; j < all.length; j++) {
      const b = all[j];
      if (b.arc) continue;
      const b0 = b.P[0],
        b1 = b.P.at(-1);
      if (((eq(a0, b0) && eq(a1, b1)) || (eq(a0, b1) && eq(a1, b0))) && !eq(a0, a1)) {
        lens.add(a);
        lens.add(b);
      }
    }
  }
  if (!lens.size) return contours;
  return contours.map((loop) =>
    loop.flatMap((c) => (lens.has(c) ? split(c.P).map((P) => ({ ...c, P })) : [c])),
  );
}
const okSeg = (c, arcs) =>
  !c.cut &&
  ((c.t === 'line' && c.P.length === 2) ||
    (c.t === 'quad' && c.P.length === 3) ||
    (c.t === 'cubic' && c.P.length === 4) ||
    (arcs && isArc(c) && c.arc.rx > 0 && c.arc.ry > 0)) &&
  !c.P.some((p) => p.some((x) => !Number.isFinite(x)));
// An arc's pieces: at most a quarter turn each, exact, sharing the arc's own end vertices; a loop of fewer than three spans is halved
function arcPieces(c, halves) {
  const d = Math.abs(c.arc.t1 - c.arc.t0);
  if (!(d > 0) || d > 2 * Math.PI + 1e-6) return null;
  const n = Math.max(1, Math.ceil(d / (Math.PI / 2) - 1e-9)) * (halves ? 2 : 1);
  return splitArc(c.arc, c.P[0], c.P[1], n).map((q) => ({
    ...c,
    P: q.P,
    arc: q.arc,
    H: arcHull(q.arc, q.P[0], q.P[1]),
  }));
}
export function certifySimplePolynomialPaint(contours, evenOdd = false, opts = {}) {
  if (opts.localProgramCertificate) {
    let curves = 0,
      controls = 0;
    for (const loop of contours || []) {
      curves += loop.length;
      if (curves > 316) return null;
      for (const curve of loop) {
        if (!Array.isArray(curve.P)) return null;
        controls += curve.P.length;
        if (controls > 1024) return null;
        for (const p of curve.P)
          if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null;
      }
    }
  }

  const st = opts.statusOut || null;
  const fail = () => {
    if (st) st.declined = true;
    return null;
  };
  if (!contours?.length) return null;
  const arcs = !!opts.arcs,
    hasArc = arcs && contours.some((loop) => loop.some(isArc));
  const limit = opts.localProgramCertificate
    ? Infinity
    : contours.some((loop) => loop.some((c) => c.t === 'cubic'))
      ? 256
      : 64;
  if (contours.reduce((n, c) => n + c.length, 0) > limit) return null;
  if (opts.changesOnly) {
    for (const loop of contours)
      for (const c of loop) {
        if (!okSeg(c, arcs)) return fail();
      }
    if (!needsBoundaryNormalization(contours, evenOdd, hasArc, st)) return null;
  }
  // An extracted cycle that passes twice through a node holds a LENS: two curves between the same two nodes. Their control hulls
  // touch at both nodes, a joint admits one, and no axis separates hulls that share a vertex, so the pair cannot be proved at any
  // subdivision depth. Each curve of such a pair is split at its midpoint (exact, and the two halves share that point bit for bit),
  // and every pair of the pieces then shares at most one node.
  if (opts.nodeJoints) contours = splitLenses(contours);
  // Subdivided spans prove injectivity and separation; the GPU integrates the authored cubics.
  const authored = contours,
    prepared = [];
  for (const loop of contours) {
    let spans = [];
    for (const c of loop) {
      if (!okSeg(c, arcs)) return fail();
      const parts = c.t === 'cubic' ? injectiveSpans(c) : isArc(c) ? arcPieces(c, false) : [c];
      if (!parts) return fail();
      spans.push(...parts);
    }
    // a loop of fewer than three spans (a half disc is an arc and a line) is split further so each span stays simple
    for (let k = 0; k < 3 && hasArc && spans.length < 3 && spans.some((c) => c.arc); k++)
      spans = spans.flatMap((c) => (c.arc ? arcPieces(c, true) : [c]));
    // an extracted lens (two curves between two nodes) is split at its midpoints so the separation proof sees three or more spans
    for (let k = 0; k < 3 && opts.nodeJoints && spans.length < 3 && !spans.some((c) => c.arc); k++)
      spans = spans.flatMap((c) => split(c.P).map((P) => ({ ...c, P })));
    prepared.push(spans);
  }
  contours = prepared;
  if (contours.reduce((n, c) => n + c.length, 0) > limit) return null;
  let coordMax = 1;
  for (let ci = 0; ci < contours.length; ci++) {
    const loop = contours[ci];
    for (let si = 0; si < loop.length; si++) {
      const P = loop[si].P;
      for (let pi = 0; pi < P.length; pi++) {
        const ax = Math.abs(P[pi][0]),
          ay = Math.abs(P[pi][1]);
        if (ax > coordMax) coordMax = ax;
        if (ay > coordMax) coordMax = ay;
      }
    }
  }
  // Extracted cycles meet at graph nodes at crossing angles as small as the arrangement can resolve, and two spans that leave a node
  // 2e-4 radians apart need the control hulls cut to a thousandth of that before an axis separates them: twice the depth of the
  // whole-paint proof. The cost is linear (only the half that holds the joint is explored to the bottom), the budget still bounds
  // it, and a separation is still an axis padded by the arithmetic's own rounding, which the deeper pieces' de Casteljau error stays inside.
  const segments = [],
    sides = [],
    budget = { left: 50000, coordinateScale: coordMax, maxDepth: opts.nodeJoints ? 32 : 16 };
  for (let ci = 0; ci < contours.length; ci++) {
    const loop = contours[ci];
    if (loop.length < (hasArc ? 2 : 3)) return fail();
    // Translate area arithmetic to avoid cancellation at large document origins.
    const area = signedArea(loop);
    if (!Number.isFinite(area) || area === 0) return fail();
    sides.push(Math.sign(area));
    for (let i = 0; i < loop.length; i++) {
      const c = loop[i],
        P = c.P;
      if (!okSeg(c, arcs)) return fail();
      if (!eq(P.at(-1), loop[(i + 1) % loop.length].P[0])) return fail();
      const chord = sub(P.at(-1), P[0]);
      if (dot(chord, chord) === 0) return fail();
      if (!c.arc)
        for (let k = 1; k < P.length; k++) {
          const d = sub(P[k], P[k - 1]);
          if ((d[0] !== 0 || d[1] !== 0) && !(dot(chord, d) > margin(chord, d))) return fail();
        }
      segments.push({ ci, i, P: c.H || P, arc: c.arc });
    }
  }
  const separatedBoundaries = () => {
    for (let i = 0; i < segments.length; i++)
      for (let j = i + 1; j < segments.length; j++) {
        const a = segments[i],
          b = segments[j],
          len = contours[a.ci].length;
        // arcs of two contours whose whole ellipses nest cannot properly cross, though they may touch
        if (a.arc && b.arc && a.ci !== b.ci && ellipseNesting(a.arc, b.arc)) continue;
        let joint =
          a.ci === b.ci
            ? b.i === a.i + 1
              ? a.P.at(-1)
              : a.i === 0 && b.i === len - 1
                ? a.P[0]
                : null
            : null;
        // Extracted cycles meet at graph nodes. Two spans that share exactly one endpoint bit for bit touch only if their hulls
        // fail to separate away from it, which the joint test proves, whichever cycle each belongs to.
        if (!joint && opts.nodeJoints) {
          const ae = [a.P[0], a.P.at(-1)],
            be = [b.P[0], b.P.at(-1)],
            shared = [];
          for (const p of ae)
            for (const q of be) if (eq(p, q) && !shared.some((x) => eq(x, p))) shared.push(p);
          if (shared.length === 1) joint = shared[0];
        }
        if (!disjoint(a.P, b.P, joint, budget)) return false;
      }
    return true;
  };
  // Coverage callers can cheaply decline a no-op before the quadratic pair
  // proof. An uncertain topology may only keep the authored fallback here;
  // every accepted change still requires the complete separation certificate.
  if (!opts.changesOnly && !separatedBoundaries()) return fail();
  const curves = [],
    directions = [];
  let dropped = false;
  for (let i = 0; i < contours.length; i++) {
    const n = nesting(i, contours, sides, !!opts.changesOnly, hasArc, !!opts.nodeJoints);
    if (!n) return fail();
    const { outside, depth } = n;
    const before = evenOdd ? depth % 2 !== 0 : outside !== 0,
      after = evenOdd ? !before : outside + sides[i] !== 0;
    if (before === after) {
      dropped = true;
      continue;
    } // nested same-winding loop is not a fill boundary
    const side = after ? 1 : -1,
      reverse = side !== sides[i],
      loop = reverse ? authored[i].slice().reverse() : authored[i];
    directions.push(reverse);
    for (const c of loop)
      curves.push({ ...c, P: reverse ? c.P.slice().reverse() : c.P, _convexEnd: side });
  }
  if (opts.changesOnly) {
    if (!dropped && (directions.every(Boolean) || directions.every((v) => !v))) return null;
    if (!separatedBoundaries()) return fail();
  }
  return curves.length >= (hasArc ? 2 : 3) ? { curves, budgetUsed: 50000 - budget.left } : fail();
}
