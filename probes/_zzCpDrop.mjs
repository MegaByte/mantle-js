// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzCpDrop — a pixel CPatch drops, term by term. The transfer curve says the engine draws nothing
// at all for a share of the rim pixels whose center falls outside the path, and widening the cover
// dilation does not change that number, so the geometry reaches those pixels and a CONSTRAINT is
// what zeroes them. This asks the CPU kernel, which matches the shader term for term, which one.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { rowSpans, rowCross } from '../src/renderer/cpatchConvert.js';
import { packCPatchShape } from '../src/renderer/cpatchPack.js';
import { patchCoverage, curveCov } from '../src/renderer/cpatchCov.js';
import {
  segTightBBox,
  packedEval,
  CPK_LINE,
  CPK_QUAD,
  CPK_CUT,
  CPK_KLMN,
  CPK_RQUAD,
  CPK_BEZ,
} from '../src/geom/cpatchImplicit.js';
import { arcDistOf } from '../src/renderer/cpatchCov.js';
import { parseMetaBin } from '../src/core/metaBin.js';
const N = +(process.env.N || 512);
const SVG = readFileSync(process.env.SVG || '../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const sec = await importSvg(SVG, { preserveViewport: true });
const cf = new Float32Array(sec.curves);
const meta = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
const bb = [0, 0, 900, 900];
const emX = (i) => bb[0] + ((i + 0.5) / N) * bb[2];
const emY = (j) => bb[1] + (1 - (j + 0.5) / N) * bb[3];
const EPP = bb[2] / N;
for (const spec of (process.env.PTS || '227,396,116').split(' ')) {
  const [pi, pj, s] = spec.split(',').map(Number);
  const x = emX(pi),
    y = emY(pj);
  const r = sec.curveRangesByShape[s];
  const evenOdd = meta.metaFloats[s * meta.floatsPerShape + 13] > 0.5;
  const cs = contoursToConverter(curveRangeToContours(cf, r.begin | 0, r.end | 0), null);
  const patches = [];
  try {
    packCPatchShape(cs, 0, { evenOdd, onPatches: (a) => patches.push(...a) });
  } catch (e) {
    console.log(`${spec}: pack threw ${e.message}`);
    continue;
  }
  const all = [];
  for (const c of cs) for (const sg of c) all.push(sg);
  let cov = 0;
  const M = 33;
  for (let g = 0; g < M; g++) {
    const yy = y + EPP * ((g + 0.5) / M - 0.5);
    let spans;
    if (!evenOdd) spans = rowSpans(all, yy) || [];
    else {
      const xs = [];
      for (const sg of all) rowCross(sg, yy, (v) => xs.push(v));
      xs.sort((a, b) => a - b);
      spans = [];
      for (let z = 0; z + 1 < xs.length; z += 2) spans.push([xs[z], xs[z + 1]]);
    }
    let c3 = 0;
    for (const sp of spans)
      c3 += Math.max(0, Math.min(x + EPP / 2, sp[1]) - Math.max(x - EPP / 2, sp[0]));
    cov += c3 / EPP / M;
  }
  console.log(`px(${pi},${pj}) s${s}  path says ${cov.toFixed(4)}   ${patches.length} patches`);
  const rows = [];
  for (let k = 0; k < patches.length; k++) {
    globalThis.__CP_TRACE = 1;
    globalThis.__cpTrace = null;
    const c = patchCoverage(patches[k], x, y, EPP);
    const tr = globalThis.__cpTrace;
    const b = patches[k].bbox;
    const near =
      b && x >= b[0] - 3 * EPP && x <= b[2] + 3 * EPP && y >= b[1] - 3 * EPP && y <= b[3] + 3 * EPP;
    if (c > 1e-6 || near)
      rows.push({
        k,
        c,
        tr,
        seam: patches[k].curves.filter((q) => q && q.cut).length,
        n: patches[k].curves.length,
      });
  }
  rows.sort((a, b) => b.c - a.c);
  console.log(
    `  kernel model: total ${rows.reduce((a, q) => a + q.c, 0).toFixed(4)}   ` +
      rows
        .slice(0, 6)
        .map((q) => `p${q.k}=${q.c.toFixed(3)}(${q.seam}/${q.n} cut)`)
        .join(' '),
  );
  // TERM BY TERM for the patches nearest the pixel. patchCoverage returns one number and the
  // question is which of the mins produced it: a curve constraint mid-ramp is the AA doing its
  // job, a CUT reading zero is a partition that has excluded the pixel from this patch and has to
  // have handed it to the neighbour.
  for (const q of rows.slice(0, +(process.env.TERMS || 3))) {
    const P = patches[q.k];
    const parts = [];
    for (let i = 0; i < P.impls.length; i++) {
      const im = P.impls[i],
        pk = im.packed,
        seg = P.curves[i];
      if (!pk) {
        parts.push('unpacked');
        continue;
      }
      const isCut = !!(seg && seg.cut);
      const sgn = packedEval(pk, P.inside[0], P.inside[1]) >= 0 ? 1 : -1;
      const res = {};
      const c = curveCov(pk, sgn, isCut, segTightBBox(seg), x, y, EPP, res, seg);
      // WHICH KIND the constraint is, and what the DRAWN arc says. A constraint that ramps where
      // the path has nothing is either measuring the wrong distance or measuring it wrongly, and
      // the two are told apart by comparing its coverage against the true distance to its own arc.
      const KN = {
        [CPK_LINE]: 'line',
        [CPK_QUAD]: 'quad',
        [CPK_CUT]: 'cut',
        [CPK_KLMN]: 'klmn',
        [CPK_RQUAD]: 'rquad',
        [CPK_BEZ]: 'bez',
      };
      const kn = KN[pk.kind] || 'k' + pk.kind;
      let ad = NaN;
      try {
        ad = arcDistOf(seg, x, y, EPP) / EPP;
      } catch {}
      parts.push(
        `${isCut ? 'cut' : kn}${i}=${c.toFixed(3)}${res.nearArc ? '*' : ''}` +
          (isCut
            ? ''
            : `(arc ${Number.isFinite(ad) ? ad.toFixed(2) : '?'}px ` +
              `impl ${Number.isFinite(res.implD) ? res.implD.toFixed(3) : '?'} ` +
              `arcD ${Number.isFinite(res.arcD) ? res.arcD.toFixed(3) : '-'} ` +
              `t ${Number.isFinite(res.arcT) ? res.arcT.toFixed(3) : '-'} ` +
              `pick ${res.pick})`),
      );
    }
    const t = q.tr;
    console.log(
      `    p${q.k}: ${parts.join(' ')}` +
        (t
          ? `   -> cov ${t.cov.toFixed(3)} cutHard ${t.cutHard.toFixed(3)} cutSoft ${t.cutSoft.toFixed(3)} nearArc ${t.nearArc}  stopped at: ${t.stage}${t.row !== undefined ? ' rowKind ' + t.row : ''}`
          : '   -> (never reached the seam)'),
    );
  }
  // Walk a small neighbourhood so a drop reads as a hole rather than a number.
  for (let dj = 1; dj >= -1; dj--) {
    let line = '';
    for (let di = -3; di <= 3; di++) {
      const xx = emX(pi + di),
        yy = emY(pj + dj);
      let t = 0;
      for (const p of patches) t += patchCoverage(p, xx, yy, EPP);
      line += t >= 0.995 ? ' ## ' : t < 0.005 ? ' .. ' : t.toFixed(2).slice(1) + ' ';
    }
    console.log('   ' + line);
  }
}
