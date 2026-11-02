// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzSplitCompanion — does SUBDIVIDING an offending curve move its companion branch away?
//
// The companion branch is a property of the IMPLICIT, and a sub-arc's implicit is a different
// algebraic curve, not a restriction of the parent's. So a split is not a sampling refinement --
// it is a different analytic problem, and the question is whether it is a better-conditioned one.
// For every curve whose own coverage ramps back UP as the fragment leaves (_zzCompanionBranch),
// this splits it in half and asks the same question of each piece.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { packCPatchShape } from '../src/renderer/cpatchPack.js';
import { patchBBox } from '../src/renderer/cpatchConvert.js';
import {
  segPt,
  segTightBBox,
  segSlice,
  segImplicitPacked,
  packedEval,
} from '../src/geom/cpatchImplicit.js';
import { curveCov } from '../src/renderer/cpatchCov.js';

const NT = 17,
  REACH = 3;
/// How far a curve's coverage comes back UP as the fragment walks out of the shape, in coverage.
function riseOf(sg, pk, sgn, emPerPx) {
  const box = segTightBBox(sg);
  let rise = 0,
    near = Infinity;
  const h = 1e-6 * (1 + Math.abs(box[0]) + Math.abs(box[1]));
  for (let j = 1; j < NT - 1; j++) {
    const a = segPt(sg, j / (NT - 1));
    const gx = (packedEval(pk, a[0] + h, a[1]) - packedEval(pk, a[0] - h, a[1])) / (2 * h);
    const gy = (packedEval(pk, a[0], a[1] + h) - packedEval(pk, a[0], a[1] - h)) / (2 * h);
    const gl = Math.hypot(gx, gy);
    if (!(gl > 0)) continue;
    const nx = (-sgn * gx) / gl,
      ny = (-sgn * gy) / gl;
    let lo = 1;
    for (let s = 0.05; s <= REACH; s += 0.05) {
      const qx = a[0] + nx * s * emPerPx,
        qy = a[1] + ny * s * emPerPx;
      if (
        qx < box[0] - emPerPx ||
        qx > box[2] + emPerPx ||
        qy < box[1] - emPerPx ||
        qy > box[3] + emPerPx
      )
        break;
      const c = curveCov(pk, sgn, false, box, qx, qy, emPerPx, {});
      if (c < lo) lo = c;
      else if (c - lo > rise) {
        rise = c - lo;
        if (near === Infinity && c - lo > 0.05) near = s;
      }
    }
  }
  return { rise, near };
}
/// Pack a bare segment the way the packer would, with the orientation that reads inside at `at`.
function packOf(sg, at) {
  const pk = segImplicitPacked(sg);
  if (!pk) return null;
  return { pk, sgn: packedEval(pk, at[0], at[1]) >= 0 ? 1 : -1 };
}

const sections = await importSvg(readFileSync(process.argv[2], 'utf8'));
const cf = new Float32Array(sections.curves);
let curves = 0,
  hit = 0,
  fixed = 0,
  halved = 0,
  worse = 0,
  unpackable = 0;
const depths = [];
for (const [si, r] of (sections.curveRangesByShape || []).entries()) {
  const cs = curveRangeToContours(cf, r.begin | 0, (r.end != null ? r.end : r.begin + r.count) | 0);
  const list = contoursToConverter(cs || [], null);
  if (!list || !list.length) continue;
  const patches = [];
  try {
    packCPatchShape(list, 0, { onPatches: (ps) => patches.push(...ps) });
  } catch {
    continue;
  }
  if (!patches.length) continue;
  const bb = patchBBox(list.flat());
  const emPerPx = Math.max(bb[2] - bb[0], bb[3] - bb[1]) / 128;
  for (const p of patches) {
    for (let k = 0; k < p.curves.length; k++) {
      const sg = p.curves[k],
        im = p.impls[k];
      if (!im || !im.impl || sg.cut || sg.t === 'line') continue;
      curves++;
      const sgn = packedEval(im.packed, p.inside[0], p.inside[1]) >= 0 ? 1 : -1;
      const before = riseOf(sg, im.packed, sgn, emPerPx);
      if (!(before.rise > 0.02)) continue;
      hit++;
      // The two halves, each packed and oriented on its own. `at` stays the parent's interior
      // point: a sub-arc bounds the same patch, so it must read inside in the same place.
      let after = 0,
        ok = true;
      for (const [a, b] of [
        [0, 0.5],
        [0.5, 1],
      ]) {
        const sub = segSlice(sg, a, b);
        const q = sub && packOf(sub, p.inside);
        if (!q) {
          ok = false;
          break;
        }
        after = Math.max(after, riseOf(sub, q.pk, q.sgn, emPerPx).rise);
      }
      if (!ok) {
        unpackable++;
        continue;
      }
      depths.push([before.rise, after]);
      if (after <= 0.02) fixed++;
      else if (after <= before.rise * 0.5) halved++;
      else if (after > before.rise + 1e-9) worse++;
    }
  }
}
console.log(
  `${curves} outline curves, ${hit} with a companion branch in reach (${((100 * hit) / Math.max(1, curves)).toFixed(1)}%)`,
);
console.log(
  `  splitting each in half: ${fixed} CLEARED, ${halved} more than halved, ${worse} worse, ${unpackable} unpackable`,
);
if (depths.length) {
  const mb = depths.reduce((s, d) => s + d[0], 0) / depths.length;
  const ma = depths.reduce((s, d) => s + d[1], 0) / depths.length;
  console.log(`  mean rise ${mb.toFixed(3)} -> ${ma.toFixed(3)}`);
}
