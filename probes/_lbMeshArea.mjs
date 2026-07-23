// Per-shape: does the LB mesh cover as much area as the shape's own fill?
// A shape whose mesh area falls far short is an incomplete triangulation — it
// renders as missing paint no matter what the fragment shader does.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP; globalThis.XMLSerializer = XS;
const { default: importSvg } = await import('../src/svg/importer.js');
const { buildLbBundle } = await import('../src/renderer/lbBuildCore.js');
const b = await importSvg(readFileSync(process.env.F, 'utf8'));
const out = buildLbBundle({
  curveFloats: new Float32Array(b.curves),
  metaFloats: b.meta ? new Float32Array(b.meta) : null,
  metaFloatsPerShape: b.metaFloatsPerShape,
  ranges: b.curveRangesByShape, numShapes: b.numShapes,
});
const tri = (a, c, d) => Math.abs((c[0]-a[0])*(d[1]-a[1]) - (d[0]-a[0])*(c[1]-a[1])) / 2;
let rows = [];
(out.raw || []).forEach((m, i) => {
  if (!m) return;
  const I = m.interior;
  let area = 0, n = 0;
  if (I) for (let t = 0; t + 5 < I.length; t += 6) {
    area += tri([I[t],I[t+1]],[I[t+2],I[t+3]],[I[t+4],I[t+5]]); n++;
  }
  // curve-buffer bbox area for this shape, as a crude expected-scale reference
  const r = b.curveRangesByShape && b.curveRangesByShape[i];
  const cnt = r ? ((r.end - r.begin) || 0) : 0;
  if (cnt > 0) rows.push({ i, tris: n, area: +area.toFixed(2), curves: cnt });
});
const slugMarked = (out.raw||[]).filter((m) => m && m.slug === true).length;
const packedSlug = (out.packed||[]).filter((m) => m && m.slug === true).length;
console.log(`  raw marked SLUG: ${slugMarked}   packed marked SLUG: ${packedSlug}`);
console.log(`  hasReal=${out.hasReal} hasSlug=${out.hasSlug} overBudget=${out.overBudget}`);
const bad = [];
(out.raw||[]).forEach((m, i) => {
  if (!m || m.slug) return;
  const I = m.interior; let ar = 0;
  if (I) for (let t = 0; t + 5 < I.length; t += 6)
    ar += tri([I[t],I[t+1]],[I[t+2],I[t+3]],[I[t+4],I[t+5]]);
  const pk = (out.packed||[])[i] || {};
  const r2 = b.curveRangesByShape && b.curveRangesByShape[i];
  const cn = r2 ? (r2.end - r2.begin) : 0;
  if (ar === 0 && cn > 0) bad.push(`shape ${i} curves=${cn} verts=${pk.vertexCount} interiorLen=${I?I.length:'none'} keys=${Object.keys(m).slice(0,10).join('|')}`);
});
console.log(`  REAL meshes with ZERO interior area: ${bad.length}`);
for (const x of bad) console.log('    ' + x);
rows.sort((x, y) => x.area - y.area);
console.log(`  shapes with fill curves: ${rows.length}`);
console.log(`  ZERO-area meshes: ${rows.filter(r => r.area === 0).length}`);
for (const r of rows.slice(0, 12)) console.log(`    shape ${String(r.i).padStart(3)}  tris=${String(r.tris).padStart(4)}  area=${r.area}  curves=${r.curves}`);

console.log('  WHY each shape fell back to Slug:');
for (const [k2, v] of Object.entries(globalThis.__LBWHY || {})) console.log(`    ${v} x  ${k2}`);

console.log('  ROOT reason:');
for (const [k3, v] of Object.entries(globalThis.__LBWHY2 || {})) console.log(`    ${v} x  ${k3}`);
if (globalThis.__lbPartitionErr) console.log('  last partition error:\n    ' + globalThis.__lbPartitionErr.split('\n').slice(0,4).join('\n    '));

console.log('  PARTITION decline site:');
for (const [k4, v] of Object.entries(globalThis.__LBWHY3 || {})) console.log(`    ${v} x  lbPartition.js ${k4}`);
