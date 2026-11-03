// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _quinticSolveRoutes — CAN the cubic closest point be solved exactly, and what does it cost?
//
// CPU only, on purpose: it compares ALGORITHMS (accuracy and arithmetic), so it needs no GPU and
// cannot disturb the machine. Price the winner on the GPU separately, throttled.
//
// A cubic's closest point is a root of f(t) = P(t).P'(t), degree FIVE. Abel-Ruffini rules out a
// radical formula, which is often read as "so it cannot be solved" — it only rules out a formula.
// Three routes, measured against a converged reference:
//
//   BRING RADICAL, not implemented here and not recommended: reduce to x^5 + x + a via Tschirnhaus
//   (quadratic, sometimes cubic), evaluate BR(a) — cheap, since x^5+x+a is strictly monotonic and
//   Newton converges hard — then INVERT the Tschirnhaus map, which is a quartic solve per root.
//   And x^5+x+a has exactly ONE real root, so the other four critical points live on complex
//   branches. We need every critical point in [0,1] to find a global minimum, so this buys one
//   root at the price of a quartic and still needs complex arithmetic for the rest.
//
//   FERRARI BRACKET: f' is a quartic, solvable in radicals, and its roots split [0,1] into
//   intervals where f is monotone. Sound in theory, MEASURED UNRELIABLE: Ferrari's cancellation
//   makes it worse than the seeded method on hard curves (55 em vs 33) even in float64. It would
//   be worse again in the shader's float32.
//
//   DESCENDING CHAIN, the one that works: f''' of a quintic is QUADRATIC, so start there and walk
//   down. Each level's roots bracket the next level's, every bracket is monotone, and one
//   bisection per bracket finds every root and can miss none. The only closed form needed is the
//   quadratic — no Ferrari, no Bring.
//
// Result: exact (1.6e-9 em worst) even on pathological curves where the shipping seed+Newton is
// wrong by 33 em, for ~6-11x the solver's arithmetic.
// f(t) = P(t).P'(t) is degree 5. f'(t) is degree 4 — solvable in RADICALS (Ferrari). Its roots
// split [0,1] into <=5 intervals on which f is MONOTONE, so each holds at most one root and
// bisection cannot miss one. That is the property the shipping seed+Newton cannot promise.
const coeff = (p1, p2, p3, p4) => [
  -p1 + 3 * p2 - 3 * p3 + p4,
  3 * (p1 - 2 * p2 + p3),
  3 * (p2 - p1),
  p1,
];
const evalC = (c, t) => ((c[0] * t + c[1]) * t + c[2]) * t + c[3];
const evalCD = (c, t) => (3 * c[0] * t + 2 * c[1]) * t + c[2];
const d2of = (cx, cy, t) => {
  const x = evalC(cx, t),
    y = evalC(cy, t);
  return x * x + y * y;
};
const fOf = (cx, cy, t) => evalC(cx, t) * evalCD(cx, t) + evalC(cy, t) * evalCD(cy, t);

// f as explicit quintic coefficients (degree 5, index 0 = t^5), from the cubic's coeffs.
function fCoeffs(cx, cy) {
  // P = a t^3 + b t^2 + c t + d ; P' = 3a t^2 + 2b t + c
  const out = new Array(6).fill(0);
  for (const c of [cx, cy]) {
    const [a, b, cc, d] = c;
    const P = [a, b, cc, d],
      D = [3 * a, 2 * b, cc];
    for (let i = 0; i < 4; i++)
      for (let j = 0; j < 3; j++) {
        const deg = 3 - i + (2 - j); // t power
        out[5 - deg] += P[i] * D[j];
      }
  }
  return out; // [t^5..t^0]
}
const polyEval = (c, t) => c.reduce((s, k) => s * t + k, 0);
const polyDeriv = (c) => {
  const n = c.length - 1;
  return c.slice(0, n).map((k, i) => k * (n - i));
};

// Ferrari quartic, real roots only, via a Cardano resolvent cubic — the same closed form the quad
// path already uses one degree down.
function quarticRoots(A, B, C, D, E) {
  const out = [];
  if (Math.abs(A) < 1e-14) return cubicRoots(B, C, D, E);
  const a = B / A,
    b = C / A,
    c = D / A,
    d = E / A;
  const p = b - (3 * a * a) / 8,
    q = c - (a * b) / 2 + (a * a * a) / 8,
    r = d - (a * c) / 4 + (a * a * b) / 16 - (3 * a * a * a * a) / 256;
  // resolvent cubic: z^3 - p z^2 - 4r z + (4pr - q^2)
  const zs = cubicRoots(1, -p, -4 * r, 4 * p * r - q * q).filter(Number.isFinite);
  let z = zs.length ? Math.max(...zs) : p;
  let u = z * z - 4 * r;
  let v = 2 * z - p;
  if (v <= 0) {
    v = Math.max(v, 0);
  }
  const su = Math.sqrt(Math.max(u, 0)),
    sv = Math.sqrt(Math.max(v, 0));
  for (const s1 of [1, -1])
    for (const s2 of [1, -1]) {
      // y^2 -/+ sv y + (z/2 -/+ su/2)
      const bb = s1 * sv,
        cc = z / 2 + (s1 * s2 * su) / 2;
      const disc = bb * bb - 4 * cc;
      if (disc >= 0) {
        const sd = Math.sqrt(disc);
        out.push((-bb + sd) / 2 - a / 4);
        out.push((-bb - sd) / 2 - a / 4);
      }
    }
  return out;
}
function cubicRoots(A, B, C, D) {
  if (Math.abs(A) < 1e-14) {
    // quadratic
    if (Math.abs(B) < 1e-14) return Math.abs(C) > 1e-14 ? [-D / C] : [];
    const disc = C * C - 4 * B * D;
    if (disc < 0) return [];
    const sd = Math.sqrt(disc);
    return [(-C + sd) / (2 * B), (-C - sd) / (2 * B)];
  }
  const a = B / A,
    b = C / A,
    c = D / A;
  const p = b - (a * a) / 3,
    q = (2 * a * a * a) / 27 - (a * b) / 3 + c;
  const disc = (q * q) / 4 + (p * p * p) / 27;
  if (disc > 0) {
    const sd = Math.sqrt(disc);
    const u = Math.cbrt(-q / 2 + sd),
      v = Math.cbrt(-q / 2 - sd);
    return [u + v - a / 3];
  }
  const r = Math.sqrt(Math.max((-p * p * p) / 27, 0));
  const phi = Math.acos(Math.min(1, Math.max(-1, -q / (2 * Math.max(r, 1e-300)))));
  const m = 2 * Math.sqrt(Math.max(-p / 3, 0));
  return [
    m * Math.cos(phi / 3) - a / 3,
    m * Math.cos((phi + 2 * Math.PI) / 3) - a / 3,
    m * Math.cos((phi + 4 * Math.PI) / 3) - a / 3,
  ];
}
// ROUTE A: bracket by f' roots (rigorous), bisect+Newton inside each monotone interval.
function bracketT(cx, cy, counts) {
  const F = fCoeffs(cx, cy),
    Fp = polyDeriv(F);
  const crit = quarticRoots(...Fp)
    .filter((t) => t > 0 && t < 1 && Number.isFinite(t))
    .sort((a, b) => a - b);
  counts.quartic++;
  const knots = [0, ...crit, 1];
  let bt = 0,
    bs = Infinity;
  for (let i = 0; i + 1 < knots.length; i++) {
    let lo = knots[i],
      hi = knots[i + 1];
    let flo = polyEval(F, lo),
      fhi = polyEval(F, hi);
    let tr;
    if (flo === 0) tr = lo;
    else if (fhi === 0) tr = hi;
    else if (flo * fhi < 0) {
      // monotone here, so exactly one root — bisect to float precision
      for (let k = 0; k < 24; k++) {
        const m = 0.5 * (lo + hi),
          fm = polyEval(F, m);
        counts.evals++;
        if (flo * fm <= 0) {
          hi = m;
        } else {
          lo = m;
          flo = fm;
        }
      }
      tr = 0.5 * (lo + hi);
    } else continue;
    const s = d2of(cx, cy, tr);
    counts.evals++;
    if (s < bs) {
      bs = s;
      bt = tr;
    }
  }
  for (const t of [0, 1]) {
    const s = d2of(cx, cy, t);
    counts.evals++;
    if (s < bs) {
      bs = s;
      bt = t;
    }
  }
  return bt;
}
// ROUTE C: the DESCENDING CHAIN, which needs no quartic formula at all.
//   f    is quintic  -> bracket its roots by the roots of f'
//   f'   is quartic   -> bracket ITS roots by the roots of f''
//   f''  is cubic     -> CLOSED FORM (Cardano), the one radical solve that is reliable here
// Each level is monotone between its parent's roots, so one bisection per interval finds every
// root and can miss none. Ferrari is avoided precisely because its cancellation is what made
// route A worse than the seeded method on hard curves.
function rootsMonotone(C, knots, counts) {
  const out = [];
  for (let i = 0; i + 1 < knots.length; i++) {
    let lo = knots[i],
      hi = knots[i + 1];
    let flo = polyEval(C, lo),
      fhi = polyEval(C, hi);
    counts.evals += 2;
    if (flo === 0) {
      out.push(lo);
      continue;
    }
    if (fhi === 0) {
      out.push(hi);
      continue;
    }
    if (flo * fhi > 0) continue;
    for (let k = 0; k < 24; k++) {
      const m = 0.5 * (lo + hi),
        fm = polyEval(C, m);
      counts.evals++;
      if (flo * fm <= 0) {
        hi = m;
      } else {
        lo = m;
        flo = fm;
      }
    }
    out.push(0.5 * (lo + hi));
  }
  return out;
}
function chainT(cx, cy, counts) {
  const F = fCoeffs(cx, cy),
    F1 = polyDeriv(F),
    F2 = polyDeriv(F1),
    F3 = polyDeriv(F2);
  counts.quartic++; // one cubic solve, counted in the same column
  // f''' of a QUINTIC is quadratic (3 coefficients). Passing it as a cubic read an undefined
  // fourth coefficient, so the top of the chain produced NaN knots and every level below it
  // inherited them — which is why this route looked worse than the seeded one it should beat.
  const r3 = cubicRoots(0, F3[0], F3[1], F3[2])
    .filter((t) => t > 0 && t < 1)
    .sort((a, b) => a - b);
  const k2 = [0, ...r3, 1];
  const r2 = rootsMonotone(F2, k2, counts); // f'' roots (cubic, bracketed by f''' )
  const k1 = [0, ...r2, 1];
  const r1 = rootsMonotone(F1, k1, counts); // f'  roots
  const k0 = [0, ...r1, 1];
  const r0 = rootsMonotone(F, k0, counts); // f   roots = the critical points
  let bt = 0,
    bs = Infinity;
  for (const t of [0, 1, ...r0]) {
    const s = d2of(cx, cy, t);
    counts.evals++;
    if (s < bs) {
      bs = s;
      bt = t;
    }
  }
  return bt;
}

// ROUTE D: NEWTON + HORNER DEFLATION down to a cubic, then the closed form.
//
// Horner is already the evaluation scheme everywhere here (evalC is Horner); the idea it unlocks is
// SYNTHETIC DIVISION. Find a root, divide it out in place — the same Horner recurrence, keeping the
// quotient instead of discarding it — and the degree drops. Do that twice and a quintic is a cubic,
// which Cardano finishes exactly. So the numeric part is two roots, not five.
//
// Deflation's known hazard is error accumulation: dividing by an inaccurate root corrupts what is
// left. The standard remedy is applied — every candidate is polished on the ORIGINAL quintic, never
// on a deflated remainder, so deflation only ever chooses WHICH root to converge to.
function deflate(C, r) {
  // synthetic division of C by (t - r), Horner form
  const out = new Array(C.length - 1);
  let acc = C[0];
  for (let i = 0; i < C.length - 1; i++) {
    out[i] = acc;
    acc = acc * r + C[i + 1];
  }
  return out; // remainder acc discarded: it is ~0 at a real root
}
function deflateT(cx, cy, counts) {
  let C = fCoeffs(cx, cy); // degree 5
  const found = [];
  // Bracket from a coarse scan and bisect+Newton to a root, twice; each drops the degree by one.
  for (let pass = 0; pass < 2 && C.length - 1 > 3; pass++) {
    let got = null,
      lo = 0,
      hi = 1,
      flo = polyEval(C, 0);
    counts.evals++;
    for (let i = 1; i <= SCAN && got === null; i++) {
      const t1 = i / SCAN,
        f1 = polyEval(C, t1);
      counts.evals++;
      if (flo * f1 <= 0) {
        let a = (i - 1) / SCAN,
          b = t1,
          fa = flo;
        for (let k = 0; k < 12; k++) {
          const m = 0.5 * (a + b),
            fm = polyEval(C, m);
          counts.evals++;
          if (fa * fm <= 0) {
            b = m;
          } else {
            a = m;
            fa = fm;
          }
        }
        got = 0.5 * (a + b);
      }
      flo = f1;
    }
    if (got === null) break; // no sign change left in [0,1]
    found.push(got);
    C = deflate(C, got);
  }
  // Whatever remains is degree <= 3: exact roots, no iteration.
  //
  // WHEN IT DOES NOT REDUCE, fall through to the rigorous chain instead of giving up. Deflation
  // needs a SIGN CHANGE to find a root, and a quintic can have none in [0,1] while still having a
  // minimum there (root pairs are invisible to a sign test). That case is what left this route at
  // 0.6 em worst on pathological curves while being at machine precision everywhere else -- and a
  // denser scan does not fix it (SCAN 16 and 32 measure identically). It is rare, so paying the
  // chain's price only there costs almost nothing on average.
  const cand = [...found];
  if (C.length - 1 === 3) cand.push(...cubicRoots(C[0], C[1], C[2], C[3]));
  else if (C.length - 1 === 2) cand.push(...cubicRoots(0, C[0], C[1], C[2]));
  else if (C.length - 1 === 1 && Math.abs(C[0]) > 1e-30) cand.push(-C[1] / C[0]);
  counts.quartic++;
  // POLISH ON THE ORIGINAL, so deflation error cannot survive into the answer.
  const F = fCoeffs(cx, cy),
    Fp = polyDeriv(F);
  let bt = 0,
    bs = Infinity;
  for (let t of [0, 1, ...cand]) {
    if (!Number.isFinite(t)) continue;
    t = Math.min(1, Math.max(0, t));
    for (let k = 0; k < 2; k++) {
      const fv = polyEval(F, t),
        dv = polyEval(Fp, t);
      counts.evals++;
      if (Math.abs(dv) > 1e-30) t = Math.min(1, Math.max(0, t - fv / dv));
    }
    const sdd = d2of(cx, cy, t);
    counts.evals++;
    if (sdd < bs) {
      bs = sdd;
      bt = t;
    }
  }
  return bt;
}

// ROUTE E: bracket every sign change in [0,1] and bisect. No deflation, no closed form.
//
// The comparison that matters for this problem: we do not need all five roots, only the critical
// points inside [0,1], and only to pick a minimum. Deflation's advantage is that it makes the
// leftover roots free via Cardano — but those leftovers are mostly OUTSIDE [0,1], where they do not
// affect the answer. So the cheaper equivalent may just be scanning for sign changes directly.
// On the GPU, as a shader arm, this route prices at 1.63x.
function scanBracketT(cx, cy, counts) {
  const F = fCoeffs(cx, cy);
  let bt = 0,
    bs = Infinity;
  for (const t of [0, 1]) {
    const sd = d2of(cx, cy, t);
    counts.evals++;
    if (sd < bs) {
      bs = sd;
      bt = t;
    }
  }
  let tp = 0,
    fp = polyEval(F, 0);
  counts.evals++;
  for (let i = 1; i <= SCAN; i++) {
    const t1 = i / SCAN,
      f1 = polyEval(F, t1);
    counts.evals++;
    if (fp * f1 <= 0) {
      let a = tp,
        b = t1,
        fa = fp;
      for (let k = 0; k < 20; k++) {
        const m = 0.5 * (a + b),
          fm = polyEval(F, m);
        counts.evals++;
        if (fa * fm <= 0) {
          b = m;
        } else {
          a = m;
          fa = fm;
        }
      }
      const tr = 0.5 * (a + b),
        sd = d2of(cx, cy, tr);
      counts.evals++;
      if (sd < bs) {
        bs = sd;
        bt = tr;
      }
    }
    tp = t1;
    fp = f1;
  }
  return bt;
}

// ROUTE F: TRUNCATE THE QUINTIC TO A CUBIC ANALYTICALLY, then 1-2 unrolled Newton steps.
//
// The seed is where every method here lives or dies: Newton converges to whatever basin it starts
// in, so the shipping 9-sample grid fails when a curve has five critical points and the grid lands
// in the wrong one. Instead of sampling, DROP THE TOP TWO DEGREES and solve the remainder in closed
// form -- Cardano gives up to three seeds, one per basin, for a fixed cost and no grid.
//
// Naive truncation (just delete a5 and a4) is poor on [0,1], where t^5 and t^4 are not small.
// CHEBYSHEV ECONOMIZATION is the right way to drop two degrees: rewrite in the shifted Chebyshev
// basis on [0,1] and remove the top two terms, which minimises the WORST error over the interval
// rather than near t=0. Both are measured below, because the difference between them is the whole
// question of whether the seed lands in the right basin.
const TSTAR = (() => {
  // shifted Chebyshev T*_n on [0,1], monomial coefficients, low->high
  const P = [[1], [-1, 2]];
  for (let n = 2; n <= 5; n++) {
    const a = P[n - 1],
      b = P[n - 2],
      out = new Array(n + 1).fill(0);
    for (let i = 0; i < a.length; i++) {
      out[i] += -2 * a[i];
      out[i + 1] += 4 * a[i];
    } // 2*(2x-1)*T*_{n-1}
    for (let i = 0; i < b.length; i++) out[i] -= b[i];
    P.push(out);
  }
  return P;
})();
function economizeToCubic(F) {
  // F is [t^5..t^0]; returns a cubic [t^3..t^0]
  const a = [...F].reverse(); // low->high
  for (let n = 5; n >= 4; n--) {
    const lead = TSTAR[n][n];
    const c = a[n] / lead; // the T*_n content of the top term
    for (let i = 0; i <= n; i++) a[i] -= c * TSTAR[n][i];
  }
  return [a[3], a[2], a[1], a[0]];
}
function truncSeedT(cx, cy, counts, economize) {
  const F = fCoeffs(cx, cy),
    Fp = polyDeriv(F);
  const C = economize ? economizeToCubic(F) : [F[2], F[3], F[4], F[5]]; // naive: keep t^3..t^0
  counts.quartic++; // one Cardano, counted in that column
  const seeds = cubicRoots(C[0], C[1], C[2], C[3]).filter(Number.isFinite);
  let bt = 0,
    bs = Infinity;
  for (let t of [0, 1, ...seeds]) {
    t = Math.min(1, Math.max(0, t));
    // UNROLLED NEWTON STEPS on the FULL quintic — no loop, no convergence test. NEWT is swept
    // because with a fixed step count the answer is decided by SEED QUALITY: a seed that is off by
    // 1e-2 needs another step or two to reach where a grid seed already is.
    for (let k = 0; k < NEWT; k++) {
      const fv = polyEval(F, t),
        dv = polyEval(Fp, t);
      counts.evals++;
      if (Math.abs(dv) > 1e-30) t = Math.min(1, Math.max(0, t - fv / dv));
    }
    const sd = d2of(cx, cy, t);
    counts.evals++;
    if (sd < bs) {
      bs = sd;
      bt = t;
    }
  }
  return bt;
}

// ROUTE H: SPLIT AT INFLECTIONS (closed form), then a cheap seeded Newton on each piece.
//
// The cliff is not precision, it is MULTIPLE MINIMA on one segment: a seed lands in the wrong
// basin and Newton converges faithfully to the wrong one, which is why more steps never helped.
// Bracketing fixes that per fragment, at 56-135 evals and with data-dependent loops that diverge
// across a warp.
//
// The alternative is to remove the basins instead of searching them. A cubic's inflections are the
// roots of cross(P', P'') = 0 -- a QUADRATIC, so exactly solvable -- and between consecutive
// inflections the curve turns one way, which is what multiplies minima. Splitting there is not
// subdivision-as-approximation: the split points are analytic, and the pieces are the same curve.
//
// It also moves the decision OFF the fragment: an encoder can split once, and every fragment then
// runs the same straight-line code. This measures only the premise -- does splitting at inflections
// actually remove the cliff? -- because if it does not, the encoder work is pointless.
function inflectionTs(P) {
  // cross(P', P'') = 0, a quadratic in t
  const [p0, p1, p2, p3] = P;
  const ax = -p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0],
    ay = -p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1];
  const bx = 3 * (p0[0] - 2 * p1[0] + p2[0]),
    by = 3 * (p0[1] - 2 * p1[1] + p2[1]);
  const cx2 = 3 * (p1[0] - p0[0]),
    cy2 = 3 * (p1[1] - p0[1]);
  // P' = 3a t^2 + 2b t + c ; P'' = 6a t + 2b   (a,b,c the coefficient form)
  const A = 6 * (ax * by - ay * bx),
    B = 6 * (ax * cy2 - ay * cx2),
    C = 2 * (bx * cy2 - by * cx2);
  const out = [];
  if (Math.abs(A) < 1e-14) {
    if (Math.abs(B) > 1e-14) out.push(-C / B);
  } else {
    const d = B * B - 4 * A * C;
    if (d >= 0) {
      const sd = Math.sqrt(d);
      out.push((-B + sd) / (2 * A), (-B - sd) / (2 * A));
    }
  }
  return out.filter((t) => t > 1e-6 && t < 1 - 1e-6).sort((a, b) => a - b);
}
function splitSeedT(P, cx, cy, counts) {
  const knots = [0, ...inflectionTs(P), 1];
  const F = fCoeffs(cx, cy),
    Fp = polyDeriv(F);
  let bt = 0,
    bs = Infinity;
  for (let i = 0; i + 1 < knots.length; i++) {
    const lo = knots[i],
      hi = knots[i + 1];
    // One seed per piece: the cheapest possible stand-in for a grid, at the piece midpoint plus
    // its two ends, then unrolled Newton CLAMPED TO THE PIECE so it cannot leave its basin.
    for (let t of [lo, 0.5 * (lo + hi), hi]) {
      for (let k = 0; k < NEWT; k++) {
        const fv = polyEval(F, t),
          dv = polyEval(Fp, t);
        counts.evals++;
        if (Math.abs(dv) > 1e-30) t = Math.min(hi, Math.max(lo, t - fv / dv));
      }
      const sd = d2of(cx, cy, t);
      counts.evals++;
      if (sd < bs) {
        bs = sd;
        bt = t;
      }
    }
  }
  return bt;
}

// ROUTE B: the shipping shader — 9 samples (+8 mid-cell if an end velocity vanishes) + 3 Newton.
function shaderT(cx, cy, counts) {
  let bT = 0,
    bS = 1e20;
  for (let k = 0; k <= 8; k++) {
    const t = k / 8,
      s = d2of(cx, cy, t);
    counts.evals++;
    if (s < bS) {
      bS = s;
      bT = t;
    }
  }
  const sv = cx[2] * cx[2] + cy[2] * cy[2];
  const ex = cx[2] + 2 * cx[1] + 3 * cx[0],
    ey = cy[2] + 2 * cy[1] + 3 * cy[0];
  if (sv < 1e-9 || ex * ex + ey * ey < 1e-9) {
    for (let k = 0; k < 8; k++) {
      const t = (2 * k + 1) / 16,
        s = d2of(cx, cy, t);
      counts.evals++;
      if (s < bS) {
        bS = s;
        bT = t;
      }
    }
  }
  let t = bT;
  for (let j = 0; j < 3; j++) {
    const px = evalC(cx, t),
      py = evalC(cy, t),
      dx = evalCD(cx, t),
      dy = evalCD(cy, t);
    const f = px * dx + py * dy,
      ddx = 6 * cx[0] * t + 2 * cx[1],
      ddy = 6 * cy[0] * t + 2 * cy[1];
    const df = dx * dx + dy * dy + px * ddx + py * ddy;
    counts.evals++;
    if (Math.abs(df) < 1e-9) break;
    t = Math.min(1, Math.max(0, t - f / df));
  }
  return t;
}
function refT(cx, cy) {
  let bt = 0,
    bs = Infinity;
  const M = 20000;
  for (let i = 0; i <= M; i++) {
    const t = i / M,
      s = d2of(cx, cy, t);
    if (s < bs) {
      bs = s;
      bt = t;
    }
  }
  let lo = Math.max(0, bt - 1 / M),
    hi = Math.min(1, bt + 1 / M);
  for (let k = 0; k < 160; k++) {
    const m1 = lo + (hi - lo) / 3,
      m2 = hi - (hi - lo) / 3;
    if (d2of(cx, cy, m1) < d2of(cx, cy, m2)) hi = m2;
    else lo = m1;
  }
  return (lo + hi) / 2;
}
/// MIN RADIUS OF CURVATURE along the segment. The stroke only ever queries points within halfW of
/// the curve, and if halfW < R_min the curve cannot bend back on itself inside that neighbourhood,
/// so the distance has exactly ONE minimum and any converging seed finds it. That is a GEOMETRIC
/// guarantee rather than a heuristic, and it is decidable per segment at encode time — which puts
/// the branch on the segment instead of the fragment, where a warp would diverge.
/// (Sampled here to test the PREDICATE; an encoder would want an analytic bound on max curvature.)
function minRadius(P) {
  let maxK = 0;
  for (let i = 0; i <= 64; i++) {
    const t = i / 64,
      mt = 1 - t;
    const dx =
      3 *
      (mt * mt * (P[1][0] - P[0][0]) +
        2 * mt * t * (P[2][0] - P[1][0]) +
        t * t * (P[3][0] - P[2][0]));
    const dy =
      3 *
      (mt * mt * (P[1][1] - P[0][1]) +
        2 * mt * t * (P[2][1] - P[1][1]) +
        t * t * (P[3][1] - P[2][1]));
    const ddx =
      6 * (mt * (P[2][0] - 2 * P[1][0] + P[0][0]) + t * (P[3][0] - 2 * P[2][0] + P[1][0]));
    const ddy =
      6 * (mt * (P[2][1] - 2 * P[1][1] + P[0][1]) + t * (P[3][1] - 2 * P[2][1] + P[1][1]));
    const sp = Math.hypot(dx, dy);
    if (sp < 1e-9) return 0;
    const k = Math.abs(dx * ddy - dy * ddx) / (sp * sp * sp);
    if (k > maxK) maxK = k;
  }
  return maxK > 0 ? 1 / maxK : Infinity;
}
const rnd = (s) => {
  let x = s;
  return () => (x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
};
const HALFW = +(process.env.HALFW || 4.5),
  TAME = process.env.TAME === '1';
// Seed density for the deflation route: a sign scan cannot see a root PAIR between samples.
const SCAN = +(process.env.SCAN || 8);
const NEWT = +(process.env.NEWT || 2);
const MODE = process.env.MODE || '';
const R = rnd(20260903);
const cA = { evals: 0, quartic: 0 },
  cB = { evals: 0, quartic: 0 },
  cC = { evals: 0, quartic: 0 },
  cD = { evals: 0, quartic: 0 },
  cE = { evals: 0, quartic: 0 },
  cF = { evals: 0, quartic: 0 },
  cG = { evals: 0, quartic: 0 },
  cH = { evals: 0, quartic: 0 };
let wA = 0,
  wB = 0,
  wC = 0,
  wD = 0,
  wE = 0,
  wF = 0,
  wG = 0,
  wH = 0,
  sA = 0,
  sB = 0,
  sC = 0,
  sD = 0,
  sE = 0,
  sF = 0,
  sG = 0,
  sH = 0,
  n = 0;
let nSafe = 0,
  nUnsafe = 0,
  wSafe = 0,
  wUnsafe = 0;
for (let i = 0; i < 4000; i++) {
  let P;
  if (MODE === 'paint') {
    // WHAT A PAINTING APP actually EMITS. createIncrementalStroke tessellates the polyline and
    // degree-elevates each LINE to a cubic with collinear controls (elevateToCubic), and
    // finalize() hands back polyline path data — so the paint path is lines end to end, however
    // wild the gesture. A line's distance has ONE minimum, so the basin ambiguity that wrecks a
    // looping cubic cannot arise no matter what the user draws.
    const x0 = R() * 128,
      y0 = R() * 128;
    let x3 = x0 + (R() * 2 - 1) * 30,
      y3 = y0 + (R() * 2 - 1) * 30; // a short freehand step, any direction
    P = [
      [x0, y0],
      [x0 + (x3 - x0) / 3, y0 + (y3 - y0) / 3],
      [x0 + (2 * (x3 - x0)) / 3, y0 + (2 * (y3 - y0)) / 3],
      [x3, y3],
    ];
  } else if (TAME) {
    const x0 = 10 + R() * 30,
      y0 = 40 + R() * 48,
      x3 = 88 + R() * 30,
      y3 = 40 + R() * 48,
      bow = (R() * 2 - 1) * 38;
    P = [
      [x0, y0],
      [x0 + (x3 - x0) / 3, y0 + bow],
      [x0 + (2 * (x3 - x0)) / 3, y3 + bow],
      [x3, y3],
    ];
  } else
    P = [
      [R() * 128, R() * 128],
      [R() * 128, R() * 128],
      [R() * 128, R() * 128],
      [R() * 128, R() * 128],
    ];
  const cxA = coeff(P[0][0], P[1][0], P[2][0], P[3][0]),
    cyA = coeff(P[0][1], P[1][1], P[2][1], P[3][1]);
  const t0 = R(),
    qx = evalC(cxA, t0),
    qy = evalC(cyA, t0),
    ang = R() * Math.PI * 2,
    off = R() * HALFW;
  const q = [qx + Math.cos(ang) * off, qy + Math.sin(ang) * off];
  const cx = coeff(P[0][0] - q[0], P[1][0] - q[0], P[2][0] - q[0], P[3][0] - q[0]);
  const cy = coeff(P[0][1] - q[1], P[1][1] - q[1], P[2][1] - q[1], P[3][1] - q[1]);
  const tr = refT(cx, cy),
    dref = Math.sqrt(d2of(cx, cy, tr));
  const ta = bracketT(cx, cy, cA),
    tb = shaderT(cx, cy, cB),
    tc = chainT(cx, cy, cC),
    td = deflateT(cx, cy, cD),
    te = scanBracketT(cx, cy, cE),
    tf = truncSeedT(cx, cy, cF, true),
    tg = truncSeedT(cx, cy, cG, false),
    th = splitSeedT(P, cx, cy, cH);
  const da = Math.abs(Math.sqrt(d2of(cx, cy, ta)) - dref),
    db = Math.abs(Math.sqrt(d2of(cx, cy, tb)) - dref);
  const dc = Math.abs(Math.sqrt(d2of(cx, cy, tc)) - dref);
  const dd2 = Math.abs(Math.sqrt(d2of(cx, cy, td)) - dref);
  if (dd2 > wD) wD = dd2;
  sD += dd2;
  const de = Math.abs(Math.sqrt(d2of(cx, cy, te)) - dref);
  if (de > wE) wE = de;
  sE += de;
  const df = Math.abs(Math.sqrt(d2of(cx, cy, tf)) - dref);
  if (df > wF) wF = df;
  sF += df;
  const dg = Math.abs(Math.sqrt(d2of(cx, cy, tg)) - dref);
  if (dg > wG) wG = dg;
  sG += dg;
  const dh = Math.abs(Math.sqrt(d2of(cx, cy, th)) - dref);
  if (dh > wH) wH = dh;
  sH += dh;
  // Does the guarantee hold, and does it PREDICT where the cheap route is safe?
  const safe = HALFW < minRadius(P);
  if (safe) {
    nSafe++;
    if (db > wSafe) wSafe = db;
  } else {
    nUnsafe++;
    if (db > wUnsafe) wUnsafe = db;
  }
  if (da > wA) wA = da;
  if (db > wB) wB = db;
  if (dc > wC) wC = dc;
  sA += da;
  sB += db;
  sC += dc;
  n++;
}
console.log(
  '  cubic closest point — ' +
    (MODE === 'paint' ? 'PAINT (elevated lines)' : TAME ? 'art-like' : 'random') +
    ' curves, halfW ' +
    HALFW,
);
console.log(
  '    route                    worst dist err     mean dist err    poly evals/call   quartics',
);
console.log(
  "    f'-quartic bracket   " +
    wA.toExponential(3).padStart(16) +
    ' ' +
    (sA / n).toExponential(3).padStart(16) +
    ' ' +
    (cA.evals / n).toFixed(1).padStart(16) +
    ' ' +
    (cA.quartic / n).toFixed(2).padStart(10),
);
console.log(
  '    descending chain     ' +
    wC.toExponential(3).padStart(16) +
    ' ' +
    (sC / n).toExponential(3).padStart(16) +
    ' ' +
    (cC.evals / n).toFixed(1).padStart(16) +
    ' ' +
    (cC.quartic / n).toFixed(2).padStart(10) +
    '  (cubic only)',
);
console.log(
  '    Newton+Horner defl.  ' +
    wD.toExponential(3).padStart(16) +
    ' ' +
    (sD / n).toExponential(3).padStart(16) +
    ' ' +
    (cD.evals / n).toFixed(1).padStart(16) +
    ' ' +
    (cD.quartic / n).toFixed(2).padStart(10) +
    '  (cubic only)',
);
console.log(
  '    sign-scan + bisect   ' +
    wE.toExponential(3).padStart(16) +
    ' ' +
    (sE / n).toExponential(3).padStart(16) +
    ' ' +
    (cE.evals / n).toFixed(1).padStart(16) +
    ' ' +
    '0'.padStart(10) +
    '  (= the GPU arm)',
);
console.log(
  '    cheb-trunc + 2 Newton' +
    wF.toExponential(3).padStart(16) +
    ' ' +
    (sF / n).toExponential(3).padStart(16) +
    ' ' +
    (cF.evals / n).toFixed(1).padStart(16) +
    ' ' +
    (cF.quartic / n).toFixed(2).padStart(10) +
    '  (cubic only)',
);
console.log(
  '    naive-trunc + 2 Newt ' +
    wG.toExponential(3).padStart(16) +
    ' ' +
    (sG / n).toExponential(3).padStart(16) +
    ' ' +
    (cG.evals / n).toFixed(1).padStart(16) +
    ' ' +
    (cG.quartic / n).toFixed(2).padStart(10) +
    '  (cubic only)',
);
console.log(
  '    split-at-inflection  ' +
    wH.toExponential(3).padStart(16) +
    ' ' +
    (sH / n).toExponential(3).padStart(16) +
    ' ' +
    (cH.evals / n).toFixed(1).padStart(16) +
    ' ' +
    '0'.padStart(10) +
    '  (encoder-side split)',
);
console.log('    ---- the SHIPPING solve, split by whether halfW < min radius of curvature ----');
console.log('      halfW <  R_min (safe)   ' + nSafe + ' cases, worst ' + wSafe.toExponential(3));
console.log(
  '      halfW >= R_min (unsafe) ' + nUnsafe + ' cases, worst ' + wUnsafe.toExponential(3),
);
console.log(
  '    shipping seed+Newton ' +
    wB.toExponential(3).padStart(16) +
    ' ' +
    (sB / n).toExponential(3).padStart(16) +
    ' ' +
    (cB.evals / n).toFixed(1).padStart(16) +
    ' ' +
    '0'.padStart(10),
);
