// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzZeroPoint — a point the shape covers whole that no patch covers at all. Patches partition,
// and their seams are exclusive hard steps, so a point exactly on a seam can be rejected by both
// sides. This says whether that is what these are, or a real gap in the tiling.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { packCPatchShape } from '../src/renderer/cpatchPack.js';
import { patchCoverage } from '../src/renderer/cpatchCov.js';
import { rowSpans } from '../src/renderer/cpatchConvert.js';

const N = +(process.env.N || 384);
const S = +(process.env.S || 103);
const SVG = readFileSync(process.env.SVG || '../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const sec = await importSvg(SVG, { preserveViewport: true });
const cf = sec.curves64 ? new Float64Array(sec.curves64) : new Float32Array(sec.curves);
const r = sec.curveRangesByShape[S];
const cs = contoursToConverter(curveRangeToContours(cf, r.begin | 0, r.end | 0), null);
const ps = [];
packCPatchShape(cs, 0, { onPatches: (a) => ps.push(...a) });
const all = [];
for (const c of cs) for (const sg of c) all.push(sg);
let x0 = Infinity,
  y0 = Infinity,
  x1 = -Infinity,
  y1 = -Infinity;
for (const sg of all)
  for (const P of sg.P) {
    if (P[0] < x0) x0 = P[0];
    if (P[0] > x1) x1 = P[0];
    if (P[1] < y0) y0 = P[1];
    if (P[1] > y1) y1 = P[1];
  }
const SC = Math.max(x1 - x0, y1 - y0) / N;
const GL5 = [
  [-0.906179845938664, 0.2369268850561891],
  [-0.5384693101056831, 0.4786286704993665],
  [0, 0.5688888888888889],
  [0.5384693101056831, 0.4786286704993665],
  [0.906179845938664, 0.2369268850561891],
];
const hist = new Array(11).fill(0);
let ink = 0;
const worst = [];
for (let j = Math.floor(y0 / SC); j <= Math.ceil(y1 / SC); j++) {
  const cy = (j + 0.5) * SC;
  for (let i = Math.floor(x0 / SC); i <= Math.ceil(x1 / SC); i++) {
    const cx = (i + 0.5) * SC;
    let t = 0;
    for (const [q, w] of GL5) {
      const y = cy + 0.5 * SC * q;
      let c2 = 0;
      for (const sp of rowSpans(all, y) || [])
        c2 += Math.max(0, Math.min(cx + SC / 2, sp[1]) - Math.max(cx - SC / 2, sp[0]));
      t += (w * 0.5 * c2) / SC;
    }
    if (!(t > 0.999)) continue;
    ink++;
    let best = 0,
      n2 = 0;
    for (const p of ps) {
      const c = Math.min(1, Math.max(0, patchCoverage(p, cx, cy, SC)));
      if (c > best) best = c;
      if (c > 0.001) n2++;
    }
    hist[Math.min(10, Math.floor(best * 10))]++;
    if (best < 0.5 && worst.length < 6) worst.push({ cx, cy, best, n2 });
  }
}
console.log(`s${S}: ${ps.length} patches, ${ink} fully-covered px at ${N} across the shape`);
console.log('  best-patch coverage histogram: ' + hist.map((v, k) => `${k / 10}:${v}`).join(' '));
for (const w of worst) {
  // IS IT A SEAM? Nudge by a thousandth of a pixel each way: a point ON an exclusive partition is
  // rejected by both sides, and either neighbour picks it up a hair off.
  const d = SC * 1e-3;
  const around = [
    [d, 0],
    [-d, 0],
    [0, d],
    [0, -d],
  ].map(([dx, dy]) => {
    let b = 0;
    for (const p of ps) {
      const c = patchCoverage(p, w.cx + dx, w.cy + dy, SC);
      if (c > b) b = c;
    }
    return b.toFixed(3);
  });
  console.log(
    `  (${w.cx.toFixed(4)}, ${w.cy.toFixed(4)}): best ${w.best.toFixed(4)} from ${w.n2} patches;` +
      ` a thousandth of a pixel away: ${around.join(' ')}`,
  );
}

// ---- HOW BIG IS THE GAP? A seam-exact point is a measure-zero artifact of sampling; a gap with
// an extent is a hole in the tiling, and the two need different answers.
if (worst.length) {
  const w = worst[0];
  let n = 0,
    tot = 0;
  const R = 3;
  for (let dj = -R * 20; dj <= R * 20; dj++)
    for (let di = -R * 20; di <= R * 20; di++) {
      const x = w.cx + (di * SC) / 20,
        y = w.cy + (dj * SC) / 20;
      let inside = false;
      for (const sp of rowSpans(all, y) || []) if (x >= sp[0] && x <= sp[1]) inside = true;
      if (!inside) continue;
      tot++;
      let b = 0;
      for (const p of ps) {
        const c = patchCoverage(p, x, y, SC);
        if (c > b) b = c;
      }
      if (b < 0.5) n++;
    }
  const cell = SC / 20;
  console.log(
    `  the gap, scanned +/-${R}px at a twentieth of a pixel: ${n} of ${tot} samples under 0.5` +
      `  =>  ${(n * cell * cell).toExponential(2)} em^2, about ${((Math.sqrt(n) * cell) / SC).toFixed(3)} px across`,
  );
}
