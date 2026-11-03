// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzUnpainted — where a shape's interior gets no ink, and what the patches there are bounded by.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { packCPatchShape } from '../src/renderer/cpatchPack.js';
import { patchCoverage } from '../src/renderer/cpatchCov.js';
import { insideContour, patchBBox, patchCoverLines } from '../src/renderer/cpatchConvert.js';
import { segPt } from '../src/geom/cpatchImplicit.js';

const sections = await importSvg(readFileSync(process.argv[2], 'utf8'));
const cf = new Float32Array(sections.curves);
const SI = +process.argv[3],
  PX = +(process.env.PX || 160);
const r = sections.curveRangesByShape[SI];
const list = contoursToConverter(
  curveRangeToContours(cf, r.begin | 0, (r.end != null ? r.end : r.begin + r.count) | 0),
  null,
);
const all = [];
for (const c of list) {
  for (const g of c) all.push(g);
  const a = segPt(c[0], 0),
    b = segPt(c[c.length - 1], 1);
  if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-6) all.push({ t: 'line', P: [b, a] });
}
const patches = [];
packCPatchShape(list, 0, { onPatches: (ps) => patches.push(...ps) });
const bb = patchBBox(all),
  span = Math.max(bb[2] - bb[0], bb[3] - bb[1]);
// The kernel's scale and the sampling grid are separate: the guard evaluates at the shape across
// 512px and samples on a coarse grid, so a gap only that scale shows needs the same split here.
const em = span / +(process.env.SCALE || PX),
  x0 = bb[0] - span * 0.04,
  y0 = bb[1] - span * 0.04;
const step = (span * 1.08) / PX;
console.log(
  `shape ${SI}: ${list.length} contour(s), ${all.length} curves, ${patches.length} patches`,
);
const holes = [];
for (let py = 0; py < PX; py++)
  for (let px = 0; px < PX; px++) {
    const x = x0 + (px + 0.5) * step,
      y = y0 + (py + 0.5) * step;
    if (!insideContour(all, x, y)) continue;
    let open = 1;
    for (const p of patches) open *= 1 - Math.min(1, Math.max(0, patchCoverage(p, x, y, em)));
    if (1 - open < 0.5) holes.push({ x, y, c: 1 - open });
  }
console.log(`  ${holes.length} interior sample(s) with no ink`);
for (const h of holes.slice(0, 3)) {
  console.log(`  at em (${h.x.toFixed(2)},${h.y.toFixed(2)}) composite ${h.c.toFixed(3)}:`);
  for (let i = 0; i < patches.length; i++) {
    const p = patches[i];
    const bx = p.bbox;
    const inBox = h.x >= bx[0] - em && h.x <= bx[2] + em && h.y >= bx[1] - em && h.y <= bx[3] + em;
    if (!inBox) continue;
    const hl = p._h || (p._h = patchCoverLines(p.curves, 16) || []);
    let m = Infinity,
      mk = -1;
    for (const q of hl) {
      const a = (q[0] * h.x + q[1] * h.y + q[2]) / em;
      if (a < m) {
        m = a;
        mk = q[3] | 0;
      }
    }
    console.log(
      `    patch ${i} (${p.curves.length} curves, ${p.curves.filter((s) => s.cut).length} cuts):` +
        ` coverage ${patchCoverage(p, h.x, h.y, em).toFixed(3)}, tightest plane ` +
        `${['bridge', 'cut', 'arc'][mk] || '?'} ${m.toFixed(2)}px`,
    );
  }
}
