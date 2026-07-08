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
  SEG_LINE, SEG_QUAD, SEG_CUBIC, SEG_ARC,
  mkLine, mkQuad, mkCubic, mkArc,
  arcToCubics,
} from './segment.js';

export const IDENT = [1, 0, 0, 1, 0, 0];

export function matMul(m1, m2) {
  const [a1,b1,c1,d1,e1,f1] = m1;
  const [a2,b2,c2,d2,e2,f2] = m2;
  return [
    a1*a2 + c1*b2,
    b1*a2 + d1*b2,
    a1*c2 + c1*d2,
    b1*c2 + d1*d2,
    a1*e2 + c1*f2 + e1,
    b1*e2 + d1*f2 + f1,
  ];
}

export function matApply(m, x, y) {
  return [m[0]*x + m[2]*y + m[4], m[1]*x + m[3]*y + m[5]];
}

/// Parse an SVG `transform="..."` attribute. Returns the composed
/// matrix, IDENT for empty. Recognises translate / scale / rotate
/// (with optional center) / skewX / skewY / matrix.
export function parseTransform(s) {
  if (!s) return IDENT;
  let m = IDENT;
  const re = /(translate|scale|rotate|skewX|skewY|matrix)\s*\(([^)]*)\)/g;
  let mt;
  while ((mt = re.exec(s)) !== null) {
    const name = mt[1];
    const args = mt[2].split(/[,\s]+/).filter(t => t).map(parseFloat);
    if (name === 'translate') {
      const tx = args[0], ty = args.length > 1 ? args[1] : 0;
      m = matMul(m, [1, 0, 0, 1, tx, ty]);
    } else if (name === 'scale') {
      const sx = args[0], sy = args.length > 1 ? args[1] : args[0];
      m = matMul(m, [sx, 0, 0, sy, 0, 0]);
    } else if (name === 'rotate') {
      const a = args[0] * Math.PI / 180;
      const ca = Math.cos(a), sa = Math.sin(a);
      let r = [ca, sa, -sa, ca, 0, 0];
      if (args.length > 1) {
        const cx = args[1], cy = args[2] || 0;
        r = matMul([1,0,0,1,cx,cy], matMul(r, [1,0,0,1,-cx,-cy]));
      }
      m = matMul(m, r);
    } else if (name === 'skewX') {
      m = matMul(m, [1, 0, Math.tan(args[0]*Math.PI/180), 1, 0, 0]);
    } else if (name === 'skewY') {
      m = matMul(m, [1, Math.tan(args[0]*Math.PI/180), 0, 1, 0, 0]);
    } else if (name === 'matrix') {
      m = matMul(m, [args[0], args[1], args[2], args[3], args[4], args[5]]);
    }
  }
  return m;
}

/// Append a transformed copy of `seg` to `out`. Identity matrices
/// pass the segment through unchanged (no allocation). Arcs use
/// native-arc reparameterisation when the matrix is non-singular,
/// fall back to cubic approximation for degenerate matrices.
export function transformSegInto(seg, m, out) {
  if (m === IDENT || (m[0]===1 && m[1]===0 && m[2]===0 && m[3]===1 && m[4]===0 && m[5]===0)) {
    out.push(seg);
    return;
  }
  if (seg.type === SEG_LINE) {
    out.push(mkLine(matApply(m, seg.p1[0], seg.p1[1]), matApply(m, seg.p2[0], seg.p2[1]), seg.is_fill_only));
    return;
  }
  if (seg.type === SEG_QUAD) {
    out.push(mkQuad(
      matApply(m, seg.p1[0], seg.p1[1]),
      matApply(m, seg.p2[0], seg.p2[1]),
      matApply(m, seg.p3[0], seg.p3[1]),
    ));
    return;
  }
  if (seg.type === SEG_CUBIC) {
    out.push(mkCubic(
      matApply(m, seg.p1[0], seg.p1[1]),
      matApply(m, seg.p2[0], seg.p2[1]),
      matApply(m, seg.p3[0], seg.p3[1]),
      matApply(m, seg.p4[0], seg.p4[1]),
    ));
    return;
  }
  if (seg.type === SEG_ARC) {
    const det = m[0]*m[3] - m[1]*m[2];
    if (Math.abs(det) > 1e-12) {
      out.push(transformArcNative(seg, m));
      return;
    }
    // Degenerate matrix (det≈0): can't reparameterize the native arc;
    // substitute cubics that preserve the projected silhouette.
    const cubs = arcToCubics(seg.p1, seg.rx, seg.ry, seg.phi*180/Math.PI, seg.large_arc_flag, seg.sweep_flag, seg.p4);
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
  const det = a*d - b*c;
  const cx = a*seg.cx + c*seg.cy + m[4];
  const cy = b*seg.cx + d*seg.cy + m[5];
  const cp = Math.cos(seg.phi), sp = Math.sin(seg.phi);
  const irx2 = 1/(seg.rx*seg.rx), iry2 = 1/(seg.ry*seg.ry);
  const Q00 = cp*cp*irx2 + sp*sp*iry2;
  const Q11 = sp*sp*irx2 + cp*cp*iry2;
  const Q01 = sp*cp*(irx2 - iry2);
  const Ma =  d/det, Mb = -b/det, Mc = -c/det, Md = a/det;
  const T00 = Q00*Ma + Q01*Mb;
  const T01 = Q00*Mc + Q01*Md;
  const T10 = Q01*Ma + Q11*Mb;
  const T11 = Q01*Mc + Q11*Md;
  const Qp00 = Ma*T00 + Mb*T10;
  const Qp01 = Ma*T01 + Mb*T11;
  const Qp11 = Mc*T01 + Md*T11;
  const tr = Qp00 + Qp11;
  const dQ = Qp00*Qp11 - Qp01*Qp01;
  const disc = Math.max(0, tr*tr - 4*dQ);
  const sd = Math.sqrt(disc);
  const lamSmall = 0.5*(tr - sd);
  const lamLarge = 0.5*(tr + sd);
  let vSmall;
  if (Math.abs(Qp01) > 1e-18) vSmall = [Qp01, lamSmall - Qp00];
  else if (Qp00 <= Qp11)       vSmall = [1, 0];
  else                          vSmall = [0, 1];
  const vn = Math.hypot(vSmall[0], vSmall[1]) || 1;
  vSmall = [vSmall[0]/vn, vSmall[1]/vn];
  const rxNew = 1/Math.sqrt(Math.max(lamSmall, 1e-30));
  const ryNew = 1/Math.sqrt(Math.max(lamLarge, 1e-30));
  const phiNew = Math.atan2(vSmall[1], vSmall[0]);
  const angleOnNew = (px, py) => {
    const dx = px - cx, dy = py - cy;
    const cp2 = Math.cos(phiNew), sp2 = Math.sin(phiNew);
    const rxp =  cp2*dx + sp2*dy;
    const ryp = -sp2*dx + cp2*dy;
    return Math.atan2(ryp/ryNew, rxp/rxNew);
  };
  // Inline matApply — p0/p1 are throwaway here, no need to allocate
  // the 2-array result.
  const p0x = m[0]*seg.p1[0] + m[2]*seg.p1[1] + m[4];
  const p0y = m[1]*seg.p1[0] + m[3]*seg.p1[1] + m[5];
  const p1x = m[0]*seg.p4[0] + m[2]*seg.p4[1] + m[4];
  const p1y = m[1]*seg.p4[0] + m[3]*seg.p4[1] + m[5];
  const tsNew = angleOnNew(p0x, p0y);
  let teNew = angleOnNew(p1x, p1y);
  const origSweep = seg.theta_end - seg.theta_start;
  const reflect = det < 0;
  const wantPos = (origSweep > 0) !== reflect;
  const TWO = 2*Math.PI;
  let delta = teNew - tsNew;
  if (delta >  TWO) delta -= TWO*Math.floor(delta/TWO);
  if (delta < -TWO) delta += TWO*Math.floor(-delta/TWO);
  if (wantPos && delta < 0) delta += TWO;
  else if (!wantPos && delta > 0) delta -= TWO;
  if (Math.abs(Math.abs(origSweep) - TWO) < 1e-6) delta = wantPos ? TWO : -TWO;
  teNew = tsNew + delta;
  return mkArc(cx, cy, rxNew, ryNew, tsNew, teNew, phiNew,
               Math.abs(delta) > Math.PI ? 1 : 0,
               delta > 0 ? 1 : 0);
}
