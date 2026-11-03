// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// What will the KERNEL paint for each shape, as against what the decomposition contains.
// inPatch scores the decomposition; this scores what the screen gets.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { pathToCycles } from '../src/geom/cpatchGraph.js';
import { convertContour } from '../src/renderer/cpatchConvert.js';
import { coverageMiss } from '../src/renderer/cpatchCov.js';
import { segPt } from '../src/geom/cpatchImplicit.js';

const N = +(process.env.N || 96);
const sections = await importSvg(readFileSync(process.argv[2], 'utf8'));
const cf = new Float32Array(sections.curves);
const only = (process.env.SHAPES || '').split(',').filter(Boolean).map(Number);
for (const [si, r] of (sections.curveRangesByShape || []).entries()) {
  if (only.length && !only.includes(si)) continue;
  const cs = curveRangeToContours(cf, r.begin | 0, (r.end != null ? r.end : r.begin + r.count) | 0);
  const list = contoursToConverter(cs || [], null);
  if (!list || !list.length) continue;
  const all = [];
  for (const c of list) {
    for (const sg of c) all.push(sg);
    const a = segPt(c[0], 0),
      b = segPt(c[c.length - 1], 1);
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-6) all.push({ t: 'line', P: [b, a] });
  }
  let cyc = [];
  try {
    cyc = pathToCycles(list, false) || [];
  } catch {
    cyc = [];
  }
  const patches = [];
  for (const c of cyc) {
    try {
      const rr = convertContour(c, { maxCurves: 8, tolPx: 0.05 });
      if (rr && rr.patches) patches.push(...rr.patches);
    } catch {
      /* refused */
    }
  }
  const m = coverageMiss(all, patches, N);
  console.log(
    `shape ${String(si).padStart(3)}: ${cyc.length} cycles, ${patches.length} patches  ` +
      `unpainted ${m.miss.toFixed(3)}%  spill ${m.over.toFixed(3)}%  thin ${m.thin.toFixed(3)}%`,
  );
}
