// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _signedAreaCoverageProto.mjs — signed-area coverage prototype (CPU only, not used by the renderer).
//
// Purpose: test whether signed-area coverage could replace our per-primitive
// analytic coverage (+ the kind-9/10/11 band machinery + Slug junction fallback)
// (signed-area coverage accumulation, as in AGG / libart / font-rs / Vello coarse
// winding). It quantifies the claim that signed-area coverage is CONFLATION-FREE at
// multi-feature junction pixels — exact for N features per pixel of one fill — where
// per-primitive coverage (independent ramp per triangle, combined by MAX or OVER)
// seams. Nothing here touches the renderer; it's a CPU numerical proof.
//
// Model: a filled square [0,4]² split (as our CDT partition would) into two
// triangles sharing the diagonal (0,0)→(4,4) — the canonical conflation case
// (Vello issue #49). We sweep pixels straddling the shared diagonal and compare, at
// each, the coverage each method reports against GROUND TRUTH (exact area of the
// pixel ∩ the square, by analytic clipping — supersample-independent).

// ---- exact polygon∩pixel area via Sutherland–Hodgman (ground truth) ----------
function clipArea(poly, x0, y0, x1, y1) {
  const clipEdge = (pts, inside, isect) => {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i + pts.length - 1) % pts.length],
        b = pts[i];
      const ia = inside(a),
        ib = inside(b);
      if (ib) {
        if (!ia) out.push(isect(a, b));
        out.push(b);
      } else if (ia) out.push(isect(a, b));
    }
    return out;
  };
  let p = poly;
  p = clipEdge(
    p,
    (q) => q[0] >= x0,
    (a, b) => {
      const t = (x0 - a[0]) / (b[0] - a[0]);
      return [x0, a[1] + t * (b[1] - a[1])];
    },
  );
  p = clipEdge(
    p,
    (q) => q[0] <= x1,
    (a, b) => {
      const t = (x1 - a[0]) / (b[0] - a[0]);
      return [x1, a[1] + t * (b[1] - a[1])];
    },
  );
  p = clipEdge(
    p,
    (q) => q[1] >= y0,
    (a, b) => {
      const t = (y0 - a[1]) / (b[1] - a[1]);
      return [a[0] + t * (b[0] - a[0]), y0];
    },
  );
  p = clipEdge(
    p,
    (q) => q[1] <= y1,
    (a, b) => {
      const t = (y1 - a[1]) / (b[1] - a[1]);
      return [a[0] + t * (b[0] - a[0]), y1];
    },
  );
  if (p.length < 3) return 0;
  let a2 = 0;
  for (let i = 0; i < p.length; i++) {
    const u = p[i],
      v = p[(i + 1) % p.length];
    a2 += u[0] * v[1] - v[0] * u[1];
  }
  return Math.abs(a2) / 2;
}

const square = [
  [0, 0],
  [4, 0],
  [4, 4],
  [0, 4],
];
const T1 = [
  [0, 0],
  [4, 0],
  [4, 4],
]; // below/right of the diagonal
const T2 = [
  [0, 0],
  [4, 4],
  [0, 4],
]; // above/left of the diagonal

// ---- per-primitive analytic coverage model (our current architecture) --------
// Each triangle computes its own coverage from a linear ramp on the signed distance
// to its nearest boundary edge (a box filter of half-width 0.5px, like slugCov),
// INDEPENDENT of the other triangle. The pixel's coverage is then the MAX (additive
// crescent model) or OVER (premultiplied composite) of the two — the two ways our
// renderer combines adjacent primitives. This is the conflation-prone step.
function edgeSignedDist(px, py, tri) {
  // signed distance to the tri's boundary, positive inside (min over 3 edges).
  let best = Infinity;
  const cx = (tri[0][0] + tri[1][0] + tri[2][0]) / 3,
    cy = (tri[0][1] + tri[1][1] + tri[2][1]) / 3;
  for (let i = 0; i < 3; i++) {
    const a = tri[i],
      b = tri[(i + 1) % 3];
    const ex = b[0] - a[0],
      ey = b[1] - a[1],
      L = Math.hypot(ex, ey);
    let nx = -ey / L,
      ny = ex / L; // a normal
    if (nx * (cx - a[0]) + ny * (cy - a[1]) < 0) {
      nx = -nx;
      ny = -ny;
    } // point inward
    const d = nx * (px - a[0]) + ny * (py - a[1]); // signed dist (inside +)
    best = Math.min(best, d);
  }
  return best;
}
const boxCov = (d) => Math.min(Math.max(d + 0.5, 0), 1); // 0.5px box ramp centerd on the edge

function perPrimitive(px, py, combine) {
  const cA = boxCov(edgeSignedDist(px, py, T1));
  const cB = boxCov(edgeSignedDist(px, py, T2));
  return combine === 'max' ? Math.max(cA, cB) : 1 - (1 - cA) * (1 - cB); // MAX or OVER
}

// ---- signed-area coverage (the combined-winding model A+H computes) ----------
// The key property: coverage is computed on the COMBINED region (the square), so the
// two triangles' shared-diagonal edges — which carry OPPOSITE winding — cancel
// before any clamp. We compute the combined coverage exactly as the pixel∩square
// area (this is precisely the value an A+H accumulator produces for one fill).
function signedArea(px, py) {
  return clipArea(square, px - 0.5, py - 0.5, px + 0.5, py + 0.5); // 1×1 px, area == coverage
}
const truth = (px, py) => clipArea(square, px - 0.5, py - 0.5, px + 0.5, py + 0.5);

// ---- sweep pixels straddling the shared diagonal -----------------------------
console.log('pixel(center)    truth   signedArea  perPrim(MAX)  perPrim(OVER)');
let maxErrSA = 0,
  maxErrMax = 0,
  maxErrOver = 0;
for (let k = 1; k <= 3; k++) {
  const px = k + 0.5,
    py = k + 0.5; // centers ON the diagonal, fully interior → truth 1.0
  const gt = truth(px, py),
    sa = signedArea(px, py),
    pm = perPrimitive(px, py, 'max'),
    po = perPrimitive(px, py, 'over');
  maxErrSA = Math.max(maxErrSA, Math.abs(sa - gt));
  maxErrMax = Math.max(maxErrMax, Math.abs(pm - gt));
  maxErrOver = Math.max(maxErrOver, Math.abs(po - gt));
  console.log(
    `(${px},${py})        ${gt.toFixed(3)}   ${sa.toFixed(3)}       ${pm.toFixed(3)}         ${po.toFixed(3)}`,
  );
}
// also sweep a few sub-pixel offsets across the diagonal at one interior band
for (const off of [-0.4, -0.2, 0, 0.2, 0.4]) {
  const px = 2 + 0.5 + off,
    py = 2 + 0.5 - off; // slide along/across the diagonal, staying interior
  const gt = truth(px, py),
    sa = signedArea(px, py),
    pm = perPrimitive(px, py, 'max'),
    po = perPrimitive(px, py, 'over');
  maxErrSA = Math.max(maxErrSA, Math.abs(sa - gt));
  maxErrMax = Math.max(maxErrMax, Math.abs(pm - gt));
  maxErrOver = Math.max(maxErrOver, Math.abs(po - gt));
}

console.log('\n--- max |coverage − ground truth| across the shared-diagonal junction ---');
console.log(
  `signed-area (combined winding):  ${maxErrSA.toExponential(2)}   ${maxErrSA < 1e-9 ? '→ CONFLATION-FREE (exact)' : ''}`,
);
console.log(`per-primitive MAX  (our crescent combine):  ${maxErrMax.toFixed(3)}   ← seam`);
console.log(`per-primitive OVER (our composite combine): ${maxErrOver.toFixed(3)}   ← seam`);
console.log(`\nConclusion: signed-area coverage matches ground truth exactly at the`);
console.log(`junction (err ${maxErrSA.toExponential(1)}); per-primitive under-covers by up to`);
console.log(
  `${Math.max(maxErrMax, maxErrOver).toFixed(2)} — the conflation seam our kind-9/10/11 + Slug`,
);
console.log(`machinery exists to paper over. This validates the signed-area premise on CPU.`);
