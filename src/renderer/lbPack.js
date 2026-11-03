// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbPack.js — the mesh's exit door: GPU vertex packing plus the
// similarity-invariant reuse machinery. packLoopBlinnMesh flattens an
// assembled raw mesh into the interleaved LB_VERT_FLOATS vertex stream the
// draw path uploads; lbCanonicalFrame/lbCanonicalHash key a contour set by
// its similarity orbit (centroid/RMS-scale/farthest-axis canonical form) and
// transformLoopBlinnRaw clones a cached raw mesh through a similarity so one
// build serves every translated/rotated/uniformly-scaled instance.
import { fatArc, LB_BAND_SHARP_TURN } from '../geom/lbContour.js';
import { klmnFrameRowsAt9, cubicSupport9, cubicChainLeftOf } from '../geom/lbCubicMath.js';
import { mantleDebugFlag, mantleDebugHook } from '../core/diagnostics.js';

export const LB_VERT_FLOATS = 24;

/** Hard per-shape vertex cap. Past this the packer flags `overBudget` and callers
 *  must Slug the shape — drawing a truncated buffer is what produces
 *  `GL_INVALID_OPERATION: Vertex buffer is not big enough for the draw call`. */
export const LB_MAX_VERTS_PER_MESH = 200000;

/** Soft whole-bundle vertex cap (sum of shape packs). Exceeded → whole-bundle Slug. */
export const LB_MAX_VERTS_PER_BUNDLE = 1000000;

/** Bytes one packed vertex occupies in the stream the draw path uploads. */
export const LB_VERT_BYTES = LB_VERT_FLOATS * 4;

/// THE PER-SHAPE LIMIT IS ON MEMORY, AND THE CALLER SETS IT.

let _shapeMemBudget = Infinity;
/** Set the per-shape packed-vertex budget in bytes. 0/null/undefined/non-finite ⇒ no limit. */
export function setLbShapeMemoryBudget(bytes) {
  const b = bytes === null || bytes === undefined ? Infinity : +bytes;
  _shapeMemBudget = b > 0 && b < Infinity ? b : Infinity;
}
/** The per-shape packed-vertex budget in bytes (`Infinity` when there is none). */
export function getLbShapeMemoryBudget() {
  return _shapeMemBudget;
}
/** Bytes a packed mesh of `vc` vertices occupies. Exact, not an estimate. */
export function lbVertexBytes(vc) {
  return (vc | 0) * LB_VERT_BYTES;
}

/// A lower bound on the bytes packLoopBlinnMesh will produce for this raw mesh.
///
/// The packer emits one vertex per interior xy pair, three per quad and one per cubic hull point,
/// and then ADDS rings, bands and strips on top -- so these three counts can only ever
/// under-estimate the total. A bound is what the builder needs: refusing on it can never turn away
/// a mesh that would have fitted, which keeps the budget's meaning ("this shape's stream is too
/// big") free of any guess about the packer's internals. Mirroring the packer's real count here
/// would be the guess, and it would drift the first time a tier is added.
export function lbRawMinVertexBytes(mesh) {
  if (!mesh) return 0;
  let vc = mesh.interior ? mesh.interior.length / 2 : 0;
  if (mesh.quads) vc += mesh.quads.length * 3;
  if (mesh.cubics) for (const c of mesh.cubics) vc += c && c.hull ? c.hull.length / 2 : 0;
  return lbVertexBytes(vc);
}

// Pack two f32 into one f32 via IEEE half (matches GLSL packHalf2x16). Used so
// CURVE_BAND can keep aTC=(Ũ,Ṽ,R) while both end curvatures still ride mixed aC2.
const _hBuf = new ArrayBuffer(4);
const _hF = new Float32Array(_hBuf);
const _hU = new Uint32Array(_hBuf);
function toHalfBits(val) {
  _hF[0] = val;
  const x = _hU[0];
  const s = (x >>> 16) & 0x8000;
  const e = ((x >>> 23) & 0xff) - 127;
  const m = x & 0x7fffff;
  if (e > 15) return s | 0x7c00;
  if (e > -15) return s | ((e + 15) << 10) | (m >>> 13);
  return s;
}
function packHalf2x16(a, b) {
  _hU[0] = (toHalfBits(b) << 16) | toHalfBits(a);
  return _hF[0];
}

/*
The cubic CURVE_BAND's klm GRADIENT PAIR (aC0.z) — a SHARED-EXPONENT pair, not two halves.
 *
 *
 *  What the kernel needs from this lane is 11 significant bits — the pair is multiplied by the
 *  1.5px ring push and added to klm, so its error reaches the edge as a fraction of a pixel, and
 *  half's 2^-11 is already far beyond what the ramp can show. What it needs is RANGE.
 *
 *    bit 31      sign of dk
 *    bits 30:23  the shared exponent E, IN THE FLOAT'S own EXPONENT FIELD
 *    bits 22:12  |dk| * 1024 / 2^(E-127), 0..2047
 *    bits 11:1   |dl| * 1024 / 2^(E-127), 0..2047
 *    bit 0       sign of dl
 *
 *  E is 2^floor(log2 max(|dk|, |dl|)) read straight off the float, so the LARGER component lands in
 *  [1024, 2047] and keeps an 11-bit significand — the same relative precision (<= 2^-11) half gave
 *  it — and both components' absolute error is bounded by 2^-11 of the pair's magnitude. The range
 *  becomes float32's own, 2^-126..2^127, which is the floor the rest of the builder already sits on.
 *
 *  Holding E in the float's exponent field is deliberate: a vertex attribute IS a float, and every
 *  pattern this writes is a normal float or a signed zero — never a denormal, an Inf or a NaN.
 *  packHalf2x16 could not promise that (dl == 0 with dk != 0 zeroes the top sixteen bits and makes
 *  the slot a denormal, which a driver may flush on load and take dk with it).
 *
 *  Cost: ZERO bytes — same lane, same stride, same attribute count. Widening the pair to two floats
 *  would have cost 8 bytes on every LB vertex, not only this kind.
 */
export function packKlmGrad(dk, dl) {
  const ak = Math.abs(dk),
    al = Math.abs(dl);
  _hF[0] = Math.fround(Math.max(ak, al));
  const E = _hU[0] & 0x7f800000;
  // E == 0 is a zero or denormal pair and E == 0x7f800000 an infinite or NaN one: both pack as a
  // plain zero, which decodes back to exactly (0, 0) and leaves the extruded vertex welded to its
  // hull. THE SIGN BITS GO TOO — bit 0 is a mantissa bit, so keeping dl's sign beside a zero
  // exponent would make the slot a denormal float, the one pattern this format exists to rule out.
  if (E === 0 || E === 0x7f800000) return 0;
  // DIVIDING by the exponent rather than multiplying by its reciprocal is what makes this total,
  // and is what the shader does: a/s is exact (s is a power of two) and below 2 by construction,
  // while 1024/s overflows float32 for s under 2^-116. The larger component is at least 1, so at
  // least one magnitude field is at least 1024.
  _hU[0] = E;
  const s = _hF[0];
  const mk = Math.min(Math.floor((ak / s) * 1024 + 0.5), 2047);
  const ml = Math.min(Math.floor((al / s) * 1024 + 0.5), 2047);
  _hU[0] = ((dk < 0 ? 0x80000000 : 0) | E | (mk << 12) | (ml << 1) | (dl < 0 ? 1 : 0)) >>> 0;
  return _hF[0];
}

/** packKlmGrad's inverse, for the mesh census and the guards. Mirrors `lbUnpackKlmGrad`. */
export function unpackKlmGrad(f) {
  _hF[0] = f;
  const u = _hU[0];
  _hU[0] = u & 0x7f800000;
  const s = _hF[0] / 1024;
  const dk = ((u >>> 12) & 0x7ff) * s,
    dl = ((u >>> 1) & 0x7ff) * s;
  return [u & 0x80000000 ? -dk : dk, u & 1 ? -dl : dl];
}

/*

 */
function band12Chainable(e) {
  return (
    !mantleDebugFlag('lbBand2NoChain') &&
    e.curve &&
    e.qn &&
    Math.abs(e.turn !== undefined ? e.turn : 1) > 0.02
  );
}

/** κ for a chained end: full sample at sharp turns, 0 at shallow. */
function band12EndKappa(e) {
  if (!e || !band12Chainable(e)) return 0;
  return Math.abs(e.turn) >= LB_BAND_SHARP_TURN ? e.k : 0;
}

/** Pack CURVE_BAND end slots (aC1/aC2/aC3) shared by quad bands and cubic rings. */
function writeBand12Ends(v, o, e1, e2, nOwnPackA, nOwnPackB, kA, kB, ax, ay, bx, by) {
  v[o + 11] = e1.nN[0];
  v[o + 12] = e1.nN[1];
  v[o + 13] = e2.nN[0];
  v[o + 14] = e2.nN[1];
  v[o + 15] = nOwnPackA;
  v[o + 16] = nOwnPackB;
  v[o + 17] = kA;
  v[o + 18] = kB;
  v[o + 19] = ax;
  v[o + 20] = ay;
  v[o + 21] = bx;
  v[o + 22] = by;
}

function clearBand12Ends(v, o) {
  for (let i = 11; i <= 22; i++) v[o + i] = 0;
}

function band12EndCodes(e1, e2) {
  const tyA = band12Chainable(e1) ? e1.type : 0;
  const tyB = band12Chainable(e2) ? e2.type : 0;
  return {
    codeA: (tyA + 1) * 4 + (e1.curve ? 2 : 0) + e1.tsign,
    codeB: (tyB + 1) * 4 + (e2.curve ? 2 : 0) + e2.tsign,
  };
}

/// The largest share of its bbox a band may keep and still take the tight footprint (band12TightFootprint).
const LB_BAND_TIGHT_MAX_KEPT = 0.5;

/// Which footprint a bbox-mode curve band packs: 'tight' (band12TightFootprint) when the page sets
/// `__LB_BAND_FOOTPRINT = 'tight'`, the padded bbox otherwise. Opt-in until the GPU prices it:
/// it trades fragments for triangles.
function band12FootprintTight() {
  return typeof globalThis !== 'undefined' && globalThis.__LB_BAND_FOOTPRINT === 'tight';
}

/// A CURVE BAND'S FOOTPRINT, WITHOUT THE REGIONS ITS KERNEL DISCARDS every FRAGMENT OF.
///
/// A bbox-mode band (an integral quad band that is not a fat CDT ring) rasterizes the control
/// triangle T = (a, c, b)'s axis-aligned bbox, its corners pushed out 0.25 px (LB_KLM_RING), and the
/// kernel then throws most of it away: half of the squircle's LB fragments are band fragments, and 1 in
/// 3800 of those paints. In the integral band's uv frame (a = (0,0), c = (1/2,0), b = (1,1)) the field is
/// f = s (u^2 - v), s the band's sign, and three sets are removed, each for a reason that holds at every
/// point of it:
///   * T: the hull-turf test discards T's closed image (integral, so R == 1 exactly).
///   * both ends unchained, s < 0: the bbox beyond the two legs, v <= 0 or v <= 2u - 1. There
///     f = v - u^2 <= 0, zero only at a and b (which the hull test takes), and the band's f < 0 discard
/// takes the rest. What is kept is the bbox beyond the chord, v >= max(0, u, 2u - 1).
///   * both ends unchained, s > 0: the bbox beyond the chord within 0 <= u <= 1. There v >= u, so
///     f = u^2 - v <= u (u - 1) <= 0, zero only at a and b. Removed with T this is one convex set,
///     Z = {0 <= u <= 1, v >= 0, v >= 2u - 1}.
/// A chained end keeps everything but T (its corner combine can paint on the fill side), so Z = T.
///
/// The kept region is cut into convex cells with exactly shared vertices: bbox minus a convex Z is one cell
/// per edge of Z, bounded by the edge, a ray out of each of its interior end vertices (the outward angle
/// bisector, so both neighbors stay convex) and the bbox between the rays. The 0.25 px frame around the
/// bbox is kept whole, one quad per stretch of bbox side between consecutive cell vertices (so no
/// T-junction opens between a cell and the frame), pushed exactly as the padded bbox's corners are or along
/// the side's normal onto the same pushed side. So every kept point lies in the padded bbox's footprint at
/// every pixel size, and no fragment appears that the padded bbox would not rasterize.
///
/// Returns the triangle list as [x, y, pushX, pushY] per vertex (push in the band's 0.25 px units), or
/// null for the padded bbox (also when the cells keep more than `maxKept` of the bbox). Pure: em-space geometry in, geometry out, no packer state.
export function band12TightFootprint(
  ax,
  ay,
  cx,
  cy,
  bx,
  by,
  sign,
  unchained,
  maxKept = LB_BAND_TIGHT_MAX_KEPT,
) {
  const x0 = Math.min(ax, cx, bx),
    y0 = Math.min(ay, cy, by);
  const x1 = Math.max(ax, cx, bx),
    y1 = Math.max(ay, cy, by);
  const W = x1 - x0,
    H = y1 - y0;
  if (!(W > 0 && H > 0)) return null;
  const e1x = cx - ax,
    e1y = cy - ay,
    e2x = bx - ax,
    e2y = by - ay,
    det = e1x * e2y - e1y * e2x;
  if (!(Math.abs(det) > 1e-9 * W * H)) return null;
  // The band's own em -> uv map (u(c) = 1/2, u(a) = 0, u(b) = 1; v(a) = v(c) = 0, v(b) = 1).
  const Hux = (0.5 * e2y - e1y) / det,
    Huy = (e1x - 0.5 * e2x) / det,
    Hvx = -e1y / det,
    Hvy = e1x / det;
  const u = (p) => Hux * (p[0] - ax) + Huy * (p[1] - ay),
    v = (p) => Hvx * (p[0] - ax) + Hvy * (p[1] - ay);
  // Half-planes, each as g(p) <= 0.
  const vGe0 = (p) => -v(p),
    vGe2u1 = (p) => 2 * u(p) - 1 - v(p),
    vGeU = (p) => u(p) - v(p),
    uGeV = (p) => v(p) - u(p);
  const uGe0 = (p) => -u(p),
    uLe1 = (p) => u(p) - 1;
  // Perimeter position, counterclockwise from (x0, y0) with y up: bottom, right, top, left. A corner takes
  // the first side that holds it, so the corners sit at 0, W, W + H and 2W + H.
  const sOf = (p) =>
    p[1] === y0
      ? p[0] - x0
      : p[0] === x1
        ? W + (p[1] - y0)
        : p[1] === y1
          ? W + H + (x1 - p[0])
          : p[0] === x0
            ? 2 * W + H + (y1 - p[1])
            : -1;
  const corners = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  const cornerPush = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  const cornerS = [0, W, W + H, 2 * W + H];
  // Computed points are SNAPPED: within a hair of T's vertex, to the vertex; within a hair of a bbox side's
  // coordinate, to it. Two clips that meet at a corner otherwise leave two points 1e-16 apart, one on each side,
  // and the perimeter order below reads them as a wrap.
  const tol = 1e-9 * Math.max(W, H);
  const snap = (p) => {
    for (const t of [
      [ax, ay],
      [bx, by],
      [cx, cy],
    ])
      if (Math.abs(p[0] - t[0]) <= tol && Math.abs(p[1] - t[1]) <= tol) return [t[0], t[1]];
    const x = Math.abs(p[0] - x0) <= tol ? x0 : Math.abs(p[0] - x1) <= tol ? x1 : p[0];
    const y = Math.abs(p[1] - y0) <= tol ? y0 : Math.abs(p[1] - y1) <= tol ? y1 : p[1];
    return [x, y];
  };
  // Sutherland-Hodgman against g <= 0. A vertex with g == 0 is kept as is; a crossing lies on its edge, and a
  // coordinate the two ends share is copied rather than interpolated, so a crossing on a bbox side is on it.
  const clip = (poly, g) => {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i],
        q = poly[(i + 1) % poly.length],
        gp = g(p),
        gq = g(q);
      if (gp <= 0) out.push(p);
      if ((gp < 0 && gq > 0) || (gp > 0 && gq < 0)) {
        const t = gp / (gp - gq);
        out.push(
          snap([
            p[0] === q[0] ? p[0] : p[0] + (q[0] - p[0]) * t,
            p[1] === q[1] ? p[1] : p[1] + (q[1] - p[1]) * t,
          ]),
        );
      }
    }
    // Drop repeats (a clip through a vertex, or two snapped crossings, can emit one point twice, or two a hair apart).
    const same = (p, q) => Math.abs(p[0] - q[0]) <= tol && Math.abs(p[1] - q[1]) <= tol;
    const res = [];
    for (const p of out) if (!res.length || !same(res[res.length - 1], p)) res.push(p);
    while (res.length > 1 && same(res[0], res[res.length - 1])) res.pop();
    return res;
  };
  const area2 = (poly) => {
    let s = 0;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i],
        q = poly[(i + 1) % poly.length];
      s += p[0] * q[1] - p[1] * q[0];
    }
    return s;
  };
  const tiny = 1e-12 * W * H;
  const cells = [];
  const keep = (poly) => {
    if (poly.length >= 3 && Math.abs(area2(poly)) > tiny) cells.push(poly);
  };
  const bbox = corners.slice();
  if (unchained && sign < 0) {
    // Kept: one convex cell, the bbox beyond the chord and the legs' lines, v >= max(0, u, 2u - 1).
    keep([vGe0, vGeU, vGe2u1].reduce(clip, bbox));
  } else {
    // Removed: a convex Z; kept: bbox minus Z, one cell per edge of Z.
    const Z = unchained && sign > 0 ? [uGe0, uLe1, vGe0, vGe2u1] : [vGe0, uGeV, vGe2u1]; // Z, or T = {v >= 0, u >= v, v >= 2u - 1}
    let z = Z.reduce(clip, bbox);
    if (z.length < 3 || !(Math.abs(area2(z)) > tiny)) return null;
    if (area2(z) < 0) z = z.reverse();
    const n = z.length,
      onBox = z.map((p) => sOf(p) >= 0);
    // A ray out of each interior vertex along its outward bisector, to the bbox.
    const w = z.map((p, i) => {
      if (onBox[i]) return p;
      const pr = z[(i + n - 1) % n],
        nx = z[(i + 1) % n];
      let ux = pr[0] - p[0],
        uy = pr[1] - p[1],
        vx = nx[0] - p[0],
        vy = nx[1] - p[1];
      const lu = Math.hypot(ux, uy),
        lv = Math.hypot(vx, vy);
      ux /= lu;
      uy /= lu;
      vx /= lv;
      vy /= lv;
      let dx = -(ux + vx),
        dy = -(uy + vy);
      if (Math.hypot(dx, dy) < 1e-9) {
        dx = vy;
        dy = -vx;
      } // straight angle: the outward normal
      const tx = dx > 0 ? (x1 - p[0]) / dx : dx < 0 ? (x0 - p[0]) / dx : Infinity;
      const ty = dy > 0 ? (y1 - p[1]) / dy : dy < 0 ? (y0 - p[1]) / dy : Infinity;
      if (tx <= ty) return [dx > 0 ? x1 : x0, Math.min(y1, Math.max(y0, p[1] + dy * tx))];
      return [Math.min(x1, Math.max(x0, p[0] + dx * ty)), dy > 0 ? y1 : y0];
    });
    const ws = w.map(sOf);
    if (ws.some((s) => s < 0)) return null;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      // The cell beyond edge z_i -> z_j (Z counterclockwise, so outside is to the right): z_j, z_i, w_i, the
      // corners strictly after w_i and before w_j going counterclockwise, w_j.
      const poly = [z[j], z[i]];
      if (!onBox[i]) poly.push(w[i]);
      const s = ws[i];
      let lim = ws[j];
      if (lim < s) lim += 2 * (W + H);
      for (let k = 0; k < 8; k++) {
        const cs = cornerS[k % 4] + (k >= 4 ? 2 * (W + H) : 0);
        if (cs > s && cs < lim) poly.push(corners[k % 4]);
      }
      // Two rays can end on one corner; the cell is then the triangle z_j, z_i, that corner.
      const last = poly[poly.length - 1];
      if (!onBox[j] && (w[j][0] !== last[0] || w[j][1] !== last[1])) poly.push(w[j]);
      keep(poly);
    }
  }
  // Only where it halves the band. The cells and the frame cost 6-14 triangles against the bbox's 2, so a band
  // that keeps most of its bbox keeps the bbox: on a quadratic-heavy illustration this threshold takes 96 percent of the fragment
  // saving (keeping any band would save 7.7 percent) for 59 percent of the added triangles (+15 against +26).
  let keptArea = 0;
  for (const poly of cells) keptArea += Math.abs(area2(poly)) / 2;
  if (keptArea > maxKept * W * H) return null;
  const tris = [];
  const vtx = (p, px, py) => tris.push([p[0], p[1], px, py]);
  for (const poly of cells)
    for (let i = 1; i + 1 < poly.length; i++) {
      vtx(poly[0], 0, 0);
      vtx(poly[i], 0, 0);
      vtx(poly[i + 1], 0, 0);
    }
  // The frame: the corners and every cell vertex on the bbox split the perimeter; one quad per stretch.
  const stops = new Map();
  corners.forEach((k, i) =>
    stops.set(cornerS[i], [k[0], k[1], cornerPush[i][0], cornerPush[i][1]]),
  );
  for (const poly of cells)
    for (const p of poly) {
      const s = sOf(p);
      if (s >= 0 && !stops.has(s)) {
        const nrm = s < W ? [0, -1] : s < W + H ? [1, 0] : s < 2 * W + H ? [0, 1] : [-1, 0];
        stops.set(s, [p[0], p[1], nrm[0], nrm[1]]);
      }
    }
  const ring = [...stops.keys()].sort((m, k) => m - k).map((s) => stops.get(s));
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i],
      q = ring[(i + 1) % ring.length];
    vtx(p, 0, 0);
    vtx(q, 0, 0);
    vtx(q, q[2], q[3]);
    vtx(p, 0, 0);
    vtx(q, q[2], q[3]);
    vtx(p, p[2], p[3]);
  }
  return tris;
}

// Generous crescent dilation (× about the centroid). Big enough that the covered region
// reaches past the arc AA band at both endpoints (so no pinch/notch); the per-fragment
// chord-span clip trims the excess so neighbors tile. Affine → texcoords follow exactly,
// so the implicit (hence the arc + its coverage) is unchanged.
const CRESCENT_DILATE = 1.3;
// Dilate a control triangle (tri = 6 floats) and its per-vertex texcoords (tc = 9 floats)
// about the shared centroid by S; returns {T (6), C (9)}.
function dilateCrescent(tri, tc, S) {
  const cx = (tri[0] + tri[2] + tri[4]) / 3,
    cy = (tri[1] + tri[3] + tri[5]) / 3;
  const m0 = (tc[0] + tc[3] + tc[6]) / 3,
    m1 = (tc[1] + tc[4] + tc[7]) / 3,
    m2 = (tc[2] + tc[5] + tc[8]) / 3;
  const T = new Float32Array(6),
    C = new Float32Array(9);
  for (let k = 0; k < 3; k++) {
    T[2 * k] = cx + S * (tri[2 * k] - cx);
    T[2 * k + 1] = cy + S * (tri[2 * k + 1] - cy);
    C[3 * k] = m0 + S * (tc[3 * k] - m0);
    C[3 * k + 1] = m1 + S * (tc[3 * k + 1] - m1);
    C[3 * k + 2] = m2 + S * (tc[3 * k + 2] - m2);
  }
  return { T, C };
}

// ---- SIMILARITY-INVARIANT mesh reuse --------------------------------------
// Loop-Blinn's per-vertex quantities (klmn, homogeneous texcoords, signs,
// barycentric values) are affine-invariant: a mesh built for shape S serves
// T(S) for any orientation-preserving similarity T (translate+rotate+uniform
// scale) by transforming only coordinates, line equations, direction vectors,
// and 1/length curvatures. Games bake motion into the curve floats, so a
// content-keyed cache misses on every moved sprite/flipbook pose; hashing the
// CANONICAL form (centroid origin, RMS-radius scale, farthest-point axis)
// hits across the whole similarity orbit, and the hit path clones + transforms
// the FULL assembly output — CDT, crescents, bands, healing all come
// along; nothing is replayed. Reflections (det<0) are excluded: turn signs and
// fill orientation would flip.

// Canonical frame of a contour set: centroid, RMS radius, axis to the farthest
// control point (deterministic; ties resolve by first-in-order).
export function lbCanonicalFrame(contours) {
  let sx = 0,
    sy = 0,
    n = 0;
  for (const c of contours)
    for (const sg of c)
      for (const P of [sg.p1, sg.p2, sg.p3, sg.p4]) {
        if (P) {
          sx += P[0];
          sy += P[1];
          n++;
        }
      }
  if (!n) return null;
  const cx = sx / n,
    cy = sy / n;
  let rms = 0,
    far2 = -1,
    fx = 1,
    fy = 0;
  for (const c of contours)
    for (const sg of c)
      for (const P of [sg.p1, sg.p2, sg.p3, sg.p4]) {
        if (!P) continue;
        const dx = P[0] - cx,
          dy = P[1] - cy,
          d2 = dx * dx + dy * dy;
        rms += d2;
        if (d2 > far2) {
          far2 = d2;
          fx = dx;
          fy = dy;
        }
      }
  const sc = Math.sqrt(rms / n);
  if (!(sc > 1e-12)) return null;
  const fl = Math.hypot(fx, fy);
  if (!(fl > 1e-9 * sc)) return null; // axis ill-conditioned (all points ~centroid)
  // Near-symmetric shapes (near-rectangles) have several control points
  // within fp noise of the farthest distance; tiny rotations flip which one wins
  // and the canonical frame jumps — every lookup misses. Collect ALL candidates
  // within a relative band of the max; callers try each (store under the first).
  const cands = [];
  const band = far2 * (1 - 1e-3);
  for (const c of contours)
    for (const sg of c)
      for (const P of [sg.p1, sg.p2, sg.p3, sg.p4]) {
        if (!P) continue;
        const dx = P[0] - cx,
          dy = P[1] - cy,
          d2 = dx * dx + dy * dy;
        if (d2 >= band) {
          const L = Math.hypot(dx, dy);
          if (L > 1e-9 * sc) cands.push({ cx, cy, scale: sc, cos: dx / L, sin: dy / L });
          if (cands.length >= 8) break;
        }
      }
  const fr = { cx, cy, scale: sc, cos: fx / fl, sin: fy / fl };
  fr.cands = cands.length > 1 ? cands : null;
  return fr;
}

// FNV pair over the canonical-space quantized outline (plus seg types and
// rational weights). Quantum = scale/4096: sub-visible differences may alias
// (fine); fp jitter at bucket boundaries costs only a miss.
export function lbCanonicalHash(contours, fr) {
  return lbCanonicalHashes(contours, [fr])[0];
}

/**
 * Hash several canonical frames in one contour walk (primary + near-tie
 * candidate axes). Avoids re-walking control points per candidate on the
 * sim-cache near-symmetric path.
 * @param {any[][]} contours
 * @param {object[]} frames
 * @returns {string[]}
 */
export function lbCanonicalHashes(contours, frames) {
  const n = frames.length;
  const h1 = new Array(n),
    h2 = new Array(n),
    cnt = new Array(n);
  const q = new Array(n),
    co = new Array(n),
    si = new Array(n);
  for (let f = 0; f < n; f++) {
    h1[f] = 0x811c9dc5;
    h2[f] = 0x01000193;
    cnt[f] = 0;
    q[f] = 4096 / frames[f].scale;
    co[f] = frames[f].cos;
    si[f] = frames[f].sin;
  }
  for (const c of contours) {
    for (let f = 0; f < n; f++) {
      h1[f] = ((h1[f] ^ 0x7fff) * 0x01000193) >>> 0;
      h2[f] = ((h2[f] + 0x7fff) * 0x85ebca6b + 0xc2b2ae35) >>> 0;
    }
    for (const sg of c) {
      const ty = sg.type + 16;
      const wBits = sg.w && sg.w !== 1 ? (sg.w * 4096) | 0 : 0;
      for (let f = 0; f < n; f++) {
        h1[f] = ((h1[f] ^ ty) * 0x01000193) >>> 0;
        h2[f] = ((h2[f] + ty) * 0x85ebca6b + 0xc2b2ae35) >>> 0;
        if (wBits) {
          h1[f] = ((h1[f] ^ wBits) * 0x01000193) >>> 0;
          h2[f] = ((h2[f] + wBits) * 0x85ebca6b + 0xc2b2ae35) >>> 0;
        }
      }
      for (const P of [sg.p1, sg.p2, sg.p3, sg.p4]) {
        if (!P) continue;
        const px = P[0],
          py = P[1];
        for (let f = 0; f < n; f++) {
          const dx = px - frames[f].cx,
            dy = py - frames[f].cy;
          const bx = Math.round((co[f] * dx + si[f] * dy) * q[f]) | 0;
          const by = Math.round((-si[f] * dx + co[f] * dy) * q[f]) | 0;
          h1[f] = ((h1[f] ^ bx) * 0x01000193) >>> 0;
          h2[f] = ((h2[f] + bx) * 0x85ebca6b + 0xc2b2ae35) >>> 0;
          h1[f] = ((h1[f] ^ by) * 0x01000193) >>> 0;
          h2[f] = ((h2[f] + by) * 0x85ebca6b + 0xc2b2ae35) >>> 0;
          cnt[f]++;
        }
      }
    }
  }
  const out = new Array(n);
  for (let f = 0; f < n; f++) out[f] = h1[f] + 'S' + h2[f] + '_' + cnt[f];
  return out;
}

// MOVE A RAW MESH BY (dx, dy). The pure-translation case, which is NOT a special case of
// `transformLoopBlinnRaw` below — that one is an ALLOW-LIST, written for the similarity cache, and
// it silently drops every field it was not told about (a Bezout crescent's `keep` half-plane, the
// route stamp, the partition's own provenance records). Dropping `keep` alone lets a crescent paint
// past its arc, which is the defect the bound exists to stop.
//
// So this starts from a shallow copy — every field carried, known or not — and REPLACES only the
// ones a translation moves. Under translation the invariants are everything except positions and
// line constants: normals, directions, curvatures, weights, signs, (u,v,r), (k,l,m) and a Bezout's
// m-matrices are all unchanged, because each is built from DIFFERENCES of coordinates.
//
// Nothing is mutated: a contour point can be aliased by several records (a piece's `cp` and its
// parent segment's), so every moved array is a fresh one.
//
// NOT MOVED, deliberately: `seg9` and `cubicRecs9[].seg9`, which are the builder's own contour
// segments. They are the INPUT the mesh was built from, they stay in the frame the build ran in,
// and the only consumer outside the builder is the morph pair (lbPartitionPair.js), which builds
// its own source and never sees a translated one.
export function translateLoopBlinnRaw(mesh, dx, dy) {
  if (!mesh || (dx === 0 && dy === 0)) return mesh;
  /// stride-2 arrays of points
  const pts = (src) => {
    if (!src || !src.length) return src;
    const o = new Float32Array(src.length);
    for (let i = 0; i + 1 < src.length; i += 2) {
      o[i] = src[i] + dx;
      o[i + 1] = src[i + 1] + dy;
    }
    return o;
  };
  /// one leading point per `stride`, the rest verbatim (interiorChainC's (P4.x, P4.y, MODE, 0))
  const ptsHead = (src, stride) => {
    if (!src || !src.length) return src;
    const o = new Float32Array(src);
    for (let i = 0; i + 1 < src.length; i += stride) {
      o[i] = src[i] + dx;
      o[i + 1] = src[i + 1] + dy;
    }
    return o;
  };
  /// (nx, ny, c, ...) rows: the normal is unchanged, c' = c + n.d
  const lines = (src, stride) => {
    if (!src || !src.length) return src;
    const o = src instanceof Float32Array ? new Float32Array(src) : src.slice();
    for (let i = 0; i + stride <= src.length; i += stride)
      o[i + 2] = src[i + 2] + src[i] * dx + src[i + 1] * dy;
    return o;
  };
  const P2 = (p) => (p ? [p[0] + dx, p[1] + dy] : p);
  const line3 = (L) => (L ? [L[0], L[1], L[2] + L[0] * dx + L[1] * dy] : L);
  const ctr = (o) => (o ? Object.assign({}, o, { cx: o.cx + dx, cy: o.cy + dy }) : o);
  const triFace = (q) => {
    const o = Object.assign({}, q);
    if (q.tri) o.tri = pts(q.tri);
    if (q.hull) o.hull = pts(q.hull);
    // A klmn face's rows are re-read AT ITS VERTICES AS STORED: moving a float32 hull rounds each corner
    // again, and rows carried over unchanged describe the curve displaced by that rounding. The piece's frame is in the
    // build's own coordinates, so each stored corner is taken back by (dx, dy) to read it.
    if (q.klmn && q._frame9 && q.hull) {
      const k = new Float32Array(9);
      for (let v = 0; v < 3; v++) {
        const r = klmnFrameRowsAt9(q._frame9, o.hull[2 * v] - dx, o.hull[2 * v + 1] - dy);
        k[3 * v] = r[0];
        k[3 * v + 1] = r[1];
        k[3 * v + 2] = r[2];
      }
      o.klmn = k;
    }
    if (q.circle) o.circle = ctr(q.circle);
    if (q.a) o.a = P2(q.a);
    if (q.b) o.b = P2(q.b);
    if (q.cp) o.cp = q.cp.map(P2);
    if (q.pts) o.pts = q.pts.map(P2);
    if (q.F) o.F = ctr(q.F);
    if (q.keep) o.keep = line3(q.keep);
    if (q.keep9) o.keep9 = line3(q.keep9);
    if (q.p1) o.p1 = P2(q.p1);
    if (q.p2) o.p2 = P2(q.p2);
    if (q.c) o.c = P2(q.c); // a hull record's middle control point
    // End metadata is direction-only except the corner plane's point, which moves with the drawing.
    for (const key of ['e1', 'e2'])
      if (q[key] && q[key].cc) o[key] = Object.assign({}, q[key], { cc: P2(q[key].cc) });
    return o;
  };
  const out = Object.assign({}, mesh);
  out.interior = pts(mesh.interior);
  out.interiorEdges = lines(mesh.interiorEdges, 3);
  out.interiorEdges2 = lines(mesh.interiorEdges2, 4);
  out.interiorEdges3 = lines(mesh.interiorEdges3, 4);
  out.interiorChainA = pts(mesh.interiorChainA);
  out.interiorChainB = pts(mesh.interiorChainB);
  out.interiorChainC = ptsHead(mesh.interiorChainC, 4); // (P4.x, P4.y, MODE, 0) — MODE is not a coordinate
  out.interiorChainD = pts(mesh.interiorChainD);
  out.interiorChainE = pts(mesh.interiorChainE);
  out.chainStripVerts = pts(mesh.chainStripVerts);
  out.chainStripA = pts(mesh.chainStripA);
  out.chainStripB = pts(mesh.chainStripB);
  for (const k of ['quads', 'cubics', 'edges', 'hulls9', 'cubicRecs9'])
    if (Array.isArray(mesh[k])) out[k] = mesh[k].map(triFace);

  for (const k of ['circles', 'annuli']) if (Array.isArray(mesh[k])) out[k] = mesh[k].map(ctr);
  // stripArcs and bandArcs may SHARE records with quads (stripArcs is a semantic subset), so a
  // shared entry must land on the same moved object rather than a second copy of it.
  const pairMap = new Map();
  if (Array.isArray(mesh.quads))
    for (let i = 0; i < mesh.quads.length; i++) pairMap.set(mesh.quads[i], out.quads[i]);
  for (const k of ['stripArcs', 'bandArcs'])
    if (Array.isArray(mesh[k])) out[k] = mesh[k].map((q) => pairMap.get(q) || triFace(q));
  if (Array.isArray(mesh.steiner9))
    out.steiner9 = mesh.steiner9.map((st) => {
      const o = Object.assign({}, st);
      for (const k of ['pa', 'pb', 'pc', 'pd', 'pt']) if (st[k]) o[k] = P2(st[k]);
      return o;
    });
  return out;
}

// Apply similarity M { s, cos, sin, dx, dy } (p' = s*R*p + d) to a raw mesh,
// producing an independent clone. VALUES (klmn, tc, signs, w, types, _topo)
// are similarity-invariant and shared or copied verbatim; COORDS map by M;
// unit normals/direction vectors rotate; line constants c' = s*c + n'.d;
// lengths/radii scale by s; curvatures scale by 1/s.
export function transformLoopBlinnRaw(mesh, M) {
  const { s, cos: co, sin: si, dx, dy } = M;
  const TP = (x, y) => [s * (co * x - si * y) + dx, s * (si * x + co * y) + dy];
  const flatP = (src) => {
    if (!src || !src.length) return src ? new Float32Array(0) : src;
    const out = new Float32Array(src.length);
    for (let i = 0; i < src.length; i += 2) {
      const x = src[i],
        y = src[i + 1];
      out[i] = s * (co * x - si * y) + dx;
      out[i + 1] = s * (si * x + co * y) + dy;
    }
    return out;
  };
  // Rows of (x, y, value, value): map the leading point, copy the tail verbatim.
  const flatPKeepTail = (src) => {
    if (!src || !src.length) return src ? new Float32Array(0) : src;
    const out = new Float32Array(src.length);
    for (let i = 0; i + 3 < src.length; i += 4) {
      const x = src[i],
        y = src[i + 1];
      out[i] = s * (co * x - si * y) + dx;
      out[i + 1] = s * (si * x + co * y) + dy;
      out[i + 2] = src[i + 2];
      out[i + 3] = src[i + 3];
    }
    return out;
  };
  const rotV = (v) => (v ? [co * v[0] - si * v[1], si * v[0] + co * v[1]] : v);
  // End metadata: normals and the corner plane's normal rotate, curvatures scale by 1/s, the corner point maps.
  const xfEnd = (m) =>
    Object.assign({}, m, {
      nN: rotV(m.nN),
      k: m.k / s,
      cw: rotV(m.cw),
      cc: m.cc ? TP(m.cc[0], m.cc[1]) : m.cc,
    });
  // line rows: n' = R*n (unit stays unit), c' = s*c + n'.d
  const lineRows = (src, stride) => {
    if (!src || !src.length) return src;
    const out = src instanceof Float32Array ? new Float32Array(src.length) : src.slice();
    for (let i = 0; i + stride <= src.length; i += stride) {
      const nx = src[i],
        ny = src[i + 1],
        c = src[i + 2];
      const nX = co * nx - si * ny,
        nY = si * nx + co * ny;
      out[i] = nX;
      out[i + 1] = nY;
      out[i + 2] = s * c + nX * dx + nY * dy;
      for (let k = 3; k < stride; k++) out[i + k] = src[i + k];
    }
    return out;
  };
  const _qPair = new Map();
  const out = {
    interior: flatP(mesh.interior),
    interiorEdges: lineRows(mesh.interiorEdges, 3),
    interiorEdges2: lineRows(mesh.interiorEdges2, 4),
    interiorEdges3: lineRows(mesh.interiorEdges3, 4),
    // Analytic poly-clip chains: POSITIONS (P0,P1 / P2,P3 per vert), not lines —
    // map by flatP (rotate+scale+translate), not lineRows.
    interiorChainA: flatP(mesh.interiorChainA),
    interiorChainB: flatP(mesh.interiorChainB),
    // chainC is NOT four coordinates: its per-vertex row is (P4.x, P4.y, MODE, 0),
    // where MODE is the chain-kind sentinel (3 = conic, 2 = straight) parked in
    // the never-read P5 slot. flatP would map that pair as a POINT and add the
    // translation to it — 2.0 becomes 2·s·cos + dx — so any shape not at the
    // origin would cross the shader's `vTC.x > 2.5` conic test with a straight
    // chain and read its slots as Bezier control points. Identity-placed shapes
    // (dx = 0, s = 1) are unaffected, so only translated shapes show it
    // (loopBlinnRenderDiffSmoke draws a sheet of translated tiles).
    interiorChainC: flatPKeepTail(mesh.interiorChainC),
    interiorChainD: flatP(mesh.interiorChainD),
    interiorChainE: flatP(mesh.interiorChainE),
    interiorHasChain2: mesh.interiorHasChain2,
    chainStripVerts: flatP(mesh.chainStripVerts),
    chainStripA: flatP(mesh.chainStripA),
    chainStripB: flatP(mesh.chainStripB),
    hasConcave: mesh.hasConcave,
    fallback: [],
    quads: (mesh.quads || []).map((q) => {
      // identity-mapped below for stripArcs (a SEMANTIC subset of quads — the
      // pack-time filter fallback is NOT equivalent; dropping it changed strip
      // planning and diverged from a fresh build in validation)
      const o = { tri: flatP(q.tri), sign: q.sign, w: q.w };
      _qPair.set(q, o);
      if (q.tc) o.tc = q.tc;
      if (q.na) o.na = rotV(q.na);
      if (q.nb) o.nb = rotV(q.nb);
      // CURVE_BAND end metadata rides the similarity like the edges' (the dropped-
      // clip-planes cache-clone class): normals rotate, curvatures scale by 1/s.
      for (const key of ['e1', 'e2']) {
        const m = q[key];
        if (m) o[key] = xfEnd(m);
      }
      if (q.circle)
        o.circle = {
          cx: s * (co * q.circle.cx - si * q.circle.cy) + dx,
          cy: s * (si * q.circle.cx + co * q.circle.cy) + dy,
          r: s * q.circle.r,
        };
      return o;
    }),
    cubics: (mesh.cubics || []).map((c) => {
      const o = { hull: flatP(c.hull), sign: c.sign };
      if (c.klmn) o.klmn = c.klmn;
      // The end-tangent clip planes must ride the similarity too. Dropping them leaves the
      // DILATED hull with nothing to trim it, so a cubic mesh reached through the canonical
      // cache would render differently on a cache HIT vs a cache MISS. na/nb are directions
      // (rotate only); a/b are points on the curve (full similarity).
      if (c.na) o.na = rotV(c.na);
      if (c.nb) o.nb = rotV(c.nb);
      if (c.a) o.a = TP(c.a[0], c.a[1]);
      if (c.b) o.b = TP(c.b[0], c.b[1]);
      if (c.cp) o.cp = c.cp.map((p) => TP(p[0], p[1]));
      // The ink side is a fact of the outline a similarity (no mirror) keeps.
      if (c.inkLeft != null) o.inkLeft = c.inkLeft;
      // The keep half-plane rides the similarity too: n . p <= c goes to R n . p' <= s c + R n . d. Dropped, a Bezout
      // crescent reached through the canonical cache packed no fence at all (aTC zero) where a cache miss fenced it.
      if (c.keep) {
        const n = rotV([c.keep[0], c.keep[1]]);
        o.keep = [n[0], n[1], s * c.keep[2] + n[0] * dx + n[1] * dy];
      }
      for (const key of ['e1', 'e2']) {
        const m = c[key];
        if (m) o[key] = xfEnd(m);
      }
      if (c.F) {
        const F = c.F,
          rm = (m) => ({ a: m.a, b: co * m.b - si * m.c, c: si * m.b + co * m.c });
        o.F = Object.assign({}, F, {
          m00: rm(F.m00),
          m01: rm(F.m01),
          m02: rm(F.m02),
          cx: s * (co * F.cx - si * F.cy) + dx,
          cy: s * (si * F.cx + co * F.cy) + dy,
          s: s * F.s,
        });
      }
      return o;
    }),
    edges: (mesh.edges || []).map((e) => {
      const o = Object.assign({}, e);
      o.p1 = TP(e.p1[0], e.p1[1]);
      o.p2 = TP(e.p2[0], e.p2[1]);
      const nX = co * e.nx - si * e.ny,
        nY = si * e.nx + co * e.ny;
      o.nx = nX;
      o.ny = nY;
      for (const key of ['e1', 'e2']) {
        const m = e[key];
        if (m) o[key] = xfEnd(m);
      }
      return o;
    }),
    circles: (mesh.circles || []).map((ci) => {
      if (ci.rx != null) {
        // Elliptical disc under similarity: scale radii, add rotation to φ.
        const cx = s * (co * ci.cx - si * ci.cy) + dx;
        const cy = s * (si * ci.cx + co * ci.cy) + dy;
        return { cx, cy, rx: s * ci.rx, ry: s * ci.ry, phi: (ci.phi || 0) + Math.atan2(si, co) };
      }
      return Object.assign({}, ci, {
        cx: s * (co * ci.cx - si * ci.cy) + dx,
        cy: s * (si * ci.cx + co * ci.cy) + dy,
        r: s * ci.r,
      });
    }),
    annuli: (mesh.annuli || []).map((an) =>
      Object.assign({}, an, {
        cx: s * (co * an.cx - si * an.cy) + dx,
        cy: s * (si * an.cx + co * an.cy) + dy,
        rMid: s * an.rMid,
        halfW: s * an.halfW,
      }),
    ),
    _topo: mesh._topo || null, // index/sign topology is similarity-invariant
    // Similarity-invariant pack flags must ride the clone: packLoopBlinnMesh
    // reads _blendTier9 to set the BLEND bit, so dropping it makes a cache
    // HIT composite differently from a MISS (the clip-planes/stripArcs class).
    _blendTier9: mesh._blendTier9 || false,
  };
  // stripArcs entries are INDEPENDENT quad-like records ({tri, sign, w, e1?, e2?}), not
  // references into quads (verified) — transform them directly, INCLUDING the CURVE_BAND
  // band end metadata (the dropped-clip-planes cache-clone class).
  if (mesh.stripArcs)
    out.stripArcs = mesh.stripArcs.map((q) => {
      const hit = _qPair.get(q);
      if (hit) return hit;
      const o = { tri: flatP(q.tri), sign: q.sign, w: q.w };
      for (const key of ['e1', 'e2']) {
        const m = q[key];
        if (m) o[key] = xfEnd(m);
      }
      return o;
    });
  // bandArcs holds its own tri copies (earcut pre-heal snapshot, not shared with
  // mesh.quads) — transform directly or the clone silently loses exterior bands.
  if (mesh.bandArcs)
    out.bandArcs = mesh.bandArcs.map((q) => {
      const o = { tri: flatP(q.tri), sign: q.sign, w: q.w };
      for (const key of ['e1', 'e2']) {
        const m = q[key];
        if (m) o[key] = xfEnd(m);
      }
      return o;
    });
  if (!mesh.circles) delete out.circles;
  if (!mesh.annuli) delete out.annuli;
  return out;
}

// ---- pack the mesh into one interleaved VBO (the renderer's draw format) ---
// 24 floats / vertex, matching loopBlinn.vert.glsl's unified layout:
//   [0,1]   aPos.xy
//   [2,3,4] aTC.xyz  (INTERP): quad (u,v,_) · cubic-klmn (k,l,m) · strip (dilate,_,_)
//   [5,6]   aFlags (kind, sign)  [flat]
//   [7..10]  aC0 = M00.xyz, M01.x        [11..14] aC1 = M01.yz, M02.xy   [flat, CUBIC_BEZ]
//   [15..18] aC2 = M02.z, M11a, M12, M22 [19..22] aC3 = cen.xy, scale, _ [flat]
//   [23] pad.  Live kinds: 0 interior · 2 cubic-klmn · 4 cubic-bezout ·
//   5 quad/rquad crescent · 7 circle/annulus SDF · 10 edge strip ·
//   12 unified curve band.
// aC3 doubles as the strip's (normal.xy, line-const) at [19,20,21].
export function packLoopBlinnMesh(mesh, reuse, opts) {
  const { interior, quads, cubics } = mesh;
  // Quantized endpoint keys for the shape's straight edges, so a crescent can ask
  // "is my chord one of these?" in O(1). Both orientations are inserted.
  //
  let ekOx = 0,
    ekOy = 0,
    ekS = 65536;
  let edgeKeySet = null;
  if (mesh.edges && mesh.edges.length) {
    let ex0 = Infinity,
      ey0 = Infinity,
      ex1 = -Infinity,
      ey1 = -Infinity;
    for (const e of mesh.edges)
      for (const p of [e.p1, e.p2]) {
        if (p[0] < ex0) ex0 = p[0];
        if (p[0] > ex1) ex1 = p[0];
        if (p[1] < ey0) ey0 = p[1];
        if (p[1] > ey1) ey1 = p[1];
      }
    if (isFinite(ex0)) {
      ekOx = ex0;
      ekOy = ey0;
      const ediag = Math.hypot(ex1 - ex0, ey1 - ey0);
      ekS = ediag > 0 ? Math.pow(2, Math.round(Math.log2(65536 / ediag))) : 65536;
    }
  }
  const ekey5 = (x, y) => Math.round((x - ekOx) * ekS) + ',' + Math.round((y - ekOy) * ekS);
  if (mesh.edges && mesh.edges.length) {
    edgeKeySet = new Set();
    for (const e of mesh.edges) {
      const a = ekey5(e.p1[0], e.p1[1]),
        b = ekey5(e.p2[0], e.p2[1]);
      edgeKeySet.add(a + '|' + b);
      edgeKeySet.add(b + '|' + a);
    }
  }
  const interiorEdges = mesh.interiorEdges || null;
  const interiorChainA = mesh.interiorChainA || null; // analytic poly-clip: P0,P1 per vert → aC3
  const interiorChainB = mesh.interiorChainB || null; // P2,P3 per vert → aC0
  const interiorChainC = mesh.interiorChainC || null; // P4,P5 per vert → aTC.yz
  const interiorChainD = mesh.interiorChainD || null; // chain 2: Q0,Q1 → aC1
  const interiorChainE = mesh.interiorChainE || null; // chain 2: Q2,Q3 → aC2
  const chainStripVerts = mesh.chainStripVerts || null; // CHAIN_STRIP thin chain strips: flat tri points
  const chainStripA = mesh.chainStripA || null; // P0,P1 per strip vert → aC3
  const chainStripB = mesh.chainStripB || null; // P2,P3 per strip vert → aC0
  const edges = mesh.edges || [];
  const circles = mesh.circles || []; // exact circular-SDF discs (DISC, disc mode)
  const annuli = mesh.annuli || []; // exact concentric-ring SDF (DISC ring mode)
  const nInterior = interior.length / 2; // xy pairs → verts
  let nQuad = 0;
  for (const q of quads) nQuad += 3;
  let nCubic = 0;
  for (const c of cubics) nCubic += c.hull.length / 2;
  // A ring may only be extruded from a hull edge that BOUNDS the mesh. An edge shared with a
  // neighboring face (a crescent's chord is shared with the interior triangle the CDT put
  // against it) extrudes into a region the partition already fills, and the ring's klm — the
  // curve's own implicit — reads "inside" there, so it paints coverage 1 a SECOND time.
  //
  // Under an opaque fill that is invisible: the same color at coverage 1, twice. Under a
  // translucent one it is a solid double-composited line along every curve (a 0.5 fill
  // compositing to 0.75). Ring the boundary only.
  const faceEdges = new Map();

  const q5 = (v) => Math.fround(v);
  const ekey = (x0, y0, x1, y1) => {
    let ax = q5(x0),
      ay = q5(y0);
    let bx = q5(x1),
      by = q5(y1);
    if (ax > bx || (ax === bx && ay > by)) {
      const tx = ax,
        ty = ay;
      ax = bx;
      ay = by;
      bx = tx;
      by = ty;
    }
    return ax + ',' + ay + '|' + bx + ',' + by;
  };
  const bumpEdge = (x0, y0, x1, y1) => {
    const k = ekey(x0, y0, x1, y1);
    faceEdges.set(k, (faceEdges.get(k) || 0) + 1);
  };
  const addFace3 = (x0, y0, x1, y1, x2, y2) => {
    bumpEdge(x0, y0, x1, y1);
    bumpEdge(x1, y1, x2, y2);
    bumpEdge(x2, y2, x0, y0);
  };
  // Face-edge census for cubic exterior-ring boundary detection (shared edges
  // must not extrude into already-filled region). The census is read by the
  // cubic ring plan below and by nothing else, so a mesh with no cubic skips it
  // (a string key per face edge is a noticeable share of a streamed build).
  if (cubics.length) {
    for (let i = 0; i + 6 <= interior.length; i += 6)
      addFace3(
        interior[i],
        interior[i + 1],
        interior[i + 2],
        interior[i + 3],
        interior[i + 4],
        interior[i + 5],
      );
    for (const q of quads) {
      const t = q.tri;
      addFace3(t[0], t[1], t[2], t[3], t[4], t[5]);
    }
    for (const c of cubics) {
      const nH = c.hull.length / 2;
      const per =
        nH === 3
          ? [
              [0, 1],
              [1, 2],
              [2, 0],
            ]
          : nH === 6
            ? [
                [0, 1],
                [1, 2],
                [4, 5],
                [5, 3],
              ]
            : nH === 4
              ? [
                  [0, 1],
                  [1, 2],
                  [2, 3],
                  [3, 0],
                ]
              : [];
      for (const [i9, j9] of per)
        bumpEdge(c.hull[2 * i9], c.hull[2 * i9 + 1], c.hull[2 * j9], c.hull[2 * j9 + 1]);
    }
  }

  // Plan cubic exterior rings: one quad per BOUNDARY hull edge.
  //
  // A MORPH PAIR'S DESTINATION TAKES ITS SOURCE'S PLAN (`mesh._ringPlanFrom9`, set by lbMorphCore after it packs the
  // source): the two poses are one mesh, lerped, so they must ring the same edges. Asked of each pose separately, the
  // census can answer differently at a DEGENERATE pose -- a serpentine cut at its own inflection has three collinear
  // control points there, its fan triangle has no area, and the edge it owns would lose its ring on that
  // pose alone: the packs would differ in length and the morph would be refused. Planned from the source, the destination's
  // edge keeps its ring, with the normal on the same side of the edge as the source's and the klm gradient read over
  // a triangle of the piece's hull that has area (the rows are one affine field over the whole hull).
  const plan9 =
    mesh._ringPlanFrom9 &&
    mesh._ringPlanFrom9.cubics &&
    mesh._ringPlanFrom9.cubics.length === cubics.length
      ? mesh._ringPlanFrom9.cubics
      : null;
  for (let ci9 = 0; ci9 < cubics.length; ci9++) {
    const c = cubics[ci9];
    const nH9 = c.hull.length / 2;
    //
    if (nH9 !== 3 && nH9 !== 4 && nH9 !== 6) continue;
    // perimeter edges with their owning fan triangle (klm is affine PER TRI on a fan)
    /** @type {Array<[number, number, [number, number, number]]>} */
    // nH9 === 6 is a two-triangle SOUP of a 4-gon hull ([h0,h1,h2, h0,h2,h3]), which is what
    // lbFastMesh emits — its perimeter edges live at soup slots, and each carries its own tri
    // (klm is affine per triangle, not across the fan).
    const edges9 =
      nH9 === 3
        ? [
            [0, 1, [0, 1, 2]],
            [1, 2, [0, 1, 2]],
            [2, 0, [0, 1, 2]],
          ]
        : nH9 === 6
          ? [
              [0, 1, [0, 1, 2]],
              [1, 2, [0, 1, 2]],
              [4, 5, [3, 4, 5]],
              [5, 3, [3, 4, 5]],
            ]
          : [
              [0, 1, [0, 1, 2]],
              [1, 2, [0, 1, 2]],
              [2, 3, [0, 2, 3]],
              [3, 0, [0, 2, 3]],
            ];
    c._ring = [];

    const arc9 =
      (!c.klmn || !(opts && opts.pairedTopology)) &&
      c.cp &&
      c.cp.length === 4 &&
      c.inkLeft != null &&
      mantleDebugHook('__LB_BEZ_RING_ARC') !== false
        ? c.inkLeft
          ? c.cp
          : [c.cp[3], c.cp[2], c.cp[1], c.cp[0]]
        : null;
    if (arc9) c._arcR9 = arc9;
    else delete c._arcR9;
    const src9 = plan9 ? plan9[ci9] : null;
    if (plan9 && (!src9 || src9.hull.length !== c.hull.length)) {
      delete c._ring;
      continue;
    }
    const planned9 = src9
      ? new Map((src9._ring || []).map((R) => [R.base[0] + ',' + R.base[1], R]))
      : null;
    // A DETERMINANT IS AN AREA, so a fixed 1e-12 calls the same triangle degenerate at one
    // drawing size and healthy at another. Against the two edges it is built from, this asks
    // whether they are PARALLEL, which is what the guard is for and is size-free.
    const hasArea9 = (A9, B9, C9) => {
      const e1x = c.hull[2 * B9] - c.hull[2 * A9],
        e1y = c.hull[2 * B9 + 1] - c.hull[2 * A9 + 1];
      const e2x = c.hull[2 * C9] - c.hull[2 * A9],
        e2y = c.hull[2 * C9 + 1] - c.hull[2 * A9 + 1];
      return (
        Math.abs(e1x * e2y - e1y * e2x) >
        1e-12 * Math.sqrt((e1x * e1x + e1y * e1y) * (e2x * e2x + e2y * e2y))
      );
    };
    for (const [i9, j9, triOwn9] of edges9) {
      const srcR9 = planned9 ? planned9.get(i9 + ',' + j9) : null;
      if (planned9) {
        if (!srcR9) continue;
      }
      // interior edge (shared with the face on the other side) → no ring, it would double-composite
      else if (
        (faceEdges.get(
          ekey(c.hull[2 * i9], c.hull[2 * i9 + 1], c.hull[2 * j9], c.hull[2 * j9 + 1]),
        ) || 0) > 1
      )
        continue;
      let tri9 = triOwn9;
      if (!hasArea9(...tri9)) {
        if (!srcR9) continue;
        // The source rang this edge. A klmn piece reads its gradient over any hull triangle that has area; a Bezout
        // piece reads none (its implicit is evaluated at position), so its ring needs only the edge.
        tri9 = null;
        if (c.klmn) {
          const nV9 = nH9 === 6 ? [0, 1, 2, 4] : nH9 === 4 ? [0, 1, 2, 3] : [0, 1, 2];
          for (let a9 = 0; a9 < nV9.length && !tri9; a9++)
            for (let b9 = a9 + 1; b9 < nV9.length && !tri9; b9++)
              for (let d9 = b9 + 1; d9 < nV9.length && !tri9; d9++)
                if (hasArea9(nV9[a9], nV9[b9], nV9[d9])) tri9 = [nV9[a9], nV9[b9], nV9[d9]];
          if (!tri9) continue;
        }
      }
      const [A9, B9, C9] = tri9 || triOwn9;
      const e1x = c.hull[2 * B9] - c.hull[2 * A9],
        e1y = c.hull[2 * B9 + 1] - c.hull[2 * A9 + 1];
      const e2x = c.hull[2 * C9] - c.hull[2 * A9],
        e2y = c.hull[2 * C9 + 1] - c.hull[2 * A9 + 1];
      const det9 = e1x * e2y - e1y * e2x;
      const grad9 = (ci9) => {
        const d19 = c.klmn[3 * B9 + ci9] - c.klmn[3 * A9 + ci9],
          d29 = c.klmn[3 * C9 + ci9] - c.klmn[3 * A9 + ci9];
        return [(d19 * e2y - d29 * e1y) / det9, (d29 * e1x - d19 * e2x) / det9];
      };
      const Z9 = [0, 0];
      const gk9 = c.klmn ? grad9(0) : Z9,
        gl9 = c.klmn ? grad9(1) : Z9,
        gm9 = c.klmn ? grad9(2) : Z9;

      let nx9 = -(c.hull[2 * j9 + 1] - c.hull[2 * i9 + 1]),
        ny9 = c.hull[2 * j9] - c.hull[2 * i9];
      const nL9 = Math.hypot(nx9, ny9);
      if (!(nL9 > 0)) continue;
      nx9 /= nL9;
      ny9 /= nL9;
      if (srcR9) {
        // the source's side of the edge: its normal is the edge's LEFT normal or its right one
        const sx9 = src9.hull[2 * j9] - src9.hull[2 * i9],
          sy9 = src9.hull[2 * j9 + 1] - src9.hull[2 * i9 + 1];
        if (-sy9 * srcR9.nx + sx9 * srcR9.ny < 0) {
          nx9 = -nx9;
          ny9 = -ny9;
        }
      } else {
        const t9 = triOwn9.find((v9) => v9 !== i9 && v9 !== j9);
        if (
          nx9 * (c.hull[2 * t9] - c.hull[2 * i9]) +
            ny9 * (c.hull[2 * t9 + 1] - c.hull[2 * i9 + 1]) >
          0
        ) {
          nx9 = -nx9;
          ny9 = -ny9;
        }

        if (arc9) {
          const mx9 = (c.hull[2 * i9] + c.hull[2 * j9]) / 2,
            my9 = (c.hull[2 * i9 + 1] + c.hull[2 * j9 + 1]) / 2,
            h9 = 1e-6 * nL9;
          if (cubicChainLeftOf(arc9, mx9 + nx9 * h9, my9 + ny9 * h9)) continue;
        }
      }
      c._ring.push({
        base: [i9, j9, j9, i9, j9, i9],
        ext: [0, 0, 1, 0, 1, 1],
        nx: nx9,
        ny: ny9,
        dk: gk9[0] * nx9 + gk9[1] * ny9,
        dl: gl9[0] * nx9 + gl9[1] * ny9,
        dm: gm9[0] * nx9 + gm9[1] * ny9,
      });
    }
    if (!c._ring.length) delete c._ring;
    else nCubic += c._ring.length * 6;
  }
  const nEdge = edges.length * 6; // 2 tris per AA strip
  const nCircle = circles.length * 6; // 2 tris per disc bbox quad
  const nAnnulus = annuli.length * 6; // 2 tris per ring bbox quad
  // Curve bands (CURVE_BAND): prefer CDT stripArcs (fat ring mode), else earcut
  // pre-heal bandArcs (bbox mode), else any quad that already carries end meta.
  const curveStripQuads =
    mesh.stripArcs || mesh.bandArcs || quads.filter((q) => !q.circle && !q.tc && q.e1 && q.e2);
  // RING strips (15 verts) for fat arcs on the CDT path; padded-bbox (6) otherwise.
  const ringMode = !!mesh.stripArcs;
  const stripFat = (q) =>
    ringMode && fatArc(q.tri[0], q.tri[1], q.tri[2], q.tri[3], q.tri[4], q.tri[5]);
  // Unified curve band (CURVE_BAND): integral + rational quads with end meta.
  // aTC=(Ũ,Ṽ,R) with R≡1 for integral; κA/κB in mixed aC2.zw.
  const isBand12 = (q) => q.e1 && q.e2 && !q.tc && !q.circle;
  const hasBands = !!(mesh.stripArcs || mesh.bandArcs);
  // the tight footprint for an integral bbox-mode band (band12TightFootprint), when the page opts in. A morph
  // pair packs its two poses with `pairedTopology`: their streams are lerped vertex for vertex, and the tight
  // footprint's vertex count follows each pose's own geometry.
  const tightBands = band12FootprintTight() && !(opts && opts.pairedTopology);
  const tightFp = tightBands ? new Map() : null;
  const tightOf = (q) => {
    if (!tightBands || stripFat(q) || !isBand12(q) || (q.w && q.w !== 1)) return null;
    if (tightFp.has(q)) return tightFp.get(q);
    const chained = (e) => band12Chainable(e) && Math.abs(e.type) > 0.5;
    const fp = band12TightFootprint(
      q.tri[0],
      q.tri[1],
      q.tri[2],
      q.tri[3],
      q.tri[4],
      q.tri[5],
      q.sign,
      !chained(q.e1) && !chained(q.e2),
    );
    tightFp.set(q, fp);
    return fp;
  };
  // Per-arc strip plan: 6 verts (bbox: shallow), 15 (fat convex toward ctrl),
  // or 6 (fat concave beyond chord).
  const stripPlanOf = (q) => {
    if (!stripFat(q)) {
      const fp = tightOf(q);
      return fp ? fp.length : 6;
    }
    const ax = q.tri[0],
      ay = q.tri[1],
      cx = q.tri[2],
      cy = q.tri[3],
      bx = q.tri[4],
      by = q.tri[5];
    const e1x = cx - ax,
      e1y = cy - ay,
      e2x = bx - ax,
      e2y = by - ay;
    const det = e1x * e2y - e1y * e2x;
    if (!(Math.abs(det) > 1e-12 * Math.sqrt((e1x * e1x + e1y * e1y) * (e2x * e2x + e2y * e2y))))
      return 6;
    const Jvx = -e1y / det,
      Jvy = e1x / det;
    const ovx = -q.sign * Jvx,
      ovy = -q.sign * Jvy;
    const ctrlSide = (cx - (ax + bx) / 2) * ovx + (cy - (ay + by) / 2) * ovy > 0;
    return ctrlSide ? 15 : 6;
  };
  let nCurveStrip = 0;
  for (const q of curveStripQuads) nCurveStrip += stripPlanOf(q);
  const nChainStrip = chainStripVerts ? chainStripVerts.length / 2 : 0; // CHAIN_STRIP thin chain strips
  const total = nInterior + nQuad + nCubic + nEdge + nCircle + nAnnulus + nCurveStrip + nChainStrip;

  let v =
    reuse && reuse.verts && reuse.verts.length === total * LB_VERT_FLOATS
      ? reuse.verts
      : new Float32Array(Math.max(total, 1) * LB_VERT_FLOATS);
  let o = 0;
  // audit-marginal shapes ride a BLEND flag in the kind fraction (bit 11 of
  // the 8192-grain: 2048/8192 = 0.25, so kind tests at .5 midpoints stay
  // exact and the combined route's painter ordinal (≤2047) still fits below).
  const blendBit = mesh._blendTier9 ? 2048 / 8192 : 0;
  const grow = () => {
    if (o + LB_VERT_FLOATS <= v.length) return;
    const nv = new Float32Array(Math.max(v.length * 2, o + LB_VERT_FLOATS * 64));
    nv.set(v.subarray(0, o));
    v = nv;
  };
  const LBK = {
    INTERIOR: 0,
    CUBIC: 2,
    CUBIC_BEZ: 4,
    ARC: 5,
    DISC: 7,
    EDGE_STRIP: 10,
    CURVE_BAND: 12,
    CHAIN_STRIP: 13,
  };
  // LB PIECE KINDS, by name. These are the wire values the fragment shader
  // dispatches on (LBK_* in _lbVaryings.glsl) — the numbers must match, and a
  // bare number at a `head(...)` call site says nothing about what it packs.
  //   INTERIOR    solid interior triangle (may ramp across a straight edge)
  //   CUBIC       cubic outline via the Loop-Blinn klmn implicit
  //   CUBIC_BEZ   cusp / d1~0 cubic via the exact Bezout determinant
  //   ARC         rational-quadratic crescent (arcs, ellipse segments)
  //   DISC        circle / annulus / ellipse analytic SDF
  //   EDGE_STRIP  a straight edge's exterior band + both end wedges
  //   CURVE_BAND  the unified exterior band around a curve
  //   CHAIN_STRIP thin per-edge band, analytic poly-clip
  // Dead values 1, 3, 8, 9, 11 lost their handlers with their emitters.
  //
  // Which KINDS this mesh actually contains, as a bitmask. lbCoverage() is one
  // big per-kind dispatch and a typical mesh uses a handful of them, so the
  // renderer compiles the unused blocks OUT (MANTLE_LB_NO_<NAME>) — the same
  // omit-define componentization the rest of the fill shader uses. Recorded here
  // rather than inferred later because this is the one place that knows.
  let kindMask = 0;
  const head = (x, y, t0, t1, t2, kind, sign) => {
    grow();
    kindMask |= 1 << kind;
    v[o] = x;
    v[o + 1] = y;
    v[o + 2] = t0;
    v[o + 3] = t1;
    v[o + 4] = t2;
    v[o + 5] = kind + blendBit;
    v[o + 6] = sign;
  };
  const bezout = (F) => {
    v[o + 7] = F.m00.a;
    v[o + 8] = F.m00.b;
    v[o + 9] = F.m00.c;
    v[o + 10] = F.m01.a;
    v[o + 11] = F.m01.b;
    v[o + 12] = F.m01.c;
    v[o + 13] = F.m02.a;
    v[o + 14] = F.m02.b;
    v[o + 15] = F.m02.c;
    v[o + 16] = F.m11a;
    v[o + 17] = F.m12;
    v[o + 18] = F.m22;
    v[o + 19] = F.cx;
    v[o + 20] = F.cy;
    v[o + 21] = F.s;
  };
  const interiorEdges2 = mesh.interiorEdges2 || null;
  const interiorEdges3 = mesh.interiorEdges3 || null;
  // The EMISSION ORDER is the packer's own unless a morph pair asks to keep the
  // builder's (`_keepOrder9`), or the TEST HOOK `__LB_EMIT_ORDER = false` (under __MANTLE_DEBUG__) does, for an A/B.
  const keepOrder9 = !!mesh._keepOrder9 || mantleDebugHook('__LB_EMIT_ORDER') === false;

  const emitInterior9 = () => {
    // ANALYTIC POLY-CLIP (chain mode): each vertex carries its triangle's local
    // outline chain as 4 POINTS — P0,P1 → aC3.xy/zw, P2,P3 → aC0.xy/zw — with a
    // aTC.z = 2.0 sentinel so the INTERIOR fragment clips instead of the line combo.
    if (interiorChainA) {
      // HYBRID meshes carry both row families: chain rows for analytic faces and
      // line/edge rows for the shattered junction-core shards. A face is LINE
      // mode iff its edge rows are non-zero (a face with all-zero rows of both
      // kinds is solid interior under either mode, so the inference is exact).
      let lineMask = null;
      if (interiorEdges) {
        const nF = (interior.length / 6) | 0;
        lineMask = new Uint8Array(nF);
        for (let f = 0; f < nF; f++) {
          for (let k = 0; k < 9; k++)
            if (interiorEdges[f * 9 + k] !== 0) {
              lineMask[f] = 1;
              break;
            }
          if (!lineMask[f] && interiorEdges2)
            for (let k = 0; k < 12; k++)
              if (interiorEdges2[f * 12 + k] !== 0) {
                lineMask[f] = 1;
                break;
              }
          if (!lineMask[f] && interiorEdges3)
            for (let k = 0; k < 12; k++)
              if (interiorEdges3[f * 12 + k] !== 0) {
                lineMask[f] = 1;
                break;
              }
        }
      }
      // Emission order: the faces that carry a cubic chain go out first. Their lanes near the arc run
      // the exact cubic kernel and hold their SIMD groups, as a ring's do (see the cubic loop); a straight face's lanes
      // then fill groups of their own. The faces partition the interior, so no pixel changes; a morph pair keeps its order.
      const nF9 = (interior.length / 6) | 0;
      const cubicFace9 = (f) =>
        !(lineMask && lineMask[f]) &&
        !!interiorChainC &&
        (interiorChainC[f * 12 + 2] > 3.5 || (Math.round(interiorChainC[f * 12 + 3]) & 1) === 1);
      for (let pass9 = keepOrder9 ? 1 : 0; pass9 < 2; pass9++)
        for (let f9 = 0; f9 < nF9; f9++) {
          if (!keepOrder9 && (cubicFace9(f9) ? 0 : 1) !== pass9) continue;
          for (let k9 = 0; k9 < 3; k9++) {
            const i = f9 * 6 + k9 * 2,
              c = f9 * 12 + k9 * 4;
            const vi = (i / 2) | 0;
            if (lineMask && lineMask[(vi / 3) | 0]) {
              // shard vertex — identical emission to the plain line-mode loop below
              if (interiorEdges3)
                head(
                  interior[i],
                  interior[i + 1],
                  interiorEdges3[c],
                  interiorEdges3[c + 1],
                  interiorEdges3[c + 2],
                  LBK.INTERIOR,
                  0,
                );
              else head(interior[i], interior[i + 1], 0, 0, 0, LBK.INTERIOR, 0);
              if (interiorEdges) {
                v[o + 19] = interiorEdges[vi * 3];
                v[o + 20] = interiorEdges[vi * 3 + 1];
                v[o + 21] = interiorEdges[vi * 3 + 2];
              } else {
                v[o + 19] = 0;
                v[o + 20] = 0;
                v[o + 21] = 0;
              }
              v[o + 22] = interiorEdges3 ? interiorEdges3[c + 3] : 0;
              if (interiorEdges2) {
                v[o + 7] = interiorEdges2[c];
                v[o + 8] = interiorEdges2[c + 1];
                v[o + 9] = interiorEdges2[c + 2];
                v[o + 10] = interiorEdges2[c + 3];
              } else {
                v[o + 7] = 0;
                v[o + 8] = 0;
                v[o + 9] = 0;
                v[o + 10] = 0;
              }
              v[o + 11] = 0;
              v[o + 12] = 0;
              v[o + 13] = 0;
              v[o + 14] = 0; // clear the chain-2 slots —
              v[o + 15] = 0;
              v[o + 16] = 0;
              v[o + 17] = 0;
              v[o + 18] = 0; // reuse buffers are dirty
              o += LB_VERT_FLOATS;
              continue;
            }
            // aTC.x = 2 chain sentinel; aTC.yz = P4 (per-face constant, so interpolation
            // is exact). Lean-safe 5-point chain: aC3=P0,P1 · aC0=P2,P3 · aTC.yz=P4.
            // 5 points cover a 2-side corner face (pre,V1,V2,V3,post) — proven ≤3 segs/box.
            // Mode rides chainC's unused P5.x slot: the straight 4-segment chain (a builder that leaves it 0 → straight),
            // or a CUBIC chain: 4 and 5, the five points one cubic's four and a straight neighbor, after it (4)
            // or before it (5). The sentinel passes through as the builder wrote it.
            const modeIn = interiorChainC ? interiorChainC[c + 2] : 0;
            const chainMode = modeIn > 3.5 ? Math.round(modeIn) : 2.0;
            if (chainMode > 3.5) hasCubicChain = true;
            head(
              interior[i],
              interior[i + 1],
              chainMode,
              interiorChainC ? interiorChainC[c] : 0,
              interiorChainC ? interiorChainC[c + 1] : 0,
              LBK.INTERIOR,
              0,
            );
            v[o + 19] = interiorChainA[c];
            v[o + 20] = interiorChainA[c + 1]; // aC3.xy = P0
            v[o + 21] = interiorChainA[c + 2];
            v[o + 22] = interiorChainA[c + 3]; // aC3.zw = P1
            v[o + 7] = interiorChainB[c];
            v[o + 8] = interiorChainB[c + 1]; // aC0.xy = P2
            v[o + 9] = interiorChainB[c + 2];
            v[o + 10] = interiorChainB[c + 3]; // aC0.zw = P3
            // CHAIN 2 (the face's SECOND outline arc, 4 pts) → aC1/aC2, the slots the
            // lean variant drops — so a mesh that has one forces the full program.
            // Absent → all zeros → every segment degenerate → cov 1 → min() no-op.
            // aSeamM = 1: chain 2 is ONE CUBIC, Q0 C Q1 C Q2 -> Q3; an interior face reads the slot for
            // nothing else, and it is written either way because the vertex buffer is reused across builds.
            const code9 = interiorChainC ? Math.round(interiorChainC[c + 3]) : 0;
            v[o + 23] = code9 & 1 ? 1.0 : 0.0;
            v[o + 6] = 0;
            if (v[o + 23] > 0.5) hasCubicChain = true;
            if (interiorChainD) {
              v[o + 11] = interiorChainD[c];
              v[o + 12] = interiorChainD[c + 1]; // aC1.xy = Q0
              v[o + 13] = interiorChainD[c + 2];
              v[o + 14] = interiorChainD[c + 3]; // aC1.zw = Q1
              v[o + 15] = interiorChainE[c];
              v[o + 16] = interiorChainE[c + 1]; // aC2.xy = Q2
              v[o + 17] = interiorChainE[c + 2];
              v[o + 18] = interiorChainE[c + 3]; // aC2.zw = Q3
            } else for (let q9 = 11; q9 <= 18; q9++) v[o + q9] = 0; // the buffer is reused: a mesh with no chain 2 reads these as one
            o += LB_VERT_FLOATS;
          }
        }
      return;
    }
    for (let i = 0, e = 0, e2 = 0; i < interior.length; i += 2, e += 3, e2 += 4) {
      // INTERIOR's aTC is otherwise unused: a THIRD boundary line (nx,ny,c) rides it, its
      // corner type rides aC3.w — no VS changes (vTC/cHalf already flow through).
      if (interiorEdges3)
        head(
          interior[i],
          interior[i + 1],
          interiorEdges3[e2],
          interiorEdges3[e2 + 1],
          interiorEdges3[e2 + 2],
          LBK.INTERIOR,
          0,
        );
      else head(interior[i], interior[i + 1], 0, 0, 0, LBK.INTERIOR, 0);
      // aC3 [19,20,21] = straight boundary-edge line (nx,ny,c) for the fragment's
      // INTERIOR inner AA ramp; 0 → solid interior (no boundary edge).
      if (interiorEdges) {
        v[o + 19] = interiorEdges[e];
        v[o + 20] = interiorEdges[e + 1];
        v[o + 21] = interiorEdges[e + 2];
      } else {
        v[o + 19] = 0;
        v[o + 20] = 0;
        v[o + 21] = 0;
      }
      v[o + 22] = interiorEdges3 ? interiorEdges3[e2 + 3] : 0;
      // aC0 [7..10] = optional SECOND boundary line + corner type (thin strokes / corners →
      // combined box coverage). Written unconditionally so the streaming in-place reuse
      // never reads a stale slot.
      if (interiorEdges2) {
        v[o + 7] = interiorEdges2[e2];
        v[o + 8] = interiorEdges2[e2 + 1];
        v[o + 9] = interiorEdges2[e2 + 2];
        v[o + 10] = interiorEdges2[e2 + 3];
      } else {
        v[o + 7] = 0;
        v[o + 8] = 0;
        v[o + 9] = 0;
        v[o + 10] = 0;
      }
      o += LB_VERT_FLOATS;
    }
  };

  for (const q of quads) {
    if (q.circle) {
      // Circular arc crescent → DISC, disc mode (cHalf < 0): exact circular SDF,
      // seam-free across co-circular pieces. Control-tri geometry; aC3 = (cx, cy, r, −1).
      for (let k = 0; k < 3; k++) {
        head(q.tri[2 * k], q.tri[2 * k + 1], 0, 0, 0, LBK.DISC, q.sign);
        v[o + 19] = q.circle.cx;
        v[o + 20] = q.circle.cy;
        v[o + 21] = q.circle.r;
        v[o + 22] = -1;
        o += LB_VERT_FLOATS;
      }
      continue;
    }
    // Kind ARC fill crescent. When CURVE_BAND owns the exterior (e1/e2 on the piece,
    // or any band list on the mesh), pack undilated fill-side only (aC3=0).
    // Dilate+chord remains only for unbanded rational (no exterior band at all).
    // CHORD-IS-A-BOUNDARY: this crescent's chord coincides with a real straight
    // EDGE of the shape, so it is a shape boundary and the fragment must ramp
    // across it (see the chord clip in loopBlinn.frag.glsl). Signaled by
    // |sign| = 3 rather than 1 — the sign-magnitude idiom CURVE_BAND uses for its
    // flags; no vertex slot is free (aC3 feeds the rquad chord-span clip, slot 23
    // carries cxo / mean(R)).
    //
    // The weaker test "this mesh has no INTERIOR interior" is NOT equivalent and
    // fails: a multi-arc ellipse or squircle has no interior triangles either,
    // but its chords form the INSCRIBED polygon and are interior, not boundary.
    // Clipping there pinches every crescent (quad-seam max under-coverage 0.976,
    // ellipse off by 5790px, squircle ink ratio 0.409).
    const lone5 =
      edgeKeySet !== null &&
      edgeKeySet.has(ekey5(q.tri[0], q.tri[1]) + '|' + ekey5(q.tri[4], q.tri[5]));
    const banded = !!(q.e1 && q.e2);
    const integral = !q.w || q.w === 1;
    const fillSide = banded || integral || hasBands;
    const pSign = (q.flip ? -1 : 1) * q.sign * (lone5 ? 3 : 1);
    if (q.tc) {
      for (let k = 0; k < 3; k++) {
        const r = integral ? 1 : q.tc[3 * k + 2];
        head(q.tri[2 * k], q.tri[2 * k + 1], q.tc[3 * k], q.tc[3 * k + 1], r, LBK.ARC, pSign);
        if (fillSide) {
          v[o + 19] = 0;
          v[o + 20] = 0;
          v[o + 21] = 0;
          v[o + 22] = 0;
        } else {
          v[o + 19] = q.tri[0];
          v[o + 20] = q.tri[1];
          v[o + 21] = q.tri[4];
          v[o + 22] = q.tri[5];
        }
        o += LB_VERT_FLOATS;
      }
    } else if (fillSide) {
      const iw = integral ? 1 : 1 / q.w;
      const d = dilateCrescent(q.tri, [0, 0, 1, 0.5 * iw, 0, iw, 1, 1, 1], 1.0);
      const cxo = q.tri[2],
        cyo = q.tri[3];
      const naX = q.na ? q.na[0] : cxo - q.tri[0],
        naY = q.na ? q.na[1] : cyo - q.tri[1];
      const nbX = q.nb ? q.nb[0] : cxo - q.tri[4],
        nbY = q.nb ? q.nb[1] : cyo - q.tri[5];
      for (let k = 0; k < 3; k++) {
        head(
          d.T[2 * k],
          d.T[2 * k + 1],
          d.C[3 * k],
          d.C[3 * k + 1],
          d.C[3 * k + 2],
          LBK.ARC,
          pSign,
        );
        v[o + 7] = naX;
        v[o + 8] = naY;
        v[o + 9] = nbX;
        v[o + 10] = nbY;
        v[o + 19] = 0;
        v[o + 20] = 0;
        v[o + 21] = 0;
        v[o + 22] = 0;
        v[o + 23] = cxo;
        o += LB_VERT_FLOATS;
      }
    } else {
      // Unbanded rational: dilated + chord-span clip (CURVE_BAND not available).
      const iw = 1 / q.w;
      const d = dilateCrescent(q.tri, [0, 0, 1, 0.5 * iw, 0, iw, 1, 1, 1], CRESCENT_DILATE);
      for (let k = 0; k < 3; k++) {
        head(
          d.T[2 * k],
          d.T[2 * k + 1],
          d.C[3 * k],
          d.C[3 * k + 1],
          d.C[3 * k + 2],
          LBK.ARC,
          pSign,
        );
        v[o + 19] = q.tri[0];
        v[o + 20] = q.tri[1];
        v[o + 21] = q.tri[4];
        v[o + 22] = q.tri[5];
        o += LB_VERT_FLOATS;
      }
    }
  }
  let hasBezout = false; // any CUBIC_BEZ (cusp / d1≈0) piece → needs the full program
  /// Any INTERIOR face whose chain is CONIC (two quadratic Beziers) rather than four straight
  /// segments. Same shape of fact as hasBezout and for the same reason: it selects a kernel,
  /// and only the packer can answer it.
  let hasCubicChain = false;

  const ringsAfter9 = [];
  for (let pass9 = 0; pass9 < 2; pass9++)
    for (const c of pass9 === 0 ? cubics : ringsAfter9) {
      const n = c.hull.length / 2;
      if (pass9 === 0)
        for (let k = 0; k < n; k++) {
          if (c.klmn) {
            head(
              c.hull[2 * k],
              c.hull[2 * k + 1],
              c.klmn[3 * k],
              c.klmn[3 * k + 1],
              c.klmn[3 * k + 2],
              LBK.CUBIC,
              c.sign,
            );
            // Dilated cubic crescent: clip back to the piece's own end tangents so neighbors tile.
            // aSeamM = 1 marks a clipped hull triangle; ring verts carry 9 (outer) / 0 (inner), and
            // hull and ring triangles are separate, so the flat provoking vertex never mixes them.
            // A cubic that carries an exterior ring stays undilated and unclipped: the ring
            // reuses aC0/aC3 for its extrusion data.
            if (!c._ring && c.na && c.nb) {
              v[o + 7] = c.na[0];
              v[o + 8] = c.na[1];
              v[o + 9] = c.nb[0];
              v[o + 10] = c.nb[1];
              v[o + 19] = c.a[0];
              v[o + 20] = c.a[1];
              v[o + 21] = c.b[0];
              v[o + 22] = c.b[1];
              v[o + 23] = 1;
            } else {
              v[o + 7] = 0;
              v[o + 8] = 0;
              v[o + 9] = 0;
              v[o + 10] = 0;
              v[o + 23] = 0;
            }
          } else {
            // aTC CARRIES THE CRESCENT'S own BOUND, because a kind-4 vertex never reads it: a Bezout
            // crescent's coverage comes from the determinant evaluated at POSITION, not from
            // interpolated texcoords, so all three slots are free. They hold the
            // half-plane past which this crescent may not paint -- beyond its own arc, on the side the
            // ink is not on. See bezoutKeepHalf9 in lbPartition.js for why that bound exists and why
            // the side is chosen by the ink rather than by the arc's bulge.
            const kp = c.keep;
            head(
              c.hull[2 * k],
              c.hull[2 * k + 1],
              kp ? kp[0] : 0,
              kp ? kp[1] : 0,
              kp ? kp[2] : 0,
              LBK.CUBIC_BEZ,
              c.sign,
            );
            bezout(c.F);
            hasBezout = true;
            // SLOTS 22 AND 23 ARE never WRITTEN ON this BRANCH, and the vertex buffer is REUSED across
            // builds: `head` fills 0-6 and `bezout` fills 7-21, so a Bezout crescent's last two slots
            // arrive holding whatever the previous mesh left there. Slot 23 is aSeamM, and the kernel
            // reads vSeam > 5 as "this is an exterior RING vertex" and discards the fragment's
            // fill-side partial coverage -- a Bezout crescent has no ring, so any value above five is
            // stale data deciding whether a pixel gets painted. The klmn branch clears 23 explicitly a
            // few lines up; this branch clears both here.
            v[o + 22] = 0;
            v[o + 23] = 0;
          }
          o += LB_VERT_FLOATS;
        }
      if (!c._ring) continue;
      if ((!c.klmn || c._arcR9) && pass9 === 0 && !keepOrder9) {
        ringsAfter9.push(c);
        continue;
      } // after every hull (above)
      // CUBIC EXTERIOR BANDS → CURVE_BAND (cubic mode, |sign|≥8192), unless the ring carries its arc (below).
      if (!c.klmn || c._arcR9) {
        // A bezout ring stays kind 4, because only the kind-4 kernel knows how to evaluate this
        // piece: the determinant is read from POSITION, so the extruded vertices carry exactly the
        // same attributes as the hull's and the implicit does not move. What each vertex needs is
        // its own push -- the edge normal, zero on the two inner vertices so the ring stays welded
        // to the hull -- and aC3.w is the one slot `bezout` leaves free. aSeamM = 9 marks the whole
        // quad a ring, the same mark the klm rings use, and buys the same fill-side claim rule:
        // the hull crescent owns f<0, the ring owns the band outside it.
        //
        // THE RING CARRIES ITS ARC INSTEAD, where the builder knows the piece's control points and which
        // side of it is ink: aC0 / aC1 hold the arc's four points, oriented fill-left, and aSeamM = 10 says so. The
        // ring's coverage is then the pixel box's exact share of the ink side of the arc (_lbCoverage.glsl, the cubic
        // chain kernel) -- no resultant, so none of its second branch, which would paint past the arc within the ring's
        // reach. The resultant needs 15 of these slots and the arc 8, so the
        // swap needs no new slot, texture or fetch. A static klm piece's ring takes the same form: kind 4 with its
        // arc, which the kind-4 kernel reads before it would look for a resultant. The TEST HOOK
        // `__LB_BEZ_RING_ARC = false` (under __MANTLE_DEBUG__) keeps the resultant ring, and a klm piece's kind-12 ring.
        const kpR = c.keep;
        const arcR9 = c._arcR9 || null; // oriented and gated where the ring was planned
        for (const R9 of c._ring) {
          for (let k = 0; k < 6; k++) {
            const b9 = R9.base[k],
              ext9 = R9.ext[k];
            head(
              c.hull[2 * b9],
              c.hull[2 * b9 + 1],
              kpR ? kpR[0] : 0,
              kpR ? kpR[1] : 0,
              kpR ? kpR[2] : 0,
              LBK.CUBIC_BEZ,
              c.sign,
            );
            if (arcR9) {
              for (let q9 = 0; q9 < 4; q9++) {
                v[o + 7 + 2 * q9] = arcR9[q9][0];
                v[o + 8 + 2 * q9] = arcR9[q9][1];
              }
              for (let q9 = 15; q9 <= 21; q9++) v[o + q9] = 0; // the resultant's slots: the buffer is reused
              hasCubicChain = true;
            } else bezout(c.F);
            hasBezout = true;
            v[o + 22] = ext9 ? packHalf2x16(R9.nx, R9.ny) : 0;
            v[o + 23] = arcR9 ? 10 : 9;
            o += LB_VERT_FLOATS;
          }
        }
        continue;
      }
      // k,l,m stay affine over the hull — inner verts share hull coords+klm
      // (watertight); outer verts extend klm by the directional gradient.
      //   aTC=(k,l,m) · aC0=(n̂.xy, packKlmGrad(dk,dl), dm)
      //   with ends: aC1=(nA,nB) · aC2=(packHalf(nOwnA), packHalf(nOwnB), κA, κB) · aC3=(a,b)
      //   |aSign|=8192 + 4096 + 2048·spanB + 1024·spanA + 16·codeA + codeB
      const hasEnds = !!(c.e1 && c.e2 && c.a && c.b && c.na && c.nb);
      let sgnC12 = c.sign * (8192 + 4096);
      let nOwnPackA = 0,
        nOwnPackB = 0,
        kA = 0,
        kB = 0;
      if (hasEnds) {
        const La = Math.hypot(c.na[0], c.na[1]) || 1;
        let nOAx = -c.sign * (-c.na[1] / La),
          nOAy = -c.sign * (c.na[0] / La);
        let nL = Math.hypot(nOAx, nOAy) || 1;
        nOAx /= nL;
        nOAy /= nL;
        const Lb = Math.hypot(c.nb[0], c.nb[1]) || 1;
        let nOBx = -c.sign * (-c.nb[1] / Lb),
          nOBy = -c.sign * (c.nb[0] / Lb);
        nL = Math.hypot(nOBx, nOBy) || 1;
        nOBx /= nL;
        nOBy /= nL;
        const ax = c.a[0],
          ay = c.a[1],
          bx = c.b[0],
          by = c.b[1];
        let cxm, cym;
        if (c.cp && c.cp[1] && c.cp[2]) {
          cxm = (c.cp[1][0] + c.cp[2][0]) / 2;
          cym = (c.cp[1][1] + c.cp[2][1]) / 2;
        } else {
          cxm = (ax + bx) / 2;
          cym = (ay + by) / 2;
        }
        let sAx = cxm - ax,
          sAy = cym - ay;
        let L12 = Math.hypot(sAx, sAy) || 1;
        sAx /= L12;
        sAy /= L12;
        let sBx = cxm - bx,
          sBy = cym - by;
        L12 = Math.hypot(sBx, sBy) || 1;
        sBx /= L12;
        sBy /= L12;
        const spanA = -nOAy * sAx + nOAx * sAy > 0 ? 1 : 0;
        const spanB = -nOBy * sBx + nOBx * sBy > 0 ? 1 : 0;
        const { codeA, codeB } = band12EndCodes(c.e1, c.e2);
        sgnC12 = c.sign * (8192 + 4096 + 2048 * spanB + 1024 * spanA + 16 * codeA + codeB);
        nOwnPackA = packHalf2x16(nOAx, nOAy);
        nOwnPackB = packHalf2x16(nOBx, nOBy);
        kA = band12EndKappa(c.e1);
        kB = band12EndKappa(c.e2);
      }
      for (const R9 of c._ring) {
        // The arc's support along the ring's normal: the half-plane n . p <= max over the arc of n . B(t)
        // holds the piece's arc and its ink near it, and it is the ring fragment's exact bound (_lbCoverage.glsl,
        // CURVE_BAND). On a hull edge through an arc END it is that edge's own line; on the far control edge it is the
        // arc's extreme, where the edge's line would leave the gap between hull and arc to the implicit. Rides the seam
        // slot, which a kind-12 vertex does not otherwise use.
        // Stored ROUNDED UP to float32, so the bound it names never cuts into the arc by the rounding.
        const sup64 =
          c.cp && c.cp.length === 4
            ? cubicSupport9(c.cp, R9.nx, R9.ny)
            : R9.nx * c.hull[2 * R9.base[0]] + R9.ny * c.hull[2 * R9.base[0] + 1];
        let sup12 = Math.fround(sup64);
        if (sup12 < sup64) {
          const b = new Float32Array([sup12]),
            u = new Int32Array(b.buffer);
          u[0] += sup12 >= 0 ? 1 : -1;
          sup12 = b[0];
        }
        for (let k = 0; k < 6; k++) {
          const b9 = R9.base[k],
            ext9 = R9.ext[k];
          head(
            c.hull[2 * b9],
            c.hull[2 * b9 + 1],
            c.klmn[3 * b9],
            c.klmn[3 * b9 + 1],
            c.klmn[3 * b9 + 2],
            LBK.CURVE_BAND,
            sgnC12,
          );
          if (ext9) {
            v[o + 7] = R9.nx;
            v[o + 8] = R9.ny;
            v[o + 9] = packKlmGrad(R9.dk, R9.dl);
            v[o + 10] = R9.dm;
          } else {
            v[o + 7] = 0;
            v[o + 8] = 0;
            v[o + 9] = 0;
            v[o + 10] = 0;
          }
          if (hasEnds)
            writeBand12Ends(
              v,
              o,
              c.e1,
              c.e2,
              nOwnPackA,
              nOwnPackB,
              kA,
              kB,
              c.a[0],
              c.a[1],
              c.b[0],
              c.b[1],
            );
          else clearBand12Ends(v, o);
          v[o + 23] = sup12;
          hasBezout = true;
          o += LB_VERT_FLOATS;
        }
      }
    }
  // Kind EDGE_STRIP unified edge cap-strip: one primitive per straight edge owning the
  // whole exterior band plus both end wedges. Edges without e1/e2 end meta are
  // skipped (builders always attach them under the current strip/band path).
  const Z2 = [0, 0];
  const strip10 = (e) => {
    const tdx0 = e.p2[0] - e.p1[0],
      tdy0 = e.p2[1] - e.p1[1],
      tL = Math.hypot(tdx0, tdy0) || 1;
    const sig = (-tdy0 / tL) * e.nx + (tdx0 / tL) * e.ny > 0 ? 1 : -1; // outward = left-perp·σ
    const codeA = (e.e1.type + 1) * 4 + (e.e1.curve ? 2 : 0) + e.e1.tsign;
    const codeB = (e.e2.type + 1) * 4 + (e.e2.curve ? 2 : 0) + e.e2.tsign;
    const packed = codeA * 16 + codeB;
    const shA = !!(e.e1.cw && e.e1.cc),
      shB = !!(e.e2.cw && e.e2.cc);
    const cwA = shA ? e.e1.cw : Z2,
      ccA = shA ? e.e1.cc : Z2,
      cwB = shB ? e.e2.cw : Z2,
      ccB = shB ? e.e2.cc : Z2;
    const sv10 = (role) => {
      const tR = role % 2,
        base = tR === 0 ? e.p1 : e.p2;
      head(base[0], base[1], role, e.e1.k, e.e2.k, LBK.EDGE_STRIP, sig);
      v[o + 7] = e.e1.nN[0];
      v[o + 8] = e.e1.nN[1];
      v[o + 9] = e.e2.nN[0];
      v[o + 10] = e.e2.nN[1];
      // The corners' shared partition planes: aC1 = (normal A, normal B),
      // aC2 = (point A, point B), zero where the strip keeps its own plane.
      v[o + 11] = cwA[0];
      v[o + 12] = cwA[1];
      v[o + 13] = cwB[0];
      v[o + 14] = cwB[1];
      v[o + 15] = ccA[0];
      v[o + 16] = ccA[1];
      v[o + 17] = ccB[0];
      v[o + 18] = ccB[1];
      v[o + 19] = e.p1[0];
      v[o + 20] = e.p1[1];
      v[o + 21] = e.p2[0];
      v[o + 22] = e.p2[1];
      v[o + 23] = packed;
      o += LB_VERT_FLOATS;
    };
    sv10(0);
    sv10(1);
    sv10(3);
    sv10(0);
    sv10(3);
    sv10(2);
  };
  for (const e of edges) {
    if (e.e1 && e.e2) strip10(e);
  }
  // Circular-SDF disc: DISC, disc mode (aC3.w = −1). One bbox quad; the fragment
  // computes f = sign·(length(em−center)−r) and slugCov AA's it — exact, seam-free.
  // Elliptical disc: aC3.w = −2, aC3.z = rx, aC0 = (ry, cosφ, sinφ, 0); unit-circle
  // pullback level set with screen-space derivatives (same slugCov path).
  // Quad dilated past the outline to hold the outer AA band.
  const disc = (px, py, c) => {
    if (c.rx != null) {
      head(px, py, 0, 0, 0, LBK.DISC, 1);
      v[o + 7] = c.ry;
      v[o + 8] = Math.cos(c.phi || 0);
      v[o + 9] = Math.sin(c.phi || 0);
      v[o + 10] = 0;
      v[o + 19] = c.cx;
      v[o + 20] = c.cy;
      v[o + 21] = c.rx;
      v[o + 22] = -2;
    } else {
      head(px, py, 0, 0, 0, LBK.DISC, 1);
      v[o + 19] = c.cx;
      v[o + 20] = c.cy;
      v[o + 21] = c.r;
      v[o + 22] = -1;
    }
    o += LB_VERT_FLOATS;
  };
  for (const c of circles) {
    let H;
    if (c.rx != null) {
      const ca = Math.abs(Math.cos(c.phi || 0)),
        sa = Math.abs(Math.sin(c.phi || 0));
      const Hx = c.rx * ca + c.ry * sa,
        Hy = c.rx * sa + c.ry * ca;
      H = 1.2 * Math.max(Hx, Hy);
    } else {
      // No flat pad. The quad has to hold the disc plus its outer AA band, and that band is a
      // PIXEL wide -- not a fixed number of em -- so a constant here is the wrong size at every
      // zoom but one, and it makes the same disc a different quad at different authoring scales.
      // 1.2x the radius holds the disc; the band is pushed in the VERTEX SHADER, which is where
      // em-per-pixel is known (see the DISC branch in _lbVertexSetup.glsl).
      H = 1.2 * c.r;
    }
    const x0 = c.cx - H,
      x1 = c.cx + H,
      y0 = c.cy - H,
      y1 = c.cy + H;
    disc(x0, y0, c);
    disc(x1, y0, c);
    disc(x1, y1, c);
    disc(x0, y0, c);
    disc(x1, y1, c);
    disc(x0, y1, c);
  }
  // Concentric-ring disc: DISC ring mode. aC3 = (cx, cy, rMid, halfW ≥ 0).
  const ring = (px, py, a) => {
    head(px, py, 0, 0, 0, LBK.DISC, 1);
    v[o + 19] = a.cx;
    v[o + 20] = a.cy;
    v[o + 21] = a.rMid;
    v[o + 22] = a.halfW;
    o += LB_VERT_FLOATS;
  };
  for (const a of annuli) {
    const H = 1.2 * (a.rMid + a.halfW),
      x0 = a.cx - H,
      x1 = a.cx + H,
      y0 = a.cy - H,
      y1 = a.cy + H;
    ring(x0, y0, a);
    ring(x1, y0, a);
    ring(x1, y1, a);
    ring(x0, y0, a);
    ring(x1, y1, a);
    ring(x0, y1, a);
  }
  // Curve band (CURVE_BAND): 4 verts (a, b on the boundary + their outward-pushed twins) as
  // 2 tris, or a fat ring (15 verts). aC3 = (a.xy, b.xy) span; aTC = (Ũ,Ṽ,R).
  // Push verts carry aC0 = (n̂.xy, Δuv.xy); base verts aC0 = 0.
  for (const q of curveStripQuads) {
    const ax = q.tri[0],
      ay = q.tri[1],
      cx = q.tri[2],
      cy = q.tri[3],
      bx = q.tri[4],
      by = q.tri[5];
    // Affine map (em → uv) from the control triangle: uv(a)=(0,0), uv(ctrl)=(½,0), uv(b)=(1,1).
    const e1x = cx - ax,
      e1y = cy - ay,
      e2x = bx - ax,
      e2y = by - ay;
    const det = e1x * e2y - e1y * e2x;
    if (
      !(Math.abs(det) > 1e-12 * Math.sqrt((e1x * e1x + e1y * e1y) * (e2x * e2x + e2y * e2y))) ||
      !isBand12(q)
    )
      continue;
    const i11 = e2y / det,
      i12 = -e2x / det,
      i21 = -e1y / det,
      i22 = e1x / det; // inverse em basis
    const Jux = 0.5 * i11 + 1 * i21,
      Juy = 0.5 * i12 + 1 * i22; // ∇u (em) integral
    const Jvx = 0 * i11 + 1 * i21,
      Jvy = 0 * i12 + 1 * i22; // ∇v (em) integral
    {
      // UNIFIED BAND (CURVE_BAND): exterior footprint + end machinery. Slot plan:
      //   aTC=(Ũ,Ṽ,R) · aC3=(a.xy,b.xy) · aC0=push (n̂, Δuv)
      //   aC1=(nA,nB) · aC2=(packHalf(nOwnA), packHalf(nOwnB), κA, κB)
      //   |aSign|=4096+2048·spanB+1024·spanA+16·codeA+codeB
      // κ rides mixed aC2.zw so morph-pair t lerps curvatures (aSeamM is A-only).
      // Homogeneous frame: a=(0,0,1), ctrl=(½/w,0,1/w), b=(1,1,1). Integral w≡1 → R≡1.
      const iw = 1 / (q.w || 1);
      const Uc = 0.5 * iw,
        Rc = iw;
      const Hux = Uc * i11 + 1 * i21,
        Huy = Uc * i12 + 1 * i22;
      const Hvx = Jvx,
        Hvy = Jvy;
      const Hrx = (Rc - 1) * i11,
        Hry = (Rc - 1) * i12;
      let nOAx = -q.sign * Hvx,
        nOAy = -q.sign * Hvy;
      let L12 = Math.hypot(nOAx, nOAy) || 1;
      nOAx /= L12;
      nOAy /= L12;
      let nOBx = q.sign * (2 * Hux - Hvx - Hrx),
        nOBy = q.sign * (2 * Huy - Hvy - Hry);
      L12 = Math.hypot(nOBx, nOBy) || 1;
      nOBx /= L12;
      nOBy /= L12;
      let sAx = cx - ax,
        sAy = cy - ay;
      L12 = Math.hypot(sAx, sAy) || 1;
      sAx /= L12;
      sAy /= L12;
      let sBx = cx - bx,
        sBy = cy - by;
      L12 = Math.hypot(sBx, sBy) || 1;
      sBx /= L12;
      sBy /= L12;
      const spanA = -nOAy * sAx + nOAx * sAy > 0 ? 1 : 0;
      const spanB = -nOBy * sBx + nOBx * sBy > 0 ? 1 : 0;
      const { codeA, codeB } = band12EndCodes(q.e1, q.e2);
      const sgn12 = q.sign * (4096 + 2048 * spanB + 1024 * spanA + 16 * codeA + codeB);
      // κA/κB ride aC2.zw (mixed under morph); nOwn packed as half in aC2.xy.
      // aSeamM stays 0 — it is A-stream-only on the morph pair VS.
      const nOwnPackA = packHalf2x16(nOAx, nOAy),
        nOwnPackB = packHalf2x16(nOBx, nOBy);
      // R is affine in the plane, and so is U - V; both vanish... a = (0,0,1) and b = (1,1,1) share R = 1, and the control point
      // (1/(2w), 0, 1/w) closes the relation R = 1 + 2(1 - w)(U - V). A vertex pushed by d moves U and V by Hu.d and Hv.d (packed
      // above) and R by 2(1 - w) times their difference: slot 23 carries the factor so the vertex stage pushes R with them
      // (an integral quad, w = 1, moves none).
      const rPush12 = 2 * (1 - (q.w || 1));
      const sv12 = (px, py, u, vv, r, dxs, dys) => {
        head(px, py, u, vv, r, LBK.CURVE_BAND, sgn12);
        v[o + 7] = dxs;
        v[o + 8] = dys;
        v[o + 9] = Hux * dxs + Huy * dys;
        v[o + 10] = Hvx * dxs + Hvy * dys;
        writeBand12Ends(
          v,
          o,
          q.e1,
          q.e2,
          nOwnPackA,
          nOwnPackB,
          band12EndKappa(q.e1),
          band12EndKappa(q.e2),
          ax,
          ay,
          bx,
          by,
        );
        v[o + 23] = rPush12;
        o += LB_VERT_FLOATS;
      };
      const ovx0 = -q.sign * Hvx,
        ovy0 = -q.sign * Hvy;
      const ovL = Math.hypot(ovx0, ovy0) || 1,
        ovx = ovx0 / ovL,
        ovy = ovy0 / ovL;
      const ctrlSide12 = (cx - (ax + bx) / 2) * ovx + (cy - (ay + by) / 2) * ovy > 0;
      if (stripFat(q)) {
        const UV = { a: [0, 0, 1], c: [Uc, 0, Rc], b: [1, 1, 1] };
        const ring12 = (P0, uv0, P1, uv1, T3) => {
          let nx = -(P1[1] - P0[1]),
            ny = P1[0] - P0[0];
          const nL = Math.hypot(nx, ny) || 1;
          nx /= nL;
          ny /= nL;
          if (nx * (T3[0] - P0[0]) + ny * (T3[1] - P0[1]) > 0) {
            nx = -nx;
            ny = -ny;
          }
          const el = Math.hypot(P1[0] - P0[0], P1[1] - P0[1]) || 1;
          const tx9 = (P1[0] - P0[0]) / el,
            ty9 = (P1[1] - P0[1]) / el;
          sv12(P0[0], P0[1], uv0[0], uv0[1], uv0[2], 0, 0);
          sv12(P1[0], P1[1], uv1[0], uv1[1], uv1[2], 0, 0);
          sv12(P1[0], P1[1], uv1[0], uv1[1], uv1[2], nx + tx9, ny + ty9);
          sv12(P0[0], P0[1], uv0[0], uv0[1], uv0[2], 0, 0);
          sv12(P1[0], P1[1], uv1[0], uv1[1], uv1[2], nx + tx9, ny + ty9);
          sv12(P0[0], P0[1], uv0[0], uv0[1], uv0[2], nx - tx9, ny - ty9);
          return [nx, ny];
        };
        if (!ctrlSide12) {
          ring12([ax, ay], UV.a, [bx, by], UV.b, [cx, cy]);
        } else {
          const n1 = ring12([ax, ay], UV.a, [cx, cy], UV.c, [bx, by]);
          const n2 = ring12([cx, cy], UV.c, [bx, by], UV.b, [ax, ay]);
          sv12(cx, cy, UV.c[0], UV.c[1], UV.c[2], 0, 0);
          sv12(cx, cy, UV.c[0], UV.c[1], UV.c[2], n1[0], n1[1]);
          sv12(cx, cy, UV.c[0], UV.c[1], UV.c[2], n2[0], n2[1]);
        }
      } else {
        const bx0 = Math.min(ax, cx, bx),
          by0 = Math.min(ay, cy, by);
        const bx1 = Math.max(ax, cx, bx),
          by1 = Math.max(ay, cy, by);
        const uOf = (px, py) => {
          const relx = px - ax,
            rely = py - ay;
          return [Hux * relx + Huy * rely, Hvx * relx + Hvy * rely, 1 + Hrx * relx + Hry * rely];
        };
        const fp = tightOf(q);
        if (fp) {
          for (const [px, py, dx, dy] of fp) {
            const uvT = uOf(px, py);
            sv12(px, py, uvT[0], uvT[1], uvT[2], dx, dy);
          }
        } else {
          let uv;
          uv = uOf(bx0, by0);
          sv12(bx0, by0, uv[0], uv[1], uv[2], -1, -1);
          uv = uOf(bx1, by0);
          sv12(bx1, by0, uv[0], uv[1], uv[2], 1, -1);
          uv = uOf(bx1, by1);
          sv12(bx1, by1, uv[0], uv[1], uv[2], 1, 1);
          uv = uOf(bx0, by0);
          sv12(bx0, by0, uv[0], uv[1], uv[2], -1, -1);
          uv = uOf(bx1, by1);
          sv12(bx1, by1, uv[0], uv[1], uv[2], 1, 1);
          uv = uOf(bx0, by1);
          sv12(bx0, by1, uv[0], uv[1], uv[2], -1, 1);
        }
      }
      hasBezout = true;
    }
  }
  // KIND-13 thin chain strips (piece tier → reject the solid interior where drawn).
  // Each vert carries its edge's chain: P0,P1 → aC3.xy/zw, P2,P3 → aC0.xy/zw.
  if (chainStripVerts) {
    for (let i = 0, c = 0; i < chainStripVerts.length; i += 2, c += 4) {
      head(chainStripVerts[i], chainStripVerts[i + 1], 0, 0, 0, LBK.CHAIN_STRIP, 0);
      v[o + 19] = chainStripA[c];
      v[o + 20] = chainStripA[c + 1];
      v[o + 21] = chainStripA[c + 2];
      v[o + 22] = chainStripA[c + 3];
      v[o + 7] = chainStripB[c];
      v[o + 8] = chainStripB[c + 1];
      v[o + 9] = chainStripB[c + 2];
      v[o + 10] = chainStripB[c + 3];
      o += LB_VERT_FLOATS;
    }
  }
  emitInterior9();
  // Trim slack so GL uploads and mem accounting match the draw count exactly.
  // Never report a vertexCount past the buffer — TypedArray length is the
  // source of truth (grow should have kept them equal; this is the last gate).
  const verts = o === v.length ? v : v.slice(0, o);
  let vc = (o / LB_VERT_FLOATS) | 0;
  const maxVc = (verts.length / LB_VERT_FLOATS) | 0;
  if (vc > maxVc) vc = maxVc;
  if (vc > LB_MAX_VERTS_PER_MESH) {
    if (typeof console !== 'undefined') {
      console.warn(
        '[mantle] LB mesh budget: shape has ' +
          vc +
          ' verts (cap ' +
          LB_MAX_VERTS_PER_MESH +
          ') — rendering via Slug.',
      );
    }
    return {
      verts: new Float32Array(0),
      vertexCount: 0,
      fallback: mesh.fallback,
      hasBezout: false,
      hasCubicChain: false,
      kindMask: 0,
      overBudget: true,
    };
  }
  // ...and the caller's own byte budget, asked at the place the bytes are spent. It reports HOW
  // Much it wanted rather than only that it refused: a budget that declines silently is how a
  // bundle ends up quietly on Slug with nothing to tune against (the same reason cpatchConvStalled
  // is a number and not a log line). `overBudget` too, so every existing caller already Slugs it.
  const wantBytes = lbVertexBytes(vc);
  if (wantBytes > _shapeMemBudget) {
    return {
      verts: new Float32Array(0),
      vertexCount: 0,
      fallback: mesh.fallback,
      hasBezout: false,
      hasCubicChain: false,
      kindMask: 0,
      overBudget: true,
      overMemory: true,
      wantBytes,
    };
  }
  //
  // A whole-shape circle, ellipse or annulus is not Loop-Blinn geometry -- it is an SDF primitive
  // that buildLoopBlinnMesh happens to be the one asking for. Crediting it to `lb` makes a ranking
  // read as "LB is fast on circles" when what happened is that the shape was recognized and never
  // decomposed by anyone. kindMask cannot tell: DISC (7) is also emitted for circular-arc
  // CRESCENTS, which are ordinary pieces of a normal decomposition. What distinguishes a primitive
  // is that the mesh is only records -- no interior, quads, cubics or edges.
  const primOnly =
    !!((mesh.circles && mesh.circles.length) || (mesh.annuli && mesh.annuli.length)) &&
    !(mesh.interior && mesh.interior.length) &&
    !(mesh.quads && mesh.quads.length) &&
    !(mesh.cubics && mesh.cubics.length) &&
    !(mesh.edges && mesh.edges.length);
  return {
    verts,
    vertexCount: vc,
    fallback: mesh.fallback,
    kindMask,
    prim: primOnly,
    hasBezout: hasBezout || !!mesh.interiorHasChain2,
    hasCubicChain,
  };
}
