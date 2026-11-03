// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// The kernel model, on the patches the RENDERER builds -- packCPatchShape's own, holes and all.
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

const N = +(process.env.N || 96);
const sections = await importSvg(readFileSync(process.argv[2], 'utf8'));
const cf = new Float32Array(sections.curves);
for (const [si, r] of (sections.curveRangesByShape || []).entries()) {
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
  const patches = [];
  let packed = null;
  try {
    packed = packCPatchShape(list, 0, { onPatches: (ps) => patches.push(...ps) });
  } catch (e) {}
  const m = coverageMiss(all, patches, N);
  console.log(
    `shape ${String(si).padStart(3)}: packed ${packed ? 'ok' : 'NULL'}, ${patches.length} patches  ` +
      `unpainted ${m.miss.toFixed(3)}%  spill ${m.over.toFixed(3)}%  thin ${m.thin.toFixed(3)}%`,
  );
}
