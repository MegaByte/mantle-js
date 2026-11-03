// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Does the SHAPE render right? Per-cycle probes compare patches against the cycle they came from,
// so a change that alters which cycles are produced moves the yardstick with the result. This
// compares the union of every patch of every cycle against the ORIGINAL path's nonzero fill, which
// is what actually gets painted.
// IT DOES NOT KNOW WHETHER THE SHAPE IS FILLED. Ground truth is the path's nonzero interior, so a
// stroke-only or fill:none shape counts as ink that no patch covers and reads as pure under-fill --
// _blur 70.6%, _fgraph_blend 53.8%, _dash_circle 37.6%, all of it on shapes CPatch is right not to
// fill. The absolute number is meaningless on such an asset; A/B THE same ASSET against a baseline,
// which is what it is for. On tiger, where the shapes are fills, the absolute number is real.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { pathToCycles } from '../src/geom/cpatchGraph.js';
import {
  convertContour,
  inPatch,
  insideContour,
  CP_TOL_DEFAULT,
} from '../src/renderer/cpatchConvert.js';
import { segPt } from '../src/geom/cpatchImplicit.js';

const G = +(process.env.G || 128);
const sections = await importSvg(readFileSync(process.argv[2], 'utf8'));
const cf = new Float32Array(sections.curves);
let tOver = 0,
  tUnder = 0,
  tInk = 0,
  tCyc = 0,
  tPatch = 0,
  nShapes = 0,
  noPatch = 0;
const worst = [];
const ONLY = (process.env.SHAPES || '').split(',').filter(Boolean).map(Number);
// THE CONVERTER'S ACCEPTED DEFECT SIZE, in the contour's own units. Sweepable, because it is the
// floor on how well the patches can tile: a sample further inside than this is a hole by design.
// UNSET MEANS THE DEFAULT, and the default is SCALED to the contour's own extent -- passing a
// flat number here overrides that and measures a policy the renderer does not use.
const TOL = process.env.TOL ? +process.env.TOL : null;
for (const [si, r] of (sections.curveRangesByShape || []).entries()) {
  if (ONLY.length && !ONLY.includes(si)) continue;
  const cs = curveRangeToContours(cf, r.begin | 0, (r.end != null ? r.end : r.begin + r.count) | 0);
  const list = contoursToConverter(cs || [], null);
  if (!list || !list.length) continue;
  // SVG fills an OPEN subpath by implicitly closing it with a straight line, and the pipeline's
  // closeLoop does the same. Ground truth has to close it too: six tiger contours are 97-100% open
  // -- their two ends are as far apart as the shape is wide -- and scoring a correctly closed
  // decomposition against an unclosed truth reads as pure over-fill.
  const all = [];
  for (const c of list) {
    for (const sg of c) all.push(sg);
    const a = segPt(c[0], 0),
      b = segPt(c[c.length - 1], 1);
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-9) all.push({ t: 'line', P: [b, a] });
  }
  let cycles = [];
  try {
    cycles = pathToCycles(list, false) || [];
  } catch {
    cycles = [];
  }
  // MIRROR THE SHIPPING FALLBACK. MantleCPatchJs.ConvertShape does not give up when the arrangement
  // returns nothing -- it converts the raw subpaths instead. A probe that omits that measures a
  // pipeline nobody runs and reports a contour that produced no cycles as lost ink, when the real
  // renderer painted it.
  if (!cycles.length && process.env.NO_FALLBACK !== '1') {
    cycles = list.map((c) => {
      const a = segPt(c[0], 0),
        b = segPt(c[c.length - 1], 1);
      return Math.hypot(a[0] - b[0], a[1] - b[1]) <= 1e-6
        ? c
        : c.concat([{ t: 'line', P: [b, a] }]);
    });
  }
  tCyc += cycles.length;
  const patches = [];
  for (const c of cycles) {
    try {
      const rr = convertContour(c, TOL == null ? { maxCurves: 8 } : { maxCurves: 8, tolPx: TOL });
      if (rr && rr.patches) patches.push(...rr.patches);
    } catch {
      /* refused */
    }
  }
  tPatch += patches.length;
  if (!patches.length) noPatch++;
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const s of all)
    for (const p of s.P) {
      x0 = Math.min(x0, p[0]);
      x1 = Math.max(x1, p[0]);
      y0 = Math.min(y0, p[1]);
      y1 = Math.max(y1, p[1]);
    }
  const pad = 0.02 * Math.max(x1 - x0, y1 - y0) + 1;
  x0 -= pad;
  y0 -= pad;
  x1 += pad;
  y1 += pad;
  let over = 0,
    under = 0,
    ink = 0;
  for (let gy = 0; gy < G; gy++) {
    const y = y0 + (y1 - y0) * ((gy + 0.5) / G);
    for (let gx = 0; gx < G; gx++) {
      const x = x0 + (x1 - x0) * ((gx + 0.5) / G);
      const truth = insideContour(all, x, y);
      let got = false;
      for (const p of patches)
        if (inPatch(p, x, y)) {
          got = true;
          break;
        }
      if (truth) ink++;
      if (got && !truth) over++;
      else if (!got && truth) under++;
    }
  }
  if (!ink) continue;
  nShapes++;
  tOver += over;
  tUnder += under;
  tInk += ink;
  if (over + under > 0) worst.push({ si, over, under, ink, cyc: cycles.length });
}
worst.sort((a, b) => b.over + b.under - (a.over + a.under));
console.log(
  `shapes ${nShapes}, cycles ${tCyc}, patches ${tPatch}, shapes with NO patches ${noPatch}`,
);
console.log(
  `  over ${tOver} (${((100 * tOver) / tInk).toFixed(3)}%)  under ${tUnder} (${((100 * tUnder) / tInk).toFixed(3)}%)  ink ${tInk}`,
);
for (const w of worst.slice(0, 8))
  console.log(
    `   shape ${String(w.si).padStart(3)}: over ${String(w.over).padStart(4)} under ${String(w.under).padStart(4)} of ink ${String(w.ink).padStart(5)} (${w.cyc} cycles)`,
  );
