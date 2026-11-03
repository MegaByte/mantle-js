// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _crossExactAudit — what the exact root would change when a clipper hit already holds the
// crossing, and whether anything downstream can tell.
//
// THE SITUATION. cpatchGraph.exactCrossings composes each curve's implicit along the other, pairs
// the roots and polishes them on the pair until the two curves meet to closeEps (1e-12 of the
// pair's extent, floored at the coordinates' own precision). It then throws that root away
// whenever the Bezier clipper already reported the same crossing -- `known.find(isThis)` -- and
// the graph cuts at the CLIPPER's parameters instead, which may be up to CLIP_SAME_ROOT (1e-4) off
// in parameter and leave the two curves' cut points a gap apart.
//
// Keeping the more accurate number instead is a one-line change: overwrite the matched hit in
// place, since the hit object IS what flattenGraph reads. That is what the package does, and
// this is the measurement behind it.
//
// WHAT IT BOUGHT, measured: 24 of the corpus's clipper hits match an exact root, 7 of them leaving
// the two curves' cut points further apart than the graph's node merge can close (1e-11 of the
// drawing's diagonal) -- so those crossings entered the arrangement as a SINK and a SOURCE and
// leaned on repairBoundary. Five of 1471 corpus shapes then decompose differently, all of them
// tiger's, and they move the right way: against the exact box-filter reference
// (probes/cpatchGate/_rowGateAaRef.mjs) tiger's summed coverage error goes 1726.707 -> 1724.707
// px^2, shape #288 alone 5.50 -> 3.36 with its patch count halved (13 -> 7, 55 -> 35 blocks,
// 234 -> 123 vertices), and the corpus loses 21 blocks and 129 vertices.
//
// WHAT IT REPORTS, over every suppressed root in the corpus's CPatch conversions:
//   gapHit    |a(tA_clip) - b(tB_clip)|, how far apart the two curves' cut points are at the
//             clipper's parameters -- the defect the exact root would close
//   gapExact  the same at the exact root, which is the floor the polish reaches
//   moveA/B   how far along each curve the cut would move, in artwork units
//   ...all also expressed in NOMINAL PIXELS at the pair's own 512-px raster, which is the only
//   frame in which "does it matter" has an answer, and against the two tolerances downstream
//   actually applied then: the seam slack the kernel carried (CP_CUT_SLACK, 1e-3 px; now CP_POS_REL) and the node merge
//   the graph does (touchEps, 1e-9 of the pair).
//
// AND THE DECIDING TEST IS NOT HERE. It is the mesh count, run with and without the substitution
// and diffed, then the shapes it names scored against the exact reference. A distribution can only say how big the change is; the mesh count says whether any
// decomposition moves, and only the reference says which way is better.
//
//   node probes/cpatchQuality/_crossExactAudit.mjs [file.svg ...]
import { readFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
globalThis.__CP_CROSS_AUDIT = [];

const xd = await import('@xmldom/xmldom');
globalThis.DOMParser = globalThis.DOMParser || xd.DOMParser;
globalThis.XMLSerializer = globalThis.XMLSerializer || xd.XMLSerializer;
const { default: importSvg } = await import('../../src/svg/importer.js');
const { headlessCPatchBundle, contoursToConverter, shapeEvenOdd, cpatchCurvePlane } =
  await import('../../src/renderer/cpatchBuild.js');
const { curveRangeToContours } = await import('../../src/geom/lbContour.js');
const { circleFromContours, ellipseFromContours } =
  await import('../../src/geom/shapeRecognize.js');
const { packCPatchShape } = await import('../../src/renderer/cpatchPack.js');

let files = process.argv.slice(2);
if (!files.length) {
  const dir = (d) =>
    existsSync(path.join(ROOT, d))
      ? readdirSync(path.join(ROOT, d))
          .filter((f) => f.endsWith('.svg'))
          .sort()
          .map((f) => d + '/' + f)
      : [];
  files = [...dir('examples'), ...dir('examples/_bench'), ...dir('examples/smoke')];
}
const _w = console.warn;
console.warn = () => {};

let shapes = 0;
for (const rel of files) {
  let bundle;
  try {
    bundle = headlessCPatchBundle(await importSvg(readFileSync(path.resolve(ROOT, rel), 'utf8')));
  } catch {
    continue;
  }
  const cf = cpatchCurvePlane(bundle);
  const ranges = bundle.curveRangesByShape || [];
  const cycleCache = new Map();
  for (let s = 0; s < ranges.length; s++) {
    const r = ranges[s];
    if (!r) continue;
    let contours = null;
    try {
      contours = curveRangeToContours(cf, r.begin, r.end);
    } catch {
      continue;
    }
    if (!contours || !contours.length) continue;
    if (circleFromContours(contours) || ellipseFromContours(contours)) continue;
    const cs = contoursToConverter(contours, null);
    if (!cs) continue;
    try {
      packCPatchShape(cs, 0, { evenOdd: shapeEvenOdd(bundle, s), cycleCache, search: 'full' });
    } catch {
      /* the audit still holds what it saw */
    }
    shapes++;
  }
}
console.warn = _w;

const A = globalThis.__CP_CROSS_AUDIT;
if (!A.length) {
  console.log(`${shapes} shapes, no clipper hit matched an exact root — nothing to decide`);
  process.exit(0);
}
/// The pair's own 512-px raster: one nominal pixel is ext/512 in artwork units.
const px = (v, r) => v / (r.ext / 512);
const stat = (name, get) => {
  const v = A.map(get).sort((a, b) => a - b);
  const q = (f) => v[Math.min(v.length - 1, Math.floor(f * v.length))];
  console.log(
    `  ${name.padEnd(22)} median ${q(0.5).toExponential(2)}   p90 ${q(0.9).toExponential(2)}   max ${v[v.length - 1].toExponential(2)}`,
  );
};
console.log(
  `${shapes} shapes, ${A.length} exact roots suppressed because a clipper hit already held them\n`,
);
console.log('in artwork units:');
stat('gap at the hit', (r) => r.gapHit);
stat('gap at the exact root', (r) => r.gapExact);
stat('cut moves along A', (r) => r.moveA);
stat('cut moves along B', (r) => r.moveB);
console.log("\nin NOMINAL PIXELS at the pair's own 512-px raster:");
stat('gap at the hit', (r) => px(r.gapHit, r));
stat('gap at the exact root', (r) => px(r.gapExact, r));
stat('cut moves along A', (r) => px(r.moveA, r));
stat('cut moves along B', (r) => px(r.moveB, r));
const CUT_SLACK_PX = 1e-3;
const overSlack = A.filter((r) => px(r.gapHit, r) >= CUT_SLACK_PX).length;
const overTouch = A.filter((r) => r.gapHit >= r.touchEps).length;
console.log(
  `\n  hits whose gap reaches the kernel's own seam slack (CP_CUT_SLACK, ${CUT_SLACK_PX} px): ${overSlack} of ${A.length}`,
);
console.log(
  `  hits whose gap reaches the graph's node-merge tolerance (touchEps): ${overTouch} of ${A.length}`,
);
console.log(
  `  (a gap under touchEps is a pair the graph merges into ONE node whichever parameters it cuts at)`,
);
