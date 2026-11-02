// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _rowGateMono — is leakOfInner MONOTONE in its tolerance?
//
// THE PROPERTY. leakOfInner reports a leak's DEPTH -- how far outside its own arcs the patch's
// half-space conjunction reaches -- and the row gate asks `depth > tol`. A predicate built that way
// is only meaningful if the leak itself does not depend on the bar it is measured against: a leak
// 5.5 deep is 5.5 deep whether the caller asked at 0.02 or at 0.061. So for any two bars t1 < t2,
//
//     leak(t1).depth > t2   =>   leak(t2) exists and leak(t2).depth > t2
//
// Anything else means the gate's answer depends on which bar happened to be passed, which is the
// same defect as depending on the size the drawing was authored at.
//
//   node probes/cpatchGate/_rowGateMono.mjs [file.svg] [shape]
//   ROWS=50 TOLS=0.002,0.02,0.061,0.32
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const x = await import('@xmldom/xmldom');
globalThis.DOMParser = globalThis.DOMParser || x.DOMParser;
globalThis.XMLSerializer = globalThis.XMLSerializer || x.XMLSerializer;
const { default: importSvg } = await import('../../src/svg/importer.js');
const { headlessCPatchBundle, contoursToConverter, shapeEvenOdd, cpatchCurvePlane } =
  await import('../../src/renderer/cpatchBuild.js');
const { curveRangeToContours } = await import('../../src/geom/lbContour.js');
const { circleFromContours, ellipseFromContours } =
  await import('../../src/geom/shapeRecognize.js');
const { packCPatchShape } = await import('../../src/renderer/cpatchPack.js');
const { leakOfInner, patchLeaksInBox } = await import('../../src/renderer/cpatchConvert.js');

const file = process.argv[2] || '../MantleSamples/Assets/Mantle/tiger.svg';
const only = process.argv[3] != null ? +process.argv[3] : null;
const TOLS = (process.env.TOLS || '0.002,0.005,0.01,0.02,0.04,0.061,0.08,0.16,0.32')
  .split(',')
  .map(Number);
const _w = console.warn;
console.warn = () => {};
const bundle = headlessCPatchBundle(
  await importSvg(readFileSync(path.resolve(ROOT, file), 'utf8')),
);
const cf = cpatchCurvePlane(bundle);
const ranges = bundle.curveRangesByShape || [];
const cycleCache = new Map();

/// The gate's question, at one bar: leakOfInner against the patch's own BOX (ask.box), with
/// the gate's own probe step -- patchLeaksInBox passes the patch's scale, not the bar, so a probe
/// that left nudgePx at its default would be asking a different predicate than the one it grades.
const LEAK_REL = 0.02 / 256;
const leakAt = (p, tol) => {
  const ext = Math.max(p.bbox[2] - p.bbox[0], p.bbox[3] - p.bbox[1]);
  let lk = null;
  const nudgePx = ext > 0 ? LEAK_REL * ext : tol;
  try {
    lk = leakOfInner(p, tol, 0, { nudgePx, monotone: true, anyStretch: true, box: true });
  } catch {
    lk = { depth: Infinity, kind: 'throw' };
  }
  return lk;
};

let nPatch = 0,
  nViol = 0,
  nShape = 0,
  nRise = 0;
const rows = [],
  riseRows = [];
for (let s = 0; s < ranges.length; s++) {
  if (only != null && s !== only) continue;
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
  const patches = [];
  try {
    packCPatchShape(cs, 0, {
      evenOdd: shapeEvenOdd(bundle, s),
      cycleCache,
      search: 'full',
      onPatches: (a) => patches.push(...a),
    });
  } catch {
    continue;
  }
  if (patches.length) nShape++;
  for (let pi = 0; pi < patches.length; pi++) {
    const p = patches[pi];
    const ext = Math.max(p.bbox[2] - p.bbox[0], p.bbox[3] - p.bbox[1]);
    const res = TOLS.map((t) => leakAt(p, t));
    const gate = TOLS.map((t) => patchLeaksInBox(p, t));
    nPatch++;
    // RISE: gate(t) = "a leak at least t deep exists", which is non-increasing in t by its own
    // statement. Fenced at a LOOSER bar and not at a tighter one is a contradiction on its face,
    // and needs no depth to see.
    for (let a = 0; a < TOLS.length; a++) {
      if (gate[a]) continue;
      let b = a + 1;
      while (b < TOLS.length && !gate[b]) b++;
      if (b >= TOLS.length) break;
      nRise++;
      riseRows.push(
        `#${s} patch ${pi} (ext ${ext.toFixed(3)}): NOT fenced at tol ${TOLS[a]} but FENCED at tol ${TOLS[b]}`,
      );
      break;
    }
    for (let a = 0; a < TOLS.length; a++) {
      if (!gate[a] || !res[a]) continue;
      for (let b = a + 1; b < TOLS.length; b++) {
        if (!(res[a].depth > TOLS[b])) continue; // the leak would not clear the looser bar anyway
        if (gate[b]) continue;
        nViol++;
        rows.push(
          `#${s} patch ${pi} (ext ${ext.toFixed(3)}, ${p.curves.length} curves): FENCED at tol ${TOLS[a]} on a leak ${res[a].depth.toFixed(3)} deep -> NOT FENCED at tol ${TOLS[b]}${res[b] ? ' (leak ' + res[b].depth.toFixed(4) + ')' : ' (no leak)'}`,
        );
        b = TOLS.length;
      }
    }
  }
}
console.warn = _w;
for (const q of riseRows.slice(0, +(process.env.ROWS || 30))) console.log(q);
for (const q of rows.slice(0, +(process.env.ROWS || 30))) console.log(q);
console.log(
  `${file}: ${nShape} shapes, ${nPatch} patches, ${rows.length} patches with a non-monotone pair (${nViol} pairs), ${nRise} with a RISE`,
);
