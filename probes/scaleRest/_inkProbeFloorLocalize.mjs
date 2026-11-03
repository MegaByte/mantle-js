// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Localize the morph pairs whose t-SEGMENTATION depends on the drawing's size.
//
// With absolute em floors in the static builder's invisible-boundary ink probe, `lbSeg`
// (segmentPartitionPairMorph) offset-differs on tiger#112/grow and tiger#114/grow at 2^-20..2^-8.
// The segmenter's own numbers are all dimensionless (t-space: 0.02 flip merge, SEG_MARGIN 0.04, mOut 1e-3,
// MORPH_DRIFT_FRAC 0.002 of a chord), so the size cannot enter there. It enters through the ORACLE: the scan
// asks `buildLoopBlinnPartitionPair(lerp(a), lerp(b))` for each of 24 cells and segments where that answer
// flips. So the thing to localize is WHICH CELL's verdict moves, and then what inside the pair builder moved.
//
// HOW TO NAME THE BAIL: copy `src/renderer/lbPartitionPair.js` to a temporary module with every
// `return null` rewritten to `return (globalThis.__W.push(<line>), null)`, import that instead, and run the
// one cell whose verdict moves at both exponents. Under absolute floors both pairs bail at the same site in
// lbPartitionPair.js -- the dst piece's normal and chord against `emD9.eps` -- and dumping the source
// partition's records there shows the split PLANS identical at both scales and exactly one record
// different: `c0/s4/p3` is INVISIBLE at offset@1 and not at offset@2^-20. That classification is taken in
// the STATIC builder (lbPartition.js), by an ink probe whose floor must be the shape's em unit (`emEps()`),
// as the pair builder's own twin of the same test uses; an absolute `nl9 > 1e-12 && chord9 > 1e-12` floor
// produces the difference. SOLO=<k> is the one-exponent-per-process control: module state is NOT what
// produces this.
//
//   node probes/scaleRest/_inkProbeFloorLocalize.mjs            PAIR=112 K=-20
//   SOLO=-20 node probes/scaleRest/_inkProbeFloorLocalize.mjs   (one exponent, fresh process)
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { default: importSvg } = await import(path.join(ROOT, 'src/svg/importer.js'));
const { parseMetaBin } = await import(path.join(ROOT, 'src/core/metaBin.js'));
const { curveRangeToContours } = await import(path.join(ROOT, 'src/geom/lbContour.js'));
const { buildLoopBlinnPartitionPair } = await import(
  path.join(ROOT, 'src/renderer/lbPartitionPair.js')
);
const { SEG_LINE, SEG_QUAD, SEG_CUBIC, mkLine, mkQuad, mkCubic, mkRQuad } = await import(
  path.join(ROOT, 'src/primitives/seg.js')
);
const { selfPairs } = await import(path.join(ROOT, 'probes/morphScale/_morphPairs.mjs'));
const _warn = console.warn;
console.warn = () => {};

const WANT = (process.env.PAIR || '112,114').split(',');
const KS = (process.env.K || '-20,-16,-12,-8').split(',').map(Number);
const OFF = 16384;
const f32 = new Float32Array(1);
const r32 = (v) => {
  f32[0] = v;
  return f32[0];
};

function scaleContours(cs, S, off) {
  const T = off ? OFF : 0;
  const P = (q) =>
    q && [off ? r32((q[0] + T) * S) : q[0] * S, off ? r32((q[1] + T) * S) : q[1] * S];
  return cs.map((c) =>
    c.map((sg) => {
      if (sg.type === SEG_LINE) return mkLine(P(sg.p1), P(sg.p2), sg.is_fill_only);
      if (sg.type === SEG_QUAD) return mkQuad(P(sg.p1), P(sg.p2), P(sg.p3));
      if (sg.type === SEG_CUBIC) return mkCubic(P(sg.p1), P(sg.p2), P(sg.p3), P(sg.p4));
      const c0 = sg.circle;
      return mkRQuad(
        P(sg.p1),
        P(sg.p2),
        P(sg.p3),
        sg.w,
        c0
          ? {
              cx: off ? r32((c0.cx + T) * S) : c0.cx * S,
              cy: off ? r32((c0.cy + T) * S) : c0.cy * S,
              r: off ? r32(c0.r * S) : c0.r * S,
            }
          : null,
      );
    }),
  );
}
const lerpContours = (sc, dc, t) => {
  if (t <= 0) return sc;
  if (t >= 1) return dc;
  const u = 1 - t,
    lp = (a, b) => [a[0] * u + b[0] * t, a[1] * u + b[1] * t];
  return sc.map((cs, ci) =>
    cs.map((ss, si) => {
      const ds = dc[ci][si];
      if (ss.type === SEG_LINE) return mkLine(lp(ss.p1, ds.p1), lp(ss.p2, ds.p2), ss.is_fill_only);
      if (ss.type === SEG_QUAD) return mkQuad(lp(ss.p1, ds.p1), lp(ss.p2, ds.p2), lp(ss.p3, ds.p3));
      if (ss.type === SEG_CUBIC)
        return mkCubic(lp(ss.p1, ds.p1), lp(ss.p2, ds.p2), lp(ss.p3, ds.p3), lp(ss.p4, ds.p4));
      return mkRQuad(lp(ss.p1, ds.p1), lp(ss.p2, ds.p2), lp(ss.p3, ds.p3), ss.w, null);
    }),
  );
};

const pairs = await selfPairs(importSvg, parseMetaBin, curveRangeToContours, { step: 1 });

// ONE EXPONENT PER PROCESS control: SOLO=<k> runs the 24-cell scan at that exponent ALONE, so no earlier
// exponent's module state (_setKeyOrigin) or segment memo can be read by a later one.
if (process.env.SOLO !== undefined) {
  const S = Math.pow(2, +process.env.SOLO);
  for (const want of WANT) {
    const p = pairs.find((q) => q.name === `tiger#${want}/grow`);
    if (!p) continue;
    const fillRule = p.evenOdd ? 'evenodd' : 'nonzero';
    const sc = scaleContours(p.src, S, true),
      dc = scaleContours(p.dst, S, true);
    const v = [];
    for (let i = 0; i < 24; i++) {
      let r = false;
      try {
        r = !!buildLoopBlinnPartitionPair(
          lerpContours(sc, dc, i / 24),
          lerpContours(sc, dc, (i + 1) / 24),
          fillRule,
          { plainDstRows: true },
        );
      } catch {
        r = false;
      }
      v.push(r ? 1 : 0);
    }
    console.log(`SOLO 2^${process.env.SOLO}  ${p.name}  scan ${v.join('')}`);
  }
  process.exit(0);
}

for (const want of WANT) {
  const p = pairs.find((q) => q.name === `tiger#${want}/grow`);
  if (!p) {
    console.log(`tiger#${want}/grow not found`);
    continue;
  }
  const fillRule = p.evenOdd ? 'evenodd' : 'nonzero';
  console.log(
    `\n=== ${p.name}  (evenOdd ${p.evenOdd}, ${p.src.length} contour(s), ${p.src[0].length} segs) ===`,
  );
  const verdicts = (S) => {
    const sc = scaleContours(p.src, S, true),
      dc = scaleContours(p.dst, S, true);
    const ok = (a, b) => {
      try {
        return !!buildLoopBlinnPartitionPair(
          lerpContours(sc, dc, a),
          lerpContours(sc, dc, b),
          fillRule,
          { plainDstRows: true },
        );
      } catch {
        return false;
      }
    };
    const N = 24,
      v = [];
    for (let i = 0; i < N; i++) v.push(ok(i / N, (i + 1) / N) ? 1 : 0);
    return v;
  };
  const base = verdicts(1);
  console.log(`  offset@1     scan: ${base.join('')}`);
  for (const k of KS) {
    const v = verdicts(Math.pow(2, k));
    const diff = v.map((x, i) => (x === base[i] ? '.' : 'X')).join('');
    const first = v.findIndex((x, i) => x !== base[i]);
    console.log(
      `  offset@2^${String(k).padStart(3)} scan: ${v.join('')}   diff ${diff}${first >= 0 ? `   first cell ${first} = t[${(first / 24).toFixed(5)}, ${((first + 1) / 24).toFixed(5)}]` : '   (scan identical)'}`,
    );
  }
}
