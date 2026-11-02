// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Independent exact-ish stroke oracle (written from SVG 2 section 13): path = subpaths of Bezier segments in USER space.
// seg = {t:'L'|'Q'|'C', p:[[x,y],...]}; subpath = {segs, closed}. Membership by foot-point roots + join/cap polygons.
export const add = (a, b) => [a[0] + b[0], a[1] + b[1]],
  sub = (a, b) => [a[0] - b[0], a[1] - b[1]],
  mul = (a, s) => [a[0] * s, a[1] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1],
  crs = (a, b) => a[0] * b[1] - a[1] * b[0],
  len = (a) => Math.hypot(a[0], a[1]);
export function ev(s, t) {
  const p = s.p,
    u = 1 - t;
  if (s.t === 'L') return [u * p[0][0] + t * p[1][0], u * p[0][1] + t * p[1][1]];
  if (s.t === 'Q')
    return [
      u * u * p[0][0] + 2 * u * t * p[1][0] + t * t * p[2][0],
      u * u * p[0][1] + 2 * u * t * p[1][1] + t * t * p[2][1],
    ];
  return [0, 1].map(
    (k) =>
      u * u * u * p[0][k] + 3 * u * u * t * p[1][k] + 3 * u * t * t * p[2][k] + t * t * t * p[3][k],
  );
}
export function dv(s, t) {
  const p = s.p,
    u = 1 - t;
  if (s.t === 'L') return sub(p[1], p[0]);
  if (s.t === 'Q')
    return [0, 1].map((k) => 2 * u * (p[1][k] - p[0][k]) + 2 * t * (p[2][k] - p[1][k]));
  return [0, 1].map(
    (k) =>
      3 * u * u * (p[1][k] - p[0][k]) +
      6 * u * t * (p[2][k] - p[1][k]) +
      3 * t * t * (p[3][k] - p[2][k]),
  );
}
// unit tangent at an end of a segment, skipping coincident control points
export function endTan(s, atEnd) {
  const p = s.p,
    n = p.length;
  const idx = atEnd ? [...p.keys()].reverse() : [...p.keys()];
  const base = p[idx[0]];
  for (let i = 1; i < n; i++) {
    const d = sub(p[idx[i]], base);
    const l = len(d);
    if (l > 0) {
      const v = atEnd ? mul(d, -1) : d;
      return mul(v, atEnd ? 1 / l : 1 / l);
    }
  }
  return null;
}
// for end: tangent direction of travel = base - previous point
export function tanOut(s) {
  const p = s.p;
  for (let i = 1; i < p.length; i++) {
    const d = sub(p[i], p[0]);
    const l = len(d);
    if (l > 0) return mul(d, 1 / l);
  }
  return null;
}
export function tanIn(s) {
  const p = s.p,
    n = p.length;
  for (let i = n - 2; i >= 0; i--) {
    const d = sub(p[n - 1], p[i]);
    const l = len(d);
    if (l > 0) return mul(d, 1 / l);
  }
  return null;
}
const segLen0 = (s) => {
  let L = 0,
    q = s.p[0];
  for (let i = 1; i < s.p.length; i++) {
    L += len(sub(s.p[i], q));
    q = s.p[i];
  }
  return L;
};
export const degenerate = (s) => segLen0(s) === 0;
const NS = 48;
function bodyHit(s, t0, t1, p, hw) {
  // exists t in [t0,t1] with (p-c)·c' = 0, |p-c|<=hw
  if (s.t === 'L') {
    const a = s.p[0],
      b = s.p[1],
      d = sub(b, a),
      l2 = dot(d, d);
    if (l2 === 0) return false;
    const t = dot(sub(p, a), d) / l2;
    if (t < t0 || t > t1) return false;
    const q = ev(s, t);
    return len(sub(p, q)) <= hw;
  }
  const g = (t) => dot(sub(p, ev(s, t)), dv(s, t));
  let ta = t0,
    ga = g(ta);
  for (let i = 1; i <= NS; i++) {
    const tb = t0 + ((t1 - t0) * i) / NS,
      gb = g(tb);
    if (ga === 0 || ga * gb < 0) {
      let lo = ta,
        hi = tb,
        glo = ga;
      for (let k = 0; k < 60; k++) {
        const m = (lo + hi) / 2,
          gm = g(m);
        if (glo * gm <= 0) hi = m;
        else {
          lo = m;
          glo = gm;
        }
      }
      const t = (lo + hi) / 2;
      if (len(sub(p, ev(s, t))) <= hw) return true;
    }
    ta = tb;
    ga = gb;
  }
  return false;
}
const inTri = (p, a, b, c) => {
  const d1 = crs(sub(b, a), sub(p, a)),
    d2 = crs(sub(c, b), sub(p, b)),
    d3 = crs(sub(a, c), sub(p, c));
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
};
const inPoly = (p, P) => {
  let neg = false,
    pos = false;
  for (let i = 0; i < P.length; i++) {
    const d = crs(sub(P[(i + 1) % P.length], P[i]), sub(p, P[i]));
    if (d < 0) neg = true;
    if (d > 0) pos = true;
  }
  return !(neg && pos);
};
export function joinHit(p, V, tA, tB, hw, join, ml) {
  const cr = crs(tA, tB),
    dt = dot(tA, tB);
  if (Math.abs(cr) < 1e-15 && dt > 0) return false; // smooth
  const sd = cr > 0 ? -1 : 1; // outer = right side when turning left
  if (join === 'round') {
    const d = sub(p, V);
    if (len(d) > hw) return false;
    const n1 = [sd * -tA[1], sd * tA[0]],
      n2 = [sd * -tB[1], sd * tB[0]];
    if (Math.abs(cr) < 1e-15) return dot(d, tA) >= 0;
    const sg = Math.sign(crs(n1, n2));
    return crs(n1, d) * sg >= 0 && crs(d, n2) * sg >= 0;
  }
  const nrm = (t) => [sd * -t[1], sd * t[0]];
  const nA = nrm(tA),
    nB = nrm(tB),
    P1 = add(V, mul(nA, hw)),
    P2 = add(V, mul(nB, hw));
  if (inTri(p, V, P1, P2)) return true;
  if (join === 'bevel') return false;
  // miter geometry
  const bis = [nA[0] + nB[0], nA[1] + nB[1]],
    bl = len(bis);
  if (bl < 1e-12) {
    // an exact 180 degree reversal: the miter is unbounded; miter-clip cuts it at ml*hw along the incoming tangent
    if (join === 'miter-clip' && dt < 0) {
      const d = sub(p, V),
        a = dot(d, tA);
      return a >= 0 && a <= ml * hw && Math.abs(crs(tA, d)) <= hw;
    }
    return false;
  }
  const b = mul(bis, 1 / bl),
    cosH = dot(nA, b); // cos of half the turn angle
  const ratio = 1 / cosH; // miter length / stroke width = 1/sin(theta/2) = 1/cos(phi/2)
  const tip = add(V, mul(b, hw / cosH));
  if (join === 'miter') {
    if (ratio > ml) return false;
    return inTri(p, V, P1, tip) || inTri(p, V, tip, P2);
  }
  if (join === 'miter-clip') {
    const L = ml * hw;
    if (ratio <= ml) return inTri(p, V, P1, tip) || inTri(p, V, tip, P2);
    const d0 = hw * cosH;
    if (L <= d0) return false;
    // clip the quad V,P1,tip,P2 by bis·(x-V)<=L
    const q = [P1, tip, P2];
    const inside = (x) => dot(sub(x, V), b) <= L;
    const out = [V];
    const cut = (a, c) => {
      const da = dot(sub(a, V), b) - L,
        dc = dot(sub(c, V), b) - L,
        t = da / (da - dc);
      return add(a, mul(sub(c, a), t));
    };
    const poly = [P1, tip, P2];
    const res = [];
    for (let i = 0; i < 3; i++) {
      const a = poly[i],
        c = poly[(i + 1) % 3]; /* edge P2->P1 is the bevel */
    }
    // walk P1 -> tip -> P2
    const pts = [];
    if (inside(P1)) pts.push(P1);
    if (inside(P1) !== inside(tip)) pts.push(cut(P1, tip));
    if (inside(tip)) pts.push(tip);
    if (inside(tip) !== inside(P2)) pts.push(cut(tip, P2));
    if (inside(P2)) pts.push(P2);
    return (
      pts.length >= 3 &&
      inPoly(p, pts) &&
      (inTri(p, V, pts[0], pts[pts.length - 1]) || (pts.length >= 3 && inPoly(p, pts)))
    );
  }
  return false;
}
export function capHit(p, V, tOutward, hw, cap) {
  // tOutward: unit direction pointing away from the path at the end
  if (cap === 'round') return len(sub(p, V)) <= hw;
  if (cap === 'square') {
    const n = [-tOutward[1], tOutward[0]];
    const d = sub(p, V);
    const a = dot(d, tOutward),
      l = dot(d, n);
    return a >= 0 && a <= hw && Math.abs(l) <= hw;
  }
  return false;
}
// pieces: [{segs:[{s,t0,t1}], closed:bool}]; region membership
export function inside(p, sp, hw, cap, join, ml) {
  for (const sc of sp) {
    const L = sc.segs;
    for (const q of L) {
      if (bodyHit(q.s, q.t0, q.t1, p, hw)) return true;
    }
    for (let i = 0; i < L.length; i++) {
      const a = L[i],
        b = L[(i + 1) % L.length];
      if (i + 1 === L.length && !sc.closed) break;
      if (a.t1 < 1 || b.t0 > 0) continue; // dash cut inside a segment: that is a cap
      const tA = tanIn(a.s),
        tB = tanOut(b.s);
      if (!tA || !tB) continue;
      if (joinHit(p, a.s.p[a.s.p.length - 1], tA, tB, hw, join, ml)) return true;
    }
    if (!sc.closed && L.length) {
      const f = L[0],
        l = L[L.length - 1];
      const tf = dv(f.s, f.t0),
        tl = dv(l.s, l.t1);
      const nf = len(tf) > 0 ? mul(tf, -1 / len(tf)) : null,
        nl = len(tl) > 0 ? mul(tl, 1 / len(tl)) : null;
      if (nf && capHit(p, ev(f.s, f.t0), nf, hw, cap)) return true;
      if (nl && capHit(p, ev(l.s, l.t1), nl, hw, cap)) return true;
    }
  }
  return false;
}
export const wholeSubpaths = (subs) =>
  subs.map((s) => ({
    segs: s.segs.filter((x) => !degenerate(x)).map((x) => ({ s: x, t0: 0, t1: 1 })),
    closed: s.closed,
    raw: s,
  }));
// box-sample coverage of pixel [x,y] with n x n samples; toLocal maps doc pt -> user pt
export function cov(f, toLocal, x, y, n = 6) {
  let c = 0;
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) if (f(toLocal([x + (i + 0.5) / n, y + (j + 0.5) / n]))) c++;
  return c / (n * n);
}
// ---- arc length + dash cutting (independent) ----
const GL = [
  [-0.906179845938664, 0.2369268850561891],
  [-0.5384693101056831, 0.4786286704993665],
  [0, 0.5688888888888889],
  [0.5384693101056831, 0.4786286704993665],
  [0.906179845938664, 0.2369268850561891],
];
export function slen(s, t0 = 0, t1 = 1) {
  if (s.t === 'L') return len(sub(s.p[1], s.p[0])) * (t1 - t0);
  const M = 256;
  let L = 0;
  for (let i = 0; i < M; i++) {
    const a = t0 + ((t1 - t0) * i) / M,
      b = t0 + ((t1 - t0) * (i + 1)) / M;
    for (const [x, w] of GL) {
      const t = (a + b) / 2 + ((b - a) / 2) * x;
      L += ((w * (b - a)) / 2) * len(dv(s, t));
    }
  }
  return L;
}
export function tAtLen(s, target, L) {
  // t in [0,1] so that arclen(0..t)=target
  if (s.t === 'L') return L === 0 ? 0 : target / L;
  let lo = 0,
    hi = 1;
  for (let k = 0; k < 48; k++) {
    const m = (lo + hi) / 2;
    if (slen(s, 0, m) < target) lo = m;
    else hi = m;
  }
  return (lo + hi) / 2;
}
// dash a subpath (starting at dash offset phase). returns pieces (open) ; ignores seam merge on closed (reports separately)
export function dashSub(sc, dashes, off) {
  const D = dashes.length % 2 ? dashes.concat(dashes) : dashes.slice();
  const T = D.reduce((a, b) => a + b, 0);
  const segs = sc.segs;
  const Ls = segs.map((x) => slen(x.s));
  const total = Ls.reduce((a, b) => a + b, 0);
  // locate dash state at s=0
  let ph = ((off % T) + T) % T,
    idx = 0;
  while (ph >= D[idx] && !(D[idx] === 0 && ph === 0 && false)) {
    ph -= D[idx];
    idx = (idx + 1) % D.length;
    if (ph < 0) break;
  }
  const out = [];
  let s0 = 0; // walk in arc length
  let pos = 0,
    remain = D[idx] - ph,
    on = idx % 2 === 0,
    cur = on ? [{ start: 0 }] : null;
  const bounds = [];
  let guard = 0;
  const events = [];
  let p = 0;
  // generate on-intervals in arc length
  const ivs = [];
  let a = 0,
    i = idx,
    r = D[idx] - ph;
  while (a < total && guard++ < 1e6) {
    const b = Math.min(a + r, total);
    if (i % 2 === 0) ivs.push([a, b]);
    a = a + r;
    i = (i + 1) % D.length;
    r = D[i];
    if (r === 0 && T === 0) break;
  }
  // map arc-length intervals to param pieces
  const cum = [0];
  for (const l of Ls) cum.push(cum[cum.length - 1] + l);
  const piece = (A, B) => {
    const ss = [];
    for (let k = 0; k < segs.length; k++) {
      const lo = cum[k],
        hi = cum[k + 1];
      if (B < lo || A > hi || hi === lo) continue;
      if (B === lo && A < lo) continue;
      const aa = Math.max(A, lo) - lo,
        bb = Math.min(B, hi) - lo;
      if (bb < aa) continue;
      const t0 = aa <= 0 ? 0 : tAtLen(segs[k].s, aa, Ls[k]),
        t1 = bb >= Ls[k] ? 1 : tAtLen(segs[k].s, bb, Ls[k]);
      ss.push({ s: segs[k].s, t0, t1 });
    }
    return { segs: ss, closed: false };
  };
  for (const [A, B] of ivs) {
    if (B > A) out.push(piece(A, B));
    else out.push({ zero: true, at: A, piece: piece(A, B + 1e-9) });
  }
  return out;
}

// ---- CLOSED SUBPATHS (SVG 2 13.5: a closed subpath has no caps at its start; a dash that is on at both ends of it is ONE dash) ----
// Dash a closed subpath whole: the pattern runs from the subpath start through its end, and the dash on at the end continues into
// the one on at the start -- one piece, one join at the seam vertex, no caps there. A dash that ENDS exactly at the end counts as
// on there, and one that STARTS exactly at the start as on there (so the two meet). Dashes that only touch the seam from one side
// are ordinary dashes with their caps. A pattern that is on over the whole subpath leaves it closed (every vertex a join).
// Returns the pieces dashSub returns, in path order (the merged piece first-segs-last), each {segs, closed:false} or {segs, closed:true}.
export function dashClosed(sc, dashes, off) {
  const D = dashes.length % 2 ? dashes.concat(dashes) : dashes.slice(),
    T = D.reduce((a, b) => a + b, 0);
  const segs = sc.segs,
    Ls = segs.map((x) => slen(x.s)),
    total = Ls.reduce((a, b) => a + b, 0);
  const cum = [0];
  for (const l of Ls) cum.push(cum[cum.length - 1] + l);
  let ph = ((off % T) + T) % T,
    idx = 0;
  while (ph >= D[idx]) {
    ph -= D[idx];
    idx = (idx + 1) % D.length;
  }
  const ivs = [];
  let a = 0,
    i = idx,
    r = D[idx] - ph,
    guard = 0;
  while (a < total && guard++ < 1e6) {
    const b = Math.min(a + r, total);
    if (i % 2 === 0 && b > a) ivs.push([a, b]);
    a += r;
    i = (i + 1) % D.length;
    r = D[i];
  }
  const piece = (A, B) => {
    const ss = [];
    for (let k = 0; k < segs.length; k++) {
      const lo = cum[k],
        hi = cum[k + 1];
      if (hi === lo || B <= lo || A >= hi) continue;
      const aa = Math.max(A, lo) - lo,
        bb = Math.min(B, hi) - lo;
      // (cum[k + 1] - cum[k] is not Ls[k] to the last bit: a piece that reaches a segment's end must say t1 = 1 or its join is lost)
      const e = 1e-12 * Ls[k];
      const t0 = aa <= e ? 0 : tAtLen(segs[k].s, aa, Ls[k]),
        t1 = bb >= Ls[k] - e ? 1 : tAtLen(segs[k].s, bb, Ls[k]);
      ss.push({ s: segs[k].s, t0, t1 });
    }
    return { segs: ss, closed: false };
  };
  if (!ivs.length) return [];
  const onFirst = ivs[0][0] <= 0,
    onLast = ivs[ivs.length - 1][1] >= total;
  if (ivs.length === 1 && onFirst && onLast)
    return [{ segs: segs.map((x) => ({ s: x.s, t0: 0, t1: 1 })), closed: true }];
  const ps = ivs.map(([A, B]) => piece(A, B));
  if (onFirst && onLast) {
    const first = ps.shift(),
      last = ps.pop();
    ps.unshift({ segs: last.segs.concat(first.segs), closed: false });
  }
  return ps;
}
// the total length of the subpath (for pathLength scaling: the dash lengths scale by total / pathLength)
export const subLen = (sc) => sc.segs.reduce((a, x) => a + slen(x.s), 0);
