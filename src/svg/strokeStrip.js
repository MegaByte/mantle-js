// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// svg/strokeStrip.js -- the STRIP COVER of a stroke row).
//
// A stroke row's cover is one oriented box over the whole path; on a long thin or sparse path 98-99 percent of its
// fragments shade pixels the stroke never touches. The strip covers only the stroke: the path flattened to a polyline,
// a CROSS-SECTION at every vertex (along the bisector, half-length halfW / cos(turn / 2), which is the miter wedge's
// tip, so the body, every join shape up to the miter tip and every round join are inside), and one convex quad between
// each pair of consecutive cross-sections, split into two triangles. Consecutive quads share their cross-section's two
// vertices BIT FOR BIT (each is computed once and indexed), so the strip is watertight: no overlap, no gap, no T-junction.
// An open end gets a cap quad past its end section (round and square caps: halfW deep; butt: none).
//
// DILATION (the vertex stage's coverQuadDilate, half a pixel along the vertex normal, scaled here to reach the box
// filter's 0.7071 px along any edge direction): only the strip's OUTER edges move; every vertex of a section carries the
// outward normal of its two side edges, so a shared cross-section edge moves as one and the quads never grow into each
// other.
//
// Folded runs use convex covers of the flattened points, join tips and cap corners,
// expanded by the stroke reach. These covers overlap adjacent quads, so they require
// the renderer's depth claim to paint each pixel once. Contexts without depth retain
// the row's cover quad. Arcs joins and covers exceeding MAX_AREA_RATIO also retain it.
import { SEG_LINE, SEG_QUAD, SEG_CUBIC, SEG_ARC, pointsMeet, segStart, segEnd } from './segment.js';

const MAX_MITER = 12;
const MAX_AREA_RATIO = 0.4;
// A fold patch's points stay within PATCH_CHUNK reach radii of its first point; its circumscribed corners turn at most PATCH_STEP.
const PATCH_CHUNK = 2;
const PATCH_STEP = Math.PI / 4;
// The dilation normal's length: |normal| 1 is half a pixel, so sqrt(2) reaches the box filter's 0.7071 px along any edge direction.
// The hairline floor (a stroke is drawn at least half a pixel each side of its centerline, in the avg of the map's two em-per-pixel
// axes) is added by the vertex stage, which knows the map: it reads each strip vertex's half-width from float 7 (see buildStrokeStrip).
const SQ2 = Math.SQRT2;

function flattenSeg(s, tol, out) {
  if (s.type === SEG_LINE) {
    out.push([s.p2[0], s.p2[1]]);
    return;
  }
  if (s.type === SEG_QUAD || s.type === SEG_CUBIC) {
    const P = s.type === SEG_QUAD ? [s.p1, s.p2, s.p3] : [s.p1, s.p2, s.p3, s.p4];
    let M;
    if (P.length === 3)
      M = 2 * Math.hypot(P[0][0] - 2 * P[1][0] + P[2][0], P[0][1] - 2 * P[1][1] + P[2][1]);
    else
      M =
        6 *
        Math.max(
          Math.hypot(P[0][0] - 2 * P[1][0] + P[2][0], P[0][1] - 2 * P[1][1] + P[2][1]),
          Math.hypot(P[1][0] - 2 * P[2][0] + P[3][0], P[1][1] - 2 * P[2][1] + P[3][1]),
        );
    const n = Math.max(1, Math.min(512, Math.ceil(Math.sqrt(M / (8 * tol)))));
    for (let i = 1; i < n; i++) {
      const t = i / n,
        u = 1 - t;
      if (P.length === 3)
        out.push([
          u * u * P[0][0] + 2 * u * t * P[1][0] + t * t * P[2][0],
          u * u * P[0][1] + 2 * u * t * P[1][1] + t * t * P[2][1],
        ]);
      else {
        const w0 = u * u * u,
          w1 = 3 * u * u * t,
          w2 = 3 * u * t * t,
          w3 = t * t * t;
        out.push([
          w0 * P[0][0] + w1 * P[1][0] + w2 * P[2][0] + w3 * P[3][0],
          w0 * P[0][1] + w1 * P[1][1] + w2 * P[2][1] + w3 * P[3][1],
        ]);
      }
    }
    out.push([P[P.length - 1][0], P[P.length - 1][1]]);
    return;
  }
  // arc
  const r = Math.max(Math.abs(s.rx), Math.abs(s.ry)),
    sweep = Math.abs(s.theta_end - s.theta_start);
  const dth = r > tol ? 2 * Math.acos(Math.max(-1, 1 - tol / r)) : Math.PI;
  const n = Math.max(1, Math.min(512, Math.ceil(sweep / Math.max(dth, 1e-3))));
  const cp = Math.cos(s.phi || 0),
    sp = Math.sin(s.phi || 0);
  for (let i = 1; i <= n; i++) {
    const th = s.theta_start + (s.theta_end - s.theta_start) * (i / n);
    const ex = s.rx * Math.cos(th),
      ey = s.ry * Math.sin(th);
    out.push([s.cx + ex * cp - ey * sp, s.cy + ex * sp + ey * cp]);
  }
  // the arc's own end, exactly
  const e = segEnd(s),
    last = out[out.length - 1];
  if (e) {
    last[0] = e[0];
    last[1] = e[1];
  }
}

/** A segment's tangent direction at its start (end = false) or end (end = true), unnormalized; null when it has none. */
export function segTangent(s, end) {
  const d = (p, q) =>
    p && q && (q[0] !== p[0] || q[1] !== p[1]) ? [q[0] - p[0], q[1] - p[1]] : null;
  if (s.type === SEG_LINE) return d(s.p1, s.p2);
  if (s.type === SEG_QUAD)
    return end ? d(s.p2, s.p3) || d(s.p1, s.p3) : d(s.p1, s.p2) || d(s.p1, s.p3);
  if (s.type === SEG_CUBIC)
    return end
      ? d(s.p3, s.p4) || d(s.p2, s.p4) || d(s.p1, s.p4)
      : d(s.p1, s.p2) || d(s.p1, s.p3) || d(s.p1, s.p4);
  if (s.type === SEG_ARC) {
    const th = end ? s.theta_end : s.theta_start,
      sg = s.theta_end >= s.theta_start ? 1 : -1;
    const cp = Math.cos(s.phi || 0),
      sp = Math.sin(s.phi || 0),
      ex = -s.rx * Math.sin(th),
      ey = s.ry * Math.cos(th);
    const tx = sg * (ex * cp - ey * sp),
      ty = sg * (ex * sp + ey * cp);
    return tx !== 0 || ty !== 0 ? [tx, ty] : null;
  }
  return null;
}

/** Split the segments into subpaths of points. A subpath is closed when its last point meets its first. A point where
 *  two segments meet carries `.j = [tin, tout]`, the two segments' own end tangents there (a JOIN the shader draws). */
function polylines(segs, tol) {
  const subs = [];
  let cur = null,
    curStart = null,
    prev = null,
    first = null;
  for (const s of segs) {
    if (!s) continue;
    const a = segStart(s);
    if (!a) return null;
    if (!cur || s.subStart === true || !pointsMeet(cur[cur.length - 1], a)) {
      cur = [[a[0], a[1]]];
      curStart = a;
      subs.push(cur);
      first = s;
    } else if (prev) {
      const ti = segTangent(prev, true),
        to = segTangent(s, false);
      if (ti && to) cur[cur.length - 1].j = [ti, to];
    }
    cur.firstSeg = first;
    cur.lastSeg = s;
    flattenSeg(s, tol, cur);
    if (s.openEnd === true) cur.openEnd = true;
    prev = s;
  }
  return subs.map((pts) => {
    // drop consecutive duplicates (relative to the extent); a dropped point's join moves to the point it duplicates
    let ext = 0;
    for (const p of pts) ext = Math.max(ext, Math.abs(p[0]), Math.abs(p[1]));
    const eps = 1e-9 * Math.max(ext, 1e-30);
    const q = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      if (Math.hypot(pts[i][0] - q[q.length - 1][0], pts[i][1] - q[q.length - 1][1]) > eps)
        q.push(pts[i]);
      else if (pts[i].j) q[q.length - 1].j = pts[i].j;
    }
    const closed =
      !pts.openEnd &&
      q.length > 2 &&
      Math.hypot(q[0][0] - q[q.length - 1][0], q[0][1] - q[q.length - 1][1]) <= eps * 4;
    if (closed) {
      q.pop();
      const ti = segTangent(pts.lastSeg, true),
        to = segTangent(pts.firstSeg, false);
      if (ti && to) q[0].j = [ti, to];
    }
    // an open subpath's own end tangents: a butt or square cap is cut square to the CURVE, not to the first chord
    return {
      pts: q,
      closed,
      t0: segTangent(pts.firstSeg, false),
      t1: segTangent(pts.lastSeg, true),
    };
  });
}

const cross = (ax, ay, bx, by) => ax * by - ay * bx;

/** Do two convex quads (4 points each, same orientation) overlap by more than `tol` in depth? SAT. */
function quadsOverlap(A, B, tol) {
  for (const Q of [A, B]) {
    for (let i = 0; i < 4; i++) {
      const p = Q[i],
        q = Q[(i + 1) % 4];
      let nx = q[1] - p[1],
        ny = p[0] - q[0];
      const l = Math.hypot(nx, ny);
      if (!(l > 0)) continue;
      nx /= l;
      ny /= l;
      let amin = Infinity,
        amax = -Infinity,
        bmin = Infinity,
        bmax = -Infinity;
      for (const a of A) {
        const v = a[0] * nx + a[1] * ny;
        if (v < amin) amin = v;
        if (v > amax) amax = v;
      }
      for (const b of B) {
        const v = b[0] * nx + b[1] * ny;
        if (v < bmin) bmin = v;
        if (v > bmax) bmax = v;
      }
      if (amax - bmin <= tol || bmax - amin <= tol) return false; // separated or only touching
    }
  }
  return true;
}

/** Convex hull of points (Andrew's monotone chain), counter-clockwise (positive cross), no collinear points. */
function convexHull(pts) {
  const P = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (P.length < 3)
    return P.length === 2 && P[0][0] === P[1][0] && P[0][1] === P[1][1] ? [P[0]] : P;
  const turn = (o, a, b) => cross(a[0] - o[0], a[1] - o[1], b[0] - o[0], b[1] - o[1]);
  const lo = [],
    hi = [];
  for (const p of P) {
    while (lo.length >= 2 && turn(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop();
    lo.push(p);
  }
  for (let i = P.length - 1; i >= 0; i--) {
    const p = P[i];
    while (hi.length >= 2 && turn(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop();
    hi.push(p);
  }
  lo.pop();
  hi.pop();
  const h = lo.concat(hi);
  return h.length ? h : [P[0]];
}

/**
 * Convex cover of the hull's radius-R neighborhood. Adjacent tangent lines meet
 * at each vertex; their normals turn by at most PATCH_STEP. Dilation normals
 * project to sqrt(2) on both adjacent edges, matching the strip vertex format.
 */
function patchPolygon(pts, R) {
  const h = convexHull(pts),
    m = h.length,
    out = [];
  for (let i = 0; i < m; i++) {
    const P = h[i];
    let nIn, phi;
    if (m === 1) {
      nIn = [1, 0];
      phi = 2 * Math.PI;
    } else {
      const A = h[(i - 1 + m) % m],
        B = h[(i + 1) % m];
      const ex = P[0] - A[0],
        ey = P[1] - A[1],
        el = Math.hypot(ex, ey);
      const fx = B[0] - P[0],
        fy = B[1] - P[1],
        fl = Math.hypot(fx, fy);
      nIn = [ey / el, -ex / el];
      const nOut = [fy / fl, -fx / fl];
      phi =
        m === 2
          ? Math.PI
          : Math.atan2(
              cross(nIn[0], nIn[1], nOut[0], nOut[1]),
              nIn[0] * nOut[0] + nIn[1] * nOut[1],
            );
      if (phi < 0) phi += 2 * Math.PI;
    }
    const k = Math.max(1, Math.ceil(phi / PATCH_STEP - 1e-9)),
      st = phi / k;
    // the outward normal (ey, -ex) of a counter-clockwise hull turns counter-clockwise through the exterior angle
    let a = nIn;
    for (let j = 0; j < k; j++) {
      const c = Math.cos(st * (j + 1)),
        sn = Math.sin(st * (j + 1));
      const b = j === k - 1 && m > 1 ? null : [nIn[0] * c - nIn[1] * sn, nIn[0] * sn + nIn[1] * c];
      const bb =
        b ||
        (() => {
          const B = h[(i + 1) % m];
          const fx = B[0] - P[0],
            fy = B[1] - P[1],
            fl = Math.hypot(fx, fy);
          return [fy / fl, -fx / fl];
        })();
      const den = 1 + a[0] * bb[0] + a[1] * bb[1];
      const mx = (a[0] + bb[0]) / den,
        my = (a[1] + bb[1]) / den;
      out.push({ p: [P[0] + R * mx, P[1] + R * my], n: [SQ2 * mx, SQ2 * my] });
      a = bb;
    }
  }
  return out;
}

/** Point-in-convex-quad (either orientation), boundary inclusive within a tolerance relative to the quad's extent (a miter
 *  tip computed from the true tangents lands ON a straight join's section vertex, up to rounding). */
function inQuad(q, x, y) {
  let pos = 0,
    neg = 0,
    ext = 0;
  for (let i = 0; i < 4; i++)
    ext = Math.max(ext, Math.hypot(q[(i + 1) % 4][0] - q[i][0], q[(i + 1) % 4][1] - q[i][1]));
  for (let i = 0; i < 4; i++) {
    const a = q[i],
      b = q[(i + 1) % 4],
      c = cross(b[0] - a[0], b[1] - a[1], x - a[0], y - a[1]);
    const t = 1e-9 * Math.hypot(b[0] - a[0], b[1] - a[1]) * ext;
    if (c > t) pos++;
    else if (c < -t) neg++;
  }
  return pos === 0 || neg === 0;
}

/**
 * @param {Array} segs the row's native segments
 * @param {object} o { halfW, joinStyle, miterLimit, capStyle, endCapStyle, boxArea } (boxArea: the single quad's area, em^2)
 * @returns {{verts:number[], area:number, quads:number, overlap:boolean, patches:number}|null} COVER_QUAD_STRIDE (12) floats
 *          per vertex as triangles; null to keep the row's single quad
 */
export function buildStrokeStrip(segs, o) {
  const {
    halfW,
    joinStyle,
    capStyle,
    endCapStyle = capStyle,
    boxArea,
    maxAreaRatio = MAX_AREA_RATIO,
    tolFactor = 0.25,
    tolDiag = 0,
  } = o;
  const miterLimit = Math.max(1, o.miterLimit || 4);
  if (!(halfW > 0) || joinStyle === 4) return null; // arcs joins have no miter bound
  // the polyline's own deviation from the curve: the strip is widened by it, so a coarser value trades area (cheap on a thin
  // row, whose strip is a sliver of its box) for far fewer quads
  let tol = tolFactor * halfW;
  if (tolDiag > 0) {
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const s of segs) {
      if (!s) continue;
      for (const k of ['p1', 'p2', 'p3', 'p4']) {
        const q = s[k];
        if (q) {
          if (q[0] < x0) x0 = q[0];
          if (q[0] > x1) x1 = q[0];
          if (q[1] < y0) y0 = q[1];
          if (q[1] > y1) y1 = q[1];
        }
      }
    }
    if (x1 >= x0) tol = Math.max(tol, tolDiag * Math.hypot(x1 - x0, y1 - y0));
  }
  const R2 = halfW * (1 + 1e-4) + tol;
  const subs = polylines(segs, tol);
  if (!subs || !subs.length) return null;
  const verts = [];
  // floats 6 and 7 mark a strip vertex (1) and carry its half-width in em, for the vertex stage's hairline floor
  const pushV = (v) => {
    verts.push(v.p[0], v.p[1], v.n[0], v.n[1], 1, R2, 0, 0, 0, 0, 1.0, -1.0);
  };
  const tri = (a, b, c) => {
    pushV(a);
    pushV(b);
    pushV(c);
  };
  const quads = []; // { q: [4 points], sub, idx, adj: [keys] }
  let area = 0,
    qid = 0,
    patches = 0;
  const NEG = -1; // the orientation every quad must have
  const sgn = (a, b, c) => cross(b[0] - a[0], b[1] - a[1], c[0] - b[0], c[1] - b[1]);
  const quadOk = (s0, s1) => {
    const q = [s0.L.p, s1.L.p, s1.R.p, s0.R.p];
    const ext = Math.max(Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]), R2);
    const t = 1e-9 * ext * ext;
    return NEG * sgn(q[0], q[1], q[2]) > t &&
      NEG * sgn(q[1], q[2], q[3]) > t &&
      NEG * sgn(q[2], q[3], q[0]) > t &&
      NEG * sgn(q[3], q[0], q[1]) > t
      ? q
      : null;
  };
  const addQuad = (s0, s1, tag) => {
    const q = quadOk(s0, s1);
    if (!q) return false;
    area +=
      0.5 *
      Math.abs(cross(q[2][0] - q[0][0], q[2][1] - q[0][1], q[3][0] - q[1][0], q[3][1] - q[1][1]));
    quads.push({ q, tag, id: qid++ });
    tri(s0.L, s0.R, s1.R);
    tri(s0.L, s1.R, s1.L);
    return true;
  };
  const addPatch = (pts) => {
    const poly = patchPolygon(pts, R2);
    for (let i = 1; i + 1 < poly.length; i++) tri(poly[0], poly[i], poly[i + 1]);
    let a2 = 0;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i].p,
        q = poly[(i + 1) % poly.length].p;
      a2 += cross(p[0], p[1], q[0], q[1]);
    }
    area += 0.5 * Math.abs(a2);
    patches++;
  };
  /// What a JOIN at polyline point P can draw beyond the R2 disc about P: the miter tip when the join miters (style 0 or 3
  /// within the limit, from the segments' own end tangents -- the polyline's turn is only a chord's), the two clip
  /// corners when a miter-clip join is past its limit; [] for round and bevel joins and for a miter that bevels. The
  /// regions are built at R2 (the whole kite scaled about P by R2 / halfW >= 1, so it holds the halfW kite).
  const joinExtras = (P) => {
    if (!P.j || (joinStyle !== 0 && joinStyle !== 3)) return [];
    const [ti, to] = P.j,
      li = Math.hypot(ti[0], ti[1]),
      lo = Math.hypot(to[0], to[1]);
    const d1 = [ti[0] / li, ti[1] / li],
      d2 = [to[0] / lo, to[1] / lo];
    const cosT = d1[0] * d2[0] + d1[1] * d2[1];
    if (!(1 + cosT > 0)) return []; // a full reversal: the miter is unbounded and bevels (round past curves)
    const cosHalf = Math.sqrt((1 + cosT) * 0.5),
      ratio = 1 / cosHalf;
    const sOut = cross(d1[0], d1[1], d2[0], d2[1]) > 0 ? -1 : 1; // the outer side: right of a left turn
    const n1 = [-d1[1] * sOut, d1[0] * sOut],
      n2 = [-d2[1] * sOut, d2[0] * sOut];
    const bx = n1[0] + n2[0],
      by = n1[1] + n2[1],
      bl = Math.hypot(bx, by);
    if (!(bl > 0)) return [];
    const b = [bx / bl, by / bl];
    if (ratio <= miterLimit * 1.02 + 1e-3)
      return [[P[0] + b[0] * R2 * ratio, P[1] + b[1] * R2 * ratio]];
    if (joinStyle === 0) return []; // past the limit a miter bevels (or rounds where a curve takes part)
    // miter-clip past its limit: the kite cut at R2 * limit along the bisector; its corners on the two outer offset lines
    const ML = R2 * miterLimit,
      tipD = R2 * ratio,
      baseD = R2 * cosHalf;
    const sc = tipD > baseD ? Math.min(1, Math.max(0, (ML - baseD) / (tipD - baseD))) : 0;
    const T = [P[0] + b[0] * tipD, P[1] + b[1] * tipD];
    return [n1, n2].map((n) => {
      const A = [P[0] + n[0] * R2, P[1] + n[1] * R2];
      return [A[0] + sc * (T[0] - A[0]), A[1] + sc * (T[1] - A[1])];
    });
  };
  let subIdx = 0;
  for (const sp of subs) {
    const P = sp.pts,
      n = P.length,
      closed = sp.closed;
    if (n < 2 || (closed && n < 3)) return null;
    const nSeg = closed ? n : n - 1;
    const dir = [],
      nor = [];
    for (let i = 0; i < nSeg; i++) {
      const a = P[i],
        b = P[(i + 1) % n];
      const dx = b[0] - a[0],
        dy = b[1] - a[1],
        l = Math.hypot(dx, dy);
      if (!(l > 0)) return null;
      dir.push([dx / l, dy / l]);
      nor.push([-dy / l, dx / l]);
    }
    // cross-sections: points and dilation normals (vertex objects {p, n}); a vertex is shared by every triangle that uses it.
    // A section with no bound (a reversal) or past MAX_MITER is null: the quads on both sides of it go to a patch.
    // AN OPEN END with a butt or square cap is cut by the shader's cap plane, square to the segment's own end tangent; the
    // first chord's direction differs from it by up to the flattening's angle, which cut a sliver off the end. Its section
    // runs along that plane out to the chord's two offset lines (R2 / cos of the angle between the normals), so the body
    // quad's sides stay the chord's offset lines. Past MAX_MITER the section is null and the end goes to a patch (which
    // takes a square cap's two far corners). A round cap keeps the chord's section: its cap quad and the body hold the disc.
    const ends = [];
    if (!closed) {
      const unit = (v, fb) => {
        const l = v ? Math.hypot(v[0], v[1]) : 0;
        return l > 0 ? [v[0] / l, v[1] / l] : fb;
      };
      const ta = unit(sp.t0, dir[0]),
        tb = unit(sp.t1, dir[nSeg - 1]);
      ends[0] = { t: [-ta[0], -ta[1]], nt: [-ta[1], ta[0]], nc: nor[0], cap: capStyle };
      ends[n - 1] = { t: tb, nt: [-tb[1], tb[0]], nc: nor[nSeg - 1], cap: endCapStyle };
    }
    const planeEnd = (k) => {
      const e = ends[k];
      return e && (e.cap === 0 || e.cap === 2) ? e : null;
    };
    const sec = [];
    for (let k = 0; k < n; k++) {
      const p = P[k],
        e = planeEnd(k);
      if (e) {
        const c = e.nt[0] * e.nc[0] + e.nt[1] * e.nc[1];
        if (!(c * MAX_MITER > 1)) {
          sec.push(null);
          continue;
        }
        const ox = (e.nt[0] * R2) / c,
          oy = (e.nt[1] * R2) / c;
        // the dilation normals: a butt end's corner joins the side (nc) and the cap plane (t); a square end's section joins
        // the body's side (nc) and the cap quad's side (nt)
        const corner = (a, b) => {
          const d = 1 + a[0] * b[0] + a[1] * b[1];
          return [(SQ2 * (a[0] + b[0])) / d, (SQ2 * (a[1] + b[1])) / d];
        };
        const nL = e.cap === 0 ? corner(e.nc, e.t) : corner(e.nc, e.nt);
        const nR =
          e.cap === 0
            ? corner([-e.nc[0], -e.nc[1]], e.t)
            : corner([-e.nc[0], -e.nc[1]], [-e.nt[0], -e.nt[1]]);
        sec.push({
          L: { p: [p[0] + ox, p[1] + oy], n: nL },
          R: { p: [p[0] - ox, p[1] - oy], n: nR },
        });
        continue;
      }
      const n1 = closed ? nor[(k - 1 + nSeg) % nSeg] : nor[Math.max(0, k - 1)];
      const n2 = closed ? nor[k % nSeg] : nor[Math.min(nSeg - 1, k)];
      const mx = n1[0] + n2[0],
        my = n1[1] + n2[1],
        m2 = mx * mx + my * my;
      if (!(m2 > 1e-12)) {
        sec.push(null);
        continue;
      } // a reversal
      const k2 = (2 * R2) / m2,
        ox = mx * k2,
        oy = my * k2;
      if (Math.hypot(ox, oy) > MAX_MITER * R2) {
        sec.push(null);
        continue;
      } // a miter tip too far out
      const den = 1 + (n1[0] * n2[0] + n1[1] * n2[1]);
      const nv =
        den > 1e-9
          ? [(SQ2 * (n1[0] + n2[0])) / den, (SQ2 * (n1[1] + n2[1])) / den]
          : [SQ2 * n1[0], SQ2 * n1[1]];
      sec.push({
        L: { p: [p[0] + ox, p[1] + oy], n: nv },
        R: { p: [p[0] - ox, p[1] - oy], n: [-nv[0], -nv[1]] },
      });
    }
    /// what a patch over an open end must add to the disc about it: a square cap's two far corners
    const endExtras = (k) => {
      const e = ends[k];
      if (!e || e.cap !== 2) return [];
      const q = P[k],
        f = [q[0] + e.t[0] * R2, q[1] + e.t[1] * R2];
      return [
        [f[0] + e.nt[0] * R2, f[1] + e.nt[1] * R2],
        [f[0] - e.nt[0] * R2, f[1] - e.nt[1] * R2],
      ];
    };
    // which body quads (quad i: section i -> i + 1) stand; the rest are patched
    const good = new Array(nSeg);
    for (let i = 0; i < nSeg; i++)
      good[i] = !!(sec[i] && sec[(i + 1) % n] && quadOk(sec[i], sec[(i + 1) % n]));
    // a miter join whose true tip lies outside both quads at its point: patch both (the tip rides the patch)
    for (let k = 0; k < n; k++) {
      const ex = joinExtras(P[k]);
      if (!ex.length) continue;
      const qa = closed ? (k - 1 + nSeg) % nSeg : k - 1,
        qb = closed ? k % nSeg : k < nSeg ? k : -1;
      const cov = (x) =>
        (qa >= 0 && good[qa] && inQuad(quadOk(sec[qa], sec[(qa + 1) % n]), x[0], x[1])) ||
        (qb >= 0 && good[qb] && inQuad(quadOk(sec[qb], sec[(qb + 1) % n]), x[0], x[1]));
      if (!ex.every(cov)) {
        if (qa >= 0) good[qa] = false;
        if (qb >= 0) good[qb] = false;
      }
    }
    // A good quad beside a patched one ends SQUARE to its own segment at that point (P +- R2 n): the bisector section's
    // far side holds part of this segment's neighbourhood that the neighbouring QUAD would have covered, which a patch
    // (the neighbours' own neighbourhood) does not; square, this quad holds its segment's whole band up to the point and
    // the patch's disc there holds the rest. The square end is not dilated along the segment: the patch's dilation covers
    // past it. A quad that no longer stands joins the patch, which can expose its neighbor in turn.
    const prevOf = (i) => (closed ? (i - 1 + nSeg) % nSeg : i - 1),
      nextOf = (i) => (closed ? (i + 1) % nSeg : i + 1 < nSeg ? i + 1 : -1);
    const square = (i, k) => ({
      L: {
        p: [P[k][0] + nor[i][0] * R2, P[k][1] + nor[i][1] * R2],
        n: [SQ2 * nor[i][0], SQ2 * nor[i][1]],
      },
      R: {
        p: [P[k][0] - nor[i][0] * R2, P[k][1] - nor[i][1] * R2],
        n: [-SQ2 * nor[i][0], -SQ2 * nor[i][1]],
      },
    });
    const qs = new Array(nSeg);
    for (let changed = true; changed;) {
      changed = false;
      for (let i = 0; i < nSeg; i++) {
        if (!good[i]) continue;
        const pi = prevOf(i),
          ni = nextOf(i);
        const a = pi >= 0 && !good[pi] ? square(i, i) : sec[i];
        const b = ni >= 0 && !good[ni] ? square(i, (i + 1) % n) : sec[(i + 1) % n];
        if (quadOk(a, b)) qs[i] = [a, b];
        else {
          good[i] = false;
          changed = true;
        }
      }
    }
    // caps: a round or square end gets a cap quad R2 deep past its section (along the chord for round, the end tangent
    // for square); a butt end is its section, whose corners carry the cap plane's normal. A null end section has none:
    // its patch holds the cap.
    const startExt = [],
      endExt = [];
    if (!closed) {
      for (const [k, store] of [
        [0, startExt],
        [n - 1, endExt],
      ]) {
        const s = sec[k],
          e = ends[k];
        if (!s || e.cap === 0) continue;
        const t = e.cap === 2 ? e.t : k === 0 ? [-dir[0][0], -dir[0][1]] : dir[nSeg - 1];
        const side = e.cap === 2 ? e.nt : e.nc;
        const nL = [SQ2 * (side[0] + t[0]), SQ2 * (side[1] + t[1])],
          nR = [SQ2 * (t[0] - side[0]), SQ2 * (t[1] - side[1])];
        store.push({
          L: { p: [s.L.p[0] + t[0] * R2, s.L.p[1] + t[1] * R2], n: nL },
          R: { p: [s.R.p[0] + t[0] * R2, s.R.p[1] + t[1] * R2], n: nR },
        });
      }
    }
    const first = quads.length;
    if (startExt.length && !addQuad(startExt[0], sec[0], 'c')) return null;
    for (let i = 0; i < nSeg; i++) if (good[i] && !addQuad(qs[i][0], qs[i][1], 's')) return null;
    if (endExt.length && !addQuad(sec[n - 1], endExt[0], 'c')) return null;
    // the patched runs: maximal runs of bad body quads (cyclic on a closed subpath), each covered by chunked patches
    let start0 = 0;
    if (closed) {
      start0 = good.indexOf(true);
      if (start0 < 0) start0 = 0;
    }
    for (let c = 0; c < nSeg; c++) {
      const i0 = closed ? (start0 + c) % nSeg : c;
      if (good[i0] || (c > 0 && !good[closed ? (i0 - 1 + nSeg) % nSeg : i0 - 1])) continue; // not the start of a bad run
      let len = 0;
      while (
        len < nSeg &&
        !good[closed ? (i0 + len) % nSeg : i0 + len] &&
        (closed || i0 + len < nSeg)
      )
        len++;
      // the run's points: P[i0] .. P[i0 + len] (segment i joins P[i] and P[i + 1])
      const at = (j) => P[closed ? (i0 + j) % n : i0 + j];
      let s0 = 0;
      while (s0 < len) {
        let e = s0 + 1;
        const A = at(s0);
        while (e < len && Math.hypot(at(e + 1)[0] - A[0], at(e + 1)[1] - A[1]) <= PATCH_CHUNK * R2)
          e++;
        const pts = [];
        for (let j = s0; j <= e; j++) {
          const q = at(j);
          pts.push(q);
          for (const x of joinExtras(q)) pts.push(x);
          for (const x of endExtras(closed ? (i0 + j) % n : i0 + j)) pts.push(x);
        }
        addPatch(pts);
        s0 = e;
      }
      if (closed && len >= nSeg) break;
    }
    // adjacency inside the subpath (they share an edge by construction): the overlap test skips them
    const cnt = quads.length - first;
    for (let j = 0; j < cnt; j++) {
      quads[first + j].sub = subIdx;
      quads[first + j].pos = j;
      quads[first + j].cnt = cnt;
      quads[first + j].closed = closed;
    }
    subIdx++;
  }
  if (boxArea > 0 && area > maxAreaRatio * boxArea) return null;
  // OVERLAP: a path that crosses itself (or comes within a half-width of itself) gives two quads over the same pixels. Both
  // run the same whole-path walk, so they paint the same color twice, which over-brightens a partial pixel; the
  // renderer's depth claim (unifiedFillDraw: depth LESS, one z per row) stops one row painting a pixel twice, so a
  // bundle with an overlapping strip asks for it. Neighbors that share an edge only touch (depth 0) and do not count.
  // A patch overlaps its neighbors by construction, so a row with one is overlapping without the test.
  let overlap = patches > 0;
  if (!overlap) {
    const tolOv = 1e-6 * R2;
    const bb = quads.map((Q) => {
      let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
      for (const p of Q.q) {
        x0 = Math.min(x0, p[0]);
        y0 = Math.min(y0, p[1]);
        x1 = Math.max(x1, p[0]);
        y1 = Math.max(y1, p[1]);
      }
      return [x0, y0, x1, y1];
    });
    outer: for (let i = 0; i < quads.length; i++) {
      const A = quads[i],
        bbi = bb[i];
      for (let j = i + 1; j < quads.length; j++) {
        const B = quads[j],
          bbj = bb[j];
        if (
          A.sub === B.sub &&
          (B.pos === A.pos + 1 || (A.closed && A.pos === 0 && B.pos === A.cnt - 1))
        )
          continue;
        if (
          bbi[2] < bbj[0] - tolOv ||
          bbj[2] < bbi[0] - tolOv ||
          bbi[3] < bbj[1] - tolOv ||
          bbj[3] < bbi[1] - tolOv
        )
          continue;
        if (quadsOverlap(A.q, B.q, tolOv)) {
          overlap = true;
          break outer;
        }
      }
    }
  }
  return { verts, area, quads: quads.length, overlap, patches };
}
