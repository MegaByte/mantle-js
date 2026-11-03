// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzF32Sign — does the packed implicit keep its SIGN in float32?
//
// The GPU evaluates the packed form from float32 texels in float32 arithmetic; the model evaluates
// the same form in double. A patch is the intersection of {f >= 0}, so the only thing that decides
// whether a fragment is IN the patch is that sign -- and where the form is near-null, float32 is
// noise. Measured on tiger: the hard-step kernel (sign only, no distance, no AA) loses 12,254 of the
// 12,260 interior pixels the full kernel loses, so the sign is where to look.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { packCPatchShape } from '../src/renderer/cpatchPack.js';
import { packedEval } from '../src/geom/cpatchImplicit.js';
import { patchBBox, insideContour } from '../src/renderer/cpatchConvert.js';
import { segPt } from '../src/geom/cpatchImplicit.js';

/// packedEval in FLOAT32 throughout -- coefficients rounded as the texture stores them, and every
/// operation rounded as the GPU would. Mirrors CP_EVAL in _cpatchCoverage.glsl term for term.
const _F = Math.fround;
function packedEval32(pk, x0, y0) {
  const a = pk.a,
    k = pk.kind;
  const x = _F(x0),
    y = _F(y0);
  const aff = (r) => _F(_F(_F(_F(a[r][0]) * x) + _F(_F(a[r][1]) * y)) + _F(a[r][2]));
  const A0 = aff(0);
  if (k === 0 || k === 2) return A0;
  const A1 = aff(1);
  if (k === 1) return _F(_F(A0 * A0) - A1);
  const A2 = aff(2);
  if (k === 5) return _F(_F(A0 * A0) - _F(A1 * A2));
  if (k === 3) return _F(_F(_F(A0 * A0) * A0) - _F(A1 * A2));
  const A3 = aff(3);
  const C0 = _F(pk.c[0]),
    C1 = _F(pk.c[1]);
  const t1 = _F(_F(C1 * A0) * A3);
  const t2 = _F(_F(C0 * C0) * A0);
  const t3 = _F(C1 * _F(A1 * A1));
  const t4 = _F(_F(_F(2 * C0) * A1) * A2);
  const t5 = _F(A3 * _F(A2 * A2));
  return _F(_F(_F(_F(t1 - t2) - t3) + t4) - t5);
}

/// THE same FORM, EVALUATED ABOUT AN ORIGIN. An implicit of degree 3 in coordinates of ~700 takes
/// values around 1e8 whose meaningful part is 1e-11 -- in float32 that is entirely rounding, and the
/// SIGN is noise. Translating the frame to the patch's own center before evaluating shrinks the
/// coordinates to the patch's size and the cancellation with them. This measures whether that is
/// what is costing the sign.
function packedEval32At(pk, x0, y0, ox, oy) {
  const a = pk.a,
    k = pk.kind;
  const x = _F(x0 - ox),
    y = _F(y0 - oy);
  // Fold the origin into each functional's constant, in DOUBLE, the way a packer would.
  const aff = (r) =>
    _F(_F(_F(_F(a[r][0]) * x) + _F(_F(a[r][1]) * y)) + _F(a[r][2] + a[r][0] * ox + a[r][1] * oy));
  const A0 = aff(0);
  if (k === 0 || k === 2) return A0;
  const A1 = aff(1);
  if (k === 1) return _F(_F(A0 * A0) - A1);
  const A2 = aff(2);
  if (k === 5) return _F(_F(A0 * A0) - _F(A1 * A2));
  if (k === 3) return _F(_F(_F(A0 * A0) * A0) - _F(A1 * A2));
  const A3 = aff(3);
  const C0 = _F(pk.c[0]),
    C1 = _F(pk.c[1]);
  const t1 = _F(_F(C1 * A0) * A3);
  const t2 = _F(_F(C0 * C0) * A0);
  const t3 = _F(C1 * _F(A1 * A1));
  const t4 = _F(_F(_F(2 * C0) * A1) * A2);
  const t5 = _F(A3 * _F(A2 * A2));
  return _F(_F(_F(_F(t1 - t2) - t3) + t4) - t5);
}
const s = await importSvg(readFileSync(process.argv[2], 'utf8'));
const cf = new Float32Array(s.curves);
const byKind = new Map();
let n = 0,
  flips = 0,
  flipsO = 0;
// AND THE ONE THAT MATTERS MOST: the sign the PACKER stores. It is computed in double at the
// patch's interior point and written to the wire; the GPU multiplies f by it. If float32 disagrees
// about the sign AT THAT POINT, every fragment of the patch reads inverted and the whole patch
// paints nothing -- which is a large contiguous hole, not a scattering of wrong pixels.
let nSg = 0,
  sgFlip = 0,
  patchesHit = 0,
  patchesN = 0;
for (const r of s.curveRangesByShape || []) {
  const cs = curveRangeToContours(cf, r.begin | 0, (r.end != null ? r.end : r.begin + r.count) | 0);
  const list = cs && cs.length ? contoursToConverter(cs, null) : null;
  if (!list || !list.length) continue;
  const ps = [];
  try {
    packCPatchShape(list, 0, { onPatches: (a) => ps.push(...a) });
  } catch {
    continue;
  }
  for (const p of ps) {
    patchesN++;
    let bad = false;
    for (let i = 0; i < p.impls.length; i++) {
      const pk = p.impls[i].packed;
      if (!pk) continue;
      nSg++;
      const d = packedEval(pk, p.inside[0], p.inside[1]);
      const f = packedEval32(pk, p.inside[0], p.inside[1]);
      if (d >= 0 !== f >= 0) {
        sgFlip++;
        bad = true;
      }
    }
    if (bad) patchesHit++;
    const bb = p.bbox || patchBBox(p.curves);
    for (let q = 0; q < 24; q++) {
      // Sample INSIDE the patch, where every constraint should read >= 0.
      const t = (q + 0.5) / 24;
      const x = bb[0] + ((bb[2] - bb[0]) * (((q * 7) % 24) + 0.5)) / 24;
      const y = bb[1] + (bb[3] - bb[1]) * t;
      if (!insideContour(p.curves, x, y)) continue;
      const ox = (bb[0] + bb[2]) / 2,
        oy = (bb[1] + bb[3]) / 2;
      for (let i = 0; i < p.impls.length; i++) {
        const pk = p.impls[i].packed;
        if (!pk) continue;
        const sgn = packedEval(pk, p.inside[0], p.inside[1]) >= 0 ? 1 : -1;
        const d = packedEval(pk, x, y) * sgn,
          f = packedEval32(pk, x, y) * sgn;
        const g = packedEval32At(pk, x, y, ox, oy) * sgn;
        n++;
        if (d >= 0 !== g >= 0) flipsO++;
        if (d >= 0 !== f >= 0) {
          flips++;
          const e = byKind.get(pk.kind) || { n: 0, flip: 0 };
          e.flip++;
          byKind.set(pk.kind, e);
        }
        const e = byKind.get(pk.kind) || { n: 0, flip: 0 };
        e.n++;
        byKind.set(pk.kind, e);
      }
    }
  }
}
console.log(
  `the STORED SIGN, at the patch's own interior point: ${sgFlip} of ${nSg} constraints disagree` +
    ` between double and float32, affecting ${patchesHit} of ${patchesN} patches` +
    ` (${((100 * patchesHit) / Math.max(1, patchesN)).toFixed(2)}%)`,
);
console.log(
  `  the same evaluations ABOUT THE PATCH'S OWN CENTER: ${flipsO} flips (${((100 * flipsO) / Math.max(1, n)).toFixed(2)}%)`,
);
console.log(
  `${n} in-patch constraint evaluations; ${flips} flip SIGN between double and float32 (${((100 * flips) / Math.max(1, n)).toFixed(2)}%)`,
);
for (const [k, e] of [...byKind].sort((a, b) => b[1].flip - a[1].flip))
  console.log(
    `  kind ${k}: ${e.flip} of ${e.n} (${((100 * e.flip) / Math.max(1, e.n)).toFixed(2)}%)`,
  );
