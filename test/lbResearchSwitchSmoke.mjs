// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbResearchSwitchSmoke — two Loop-Blinn alternatives stay out of the build: the klmn cusp row and
// the conic interior chain.
//
// A cusp row for cubicKLMN (`__LB_KLMN_ROWS`, cubicKLMNRows) costs on the GPU (slower on tiger, with
// more wrong-solid and painted-outside pixels) and the CPatch equivalent gains nothing, so neither
// exists. What stays pinned is the exact construction such a row is measured against: on a convex
// arch it leaves none of the hull box inside the implicit and outside the curve.
//
// The conic interior chain (`__LB_CONIC`: two quadratic Beziers in the five slots) trades
// over-painted pixels for lost ones, and the cubic chain carries arcs exactly without it, so there
// is no conic chain kernel (conicChainBoxCov), no variant define (MANTLE_LB_NO_CONIC_CHAIN) and no
// chain-2 convex bound fed by its control points.
//
//   (b) the exact construction leaves none of the arch's hull box inside the implicit and outside
//       the curve;
//   (c) no builder reads __LB_CONIC, the kernel has no conicChainBoxCov, and there is no
//       __LB_KLMN_ROWS: the partition has no cusp row.
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { cubicKLMN, affineEval, cubicSignKLMN } = await import('../src/geom/lbCubicMath.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

// ---- (c) absent -----------------------------------------------------------------------------------
{
  const src = (f) => readFileSync(path.join(ROOT, f), 'utf8');
  const PT = src('src/renderer/lbPartition.js');
  const builders = [
    'src/renderer/lbFastMesh.js',
    'src/renderer/lbFastResolve.js',
    'src/renderer/lbPartition.js',
    'src/renderer/lbPartitionPair.js',
    'src/renderer/workerFlags.js',
  ]
    .map(src)
    .join('\n');
  ok(!/__LB_CONIC/.test(builders), '(c) there is no __LB_CONIC: no builder reads it');
  ok(
    !/conicChainBoxCov|MANTLE_LB_NO_CONIC_CHAIN/.test(
      src('src/shaders/_boxCov.glsl') + src('src/shaders/_lbCoverage.glsl'),
    ),
    '(c) ...and the kernel has no conic chain to compile out',
  );
  // The cusp row is absent, not switched off.
  ok(
    !/__LB_KLMN_ROWS|cubicKLMNRows/.test(PT),
    '(c) there is no __LB_KLMN_ROWS: the partition writes no cusp row',
  );
}

// A plain convex arch, which cubicKLMN serves exactly.
const ARCH = [
  [0, 0],
  [0.5, 2.4],
  [2.6, 2.4],
  [3, 0],
];

// ---- (b) how much of the hull each implicit calls inside --------------------------------------------
const cubicAt = (P, t) => {
  const u = 1 - t;
  return [
    u * u * u * P[0][0] + 3 * u * u * t * P[1][0] + 3 * u * t * t * P[2][0] + t * t * t * P[3][0],
    u * u * u * P[0][1] + 3 * u * u * t * P[1][1] + 3 * u * t * t * P[2][1] + t * t * t * P[3][1],
  ];
};
/// The TRUE crescent: between the curve and its chord. Winding of the closed loop curve + chord.
function inCrescent(P, q) {
  const poly = [];
  for (let i = 0; i <= 200; i++) poly.push(cubicAt(P, i / 200));
  let w = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i],
      b = poly[(i + 1) % poly.length];
    if (a[1] <= q[1]) {
      if (b[1] > q[1] && (b[0] - a[0]) * (q[1] - a[1]) - (q[0] - a[0]) * (b[1] - a[1]) > 0) w++;
    } else if (b[1] <= q[1] && (b[0] - a[0]) * (q[1] - a[1]) - (q[0] - a[0]) * (b[1] - a[1]) < 0)
      w--;
  }
  return w !== 0;
}
/// The fraction of a box around the hull each implicit calls "inside" (f < 0 after the keep sign),
/// and how much of that the true crescent does not contain.
function share(P, klmn) {
  if (!klmn) return null;
  // The KEEP SIGN is part of the implicit: the builder takes sign * (k^3 - l*m) < 0 as inside, and
  // without it "f < 0" is simply the wrong half of the plane for either construction.
  const sg = cubicSignKLMN(P, klmn, false);
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const p of P) {
    x0 = Math.min(x0, p[0]);
    y0 = Math.min(y0, p[1]);
    x1 = Math.max(x1, p[0]);
    y1 = Math.max(y1, p[1]);
  }
  const G = 160,
    dx = (x1 - x0) / G,
    dy = (y1 - y0) / G;
  let neg = 0,
    negOutside = 0,
    tot = 0,
    cres = 0;
  for (let j = 0; j <= G; j++)
    for (let i = 0; i <= G; i++) {
      const q = [x0 + i * dx, y0 + j * dy];
      const K = affineEval([klmn.k[0], klmn.k[1], klmn.k[2]], P, q[0], q[1]);
      const L = affineEval([klmn.l[0], klmn.l[1], klmn.l[2]], P, q[0], q[1]);
      const Mv = affineEval([klmn.m[0], klmn.m[1], klmn.m[2]], P, q[0], q[1]);
      const f = sg * (K * K * K - L * Mv);
      const inC = inCrescent(P, q);
      tot++;
      if (inC) cres++;
      if (f < 0) {
        neg++;
        if (!inC) negOutside++;
      }
    }
  return { neg: neg / tot, cres: cres / tot, outside: negOutside / tot };
}
{
  const exact = share(ARCH, cubicKLMN(ARCH, 0));
  ok(
    exact && exact.outside < 0.005,
    `(b) the EXACT construction on the arch leaves ${(100 * exact.outside).toFixed(1)}% of the hull box inside the implicit and outside the curve`,
  );
}

console.log(fail ? `lbResearchSwitchSmoke FAIL (${fail})` : 'lbResearchSwitchSmoke PASS');
process.exit(fail ? 1 : 0);
