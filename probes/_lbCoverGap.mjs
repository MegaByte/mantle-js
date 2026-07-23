// One-sided under-coverage test, per shape.
//
// Union(pieces) <= sum(piece areas). So if the SUM of every triangle the mesh
// emits is less than the shape's true fill area, the mesh provably cannot cover
// the shape — that is missing paint no fragment shader can recover. The converse
// is not implied (sum >= area proves nothing), which is exactly why this is the
// safe direction to test.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP; globalThis.XMLSerializer = XS;
const { default: importSvg } = await import('../src/svg/importer.js');
const { buildLbBundle } = await import('../src/renderer/lbBuildCore.js');
const { curveRangeToContours, segPt } = await import('../src/renderer/lbContour.js');

const b = await importSvg(readFileSync(process.env.F, 'utf8'));
const cf = new Float32Array(b.curves);
const out = buildLbBundle({ curveFloats: cf,
  metaFloats: b.meta ? new Float32Array(b.meta) : null,
  metaFloatsPerShape: b.metaFloatsPerShape,
  ranges: b.curveRangesByShape, numShapes: b.numShapes });

const triA = (ax,ay,bx,by,cx,cy) => Math.abs((bx-ax)*(cy-ay)-(cx-ax)*(by-ay))/2;
const sumTris = (arr) => { let a = 0; if (!arr) return 0;
  for (let t = 0; t + 5 < arr.length; t += 6) a += triA(arr[t],arr[t+1],arr[t+2],arr[t+3],arr[t+4],arr[t+5]);
  return a; };

// True fill area: flatten each segment densely. DIAGNOSTIC ONLY — this measures
// the geometry, it does not render it, so sampling is legitimate here.
function trueArea(contours) {
  let A = 0;
  for (const c of contours) {
    const pts = [];
    for (const sg of c) {
      const N = 48;
      for (let i = 0; i < N; i++) { const q = segPt(sg, i / N); if (q) pts.push(q); }
    }
    for (let i = 0; i < pts.length; i++) {
      const q = pts[(i + 1) % pts.length];
      A += pts[i][0] * q[1] - q[0] * pts[i][1];
    }
  }
  return Math.abs(A) / 2;
}

const rows = [];
for (let s = 0; s < b.numShapes; s++) {
  const m = (out.raw || [])[s];
  const r = b.curveRangesByShape[s];
  if (!m || m.slug || !r || r.end <= r.begin) continue;
  let contours = null;
  try { contours = curveRangeToContours(cf, r.begin, r.end); } catch { continue; }
  if (!contours) continue;
  const ta = trueArea(contours);
  if (!(ta > 0)) continue;
  const ma = sumTris(m.interior) + sumTris(m.quads) + sumTris(m.cubics) + sumTris(m.edges);
  rows.push({ s, ta: +ta.toFixed(2), ma: +ma.toFixed(2), ratio: +(ma / ta).toFixed(3) });
}
rows.sort((a, c) => a.ratio - c.ratio);
const short = rows.filter((r) => r.ratio < 0.95);
console.log(`  shapes with a real LB mesh: ${rows.length}`);
console.log(`  PROVABLY under-covering (sum of all tris < 95% of fill area): ${short.length}`);
let lost = 0; for (const r of short) lost += (r.ta - r.ma);
console.log(`  em^2 of fill the mesh cannot reach: ${lost.toFixed(1)}`);
for (const r of rows.slice(0, 12)) console.log(`    shape ${String(r.s).padStart(3)}  trueArea=${String(r.ta).padStart(10)}  meshArea=${String(r.ma).padStart(10)}  ratio=${r.ratio}`);
