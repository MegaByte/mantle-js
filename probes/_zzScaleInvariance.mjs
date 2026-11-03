// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzScaleInvariance — the same drawing at different sizes must convert the same way.
//
// An absolute epsilon compared against a dimensional quantity -- a coordinate, a length, a
// derivative -- is a threshold that means different things on artwork authored at 1e-3 and at 1e6.
// Auditing them by eye does not scale; this DETECTS them. Every coordinate is multiplied by a
// POWER OF TWO, which is exact in floating point, so any change in the output is the code's own
// scale dependence and nothing else.
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

const sections = await importSvg(readFileSync(process.argv[2], 'utf8'));
const cf = new Float32Array(sections.curves);
const SCALES = (process.env.SCALES || '0.00390625,0.125,1,8,256').split(',').map(Number);
const LIMIT = +(process.env.LIMIT || 60);

const base = [];
for (const [si, r] of (sections.curveRangesByShape || []).entries()) {
  const cs = curveRangeToContours(cf, r.begin | 0, (r.end != null ? r.end : r.begin + r.count) | 0);
  const list = contoursToConverter(cs || [], null);
  if (list && list.length) base.push({ si, list });
  if (base.length >= LIMIT) break;
}
// A FRESH SEGMENT, not a spread of the original. The converter memoises a segment's implicit and its
// packed form on the segment itself, under symbols -- and a spread copies those, so a scaled copy
// would answer with the geometry it was scaled FROM (0 patches at every scale that runs after x1
// has populated them).
const scaleList = (list, k) =>
  list.map((c) =>
    c.map((sg) => {
      const out = { t: sg.t, P: sg.P.map((p) => [p[0] * k, p[1] * k]) };
      if (sg.cut) out.cut = true;
      if (sg.w !== undefined) out.w = sg.w;
      return out;
    }),
  );

const rows = [];
for (const k of SCALES) {
  let patches = 0,
    shapes = 0,
    nulls = 0,
    miss = 0,
    over = 0;
  const per = new Map();
  for (const b of base) {
    const list = scaleList(b.list, k);
    const got = [];
    let packed = null;
    // NO TOLERANCE PASSED, deliberately. The default scales itself to the contour's own
    // extent, so the probe does not have to know: a bar the caller has to remember to scale is a
    // bar that will one day not be scaled. Passing one here would override that and test a policy
    // the renderer does not use.
    try {
      packed = packCPatchShape(list, 0, { onPatches: (ps) => got.push(...ps) });
    } catch {}
    if (!packed) {
      nulls++;
      continue;
    }
    shapes++;
    patches += got.length;
    per.set(b.si, { n: got.length, m: 0 });
    if (got.length) {
      const all = [];
      for (const c of list) {
        for (const g of c) all.push(g);
        const a = segPt(c[0], 0),
          z = segPt(c[c.length - 1], 1);
        if (Math.hypot(a[0] - z[0], a[1] - z[1]) > 1e-6 * k) all.push({ t: 'line', P: [z, a] });
      }
      const m = coverageMiss(all, got, 48);
      miss += m.miss;
      over += m.over;
      per.get(b.si).m = m.miss;
    }
  }
  rows.push({
    k,
    shapes,
    nulls,
    patches,
    per,
    miss: miss / Math.max(1, shapes),
    over: over / Math.max(1, shapes),
  });
}
console.log(`${base.length} shapes, scaled by exact powers of two:`);
const ref = rows.find((r) => r.k === 1);
// Per shape: where does a scaled run disagree with x1?
if (ref) {
  const bad = [];
  for (const r of rows) {
    if (r.k === 1) continue;
    for (const [si, v] of r.per) {
      const rv = ref.per.get(si);
      if (!rv) continue;
      if (v.n !== rv.n || Math.abs(v.m - rv.m) > 1e-9)
        bad.push(
          `shape ${si} at x${r.k}: ${rv.n} patches / ${rv.m.toFixed(3)}% unpainted at x1, ` +
            `${v.n} / ${v.m.toFixed(3)}% here`,
        );
    }
  }
  console.log(`  ${bad.length} shape/scale disagreements with x1:`);
  for (const b of bad.slice(0, 10)) console.log(`    ${b}`);
}
for (const r of rows)
  console.log(
    `  x${String(r.k).padEnd(10)} ${String(r.shapes).padStart(3)} converted, ${String(r.nulls).padStart(3)} declined, ` +
      `${String(r.patches).padStart(5)} patches${ref && r.patches !== ref.patches ? ` (${r.patches > ref.patches ? '+' : ''}${r.patches - ref.patches} vs x1)` : ''}` +
      `   unpainted ${r.miss.toFixed(4)}%  spill ${r.over.toFixed(4)}%`,
  );
