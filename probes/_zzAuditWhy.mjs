// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzAuditWhy — WHAT the over-paint audit is declining shapes for, by piece kind. A count of
// declines says nothing about which machinery would prevent them.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { buildLoopBlinnCDT } from '../src/renderer/loopBlinn.js';
import { parseMetaBin } from '../src/core/metaBin.js';
const SVG = readFileSync('../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const sec = await importSvg(SVG, { preserveViewport: true });
const cf = new Float32Array(sec.curves);
const meta = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
globalThis.__lbAuditTrace = 1;
let declined = 0;
const byKind = new Map();
const perShape = new Map();
let withKeep = 0,
  beyondKeep = 0;
const rel = [];
for (let s = 0; s < meta.numShapes; s++) {
  const r = sec.curveRangesByShape && sec.curveRangesByShape[s];
  if (!r || !(meta.metaFloats[s * meta.floatsPerShape + 7] > 0)) continue;
  const evenOdd = meta.metaFloats[s * meta.floatsPerShape + 13] > 0.5;
  let cs = null;
  try {
    cs = curveRangeToContours(cf, r.begin | 0, r.end | 0);
  } catch {
    continue;
  }
  if (!cs || !cs.length) continue;
  globalThis.__lbAuditBad = [];
  globalThis.__lbDeclineWhy = null;
  let m = null;
  try {
    m = buildLoopBlinnCDT(cs, { fillRule: evenOdd ? 'evenodd' : 'nonzero' });
  } catch {
    m = null;
  }
  if (m) continue;
  if (globalThis.__lbDeclineWhy !== 'coverage-audit') continue;
  declined++;
  let mx = 0,
    nb = 0;
  for (const b of globalThis.__lbAuditBad || []) {
    byKind.set(b.kind, (byKind.get(b.kind) || 0) + 1);
    if (b.hasKeep) {
      withKeep++;
      if (b.keepD > 0) beyondKeep++;
    }
    if (b.dEm != null && b.chord > 0) {
      rel.push(b.dEm / b.chord);
      if (b.dEm / b.chord > mx) mx = b.dEm / b.chord;
    }
    nb++;
  }
  perShape.set(s, { mx, nb });
}
console.log(`${declined} shapes declined by the over-paint audit`);
console.log(`  bad samples by piece kind: ${[...byKind].map(([k, v]) => k + ':' + v).join('  ')}`);
console.log(
  `  of the Bezout ones, ${withKeep} carry a keep half-plane and ${beyondKeep} lie BEYOND it`,
);
rel.sort((a, b) => a - b);
const q = (f) =>
  rel.length ? rel[Math.min(rel.length - 1, Math.floor(f * rel.length))].toFixed(3) : 'n/a';
console.log(`  how DEEP inside its own half-space the piece holds the sample, over the chord:`);
console.log(`    median ${q(0.5)}   p75 ${q(0.75)}   p90 ${q(0.9)}   p99 ${q(0.99)}   max ${q(1)}`);

// GUILTY vs CLEAN: a decline is JUSTIFIED when admitting the shape actually paints wrong pixels
// (measured on the GPU by _zzEnginePaint BLAME) and FALSE when it does not. If the two groups
// separate on the over-paint DEPTH, the audit has an honest analytic bar it is currently missing;
// if they do not, the depth is the wrong quantity and the difference is elsewhere.
const GUILTY = new Set(
  (
    process.env.GUILTY ||
    '12,13,34,90,91,94,105,106,115,173,174,175,176,177,178,180,182,183,184,187,189,191,193,197,213'
  )
    .split(',')
    .map(Number),
);
const g = [],
  c = [];
for (const [s, v] of perShape) (GUILTY.has(s) ? g : c).push(v.mx);
const stat = (a2) => {
  a2.sort((x, y) => x - y);
  const f = (t) =>
    a2.length ? a2[Math.min(a2.length - 1, Math.floor(t * a2.length))].toFixed(4) : 'n/a';
  return `n=${a2.length} min ${f(0)} median ${f(0.5)} p90 ${f(0.9)} max ${f(1)}`;
};
console.log(`  deepest over-paint per shape, as a fraction of the piece's chord:`);
console.log(`    GUILTY (admitting them paints wrong px): ${stat(g)}`);
console.log(`    CLEAN  (admitting them paints nothing) : ${stat(c)}`);
