// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _bakeCoverage — how much of the corpus a CPatch bake actually covers, and what it costs to
// replay it.
//
// A bake ships the search's DECISIONS instead of its result: ~6 bytes a patch, replayed against
// the runtime's own curves (tiger, 3.4 s of conversion -> 0.11 s, byte-identical streams). A
// contour with no entry is not wrong, it just converts from scratch -- so "how many shapes have
// one" is the number that says whether the bake is doing its job.
//
// The normalized rung is the reason to look. A conversion that comes off it records nothing
// unless the trace carries the scaled, translated frame its cut lines were chosen in. Run this
// against a tree with and without that frame in the trace and the difference is what it buys.
//
// PER ASSET: shapes, bake entries, bytes, and then the replay -- how many shapes come back
// byte-identical through the bake, how many MISFIT (an entry that did not fit, which costs a
// conversion), and how many MISS (no entry at all, which costs the same conversion).
//
//   node probes/cpatchQuality/_bakeCoverage.mjs [file.svg ...]
//
// WHAT this CANNOT SEE. Both arms here run in node, where `Worker` is missing, so
// `convertContoursPooled` degrades to an in-thread conversion -- and the pool's own transforms
// never run. A pool that pre-split contours differently from the serial search would make a
// browser's searched frame and its baked replay disagree while this reports every shape clean.
// Anything the pool does to a contour before dispatching it is invisible here by construction;
// test/cpatchPoolSplitParitySmoke.mjs drives that decision directly instead.
import { readFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

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
const { encodeTraceBake, decodeTraceBake } = await import('../../src/renderer/cpatchTrace.js');

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

let tShapes = 0,
  tEntries = 0,
  tBytes = 0,
  tHits = 0,
  tMisfits = 0,
  tMisses = 0,
  tSame = 0,
  tMoved = 0;
const worst = [];
for (const rel of files) {
  let bundle;
  try {
    bundle = headlessCPatchBundle(await importSvg(readFileSync(path.resolve(ROOT, rel), 'utf8')));
  } catch {
    continue;
  }
  const cf = cpatchCurvePlane(bundle);
  const ranges = bundle.curveRangesByShape || [];
  const shapes = [];
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
    shapes.push({ s, cs, evenOdd: shapeEvenOdd(bundle, s) });
  }
  if (!shapes.length) continue;
  // RECORD
  const traceOut = new Map();
  const cc1 = new Map();
  const direct = new Map();
  for (const sh of shapes) {
    let m = null;
    try {
      m = packCPatchShape(sh.cs, 0, { evenOdd: sh.evenOdd, cycleCache: cc1, traceOut });
    } catch {
      m = null;
    }
    direct.set(sh.s, m);
  }
  const bytes = encodeTraceBake(traceOut);
  // REPLAY
  const traces = decodeTraceBake(bytes);
  const stats = {};
  const cc2 = new Map();
  let same = 0,
    moved = 0;
  for (const sh of shapes) {
    let m = null;
    try {
      m = packCPatchShape(sh.cs, 0, {
        evenOdd: sh.evenOdd,
        cycleCache: cc2,
        traces,
        traceStats: stats,
      });
    } catch {
      m = null;
    }
    const a = direct.get(sh.s);
    const eq =
      !!a &&
      !!m &&
      a.texels.length === m.texels.length &&
      a.verts.length === m.verts.length &&
      a.texels.every((v, i) => v === m.texels[i]) &&
      a.verts.every((v, i) => v === m.verts[i]);
    if (eq) same++;
    else moved++;
  }
  tShapes += shapes.length;
  tEntries += traceOut.size;
  tBytes += bytes.length;
  tHits += stats.hits | 0;
  tMisfits += stats.misfits | 0;
  tMisses += stats.misses | 0;
  tSame += same;
  tMoved += moved;
  if (stats.misses | 0 || stats.misfits | 0 || moved)
    worst.push({ rel, shapes: shapes.length, entries: traceOut.size, ...stats, moved });
}
console.warn = _w;
worst.sort(
  (a, b) =>
    (b.misses | 0) + (b.misfits | 0) + b.moved - ((a.misses | 0) + (a.misfits | 0) + a.moved),
);
console.log('  shapes  entries   hits  misfits  misses  moved   asset');
for (const r of worst.slice(0, +(process.env.ROWS || 15)))
  console.log(
    `  ${String(r.shapes).padStart(6)}  ${String(r.entries).padStart(7)}  ${String(r.hits | 0).padStart(5)}  ${String(r.misfits | 0).padStart(7)}  ${String(r.misses | 0).padStart(6)}  ${String(r.moved).padStart(5)}   ${r.rel}`,
  );
console.log(`\n  ${tShapes} shapes, ${tEntries} bake entries, ${tBytes} bytes`);
console.log(
  `  replay: ${tHits} hits, ${tMisfits} misfits, ${tMisses} misses (a contour with no entry)`,
);
console.log(`  wire:   ${tSame} shapes byte-identical through the bake, ${tMoved} moved`);
