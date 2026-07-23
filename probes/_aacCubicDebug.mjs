// _aacCubicDebug — replicate the SHIPPED GLSL cubic AAC path in JS and find
// where it diverges from ground truth on the failing shape (the parity smoke's
// cubic blob). Compares, per pixel:
//   run_shader = sum over segments of the shader's contribution
//   run_ref    = sum over segments of a high-precision -INT clamp(Xl) dYl
// and reports the worst pixels plus the per-segment breakdown, so the bad branch
// is identifiable rather than guessed at.

const PATH = [                              // M60 128 C60 40 196 40 196 128 C196 216 60 216 60 128 Z
  [[60,128],[60,40],[196,40],[196,128]],
  [[196,128],[196,216],[60,216],[60,128]],
];
const AAC_EPS = 1/65536;

const evalS = (C, t) => { const u = 1-t;
  return C.length === 4 ? u*u*u*C[0] + 3*u*u*t*C[1] + 3*u*t*t*C[2] + t*t*t*C[3]
                        : u*u*C[0] + 2*u*t*C[1] + t*t*C[2]; };
const derivS = (C, t) => { const u = 1-t;
  return C.length === 4 ? 3*u*u*(C[1]-C[0]) + 6*u*t*(C[2]-C[1]) + 3*t*t*(C[3]-C[2])
                        : 2*u*(C[1]-C[0]) + 2*t*(C[2]-C[1]); };
const lane = (P, i) => P.map((p) => p[i]);
const clamp = (v,a,b) => v<a?a:v>b?b:v;
const clamp01 = (v) => clamp(v,0,1);

// ---- aacSolveS (cubic: 8-iter clamped Newton, secant seed) ----
function solveS(C, ta, tb, V) {
  let lo = Math.min(ta,tb), hi = Math.max(ta,tb);
  if (C.length === 3) {
    const qa = C[0]-2*C[1]+C[2], qb = 2*(C[1]-C[0]), qc = C[0]-V;
    if (Math.abs(qa) < AAC_EPS) return clamp(Math.abs(qb) > AAC_EPS ? -qc/qb : lo, lo, hi);
    const sq = Math.sqrt(Math.max(qb*qb-4*qa*qc,0));
    const q = -0.5*(qb + (qb<0?-sq:sq));
    const r1 = q/qa, r2 = Math.abs(q) > AAC_EPS ? qc/q : r1;
    const t = (r1 >= lo-1e-4 && r1 <= hi+1e-4) ? r1 : r2;
    return clamp(t, lo, hi);
  }
  const fa = evalS(C,lo)-V, fb = evalS(C,hi)-V, den = fb-fa;
  let t = Math.abs(den) > AAC_EPS ? clamp(lo - fa*(hi-lo)/den, lo, hi) : 0.5*(lo+hi);
  for (let k=0;k<8;k++){            // Slug's clamped Newton: step, clamp to fixed bracket
    const f = evalS(C,t)-V;
    const d = derivS(C,t);
    if (Math.abs(d) < 1e-12) break;
    t = clamp(t - f/d, lo, hi);
  }
  return t;
}
const G3 = 0.7745966692414834;
function gaussXY(P, a, b) {
  const X = lane(P,0), Y = lane(P,1);
  const h = 0.5*(b-a), m = 0.5*(a+b), g = G3*h;
  return h * ((5/9)*(evalS(X,m-g)*derivS(Y,m-g) + evalS(X,m+g)*derivS(Y,m+g))
            + (8/9)*(evalS(X,m)*derivS(Y,m)));
}
function zoneI2(P, a, b) {
  if (b-a < 1e-12) return 0;
  const X = lane(P,0), Y = lane(P,1);
  const xm = evalS(X, 0.5*(a+b));
  if (xm <= 0) return 0;
  if (xm >= 1) return evalS(Y,b) - evalS(Y,a);
  return gaussXY(P, a, b);
}
function xMonoI2(P, a, b) {
  if (b-a < 1e-12) return 0;
  const X = lane(P,0), Y = lane(P,1);
  const xa = evalS(X,a), xb = evalS(X,b);
  const xlo = Math.min(xa,xb), xhi = Math.max(xa,xb);
  if (xhi <= 0) return 0;
  if (xlo >= 1) return evalS(Y,b) - evalS(Y,a);
  if (xlo >= 0 && xhi <= 1) return gaussXY(P,a,b);
  const incx = xb > xa;
  let c0 = 1e9, c1 = 1e9;
  if (xlo < 0 && xhi > 0) c0 = solveS(X, a, b, 0);
  if (xlo < 1 && xhi > 1) c1 = solveS(X, a, b, 1);
  const m0 = Math.min(c0,c1), m1 = Math.max(c0,c1);
  let acc = 0, prev = a;
  if (m0 < 1e8) { acc += zoneI2(P, prev, m0); prev = m0; }
  if (m1 < 1e8) { acc += zoneI2(P, prev, m1); prev = m1; }
  return acc + zoneI2(P, prev, b);
}
function exactI2(P, u0, u1) {
  const X = lane(P,0);
  let e0 = 1e9, e1 = 1e9;
  if (P.length === 4) {
    const d0 = X[1]-X[0], d1 = X[2]-X[1], d2 = X[3]-X[2];
    const qa = d0-2*d1+d2, qb = 2*(d1-d0), qc = d0;
    if (Math.abs(qa) > AAC_EPS) { const disc = qb*qb-4*qa*qc;
      if (disc > 0) { const s = Math.sqrt(disc); const r1=(-qb-s)/(2*qa), r2=(-qb+s)/(2*qa);
        e0 = Math.min(r1,r2); e1 = Math.max(r1,r2); } }
    else if (Math.abs(qb) > AAC_EPS) e0 = -qc/qb;
  } else {
    const den = X[0]-2*X[1]+X[2];
    if (Math.abs(den) > AAC_EPS) e0 = (X[0]-X[1])/den;
  }
  let s0 = (e0 > u0+1e-7 && e0 < u1-1e-7) ? e0 : 1e9;
  let s1 = (e1 > u0+1e-7 && e1 < u1-1e-7) ? e1 : 1e9;
  if (s1 < s0) { const t=s0; s0=s1; s1=t; }
  let acc = 0, prev = u0;
  if (s0 < 1e8) { acc += xMonoI2(P, prev, s0); prev = s0; }
  if (s1 < 1e8) { acc += xMonoI2(P, prev, s1); prev = s1; }
  return acc + xMonoI2(P, prev, u1);
}
function bezMonoContrib(P, ta, tb) {
  const Y = lane(P,1);
  const ya = evalS(Y,ta), yb = evalS(Y,tb);
  if (Math.max(ya,yb) <= 0 || Math.min(ya,yb) >= 1) return 0;
  const inc = yb > ya;
  let tLo, tHi;
  if (inc) { tLo = (ya>=0)?ta:solveS(Y, ta, tb, 0); tHi = (yb<=1)?tb:solveS(Y, ta, tb, 1); }
  else     { tLo = (yb>=0)?tb:solveS(Y, ta, tb, 0); tHi = (ya<=1)?ta:solveS(Y, ta, tb, 1); }
  const u0 = Math.min(tLo,tHi), u1 = Math.max(tLo,tHi);
  if (u1-u0 < 1e-12) return 0;
  return -exactI2(P, u0, u1);
}
function cubicContrib(P) {
  const X = lane(P,0), Y = lane(P,1);
  if (Math.max(...Y) <= 0 || Math.min(...Y) >= 1) return 0;
  if (Math.min(...X) >= 1) return -(clamp01(Y[3]) - clamp01(Y[0]));
  const d0 = Y[1]-Y[0], d1 = Y[2]-Y[1], d2 = Y[3]-Y[2];
  const a = d0-2*d1+d2, b = 2*(d1-d0), cc = d0;
  let e0 = 2, e1 = 2;
  if (Math.abs(a) > 1e-9) { const disc = b*b-4*a*cc;
    if (disc > 0) { const sq = Math.sqrt(disc); const r1=(-b-sq)/(2*a), r2=(-b+sq)/(2*a);
      e0 = Math.min(r1,r2); e1 = Math.max(r1,r2); } }
  else if (Math.abs(b) > 1e-9) e0 = -cc/b;
  const s0 = (e0>1e-6 && e0<1-1e-6) ? e0 : 2;
  const s1 = (e1>1e-6 && e1<1-1e-6) ? e1 : 2;
  let run = 0, prev = 0;
  if (s0 < 1.5) { run += bezMonoContrib(P, prev, s0); prev = s0; }
  if (s1 < 1.5) { run += bezMonoContrib(P, prev, s1); prev = s1; }
  return run + bezMonoContrib(P, prev, 1);
}

// ---- reference: -INT clamp(x(t)) y'(t) dt over the y-clipped t-range, fine ----
function refContrib(P, N = 400000) {
  const X = lane(P,0), Y = lane(P,1);
  let acc = 0;
  for (let i=0;i<N;i++){
    const t = (i+0.5)/N;
    const y = evalS(Y,t);
    if (y <= 0 || y >= 1) continue;
    acc += clamp01(evalS(X,t)) * derivS(Y,t) / N;
  }
  return -acc;
}

const toPL = (P, cx, cy) => P.map(([x,y]) => [x-cx+0.5, y-cy+0.5]);
const fold = (r) => Math.min(Math.abs(r),1);

// scan a grid, find worst |shader - ref|
let worst = [];
for (let py = 30; py <= 226; py += 1) {
  for (let px = 30; px <= 226; px += 1) {
    let rs = 0, rr = 0;
    const per = [];
    for (const seg of PATH) {
      const P = toPL(seg, px+0.0, py+0.0);
      const a = cubicContrib(P), b = refContrib(P);
      rs += a; rr += b; per.push([a,b]);
    }
    const d = Math.abs(fold(rs) - fold(rr));
    if (d > 1/255) worst.push([d, px, py, rs, rr, per]);
  }
}
worst.sort((a,b)=>b[0]-a[0]);
console.log(`pixels where |fold(shader) - fold(ref)| > 1/255 : ${worst.length}`);
for (const [d,px,py,rs,rr,per] of worst.slice(0,8)) {
  console.log(`\n(${px},${py})  err ${(d*255).toFixed(1)}/255   run shader=${rs.toFixed(6)}  ref=${rr.toFixed(6)}`);
  per.forEach(([a,b],i)=>console.log(`    seg${i}: shader=${a.toFixed(6)}  ref=${b.toFixed(6)}  diff=${(a-b).toFixed(6)}`));
}
if (!worst.length) console.log('no divergence found on this grid');

// ---- focused trace ----
function trace(px, py) {
  console.log(`\n===== TRACE pixel (${px},${py}) seg0 =====`);
  const P = toPL(PATH[0], px, py);
  const X = lane(P,0), Y = lane(P,1);
  console.log('  Xl ctrl:', X.map(v=>v.toFixed(2)).join(', '));
  console.log('  Yl ctrl:', Y.map(v=>v.toFixed(2)).join(', '));
  const d0 = Y[1]-Y[0], d1 = Y[2]-Y[1], d2 = Y[3]-Y[2];
  const a = d0-2*d1+d2, b = 2*(d1-d0), cc = d0;
  let e0=2,e1=2;
  if (Math.abs(a) > 1e-9) { const disc=b*b-4*a*cc; if (disc>0){const sq=Math.sqrt(disc);
    e0=Math.min((-b-sq)/(2*a),(-b+sq)/(2*a)); e1=Math.max((-b-sq)/(2*a),(-b+sq)/(2*a));} }
  else if (Math.abs(b) > 1e-9) e0 = -cc/b;
  console.log(`  y-extrema: a=${a} b=${b} -> e0=${e0} e1=${e1}`);
  const s0 = (e0>1e-6&&e0<1-1e-6)?e0:2, s1 = (e1>1e-6&&e1<1-1e-6)?e1:2;
  const pieces = [];
  let prev = 0;
  if (s0<1.5){pieces.push([prev,s0]); prev=s0;}
  if (s1<1.5){pieces.push([prev,s1]); prev=s1;}
  pieces.push([prev,1]);
  for (const [ta,tb] of pieces) {
    const ya = evalS(Y,ta), yb = evalS(Y,tb);
    const inc = yb>ya;
    console.log(`  piece [${ta.toFixed(4)},${tb.toFixed(4)}] ya=${ya.toFixed(3)} yb=${yb.toFixed(3)} inc=${inc}`);
    if (Math.max(ya,yb)<=0 || Math.min(ya,yb)>=1) { console.log('    -> culled (no y-overlap)'); continue; }
    let tLo,tHi;
    if (inc){ tLo=(ya>=0)?ta:solveS(Y, ta, tb, 0); tHi=(yb<=1)?tb:solveS(Y, ta, tb, 1);}
    else    { tLo=(yb>=0)?tb:solveS(Y, ta, tb, 0); tHi=(ya<=1)?ta:solveS(Y, ta, tb, 1);}
    const u0=Math.min(tLo,tHi), u1=Math.max(tLo,tHi);
    console.log(`    tLo=${tLo.toFixed(6)} (y=${evalS(Y,tLo).toFixed(4)})  tHi=${tHi.toFixed(6)} (y=${evalS(Y,tHi).toFixed(4)})`);
    console.log(`    u0=${u0.toFixed(6)} u1=${u1.toFixed(6)}  x(u0)=${evalS(X,u0).toFixed(3)} x(u1)=${evalS(X,u1).toFixed(3)}`);
    console.log(`    contrib=${(-exactI2(P,u0,u1)).toFixed(6)}`);
  }
  console.log(`  TOTAL shader=${cubicContrib(P).toFixed(6)}  ref=${refContrib(P).toFixed(6)}`);
}
trace(161,71);
trace(60,74);
