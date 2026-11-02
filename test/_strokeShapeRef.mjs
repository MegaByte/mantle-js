// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _strokeShapeRef.mjs — shared by the stroke-join checks (not a test on its own).
//
// * svgInside: the SVG 2 stroke shape (painting.html, "Computing the shape of the stroke") for an
//   open or closed polyline — rectangles, caps (butt: nothing; round: semicircle; square: halfW
//   rectangle), joins (bevel triangle; round = bevel plus the circular SECTOR; miter = bevel plus
//   the tip triangle within the limit, else bevel; miter-clip and arcs clipped at limit * halfW).
// * lineSeg / minDist / coverage: a port of _coverage.glsl strokeBandAccum's LINE branch and the
//   frag's coverage tail, as shipped ('fixed'), under alternative rules kept as controls ('prefix' for the
//   line joins, 'miterClipRound', 'squareCapDrop', 'buttPastEnd'), and four mutations.
// * makeStrokeCases / pixels: the seeded random polylines and their pixel grids.

export const sub = (p, q) => [p[0] - q[0], p[1] - q[1]];
export const dot = (p, q) => p[0] * q[0] + p[1] * q[1];
export const len = (p) => Math.hypot(p[0], p[1]);
export const norm = (p) => {
  const l = Math.max(len(p), 1e-300);
  return [p[0] / l, p[1] / l];
};
export const crs = (p, q) => p[0] * q[1] - p[1] * q[0];

// ---- the shader's line branch --------------------------------------------------------------
// rule: 'fixed' (as shipped); the alternatives the shader rejects, 'prefix' (the radial fall-through outside
// the wedge and the round shoulder past a miter's limit), 'miterClipRound' (miter-clip drawn round inside the
// wedge and arcs round past the limit), 'squareCapDrop' (a square cap DROPS past halfW) and 'buttPastEnd' (a free
// butt end's plane cuts only the pixels past the end); and the mutations of 'fixed' 'radialOutside', 'roundPastLimit', 'noGate',
// 'noClip' (a clipped miter's clip line dropped).
const RULES = {
  fixed: {},
  prefix: { prefixJoins: true },
  miterClipRound: { miterClipRound: true },
  squareCapDrop: { squareCapDrop: true },
  buttPastEnd: { buttPastEnd: true },
  base: { miterClipRound: true, squareCapDrop: true, buttPastEnd: true }, // all three alternatives at once
  radialOutside: { radialOutside: true },
  roundPastLimit: { roundPastLimit: true },
  noGate: { noGate: true },
  noClip: { noClip: true },
};
// `cap` is the START cap and `endCap` the END one; they differ only on a bundle that carries an
// asymmetric pair (meta slot 46, which SVG has no syntax for — Flash LineStyle2 does). Every
// branch below picks the one belonging to the free end it is standing on, exactly as
// _coverage.glsl's strokeLineAccum picks between its own startCap / endCap arguments.
export function lineSeg(rule, c, s, halfW, cap, joinStyle, miterLimit, endCap = cap) {
  const R = RULES[rule];
  if (!R) throw new Error(`unknown rule ${rule}`);
  const ab = sub(s.b, s.a),
    abLen2 = Math.max(dot(ab, ab), 1e-20),
    abLen = Math.sqrt(abLen2);
  const tRaw = dot(sub(c, s.a), ab) / abLen2,
    segTan = [ab[0] / abLen, ab[1] / abLen];
  const prefix = !!R.prefixJoins;
  let thisD = -1,
    drop = false;
  const bevel = (q, tA, tB) => {
    const sd = crs(tA, tB) >= 0 ? 1 : -1;
    const nA = [sd * tA[1], -sd * tA[0]],
      nB = [sd * tB[1], -sd * tB[0]];
    const nb = [nA[0] + nB[0], nA[1] + nB[1]],
      bl = len(nb);
    if (bl > 1e-4) {
      const bis = [nb[0] / bl, nb[1] / bl];
      thisD = Math.max(len(q), halfW + dot(q, bis) - halfW * dot(nA, bis));
    }
  };
  // own = this segment's outward direction at the vertex, other = the neighbor's direction pointing
  // away from it (inTan at a start vertex, -outTan at an end vertex); ourTerritory = dot(q, other) >= 0
  const vertex = (q, own, other, tA, tB) => {
    const inWedge = R.noGate || dot(q, other) >= 0;
    if (!inWedge) {
      if (prefix || R.radialOutside) return; // radial fall-through
      thisD = Math.max(len(q), halfW + dot(q, own)); // butt end
      return;
    }
    const cosBetween = dot(own, other);
    const sinHalf = 0.5 * Math.hypot(own[0] - other[0], own[1] - other[1]); // half the distance between the unit vectors (no absolute floor)
    const miterLen = halfW / sinHalf;
    const fits = miterLen <= halfW * miterLimit;
    const bevelHere =
      joinStyle === 2 || (!(prefix || R.roundPastLimit) && joinStyle === 0 && !fits);
    if (bevelHere) bevel(q, tA, tB);
    const along = dot(q, own);
    let capAlong = 0;
    const clipJoin = joinStyle === 3 || joinStyle === 4; // miter-clip, and arcs on lines
    if ((joinStyle === 0 || joinStyle === 4 || (joinStyle === 3 && !R.miterClipRound)) && fits)
      capAlong = miterLen * Math.sqrt(Math.max(0.5 * (1 + cosBetween), 0));
    const kite = () =>
      Math.max(
        len([q[0] - own[0] * along, q[1] - own[1] * along]),
        Math.abs(dot(q, [-other[1], other[0]])),
      );
    if (along <= capAlong) {
      thisD = kite();
    } else if (clipJoin && !fits && !R.miterClipRound) {
      // the miter kite cut by the clip line at miterLimit * halfW along the bisector (own + other)
      const bs = [own[0] + other[0], own[1] + other[1]],
        bl = len(bs);
      thisD = kite();
      if (bl > 1e-4 && !R.noClip)
        thisD = Math.max(thisD, halfW + dot(q, bs) / bl - halfW * Math.max(miterLimit, 1));
    }
  };
  if (tRaw < 0) {
    const q = sub(c, s.a);
    if (s.freeStart) {
      if (cap === 0) thisD = Math.max(len(q), halfW + dot(q, [-segTan[0], -segTan[1]]));
      else if (cap === 2) {
        const al = dot(q, [-segTan[0], -segTan[1]]),
          perp = len([q[0] + segTan[0] * al, q[1] + segTan[1] * al]);
        if (!R.squareCapDrop) thisD = Math.max(perp, al);
        else if (al < 0 || al > halfW) drop = true;
        else thisD = perp;
      }
    } else vertex(q, [-segTan[0], -segTan[1]], s.inTan, s.inTan, segTan);
  }
  if (tRaw > 1) {
    const q = sub(c, s.b);
    if (s.freeEnd) {
      if (endCap === 0) thisD = Math.max(len(q), halfW + dot(q, segTan));
      else if (endCap === 2) {
        const al = dot(q, segTan),
          perp = len([q[0] - segTan[0] * al, q[1] - segTan[1] * al]);
        if (!R.squareCapDrop) thisD = Math.max(perp, al);
        else if (al < 0 || al > halfW) drop = true;
        else thisD = perp;
      }
    } else vertex(q, segTan, [-s.outTan[0], -s.outTan[1]], segTan, s.outTan);
  }
  if (drop) return { d: Infinity, g: null };
  if (thisD < 0) {
    const tC = Math.min(1, Math.max(0, tRaw));
    const g = sub(c, [s.a[0] + ab[0] * tC, s.a[1] + ab[1] * tC]),
      d = len(g);
    // a free butt end's plane cuts the body from inside too
    let endD = -1;
    if (!R.buttPastEnd) {
      if (s.freeStart && cap === 0) endD = halfW + dot(sub(c, s.a), [-segTan[0], -segTan[1]]);
      if (s.freeEnd && endCap === 0) endD = Math.max(endD, halfW + dot(sub(c, s.b), segTan));
    }
    if (endD > d) return { d: endD, g: null };
    return { d, g: [g[0] / Math.max(d, 1e-12), g[1] / Math.max(d, 1e-12)] };
  }
  return { d: thisD, g: null };
}
export function exactBoxCov(nx, ny, d) {
  const a = Math.max(Math.abs(nx), Math.abs(ny)),
    b = Math.min(Math.abs(nx), Math.abs(ny));
  const ssum = 0.5 * (a + b),
    t = 0.5 * (a - b);
  if (d <= -ssum) return 0;
  if (d >= ssum) return 1;
  const ab = Math.max(2 * a * b, 1e-12);
  if (d <= -t) return ((d + ssum) * (d + ssum)) / ab;
  if (d >= t) return 1 - ((ssum - d) * (ssum - d)) / ab;
  return 0.5 + d / Math.max(a, 1e-12);
}
export function minDist(rule, c, segs, halfW, cap, joinStyle, miterLimit, endCap = cap) {
  let minD = 1e30,
    grad = [0, 0];
  for (const s of segs) {
    const r = lineSeg(rule, c, s, halfW, cap, joinStyle, miterLimit, endCap);
    if (r.d < minD) {
      minD = r.d;
      grad = r.g || [0, 0];
    }
  }
  return { minD, grad };
}
// mantle.frag.glsl's stroke coverage at one em per pixel, exact-AA on
export function coverage(rule, c, segs, halfW, cap, joinStyle, miterLimit, endCap = cap) {
  const { minD, grad } = minDist(rule, c, segs, halfW, cap, joinStyle, miterLimit, endCap);
  return coverageTail(minD, grad, halfW);
}
export function coverageTail(minD, grad, halfW) {
  const hv = Math.max(halfW, 0.5),
    fade = halfW / hv,
    dfe = minD - hv;
  if (dot(grad, grad) > 0.5 && dfe <= 0.75) return exactBoxCov(grad[0], grad[1], -dfe) * fade;
  return dfe <= 0.5 ? Math.min(1, Math.max(0, 0.5 - dfe)) * fade : 0;
}

// ---- polyline -> the encoder's per-segment records ------------------------------------------
export function polySegs(P, closed) {
  const n = P.length,
    m = closed ? n : n - 1,
    segs = [];
  for (let i = 0; i < m; i++) segs.push({ a: P[i], b: P[(i + 1) % n] });
  const tan = segs.map((s) => norm(sub(s.b, s.a)));
  segs.forEach((s, i) => {
    const prev = closed ? (i - 1 + m) % m : i - 1,
      next = closed ? (i + 1) % m : i + 1;
    s.freeStart = prev < 0;
    s.freeEnd = next >= m;
    s.inTan = prev < 0 ? [0, 0] : tan[prev];
    s.outTan = next >= m ? [0, 0] : tan[next];
  });
  return segs;
}

// ---- SVG 2 stroke shape ----------------------------------------------------------------------
export function svgInside(c, P, closed, halfW, cap, joinStyle, miterLimit, endCap = cap) {
  const n = P.length,
    m = closed ? n : n - 1,
    tans = [];
  const inTri = (q, A, B, C) => {
    const s1 = crs(sub(B, A), sub(q, A)),
      s2 = crs(sub(C, B), sub(q, B)),
      s3 = crs(sub(A, C), sub(q, C));
    return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
  };
  for (let i = 0; i < m; i++) {
    const a = P[i],
      b = P[(i + 1) % n],
      t = norm(sub(b, a)),
      L = len(sub(b, a));
    tans.push(t);
    const s = dot(sub(c, a), t);
    if (s >= 0 && s <= L && Math.abs(dot(sub(c, a), [-t[1], t[0]])) <= halfW) return true; // rectangle
  }
  if (!closed) {
    // SVG 2 caps the two free ends independently: stroke-linecap applies to both, but a bundle
    // may carry an asymmetric pair (meta slot 46), so the START end takes `cap` and the END one
    // takes `endCap`.
    for (const [V, out, k] of [
      [P[0], [-tans[0][0], -tans[0][1]], cap],
      [P[n - 1], tans[m - 1], endCap],
    ]) {
      const q = sub(c, V),
        s = dot(q, out);
      if (k === 1 && s >= 0 && len(q) <= halfW) return true; // semicircle
      if (k === 2 && s >= 0 && s <= halfW && Math.abs(dot(q, [-out[1], out[0]])) <= halfW)
        return true;
    }
  }
  const verts = closed ? [...Array(n).keys()] : [...Array(n - 2).keys()].map((k) => k + 1);
  for (const j of verts) {
    const tA = tans[(j - 1 + m) % m],
      tB = tans[j % m],
      q = sub(c, P[j]),
      k0 = crs(tA, tB);
    if (Math.abs(k0) < 1e-12 && dot(tA, tB) > 0) continue;
    const sd = k0 >= 0 ? 1 : -1;
    const nA = [sd * tA[1], -sd * tA[0]],
      nB = [sd * tB[1], -sd * tB[0]];
    const P1 = [halfW * nA[0], halfW * nA[1]],
      P2 = [halfW * nB[0], halfW * nB[1]];
    if (inTri(q, [0, 0], P1, P2)) return true; // bevel
    if (joinStyle === 2) continue;
    if (joinStyle === 1) {
      const k = crs(nA, nB);
      if (len(q) <= halfW && crs(nA, q) * k >= 0 && crs(q, nB) * k >= 0) return true;
      continue;
    }
    const ratio = 1 / Math.sqrt(Math.max(0, 0.5 * (1 - dot([-tA[0], -tA[1]], tB))));
    const bis = norm([nA[0] + nB[0], nA[1] + nB[1]]),
      P3 = [halfW * ratio * bis[0], halfW * ratio * bis[1]];
    if (joinStyle === 0) {
      if (ratio <= miterLimit && inTri(q, P1, P2, P3)) return true;
      continue;
    }
    if (inTri(q, P1, P2, P3) && dot(q, bis) <= miterLimit * halfW) return true; // miter-clip, arcs
  }
  return false;
}

// ---- the case set -----------------------------------------------------------------------------
export function makeStrokeCases(seed0 = 0x51de, count = 360) {
  let seed = seed0;
  const rnd = () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const cases = [];
  for (let i = 0; i < count; i++) {
    const halfW = pick([1, 2.5, 6]),
      closed = rnd() < 0.3,
      nPts = closed ? 3 + Math.floor(rnd() * 3) : 3 + Math.floor(rnd() * 2);
    const P = [[0, 0]];
    let ang = rnd() * Math.PI * 2;
    for (let k = 1; k < nPts; k++) {
      const L = halfW * pick([0.25, 0.6, 1.2, 3, 8]);
      ang += (rnd() - 0.5) * 2 * ((Math.PI * 170) / 180);
      P.push([P[k - 1][0] + L * Math.cos(ang), P[k - 1][1] + L * Math.sin(ang)]);
    }
    const segs = polySegs(P, closed);
    const joinStyle = Math.floor(rnd() * 5),
      cap = closed ? 0 : Math.floor(rnd() * 3),
      miterLimit = pick([1, 1.5, 2, 4, 10]);
    const minLen = Math.min(...segs.map((s) => len(sub(s.b, s.a))));
    const pastLimit = segs.some(
      (s) =>
        !s.freeEnd &&
        1 / Math.sqrt(Math.max(1e-12, 0.5 * (1 - dot(norm(sub(s.a, s.b)), s.outTan)))) > miterLimit,
    );
    cases.push({
      P,
      closed,
      segs,
      halfW,
      cap,
      joinStyle,
      miterLimit,
      minLen,
      pastLimit,
      off: [rnd() * 0.9, rnd() * 0.9],
    });
  }
  return cases;
}
export const pixels = (cs) => {
  // the farthest SVG 2 reaches: a clipped miter's corners, sqrt(limit^2 + 1) half-widths from the
  // vertex, which also covers a miter's tip (limit) and a square cap's corners (sqrt 2)
  const ml = Math.max(cs.miterLimit, 1),
    reach = cs.halfW * Math.sqrt(ml * ml + 1) + 2,
    out = [];
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const p of cs.P) {
    x0 = Math.min(x0, p[0]);
    y0 = Math.min(y0, p[1]);
    x1 = Math.max(x1, p[0]);
    y1 = Math.max(y1, p[1]);
  }
  for (let py = Math.floor(y0 - reach); py <= Math.ceil(y1 + reach); py++)
    for (let px = Math.floor(x0 - reach); px <= Math.ceil(x1 + reach); px++)
      out.push([px + cs.off[0], py + cs.off[1]]);
  return out;
};
export const JOINS = ['miter', 'round', 'bevel', 'miter-clip', 'arcs'];
