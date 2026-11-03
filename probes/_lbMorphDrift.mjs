// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _lbMorphDrift.mjs — HOW FAR IS THE DRAWN EDGE FROM THE CURVE IT IS MEANT TO BE,
// mid-morph, in pixels — on the CPU, with no GPU.
//
// A morph pair packs one implicit frame per curve face on each endpoint and the
// vertex shader LERPS those packed coefficients. Interpolating an implicit is not
// interpolating a curve: the frame is normalized by a per-pose conditioning scale
// (a max of absolute values, which kinks rather than lerps), and with that scale
// held fixed the Bezout entries are still exactly DEGREE 2 in t, so a linear mix
// draws the quadratic's chord. Both errors vanish at a t-segment's endpoints and
// peak in its middle, which is the shape unifiedMorphSmoke reads at t = 0.5 — and
// the shape no endpoint gate can see, because the positions are linear and exact
// and it is only the implicit inside a correct mesh that is wrong.
//
// The measurement is the builder's own oracle (pairImplicitDrift), so what this
// prints is exactly what the segmenter gates on. For each t it picks the active
// segment the way the draw does (unifiedFillDraw's morphSeg), rescales t into that
// segment's blend range, and asks how far the TRUE curve at that t — the cubic
// whose control points are the lerp of the two poses' — stands from the zero set
// of the frame the vertex stage actually mixes. That distance IS the edge
// displacement, so on a hard edge it is also the coverage error, and 255x it is
// the per-channel delta a pixel test reads.
//
// Read the SHAPE over t — zero at the endpoints, peaking mid-segment — rather than
// any single number. `frac` is the unit the builder gates on: the displacement as a
// fraction of the drifting piece's own chord, which is size-free the way a mesh is.
//
// Usage:  node probes/_lbMorphDrift.mjs [src.svg dst.svg] [--px=160] [--ts=0,0.5,1]
// With no assets it runs the morph unifiedMorphSmoke draws, at that smoke's size.

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';

globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { default: importSvg } = await import('../src/svg/importer.js');
const { curveRangeToContours } = await import('../src/geom/lbContour.js');
const { buildEarcutPair, segmentPartitionPairMorph } =
  await import('../src/renderer/loopBlinnMorph.js');
const { buildLoopBlinnPartitionPair, pairImplicitDrift } =
  await import('../src/renderer/lbPartitionPair.js');

const args = process.argv.slice(2);
const PX = +(args.find((a) => a.startsWith('--px='))?.slice(5) || 160);
const assets = args.filter((a) => !a.startsWith('--'));
const TS = (
  args.find((a) => a.startsWith('--ts='))?.slice(5) || '0,0.125,0.25,0.375,0.5,0.625,0.75,0.875,1'
)
  .split(',')
  .map(Number);

// The smoke's own morph, so the defect this looks for needs no asset.
const A9 = 'M20 4 C31 4 36 9 36 20 C36 31 31 36 20 36 C9 36 4 31 4 20 C4 9 9 4 20 4 Z';
const B9 = 'M20 8 C28 2 34 10 33 20 C32 30 28 34 20 33 C11 32 6 28 7 20 C8 10 12 2 20 8 Z';
const smokeSvg = (d) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><path d="${d}" fill="#3060c0"/></svg>`;

/// The morph mesh the renderer would build for one shape, as the segment list the
/// draw indexes: an unsegmented pair is the single segment [0,1].
function morphSegmentsFor(sc, dc, fillRule, translucent) {
  const pair =
    (!translucent && buildEarcutPair(sc, dc, fillRule)) ||
    buildLoopBlinnPartitionPair(sc, dc, fillRule) ||
    buildLoopBlinnPartitionPair(sc, dc, fillRule, { plainDstRows: true });
  if (pair) return [{ tLo: 0, tHi: 1, tLoB: 0, tHiB: 1, pair }];
  try {
    return segmentPartitionPairMorph(sc, dc, fillRule);
  } catch {
    return null;
  }
}

/// The active segment at t and its local parameter, exactly as the draw picks them.
function segAt(segs, t) {
  let seg = segs[segs.length - 1];
  for (let i = 0; i < segs.length; i++)
    if (t <= segs[i].tHi) {
      seg = segs[i];
      break;
    }
  const span = seg.tHiB - seg.tLoB;
  return { seg, i: segs.indexOf(seg), u: span > 1e-9 ? (t - seg.tLoB) / span : 0 };
}

async function run(name, srcSvg, dstSvg) {
  const ba = await importSvg(srcSvg),
    bb = await importSvg(dstSvg);
  const ma = new Float32Array(ba.meta, 32),
    mb = new Float32Array(bb.meta, 32); // 32-BYTE HEADER
  const st = ba.metaFloatsPerShape;
  const ca = new Float32Array(ba.curves),
    cb = new Float32Array(bb.curves);
  console.log(`${name}  px=${PX}`);
  for (let s = 0; s < ba.numShapes; s++) {
    const r = ba.curveRangesByShape[s];
    if (!r || r.end <= r.begin) continue;
    let sc = null,
      dc = null;
    try {
      sc = curveRangeToContours(ca, r.begin, r.end);
      dc = curveRangeToContours(cb, r.begin, r.end);
    } catch {
      continue;
    }
    if (!sc || !dc) continue;
    const b = s * st;
    const hasPaint =
      Math.floor(ma[b + 28] + 0.5) !== 0 || (st >= 36 && Math.floor(ma[b + 35] + 0.5) !== 0);
    const translucent = !hasPaint && (ma[b + 7] < 0.996 || mb[b + 7] < 0.996);
    const fillRule = ma[b + 13] > 0.5 ? 'evenodd' : 'nonzero';
    const segs = morphSegmentsFor(sc, dc, fillRule, translucent);
    if (!segs || !segs.length) {
      console.log(`   shape ${s}: no morph pair (Slug draws it)`);
      continue;
    }
    // the renderer fits the CONTENT bbox to the viewport, so that is the scale
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const c of sc)
      for (const sg of c)
        for (const P of [sg.p1, sg.p2, sg.p3, sg.p4])
          if (P) {
            if (P[0] < x0) x0 = P[0];
            if (P[0] > x1) x1 = P[0];
            if (P[1] < y0) y0 = P[1];
            if (P[1] > y1) y1 = P[1];
          }
    const emPerPx = Math.max(x1 - x0, y1 - y0) / PX;
    console.log(
      `   shape ${s}: ${segs.length} t-segment(s) drawn ` +
        segs.map((g) => `[${g.tLo.toFixed(3)},${g.tHi.toFixed(3)}]`).join(' '),
    );
    console.log(
      '       t      seg  localT     drift px   ~alpha/255        frac   worst face / faces',
    );
    let peak = 0,
      peakT = 0;
    const out = {};
    for (const t of TS) {
      const { seg, i, u } = segAt(segs, t);
      pairImplicitDrift(seg.pair.src, seg.pair.dst, u, u, out);
      const px = out.em / emPerPx;
      if (px > peak) {
        peak = px;
        peakT = t;
      }
      console.log(
        `     ${t.toFixed(3)}   ${String(i).padStart(3)}  ${u.toFixed(4)}` +
          `   ${px.toFixed(4).padStart(9)}   ${String(Math.round(Math.min(1, px) * 255)).padStart(10)}` +
          `   ${out.frac.toExponential(2).padStart(9)}   #${out.face} ${out.kind} / ${out.faces}`,
      );
    }
    // What the segmenter itself sees: the worst over each segment's whole DRAWN
    // range, which includes the part outside [0,1] that a segment whose
    // classification was baked a margin inside its interval extrapolates into.
    let gate = 0;
    for (const g of segs) {
      const span = g.tHiB - g.tLoB;
      const uLo = span > 1e-9 ? (g.tLo - g.tLoB) / span : 0;
      const uHi = span > 1e-9 ? (g.tHi - g.tLoB) / span : 1;
      gate = Math.max(gate, pairImplicitDrift(g.pair.src, g.pair.dst, uLo, uHi));
    }
    console.log(
      `   PEAK ${peak.toFixed(4)}px at t=${peakT}   worst over every segment's drawn range: ` +
        `${gate.toExponential(3)} of a chord`,
    );
  }
}

if (!assets.length) await run('smoke-morph', smokeSvg(A9), smokeSvg(B9));
else if (assets.length === 2) {
  const p = (a) => (path.isAbsolute(a) ? a : path.resolve(ROOT, a));
  await run(
    path.basename(p(assets[0])) + ' -> ' + path.basename(p(assets[1])),
    readFileSync(p(assets[0]), 'utf8'),
    readFileSync(p(assets[1]), 'utf8'),
  );
} else console.log('usage: node probes/_lbMorphDrift.mjs [src.svg dst.svg] [--px=] [--ts=]');
