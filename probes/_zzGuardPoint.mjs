// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzGuardPoint — the guard's own sampling, with the failing samples named. coverageMiss evaluates
// the kernel at the shape across 512px but samples a 64x64 grid over a grown box, and skips
// anything within half a pixel of the outline; a probe that ties scale and grid together misses
// exactly the samples it refuses on.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { packCPatchShape } from '../src/renderer/cpatchPack.js';
import { patchCoverage } from '../src/renderer/cpatchCov.js';
import { rowSpans, patchCoverLines } from '../src/renderer/cpatchConvert.js';
import { segPt, packedEval } from '../src/geom/cpatchImplicit.js';

const sections = await importSvg(readFileSync(process.argv[2], 'utf8'));
const cf = new Float32Array(sections.curves);
const SI = +process.argv[3],
  n = 64;
const r = sections.curveRangesByShape[SI];
const list = contoursToConverter(
  curveRangeToContours(cf, r.begin | 0, (r.end != null ? r.end : r.begin + r.count) | 0),
  null,
);
const curves = [];
for (const c of list) {
  for (const g of c) curves.push(g);
  const a = segPt(c[0], 0),
    b = segPt(c[c.length - 1], 1);
  if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-6) curves.push({ t: 'line', P: [b, a] });
}
const patches = [];
packCPatchShape(list, 0, { onPatches: (ps) => patches.push(...ps) });
let x0 = Infinity,
  y0 = Infinity,
  x1 = -Infinity,
  y1 = -Infinity;
for (const s of curves)
  for (const p of s.P) {
    if (p[0] < x0) x0 = p[0];
    if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[1] > y1) y1 = p[1];
  }
const em = Math.max(x1 - x0, y1 - y0) / 512;
const gw = (x1 - x0) * 0.15,
  gh = (y1 - y0) * 0.15;
x0 -= gw;
x1 += gw;
y0 -= gh;
y1 += gh;
let tot = 0,
  miss = 0;
console.log(
  `shape ${SI}: ${curves.length} curves, ${patches.length} patches, emPerPx ${em.toFixed(4)}`,
);
for (let j = 0; j < n; j++) {
  const y = y0 + ((y1 - y0) * (j + 0.5)) / n;
  const spans = rowSpans(curves, y);
  for (let i = 0; i < n; i++) {
    const x = x0 + ((x1 - x0) * (i + 0.5)) / n;
    let inR = false,
      edge = Infinity;
    for (const sp of spans) {
      if (x >= sp[0] && x <= sp[1]) {
        inR = true;
        edge = Math.min(x - sp[0], sp[1] - x);
        break;
      }
      edge = Math.min(edge, Math.min(Math.abs(x - sp[0]), Math.abs(x - sp[1])));
    }
    if (edge < 0.5 * em) continue;
    if (!inR) continue;
    let open = 1;
    for (const p of patches) {
      const c = patchCoverage(p, x, y, em);
      if (c > 0) open *= 1 - c;
    }
    const painted = 1 - open;
    tot++;
    if (painted >= 0.5) continue;
    miss++;
    if (miss > 4) continue;
    console.log(
      `  MISS at em (${x.toFixed(9)},${y.toFixed(9)}) painted ${painted.toFixed(3)}, ${(edge / em).toFixed(1)}px from the outline along its row`,
    );
    // The two owners of the seam, evaluated side by side: what each one's cut says about this point.
    for (let k2 = 0; k2 < patches.length; k2++) {
      const p2 = patches[k2];
      for (let c2 = 0; c2 < p2.impls.length; c2++) {
        const sg2 = p2.curves[c2],
          im2 = p2.impls[c2];
        if (!sg2.cut || !im2.packed) continue;
        const sgn2 = packedEval(im2.packed, p2.inside[0], p2.inside[1]) >= 0 ? 1 : -1;
        const a2 = im2.packed.a[0],
          L2 = Math.hypot(a2[0], a2[1]) || 1;
        const sd2 = (sgn2 * (a2[0] * x + a2[1] * y + a2[2])) / L2 / em;
        const e0 = segPt(sg2, 0),
          e1 = segPt(sg2, 1);
        console.log(
          `      patch ${k2} cut (${e0[0].toFixed(1)},${e0[1].toFixed(1)})->(${e1[0].toFixed(1)},${e1[1].toFixed(1)}) sd ${sd2.toExponential(3)}px`,
        );
      }
    }
    for (let k = 0; k < patches.length; k++) {
      const p = patches[k];
      const hl = p._h || (p._h = patchCoverLines(p.curves, 16) || []);
      let m = Infinity,
        mk = -1;
      for (const q of hl) {
        const a = (q[0] * x + q[1] * y + q[2]) / em;
        if (a < m) {
          m = a;
          mk = q[3] | 0;
        }
      }
      console.log(
        `    patch ${k}: ${p.curves.length} curves (${p.curves.filter((s) => s.cut).length} cuts)` +
          `  coverage ${patchCoverage(p, x, y, em).toFixed(3)}  tightest plane ${['bridge', 'cut', 'arc'][mk] || '?'} ${m.toFixed(2)}px`,
      );
    }
  }
}
console.log(
  `  ${miss} of ${tot} interior samples unpainted (${((100 * miss) / Math.max(1, tot)).toFixed(3)}%)`,
);
