// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeFrame.js — the STROKE SPACE of a stroke drawn under a transform that is not conformal.

// Such a row is evaluated in STROKE SPACE instead: the element's local space scaled uniformly by sMax, the CTM's
// larger singular value. The segments stay in DOCUMENT space in the curve plane (every fill, band, cull and cover
// quad reads them there), and the walker maps each one, relative to the fragment, through
//
//   N = sMax * M^-1 (M the CTM's linear part; column-major (n00, n10, n01, n11) in meta texel 5)
//
// Bezier control points map exactly under a linear map; an elliptical arc maps to another ellipse (strokeFrameArc).
// In stroke space the row is an ordinary stroke of the LOCAL path: its width, dashes, caps, joins and miter limits are
// the authored ones, all scaled by sMax, and so is every per-segment quantity the encoder writes in stroke terms
// (startDist, the arcs join's curvatures). The join tangents stay in document space with the geometry; the walker
// maps them too, which keeps a morph's rebuilt tangents meaningful.
//
// WHY sMax. N's singular values are sMax / sMax = 1 and sMax / sMin >= 1, so N never shrinks a vector: a distance in
// document space is at most the stroke-space one. The row's stroke width, sMax * w, is therefore at the same time the
// stroke-space width the walker uses AND a bound on the document-space width in every direction -- which is what
// every consumer that pads a box by META_STROKE_W (band membership, cover quads, bundle/strokeReach.js, the view,
// occlusion and hit-test culls, filter regions) needs, so none of them changes.
//
// A CONFORMAL CTM (within float32's resolution of the stored data, a relative test) has no frame and draws exactly as
// before. A singular transform has no stroke area and is suppressed by the importer.

/// Relative anisotropy below which a CTM is conformal: under 2^-24 of the larger singular value the two treatments
/// differ by less than float32 resolves in the stroke width.
const CONFORMAL_REL = 2 ** -24;

/// Is the CTM [a, b, c, d, e, f] CONFORMAL -- a rotation and a uniform scale, reflected or not -- to float32's resolution
/// (the same relative test strokeFrameOf takes)? What it maps a circle to is a circle.
export function ctmConformal(ctm) {
  if (!ctm) return true;
  const a = ctm[0],
    b = ctm[1],
    c = ctm[2],
    d = ctm[3];
  const Q = Math.hypot(0.5 * (a + d), 0.5 * (b - c)),
    R = Math.hypot(0.5 * (a - d), 0.5 * (b + c));
  return Math.min(Q, R) <= CONFORMAL_REL * (Q + R);
}

/** Whether the affine linear part has no inverse. No condition-number cutoff. */
export function ctmSingular(ctm) {
  if (!ctm) return false;
  const scale = Math.max(...ctm.slice(0, 4).map(Math.abs));
  if (scale === 0) return true;
  const a = ctm[0] / scale,
    b = ctm[1] / scale,
    c = ctm[2] / scale,
    d = ctm[3] / scale;
  return a * d - b * c === 0;
}

/// The stroke frame of a CTM [a, b, c, d, e, f] (x' = a x + c y + e, y' = b x + d y + f), or null when the CTM is
/// conformal or singular. { N: [n00, n10, n01, n11] column-major, sMax, sMin } with N = sMax * M^-1.
export function strokeFrameOf(ctm) {
  if (!ctm) return null;
  const scale = Math.max(...ctm.slice(0, 4).map(Math.abs));
  if (!(scale > 0) || !Number.isFinite(scale)) return null;
  const a = ctm[0] / scale,
    b = ctm[1] / scale,
    c = ctm[2] / scale,
    d = ctm[3] / scale;
  // M = R(phi) diag(Q + R, Q - R) R(theta): Q is the conformal part's scale, R the anisotropic part's.
  const Q = Math.hypot(0.5 * (a + d), 0.5 * (b - c));
  const R = Math.hypot(0.5 * (a - d), 0.5 * (b + c));
  const major = Q + R;
  if (Math.min(Q, R) <= CONFORMAL_REL * major) return null;
  const det = a * d - b * c;
  if (det === 0) return null;
  const minor = Math.abs(det) / major;
  const k = major / det;
  const N = [d * k, -b * k, -c * k, a * k],
    packed = N.map(Math.fround);
  // A finite double inverse can lose an axis or overflow in the GPU metadata.
  const representable =
    packed.every(Number.isFinite) &&
    packed[0] * packed[3] - packed[1] * packed[2] !== 0 &&
    Number.isFinite(Math.fround(major * scale));
  return { N, sMax: major * scale, sMin: minor * scale, representable };
}

/** N * (x, y). */
export function strokeFrameApply(N, x, y) {
  return [N[0] * x + N[2] * y, N[1] * x + N[3] * y];
}

/// An elliptical arc under N: center (cx, cy), radii (rx, ry), rotation phi, parameter range [th0, th1] -> the same
/// four in stroke space, with the parameter carried pointwise (the arc at th maps to the image's arc at th' ), so the
/// fraction of the sweep is the same on both. The shader's twin is _coverage.glsl strokeFrameArc.
///
/// A = N R(phi) diag(rx, ry) = R(phi') diag(sx, sy) R(theta) (the closed-form 2x2 SVD), so the image is
/// center' + R(phi') diag(sx, sy) u(th + theta), u(t) = (cos t, sin t). A NEGATIVE sy (N reflects) is the same ellipse
/// traversed the other way: diag(sx, sy) u(t) = diag(sx, -sy) u(-t).
export function strokeFrameArc(N, cx, cy, rx, ry, phi, th0, th1) {
  const cp = Math.cos(phi),
    sp = Math.sin(phi);
  // A's columns: N (cp rx, sp rx) and N (-sp ry, cp ry)
  const a00 = (N[0] * cp + N[2] * sp) * rx,
    a10 = (N[1] * cp + N[3] * sp) * rx;
  const a01 = (-N[0] * sp + N[2] * cp) * ry,
    a11 = (-N[1] * sp + N[3] * cp) * ry;
  const E = 0.5 * (a00 + a11),
    F = 0.5 * (a00 - a11),
    G = 0.5 * (a10 + a01),
    H = 0.5 * (a10 - a01);
  const Q = Math.hypot(E, H),
    R = Math.hypot(F, G);
  // A circle's image keeps its rounding-level anisotropy (both walkers take near-circles exactly); a term that is
  // exactly zero has a free angle and takes 0, as the shader does.
  const a1 = R > 0 ? Math.atan2(G, F) : 0,
    a2 = Q > 0 ? Math.atan2(H, E) : 0;
  const theta = 0.5 * (a2 - a1),
    phiN = 0.5 * (a2 + a1);
  const sy = Q - R,
    flip = sy < 0;
  const [ccx, ccy] = strokeFrameApply(N, cx, cy);
  return {
    cx: ccx,
    cy: ccy,
    rx: Q + R,
    ry: Math.abs(sy),
    phi: phiN,
    th0: flip ? -(th0 + theta) : th0 + theta,
    th1: flip ? -(th1 + theta) : th1 + theta,
  };
}
