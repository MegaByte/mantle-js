// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzCompanionBranch — how close does a curve's own implicit come back to it?
//
// A patch is bounded by half-spaces f >= 0, and f's zero set is the whole algebraic curve, not the
// drawn arc. Where a second component of that curve runs alongside the arc, f turns positive again
// a short way outside and the half-space stops bounding anything: the kernel's coverage ramps
// 0.5 -> 0 -> 1 across the band, which is a leak and a non-monotone edge at once. The arc box
// cannot separate them -- the companion is inside the arc's own box.
//
// This measures the separation, per curve, as a distance in em and in pixels at the asset's scale.
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
  segTangent,
  implEval,
  segTightBBox,
  packedEval,
} from '../src/geom/cpatchImplicit.js';
import { curveCov } from '../src/renderer/cpatchCov.js';
// The packed form's value and gradient, spelled the way the kernel spells it.
function evalGradAt(pk, x, y, out) {
  const h = 1e-6 * (1 + Math.abs(x) + Math.abs(y));
  const f = packedEval(pk, x, y);
  out[0] = f;
  out[1] = (packedEval(pk, x + h, y) - packedEval(pk, x - h, y)) / (2 * h);
  out[2] = (packedEval(pk, x, y + h) - packedEval(pk, x, y - h)) / (2 * h);
}

const file = process.argv[2];
const NT = +(process.env.NT || 17); // arc samples
const REACH = +(process.env.REACH || 3); // how far out to look, in em multiples of the probe step
const sections = await importSvg(readFileSync(file, 'utf8'));
const cf = new Float32Array(sections.curves);
let curves = 0,
  hit = 0;
const worst = [];
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
  const scale = Math.max(bb[2] - bb[0], bb[3] - bb[1]); // the shape's own size, in em
  for (const p of patches) {
    for (let k = 0; k < p.curves.length; k++) {
      const sg = p.curves[k],
        im = p.impls[k];
      if (!im || !im.impl || sg.cut || sg.t === 'line') continue;
      curves++;
      // IN THE KERNEL'S own TERMS. f is ~0 at the arc and its sign there is noise; the coverage
      // is not. Walk outward and ask when the constraint STOPS ramping down and comes back --
      // that is the leak, the non-monotone edge, and the number a band has to fit inside.
      const sgn = packedEval(im.packed, p.inside[0], p.inside[1]) >= 0 ? 1 : -1;
      const box = segTightBBox(sg);
      const emPerPx = scale / 128;
      let near = Infinity,
        rise = 0;
      for (let j = 1; j < NT - 1; j++) {
        const t = j / (NT - 1);
        const a = segPt(sg, t);
        // OUTWARD IS THE IMPLICIT'S own GRADIENT, NEGATED, and it has to be: the direction to the
        // patch's interior POINT is not the local outward normal on a curved arc, and using it
        // walks INTO the shape on every arc that bends away -- where coverage rises from a half to
        // one for the most ordinary of reasons.
        const gA = [0, 0, 0];
        evalGradAt(im.packed, a[0], a[1], gA);
        const gl = Math.hypot(gA[1], gA[2]);
        if (!(gl > 0)) continue;
        const nx = (-sgn * gA[1]) / gl,
          ny = (-sgn * gA[2]) / gl;
        let lo = 1;
        for (let s2 = 0.05; s2 <= REACH; s2 += 0.05) {
          const qx = a[0] + nx * s2 * emPerPx,
            qy = a[1] + ny * s2 * emPerPx;
          // OUTSIDE THE ARC'S own BOX THE CONSTRAINT BOUNDS nothing AND RETURNS 1 BY DESIGN. That
          // is not a companion branch, and counting it as one buries the defect in noise.
          if (
            qx < box[0] - emPerPx ||
            qx > box[2] + emPerPx ||
            qy < box[1] - emPerPx ||
            qy > box[3] + emPerPx
          )
            break;
          const c = curveCov(im.packed, sgn, false, box, qx, qy, emPerPx, {});
          if (c < lo) lo = c;
          // WALKING OUT OF A SHAPE, COVERAGE MUST NOT RISE. However far it comes back up is the
          // error the edge carries, and where it first does is how far out the band survives.
          else if (c - lo > rise) {
            rise = c - lo;
            if (near === Infinity && c - lo > 0.05) near = s2;
          }
        }
      }
      if (rise > 0.02 && process.env.DUMP && worst.length < +process.env.DUMP) {
        // The profile itself, so the number above can be checked rather than believed.
        const t = 0.5,
          a = segPt(sg, t),
          gA = [0, 0, 0];
        evalGradAt(im.packed, a[0], a[1], gA);
        const gl = Math.hypot(gA[1], gA[2]);
        const nx = (-sgn * gA[1]) / gl,
          ny = (-sgn * gA[2]) / gl;
        const prof = [];
        for (let s2 = -0.4; s2 <= 2.01; s2 += 0.2)
          prof.push(
            s2.toFixed(1) +
              ':' +
              curveCov(
                im.packed,
                sgn,
                false,
                box,
                a[0] + nx * s2 * emPerPx,
                a[1] + ny * s2 * emPerPx,
                emPerPx,
                {},
              ).toFixed(2),
          );
        console.log(
          `  shape ${si} ${sg.t} rise ${rise.toFixed(2)} @${near.toFixed(2)}px  profile(px out:cov) ${prof.join(' ')}`,
        );
      }
      if (rise > 0.02) {
        hit++;
        worst.push({ si, n: near, rel: near, rise, t: sg.t, nCur: p.curves.length });
      }
    }
  }
}
worst.sort((a, b) => b.rise - a.rise);
console.log(
  `${curves} outline curves in packed patches; ${hit} ramp back UP as the fragment leaves (${((100 * hit) / Math.max(1, curves)).toFixed(1)}%)`,
);
const q = (f) =>
  worst.length ? worst[Math.min(worst.length - 1, Math.floor(f * worst.length))].rise : NaN;
if (worst.length) {
  console.log(
    `  how far back up it comes: worst ${q(0).toFixed(3)}, p25 ${q(0.25).toFixed(3)}, median ${q(0.5).toFixed(3)}`,
  );
  let big = 0,
    huge = 0,
    inBand = 0;
  for (const w of worst) {
    if (w.rise > 0.3) big++;
    if (w.rise > 0.7) huge++;
    if (w.n <= 0.7072) inBand++;
  }
  console.log(`  ${big} rise by more than 0.3 coverage, ${huge} by more than 0.7`);
  const ns = worst.map((w) => w.n).sort((a, b) => a - b);
  console.log(
    `  the rise starts at: min ${ns[0].toFixed(2)}px, p25 ${ns[(ns.length * 0.25) | 0].toFixed(2)}px, ` +
      `median ${ns[(ns.length * 0.5) | 0].toFixed(2)}px, p75 ${ns[(ns.length * 0.75) | 0].toFixed(2)}px`,
  );
  console.log(`  ${inBand} of ${worst.length} start rising INSIDE the filter's reach (0.7072px)`);
  for (const w of worst.slice(0, 6))
    console.log(
      `    shape ${String(w.si).padStart(3)} ${w.t} in a ${w.nCur}-curve patch: rises ${w.rise.toFixed(3)} starting ${w.rel.toFixed(2)}px out`,
    );
}
