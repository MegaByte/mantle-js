// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzSeamIdentical — do the two patches sharing a seam derive the same line?
//
// A strict partition needs them to. Each patch frames its own copy of the cut, and if the two
// signed distances disagree in the last bits there is a hairline the strict test leaves to nobody.
// That crack is what a slack was covering; the fix is for the coefficients to be identical up to
// sign, not for the slack to hide them.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { packCPatchShape } from '../src/renderer/cpatchPack.js';
import { segPt } from '../src/geom/cpatchImplicit.js';

const sections = await importSvg(readFileSync(process.argv[2], 'utf8'));
const cf = new Float32Array(sections.curves);
let pairs = 0,
  same = 0,
  negated = 0,
  differ = 0;
const endGap = [];
const worst = [];
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
  // Index cuts by their endpoint pair, unordered, so both owners land in the same bucket.
  const by = new Map();
  for (const p of patches)
    for (let k = 0; k < p.curves.length; k++) {
      const sg = p.curves[k];
      if (!sg.cut) continue;
      const a = segPt(sg, 0),
        b = segPt(sg, 1);
      const ka = a[0] + ',' + a[1],
        kb = b[0] + ',' + b[1];
      // Keyed on the endpoints ROUNDED, so two sides that disagree in the last digits still land in
      // the same bucket -- which is the disagreement being measured.
      const rk = (p) => p.map((v) => v.toFixed(3)).join(',');
      const ra = rk(a),
        rb = rk(b);
      const key = ra < rb ? ra + '|' + rb : rb + '|' + ra;
      if (!by.has(key)) by.set(key, []);
      by.get(key).push({ p, k, sg });
    }
  for (const [, group] of by) {
    if (group.length !== 2) continue;
    pairs++;
    // How far apart are the two sides' endpoints?
    {
      const a0 = segPt(group[0].sg, 0),
        a1 = segPt(group[0].sg, 1);
      const b0 = segPt(group[1].sg, 0),
        b1 = segPt(group[1].sg, 1);
      const d = Math.min(
        Math.max(
          Math.hypot(a0[0] - b1[0], a0[1] - b1[1]),
          Math.hypot(a1[0] - b0[0], a1[1] - b0[1]),
        ),
        Math.max(
          Math.hypot(a0[0] - b0[0], a0[1] - b0[1]),
          Math.hypot(a1[0] - b1[0], a1[1] - b1[1]),
        ),
      );
      endGap.push(d);
    }
    const A = group[0].p.impls[group[0].k],
      B = group[1].p.impls[group[1].k];
    if (!A || !B || !A.packed || !B.packed) {
      differ++;
      continue;
    }
    // AN IMPLICIT IS DEFINED UP TO A POSITIVE SCALE, and the kernel divides by |grad| -- so what
    // has to agree is the NORMALIZED line, which is the signed distance itself.
    const norm = (v) => {
      const L = Math.hypot(v[0], v[1]) || 1;
      return [v[0] / L, v[1] / L, v[2] / L];
    };
    const a = norm(A.packed.a[0]),
      b = norm(B.packed.a[0]);
    const d = Math.max(
      ...[0, 1, 2].map((i) => Math.min(Math.abs(a[i] - b[i]), Math.abs(a[i] + b[i]))),
    );
    if (d === 0) {
      if (a[0] === b[0] && a[1] === b[1]) same++;
      else negated++;
    } else {
      differ++;
      // In em: how far apart do the two lines put the seam?
      const mid = segPt(group[0].sg, 0.5);
      const gap = Math.abs(
        a[0] * mid[0] + a[1] * mid[1] + a[2] - (b[0] * mid[0] + b[1] * mid[1] + b[2]),
      );
      const gapN = Math.abs(
        a[0] * mid[0] + a[1] * mid[1] + a[2] + (b[0] * mid[0] + b[1] * mid[1] + b[2]),
      );
      if (worst.length < 5) worst.push({ si, d, gap: Math.min(gap, gapN) });
    }
  }
}
endGap.sort((a, b) => a - b);
const eq = endGap.filter((d) => d === 0).length;
console.log(`${pairs} seams shared by exactly two patches`);
console.log(
  `  endpoints identical on ${eq}; the rest are apart by median ` +
    `${(endGap[(endGap.length + eq) >> 1] || 0).toExponential(2)} em, max ${(endGap[endGap.length - 1] || 0).toExponential(2)} em`,
);
console.log(`  identical ${same}, exact negatives ${negated}, DIFFERENT ${differ}`);
for (const w of worst)
  console.log(
    `    shape ${w.si}: coefficients differ by ${w.d.toExponential(2)}, ` +
      `which puts the seam ${w.gap.toExponential(2)} em apart at its midpoint`,
  );
