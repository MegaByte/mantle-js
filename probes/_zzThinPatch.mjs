// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzThinPatch — how a SUB-PIXEL sliver decomposes, and what the kernel makes of it.
//
// Tiger's shape 120 is 0.119 em (0.068 px at 512) wide where both analytic engines paint it SOLID:
// CPatch reads coverage 1.000 against an exact 0.067, LB 1.000 against 0.002, while Slug manages
// 0.225 worst error on the same shape. CPatch's patch kernel is an INTERSECTION of half-spaces,
// so a sliver whose two sides live in ONE patch should come out at its true width -- and one split
// down the middle cannot, because each half claims its own side and the union saturates. Which of
// those happens is a converter question, and this asks it: how many patches cover the point, and
// what does each one's coverage say.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { patchCoverage } from '../src/renderer/cpatchCov.js';
import { segPt } from '../src/geom/cpatchImplicit.js';
import { rowSpans } from '../src/renderer/cpatchConvert.js';
import { parseMetaBin } from '../src/core/metaBin.js';

const SVG = readFileSync(process.env.SVG || '../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const sec = await importSvg(SVG, { preserveViewport: true });
const cf = sec.curves64 ? new Float64Array(sec.curves64) : new Float32Array(sec.curves);
const meta = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
const S = +(process.env.SHAPE || 120);
const PX = +(process.env.PXX || 245.2),
  PY = +(process.env.PXY || 278.6);
const EMPP = +(process.env.EMPP || 900 / 512);

const r = sec.curveRangesByShape[S];
const cs = curveRangeToContours(cf, r.begin | 0, r.end | 0);
const cv = contoursToConverter(cs, null);
const segs = [];
for (const c of cv) for (const sg of c) segs.push(sg);
const evenOdd = meta.metaFloats[S * meta.floatsPerShape + 13] > 0.5;

const { packCPatchShape } = await import('../src/renderer/cpatchPack.js');
const list = [];
packCPatchShape(cv, 0, { evenOdd, onPatches: (a2) => list.push(...a2) });
console.log(`s${S}: ${list.length} patches, one pixel = ${EMPP.toFixed(3)} em`);
const sp = rowSpans(segs, PY) || [];
console.log(
  `  exact span at y=${PY}: ` +
    sp
      .map(
        (q) =>
          `[${q[0].toFixed(3)},${q[1].toFixed(3)}] w=${(q[1] - q[0]).toFixed(3)}em = ${((q[1] - q[0]) / EMPP).toFixed(3)}px`,
      )
      .join(' '),
);
// Patches composite with MAX (see _zzCorpusSpill), so the rendered coverage is the largest single
// claim -- a sliver split down the middle cannot come out right however many patches share it.
let n = 0,
  mx = 0;
list.forEach((p, i) => {
  let c = 0;
  try {
    c = patchCoverage(p, PX, PY, EMPP);
  } catch {
    return;
  }
  if (!(c > 1e-4)) return;
  n++;
  if (c > mx) mx = c;
  console.log(
    `  patch ${i}: coverage ${c.toFixed(4)}  curves ${(p.curves || []).length}  impls ${(p.impls || []).length}`,
  );
  // PER CONSTRAINT. A drawn curve ramps and a SEAM is a hard step, and the difference decides
  // whether this pixel could ever have been antialiased by the patch's own constraints.
  (p.curves || []).forEach((sg, k) => {
    const isCut = !!(sg && sg.cut);
    let near = Infinity;
    for (let t = 0; t <= 1; t += 1 / 512) {
      const q = segPt(sg, t);
      const d = Math.hypot(q[0] - PX, q[1] - PY);
      if (d < near) near = d;
    }
    console.log(
      `      constraint ${k}: ${isCut ? 'SEAM (hard step)' : 'drawn curve ' + (sg.t || '?')}` +
        `  nearest point ${(near / EMPP).toFixed(4)}px away`,
    );
  });
});
console.log(`  ${n} patches cover the point; MAX (what the frame gets) = ${mx.toFixed(4)}`);
