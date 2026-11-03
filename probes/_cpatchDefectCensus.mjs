// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _cpatchDefectCensus — WHICH defect blocks the contours the converter cannot validate.
//
// Coverage is what decides whether CPatch could replace Loop-Blinn rather than sit beside it,
// and "N% of contours fail" is not an actionable number. This classifies every failure by
// defect KIND and by the TYPE of the curve that caused it. The converter features each kind
// maps to, with the share of contours validated as each is added:
//
//   27.7%  oriented-box cover, no subdivision
//   70.4%  cover polygon = control-point hull instead of the oriented box
//   81.8%  subdivision as a LEAK repair. Halving a Bezier does not change its implicit, which
//          makes subdivision useless under a box cover; under the control HULL, halving shrinks
//          the hull, and a leak is a far branch passing through the cover.
//   87.0%  leaks COUNTED in the cut search. A scoreOf that measures only the clip direction
//          scores a cut that repairs a leak as no improvement, so the validator refuses patches
//          for a defect the search cannot see (leak-on-cut-seam 56 -> 3).
//   93.2%  subdivision generalized to clip defects. It cannot move the half-space, but it
//          shrinks the patch, and a clip violation is measured along the OTHER boundary curves,
//          which shrink with it. The chord-cut fallback refuses a minimal crescent, which is
//          exactly where clip:cubic failures sit.
//
// What is left is 22 of 324 contours with no dominant kind (leak 13, clip 11 across lines,
// cubics and cut seams): no single structural change covers them.
import { readFileSync } from 'fs';
import { parsePathD } from '../src/svg/path.js';
import { convertContour, validatePatch, patchBBox } from '../src/renderer/cpatchConvert.js';
import { cubicInflections, cubicLoopCuts, cubicSlice } from '../src/geom/lbCubicMath.js';
import { arcToRQuads } from '../src/geom/cpatchImplicit.js';
const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/\/$/, ''); // the package root
const files = ['examples/tiger.svg'];
import { readdirSync } from 'fs';
for (const f of readdirSync(ROOT + '/../fixtures/svg'))
  if (f.endsWith('.svg')) files.push('../fixtures/svg/' + f);
const all = [];
for (const f of files) {
  let txt;
  try {
    txt = readFileSync(ROOT + '/' + f, 'utf8');
  } catch {
    continue;
  }
  for (const m of txt.matchAll(/\sd\s*=\s*"([^"]+)"/g)) {
    let segs;
    try {
      segs = parsePathD(m[1]);
    } catch {
      continue;
    }
    let cur = null,
      bad = false;
    const flush = () => {
      if (cur && cur.length >= 2) all.push(cur);
      cur = null;
    };
    for (const s of segs) {
      if (s.subStart) flush();
      if (!cur) cur = [];
      if (s.type === 0 && s.p2) cur.push({ t: 'line', P: [s.p1, s.p2] });
      else if (s.type === 1 && s.p3) cur.push({ t: 'quad', P: [s.p1, s.p2, s.p3] });
      else if (s.type === 2 && s.p4) {
        const P = [s.p1, s.p2, s.p3, s.p4];
        const ts = cubicInflections(P)
          .concat(cubicLoopCuts(P))
          .sort((a, b) => a - b);
        let pr = 0;
        for (const t of ts) {
          if (t - pr > 1e-4) {
            cur.push({ t: 'cubic', P: cubicSlice(P, pr, t) });
            pr = t;
          }
        }
        cur.push({ t: 'cubic', P: cubicSlice(P, pr, 1) });
      } else if (s.type === 3) {
        const qs = arcToRQuads(s);
        if (!qs.length) {
          bad = true;
          break;
        }
        for (const q of qs) cur.push(q);
      } else {
        bad = true;
        break;
      }
    }
    if (!bad) flush();
  }
}
const kinds = {},
  byCurveCount = {},
  depthHist = {},
  depthMag = {},
  nCurves = {};
let clean = 0,
  dirty = 0,
  tot = 0,
  totBad = 0,
  totPatch = 0,
  termSub = 0,
  termFired = 0,
  capUn = 0,
  exh = 0,
  tn = 0;
for (const curves of all) {
  if (curves.length > 200) continue;
  const bb = patchBBox(curves);
  const S = Math.max(bb[2] - bb[0], bb[3] - bb[1]);
  if (!(S > 0)) continue;
  let out;
  try {
    out = convertContour(curves, {
      maxCurves: 8,
      tolPx: (0.05 * S) / 128,
      maxDepth: +(process.env.MD || 24),
      budget: +(process.env.BG || 8192),
      allowInvalid: true,
    });
  } catch {
    continue;
  }
  tot++;
  let bad = 0;
  for (const p of out.patches) {
    const v = validatePatch(p, (0.05 * S) / 128);
    if (!v.ok) {
      bad++;
      const w = v.worst;
      const key =
        w.kind +
        ':' +
        p.curves[w.i].t +
        (p.curves[w.i].cut ? '/cut' : '') +
        (p._terminal ? '[TERM]' : '');
      if (bad <= 1)
        console.log(
          '   invalid: [' +
            p.curves.map((x) => x.t).join(',') +
            '] ' +
            w.kind +
            ' depth ' +
            (w.depth || 0).toFixed(4) +
            ' tol ' +
            ((0.05 * S) / 128).toFixed(4) +
            (p._terminal ? '  TERMINAL' : '  NOT-terminal'),
        );
      kinds[key] = (kinds[key] || 0) + 1;
      const d = Math.min(Math.round(Math.log10(Math.max(w.depth, 1e-9))), 4);
      depthMag[d] = (depthMag[d] || 0) + 1;
      nCurves[Math.min(p.curves.length, 9)] = (nCurves[Math.min(p.curves.length, 9)] || 0) + 1;
    }
  }
  totBad += bad;
  totPatch += out.patches.length;
  termSub += out.stats.termSubdiv | 0;
  termFired += out.stats.terminal | 0;
  capUn += out.stats.unresolvedCap | 0;
  exh += out.stats.unresolvedExhausted | 0;
  tn += out.stats.terminalNull | 0;
  if (bad) {
    dirty++;
    byCurveCount[Math.min(curves.length, 12)] =
      (byCurveCount[Math.min(curves.length, 12)] || 0) + 1;
  } else clean++;
  depthHist[out.stats.maxDepth] = (depthHist[out.stats.maxDepth] || 0) + 1;
}
console.log(
  'contours',
  tot,
  'clean',
  clean,
  `(${((100 * clean) / tot).toFixed(1)}%)`,
  'dirty',
  dirty,
);
console.log('patches', totPatch, 'INVALID', totBad, `(${((100 * totBad) / totPatch).toFixed(2)}%)`);
console.log('blocking defect kind:', JSON.stringify(kinds));
console.log(
  'terminal fired',
  termFired,
  'termSubdiv',
  termSub,
  'unresolvedCap',
  capUn,
  'exhausted',
  exh,
  'terminalNull',
  tn,
);
console.log('dirty by input curve count:', JSON.stringify(byCurveCount));
console.log('failing patch curve count:', JSON.stringify(nCurves));
console.log('violation depth, log10 px:', JSON.stringify(depthMag));
