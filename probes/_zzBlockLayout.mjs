// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzBlockLayout — every constraint block is CP_BLOCK_TEXELS wide, and a curve block carries an arc.
//
// The wire is one long run of texels the kernel addresses as `idx * CP_BLOCK_TEXELS`, so an
// emission site that pushes the wrong number of texels does not fail loudly: it shifts every block
// after it, and the kernel reads a curve's coefficients out of its neighbour's box. There are five
// sites (separator, hull plane, two curve paths, the packed-line layout) and adding a texel means
// touching all five. This asks the two questions that catch a missed one -- is the run a whole
// number of blocks, and does every CURVE block have control points in texels 5 and 6.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import {
  packCPatchShape,
  CP_BLOCK_TEXELS,
  CPK_ARC3,
  arcTexels,
  arcIs3,
} from '../src/renderer/cpatchPack.js';
import { arcGeom } from '../src/renderer/cpatchCov.js';

const s = await importSvg(readFileSync(process.argv[2], 'utf8'));
const cf = new Float32Array(s.curves);
let blocks = 0,
  bad = 0,
  geomOk = 0,
  geomZero = 0,
  arcs = 0,
  arcBad = 0,
  arc3 = 0;
const kinds = new Map();
for (const r of s.curveRangesByShape || []) {
  const list = contoursToConverter(
    curveRangeToContours(cf, r.begin | 0, (r.end != null ? r.end : r.begin + r.count) | 0),
    null,
  );
  if (!list || !list.length) continue;
  const ps = [];
  let p = null;
  try {
    p = packCPatchShape(list, 0, { onPatches: (a) => ps.push(...a) });
  } catch {
    continue;
  }
  if (!p || !p.texels) continue;
  // AND THE WIRE AND THE MODEL MUST DESCRIBE THE same ARC. Both are pure functions of the segment,
  // so the invariant is checkable directly. It is the one that broke before: the model asked
  // `seg.t` and the packer asked the packed KIND, and a quadratic that packs to the conic implicit
  // had four cubic control points written where three points and a weight were read.
  for (const pt of ps)
    for (const seg of pt.curves) {
      if (seg.P.length < 3) continue; // a line never reads the arc
      const tx = arcTexels(seg),
        g = arcGeom(seg);
      arcs++;
      if (arcIs3(seg)) arc3++;
      const want = arcIs3(seg)
        ? [g.P0[0], g.P0[1], g.P1[0], g.P1[1], g.P2[0], g.P2[1], g.w, 0]
        : [g.P0[0], g.P0[1], g.P1[0], g.P1[1], g.P2[0], g.P2[1], g.P3[0], g.P3[1]];
      if (want.some((v, i) => v !== tx[i]) || (arcIs3(seg) ? 2 : 3) !== g.deg) arcBad++;
    }
  const t = p.texels;
  if (t.length % (CP_BLOCK_TEXELS * 4)) {
    bad++;
    continue;
  }
  for (let b = 0; b * CP_BLOCK_TEXELS * 4 < t.length; b++) {
    blocks++;
    const o = b * CP_BLOCK_TEXELS * 4;
    // Bit 5 is the ARC'S DEGREE, not part of the kind; strip it before classifying.
    const raw = t[o + 3],
      arc3 = raw >= CPK_ARC3,
      k = arc3 ? raw - CPK_ARC3 : raw;
    kinds.set(k, (kinds.get(k) | 0) + 1);
    // A LINE, A HULL PLANE AND A SEPARATOR HAVE NO ARC. A line's implicit IS its line, so no
    // companion branch and nothing for the control points to say; the rest bound rather than draw.
    if (k >= 14 || k % 8 === 0) continue;
    t.slice(o + 20, o + (arc3 ? 27 : 28)).every((v) => v === 0) ? geomZero++ : geomOk++;
  }
}
console.log(
  `${blocks} blocks of ${CP_BLOCK_TEXELS} texels, ${bad} shapes with a ragged texel count`,
);
console.log(
  '  kinds (arc-degree bit stripped) ' +
    [...kinds]
      .sort((a, b) => a[0] - b[0])
      .map(([k, n]) => `${k}:${n}`)
      .join(' '),
);
console.log(`  curve blocks with control points ${geomOk}, with none ${geomZero}`);
console.log(
  `  ${arcs} arcs (${arc3} three-point, ${arcs - arc3} cubic), ` +
    `${arcBad} where the wire and the model disagree`,
);
