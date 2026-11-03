// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzWorstAa — the pixels furthest from the truth, and what each is made of. The bar is a MAX, so
// a mean says nothing about whether it is met; these are the pixels that decide it.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { packCPatchShape } from '../src/renderer/cpatchPack.js';
import { patchCoverage, curveCov } from '../src/renderer/cpatchCov.js';
import { rowSpans, patchBBox } from '../src/renderer/cpatchConvert.js';
import { segTightBBox, packedEval } from '../src/geom/cpatchImplicit.js';

const PX = +(process.env.PX || 256);
const THR = +(process.env.THR || 0.5);
const SVG = readFileSync(process.env.SVG || '../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const sec = await importSvg(SVG, { preserveViewport: true });
const cf = sec.curves64 ? new Float64Array(sec.curves64) : new Float32Array(sec.curves);
const GL = [
  [-0.906179845938664, 0.2369268850561891],
  [-0.5384693101056831, 0.4786286704993665],
  [0, 0.5688888888888889],
  [0.5384693101056831, 0.4786286704993665],
  [0.906179845938664, 0.2369268850561891],
];
const _r = {};
const hits = [];
for (let S = 0; S < (sec.curveRangesByShape || []).length; S++) {
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
  const bb = patchBBox(all);
  const em = Math.max(bb[2] - bb[0], bb[3] - bb[1]) / PX;
  for (let j = Math.floor(bb[1] / em) - 2; j <= Math.ceil(bb[3] / em) + 2; j++) {
    const cy = (j + 0.5) * em;
    for (let i = Math.floor(bb[0] / em) - 2; i <= Math.ceil(bb[2] / em) + 2; i++) {
      const cx = (i + 0.5) * em;
      let t = 0;
      for (const [q, w] of GL) {
        const y = cy + 0.5 * em * q;
        let c2 = 0;
        for (const sp of rowSpans(all, y) || [])
          c2 += Math.max(0, Math.min(cx + em / 2, sp[1]) - Math.max(cx - em / 2, sp[0]));
        t += (w * 0.5 * c2) / em;
      }
      t = Math.min(1, Math.max(0, t));
      let open = 1,
        nCov = 0,
        best = null;
      for (const p of ps) {
        const c = Math.min(1, Math.max(0, patchCoverage(p, cx, cy, em)));
        if (c > 0) nCov++;
        open *= 1 - c;
        if (!best || c > best.c) best = { c, p };
      }
      const got = 1 - open;
      if (Math.abs(got - t) <= THR) continue;
      // WHAT BOUNDS THE WINNING PATCH HERE, and is it bounded by anything that can ramp at all?
      const p = best.p;
      let lo = 2,
        who = 'none',
        allSeam = true;
      for (let k = 0; k < p.impls.length; k++) {
        const pk = p.impls[k].packed;
        if (!pk) continue;
        const seg = p.curves[k];
        const isCut = !!(seg && seg.cut);
        if (!isCut) allSeam = false;
        const sgn = packedEval(pk, p.inside[0], p.inside[1]) >= 0 ? 1 : -1;
        const c = curveCov(pk, sgn, isCut, segTightBBox(seg), cx, cy, em, _r, seg);
        if (c < lo) {
          lo = c;
          who = isCut ? 'seam' : _r.pick;
        }
      }
      hits.push({
        S,
        i,
        j,
        d: got - t,
        got,
        ref: t,
        who,
        allSeam,
        nCov,
        nc: p.curves.length,
        cuts: p.curves.filter((c) => c.cut).length,
      });
    }
  }
}
hits.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
console.log(`${hits.length} px more than ${THR} from the truth at ${PX}px per shape`);
const by = new Map(),
  dir = new Map();
for (const h of hits) {
  const k = `${h.allSeam ? 'ALL-SEAM patch' : 'bound by ' + h.who}`;
  by.set(k, (by.get(k) | 0) + 1);
  dir.set(h.d > 0 ? 'over' : 'under', (dir.get(h.d > 0 ? 'over' : 'under') | 0) + 1);
}
console.log(
  '  ' +
    [...by]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}: ${v}`)
      .join('   '),
);
console.log('  ' + [...dir].map(([k, v]) => `${k}-painted: ${v}`).join('   '));
for (const h of hits.slice(0, 10))
  console.log(
    `   s${h.S} (${h.i},${h.j}) got ${h.got.toFixed(3)} vs ${h.ref.toFixed(3)}` +
      ` (${h.d > 0 ? '+' : ''}${h.d.toFixed(3)}); winner has ${h.nc} curves ${h.cuts} cuts` +
      `${h.allSeam ? ' ALL-SEAM' : ''}, bound by ${h.who}, ${h.nCov} patches cover it`,
  );
