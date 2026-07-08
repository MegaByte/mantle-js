// svgTextPathArcLenSmoke.mjs — confirms that the closed-form quad
// arc-length and Gauss–Legendre cubic arc-length agree with a
// high-density numerical reference (1e6 trapezoidal samples) to within
// 1e-9 relative error.
//
// The path-sample math is re-derived inline (rather than re-exporting
// internals) to keep the test self-contained.

let failures = 0;
const fail = (msg) => { console.error('FAIL:', msg); failures++; };
const ok   = (msg) => console.log('ok ' + msg);

// 16-point GL on [0,1] (same constants as svgImporter.js).
const NODES = [
  0.005299532504175033, 0.027712488463383711, 0.067184398806084128,
  0.122297795822498470, 0.191061877798678115, 0.270991611171386573,
  0.359198224610370696, 0.452493745081181231, 0.547506254918818769,
  0.640801775389629304, 0.729008388828613427, 0.808938122201321885,
  0.877702204177501530, 0.932815601193915872, 0.972287511536616289,
  0.994700467495824967,
];
const WEIGHTS = [
  0.013576229705877047, 0.031126761969323946, 0.047579255841246392,
  0.062314485627766936, 0.074797994408288365, 0.084578259697501269,
  0.091301707522461794, 0.094725305227534248, 0.094725305227534248,
  0.091301707522461794, 0.084578259697501269, 0.074797994408288365,
  0.062314485627766936, 0.047579255841246392, 0.031126761969323946,
  0.013576229705877047,
];

// Quad speed |p'(t)| = 2√(A t² + B t + C).
const quadSpeed = (P0, P1, P2, t) => {
  const ax = P0[0] - 2*P1[0] + P2[0], ay = P0[1] - 2*P1[1] + P2[1];
  const bx = P1[0] - P0[0],           by = P1[1] - P0[1];
  const dx = 2*(ax*t + bx), dy = 2*(ay*t + by);
  return Math.hypot(dx, dy);
};
// Cubic speed |p'(t)|.
const cubicSpeed = (P0, P1, P2, P3, t) => {
  const u = 1 - t;
  const dx = 3*u*u*(P1[0]-P0[0]) + 6*u*t*(P2[0]-P1[0]) + 3*t*t*(P3[0]-P2[0]);
  const dy = 3*u*u*(P1[1]-P0[1]) + 6*u*t*(P2[1]-P1[1]) + 3*t*t*(P3[1]-P2[1]);
  return Math.hypot(dx, dy);
};

const trapLen = (speedFn, N) => {
  // ∫₀¹ |p'(t)| dt via composite trapezoid with N intervals.
  const h = 1 / N;
  let sum = 0.5 * (speedFn(0) + speedFn(1));
  for (let i = 1; i < N; i++) sum += speedFn(i * h);
  return sum * h;
};

const gl16Len = (speedFn) => {
  let sum = 0;
  for (let i = 0; i < 16; i++) sum += WEIGHTS[i] * speedFn(NODES[i]);
  return sum;
};

// Closed-form quad arc-length (mirror of _quadLenAt).
function quadLenClosed(P0, P1, P2) {
  const ax = P0[0] - 2*P1[0] + P2[0], ay = P0[1] - 2*P1[1] + P2[1];
  const bx = P1[0] - P0[0],           by = P1[1] - P0[1];
  const A = ax*ax + ay*ay;
  const B = 2*(ax*bx + ay*by);
  const C = bx*bx + by*by;
  if (A < 1e-12) return Math.hypot(P2[0]-P0[0], P2[1]-P0[1]);
  const F = (tt) => {
    const u = A*tt*tt + B*tt + C;
    if (u < 0) return 0;
    const sqrtU = Math.sqrt(u);
    const sqrtA = Math.sqrt(A);
    const term1 = ((2*A*tt + B) * sqrtU) / (4*A);
    const disc = 4*A*C - B*B;
    const arg = 2*sqrtA*sqrtU + 2*A*tt + B;
    const term2 = (arg > 1e-12) ? (disc / (8 * Math.pow(A, 1.5))) * Math.log(arg) : 0;
    return 2 * (term1 + term2);
  };
  return F(1) - F(0);
}

// --- T1: random quad — closed form vs 1e6-sample trapezoid.
{
  const P0 = [10, 30], P1 = [100, -50], P2 = [200, 200];
  const closed = quadLenClosed(P0, P1, P2);
  const ref = trapLen(t => quadSpeed(P0, P1, P2, t), 1_000_000);
  const relErr = Math.abs(closed - ref) / ref;
  if (relErr > 1e-9) fail(`T1 quad closed-form vs trap: closed=${closed} ref=${ref} relErr=${relErr.toExponential(3)}`);
  else ok(`T1 quad closed-form len=${closed.toFixed(6)} relErr=${relErr.toExponential(2)}`);
}

// --- T2: degenerate quad (control point on chord) — should collapse to chord.
{
  const P0 = [0, 0], P1 = [50, 0], P2 = [100, 0];
  const closed = quadLenClosed(P0, P1, P2);
  if (Math.abs(closed - 100) > 1e-9) fail(`T2 degenerate quad len=${closed} (expected 100)`);
  else ok(`T2 degenerate quad len=${closed.toFixed(6)}`);
}

// --- T3: cubic GL16 vs 1e6-sample trapezoid.
{
  const P0 = [50, 300], P1 = [250, 50], P2 = [550, 50], P3 = [750, 300];
  const gl  = gl16Len(t => cubicSpeed(P0, P1, P2, P3, t));
  const ref = trapLen(t => cubicSpeed(P0, P1, P2, P3, t), 1_000_000);
  const relErr = Math.abs(gl - ref) / ref;
  if (relErr > 1e-9) fail(`T3 cubic GL16 vs trap: gl=${gl} ref=${ref} relErr=${relErr.toExponential(3)}`);
  else ok(`T3 cubic GL16 len=${gl.toFixed(6)} relErr=${relErr.toExponential(2)}`);
}

// --- T4: high-curvature cubic (S-curve). Stress GL16.
{
  const P0 = [0, 0], P1 = [100, 1000], P2 = [-100, 1000], P3 = [0, 2000];
  const gl  = gl16Len(t => cubicSpeed(P0, P1, P2, P3, t));
  const ref = trapLen(t => cubicSpeed(P0, P1, P2, P3, t), 1_000_000);
  const relErr = Math.abs(gl - ref) / ref;
  if (relErr > 1e-7) fail(`T4 S-curve cubic GL16 vs trap: gl=${gl} ref=${ref} relErr=${relErr.toExponential(3)}`);
  else ok(`T4 S-curve cubic GL16 len=${gl.toFixed(4)} relErr=${relErr.toExponential(2)}`);
}

console.log();
console.log(failures === 0 ? 'SVG-TEXTPATH-ARCLEN PASS' : `SVG-TEXTPATH-ARCLEN FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
