// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzSeamHoles — the isolated single pixels a decomposition drops. Patches PARTITION a shape and
// their seams are exclusive hard steps, so a fragment the two sides of one seam both reject is a
// hole with no engine-level cause: nothing is over-painting and nothing is under-filling an edge.
// Reports, for pixels the path covers whole, the best single patch and the OVER composite.
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
import { curveCov, CP_AA_REACH } from '../src/renderer/cpatchCov.js';
import { segTightBBox, packedEval } from '../src/geom/cpatchImplicit.js';
import { CP_HULL_ROW_SAMPLES } from '../src/renderer/cpatchPack.js';

const gate = new Map();
/// Which of the patch's bounds reports the lowest value here -- a CURVE constraint, a SEAM, or one
/// of the cover's planes (and which kind of plane).
function bindOf(p, x, y, em) {
  let lo = 2,
    who = '?';
  for (let i = 0; i < p.impls.length; i++) {
    const pk = p.impls[i].packed;
    if (!pk) continue;
    const seg = p.curves[i];
    const isCut = !!(seg && seg.cut);
    const sgn = packedEval(pk, p.inside[0], p.inside[1]) >= 0 ? 1 : -1;
    const c = curveCov(pk, sgn, isCut, segTightBBox(seg), x, y, em, {}, seg);
    if (c < lo) {
      lo = c;
      who = isCut ? 'seam' : 'curve';
    }
  }
  // the same reading the packer makes (__CP_HULL_ROW_SAMPLES is a test hook, honored only under __MANTLE_DEBUG__)
  const hl =
    patchCoverLines(
      p.curves,
      globalThis.__MANTLE_DEBUG__ === true && globalThis.__CP_HULL_ROW_SAMPLES != null
        ? globalThis.__CP_HULL_ROW_SAMPLES
        : CP_HULL_ROW_SAMPLES,
    ) || [];
  for (const h of hl) {
    const A = (h[0] * x + h[1] * y + h[2]) / em;
    const c = Math.max(0, Math.min(1, 0.5 + A / (2 * CP_AA_REACH)));
    if (c < lo) {
      lo = c;
      who = 'plane' + (h[3] | 0);
    }
  }
  return who;
}

const N = +(process.env.N || 1024);
const SVG = readFileSync(process.env.SVG || '../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const sec = await importSvg(SVG, { preserveViewport: true });
const cf = sec.curves64 ? new Float64Array(sec.curves64) : new Float32Array(sec.curves);
const SC = sec.viewBox[2] / N;
const GL5 = [
  [-0.906179845938664, 0.2369268850561891],
  [-0.5384693101056831, 0.4786286704993665],
  [0, 0.5688888888888889],
  [0.5384693101056831, 0.4786286704993665],
  [0.906179845938664, 0.2369268850561891],
];
const LIST = (process.env.S || '').length
  ? process.env.S.split(',').map(Number)
  : (sec.curveRangesByShape || []).map((_, i) => i);
let ink = 0,
  holeMax = 0,
  holeOver = 0,
  worst = 1,
  worstAt = '';
const by = new Map();
for (const S of LIST) {
  const r = sec.curveRangesByShape[S];
  if (!r) continue;
  let cs = null;
  try {
    cs = contoursToConverter(curveRangeToContours(cf, r.begin | 0, r.end | 0), null);
  } catch {
    cs = null;
  }
  if (!cs || !cs.length) continue;
  const ps = [];
  try {
    packCPatchShape(cs, 0, { onPatches: (a) => ps.push(...a) });
  } catch {
    continue;
  }
  if (!ps.length) continue;
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
  let sn = 0;
  for (let j = Math.floor(y0 / SC); j <= Math.ceil(y1 / SC); j++) {
    const cy = (j + 0.5) * SC;
    for (let i = Math.floor(x0 / SC); i <= Math.ceil(x1 / SC); i++) {
      const cx = (i + 0.5) * SC;
      // exact coverage of the path at this pixel: only a pixel the shape covers whole can be a hole.
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
        open = 1,
        bp = null;
      for (const p of ps) {
        const c = Math.min(1, Math.max(0, patchCoverage(p, cx, cy, SC)));
        if (c > best) {
          best = c;
          bp = p;
        }
        open *= 1 - c;
      }
      const over = 1 - open;
      if (best < 0.99) {
        holeMax++;
        sn++;
        // WHAT HOLDS IT BACK: the patch's own curve constraints, or a plane of its cover? They are
        // different fixes, so the count is split before either is tried.
        if (bp) {
          const g = bindOf(bp, cx, cy, SC);
          gate.set(g, (gate.get(g) | 0) + 1);
        }
        if (best < worst) {
          worst = best;
          worstAt = `s${S} (${i},${j})`;
        }
      }
      if (over < 0.99) holeOver++;
    }
  }
  if (sn) by.set(S, sn);
}
console.log(`${ink} fully-covered px over ${LIST.length} shapes at ${N}px`);
console.log(`  best single patch < 0.99: ${holeMax}   OVER of all patches < 0.99: ${holeOver}`);
console.log(`  worst single-patch coverage ${worst.toFixed(4)} at ${worstAt}`);
console.log(
  '  what binds them: ' +
    [...gate]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}:${v}`)
      .join(' '),
);
const top = [...by].sort((a, b) => b[1] - a[1]).slice(0, 8);
if (top.length) console.log('  by shape: ' + top.map(([k, v]) => `s${k}:${v}`).join(' '));
