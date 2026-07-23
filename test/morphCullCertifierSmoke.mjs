// morphCullCertifierSmoke.mjs — ground-truth check of the analytic no-crossing
// certifier that decides whether a morph may cull a shape.
//
// morphCull.js eliminates t from the crossing condition S(u,t) = B(v,t): because t
// enters linearly, "the boundaries meet" becomes cross(P,Q) = 0 AND dot(P,Q) <= 0 in
// (u,v) alone, decided by Bernstein sign tests over the unit square. That is a strong
// claim, so check it against brute force over the whole (u,v,t) cube.
//
// The ONLY unsound outcome is certifying "never crosses" when it demonstrably does —
// that is what would delete a visible shape from an animation. Refusing to certify a
// pair that in fact never crosses is merely a missed draw, and is allowed.
import { SEG_LINE, SEG_QUAD, SEG_CUBIC } from '../src/hitTest/curveGeom.js';

import { certifyNoCross as certify } from '../src/renderer/morphCull.js';

const line = (x0,y0,x1,y1) => ({ t: SEG_LINE, x0, y0, x1, y1 });
const cub  = (x0,y0,a,b,c,d,x1,y1) => ({ t: SEG_CUBIC, x0, y0, c1x:a, c1y:b, c2x:c, c2y:d, x1, y1 });

// Brute force: does A(u,t) == B(v,t) for some u,v,t in [0,1]? (min distance over a grid)
const evalSeg = (s, u) => {
  const w = 1 - u;
  if (s.t === SEG_CUBIC) {
    const a=w*w*w, b=3*w*w*u, c=3*w*u*u, d=u*u*u;
    return [a*s.x0+b*s.c1x+c*s.c2x+d*s.x1, a*s.y0+b*s.c1y+c*s.c2y+d*s.y1];
  }
  if (s.t === SEG_QUAD) { const a=w*w,b=2*w*u,c=u*u; return [a*s.x0+b*s.cx+c*s.x1, a*s.y0+b*s.cy+c*s.y1]; }
  return [s.x0+(s.x1-s.x0)*u, s.y0+(s.y1-s.y0)*u];
};
const lerpSeg = (s0, s1, t) => {
  const o = { t: s0.t };
  for (const k of ['x0','y0','x1','y1','cx','cy','c1x','c1y','c2x','c2y'])
    if (s0[k] !== undefined) o[k] = s0[k]*(1-t) + s1[k]*t;
  return o;
};
const brute = (a0,a1,b0,b1, K=60) => {
  let best = Infinity;
  for (let ti=0; ti<=K; ti++) { const t=ti/K;
    const A=lerpSeg(a0,a1,t), B=lerpSeg(b0,b1,t);
    for (let ui=0; ui<=K; ui++) { const [ax,ay]=evalSeg(A,ui/K);
      for (let vi=0; vi<=K; vi++) { const [bx,by]=evalSeg(B,vi/K);
        const d=Math.hypot(ax-bx, ay-by); if (d<best) best=d; } } }
  return best;   // ~0 ⇒ they cross
};

const cases = [
  { name: 'far apart, both static',        a0: line(0,0,10,0),  a1: line(0,0,10,0),
                                           b0: line(0,50,10,50), b1: line(0,50,10,50), cross: false },
  { name: 'static crossing (X)',           a0: line(0,0,10,10), a1: line(0,0,10,10),
                                           b0: line(0,10,10,0), b1: line(0,10,10,0), cross: true },
  { name: 'apart at BOTH ends, cross mid', a0: line(0,0,10,0),  a1: line(0,0,10,0),
                                           b0: line(0,-20,10,-20), b1: line(0,20,10,20), cross: true },
  { name: 'occluder sweeps past, no touch',a0: line(0,0,10,0),  a1: line(0,0,10,0),
                                           b0: line(0,30,10,30), b1: line(0,60,10,60), cross: false },
  { name: 'curves, apart throughout',      a0: cub(0,0,3,5,7,5,10,0), a1: cub(0,2,3,7,7,7,10,2),
                                           b0: cub(0,40,3,45,7,45,10,40), b1: cub(0,42,3,47,7,47,10,42), cross: false },
  { name: 'curves that meet mid-morph',    a0: cub(0,0,3,5,7,5,10,0),  a1: cub(0,0,3,5,7,5,10,0),
                                           b0: cub(0,30,3,35,7,35,10,30), b1: cub(0,-30,3,-25,7,-25,10,-30), cross: true },
];

let bad = 0;
for (const c of cases) {
  const certified = certify(c.a0, c.a1, c.b0, c.b1);   // true ⇒ provably NO crossing
  const d = brute(c.a0, c.a1, c.b0, c.b1);
  const reallyCrosses = d < 0.25;
  const claim = certified ? 'NO CROSS (certified)' : 'cannot certify';
  const truth = reallyCrosses ? 'crosses' : 'no cross';
  // The only UNSOUND outcome is certifying "no cross" when it really crosses.
  const unsound = certified && reallyCrosses;
  if (unsound) bad++;
  console.log(`${unsound ? 'UNSOUND ' : 'ok      '} ${c.name.padEnd(30)} certifier=${claim.padEnd(22)} brute=${truth} (min dist ${d.toFixed(2)})`);
}
console.log(bad ? `\nFAILURES: ${bad}` : '\nmorphCullCertifierSmoke: sound on all cases');
process.exit(bad ? 1 : 0);
