import { interiorChainsFromTris } from '../src/renderer/lbFastMesh.js';
import { _setKeyOrigin } from '../src/renderer/lbContour.js';
_setKeyOrigin([[{p1:[0,0]},{p1:[100,0]},{p1:[100,40]},{p1:[0,40]}]]);
// rect (0,0)-(100,40), fill inside. earcut → tri1=(0,0)(100,0)(100,40), tri2=(0,0)(100,40)(0,40)
const P=(x,y)=>[x,y];
const tri1=[P(0,0),P(100,0),P(100,40)], tri2=[P(0,0),P(100,40),P(0,40)];
const coords=[...tri1,...tri2];
const tris=coords.map((_,i)=>i);          // identity (per-vertex, like the partition passes)
// boundary edges with OUTWARD normals (fill inside, y-down)
const edges=[
  {p1:P(0,0),  p2:P(100,0), nx:0,ny:-1},   // top
  {p1:P(100,0),p2:P(100,40),nx:1,ny:0},    // right
  {p1:P(100,40),p2:P(0,40), nx:0,ny:1},    // bottom
  {p1:P(0,40), p2:P(0,0),   nx:-1,ny:0},   // left
];
const ch = interiorChainsFromTris(coords, tris, edges);
console.log('incomplete:', ch.incomplete, ' hasChain2:', ch.hasChain2);
console.log('badFaces:', Array.from(ch.badFaces));
const nz=a=>{ for(let i=0;i<a.length;i++) if(a[i]!==0) return true; return false; };
for(let f=0; f<tris.length/3; f++){
  const o=f*4;
  const A=[ch.chainA[o],ch.chainA[o+1],ch.chainA[o+2],ch.chainA[o+3]];
  const B=[ch.chainB[o],ch.chainB[o+1],ch.chainB[o+2],ch.chainB[o+3]];
  const C=[ch.chainC[o],ch.chainC[o+1],ch.chainC[o+2],ch.chainC[o+3]];
  const D=[ch.chainD[o],ch.chainD[o+1],ch.chainD[o+2],ch.chainD[o+3]];
  console.log(`face ${f} (tri ${f===0?'top+right':'bottom+left'}): bad=${ch.badFaces[f]}  chainA=${A}  chainB=${B}  chainC=${C}  chain2D=${D}`);
}
