// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzLeakOne — one leaking patch, in full: which curves bound it, where its region leaves the
// shape, and what the converter's own validity test says about it.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { packCPatchShape } from '../src/renderer/cpatchPack.js';
import { patchCoverage, curveCov } from '../src/renderer/cpatchCov.js';
import {
  patchBBox,
  insideContour,
  validatePatch,
  patchCoverLines,
} from '../src/renderer/cpatchConvert.js';
import { segPt, segTightBBox, packedEval } from '../src/geom/cpatchImplicit.js';

const file = process.argv[2],
  SI = +process.argv[3],
  PX = +(process.env.PX || 128);
const sections = await importSvg(readFileSync(file, 'utf8'));
const cf = new Float32Array(sections.curves);
const r = sections.curveRangesByShape[SI];
const cs = curveRangeToContours(cf, r.begin | 0, (r.end != null ? r.end : r.begin + r.count) | 0);
const list = contoursToConverter(cs || [], null);
const all = [];
for (const c of list) {
  for (const sg of c) all.push(sg);
  const a = segPt(c[0], 0),
    b = segPt(c[c.length - 1], 1);
  if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-6) all.push({ t: 'line', P: [b, a] });
}
const patches = [];
packCPatchShape(list, 0, { onPatches: (ps) => patches.push(...ps) });
const bb = patchBBox(all);
const span = Math.max(bb[2] - bb[0], bb[3] - bb[1]);
const pad = span * 0.04,
  x0 = bb[0] - pad,
  y0 = bb[1] - pad,
  emPerPx = (span + 2 * pad) / PX;
console.log(
  `shape ${SI}: ${list.length} contour(s), ${all.length} curves, ${patches.length} patches, emPerPx ${emPerPx.toFixed(4)}`,
);

// Every pixel the engine paints solid and the shape does not have.
const bad = [];
for (let py = 0; py < PX; py++)
  for (let px = 0; px < PX; px++) {
    const x = x0 + (px + 0.5) * emPerPx,
      y = y0 + (py + 0.5) * emPerPx;
    if (insideContour(all, x, y)) continue;
    let open = 1;
    for (const p of patches) open *= 1 - Math.min(1, Math.max(0, patchCoverage(p, x, y, emPerPx)));
    const c = 1 - open;
    if (c > 0.5) bad.push({ px, py, x, y, c });
  }
console.log(`  ${bad.length} pixels painted outside the contour`);
const byPatch = new Map();
for (const b of bad) {
  for (let i = 0; i < patches.length; i++) {
    if (patchCoverage(patches[i], b.x, b.y, emPerPx) > 0.5) {
      if (!byPatch.has(i)) byPatch.set(i, []);
      byPatch.get(i).push(b);
    }
  }
}
for (const [pi, px] of [...byPatch].sort((a, b) => b[1].length - a[1].length).slice(0, 3)) {
  const p = patches[pi];
  const v = validatePatch(p);
  const hull = patchCoverLines(p.curves, 16);
  console.log(
    `  patch ${pi}: ${p.curves.length} curves, ${px.length} leaked px, validate=${JSON.stringify(v)}`,
  );
  console.log(
    `    inside point (${p.inside[0].toFixed(2)}, ${p.inside[1].toFixed(2)}), hull ${hull ? hull.length : 0} planes` +
      `, ${hull ? hull.filter((h) => h[3] === 0).length : 0} of them undilated`,
  );
  for (const sg of p.curves) {
    const a = segPt(sg, 0),
      b = segPt(sg, 1),
      m = segPt(sg, 0.5);
    console.log(
      `      ${sg.cut ? 'CUT ' : 'edge'} ${sg.t.padEnd(5)} (${a[0].toFixed(2)},${a[1].toFixed(2)})` +
        ` -> (${b[0].toFixed(2)},${b[1].toFixed(2)})  mid (${m[0].toFixed(2)},${m[1].toFixed(2)})`,
    );
  }
  const w = px[0];
  console.log(
    `    worst leak at em (${w.x.toFixed(2)}, ${w.y.toFixed(2)}) cov ${w.c.toFixed(3)}` +
      `  -- inside the contour? ${insideContour(all, w.x, w.y)}`,
  );
  // How far outside is it?
  let best = Infinity;
  for (const sg of all)
    for (let k = 0; k <= 64; k++) {
      const q = segPt(sg, k / 64);
      best = Math.min(best, Math.hypot(q[0] - w.x, q[1] - w.y));
    }
  console.log(`    that point is ${(best / emPerPx).toFixed(2)} px from the nearest outline curve`);
  // WHICH CONSTRAINT SHOULD HAVE STOPPED IT? Each one's own answer at that point, with the arc box
  // it is judged inside: a constraint whose box excludes the fragment returns 1 and bounds nothing.
  for (let k = 0; k < p.curves.length; k++) {
    const sg = p.curves[k],
      im = p.impls[k];
    if (!im || !im.packed) {
      console.log(`      [${k}] no packed implicit`);
      continue;
    }
    const sgn = packedEval(im.packed, p.inside[0], p.inside[1]) >= 0 ? 1 : -1;
    const res = {};
    const box = segTightBBox(sg);
    const c = curveCov(im.packed, sgn, !!sg.cut, box, w.x, w.y, emPerPx, res);
    const inBox =
      w.x >= box[0] - emPerPx &&
      w.x <= box[2] + emPerPx &&
      w.y >= box[1] - emPerPx &&
      w.y <= box[3] + emPerPx;
    // THE TRUE DISTANCE TO THE ARC, which is what the constraint's estimate is supposed to be:
    // sampled densely here only because this is a diagnostic, not a kernel.
    let dTrue = Infinity,
      tAt = 0;
    for (let q = 0; q <= 2000; q++) {
      const pt = segPt(sg, q / 2000),
        dd = Math.hypot(pt[0] - w.x, pt[1] - w.y);
      if (dd < dTrue) {
        dTrue = dd;
        tAt = q / 2000;
      }
    }
    console.log(
      `      [${k}] ${sg.cut ? 'CUT ' : 'edge'} ${sg.t.padEnd(5)} cov ${c.toFixed(3)}` +
        `  nearArc ${(!!res.nearArc + '').padEnd(5)} inBox ${(inBox + '').padEnd(5)}` +
        `  true dist to arc ${(dTrue / emPerPx).toFixed(2)}px at t=${tAt.toFixed(3)}`,
    );
  }
  console.log(`    patch's own coverage there: ${patchCoverage(p, w.x, w.y, emPerPx).toFixed(3)}`);
  // AND WHAT THE COVER SAYS. Each plane's signed distance in pixels, with what the kernel does
  // with it: 0 bridging (hard, undilated), 1 along a cut (hard, dilated), 2 along an arc (ramped).
  const hl = patchCoverLines(p.curves, 16) || [];
  const acts = hl.map((h) => (h[0] * w.x + h[1] * w.y + h[2]) / emPerPx);
  const kinds = hl.map((h, i) => `${h[3]}:${acts[i].toFixed(2)}`);
  console.log(`    cover planes (kind:px) ${kinds.join(' ')}`);
}

// WALK OUTWARD FROM THE ARC. If the implicit's sign returns to "inside" a fraction of a pixel
// out, its algebraic curve has a SECOND BRANCH passing through the arc's own neighbourhood --
// which is the one thing the arc box cannot discriminate, since that branch is inside the box.
if (process.env.WALK) {
  const [pi, k] = process.env.WALK.split(',').map(Number);
  const p = patches[pi],
    sg = p.curves[k],
    im = p.impls[k];
  const sgn = packedEval(im.packed, p.inside[0], p.inside[1]) >= 0 ? 1 : -1;
  const t = +(process.env.WALK_T || 0.973);
  const a = segPt(sg, t),
    b = segPt(sg, Math.min(1, t + 1e-4));
  const tx = b[0] - a[0],
    ty = b[1] - a[1],
    L = Math.hypot(tx, ty);
  let nx = -ty / L,
    ny = tx / L;
  // Point the normal OUTWARD (away from the patch's interior point).
  if (nx * (p.inside[0] - a[0]) + ny * (p.inside[1] - a[1]) > 0) {
    nx = -nx;
    ny = -ny;
  }
  console.log(
    `  walking outward from t=${t} at (${a[0].toFixed(2)},${a[1].toFixed(2)}), normal (${nx.toFixed(3)},${ny.toFixed(3)})`,
  );
  for (let s = -1; s <= 4.01; s += 0.25) {
    const x = a[0] + nx * s * emPerPx,
      y = a[1] + ny * s * emPerPx;
    const f = packedEval(im.packed, x, y) * sgn;
    const res = {};
    const c = curveCov(im.packed, sgn, !!sg.cut, segTightBBox(sg), x, y, emPerPx, res);
    console.log(
      `    ${s.toFixed(2).padStart(5)} px out: f ${f.toExponential(3).padStart(11)}  cov ${c.toFixed(3)}` +
        `  inside contour ${insideContour(all, x, y)}`,
    );
  }
}

if (process.env.WALK) {
  const [pi, k] = process.env.WALK.split(',').map(Number);
  const sg = patches[pi].curves[k],
    im = patches[pi].impls[k];
  console.log(
    '  the curve itself:',
    sg.t,
    JSON.stringify(sg.P.map((q) => q.map((v) => +v.toFixed(3)))),
  );
  console.log(
    '  packed kind:',
    im.packed && im.packed.kind,
    ' impl keys:',
    Object.keys(im).join(','),
  );
  // Its own singular points: an inflection or a loop cut is where a cubic's implicit degenerates.
  const { cubicInflections, cubicLoopCuts } = await import('../src/geom/lbCubicMath.js');
  try {
    console.log('  inflections:', JSON.stringify(cubicInflections(sg.P)));
  } catch (e) {
    console.log('  inflections: ' + e.message);
  }
  try {
    console.log('  loop cuts:', JSON.stringify(cubicLoopCuts(sg.P)));
  } catch (e) {
    console.log('  loop cuts: ' + e.message);
  }
}

if (process.env.WALK) {
  const [pi, k] = process.env.WALK.split(',').map(Number);
  const p = patches[pi],
    sg = p.curves[k],
    im = p.impls[k];
  const { implEval } = await import('../src/geom/cpatchImplicit.js');
  const t = +(process.env.WALK_T || 0.973);
  const a = segPt(sg, t),
    b = segPt(sg, Math.min(1, t + 1e-4));
  const tx = b[0] - a[0],
    ty = b[1] - a[1],
    L = Math.hypot(tx, ty);
  let nx = -ty / L,
    ny = tx / L;
  if (nx * (p.inside[0] - a[0]) + ny * (p.inside[1] - a[1]) > 0) {
    nx = -nx;
    ny = -ny;
  }
  const sT = Math.sign(implEval(im.impl, p.inside[0], p.inside[1])) || 1;
  const sP = packedEval(im.packed, p.inside[0], p.inside[1]) >= 0 ? 1 : -1;
  console.log(
    `  TERM LIST vs PACKED, both oriented by the patch's inside point (term ${sT}, packed ${sP}):`,
  );
  for (let s = -0.6; s <= 0.61; s += 0.15) {
    const x = a[0] + nx * s * emPerPx,
      y = a[1] + ny * s * emPerPx;
    console.log(
      `    ${s.toFixed(2).padStart(5)} px out:  term ${(implEval(im.impl, x, y) * sT).toExponential(3).padStart(11)}` +
        `   packed ${(packedEval(im.packed, x, y) * sP).toExponential(3).padStart(11)}`,
    );
  }
}
