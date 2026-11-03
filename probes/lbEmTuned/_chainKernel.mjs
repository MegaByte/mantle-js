// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _chainKernel — chainBoxCov, ported term for term from src/shaders/_boxCov.glsl.
//
// WHY this EXISTS. The first GPU prediction for the em-tuned-length fix was wrong by 8x because it
// modelled the chain's GEOMETRY (how far the n-piece polyline lies from the true arc) instead of the
// chain KERNEL'S INPUT. The kernel does not see the polyline: it sees a FIVE-POINT WINDOW onto it,
// clips that window to the pixel box, and closes the polygon along the box border -- and when the
// window does not cross the box it falls to miss modes (a tangent extension to the border, the
// nearest segment's infinite line, or a flat 1.0). Those are discrete, and no bound on the polyline's
// sagitta bounds them. This is the kernel itself, so a prediction made with it can be checked.
//
// Ported: bparamOf, cornerOf, chainFillSide, chainMissCov, chainBoxCov, and exactBoxCov (as an exact
// polygon clip, which is what the shader's closed form computes). There is no conic chain.
//
// NOT THE SHADER'S current CLOSURE: the shader closes the border at every gap between runs (by border sums) and
// treats a zero-length clip as a touch; this copy walks only the wrap. It is kept as the model the em-tuned studies
// measured with, and is not the twin's cross-check (_kernelSelfTest checks chainBoxCov against the exact area instead).
//
// Not bit-exact with the GPU: this runs in float64 where the shader runs in float32, and the shader's
// own early-out epsilons (1e-4 border tests, 1e-9 clip guards) are kept verbatim, so a fragment
// sitting exactly on one of them can differ. Everything else is the same arithmetic in the same order.

/// Area of the unit box [-1/2,1/2]^2 on the side n.p <= c, by Sutherland-Hodgman + shoelace.
export function exactBoxCov(nx, ny, c) {
  let poly = [
    [-0.5, -0.5],
    [0.5, -0.5],
    [0.5, 0.5],
    [-0.5, 0.5],
  ];
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const A = poly[i],
      B = poly[(i + 1) % poly.length];
    const fa = nx * A[0] + ny * A[1] - c,
      fb = nx * B[0] + ny * B[1] - c;
    if (fa <= 0) out.push(A);
    if (fa <= 0 !== fb <= 0) {
      const u = fa / (fa - fb);
      out.push([A[0] + u * (B[0] - A[0]), A[1] + u * (B[1] - A[1])]);
    }
  }
  let a = 0;
  for (let i = 0; i < out.length; i++) {
    const q = out[(i + 1) % out.length];
    a += out[i][0] * q[1] - q[0] * out[i][1];
  }
  return Math.min(1, Math.max(0, Math.abs(a) * 0.5));
}

const bparamOf = (p) => {
  if (Math.abs(p[1] + 0.5) < 1e-4) return Math.min(1, Math.max(0, p[0] + 0.5));
  if (Math.abs(p[0] - 0.5) < 1e-4) return 1 + Math.min(1, Math.max(0, p[1] + 0.5));
  if (Math.abs(p[1] - 0.5) < 1e-4) return 2 + Math.min(1, Math.max(0, 0.5 - p[0]));
  return 3 + Math.min(1, Math.max(0, 0.5 - p[1]));
};
const cornerOf = (j) =>
  j === 0 ? [0.5, -0.5] : j === 1 ? [0.5, 0.5] : j === 2 ? [-0.5, 0.5] : [-0.5, -0.5];

export function chainFillSide(P) {
  let best = 1e30,
    side = true;
  for (let s = 0; s < 4; s++) {
    const A = P[s],
      B = P[s + 1];
    const dx = B[0] - A[0],
      dy = B[1] - A[1],
      L2 = dx * dx + dy * dy;
    if (L2 < 1e-20) continue;
    const t = Math.min(1, Math.max(0, (-A[0] * dx - A[1] * dy) / L2));
    const cx = A[0] + t * dx,
      cy = A[1] + t * dy,
      dd = cx * cx + cy * cy;
    if (dd < best) {
      best = dd;
      side = dy * A[0] - dx * A[1] >= 0;
    }
  }
  return side;
}

export function chainMissCov(P) {
  let best = 1e30,
    bA = [0, 0],
    bd = [0, 0],
    found = false,
    bs = -1,
    firstS = 9,
    lastS = -1,
    bt = 0;
  for (let s = 0; s < 4; s++) {
    const A = P[s],
      B = P[s + 1];
    const dx = B[0] - A[0],
      dy = B[1] - A[1],
      L2 = dx * dx + dy * dy;
    if (L2 < 1e-20) continue;
    if (s < firstS) firstS = s;
    lastS = s;
    const tu = (-A[0] * dx - A[1] * dy) / L2;
    const t = Math.min(1, Math.max(0, tu));
    const cx = A[0] + t * dx,
      cy = A[1] + t * dy,
      dd = cx * cx + cy * cy;
    if (dd < best) {
      best = dd;
      bA = A;
      bd = [dx, dy];
      found = true;
      bs = s;
      bt = tu;
    }
  }
  if (!found || best > 2.0) return -1; // far: no opinion
  if ((bt < 0 && bs === firstS) || (bt > 1 && bs === lastS)) return -1; // past a TERMINAL: no opinion
  const L = Math.hypot(bd[1], -bd[0]) || 1;
  const nx = bd[1] / L,
    ny = -bd[0] / L;
  return exactBoxCov(nx, ny, nx * bA[0] + ny * bA[1]);
}

/// area(box INTERSECT fill), fill = LEFT of the chain p0->p1->p2->p3->p4, in CELL coordinates.
/// forceInside: 2 = the face's own chain (linear-miss mode), 1 = an auxiliary chain, 0 = strip mode.
export function chainBoxCov(P, forceInside) {
  {
    // exact early out on the chain's bbox
    let lox = Infinity,
      loy = Infinity,
      hix = -Infinity,
      hiy = -Infinity;
    for (const p of P) {
      if (p[0] < lox) lox = p[0];
      if (p[0] > hix) hix = p[0];
      if (p[1] < loy) loy = p[1];
      if (p[1] > hiy) hiy = p[1];
    }
    const m = forceInside > 1.5 ? 1.414215 : 0.500001;
    if (hix < -m || lox > m || hiy < -m || loy > m)
      return forceInside > 0.5 ? 1.0 : chainFillSide(P) ? 1.0 : 0.0;
  }
  const poly = [];
  let X = [0, 0];
  for (let s = 0; s < 4; s++) {
    const A = P[s],
      B = P[s + 1];
    const dx = B[0] - A[0],
      dy = B[1] - A[1];
    if (dx * dx + dy * dy < 1e-12) continue; // degenerate padding segment
    const lox = Math.min(A[0], B[0]),
      hix = Math.max(A[0], B[0]);
    const loy = Math.min(A[1], B[1]),
      hiy = Math.max(A[1], B[1]);
    if (hix < -0.500001 || lox > 0.500001 || hiy < -0.500001 || loy > 0.500001) continue;
    let t0 = 0,
      t1 = 1,
      ok = true; // Liang-Barsky
    for (let k = 0; k < 4; k++) {
      const Pk = k === 0 ? -dx : k === 1 ? dx : k === 2 ? -dy : dy;
      const Qk = k === 0 ? A[0] + 0.5 : k === 1 ? 0.5 - A[0] : k === 2 ? A[1] + 0.5 : 0.5 - A[1];
      if (Math.abs(Pk) < 1e-12) {
        if (Qk < 0) ok = false;
      } else {
        const r = Qk / Pk;
        if (Pk < 0) {
          if (r > t1) ok = false;
          else if (r > t0) t0 = r;
        } else {
          if (r < t0) ok = false;
          else if (r < t1) t1 = r;
        }
      }
    }
    if (!ok || t1 < t0) continue;
    const A2 = [A[0] + t0 * dx, A[1] + t0 * dy],
      B2 = [A[0] + t1 * dx, A[1] + t1 * dy];
    if (poly.length === 0) poly.push(A2);
    else {
      const L = poly[poly.length - 1];
      if ((L[0] - A2[0]) ** 2 + (L[1] - A2[1]) ** 2 > 1e-10 && poly.length < 12) poly.push(A2);
    }
    if (poly.length < 12) poly.push(B2);
    X = B2;
  }
  let n = poly.length;
  if (n < 2) {
    if (forceInside > 1.5) {
      const mc = chainMissCov(P);
      return mc < 0 ? 1.0 : mc;
    }
    return forceInside > 0.5 || chainFillSide(P) ? 1.0 : 0.0;
  }
  {
    // ENDS-ON-BORDER: extend an interior endpoint along its terminal segment's direction
    const dEx = poly[n - 1][0] - poly[n - 2][0],
      dEy = poly[n - 1][1] - poly[n - 2][1];
    if (
      Math.max(Math.abs(poly[n - 1][0]), Math.abs(poly[n - 1][1])) < 0.5 - 1e-4 &&
      dEx * dEx + dEy * dEy > 1e-12 &&
      n < 12
    ) {
      const L = Math.hypot(dEx, dEy),
        dnx = dEx / L,
        dny = dEy / L;
      const tx = Math.abs(dnx) > 1e-6 ? ((dnx > 0 ? 0.5 : -0.5) - poly[n - 1][0]) / dnx : 1e9;
      const ty = Math.abs(dny) > 1e-6 ? ((dny > 0 ? 0.5 : -0.5) - poly[n - 1][1]) / dny : 1e9;
      const t = Math.min(tx, ty);
      poly.push([poly[n - 1][0] + dnx * t, poly[n - 1][1] + dny * t]);
      n++;
      X = poly[n - 1];
    }
    const dBx = poly[1][0] - poly[0][0],
      dBy = poly[1][1] - poly[0][1];
    if (
      Math.max(Math.abs(poly[0][0]), Math.abs(poly[0][1])) < 0.5 - 1e-4 &&
      dBx * dBx + dBy * dBy > 1e-12 &&
      n < 12
    ) {
      const L = Math.hypot(dBx, dBy),
        dnx = -dBx / L,
        dny = -dBy / L;
      const tx = Math.abs(dnx) > 1e-6 ? ((dnx > 0 ? 0.5 : -0.5) - poly[0][0]) / dnx : 1e9;
      const ty = Math.abs(dny) > 1e-6 ? ((dny > 0 ? 0.5 : -0.5) - poly[0][1]) / dny : 1e9;
      const t = Math.min(tx, ty);
      poly.unshift([poly[0][0] + dnx * t, poly[0][1] + dny * t]);
      n++;
    }
  }
  const E = poly[0];
  const dXx = poly[n - 1][0] - poly[n - 2][0],
    dXy = poly[n - 1][1] - poly[n - 2][1];
  const leftN = [-dXy, dXx];
  let tCCW;
  if (Math.abs(X[1] + 0.5) < 1e-4 && X[0] < 0.5 - 1e-4) tCCW = [1, 0];
  else if (Math.abs(X[0] - 0.5) < 1e-4 && X[1] < 0.5 - 1e-4) tCCW = [0, 1];
  else if (Math.abs(X[1] - 0.5) < 1e-4 && X[0] > -0.5 + 1e-4) tCCW = [-1, 0];
  else tCCW = [0, -1];
  const ccw = tCCW[0] * leftN[0] + tCCW[1] * leftN[1] >= 0;
  const pa = bparamOf(X),
    pb = bparamOf(E);
  if (ccw) {
    const pbW = pb < pa ? pb + 4 : pb;
    for (let j = 0; j < 8; j++) {
      const cp = j + 1;
      if (cp > pa + 1e-5 && cp < pbW - 1e-5 && n < 12) {
        poly.push(cornerOf(j % 4));
        n++;
      }
    }
  } else {
    const pbW = pb > pa ? pb - 4 : pb;
    for (let j = 7; j >= 0; j--) {
      const cp = j + 1 - 4;
      if (cp < pa - 1e-5 && cp > pbW + 1e-5 && n < 12) {
        poly.push(cornerOf(j % 4));
        n++;
      }
    }
  }
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = poly[i],
      b = poly[i + 1 === n ? 0 : i + 1];
    area += a[0] * b[1] - a[1] * b[0];
  }
  return Math.min(1, Math.max(0, Math.abs(area) * 0.5));
}
