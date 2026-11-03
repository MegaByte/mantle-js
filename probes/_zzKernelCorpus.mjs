// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// The kernel model over a whole asset, on the renderer's own patches: what would a guard refuse?
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { packCPatchShape } from '../src/renderer/cpatchPack.js';
import { coverageMiss } from '../src/renderer/cpatchCov.js';
import { segPt } from '../src/geom/cpatchImplicit.js';

const N = +(process.env.N || 64);
const sections = await importSvg(readFileSync(process.argv[2], 'utf8'));
const cf = new Float32Array(sections.curves);
const rows = [];
let shapes = 0,
  nullPack = 0;
for (const [si, r] of (sections.curveRangesByShape || []).entries()) {
  const cs = curveRangeToContours(cf, r.begin | 0, (r.end != null ? r.end : r.begin + r.count) | 0);
  const list = contoursToConverter(cs || [], null);
  if (!list || !list.length) continue;
  shapes++;
  const all = [];
  for (const c of list) {
    for (const sg of c) all.push(sg);
    const a = segPt(c[0], 0),
      b = segPt(c[c.length - 1], 1);
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-6) all.push({ t: 'line', P: [b, a] });
  }
  const patches = [];
  let packed = null;
  try {
    packed = packCPatchShape(list, 0, { onPatches: (ps) => patches.push(...ps) });
  } catch {}
  if (!packed) {
    nullPack++;
    continue;
  }
  if (!patches.length) continue;
  const m = coverageMiss(all, patches, N);
  rows.push({ si, ...m, n: patches.length });
}
rows.sort((a, b) => b.miss + b.over - (a.miss + a.over));
const mean = (k) => rows.reduce((a, r) => a + r[k], 0) / Math.max(1, rows.length);
console.log(`${shapes} shapes, ${nullPack} packed null, ${rows.length} measured`);
console.log(
  `  mean unpainted ${mean('miss').toFixed(4)}%  mean spill ${mean('over').toFixed(4)}%  mean thin ${mean('thin').toFixed(4)}%`,
);
for (const t of [1.0, 0.25, 0.05, 0.01]) {
  const n = rows.filter((r) => r.miss > t || r.over > t).length;
  console.log(
    `  at threshold ${String(t).padStart(5)}: ${String(n).padStart(4)} of ${rows.length} refused (${((100 * n) / rows.length).toFixed(1)}%)`,
  );
}
for (const r of rows.slice(0, 6))
  if (r.miss + r.over > 0.001)
    console.log(
      `    shape ${String(r.si).padStart(3)}: ${String(r.n).padStart(3)} patches  unpainted ${r.miss.toFixed(3)}%  spill ${r.over.toFixed(3)}%`,
    );
