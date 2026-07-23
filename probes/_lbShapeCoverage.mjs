// Does the LB builder produce a mesh for EVERY shape it is handed?
// A silently dropped shape renders as the shape UNDER it, which the audit sees
// as a colour mismatch (WRONG), not as a hole.
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
const raw = out.raw || [];
const withMesh = new Set();
raw.forEach((m, i) => { if (m && (m.interior || m.tris || m.verts)) withMesh.add(m.shape !== undefined ? m.shape : i); });
console.log(`  shapes=${b.numShapes}  raw entries=${raw.length}  with geometry=${withMesh.size}`);
const missing = [];
for (let i = 0; i < b.numShapes; i++) if (!withMesh.has(i)) missing.push(i);
console.log(`  shapes with NO LB geometry: ${missing.length}`);
if (missing.length) console.log('   ', missing.slice(0, 40).join(','));

// Is a missing entry legitimately fill-less, or a DROPPED fill?
const fillless = [];
const dropped = [];
for (const i of missing) {
  const r = b.curveRangesByShape ? b.curveRangesByShape[i] : null;
  const n = Array.isArray(r) ? (r[1] - r[0]) : (r && r.count) || 0;
  const m = raw[i] || {};
  (n > 0 ? dropped : fillless).push([i, n, Object.keys(m).slice(0, 8).join('|')]);
}
console.log(`  of those: no curves at all = ${fillless.length}   HAS curves but no mesh = ${dropped.length}`);
for (const d of dropped.slice(0, 12)) console.log(`    shape ${d[0]}  curves=${d[1]}  keys=${d[2]}`);
