// _predicateBench — G8: is the double-double tier faster than jumping to BigInt?
// Times the UNCERTAIN distribution (near-collinear), which is the only place either runs.
import { orient2d } from '../src/renderer/predicates.js';
const dv = new DataView(new ArrayBuffer(8));
function toBig(x){ if(x===0) return {m:0n,e:0}; dv.setFloat64(0,x); const b=dv.getBigUint64(0);
  const s=(b>>63n)&1n?-1n:1n; let e=Number((b>>52n)&0x7ffn); let m=b&0xfffffffffffffn;
  if(e===0)e=-1074; else {m|=0x10000000000000n; e-=1075;} return {m:s*m,e}; }
function exactOrient(a,b,c){ const vs=[a[0],a[1],b[0],b[1],c[0],c[1]].map(toBig);
  let mE=Infinity; for(const v of vs) if(v.e<mE) mE=v.e;
  const [ax,ay,bx,by,cx,cy]=vs.map(v=>v.m<<BigInt(v.e-mE));
  const d=(bx-ax)*(cy-ay)-(by-ay)*(cx-ax); return d>0n?1:d<0n?-1:0; }

let seed=7; const rnd=()=>(seed=(seed*1103515245+12345)&0x7fffffff)/0x7fffffff;
const ulp=(x)=>{dv.setFloat64(0,x); dv.setBigUint64(0,dv.getBigUint64(0)+1n); return dv.getFloat64(0);};
const N=200000, cases=[];
for(let i=0;i<N;i++){ const s=[1e-3,1,1e3][i%3];
  const a=[(rnd()-0.5)*s,(rnd()-0.5)*s], b=[(rnd()-0.5)*s,(rnd()-0.5)*s];
  const t=rnd()*2-0.5; const c=[a[0]+t*(b[0]-a[0]), a[1]+t*(b[1]-a[1])];
  cases.push([a,b,(i%2)?[ulp(c[0]),c[1]]:c]);   // half exactly collinear, half 1 ulp off
}
// checksum on the SIGN: orient2d returns a scaled determinant (a tiny double), so |0 would
// truncate every result to 0 and the two columns could not be compared.
const time=(label,fn)=>{ fn(); const t0=performance.now(); let s=0;
  for(const [a,b,c] of cases) s+=Math.sign(fn(a,b,c));
  const ms=performance.now()-t0;
  console.log(`  ${label.padEnd(28)} ${ms.toFixed(1).padStart(7)}ms  ${(ms*1e6/N).toFixed(1).padStart(6)} ns/call  (checksum ${s})`);
  return ms; };
console.log(`\n  ${N} near-collinear cases (the only inputs where the filter fails)\n`);
const ddMs = time('orient2d (adaptive expansions)', (a,b,c)=> a?orient2d(a,b,c):0);
const bigMs = time('BigInt exact only (removed)', (a,b,c)=> a?exactOrient(a,b,c):0);
console.log(`\n  adaptive cascade is ${(bigMs/ddMs).toFixed(2)}x faster on this distribution`);
