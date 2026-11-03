// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// svg/strokeBox.js -- the STROKE BOUNDING BOX of a shape (SVG 2 §8.10 "stroke bounding box", CSS Masking `stroke-box`), exact.
//
// The box a basic-shape clip-path resolves against by default (`border-box` on an SVG element is `stroke-box`) is the box of the
// shape's INK: its path grown by the stroke's width, caps and joins, markers excluded. It is computed in closed form, no
// flattening, from the shape's own (local) segments and the map M from that local space to the space the box is wanted in:
//
//   * the fill box of the mapped path;
//   * the offset curves p(t) +- h n(t) of every segment. In the mapped space an extremum of an offset curve is where the
//     MAPPED tangent is axis-parallel (the offset curve's tangent is p'(t) (1 + k h), parallel to p'), so the parameters are the
//     roots of the mapped control polygon's axis derivatives, and the point is the local p(t) +- h n(t) mapped by M;
//   * both offset points at every segment end (the cross-section a butt cap or a bevel join is bounded by);
//   * a round join or cap: the part of the mapped disc that exists, i.e. its axis extremes when their direction lies in the
//     join's outer sector or the cap's half-plane;
//   * miter / miter-clip tips and square-cap corners, which strokeInk.js already lists exactly.
//
// Dashes are ignored (a dashed stroke's bounding box is the undashed one, as in browsers). An offset curve with a cusp of its own
// (a stroke wider than the curve's radius of curvature) needs no case: the cusp is the center of curvature, which the curve itself
// passes inside of, so it lies in the interior of the ink; the ink's boundary corners are all reflex (a union of discs), so no
// extreme of the box sits on one, and every other extreme is a stationary point listed above.
import { SEG_LINE, SEG_QUAD, SEG_CUBIC, SEG_ARC, segStart, segEnd, pointsMeet } from './segment.js';
import { pathBbox } from './bbox.js';
import { transformSegInto } from './transform.js';
import { strokeInkPoints } from './strokeInk.js';
import { segTangent } from './strokeStrip.js';

const unit = (v) => {
  if (!v) return null;
  const l = Math.hypot(v[0], v[1]);
  return l > 0 && Number.isFinite(l) ? [v[0] / l, v[1] / l] : null;
};

function subpathsOf(segs) {
  const subs = [];
  let cur = null,
    prev = null;
  for (const s of segs) {
    if (!s) continue;
    const a = segStart(s);
    if (!cur || s.subStart === true || !pointsMeet(segEnd(prev), a)) {
      cur = { segs: [], openEnd: false };
      subs.push(cur);
    }
    cur.segs.push(s);
    if (s.openEnd === true) cur.openEnd = true;
    prev = s;
  }
  for (const sp of subs) {
    const a = segStart(sp.segs[0]),
      b = segEnd(sp.segs[sp.segs.length - 1]);
    sp.closed = !sp.openEnd && sp.segs.length > 1 && pointsMeet(a, b);
  }
  return subs;
}

/// Roots in (0, 1) of the derivative of a Bezier whose scalar control values are `v` (2 to 4 of them).
function derivRoots(v) {
  const n = v.length;
  if (n === 3) {
    const den = v[0] - 2 * v[1] + v[2];
    if (den === 0) return [];
    const t = (v[0] - v[1]) / den;
    return t > 0 && t < 1 ? [t] : [];
  }
  if (n === 4) {
    const B0 = v[1] - v[0],
      B1 = v[2] - v[1],
      B2 = v[3] - v[2];
    const a = B0 - 2 * B1 + B2,
      b = 2 * (B1 - B0),
      c = B0;
    const out = [];
    if (a === 0) {
      if (b !== 0) out.push(-c / b);
    } else {
      const disc = b * b - 4 * a * c;
      if (disc >= 0) {
        const q = Math.sqrt(disc);
        out.push((-b + q) / (2 * a), (-b - q) / (2 * a));
      }
    }
    return out.filter((t) => t > 0 && t < 1);
  }
  return [];
}

function bezierPoint(ctrl, t) {
  const n = ctrl.length - 1,
    u = 1 - t;
  if (n === 2)
    return [
      u * u * ctrl[0][0] + 2 * u * t * ctrl[1][0] + t * t * ctrl[2][0],
      u * u * ctrl[0][1] + 2 * u * t * ctrl[1][1] + t * t * ctrl[2][1],
    ];
  const b0 = u * u * u,
    b1 = 3 * u * u * t,
    b2 = 3 * u * t * t,
    b3 = t * t * t;
  return [
    b0 * ctrl[0][0] + b1 * ctrl[1][0] + b2 * ctrl[2][0] + b3 * ctrl[3][0],
    b0 * ctrl[0][1] + b1 * ctrl[1][1] + b2 * ctrl[2][1] + b3 * ctrl[3][1],
  ];
}
function bezierTangent(ctrl, t) {
  const n = ctrl.length - 1,
    u = 1 - t;
  if (n === 2)
    return [
      2 * (u * (ctrl[1][0] - ctrl[0][0]) + t * (ctrl[2][0] - ctrl[1][0])),
      2 * (u * (ctrl[1][1] - ctrl[0][1]) + t * (ctrl[2][1] - ctrl[1][1])),
    ];
  const d = [0, 1].map((k) => [0, 1, 2].map((i) => ctrl[i + 1][k] - ctrl[i][k]));
  const f = (a) => 3 * (u * u * a[0] + 2 * u * t * a[1] + t * t * a[2]);
  return [f(d[0]), f(d[1])];
}

/// The stroke bounding box [x0, y0, x1, y1] of `segs` (a shape's own segments), stroked with half width `o.halfW`, joins and caps
/// as in strokeInkPoints' options, in the space `M` ([a b c d e f], the usual column order) maps the segments to.
export function strokeBoxOf(segs, o, M) {
  const mapped = [];
  for (const s of segs) transformSegInto(s, M, mapped);
  const box = pathBbox(mapped);
  const h = o.halfW;
  if (!(h > 0) || !Number.isFinite(box[0])) return box;
  const [ma, mb, mc, md, me, mf] = M;
  const apply = (p) => [ma * p[0] + mc * p[1] + me, mb * p[0] + md * p[1] + mf];
  const grow = (q) => {
    if (!Number.isFinite(q[0] + q[1])) return;
    if (q[0] < box[0]) box[0] = q[0];
    if (q[0] > box[2]) box[2] = q[0];
    if (q[1] < box[1]) box[1] = q[1];
    if (q[1] > box[3]) box[3] = q[1];
  };
  const left = (d) => [-d[1], d[0]];
  const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
  // p +- h n for a local point and a (non-unit) tangent
  const both = (p, tan) => {
    const t = unit(tan);
    if (!t) return;
    const n = left(t);
    grow(apply([p[0] + h * n[0], p[1] + h * n[1]]));
    grow(apply([p[0] - h * n[0], p[1] - h * n[1]]));
  };
  // The mapped disc about local point p, restricted to the directions `inDir` accepts: its extremes along the carrier axes are
  // at u = +-(row of M)/|row|, taken when that direction (in local space) is in the sector.
  const rowX = [ma, mc],
    rowY = [mb, md];
  const disc = (p, inDir) => {
    const P = apply(p);
    for (const [row, ax] of [
      [rowX, 0],
      [rowY, 1],
    ]) {
      const len = Math.hypot(row[0], row[1]);
      if (!(len > 0)) continue;
      const u = [row[0] / len, row[1] / len];
      if (inDir(u)) {
        const q = P.slice();
        q[ax] += h * len;
        grow(q);
      }
      const w = [-u[0], -u[1]];
      if (inDir(w)) {
        const q = P.slice();
        q[ax] -= h * len;
        grow(q);
      }
    }
  };
  const inHalf = (t) => (u) => u[0] * t[0] + u[1] * t[1] >= 0;
  const inSector = (a, b) => {
    const c = cross(a, b);
    if (c === 0) return inHalf(a);
    return (u) => cross(a, u) * c >= 0 && cross(u, b) * c >= 0;
  };
  const round = (s) => s === 1;
  const subs = subpathsOf(segs);
  for (const sp of subs) {
    const ss = sp.segs;
    // the offset curves of every segment
    for (const s of ss) {
      const p0 = segStart(s),
        p1 = segEnd(s);
      both(p0, segTangent(s, false));
      both(p1, segTangent(s, true));
      if (s.type === SEG_QUAD || s.type === SEG_CUBIC) {
        const ctrl = s.type === SEG_QUAD ? [s.p1, s.p2, s.p3] : [s.p1, s.p2, s.p3, s.p4];
        for (const [row] of [[rowX], [rowY]]) {
          const v = ctrl.map((p) => row[0] * p[0] + row[1] * p[1]);
          for (const t of derivRoots(v)) both(bezierPoint(ctrl, t), bezierTangent(ctrl, t));
        }
      } else if (s.type === SEG_ARC) {
        const cp = Math.cos(s.phi || 0),
          sp2 = Math.sin(s.phi || 0),
          rx = s.rx,
          ry = s.ry;
        // carrier position = A + B (cos th, sin th), B = Mlin R diag(rx, ry); the axis tangents are at tan th = B[row][1] / B[row][0]
        const Bc = [
          [ma * cp * rx + mc * sp2 * rx, -ma * sp2 * ry + mc * cp * ry],
          [mb * cp * rx + md * sp2 * rx, -mb * sp2 * ry + md * cp * ry],
        ];
        const lo = Math.min(s.theta_start, s.theta_end),
          hi = Math.max(s.theta_start, s.theta_end);
        for (const r of Bc) {
          if (r[0] === 0 && r[1] === 0) continue;
          const th0 = Math.atan2(r[1], r[0]);
          for (const base of [th0, th0 + Math.PI]) {
            let th = base;
            while (th < lo) th += 2 * Math.PI;
            while (th > hi) th -= 2 * Math.PI;
            if (th < lo || th > hi) continue;
            const ct = Math.cos(th),
              st = Math.sin(th);
            const pt = [s.cx + cp * rx * ct - sp2 * ry * st, s.cy + sp2 * rx * ct + cp * ry * st];
            const tan = [-rx * st * cp - ry * ct * sp2, -rx * st * sp2 + ry * ct * cp];
            both(pt, tan);
          }
        }
      }
    }
    // caps
    if (!sp.closed) {
      const ends = [
        [segStart(ss[0]), segTangent(ss[0], false), -1, o.capStyle],
        [
          segEnd(ss[ss.length - 1]),
          segTangent(ss[ss.length - 1], true),
          1,
          o.endCapStyle ?? o.capStyle,
        ],
      ];
      for (const [p, tan, sgn, cap] of ends) {
        const t = unit(tan);
        if (!t) {
          if (round(cap)) disc(p, () => true);
          continue;
        }
        const out = [t[0] * sgn, t[1] * sgn];
        if (round(cap)) disc(p, inHalf(out));
      }
    }
    // joins at sharp vertices
    if (round(o.joinStyle)) {
      const verts = [];
      for (let i = 1; i < ss.length; i++)
        verts.push([segStart(ss[i]), segTangent(ss[i - 1], true), segTangent(ss[i], false)]);
      if (sp.closed)
        verts.push([
          segStart(ss[0]),
          segTangent(ss[ss.length - 1], true),
          segTangent(ss[0], false),
        ]);
      for (const [p, ti, to] of verts) {
        const d1 = unit(ti),
          d2 = unit(to);
        if (!d1 || !d2) continue;
        const c = cross(d1, d2),
          dot = d1[0] * d2[0] + d1[1] * d2[1];
        if (c === 0 && dot > 0) continue;
        if (c === 0) {
          disc(p, inHalf(d1));
          continue;
        }
        const Rn = (d) => [d[1], -d[0]],
          Ln = (d) => [-d[1], d[0]];
        disc(p, c > 0 ? inSector(Rn(d1), Rn(d2)) : inSector(Ln(d1), Ln(d2)));
      }
    }
  }
  // miter / miter-clip tips and square-cap corners
  const pts = strokeInkPoints(segs, {
    halfW: h,
    joinStyle: o.joinStyle,
    miterLimit: o.miterLimit,
    capStyle: o.capStyle,
    endCapStyle: o.endCapStyle ?? o.capStyle,
    dashed: false,
    N: null,
  });
  for (let i = 0; i + 1 < pts.length; i += 2) grow(apply([pts[i], pts[i + 1]]));
  return box;
}
