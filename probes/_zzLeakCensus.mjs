// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzLeakCensus — every pixel the kernel paints that the shape does not have, sorted by WHAT let
// it through. Two answers are possible and they need different fixes: a fragment INSIDE the
// painting patch's own cover is one the cover cannot reject, so the patch's region is wrong and
// the converter has to cut it; a fragment outside the cover is one the reach admitted.
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
const ASSET = +(process.env.ASSET || 1024);
let ax0 = Infinity,
  ay0 = Infinity,
  ax1 = -Infinity,
  ay1 = -Infinity;
const shapes = [];
for (const [si, r] of (sections.curveRangesByShape || []).entries()) {
  const cs = curveRangeToContours(cf, r.begin | 0, (r.end != null ? r.end : r.begin + r.count) | 0);
  const list = contoursToConverter(cs || [], null);
  if (!list || !list.length) continue;
  const b = patchBBox(list.flat());
  ax0 = Math.min(ax0, b[0]);
  ay0 = Math.min(ay0, b[1]);
  ax1 = Math.max(ax1, b[2]);
  ay1 = Math.max(ay1, b[3]);
  shapes.push({ si, list, b });
}
const emPerPx = Math.max(ax1 - ax0, ay1 - ay0) / ASSET;
let inHull = 0,
  byReach = 0,
  total = 0,
  worstIn = 0,
  worstAt = null;
const deep = [];
// Which plane is the tightest on a fragment the reach let through: 0 bridging (hard, undilated),
// 1 along a cut (hard, dilated), 2 along an arc (ramped).
const kindTally = [];
const dist = [];
for (const sh of shapes) {
  const all = [];
  for (const c of sh.list) {
    for (const sg of c) all.push(sg);
    const a = segPt(c[0], 0),
      b = segPt(c[c.length - 1], 1);
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-6) all.push({ t: 'line', P: [b, a] });
  }
  const patches = [];
  try {
    packCPatchShape(sh.list, 0, { onPatches: (ps) => patches.push(...ps) });
  } catch {
    continue;
  }
  if (!patches.length) continue;
  const NX = Math.ceil((sh.b[2] - sh.b[0]) / emPerPx) + 4,
    NY = Math.ceil((sh.b[3] - sh.b[1]) / emPerPx) + 4;
  for (let py = 0; py < NY; py++)
    for (let px = 0; px < NX; px++) {
      const x = sh.b[0] + (px - 1.5) * emPerPx,
        y = sh.b[1] + (py - 1.5) * emPerPx;
      if (insideContour(all, x, y)) continue;
      let open = 1;
      for (const p of patches)
        open *= 1 - Math.min(1, Math.max(0, patchCoverage(p, x, y, emPerPx)));
      if (1 - open <= 0.5) continue;
      // A PIXEL CENTER JUST OUTSIDE THE OUTLINE IS NOT A LEAK. Its box is half covered and the
      // engine is meant to paint it; only ink further out than the filter can reach is wrong.
      let d0 = Infinity;
      for (const sg of all)
        for (let k = 0; k <= 32; k++) {
          const q = segPt(sg, k / 32);
          d0 = Math.min(d0, Math.hypot(q[0] - x, q[1] - y));
        }
      if (d0 / emPerPx <= 1.0) continue;
      total++;
      let best = -Infinity,
        bestP = null,
        bestKind = -1;
      for (const p of patches) {
        if (patchCoverage(p, x, y, emPerPx) <= 0.5) continue;
        const hl = p._cpHull || (p._cpHull = patchCoverLines(p.curves, 16) || []);
        let m = Infinity,
          mk = -1;
        for (const h of hl) {
          const a = (h[0] * x + h[1] * y + h[2]) / emPerPx;
          if (a < m) {
            m = a;
            mk = h[3] | 0;
          }
        }
        if (m > best) {
          best = m;
          bestP = p;
          bestKind = mk;
        }
      }
      if (best < 0) kindTally[bestKind + 1] = (kindTally[bestKind + 1] || 0) + 1;
      if (best >= 0) {
        inHull++;
        if (best > worstIn) {
          worstIn = best;
          worstAt = {
            si: sh.si,
            x,
            y,
            n: bestP.curves.length,
            cuts: bestP.curves.filter((c) => c.cut).length,
          };
        }
      } else byReach++;
      dist.push(d0 / emPerPx);
      deep.push({
        si: sh.si,
        x,
        y,
        d: d0 / emPerPx,
        hull: best,
        recheck: insideContour(all, x, y),
        nAll: all.length,
        n: bestP ? bestP.curves.length : 0,
        cuts: bestP ? bestP.curves.filter((c) => c.cut).length : 0,
      });
    }
}
dist.sort((a, b) => a - b);
console.log(`${total} pixels painted MORE THAN A PIXEL outside a shape at a ${ASSET}px render`);
console.log(`  ${inHull} are INSIDE the painting patch's own cover (the cover cannot reject them)`);
console.log(`  ${byReach} are outside it and admitted by the reach`);
if (dist.length)
  console.log(
    `  how far outside the shape: median ${dist[dist.length >> 1].toFixed(2)}px, ` +
      `p90 ${dist[(dist.length * 0.9) | 0].toFixed(2)}px, max ${dist[dist.length - 1].toFixed(2)}px`,
  );
console.log(
  `  the tightest plane on those was: ` +
    [0, 1, 2]
      .map((k) => `${['bridging', 'along a cut', 'along an arc'][k]} ${kindTally[k + 1] || 0}`)
      .join(', '),
);
deep.sort((a, b) => b.d - a.d);
for (const w of deep.slice(0, 5))
  console.log(
    `    shape ${w.si} at em (${w.x.toFixed(6)},${w.y.toFixed(6)}) [${w.nAll} curves]: ${w.d.toFixed(1)}px outside, ` +
      `${w.hull >= 0 ? w.hull.toFixed(1) + 'px INSIDE its cover' : 'outside its cover'}, ` +
      `painted by a ${w.n}-curve patch (${w.cuts} cuts)  [re-checked inside? ${w.recheck}]`,
  );
if (worstAt)
  console.log(
    `  deepest inside a cover: ${worstIn.toFixed(2)}px, shape ${worstAt.si}, ` +
      `a ${worstAt.n}-curve patch with ${worstAt.cuts} cuts`,
  );
