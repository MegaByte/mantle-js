// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzCorpusSpill — the two questions that decide correctness, over the whole fixture corpus:
// does any shape's decomposition paint OUTSIDE its path, and does any pixel the path covers whole
// come back short? One asset proves nothing about either.
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { packCPatchShape } from '../src/renderer/cpatchPack.js';
import { patchCoverage } from '../src/renderer/cpatchCov.js';
import { rowSpans, rowCross } from '../src/renderer/cpatchConvert.js';
import { parseMetaBin } from '../src/core/metaBin.js';
import { circleFromContours, ellipseFromContours } from '../src/geom/shapeRecognize.js';

// THE SHAPE'S own FILL RULE, on both sides. rowSpans is the nonzero rule, and asking it about an
// even-odd shape says a hole is filled -- which reads as the converter painting 28,372 pixels
// outside the path on a square with a disc cut out of it, when the converter was right and the
// reference was wrong. The crossings are the same either way; only how they are folded differs.
function spansOf(curves, y, evenOdd) {
  if (!evenOdd) return rowSpans(curves, y) || [];
  const xs = [];
  for (const sg of curves) rowCross(sg, y, (x) => xs.push(x));
  xs.sort((a, b) => a - b);
  const out = [];
  for (let k = 0; k + 1 < xs.length; k += 2)
    if (xs[k + 1] - xs[k] > 1e-9) out.push([xs[k], xs[k + 1]]);
  return out;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = +(process.env.N || 384);
const GL5 = [
  [-0.906179845938664, 0.2369268850561891],
  [-0.5384693101056831, 0.4786286704993665],
  [0, 0.5688888888888889],
  [0.5384693101056831, 0.4786286704993665],
  [0.906179845938664, 0.2369268850561891],
];
const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      '../MantleSamples/Assets/Mantle/tiger.svg',
      ...readdirSync(path.join(ROOT, '../fixtures/svg'))
        .filter((f) => f.endsWith('.svg'))
        .map((f) => '../fixtures/svg/' + f),
    ];
let tShapes = 0,
  tOut = 0,
  tShort = 0,
  tInk = 0,
  tFail = 0,
  worstShort = 1,
  worstAt = '';
const bad = [];
for (const f of files) {
  let txt;
  try {
    txt = readFileSync(path.join(ROOT, f), 'utf8');
  } catch {
    continue;
  }
  txt = txt
    .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
    .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
  let sec;
  try {
    sec = await importSvg(txt, { preserveViewport: true });
  } catch {
    continue;
  }
  const cf = sec.curves64 ? new Float64Array(sec.curves64) : new Float32Array(sec.curves);
  const meta = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
  let fOut = 0,
    fShort = 0,
    fShapes = 0;
  const fBad = [];
  let si = -1;
  for (const r of sec.curveRangesByShape || []) {
    si++;
    if (!r) continue;
    // A RECOGNIZED PRIMITIVE IS ITS own ENGINE and never reaches the converter, so measuring its
    // decomposition measures something the renderer does not draw. buildCPatchBundle skips these.
    let raw = null;
    try {
      raw = curveRangeToContours(cf, r.begin | 0, r.end | 0);
    } catch {
      raw = null;
    }
    if (raw && (circleFromContours(raw) || ellipseFromContours(raw))) continue;
    let cs = null;
    try {
      cs = contoursToConverter(curveRangeToContours(cf, r.begin | 0, r.end | 0), null);
    } catch {
      cs = null;
    }
    if (!cs || !cs.length) continue;
    const evenOdd = meta.metaFloats[si * meta.floatsPerShape + 13] > 0.5;
    const ps = [];
    try {
      packCPatchShape(cs, 0, { evenOdd, onPatches: (a) => ps.push(...a) });
    } catch {
      tFail++;
      continue;
    }
    if (!ps.length) continue;
    fShapes++;
    let sOut = 0,
      sShort = 0;
    const all = [];
    for (const c of cs) for (const sg of c) all.push(sg);
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const sg of all)
      for (const P of sg.P) {
        if (P[0] < x0) x0 = P[0];
        if (P[0] > x1) x1 = P[0];
        if (P[1] < y0) y0 = P[1];
        if (P[1] > y1) y1 = P[1];
      }
    // PER SHAPE, so a small shape in a large asset is sampled as finely as a large one -- a fixed
    // asset-wide grid measures the big shapes and nothing else.
    const SC = Math.max(x1 - x0, y1 - y0) / N;
    if (!(SC > 0)) continue;
    for (let j = Math.floor((y0 - 2 * SC) / SC); j <= Math.ceil((y1 + 2 * SC) / SC); j++) {
      const cy = (j + 0.5) * SC;
      const spans = spansOf(all, cy, evenOdd);
      for (let i = Math.floor((x0 - 2 * SC) / SC); i <= Math.ceil((x1 + 2 * SC) / SC); i++) {
        const cx = (i + 0.5) * SC;
        let far = true;
        for (const sp of spans) if (cx > sp[0] - 1.5 * SC && cx < sp[1] + 1.5 * SC) far = false;
        let cov = 0;
        for (const p of ps) {
          const c = patchCoverage(p, cx, cy, SC);
          if (c > cov) cov = c;
          if (cov > 0.999) break;
        }
        if (far) {
          if (cov > 0.5) {
            fOut++;
            sOut++;
          }
          continue;
        }
        let t = 0;
        for (const [q, w] of GL5) {
          const y = cy + 0.5 * SC * q;
          let c2 = 0;
          for (const sp of spansOf(all, y, evenOdd))
            c2 += Math.max(0, Math.min(cx + SC / 2, sp[1]) - Math.max(cx - SC / 2, sp[0]));
          t += (w * 0.5 * c2) / SC;
        }
        if (!(t > 0.999)) continue;
        tInk++;
        if (cov < 0.99) {
          fShort++;
          sShort++;
          if (cov < worstShort) {
            worstShort = cov;
            worstAt = `${path.basename(f)} s${si} (${i},${j})`;
          }
        }
      }
    }
    if (sOut) fBad.push(`s${si}:${sOut}`);
  }
  tShapes += fShapes;
  tOut += fOut;
  tShort += fShort;
  if (fOut) bad.push(`${path.basename(f)}: ${fOut} outside  [${fBad.join(' ')}]`);
}
console.log(`${files.length} files, ${tShapes} shapes, ${tFail} pack failures`);
console.log(`  painted OUTSIDE the path: ${tOut}`);
console.log(
  `  fully-covered px below 0.99: ${tShort} of ${tInk} (${((100 * tShort) / Math.max(1, tInk)).toFixed(4)}%), worst ${worstShort.toFixed(4)} at ${worstAt}`,
);
if (bad.length) console.log('  ' + bad.join('\n  '));
