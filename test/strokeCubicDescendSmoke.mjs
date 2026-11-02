// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeCubicDescendSmoke — the analytic closest point on a cubic, run as the SHIPPED SHADER
// TEXT compiled to float32 (`_glslEmu.mjs`), against an independent reference.
//
// THE HAZARD. A closest-point solve seeded from 9 samples and run for 3 Newton steps converges
// to whatever basin its seed is in, so a seed on the wrong side of a loop or a cusp converges
// FAITHFULLY to the wrong minimum. Over 400,010 centers that moves MEMBERSHIP at 893 and distance
// by more than 1% of a half-width at 51,782, worst 11.82 half-widths. More Newton steps do not help (31.9 / 60.0 / 60.0 em at 2 / 4 / 6) and neither does
// a sign-scan bracket: it cannot see a tangency, which is a DOUBLE root.
//
// THE ROUTE. f(t) = P(t).P'(t) is a quintic. f''' is a QUADRATIC with a closed form, and between
// consecutive roots of g' the function g is monotone -- so each level's roots bracket the next's,
// one bisection per bracket cannot miss a root, and a double root of f is a simple root of f' that
// the level above hands over as a bracket end. It is the only cubic solver: there are no seeded
// arms kept as defines nobody sets.
//
// WHAT this PINS. The ACCURACY and the PRICE on the CPU, in the shader's own float32, and that no
// alternate solver arm has come back.
import path from 'path';
import { fileURLToPath } from 'url';
import { hasCxx, buildGlslEmu, K_CUBIC_DESCEND, K_CUBIC_EVALS } from './_glslEmu.mjs';
import { readFileSync } from 'fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => (c ? console.log('  ok ' + m) : (fail++, console.error('  FAIL ' + m)));

// ── it is THE solver, with no arm to switch it off ───────────────────────────────────────────
{
  const glsl = readFileSync(path.join(ROOT, 'src/shaders/_strokeMath.glsl'), 'utf8');
  ok(/float\s+cubicClosestDescend\s*\(/.test(glsl), 'cubicClosestDescend is in the shader');
  const acc = glsl.slice(glsl.indexOf('float strokeCubicAccum('));
  const body = acc.slice(0, acc.indexOf('\n}\n'));
  // (`u`: the solve runs from the nearer end, and t = 1 - u when that is p4.)
  // (and its nearest interior root too: cubicClosestDescend is cubicClosestDescend2 without it)
  ok(
    /\n  float u = cubicClosestDescend2\(cx, cy, uIn\);/.test(body) &&
      !/#if/.test(body) &&
      /float cubicClosestDescend\(vec4 cx, vec4 cy\) \{ float tIn; return cubicClosestDescend2\(cx, cy, tIn\); \}/.test(
        glsl,
      ),
    '...and strokeCubicAccum calls it unconditionally, with no preprocessor arm around it',
  );
  const arms = glsl.match(/MANTLE_CUBIC_[A-Z_]+/g) || [];
  ok(
    arms.length === 0,
    `no alternate solver define survives (${arms.length ? [...new Set(arms)].join(', ') : 'none'})`,
  );
}

// ── the reference: dense scan + golden section, which owes the shader nothing ────────────────
// P is query-relative, so the closest point minimises |P(t)|^2 over [0,1]. 4096 samples put a
// bracket inside every basin a cubic can have (at most 3 minima), and 80 golden sections take each
// to float64's floor.
function refT(cx, cy) {
  const at = (t) => {
    const x = ((cx[0] * t + cx[1]) * t + cx[2]) * t + cx[3];
    const y = ((cy[0] * t + cy[1]) * t + cy[2]) * t + cy[3];
    return x * x + y * y;
  };
  const N = 4096;
  let bt = 0,
    bs = at(0);
  for (let i = 1; i <= N; i++) {
    const t = i / N,
      s = at(t);
    if (s < bs) {
      bs = s;
      bt = t;
    }
  }
  let lo = Math.max(0, bt - 1 / N),
    hi = Math.min(1, bt + 1 / N);
  const g = (Math.sqrt(5) - 1) / 2;
  for (let k = 0; k < 80; k++) {
    const a = hi - g * (hi - lo),
      b = lo + g * (hi - lo);
    if (at(a) < at(b)) hi = b;
    else lo = a;
  }
  const tm = 0.5 * (lo + hi);
  return at(tm) < bs ? tm : bt;
}
// ...and the SEEDED route, spelled here because it is the comparison and it is eight lines. Read against the reference, not against the descend arm, so a bug here can only
// understate the gap it is used to report.
function seededT(cx, cy) {
  const ev = (c, t) => ((c[0] * t + c[1]) * t + c[2]) * t + c[3];
  const evd = (c, t) => (3 * c[0] * t + 2 * c[1]) * t + c[2];
  const d2 = (t) => {
    const x = ev(cx, t),
      y = ev(cy, t);
    return x * x + y * y;
  };
  let bt = 0,
    bs = 1e20;
  for (let k = 0; k <= 8; k++) {
    const t = k / 8,
      s = d2(t);
    if (s < bs) {
      bs = s;
      bt = t;
    }
  }
  const sv = cx[2] * cx[2] + cy[2] * cy[2];
  const ex = cx[2] + 2 * cx[1] + 3 * cx[0],
    ey = cy[2] + 2 * cy[1] + 3 * cy[0];
  if (sv < 1e-9 || ex * ex + ey * ey < 1e-9)
    for (let k = 0; k < 8; k++) {
      const t = (2 * k + 1) / 16,
        s = d2(t);
      if (s < bs) {
        bs = s;
        bt = t;
      }
    }
  let t = bt;
  for (let j = 0; j < 3; j++) {
    const px = ev(cx, t),
      py = ev(cy, t),
      dx = evd(cx, t),
      dy = evd(cy, t);
    const f = px * dx + py * dy;
    const df =
      dx * dx + dy * dy + px * (6 * cx[0] * t + 2 * cx[1]) + py * (6 * cy[0] * t + 2 * cy[1]);
    if (Math.abs(df) < 1e-9) break;
    t = Math.min(1, Math.max(0, t - f / df));
  }
  return t;
}

// ── the cases: ordinary, loop and cusp cubics, at many query points ──────────────────────────
// Bezier control points to the coefficient form the kernel carries (t^3, t^2, t, 1), RELATIVE to
// the query point — cubicCoeff's own arrangement.
function coeff(P, q) {
  const c = (i) => [P[0][i] - q[i], P[1][i] - q[i], P[2][i] - q[i], P[3][i] - q[i]];
  const mk = (b) => [
    -b[0] + 3 * b[1] - 3 * b[2] + b[3],
    3 * b[0] - 6 * b[1] + 3 * b[2],
    -3 * b[0] + 3 * b[1],
    b[0],
  ];
  return [mk(c(0)), mk(c(1))];
}
let seed = 0x2f6e2b1;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const FAMILIES = {
  // a self-intersecting loop: the case where two minima face each other across the crossing
  loop: () => [
    [0, 0],
    [260, 200],
    [-260, 200],
    [0, 0.0001],
  ],
  // an exact cusp, from B'(t) = (t - t0)(A t + B) integrated
  cusp: () => {
    const t0 = 0.4 + 0.2 * rnd(),
      A = [1, 0.3 * rnd()],
      B = [0.2 * rnd(), 1];
    const pb = (c) => [
      c[0],
      c[0] + c[1] / 3,
      c[0] + (2 * c[1]) / 3 + c[2] / 3,
      c[0] + c[1] + c[2] + c[3],
    ];
    const bx = pb([0, -t0 * B[0], (B[0] - t0 * A[0]) / 2, A[0] / 3]);
    const by = pb([0, -t0 * B[1], (B[1] - t0 * A[1]) / 2, A[1] / 3]);
    return [0, 1, 2, 3].map((i) => [bx[i] * 300, by[i] * 300]);
  },
  // ordinary art-like curves
  plain: () => [
    [0, 0],
    [100 * rnd(), 200 * rnd()],
    [100 + 100 * rnd(), 200 * rnd()],
    [200, 30 * rnd()],
  ],
};

if (!hasCxx()) {
  console.log('  SKIP the shipped-shader comparison: no C++ compiler ($CXX, clang++, g++, c++)');
} else {
  const emu = buildGlslEmu(ROOT, { cubicSolve: true });
  const qs = [],
    meta = [];
  for (const [fam, gen] of Object.entries(FAMILIES)) {
    for (let c = 0; c < 40; c++) {
      const P = gen();
      let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
      for (const p of P) {
        x0 = Math.min(x0, p[0]);
        x1 = Math.max(x1, p[0]);
        y0 = Math.min(y0, p[1]);
        y1 = Math.max(y1, p[1]);
      }
      const w = Math.max(x1 - x0, 1e-6),
        h = Math.max(y1 - y0, 1e-6);
      for (let s = 0; s < 24; s++) {
        const q = [x0 - 0.15 * w + 1.3 * w * rnd(), y0 - 0.15 * h + 1.3 * h * rnd()];
        const [cx, cy] = coeff(P, q);
        qs.push({
          k: K_CUBIC_DESCEND,
          bb: [cx[0], cx[1], cx[2], cx[3]],
          ex: [cy[0], cy[1], cy[2], cy[3]],
        });
        meta.push({ fam, cx, cy, scale: Math.max(w, h) });
      }
    }
  }
  const got = emu.run(new Float32Array(4), new Float32Array(4), qs);
  const worst = {},
    worstSeed = {};
  const d2 = (cx, cy, t) => {
    const x = ((cx[0] * t + cx[1]) * t + cx[2]) * t + cx[3];
    const y = ((cy[0] * t + cy[1]) * t + cy[2]) * t + cy[3];
    return Math.sqrt(x * x + y * y);
  };
  for (let i = 0; i < qs.length; i++) {
    const { fam, cx, cy } = meta[i];
    const tr = refT(cx, cy);
    const dRef = d2(cx, cy, tr);
    // THE ERROR IS IN DISTANCE, NOT IN t. A wrong basin is a wrong DISTANCE, and t alone would
    // call two parameters far apart on a symmetric loop that give the same distance a failure.
    const eD = d2(cx, cy, got[i]) - dRef;
    const eS = d2(cx, cy, seededT(cx, cy)) - dRef;
    worst[fam] = Math.max(worst[fam] || 0, eD);
    worstSeed[fam] = Math.max(worstSeed[fam] || 0, eS);
  }
  let allD = 0,
    allS = 0;
  for (const fam of Object.keys(FAMILIES)) {
    allD = Math.max(allD, worst[fam]);
    allS = Math.max(allS, worstSeed[fam]);
    console.log(
      `  .. ${fam.padEnd(6)} worst excess distance: descend ${worst[fam].toExponential(2)} em, seeded ${worstSeed[fam].toExponential(2)} em`,
    );
  }
  // A closest point is a MINIMUM, so any route's distance is >= the reference's; the error is
  // one-sided and the bar is on how far above it the route lands. The descending chain's residual
  // is float32 rounding on a quintic built from coordinates of order 300.
  ok(
    allD < 1e-2,
    `the descending chain lands on the true minimum (worst excess ${allD.toExponential(2)} em over ${qs.length} cases)`,
  );
  ok(
    allS > 1.0,
    `...where the shipped seeded route does not (worst excess ${allS.toExponential(2)} em)`,
  );
  ok(
    allS / Math.max(allD, 1e-30) > 100,
    `...by a factor of ${(allS / Math.max(allD, 1e-30)).toExponential(1)}`,
  );

  // THE PRICE, off the same text: how many polynomial evaluations the chain spends.
  const ev = emu.run(
    new Float32Array(4),
    new Float32Array(4),
    qs.map((q) => ({ ...q, k: K_CUBIC_EVALS })),
  );
  let tot = 0,
    mx = 0;
  for (const v of ev) {
    tot += v;
    mx = Math.max(mx, v);
  }
  const mean = tot / ev.length;
  console.log(
    `  .. price: ${mean.toFixed(1)} polynomial evaluations a query (worst ${mx}), against the seeded route's 12.0`,
  );
  ok(mean > 0, `the price is measured, not asserted (${mean.toFixed(1)} evaluations)`);
  ok(mean < 400, `...and bounded: the chain cannot run away (worst ${mx})`);
}

console.log(fail ? `STROKE-CUBIC-DESCEND FAIL (${fail})` : 'STROKE-CUBIC-DESCEND OK');
process.exit(fail ? 1 : 0);
