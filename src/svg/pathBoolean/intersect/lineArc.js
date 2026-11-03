// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lineArc — intersect a line with a SEG_ARC (rotated elliptical arc).
//
// Arc: a(θ) = c + cos(φ)·rx·cos(θ) - sin(φ)·ry·sin(θ),
//             c + sin(φ)·rx·cos(θ) + cos(φ)·ry·sin(θ)
// for θ in [theta_start, theta_end].
//
// Transform the line into the arc's local frame (centered at (cx,cy),
// rotated by -φ, scaled by 1/rx in x and 1/ry in y). In that frame
// the arc becomes the unit circle, and the line becomes another line.
// Intersect line with unit circle (closed form), filter for in-range
// angles, transform back.

const EPS = 1e-9;
const TWO_PI = Math.PI * 2;

export function intersectLineArc(aP1, aP2, arc) {
  // Transform a's endpoints into arc-local frame:
  //   p_local = R(-φ) · (p - c) then componentwise divide by (rx, ry).
  const { cx, cy, rx, ry, phi, theta_start: t0, theta_end: t1 } = arc;
  if (rx < EPS || ry < EPS) return [];
  const cp = Math.cos(phi),
    sp = Math.sin(phi);
  const toLocal = (p) => {
    const dx = p[0] - cx,
      dy = p[1] - cy;
    return [(cp * dx + sp * dy) / rx, (-sp * dx + cp * dy) / ry];
  };
  const a0L = toLocal(aP1);
  const a1L = toLocal(aP2);
  // Line in local frame: q(t) = a0L + t·(a1L - a0L). Substitute into
  // |q|² = 1 → quadratic in t, A2·t² + A1·t + A0 = 0:
  //   (Dx² + Dy²)·t² + 2·(a0L · D)·t + (|a0L|² - 1) = 0
  // where D = a1L - a0L.
  const Dx = a1L[0] - a0L[0];
  const Dy = a1L[1] - a0L[1];
  const A2 = Dx * Dx + Dy * Dy;

  if (!(A2 > 0)) return [];
  const tStar = -(a0L[0] * Dx + a0L[1] * Dy) / A2;
  const mx = a0L[0] + tStar * Dx,
    my = a0L[1] + tStar * Dy;
  const h2 = 1 - (mx * mx + my * my); // (half-chord / radius)², the tangency is h2 = 0
  if (h2 < -EPS) return []; // line doesn't meet the (extended) circle
  const half = Math.sqrt(Math.max(0, h2) / A2);
  const tCandidates = h2 < EPS ? [tStar] : [tStar - half, tStar + half];

  const out = [];
  // World-space line parametric direction for back-projecting tA.
  const wx = aP2[0] - aP1[0];
  const wy = aP2[1] - aP1[1];
  const wLen2 = wx * wx + wy * wy;
  if (!(wLen2 > 0)) return []; // a divide guard, as A2 above

  // Arc sweep direction. theta sweeps from t0 to t1; t1 may be less
  // than t0 for sweep=0 SVG arcs (dtheta negative). Caller's
  // arcInRange semantics — replicate them here.
  const sweep = t1 - t0;
  const tLo = Math.min(t0, t1);
  const tHi = Math.max(t0, t1);

  for (const tParam of tCandidates) {
    if (tParam < -EPS || tParam > 1 + EPS) continue;
    const tC = Math.max(0, Math.min(1, tParam));
    // Local intersection point.
    const lx = a0L[0] + tC * Dx;
    const ly = a0L[1] + tC * Dy;
    // Angle on the unit circle.
    let theta = Math.atan2(ly, lx);
    // Bring theta into the arc's sweep range. If sweep > 0
    // (theta_end > theta_start), accept theta in [t0, t1] possibly
    // shifted by ±2π. Same for sweep < 0.
    let normalized = theta;
    while (normalized < tLo - EPS) normalized += TWO_PI;
    while (normalized > tHi + EPS) normalized -= TWO_PI;
    if (normalized < tLo - EPS || normalized > tHi + EPS) continue;
    // tB parameter on the arc: position along sweep ∈ [0, 1].
    const tB = sweep === 0 ? 0 : (normalized - t0) / sweep;
    if (tB < -EPS || tB > 1 + EPS) continue;
    // World-space point: transform local back to world.
    const wXL = lx * rx;
    const wYL = ly * ry;
    const x = cp * wXL - sp * wYL + cx;
    const y = sp * wXL + cp * wYL + cy;
    // World tA via projection.
    const tA = ((x - aP1[0]) * wx + (y - aP1[1]) * wy) / wLen2;
    if (tA < -EPS || tA > 1 + EPS) continue;
    const tAC = Math.max(0, Math.min(1, tA));
    const tBC = Math.max(0, Math.min(1, tB));
    out.push({
      tA: tAC,
      tB: tBC,
      x,
      y,
      endpointA: tAC < EPS || tAC > 1 - EPS,
      endpointB: tBC < EPS || tBC > 1 - EPS,
    });
  }
  return out;
}
