// _aacChordError — how wrong is AAC's band-chord approximation, really?
//
// The shader approximates a y-monotone curve piece inside a 1px band by its
// CHORD (adaptive: 2 chords when the piece sweeps >1px in x). Everything else in
// the kernel is exact. So the kernel's ONLY approximation error is measured here,
// against a high-precision reference, in 1/255 units.
//
// This decides whether the "exact clamped integral" (split the piece at its x=0
// and x=1 crossings; Gauss-Legendre the unclamped middle, closed-form the rest)
// is worth its cost. Gauss-3 is EXACT for the middle zone: the integrand
// x(t)·y'(t) is degree 5 for a cubic, degree 3 for a quad.
//
// Reports error for: adaptive chord (shipping), single chord (pre-3da930aa), and
// the exact clamped integral (candidate). Run: node probes/_aacChordError.mjs

// ---------- curve algebra (pixel-local coords; cell is [0,1]^2) ----------
const bezY = (P, t) => { const u = 1-t;
  return P.length === 4 ? u*u*u*P[0][1] + 3*u*u*t*P[1][1] + 3*u*t*t*P[2][1] + t*t*t*P[3][1]
                        : u*u*P[0][1] + 2*u*t*P[1][1] + t*t*P[2][1]; };
const bezX = (P, t) => { const u = 1-t;
  return P.length === 4 ? u*u*u*P[0][0] + 3*u*u*t*P[1][0] + 3*u*t*t*P[2][0] + t*t*t*P[3][0]
                        : u*u*P[0][0] + 2*u*t*P[1][0] + t*t*P[2][0]; };
const dY = (P, t) => { const u = 1-t;
  return P.length === 4 ? 3*u*u*(P[1][1]-P[0][1]) + 6*u*t*(P[2][1]-P[1][1]) + 3*t*t*(P[3][1]-P[2][1])
                        : 2*u*(P[1][1]-P[0][1]) + 2*t*(P[2][1]-P[1][1]); };
const dX = (P, t) => { const u = 1-t;
  return P.length === 4 ? 3*u*u*(P[1][0]-P[0][0]) + 6*u*t*(P[2][0]-P[1][0]) + 3*t*t*(P[3][0]-P[2][0])
                        : 2*u*(P[1][0]-P[0][0]) + 2*t*(P[2][0]-P[1][0]); };
const clamp01 = (v) => v < 0 ? 0 : v > 1 ? 1 : v;

// monotone solve f(t) = target on [a,b] (bisection, deep — reference quality)
function solve(f, a, b, target, iters = 60) {
  const inc = f(b) > f(a);
  for (let i = 0; i < iters; i++) { const m = (a+b)/2; if ((f(m) < target) === inc) a = m; else b = m; }
  return (a+b)/2;
}

// ---------- the shipping kernel's chord math ----------
function rampI(f0, f1) {
  if (f0 >= 0 && f1 >= 0) return 0.5*(f0+f1);
  if (f0 <= 0 && f1 <= 0) return 0;
  const p = Math.max(f0, f1);
  return 0.5*p*p/Math.abs(f1-f0);
}
const chordI = (ylo, yhi, xa, xb) => (yhi-ylo) * (rampI(xa,xb) - rampI(xa-1,xb-1));

// ---------- reference: fine quadrature of INT clamp(x(t))*y'(t) dt ----------
function refI2(P, t0, t1, N = 200000) {
  let acc = 0;
  for (let i = 0; i < N; i++) {
    const t = t0 + (i+0.5)/N*(t1-t0);
    acc += clamp01(bezX(P,t)) * dY(P,t) * (t1-t0)/N;
  }
  return acc;
}

// ---------- candidate: EXACT clamped integral ----------
// Split [t0,t1] at x-extrema -> x-monotone runs. On each run, split at the x=0
// and x=1 crossings. Zone x<0 contributes 0; zone x>1 contributes INT y' dt =
// dy; zone x in [0,1] is an unclamped polynomial -> Gauss-3 is exact (deg<=5).
const G3_T = [-Math.sqrt(3/5), 0, Math.sqrt(3/5)], G3_W = [5/9, 8/9, 5/9];
function gaussXY(P, a, b) {          // INT_a^b x(t) y'(t) dt, exact for deg<=5
  const h = (b-a)/2, m = (a+b)/2;
  let s = 0;
  for (let i = 0; i < 3; i++) { const t = m + h*G3_T[i]; s += G3_W[i] * bezX(P,t) * dY(P,t); }
  return s*h;
}
function xExtrema(P, t0, t1) {
  const ts = [];
  if (P.length === 4) {
    const d0 = P[1][0]-P[0][0], d1 = P[2][0]-P[1][0], d2 = P[3][0]-P[2][0];
    const a = d0 - 2*d1 + d2, b = 2*(d1-d0), c = d0;
    if (Math.abs(a) > 1e-12) { const disc = b*b - 4*a*c;
      if (disc > 0) { const s = Math.sqrt(disc); ts.push((-b-s)/(2*a), (-b+s)/(2*a)); } }
    else if (Math.abs(b) > 1e-12) ts.push(-c/b);
  } else {
    const den = P[0][0] - 2*P[1][0] + P[2][0];
    if (Math.abs(den) > 1e-12) ts.push((P[0][0]-P[1][0])/den);
  }
  return ts.filter((t) => t > t0 + 1e-9 && t < t1 - 1e-9).sort((p,q)=>p-q);
}
// SHADER-FIDELITY root solve: quad closed form; cubic = 8-iter clamped Newton
// (secant seed, step, clamp to the FIXED bracket) -- exactly aacSolveS in the
// GLSL. The shader must be judged with the solver it actually ships, not a
// 60-iter bisection reference.
const AAC_EPS = 1/65536;
function solveS(P, lane, ta, tb, V) {
  const C = P.map((p) => p[lane]);
  let lo = Math.min(ta,tb), hi = Math.max(ta,tb);
  const ev  = (t) => lane === 0 ? bezX(P,t) : bezY(P,t);
  const dv  = (t) => lane === 0 ? dX(P,t)   : dY(P,t);
  if (P.length === 3) {                                        // quad: closed form
    const qa = C[0] - 2*C[1] + C[2], qb = 2*(C[1]-C[0]), qc = C[0] - V;
    if (Math.abs(qa) < AAC_EPS)
      return Math.min(hi, Math.max(lo, Math.abs(qb) > AAC_EPS ? -qc/qb : lo));
    const sq = Math.sqrt(Math.max(qb*qb - 4*qa*qc, 0));
    const q  = -0.5*(qb + (qb < 0 ? -sq : sq));
    const r1 = q/qa, r2 = Math.abs(q) > AAC_EPS ? qc/q : r1;
    const t  = (r1 >= lo - 1e-4 && r1 <= hi + 1e-4) ? r1 : r2;
    return Math.min(hi, Math.max(lo, t));
  }
  const fa = ev(lo) - V, fb = ev(hi) - V, den = fb - fa;
  let t = Math.abs(den) > AAC_EPS ? Math.min(hi, Math.max(lo, lo - fa*(hi-lo)/den)) : (lo+hi)/2;
  for (let k = 0; k < 8; k++) {     // Slug's clamped Newton: step, clamp to fixed bracket
    const f = ev(t) - V;
    const d = dv(t);
    if (Math.abs(d) < 1e-12) break;
    t = Math.min(hi, Math.max(lo, t - f/d));
  }
  return t;
}

function exactI2(P, t0, t1, shaderSolve = false) {
  const xs = (a, b, lvl) => shaderSolve ? solveS(P, 0, a, b, lvl) : solve((t)=>bezX(P,t), a, b, lvl);
  const cuts = [t0, ...xExtrema(P, t0, t1), t1];
  let acc = 0;
  for (let k = 0; k + 1 < cuts.length; k++) {
    const a = cuts[k], b = cuts[k+1];
    const xa = bezX(P,a), xb = bezX(P,b);
    // x is monotone on [a,b]; locate the x=0 and x=1 crossings
    const marks = [a];
    for (const lvl of [0, 1]) {
      if ((xa - lvl) * (xb - lvl) < 0) marks.push(xs(a, b, lvl));
    }
    marks.push(b); marks.sort((p,q)=>p-q);
    for (let j = 0; j + 1 < marks.length; j++) {
      const u0 = marks[j], u1 = marks[j+1];
      if (u1 - u0 < 1e-14) continue;
      const xm = bezX(P, (u0+u1)/2);
      if (xm <= 0) continue;                                  // clamp -> 0
      if (xm >= 1) acc += bezY(P,u1) - bezY(P,u0);            // clamp -> 1, INT y' dt = dy
      else acc += gaussXY(P, u0, u1);                         // unclamped: exact
    }
  }
  return acc;
}

// ---------- the shipping approximations ----------
function chordApprox(P, t0, t1, adaptive) {
  const ya = bezY(P,t0), yb = bezY(P,t1);
  const lo = Math.max(0, Math.min(ya,yb)), hi = Math.min(1, Math.max(ya,yb));
  if (hi <= lo) return 0;
  const inc = yb > ya;
  const bandT = (Y) => solve((t)=>bezY(P,t), t0, t1, Y, 12);   // shader: 12 iters
  const xlo = bezX(P, bandT(lo)), xhi = bezX(P, bandT(hi));
  let area;
  if (!adaptive || Math.abs(xhi - xlo) <= 1) area = chordI(lo,hi,xlo,xhi);
  else { const mid = (lo+hi)/2, xmid = bezX(P, bandT(mid));
    area = chordI(lo,mid,xlo,xmid) + chordI(mid,hi,xmid,xhi); }
  return (inc ? 1 : -1) * area;      // I2 magnitude, signed
}

// ---------- sample y-monotone pieces crossing the cell ----------
let seed = 987654321;
const rnd = () => (seed = (seed*1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

// build a piece that is y-monotone and crosses the cell's y-range, with a
// controllable x-sweep (xSpan) so we can probe near-vertical .. near-horizontal
function makePiece(cubic, xSpan) {
  const x0 = 0.5 - xSpan/2 + (rnd()-0.5)*0.2;
  const x1 = 0.5 + xSpan/2 + (rnd()-0.5)*0.2;
  const y0 = -0.3 - rnd()*0.4, y1 = 1.3 + rnd()*0.4;         // straddles [0,1]
  if (cubic) return [[x0,y0], [x0 + (rnd()-0.5)*xSpan, y0 + (y1-y0)/3],
                     [x1 + (rnd()-0.5)*xSpan, y0 + 2*(y1-y0)/3], [x1,y1]];
  return [[x0,y0], [x0 + (x1-x0)*0.5 + (rnd()-0.5)*xSpan, (y0+y1)/2], [x1,y1]];
}

const bands = [
  ['near-vertical  (x-span 0.1px)', 0.1],
  ['moderate       (x-span 0.8px)', 0.8],
  ['near-horizontal(x-span 3.0px)', 3.0],
  ['very horizontal(x-span 8.0px)', 8.0],
];

console.log('AAC band-chord error vs high-precision reference, in 1/255 units');
console.log('(the kernel\'s ONLY approximation; everything else is closed form)\n');
console.log('piece class                     | single chord | adaptive (was) | exact+Newton8 (now)');
console.log('-------------------------------+--------------+----------------+--------------------');

for (const [label, xSpan] of bands) {
  let mS = 0, mA = 0, mE = 0;
  for (let i = 0; i < 400; i++) {
    const P = makePiece(i % 2 === 0, xSpan);
    // y-monotone check; skip non-monotone samples (the shader splits those)
    let mono = true; const n = 64; let prev = null;
    for (let k = 0; k <= n; k++) { const d = dY(P, k/n); if (prev !== null && d*prev < 0) { mono = false; break; } prev = d; }
    if (!mono) continue;
    // band-clip t-range (reference precision)
    const ya = bezY(P,0), yb = bezY(P,1);
    const lo = Math.max(0, Math.min(ya,yb)), hi = Math.min(1, Math.max(ya,yb));
    if (hi <= lo) continue;
    const t0 = solve((t)=>bezY(P,t), 0, 1, lo), t1 = solve((t)=>bezY(P,t), 0, 1, hi);
    const A = Math.min(t0,t1), B = Math.max(t0,t1);

    const ref = refI2(P, A, B);
    mS = Math.max(mS, Math.abs(Math.abs(chordApprox(P,0,1,false)) - Math.abs(ref)));
    mA = Math.max(mA, Math.abs(Math.abs(chordApprox(P,0,1,true )) - Math.abs(ref)));
    mE = Math.max(mE, Math.abs(Math.abs(exactI2(P, A, B, true))   - Math.abs(ref)));
  }
  const f = (v) => (v*255).toFixed(3).padStart(11);
  console.log(`${label.padEnd(30)} | ${f(mS)}  | ${f(mA)}    | ${f(mE)}`);
}
console.log('\n(max abs coverage error over 400 random pieces per class)');
console.log('exact column uses the SHIPPED solver: quad closed-form, cubic 8-iter clamped Newton');
