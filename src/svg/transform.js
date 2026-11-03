// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// svg/transform.js — 2×3 affine math + SVG transform-attr parser
// + segment-aware transformation.
//
// Affine matrices are stored as 6-element arrays [a, b, c, d, e, f]
// representing
//   [ a  c  e ]
//   [ b  d  f ]
//   [ 0  0  1 ]
// Same convention SVG / CSS / Postscript use.

import {
  SEG_LINE,
  SEG_QUAD,
  SEG_CUBIC,
  SEG_ARC,
  mkLine,
  mkQuad,
  mkCubic,
  mkArc,
  arcToCubics,
} from './segment.js';

export const IDENT = [1, 0, 0, 1, 0, 0];

export function matMul(m1, m2) {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

export function matApply(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/// A preserveAspectRatio value read: `none`, the alignment on each axis (0 = Min, 1 = Mid, 2 = Max; Mid when the value names
/// none) and meet (else slice).
export function parseAspect(parAttr) {
  const pParts = String(parAttr || 'xMidYMid meet')
    .trim()
    .toLowerCase()
    .split(/\s+/);
  const align = pParts[0] || '';
  let alignX = 1,
    alignY = 1;
  const none = align === 'none';
  if (!none) {
    const yIdx = align.indexOf('y');
    if (yIdx > 0 && yIdx + 4 <= align.length) {
      const xPart = align.substring(1, yIdx),
        yPart = align.substring(yIdx + 1);
      alignX = xPart === 'min' ? 0 : xPart === 'max' ? 2 : 1;
      alignY = yPart === 'min' ? 0 : yPart === 'max' ? 2 : 1;
    }
  }
  return { none, alignX, alignY, meet: !(pParts[1] && pParts[1] === 'slice') };
}

/// The matrix that fits a viewBox (vbX, vbY, vbW, vbH) into the rect (x, y, w, h) under a preserveAspectRatio value
/// (SVG 2 §8.2): `none` scales each axis independently; otherwise one scale, the smaller for `meet` and the larger for
/// `slice`, aligned by xMin/xMid/xMax and yMin/yMid/yMax in the rect. One implementation for every element that fits a
/// viewBox (a nested SVG drawn by <image>, a <pattern>), so they cannot drift apart.
export function viewBoxFit(vbX, vbY, vbW, vbH, parAttr, x, y, w, h) {
  const { none, alignX, alignY, meet } = parseAspect(parAttr);
  let sx = w / vbW,
    sy = h / vbH,
    tx = 0,
    ty = 0;
  if (!none) {
    const s = meet ? Math.min(sx, sy) : Math.max(sx, sy);
    sx = s;
    sy = s;
    const slackX = w - vbW * sx,
      slackY = h - vbH * sy;
    tx = alignX === 0 ? 0 : alignX === 2 ? slackX : slackX * 0.5;
    ty = alignY === 0 ? 0 : alignY === 2 ? slackY : slackY * 0.5;
  }
  return [sx, 0, 0, sy, x + tx - sx * vbX, y + ty - sy * vbY];
}

/// Whether an element's viewBox has a width or height of zero, which disables the rendering of the element (SVG 2 8.6). A negative one is an
/// error and is no viewBox at all, as is anything that does not read as four numbers.
export function viewBoxDisablesRendering(el) {
  const text = (el.getAttribute('viewBox') || '').trim();
  if (!text) return false;
  const p = text.split(/[\s,]+/).map(Number);
  return (
    p.length === 4 &&
    p.every(Number.isFinite) &&
    p[2] >= 0 &&
    p[3] >= 0 &&
    (p[2] === 0 || p[3] === 0)
  );
}

const TRANSFORM_FUNCTIONS = {
  translate: { min: 1, max: 2, unit: 'length' },
  scale: { min: 1, max: 2, unit: 'none' },
  rotate: { min: 1, max: 3, unit: 'angle', only: [1, 3] },
  skewX: { min: 1, max: 1, unit: 'angle' },
  skewY: { min: 1, max: 1, unit: 'angle' },
  matrix: { min: 6, max: 6, unit: 'length' },
};
const ANGLE_TO_DEGREES = { deg: 1, grad: 0.9, rad: 180 / Math.PI, turn: 360 };

/// Parse an SVG `transform="..."` attribute. Returns the composed matrix, IDENT for empty. Recognizes translate /
/// scale / rotate (with optional center) / skewX / skewY / matrix.
///
/// The whole list is one value (SVG 2 §8.5, CSS Transforms 1 §6): an error ANYWHERE in it -- an unknown or
/// misspelled function, a wrong number of arguments, a number that is not finite, a stray token, a bad separator --
/// makes the attribute invalid and it is ignored, so the element is untransformed. (Applying the part before the
/// error moved an element by a transform its author did not write.) Arguments are numbers; the CSS forms with a unit
/// are accepted where the unit means something here: `px` on a length argument, deg / grad / rad / turn on an angle.
export function parseTransform(s) {
  if (!s) return IDENT;
  const text = String(s);
  const number = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
  const word = /[A-Za-z]+/y;
  let m = IDENT;
  let i = 0;
  const skipSpace = () => {
    while (i < text.length && /\s/.test(text[i])) i++;
  };
  skipSpace();
  while (i < text.length) {
    word.lastIndex = i;
    const w = word.exec(text);
    if (!w) return IDENT;
    const name = w[0],
      spec = Object.hasOwn(TRANSFORM_FUNCTIONS, name) ? TRANSFORM_FUNCTIONS[name] : null;
    if (!spec) return IDENT;
    i += name.length;
    skipSpace();
    if (text[i] !== '(') return IDENT;
    i++;
    const args = [];
    skipSpace();
    while (i < text.length && text[i] !== ')') {
      number.lastIndex = i;
      const n = number.exec(text);
      if (!n) return IDENT;
      i += n[0].length;
      let v = parseFloat(n[0]);
      const unit = /[A-Za-z]*/y;
      unit.lastIndex = i;
      const u = unit.exec(text)[0].toLowerCase();
      i += u.length;
      if (u) {
        if (spec.unit === 'angle' && Object.hasOwn(ANGLE_TO_DEGREES, u)) v *= ANGLE_TO_DEGREES[u];
        else if (!(spec.unit === 'length' && u === 'px')) return IDENT;
      }
      if (!Number.isFinite(v)) return IDENT;
      args.push(v);
      skipSpace();
      if (text[i] === ',') {
        i++;
        skipSpace();
      } // one comma may follow a number, `translate(10,)` included
    }
    if (text[i] !== ')') return IDENT;
    i++;
    if (
      args.length < spec.min ||
      args.length > spec.max ||
      (spec.only && !spec.only.includes(args.length))
    )
      return IDENT;
    skipSpace();
    if (text[i] === ',') {
      i++;
      skipSpace();
      if (i >= text.length) return IDENT;
    }
    if (name === 'translate') {
      m = matMul(m, [1, 0, 0, 1, args[0], args.length > 1 ? args[1] : 0]);
    } else if (name === 'scale') {
      m = matMul(m, [args[0], 0, 0, args.length > 1 ? args[1] : args[0], 0, 0]);
    } else if (name === 'rotate') {
      const a = (args[0] * Math.PI) / 180;
      const ca = Math.cos(a),
        sa = Math.sin(a);
      let r = [ca, sa, -sa, ca, 0, 0];
      if (args.length === 3) {
        const cx = args[1],
          cy = args[2];
        r = matMul([1, 0, 0, 1, cx, cy], matMul(r, [1, 0, 0, 1, -cx, -cy]));
      }
      m = matMul(m, r);
    } else if (name === 'skewX') {
      m = matMul(m, [1, 0, Math.tan((args[0] * Math.PI) / 180), 1, 0, 0]);
    } else if (name === 'skewY') {
      m = matMul(m, [1, Math.tan((args[0] * Math.PI) / 180), 0, 1, 0, 0]);
    } else {
      m = matMul(m, [args[0], args[1], args[2], args[3], args[4], args[5]]);
    }
  }
  return m;
}

/// Append a transformed copy of `seg` to `out`. Identity matrices
/// pass the segment through unchanged (no allocation). Arcs use
/// native-arc reparameterization when the matrix is non-singular,
/// fall back to cubic approximation for degenerate matrices.
export function transformSegInto(seg, m, out) {
  const at = out.length;
  transformSegIntoRaw(seg, m, out);
  // A transform must not move where a SUBPATH BEGINS. Every branch below either
  // allocates fresh segs or fans one arc out into cubics; only the identity fast
  // path passes the original through. So restamp the marker on whatever came out
  // first — the same rule cubicCusp.js applies when it splits a segment. Dropped,
  // it leaves the subpath structure recoverable only from geometry, and two
  // subpaths that touch are then indistinguishable from one.
  if (seg.subStart && out.length > at) out[at].subStart = true;
  // and where an OPEN subpath ENDS (path.js openEnd): the last piece carries it
  if (seg.openEnd && out.length > at) out[out.length - 1].openEnd = true;
}

function transformSegIntoRaw(seg, m, out) {
  if (
    m === IDENT ||
    (m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0)
  ) {
    out.push(seg);
    return;
  }
  if (seg.type === SEG_LINE) {
    out.push(
      mkLine(
        matApply(m, seg.p1[0], seg.p1[1]),
        matApply(m, seg.p2[0], seg.p2[1]),
        seg.is_fill_only,
      ),
    );
    return;
  }
  if (seg.type === SEG_QUAD) {
    out.push(
      mkQuad(
        matApply(m, seg.p1[0], seg.p1[1]),
        matApply(m, seg.p2[0], seg.p2[1]),
        matApply(m, seg.p3[0], seg.p3[1]),
      ),
    );
    return;
  }
  if (seg.type === SEG_CUBIC) {
    out.push(
      mkCubic(
        matApply(m, seg.p1[0], seg.p1[1]),
        matApply(m, seg.p2[0], seg.p2[1]),
        matApply(m, seg.p3[0], seg.p3[1]),
        matApply(m, seg.p4[0], seg.p4[1]),
      ),
    );
    return;
  }
  if (seg.type === SEG_ARC) {
    const det = m[0] * m[3] - m[1] * m[2];

    if (
      seg.rx === 0 ||
      seg.ry === 0 ||
      Math.abs(det) > 1e-12 * (Math.abs(m[0] * m[3]) + Math.abs(m[1] * m[2]))
    ) {
      out.push(transformArcNative(seg, m));
      return;
    }
    // Degenerate matrix (det≈0): can't reparameterize the native arc;
    // substitute cubics that preserve the projected silhouette.
    const cubs = arcToCubics(
      seg.p1,
      seg.rx,
      seg.ry,
      (seg.phi * 180) / Math.PI,
      seg.large_arc_flag,
      seg.sweep_flag,
      seg.p4,
    );
    for (const c of cubs) transformSegInto(c, m, out);
    return;
  }
  out.push(seg);
}

/// Transform a native SVG_ARC. Eigendecompose the conic matrix
/// Q' = M⁻ᵀ Q M⁻¹ to get the new (rx', ry', phi'); reparameterize
/// angles around the new ellipse so the start/end points map
/// exactly. Preserves large_arc / sweep flags accounting for
/// reflection (det < 0).
export function transformArcNative(seg, m) {
  const [a, b, c, d] = m;
  const det = a * d - b * c;
  const cx = a * seg.cx + c * seg.cy + m[4];
  const cy = b * seg.cx + d * seg.cy + m[5];
  const cp = Math.cos(seg.phi),
    sp = Math.sin(seg.phi);
  // A ZERO RADIUS (SVG's zero-radius arc, which arcEndpointToCenter keeps as its chord: a half-turn of a degenerate
  // ellipse). The conic below is 1 / r^2, so it would come out Infinity and NaN, and drop the segment from the fill and
  // the stroke under ANY transform, a translate included. The ellipse is a segment along its other axis,
  // c + cos(th) (rx along phi) or c + sin(th) (ry along phi + pi/2); m's image of it is the segment along that axis's
  // image, at the same angles. Both radii zero, it is its center.
  if (seg.rx === 0 || seg.ry === 0) {
    const ex =
      seg.rx !== 0 ? [a * cp + c * sp, b * cp + d * sp] : [-a * sp + c * cp, -b * sp + d * cp]; // the axis through m
    const r = (seg.rx !== 0 ? seg.rx : seg.ry) * Math.hypot(ex[0], ex[1]);
    const phiN =
      r === 0 ? seg.phi : seg.rx !== 0 ? Math.atan2(ex[1], ex[0]) : Math.atan2(-ex[0], ex[1]);
    return mkArc(
      cx,
      cy,
      seg.rx !== 0 ? r : 0,
      seg.rx !== 0 ? 0 : r,
      seg.theta_start,
      seg.theta_end,
      phiN,
      seg.large_arc_flag,
      seg.sweep_flag,
      [a * seg.p1[0] + c * seg.p1[1] + m[4], b * seg.p1[0] + d * seg.p1[1] + m[5]],
      [a * seg.p4[0] + c * seg.p4[1] + m[4], b * seg.p4[0] + d * seg.p4[1] + m[5]],
    );
  }
  const irx2 = 1 / (seg.rx * seg.rx),
    iry2 = 1 / (seg.ry * seg.ry);
  const Q00 = cp * cp * irx2 + sp * sp * iry2;
  const Q11 = sp * sp * irx2 + cp * cp * iry2;
  const Q01 = sp * cp * (irx2 - iry2);
  const Ma = d / det,
    Mb = -b / det,
    Mc = -c / det,
    Md = a / det;
  const T00 = Q00 * Ma + Q01 * Mb;
  const T01 = Q00 * Mc + Q01 * Md;
  const T10 = Q01 * Ma + Q11 * Mb;
  const T11 = Q01 * Mc + Q11 * Md;
  const Qp00 = Ma * T00 + Mb * T10;
  const Qp01 = Ma * T01 + Mb * T11;
  const Qp11 = Mc * T01 + Md * T11;
  const tr = Qp00 + Qp11;
  const dQ = Qp00 * Qp11 - Qp01 * Qp01;
  const hd = 0.5 * (Qp00 - Qp11);
  const disc = Math.max(0, tr * tr - 4 * dQ);
  // sd = lamLarge - lamSmall. tr^2 - 4 dQ is (Qp00 - Qp11)^2 + 4 Qp01^2 reached through a cancellation: once it is
  // under a thousandth of tr^2 it has lost three digits, and near a circle all of them (sd comes out sqrt(eps) of tr:
  // radii 10 and 10.0000001 under rotate(30) would come out 9.999999992 and 10.000000108). The difference form has none.
  const sd = disc < 1e-3 * tr * tr ? 2 * Math.hypot(hd, Qp01) : Math.sqrt(disc);
  const lamSmall = 0.5 * (tr - sd);
  const lamLarge = 0.5 * (tr + sd);

  let vSmall;
  if (Math.abs(Qp01) > Number.EPSILON * (Math.abs(Qp00) + Math.abs(Qp11))) {
    vSmall = [Qp01, lamSmall - Qp00];
    // lamSmall - Qp00 is -(hd + sd/2). Computed as a difference of the eigenvalue and the diagonal it cancels when the
    // small eigenvalue's axis lies near x (hd < 0), and near a circle whichever axis it is; the rounding left in it is
    // then as large as a small Qp01, and the axis would turn by up to a right angle. An ellipse 10 x 100 under
    // rotate(30) rotate(30) rotate(30) (a rotation residue of 2.8e-16) would come out tilted, 13.6 thick where it is 10.
    // Once the difference has lost three digits, take the eigenvector in the difference form, from the row that
    // does not cancel (-(hd + sd/2) for hd >= 0, else hd - sd/2 in the other slot), pointing the way the
    // classic vector does.
    if (Math.abs(vSmall[1]) < 1e-3 * Math.abs(Qp00)) {
      const h = 0.5 * sd;
      vSmall = hd >= 0 ? [Qp01, -(hd + h)] : Qp01 > 0 ? [h - hd, -Qp01] : [hd - h, Qp01];
    }
  } else if (Qp00 <= Qp11) vSmall = [1, 0];
  else vSmall = [0, 1];
  const vn = Math.hypot(vSmall[0], vSmall[1]) || 1;
  vSmall = [vSmall[0] / vn, vSmall[1] / vn];
  //
  // The transform carries the parameterization. Send the arc's own rx axis (cos phi, sin phi) through m's linear
  // part and keep the eigenvector it lands along, with its sign -- an exact comparison of |dot| against |dot with
  // the perpendicular|, no tolerance, and unchanged by a positive scale on m, so rebuild(arc, S*m) is
  // rebuild(arc, m) scaled for every S. At m = S*I it returns the arc's own phi and radii, which is what the
  // identity fast path leaves at scale 1.
  const rMaj = 1 / Math.sqrt(Math.max(lamSmall, Number.EPSILON * lamLarge, Number.MIN_VALUE)); // along vSmall
  const rMin = 1 / Math.sqrt(Math.max(lamLarge, Number.MIN_VALUE)); // across it
  const ax = a * cp + c * sp,
    ay = b * cp + d * sp; // the source rx axis, carried
  const dS = ax * vSmall[0] + ay * vSmall[1]; // along vSmall
  const dP = -ax * vSmall[1] + ay * vSmall[0]; // along its perpendicular
  let ux, uy, rxNew, ryNew;
  if (Math.abs(dS) >= Math.abs(dP)) {
    const sg = dS < 0 ? -1 : 1;
    ux = sg * vSmall[0];
    uy = sg * vSmall[1];
    rxNew = rMaj;
    ryNew = rMin;
  } else {
    const sg = dP < 0 ? -1 : 1;
    ux = -sg * vSmall[1];
    uy = sg * vSmall[0];
    rxNew = rMin;
    ryNew = rMaj;
  }
  // The rotation is a number a morph lerps (SVG 2, 9.3.2), and two poses at 350 and 10 are not 20 apart. atan2 folds it into a half turn either way, so keep
  // the turns the authored angle has: the nearest spelling of this axis to the angle m takes the authored rx axis to, which is the authored number at m = S*I.
  const phiAxis = Math.atan2(uy, ux);
  const phiNew =
    phiAxis +
    2 *
      Math.PI *
      Math.round((Math.atan2(b, a) + (det < 0 ? -seg.phi : seg.phi) - phiAxis) / (2 * Math.PI));
  const angleOnNew = (px, py) => {
    const dx = px - cx,
      dy = py - cy;
    const cp2 = Math.cos(phiNew),
      sp2 = Math.sin(phiNew);
    const rxp = cp2 * dx + sp2 * dy;
    const ryp = -sp2 * dx + cp2 * dy;
    return Math.atan2(ryp / ryNew, rxp / rxNew);
  };
  // THE ANGLES FROM THE CENTER FORM'S own ENDS, the ENDPOINTS FROM THE ARC'S. The new angles are read off the source
  // parameters' points: the rebuild is then exact under a scale (rebuild(arc, S*m) is
  // rebuild(arc, m) scaled), and an arc at 2^20 has scale 1's angles. The arc's endpoints are its path's vertices
  // through m, matApply's arithmetic -- the value the neighboring segments get -- and a hair from those.
  const cq = Math.cos(seg.phi),
    sq = Math.sin(seg.phi);
  const derived = (th) => [
    seg.cx + cq * seg.rx * Math.cos(th) - sq * seg.ry * Math.sin(th),
    seg.cy + sq * seg.rx * Math.cos(th) + cq * seg.ry * Math.sin(th),
  ];
  const d0 = derived(seg.theta_start),
    d1 = derived(seg.theta_end);
  const tsNew = angleOnNew(m[0] * d0[0] + m[2] * d0[1] + m[4], m[1] * d0[0] + m[3] * d0[1] + m[5]);
  let teNew = angleOnNew(m[0] * d1[0] + m[2] * d1[1] + m[4], m[1] * d1[0] + m[3] * d1[1] + m[5]);
  const p0x = m[0] * seg.p1[0] + m[2] * seg.p1[1] + m[4];
  const p0y = m[1] * seg.p1[0] + m[3] * seg.p1[1] + m[5];
  const p1x = m[0] * seg.p4[0] + m[2] * seg.p4[1] + m[4];
  const p1y = m[1] * seg.p4[0] + m[3] * seg.p4[1] + m[5];
  const origSweep = seg.theta_end - seg.theta_start;
  const reflect = det < 0;
  const wantPos = origSweep > 0 !== reflect;
  const TWO = 2 * Math.PI;
  let delta = teNew - tsNew;
  if (delta > TWO) delta -= TWO * Math.floor(delta / TWO);
  if (delta < -TWO) delta += TWO * Math.floor(-delta / TWO);
  if (wantPos && delta < 0) delta += TWO;
  else if (!wantPos && delta > 0) delta -= TWO;
  if (Math.abs(Math.abs(origSweep) - TWO) < 1e-6) delta = wantPos ? TWO : -TWO;
  teNew = tsNew + delta;
  // ...and THE same TURN THE ARC CAME IN ON. Adding one turn to both ends is the ellipse's last free choice, and
  // atan2 takes it at the branch cut, where the sign of a ZERO decides: a circle's leftmost point is atan2(+0, -1)
  // here and comes off the path parser as -pi, so every full circle in a drawing would come back theta +2pi the
  // moment it is wrapped in a scale. Snap to the turn nearest the arc's own start -- delta, and so the geometry, is
  // already fixed, and this only names the representative.
  const turn = TWO * Math.round((seg.theta_start - tsNew) / TWO);
  // ...and the arc's ENDPOINTS are its source ones through m, the arithmetic matApply gives the segments beside it, so a
  // shared vertex keeps one value.
  return mkArc(
    cx,
    cy,
    rxNew,
    ryNew,
    tsNew + turn,
    teNew + turn,
    phiNew,
    Math.abs(delta) > Math.PI ? 1 : 0,
    delta > 0 ? 1 : 0,
    [p0x, p0y],
    [p1x, p1y],
    seg.radiusScale || 1,
  ); // the authored-radius factor is a ratio: any map keeps it
}
