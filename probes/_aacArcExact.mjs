// _aacArcExact — the arc is the last AAC curve type still using the band-CHORD
// approximation. Unlike a Bezier it is not polynomial, so Gauss is not exact...
// but it does not need to be: with
//     Xl(θ) = CX + A1·cosθ + B1·sinθ
//     Yl(θ) = CY + A2·cosθ + B2·sinθ   ⇒  Yl'(θ) = −A2·sinθ + B2·cosθ
// the integrand Xl·Yl' is a trig polynomial of degree ≤ 2, so ∫Xl·Yl'dθ has an
// elementary antiderivative. The arc can be made EXACT in closed form.
//
// F(θ) = CX·A2·cosθ + CX·B2·sinθ
//      + (B1·B2 − A1·A2)·sin²θ/2
//      + (A1·B2 − B1·A2)·θ/2
//      + (A1·B2 + B1·A2)·sinθ·cosθ/2
//
// Verify: (a) F' == Xl·Yl' pointwise, (b) the full zone machinery (split at
// x-extrema, then at the Xl=0 / Xl=1 crossings, closed-form each zone) matches a
// high-precision reference, and (c) how bad the shipping chord is.

const TWO_PI = 2 * Math.PI;
const clamp = (v,a,b)=>v<a?a:v>b?b:v;
const clamp01 = (v)=>clamp(v,0,1);

const trigEval  = (P, th) => P[0] + P[1]*Math.cos(th) + P[2]*Math.sin(th);
const trigDeriv = (P, th) => -P[1]*Math.sin(th) + P[2]*Math.cos(th);

// antiderivative of Xl(θ)·Yl'(θ)
function trigF(X, Y, th) {
  const c = Math.cos(th), s = Math.sin(th);
  const [CX, A1, B1] = X, [ , A2, B2] = Y;
  return CX*A2*c + CX*B2*s
       + (B1*B2 - A1*A2) * 0.5 * s*s
       + (A1*B2 - B1*A2) * 0.5 * th
       + (A1*B2 + B1*A2) * 0.5 * s*c;
}
// solve CX + A cosθ + B sinθ = V on a MONOTONE θ-range [a,b]
function trigSolve(P, V, a, b) {
  const R = Math.hypot(P[1], P[2]);
  const r = clamp((V - P[0]) / Math.max(R, 1e-12), -1, 1);
  const phi = Math.atan2(P[2], P[1]), ac = Math.acos(r);
  const lo = Math.min(a,b), hi = Math.max(a,b);
  for (const sgn of [1,-1]) {
    let th = phi + sgn*ac;
    th += Math.ceil((lo - th) / TWO_PI) * TWO_PI;
    if (th <= hi + 1e-6) return clamp(th, lo, hi);
  }
  return 0.5*(lo+hi);
}

// ---- exact: split at x-extrema, then at Xl=0 / Xl=1 crossings ----
function zoneI2(X, Y, a, b) {
  if (Math.abs(b-a) < 1e-14) return 0;
  const xm = trigEval(X, 0.5*(a+b));
  if (xm <= 0) return 0;                                   // clamp → 0
  if (xm >= 1) return trigEval(Y,b) - trigEval(Y,a);       // clamp → 1 ⇒ ∫Yl'dθ = ΔYl
  return trigF(X,Y,b) - trigF(X,Y,a);                      // unclamped, EXACT
}
function xMonoI2(X, Y, a, b) {
  if (Math.abs(b-a) < 1e-14) return 0;
  const xa = trigEval(X,a), xb = trigEval(X,b);
  const xlo = Math.min(xa,xb), xhi = Math.max(xa,xb);
  if (xhi <= 0) return 0;
  if (xlo >= 1) return trigEval(Y,b) - trigEval(Y,a);
  if (xlo >= 0 && xhi <= 1) return trigF(X,Y,b) - trigF(X,Y,a);
  const cuts = [a];
  for (const lvl of [0,1]) if ((xa-lvl)*(xb-lvl) < 0) cuts.push(trigSolve(X, lvl, a, b));
  cuts.push(b);
  cuts.sort((p,q)=> (b>a ? p-q : q-p));       // traversal order
  let acc = 0;
  for (let i=0;i+1<cuts.length;i++) acc += zoneI2(X,Y,cuts[i],cuts[i+1]);
  return acc;
}
// x-extrema of Xl: dXl/dθ = 0 → θ = atan2(B1,A1) + kπ
function exactI2(X, Y, thA, thB) {
  const base = Math.atan2(X[2], X[1]);
  const lo = Math.min(thA,thB), hi = Math.max(thA,thB);
  const ex = [];
  for (let k=-4;k<=4;k++){ const th = base + k*Math.PI; if (th > lo+1e-9 && th < hi-1e-9) ex.push(th); }
  const cuts = [thA, ...ex, thB];
  cuts.sort((p,q)=> (thB>thA ? p-q : q-p));
  let acc = 0;
  for (let i=0;i+1<cuts.length;i++) acc += xMonoI2(X,Y,cuts[i],cuts[i+1]);
  return acc;
}

// ---- reference: fine quadrature of ∫clamp(Xl)·Yl' dθ over the y-clipped range ----
function refI2(X, Y, thA, thB, q0, q1, N=400000) {
  let acc = 0;
  for (let i=0;i<N;i++){
    const th = thA + (i+0.5)/N*(thB-thA);
    const y = trigEval(Y, th);
    if (y <= q0 || y >= q1) continue;
    acc += clamp01(trigEval(X,th)) * trigDeriv(Y,th) * (thB-thA)/N;
  }
  return acc;
}

// ---- shipping approximation: adaptive band chord ----
function rampI(f0,f1){ if(f0>=0&&f1>=0) return 0.5*(f0+f1); if(f0<=0&&f1<=0) return 0;
  const p=Math.max(f0,f1); return 0.5*p*p/Math.abs(f1-f0); }
const chordI=(ylo,yhi,xa,xb)=>(yhi-ylo)*(rampI(xa,xb)-rampI(xa-1,xb-1));
function chordI2(X, Y, thA, thB, q0, q1) {
  const ya = trigEval(Y,thA), yb = trigEval(Y,thB);
  const lo = Math.max(q0, Math.min(ya,yb)), hi = Math.min(q1, Math.max(ya,yb));
  if (hi <= lo) return 0;
  const inc = yb > ya;
  const xAt = (Yv) => trigEval(X, trigSolve(Y, Yv, thA, thB));
  const xlo = xAt(lo), xhi = xAt(hi);
  let area;
  if (Math.abs(xhi-xlo) <= 1) area = chordI(lo,hi,xlo,xhi);
  else { const mid=0.5*(lo+hi), xmid=xAt(mid); area = chordI(lo,mid,xlo,xmid)+chordI(mid,hi,xmid,xhi); }
  return (inc?1:-1)*area;
}

// ---------------- checks ----------------
let seed = 424242;
const rnd = () => (seed = (seed*1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

// (a) F' == Xl·Yl' pointwise
let worstD = 0;
for (let i=0;i<200;i++){
  const X=[rnd()*2-0.5, rnd()*4-2, rnd()*4-2], Y=[rnd()*2-0.5, rnd()*4-2, rnd()*4-2];
  const th = rnd()*TWO_PI, e = 1e-6;
  const num = (trigF(X,Y,th+e) - trigF(X,Y,th-e)) / (2*e);
  const ana = trigEval(X,th) * trigDeriv(Y,th);
  worstD = Math.max(worstD, Math.abs(num-ana));
}
console.log(`(a) max |F'(θ) - Xl·Yl'| over 200 random arcs : ${worstD.toExponential(2)}`);

// (b)+(c) full-piece accuracy, y-monotone pieces crossing the cell
console.log('\narc piece class                 | adaptive chord (ship) | exact closed form');
console.log('-------------------------------+-----------------------+------------------');
for (const [label, rx, ry] of [['small radius (r~1px)', 1.2, 1.0], ['medium (r~4px)', 4, 3], ['large (r~40px)', 40, 32], ['very large (r~400px)', 400, 300]]) {
  let mC = 0, mE = 0, n = 0;
  for (let i=0;i<300;i++){
    const phi = rnd()*Math.PI, cp=Math.cos(phi), sp=Math.sin(phi);
    // pixel-local: place the ellipse centre so the arc crosses the cell
    const CX = 0.5 + (rnd()-0.5)*2*rx, CY = (rnd()<0.5 ? -1 : 1) * (0.3 + rnd()) * ry;
    const X = [CX,  cp*rx, -sp*ry];
    const Y = [CY,  sp*rx,  cp*ry];
    // pick a y-monotone θ-range: between consecutive y-extrema
    const baseY = Math.atan2(Y[2], Y[1]);
    const thA = baseY + rnd()*0.9*Math.PI - 0.45*Math.PI;
    const thB = thA + (rnd()<0.5?-1:1) * (0.05 + rnd()*0.8) * Math.PI;
    // require y-monotone on [thA,thB]
    let mono = true, prev = null;
    for (let k=0;k<=48;k++){ const d = trigDeriv(Y, thA + (thB-thA)*k/48); if (prev!==null && d*prev<0){mono=false;break;} prev=d; }
    if (!mono) continue;
    // y-clip to the cell
    const ya = trigEval(Y,thA), yb = trigEval(Y,thB);
    const lo = Math.max(0, Math.min(ya,yb)), hi = Math.min(1, Math.max(ya,yb));
    if (hi <= lo) continue;
    const u0 = trigSolve(Y, ya<yb?lo:hi, thA, thB), u1 = trigSolve(Y, ya<yb?hi:lo, thA, thB);
    const s0 = (thB>thA) ? Math.min(u0,u1) : Math.max(u0,u1);
    const s1 = (thB>thA) ? Math.max(u0,u1) : Math.min(u0,u1);
    const ref = refI2(X, Y, s0, s1, -1e9, 1e9);   // already y-clipped
    mE = Math.max(mE, Math.abs(exactI2(X,Y,s0,s1) - ref));
    // give the chord the SAME already-clipped range, so this compares the
    // approximation and not two different integration domains
    mC = Math.max(mC, Math.abs(chordI2(X,Y,s0,s1,-1e9,1e9) - ref));
    n++;
  }
  const f=(v)=>(v*255).toFixed(3).padStart(12);
  console.log(`${label.padEnd(30)} | ${f(mC)}          | ${f(mE)}   (n=${n})`);
}
console.log('\n(max abs coverage error, 1/255 units)');
