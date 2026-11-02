// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzHoles — interior the patches do not tile, measured as GEOMETRY rather than as pixels.
//
// A hole is a fixed size in em, so calling one "sub-pixel" is a statement about the render, not
// about the defect: the same hole is 0.2px across at a 512px render and 1.7px at 2048. This finds
// them on a fine grid, clusters them, and reports each one's extent in em -- and what it would be
// at a few render sizes.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { packCPatchShape } from '../src/renderer/cpatchPack.js';
import { insideContour, patchBBox, rowSpans } from '../src/renderer/cpatchConvert.js';
import { patchCoverage } from '../src/renderer/cpatchCov.js';
import { segPt } from '../src/geom/cpatchImplicit.js';

const sections = await importSvg(readFileSync(process.argv[2], 'utf8'));
const cf = new Float32Array(sections.curves);
const ONLY = process.argv[3] != null ? +process.argv[3] : null;
const N = +(process.env.N || 700);
const inLoop = (loop, x, y) => {
  for (const sp of rowSpans(loop, y)) if (x >= sp[0] && x <= sp[1]) return true;
  return false;
};
let assetSpan = 0;
const shapes = [];
for (const [si, r] of (sections.curveRangesByShape || []).entries()) {
  const list = contoursToConverter(
    curveRangeToContours(cf, r.begin | 0, (r.end != null ? r.end : r.begin + r.count) | 0),
    null,
  );
  if (!list || !list.length) continue;
  shapes.push({ si, list });
}
{
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const sh of shapes) {
    const b = patchBBox(sh.list.flat());
    x0 = Math.min(x0, b[0]);
    y0 = Math.min(y0, b[1]);
    x1 = Math.max(x1, b[2]);
    y1 = Math.max(y1, b[3]);
  }
  assetSpan = Math.max(x1 - x0, y1 - y0);
}
const holes = [],
  untiled = [];
let totIn = 0,
  totHole = 0;
for (const sh of shapes) {
  if (ONLY != null && sh.si !== ONLY) continue;
  const all = [];
  for (const c of sh.list) {
    for (const g of c) all.push(g);
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
  const bb = patchBBox(all),
    span = Math.max(bb[2] - bb[0], bb[3] - bb[1]);
  const step = (span * 1.02) / N,
    em = span / 512;
  const hits = [];
  let inN = 0;
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const x = bb[0] - span * 0.01 + (i + 0.5) * step,
        y = bb[1] - span * 0.01 + (j + 0.5) * step;
      if (!insideContour(all, x, y)) continue;
      inN++;
      let inAny = false;
      for (const p of patches)
        if (inLoop(p.curves, x, y)) {
          inAny = true;
          break;
        }
      // AND only IF IT IS actually UNPAINTED. A point lying exactly on the boundary two patches
      // share is inside NEITHER loop under the half-open span rule, while the kernel covers it
      // fully -- 19 of tiger's "holes" were that, each with a patch boundary 0.001 em away and
      // coverage 1.000. A hole worth reporting is one the renderer leaves empty.
      if (!inAny) {
        let open = 1;
        for (const p of patches) open *= 1 - Math.min(1, Math.max(0, patchCoverage(p, x, y, em)));
        if (1 - open < 0.5) hits.push([x, y]);
      }
    }
  if (hits.length)
    untiled.push({ si: sh.si, frac: hits.length / Math.max(1, inN), n: hits.length, inN });
  totIn += inN;
  totHole += hits.length;
  // Cluster: anything within two grid steps is the same hole.
  const used = new Array(hits.length).fill(false);
  for (let i = 0; i < hits.length; i++) {
    if (used[i]) continue;
    const q = [i];
    used[i] = true;
    let x0 = hits[i][0],
      x1 = hits[i][0],
      y0 = hits[i][1],
      y1 = hits[i][1],
      n = 0;
    while (q.length) {
      const k = q.pop();
      n++;
      const [hx, hy] = hits[k];
      x0 = Math.min(x0, hx);
      x1 = Math.max(x1, hx);
      y0 = Math.min(y0, hy);
      y1 = Math.max(y1, hy);
      for (let m = 0; m < hits.length; m++)
        if (
          !used[m] &&
          Math.abs(hits[m][0] - hx) <= 2.1 * step &&
          Math.abs(hits[m][1] - hy) <= 2.1 * step
        ) {
          used[m] = true;
          q.push(m);
        }
    }
    holes.push({
      si: sh.si,
      n,
      w: x1 - x0 + step,
      h: y1 - y0 + step,
      x: (x0 + x1) / 2,
      y: (y0 + y1) / 2,
      sx: hits[i][0],
      sy: hits[i][1],
    });
  }
}
holes.sort((a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h));
console.log(
  `${holes.length} untiled region(s) across the asset, grid step ${(assetSpan / N).toFixed(3)} em`,
);
console.log(
  `  untiled area: ${((100 * totHole) / Math.max(1, totIn)).toFixed(4)}% of interior, across ${untiled.length} of ${shapes.length} shapes`,
);
untiled.sort((a, b) => b.frac - a.frac);
for (const u of untiled.slice(0, 5))
  console.log(
    `    shape ${String(u.si).padStart(3)}: ${(100 * u.frac).toFixed(3)}% of its interior untiled (${u.n} of ${u.inN} samples)`,
  );
const px = (em, at) => (em / (assetSpan / at)).toFixed(2);
for (const h of holes.slice(0, 12)) {
  const d = Math.max(h.w, h.h);
  console.log(
    `  shape ${String(h.si).padStart(3)} at em (${h.x.toFixed(1)},${h.y.toFixed(1)}): ` +
      `${h.w.toFixed(3)} x ${h.h.toFixed(3)} em, ${h.n} sample(s)` +
      `  -> ${px(d, 512)}px at 512, ${px(d, 2048)}px at 2048, ${px(d, 8192)}px at 8192` +
      `   [a sample: (${h.sx.toFixed(4)},${h.sy.toFixed(4)})]`,
  );
}
