// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzWrongSolid — the wrong SOLID samples, split by cause.
//
// _cpatchShapeFill counts them; a count does not say what to fix. Membership has three independent
// gates -- the patch's convex cover, its constraint half-spaces, and whether any patch claims the
// point at all -- and each names a different defect:
//
//   TILING GAP   no patch's constraints contain it, cover or no cover. The decomposition does not
//                reach the shape's boundary here; nothing in the kernel can recover it.
//   COVER CLIP   some patch's constraints DO contain it and the convex cover excludes it. The hull
//                is tighter than the region it is meant to bound.
//   CONSTRAINT   inside a patch's cover but outside one of its half-spaces -- an implicit reading
//                the wrong side, which is the far-branch family.
//   LEAK         (over) inside a patch by every gate, and outside the shape.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import {
  inPatch,
  insideContour,
  patchEval,
  patchBBox,
  convertContour,
} from '../src/renderer/cpatchConvert.js';
import { pathToCycles } from '../src/geom/cpatchGraph.js';
import { patchCoverage } from '../src/renderer/cpatchCov.js';
import { segPt } from '../src/geom/cpatchImplicit.js';

const G = +(process.env.G || 512);
const sections = await importSvg(readFileSync(process.argv[2], 'utf8'));
const cf = new Float32Array(sections.curves);
const affEval = (h, x, y) => h[0] * x + h[1] * y + h[2];
/// What the KERNEL composites at a point: OVER across every patch, at the sampling step's own scale.
const kernelPaint = (patches, x, y, em) => {
  let open = 1;
  for (const p of patches) open *= 1 - Math.min(1, Math.max(0, patchCoverage(p, x, y, em)));
  return 1 - open;
};
const cause = new Map();
const bump = (k, si, d, paint) => {
  const e = cause.get(k) || { n: 0, sh: new Set(), d: [], lost: 0, deep: 0 };
  e.n++;
  e.sh.add(si);
  // WHAT THE RENDERER actually PAINTS THERE. inPatch is the VALIDITY test and carries no seam
  // slack; the kernel admits a thousandth of a pixel past a cut, so a sample in the hairline
  // between two patches' own derivations of a shared seam is a crack the frame does not have.
  if (d !== undefined) {
    e.d.push(d);
    if (d >= 3) {
      e.deep++;
      if (paint < 0.5) {
        e.lost++;
        e.sh2 = e.sh2 || new Map();
        e.sh2.set(si, (e.sh2.get(si) | 0) + 1);
      }
    }
  }
  cause.set(k, e);
};
/// HOW DEEP IS IT? A sample a step from the outline is the AA band and costs nothing; one many
/// steps in is ink the shape has and the decomposition does not. Measured in SAMPLING STEPS, by
/// walking out until the truth flips -- the same grid the defect was found on.
const depthOf = (all, x, y, step, want) => {
  for (let k = 1; k <= 24; k++)
    for (const [dx, dy] of [
      [k, 0],
      [-k, 0],
      [0, k],
      [0, -k],
    ])
      if (insideContour(all, x + dx * step, y + dy * step) !== want) return k;
  return 25;
};
let over = 0,
  under = 0;
for (const [si, r] of (sections.curveRangesByShape || []).entries()) {
  const cs = curveRangeToContours(cf, r.begin | 0, (r.end != null ? r.end : r.begin + r.count) | 0);
  const list = contoursToConverter(cs || [], null);
  if (!list || !list.length) continue;
  // SVG FILLS AN OPEN SUBPATH BY CLOSING IT WITH A STRAIGHT LINE, and ground truth has to close it
  // too -- six tiger contours are 97-100% open, and a correctly closed decomposition scored against
  // an unclosed truth reads as PURE OVER-FILL (measured here as 282,444 phantom leaked samples).
  const all = [];
  for (const c of list) {
    for (const sg of c) all.push(sg);
    const a = segPt(c[0], 0),
      b = segPt(c[c.length - 1], 1);
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-9) all.push({ t: 'line', P: [b, a] });
  }
  // AND THE SHIPPING FALLBACK: the renderer converts raw subpaths when the arrangement returns
  // nothing, so a probe that omits it reports painted ink as lost.
  let cycles = [];
  try {
    cycles = pathToCycles(list, false) || [];
  } catch {
    cycles = [];
  }
  if (!cycles.length)
    cycles = list.map((c) => {
      const a = segPt(c[0], 0),
        b = segPt(c[c.length - 1], 1);
      return Math.hypot(a[0] - b[0], a[1] - b[1]) <= 1e-6
        ? c
        : c.concat([{ t: 'line', P: [b, a] }]);
    });
  const patches = [];
  for (const c of cycles) {
    // NO TOLERANCE PASSED: the default scales itself to the contour's extent, and a flat one here
    // would measure a policy the renderer does not use.
    try {
      const rr = convertContour(c, { maxCurves: 8 });
      if (rr && rr.patches) patches.push(...rr.patches);
    } catch {
      /* refused */
    }
  }
  if (!patches.length) continue;
  const bb = patchBBox(all);
  const pad = 0.02 * Math.max(bb[2] - bb[0], bb[3] - bb[1]) + 1;
  const stepX = (bb[2] - bb[0] + 2 * pad) / G;
  for (let gy = 0; gy < G; gy++) {
    const y = bb[1] - pad + (bb[3] - bb[1] + 2 * pad) * ((gy + 0.5) / G);
    for (let gx = 0; gx < G; gx++) {
      const x = bb[0] - pad + (bb[2] - bb[0] + 2 * pad) * ((gx + 0.5) / G);
      const truth = insideContour(all, x, y);
      let got = false;
      for (const p of patches)
        if (inPatch(p, x, y)) {
          got = true;
          break;
        }
      if (got === truth) continue;
      if (got) {
        over++;
        bump('LEAK: painted outside the shape', si, depthOf(all, x, y, stepX, truth), 0);
        continue;
      }
      under++;
      // Which gate excluded it? Ask each patch separately: constraints alone, then the cover.
      let inConstraints = false,
        inCover = false;
      for (const p of patches) {
        let ok = true;
        for (let i = 0; i < p.impls.length && ok; i++) if (patchEval(p, i, x, y) < 0) ok = false;
        if (ok) inConstraints = true;
        const cov = p.cover || (p.obb && p.obb.lines);
        let cok = true;
        if (cov)
          for (const h of cov)
            if (affEval(h, x, y) < 0) {
              cok = false;
              break;
            }
        if (cok) inCover = true;
      }
      bump(
        inConstraints
          ? 'COVER CLIP: constraints contain it, the hull does not'
          : inCover
            ? 'CONSTRAINT: inside a cover, outside a half-space'
            : 'TILING GAP: no patch reaches it',
        si,
        depthOf(all, x, y, stepX, truth),
        kernelPaint(patches, x, y, stepX),
      );
    }
  }
}
console.log(`${G}x${G} per shape: ${over} painted outside, ${under} left unpainted`);
for (const [k, e] of [...cause].sort((a, b) => b[1].n - a[1].n)) {
  const d = e.d.slice().sort((a, b) => a - b);
  const q = (f) => (d.length ? d[Math.min(d.length - 1, Math.floor(f * d.length))] : 0);
  console.log(`  ${String(e.n).padStart(4)}  ${k}`);
  console.log(`        ${e.sh.size} shape(s): ${[...e.sh].slice(0, 8).join(', ')}`);
  console.log(
    `        depth in sampling steps: median ${q(0.5)}, p90 ${q(0.9)}, worst ${d[d.length - 1]}` +
      `  (${d.filter((v) => v <= 1).length} of ${d.length} are one step from the outline)`,
  );
  if (e.deep)
    console.log(
      `        of the ${e.deep} deeper than 2 steps, the KERNEL still loses ${e.lost}` +
        (e.sh2
          ? ' in ' +
            [...e.sh2]
              .sort((a, b) => b[1] - a[1])
              .slice(0, 8)
              .map(([si, n]) => `${si}:${n}`)
              .join(' ')
          : ''),
    );
}
