// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzCpBezFaithful — CPatch's kind-4 constraint is built by the same bezoutCubicImplicit that
// misstated its own arc distance for a third of Loop-Blinn's crescents. CPatch usually escapes the
// consequence, because it substitutes the true arc distance wherever the foot point is interior --
// but at an ARC END it deliberately keeps the implicit, to close a corner sharply, and there a
// lying implicit paints. Measured on tiger: s187 puts 0.43 of a pixel down where its path covers
// 0.0000, with the implicit claiming an edge 0.053 px away whose arc is 0.662 px away.
//
// So: how many of the cubics CPatch packs as kind 4 misstate the distance to their own arc?
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { packCPatchShape } from '../src/renderer/cpatchPack.js';
import { CPK_BEZ } from '../src/geom/cpatchImplicit.js';
import { evalBezout, bezoutCubicImplicit } from '../src/geom/lbCubicMath.js';
import { parseMetaBin } from '../src/core/metaBin.js';
const SVG = readFileSync(process.env.SVG || '../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const sec = await importSvg(SVG, { preserveViewport: true });
const cf = new Float32Array(sec.curves);
const meta = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
const at = (cp, t) => {
  const u = 1 - t;
  return [
    u * u * u * cp[0][0] +
      3 * u * u * t * cp[1][0] +
      3 * u * t * t * cp[2][0] +
      t * t * t * cp[3][0],
    u * u * u * cp[0][1] +
      3 * u * u * t * cp[1][1] +
      3 * u * t * t * cp[2][1] +
      t * t * t * cp[3][1],
  ];
};
const gaps = [];
let n = 0,
  seen = 0;
for (const s of (process.env.SHAPES || Array.from({ length: 260 }, (_, i) => i).join(','))
  .split(',')
  .map(Number)) {
  const r = sec.curveRangesByShape && sec.curveRangesByShape[s];
  if (!r || !(meta.metaFloats[s * meta.floatsPerShape + 7] > 0)) continue;
  const evenOdd = meta.metaFloats[s * meta.floatsPerShape + 13] > 0.5;
  let cs = null;
  try {
    cs = contoursToConverter(curveRangeToContours(cf, r.begin | 0, r.end | 0), null);
  } catch {
    continue;
  }
  if (!cs) continue;
  const patches = [];
  try {
    packCPatchShape(cs, 0, { evenOdd, onPatches: (a) => patches.push(...a) });
  } catch {
    continue;
  }
  const done = new Set();
  for (const p of patches)
    for (let i = 0; i < p.curves.length; i++) {
      const im = p.impls[i],
        seg = p.curves[i];
      if (!im || !im.packed || im.packed.kind !== CPK_BEZ) continue;
      if (!seg || !seg.P || seg.P.length !== 4) continue;
      const key = seg.P.map((q) => q.join(',')).join(';');
      if (done.has(key)) continue;
      done.add(key);
      seen++;
      const cp = seg.P;
      let F = null;
      try {
        F = bezoutCubicImplicit(cp);
      } catch {
        continue;
      }
      if (!F) continue;
      n++;
      const chord = Math.hypot(cp[3][0] - cp[0][0], cp[3][1] - cp[0][1]) || 1;
      const h = 1e-5 * chord;
      const arc = [];
      for (let k = 0; k <= 16; k++) arc.push(at(cp, k / 16));
      let worst = 0;
      const G = 6;
      for (const tri of [
        [0, 1, 2],
        [0, 2, 3],
      ])
        for (let a = 0; a <= G; a++)
          for (let b = 0; a + b <= G; b++) {
            const wa = a / G,
              wb = b / G,
              wc = 1 - wa - wb;
            const x = wa * cp[tri[0]][0] + wb * cp[tri[1]][0] + wc * cp[tri[2]][0];
            const y = wa * cp[tri[0]][1] + wb * cp[tri[1]][1] + wc * cp[tri[2]][1];
            const f0 = evalBezout(F, x, y);
            const g = Math.hypot(
              (evalBezout(F, x + h, y) - evalBezout(F, x - h, y)) / (2 * h),
              (evalBezout(F, x, y + h) - evalBezout(F, x, y - h)) / (2 * h),
            );
            if (!(g > 0)) continue;
            let ad = Infinity;
            for (const P of arc) {
              const d = (P[0] - x) * (P[0] - x) + (P[1] - y) * (P[1] - y);
              if (d < ad) ad = d;
            }
            const gap = Math.sqrt(ad) - Math.abs(f0) / g;
            if (gap > worst) worst = gap;
          }
      gaps.push(worst / chord);
    }
}
gaps.sort((a, b) => a - b);
const q = (f) =>
  gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(f * gaps.length))].toFixed(3) : 'n/a';
const over = gaps.filter((g) => g > 0.05).length;
console.log(`${n} distinct kind-4 (Bezout) constraints CPatch packs.`);
console.log(
  `  ${over} (${((100 * over) / Math.max(1, n)).toFixed(1)}%) understate the distance to their own arc by >5% of the chord`,
);
console.log(
  `  worst understatement, over the chord:  median ${q(0.5)}  p90 ${q(0.9)}  max ${q(1)}`,
);
