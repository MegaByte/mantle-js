// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzMaxCurves — convert an asset at every maxCurves, in plain node, the way the POOL does it.
//
// Built because cpatchOpts.maxCurves = 6 made tiger decline ENTIRELY: every shape drew Slug, with
// no error, no bail and no refusal recorded. The renderer's own diagnostics could not see it --
// bundle._cpatchConv simply stayed 'pending' for the life of the bundle, because one pooled job
// never answered and the collect pass's Promise.all waited for it.
//
// WHAT MAKES this PROBE DIFFERENT FROM CALLING packCPatchShape: the pooled path does not convert
// contours. It walks each shape with `collect` to gather CYCLES, splits any cycle over 24 curves
// with countFirstPieces, and posts the PIECES. A cycle that converts fine whole says nothing about
// the piece the worker was handed -- and the piece is where the hang was (tiger's shape 32, piece
// 0 of 14, 33 curves: countFirstPieces cannot ear it at maxCurves=6, so it ships whole and the
// search gets a loop five times its target size). Converting contours reported 298 built at every
// setting while the renderer drew Slug.
//
//   MC=6            maxCurves to convert at
//   CAP=4000        report any single conversion over this many ms
//   TRACE=1         print every piece before converting it -- the only way to see WHICH one hangs,
//                   since a timing print never runs if the call does not return
//   SHAPE=32 PIECE=0  isolate one unit, for a profile (node --prof; the hang is in the tree, and
//                   --cpu-prof never writes because the event loop is blocked)
//   SVG=path        default ../MantleSamples/Assets/Mantle/tiger.svg
//
// clipBudgetHits reports intersectBezierClip calls that ran out of node budget. On tiger it is 2 at
// maxCurves=8 and 26 at 6 -- those are curve pairs that OVERLAP, where the fat line never shrinks.
import { readFileSync } from 'fs';
const { DOMParser: DP, XMLSerializer: XS } = await import('@xmldom/xmldom');
globalThis.DOMParser = globalThis.DOMParser || DP;
globalThis.XMLSerializer = globalThis.XMLSerializer || XS;
const { default: importSvg } = await import('../src/svg/importer.js');
const { headlessCPatchBundle, contoursToConverter, shapeEvenOdd, cpatchCurvePlane } =
  await import('../src/renderer/cpatchBuild.js');
const { curveRangeToContours } = await import('../src/geom/lbContour.js');
const { packCPatchShape } = await import('../src/renderer/cpatchPack.js');
const { convertContour, countFirstPieces } = await import('../src/renderer/cpatchConvert.js');
const { bezierClipBudgetHits, bezierClipCoincideHits } =
  await import('../src/svg/pathBoolean/bezierClip.js');

const svg = readFileSync(process.env.SVG || '../MantleSamples/Assets/Mantle/tiger.svg', 'utf8');
const sections = await importSvg(svg);
const bundle = headlessCPatchBundle(sections);
const cf = cpatchCurvePlane(bundle);
const MC = +(process.env.MC || 6),
  CAP = +(process.env.CAP || 4000);
if (process.env.DUMP) globalThis.__BC_DUMP = [];
let slow = 0,
  ok = 0,
  nil = 0,
  ok0 = 0;
const ONLY = process.env.SHAPE != null ? +process.env.SHAPE : -1;
const ONLYP = process.env.PIECE != null ? +process.env.PIECE : -1;
for (let s = 0; s < bundle.curveRangesByShape.length; s++) {
  if (ONLY >= 0 && s !== ONLY) continue;
  const r = bundle.curveRangesByShape[s];
  let contours = null;
  try {
    contours = curveRangeToContours(cf, r.begin, r.end);
  } catch {
    contours = null;
  }
  const cs = contours && contours.length ? contoursToConverter(contours, null) : null;
  if (!cs) {
    nil++;
    continue;
  }
  // WHAT THE WORKER actually CONVERTS: the collected CYCLES, not the contours. The pooled path
  // walks the shape once with `collect` and posts each cycle to convertContour; a contour that
  // packs fine on this thread says nothing about the cycle the pool was handed.
  const collected = [];
  try {
    packCPatchShape(cs, 0, { maxCurves: MC, evenOdd: shapeEvenOdd(bundle, s), collect: collected });
  } catch {
    /* reported below */
  }
  const t0 = Date.now();
  let m = null;
  for (const e of collected.filter((e) => !e.holes)) {
    // AND THE SPLIT THE POOL MAKES FIRST, on this thread, before anything is posted.
    if (e.curves.length > 24) {
      const tp = Date.now();
      let pieces = null;
      try {
        pieces = countFirstPieces(e.curves, MC);
      } catch (ex) {
        pieces = 'threw ' + ex.message;
      }
      const dp = Date.now() - tp;
      if (dp > 500)
        console.log(
          `  shape ${s} SPLIT: ${dp} ms for ${e.curves.length} curves -> ${pieces && pieces.length} pieces`,
        );
      // AND CONVERT THE PIECES, which is what the pool actually posts. A cycle that converts
      // whole says nothing about the piece a split handed the worker.
      if (Array.isArray(pieces))
        for (let pi = 0; pi < pieces.length; pi++) {
          if (ONLYP >= 0 && pi !== ONLYP) continue;
          if (process.env.TRACE) {
            process.stdout.write(
              `  shape ${s} piece ${pi}/${pieces.length} n=${pieces[pi].length} ...`,
            );
          }
          const tq = Date.now();
          try {
            convertContour(pieces[pi], { maxCurves: MC, holes: null, search: 'full' });
          } catch {
            /* worker catches */
          }
          const dq = Date.now() - tq;
          if (process.env.TRACE) process.stdout.write(` ${dq}ms\n`);
          else if (dq > CAP)
            console.log(
              `  shape ${s} PIECE ${pi}/${pieces.length}: ${dq} ms for ${pieces[pi].length} curves  <-- THE POOL POSTS THIS`,
            );
        }
    }
    const tc = Date.now();
    try {
      convertContour(e.curves, { maxCurves: MC, interiorN: undefined, search: 'full' });
    } catch {
      /* the worker catches too */
    }
    const dc = Date.now() - tc;
    if (dc > CAP) console.log(`  shape ${s} CYCLE: ${dc} ms for ${e.curves.length} curves`);
  }
  if (!m) {
    try {
      m = packCPatchShape(cs, 0, { maxCurves: MC, evenOdd: shapeEvenOdd(bundle, s) });
    } catch (e) {
      m = 'threw ' + e.message;
    }
  }
  const dt = Date.now() - t0;
  if (m && m.vertexCount > 0) ok0++;
  if (dt > CAP) {
    slow++;
    console.log(
      `  shape ${s}: ${dt} ms  curves=${cs.reduce((a, c) => a + c.length, 0)} contours=${cs.length} -> ${m && m.patches !== undefined ? m.patches + ' patches' : m}`,
    );
  } else if (m && m.patches !== undefined) ok++;
  else if (m && m.vertexCount > 0) ok++;
  else {
    nil++;
    if (nil <= 2) console.log(`  shape ${s}: keys=${m ? Object.keys(m).join(',') : 'null'}`);
  }
}
console.log(
  `maxCurves=${MC}: ${ok0} built, ${nil} none, ${slow} over ${CAP}ms, clipBudgetHits=${bezierClipBudgetHits()} clipCoincide=${bezierClipCoincideHits()}`,
);
if (globalThis.__BC_DUMP) {
  const seen = new Set();
  for (const d of globalThis.__BC_DUMP) {
    const k = JSON.stringify(d);
    if (seen.has(k)) continue;
    seen.add(k);
    const f = (p) => '(' + p.map((v) => v.toFixed(4)).join(',') + ')';
    console.log(
      `  STALL hits=${d.hits}\n    A ${d.A.map(f).join(' ')}\n    B ${d.B.map(f).join(' ')}`,
    );
  }
  console.log(`  distinct stalling pairs: ${seen.size} of ${globalThis.__BC_DUMP.length}`);
}
