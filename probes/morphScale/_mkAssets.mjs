// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _mkAssets — write the GPU check's morph artwork: the same outline authored at two sizes.
//
// The point of the check is that a drawing's SIZE must not change what the renderer does with it, so
// each pair ships twice: once at the size these constants were tuned at, and once at 2^-8 of it with
// the viewBox scaled to match, so the renderer's fit maps both onto the same pixels. Two renders of
// the same picture; any difference between them is a tolerance that did not scale.
//
// `_zzScaleAll.mjs` does this by wrapping the content in a `<g transform="scale(S)">`, which is right
// for an audit but wrong here: the importer flattens that transform, so both files would then carry
// the same authored numbers and the check would test nothing. These write the scaled COORDINATES.
//
//   node probes/morphScale/_mkAssets.mjs        (writes probes/morphScale/assets/)
import { mkdirSync, writeFileSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'assets');
mkdirSync(OUT, { recursive: true });
const ROOT = path.resolve(HERE, '../..');

const { default: importSvg } = await import('../../src/svg/importer.js');
const { parseMetaBin } = await import('../../src/core/metaBin.js');
const { curveRangeToContours } = await import('../../src/geom/lbContour.js');
const { SEG_LINE, SEG_QUAD, SEG_CUBIC } = await import('../../src/primitives/seg.js');
const { blobPath } = await import('./_morphPairs.mjs');

const n = (v) => (Math.abs(v) < 1e-12 ? '0' : String(+v.toPrecision(12)));
const svg = (vb, d, extra = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}">\n  <path d="${d}" fill="#3366cc"${extra}/>\n</svg>\n`;
const write = (name, s) => {
  writeFileSync(path.join(OUT, name), s);
  console.log('  ' + name);
};

/// Scale every number in a path's `d` about the origin. The viewBox scales with it, so the drawing
/// lands on the same pixels and only the AUTHORED magnitudes differ.
const scaleD = (d, S) => d.replace(/-?\d+(\.\d+)?(e[-+]?\d+)?/gi, (m) => n(parseFloat(m) * S));

// PHASE 2.0, which is the rotation test/morphScaleEquivarianceSmoke.mjs's fan-triangle case uses and the one an absolute-bar tree
// declines from 2^-8 down; phase 0 builds at every size on both trees and would test nothing.
console.log('blob (cubic, rot 2.0): the case an absolute-bar tree declines from 2^-8 down');
for (const [tag, S] of [
  ['u1', 1],
  ['u256', 2 ** -8],
  ['u65536', 2 ** -16],
]) {
  const vb = `0 0 ${n(200 * S)} ${n(200 * S)}`;
  write(`blobCubic_${tag}_SRC.svg`, svg(vb, scaleD(blobPath(0, 2.0, 'cubic'), S)));
  write(`blobCubic_${tag}_DST.svg`, svg(vb, scaleD(blobPath(1, 2.0, 'cubic'), S)));
}

console.log('blob (cubic), MIXED SIZE: the destination is 1/16 of the source');
for (const [tag, S] of [
  ['u1', 1],
  ['u256', 2 ** -8],
]) {
  const vb = `0 0 ${n(200 * S)} ${n(200 * S)}`;
  write(`blobMixed_${tag}_SRC.svg`, svg(vb, scaleD(blobPath(0, 0, 'cubic'), S)));
  write(`blobMixed_${tag}_DST.svg`, svg(vb, scaleD(blobPath(1, 0, 'cubic', 6, 2.5, 1.375), S)));
}

// A REAL SHAPE, not a generated one: the scale corpus's declines are concentrated on tiger's cubic
// shapes, and a tiger shape morphed to an affine of itself is the pair `_morphPairs.selfPairs` uses,
// so the GPU sees exactly what the CPU survey scored.
console.log('tiger shapes morphed to an affine of themselves');
{
  const raw = readFileSync(path.join(ROOT, '../MantleSamples/Assets/Mantle/tiger.svg'), 'utf8')
    .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
    .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
  const sec = await importSvg(raw, { preserveViewport: true });
  const meta = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
  const plane = new Float32Array(sec.curves);
  const dOf = (cs) =>
    cs
      .map((c) => {
        let d = `M ${n(c[0].p1[0])} ${n(c[0].p1[1])}`;
        for (const s of c) {
          if (s.type === SEG_LINE) d += ` L ${n(s.p2[0])} ${n(s.p2[1])}`;
          else if (s.type === SEG_QUAD)
            d += ` Q ${n(s.p2[0])} ${n(s.p2[1])} ${n(s.p3[0])} ${n(s.p3[1])}`;
          else if (s.type === SEG_CUBIC)
            d += ` C ${n(s.p2[0])} ${n(s.p2[1])} ${n(s.p3[0])} ${n(s.p3[1])} ${n(s.p4[0])} ${n(s.p4[1])}`;
          else return null; // an arc has no single path command here; these shapes have none
        }
        return d + ' Z';
      })
      .join(' ');
  // The shapes the CPU tracer named: each declines at 2^-20 with absolute bars and builds with relative ones.
  for (const s of [64, 160, 184]) {
    const r = sec.curveRangesByShape[s];
    if (!r) continue;
    const cs = curveRangeToContours(plane, r.begin, r.end);
    let cx = 0,
      cy = 0,
      m = 0,
      x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const c of cs)
      for (const sg of c)
        for (const q of [sg.p1, sg.p2, sg.p3, sg.p4])
          if (q) {
            cx += q[0];
            cy += q[1];
            m++;
            if (q[0] < x0) x0 = q[0];
            if (q[0] > x1) x1 = q[0];
            if (q[1] < y0) y0 = q[1];
            if (q[1] > y1) y1 = q[1];
          }
    cx /= m;
    cy /= m;
    const grow = (k, a) => {
      const ca = Math.cos(a),
        sa = Math.sin(a);
      const P = (q) =>
        q && [
          cx + ((q[0] - cx) * ca - (q[1] - cy) * sa) * k,
          cy + ((q[0] - cx) * sa + (q[1] - cy) * ca) * k,
        ];
      return cs.map((c) =>
        c.map((sg) => ({ type: sg.type, p1: P(sg.p1), p2: P(sg.p2), p3: P(sg.p3), p4: P(sg.p4) })),
      );
    };
    const pad = 0.2 * Math.max(x1 - x0, y1 - y0);
    for (const [tag, S] of [
      ['u1', 1],
      ['u256', 2 ** -8],
      ['u65536', 2 ** -16],
    ]) {
      const vb = `${n((x0 - pad) * S)} ${n((y0 - pad) * S)} ${n((x1 - x0 + 2 * pad) * S)} ${n((y1 - y0 + 2 * pad) * S)}`;
      const a = dOf(cs),
        b = dOf(grow(1.1, 0.05));
      if (!a || !b) continue;
      write(`tiger${s}_${tag}_SRC.svg`, svg(vb, scaleD(a, S), ' fill-rule="nonzero"'));
      write(`tiger${s}_${tag}_DST.svg`, svg(vb, scaleD(b, S), ' fill-rule="nonzero"'));
    }
  }
}
console.log(`written to ${OUT}`);
