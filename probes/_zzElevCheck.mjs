// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzElevCheck — WHAT does the wire degree-elevate, and how far does the elevated curve move?
//
// Degree elevation is an identity in exact arithmetic -- the elevated cubic IS the quadratic -- but
// the interior control points are P0 + (2/3)(P1-P0), and 2/3 is not a binary fraction. So the
// question is not "is it exact" (it is not) but "how does its rounding compare with the rounding
// the wire already imposes", since the constraint texture is float32 and every control point is
// quantised to it regardless.
//
// It also asks which SEGMENT TYPES reach which packed KINDS, because the kernel picks the conic
// form by kind and the packer must pick the same one from the same number.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { packCPatchShape } from '../src/renderer/cpatchPack.js';
import { segPt, segImplicitPacked, segTightBBox } from '../src/geom/cpatchImplicit.js';

const f32 = (v) => Math.fround(v);
/// The elevated cubic, exactly as cpatchPack.arcTexels writes it, then through float32.
function elev(P) {
  const a = P[0];
  if (P.length === 3) {
    const m = P[1],
      d = P[2];
    return [
      a,
      [a[0] + (2 / 3) * (m[0] - a[0]), a[1] + (2 / 3) * (m[1] - a[1])],
      [d[0] + (2 / 3) * (m[0] - d[0]), d[1] + (2 / 3) * (m[1] - d[1])],
      d,
    ];
  }
  const d = P[1];
  return [
    a,
    [a[0] + (d[0] - a[0]) / 3, a[1] + (d[1] - a[1]) / 3],
    [a[0] + (2 * (d[0] - a[0])) / 3, a[1] + (2 * (d[1] - a[1])) / 3],
    d,
  ];
}
const cubAt = (Q, t) => {
  const u = 1 - t,
    b = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
  return [
    b[0] * Q[0][0] + b[1] * Q[1][0] + b[2] * Q[2][0] + b[3] * Q[3][0],
    b[0] * Q[0][1] + b[1] * Q[1][1] + b[2] * Q[2][1] + b[3] * Q[3][1],
  ];
};
const q32 = (Q) => Q.map((p) => [f32(p[0]), f32(p[1])]);

const files = process.argv.slice(2);
const byKind = new Map(); // "segType->kind" -> count
let nQuad = 0,
  worstElev = 0,
  worstF32 = 0,
  worst64 = 0,
  worstAt = null,
  scale = 0;
for (const file of files) {
  const sections = await importSvg(readFileSync(file, 'utf8'));
  const cf = new Float32Array(sections.curves);
  for (const [si, r] of (sections.curveRangesByShape || []).entries()) {
    const list = contoursToConverter(
      curveRangeToContours(cf, r.begin | 0, (r.end != null ? r.end : r.begin + r.count) | 0),
      null,
    );
    if (!list || !list.length) continue;
    const patches = [];
    try {
      packCPatchShape(list, 0, { onPatches: (ps) => patches.push(...ps) });
    } catch {
      continue;
    }
    for (const p of patches)
      for (const sg of p.curves) {
        const pk = segImplicitPacked(sg);
        if (!pk) continue;
        const key = `${sg.t}(${sg.P.length}pt) -> kind ${pk.kind}`;
        byKind.set(key, (byKind.get(key) | 0) + 1);
        if (sg.t === 'rquad' || sg.P.length >= 4) continue; // stored as-is
        nQuad++;
        // How far does the elevated curve sit from the original, and how far does float32 alone
        // move the ORIGINAL? The second is the floor the first has to be judged against.
        const Q = elev(sg.P),
          Q32 = q32(Q);
        const bb = segTightBBox(sg);
        const sc = Math.max(bb[2] - bb[0], bb[3] - bb[1]) || 1;
        const P32 = q32(sg.P.length === 3 ? sg.P : [sg.P[0], sg.P[0], sg.P[1], sg.P[1]]);
        for (let k = 1; k < 32; k++) {
          // INTERIOR t only: at an endpoint the elevated
          const t = k / 32; // cubic's own P0/P3 ARE the original's, so the
          const e = segPt(sg, t); // ends measure quantisation and nothing else.
          const d = Math.hypot(...cubAt(Q32, t).map((v, j) => v - e[j]));
          const d64 = Math.hypot(...cubAt(Q, t).map((v, j) => v - e[j])); // elevation ALONE
          // float32 alone: quantise the ORIGINAL control points and evaluate the same curve.
          const s2 = {
            t: sg.t,
            P: sg.P.length === 3 ? [P32[0], P32[1], P32[2]] : [P32[0], P32[3]],
          };
          const h = segPt(s2, t);
          const d2 = Math.hypot(h[0] - e[0], h[1] - e[1]);
          if (d > worstElev) {
            worstElev = d;
            worstAt = { si, t, sc };
          }
          if (d64 > worst64) worst64 = d64;
          if (d2 > worstF32) worstF32 = d2;
          scale = Math.max(scale, sc);
        }
      }
  }
}
console.log('segment type -> packed kind:');
for (const [k, n] of [...byKind].sort((a, b) => b[1] - a[1]))
  console.log(`  ${String(n).padStart(6)}  ${k}`);
console.log(`\n${nQuad} elevated segments (quadratics and lines)`);
if (nQuad) {
  console.log(
    `  worst |elevated(float64) - exact|  ${worst64.toExponential(3)} em  <- elevation ALONE`,
  );
  console.log(
    `  worst |elevated(float32) - exact|  ${worstElev.toExponential(3)} em` +
      (worstAt
        ? `  (shape ${worstAt.si}, t=${worstAt.t.toFixed(2)}, arc ${worstAt.sc.toFixed(2)} em)`
        : ''),
  );
  console.log(
    `  worst |original(float32) - exact|  ${worstF32.toExponential(3)} em  <- the wire's own floor`,
  );
  console.log(
    `  at 1024px over ${scale.toFixed(0)} em that is ${((worstElev / scale) * 1024).toExponential(2)} px` +
      ` against a float32 floor of ${((worstF32 / scale) * 1024).toExponential(2)} px`,
  );
}
