// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzFacePaint — WHAT covers one pixel, and what that piece says the coverage is. Both engines
// spike at smooth joints with TOO MUCH ink, and the mechanism a build-side comment already names
// is an interior face that finds no outline: its chain comes out all-zero, chainBoxCov reads that
// as deep interior, and the face paints a flat 1 on a pixel the path half covers. This checks
// that claim on a named pixel instead of assuming it.
import { readFileSync } from 'fs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { rowSpans, rowCross } from '../src/renderer/cpatchConvert.js';
import { buildLoopBlinnCDT } from '../src/renderer/loopBlinn.js';
import { packLoopBlinnMesh } from '../src/renderer/lbPack.js';
import { parseMetaBin } from '../src/core/metaBin.js';
const N = +(process.env.N || 512);
const SVG = readFileSync(process.env.SVG || '../MantleSamples/Assets/Mantle/tiger.svg', 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
const sec = await importSvg(SVG, { preserveViewport: true });
const cf = new Float32Array(sec.curves);
const meta = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
const bb = [0, 0, 900, 900];
const emX = (i) => bb[0] + ((i + 0.5) / N) * bb[2];
const emY = (j) => bb[1] + (1 - (j + 0.5) / N) * bb[3];
const SCX = bb[2] / N;
globalThis.__lbChainTrace = 1;
const inTri = (p, a, b, c) => {
  const d = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (!(Math.abs(d) > 0)) return false;
  const w1 = ((p[0] - a[0]) * (c[1] - a[1]) - (p[1] - a[1]) * (c[0] - a[0])) / d;
  const w2 = ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) / d;
  return w1 >= -1e-12 && w2 >= -1e-12 && 1 - w1 - w2 >= -1e-12;
};
for (const spec of (process.env.PTS || '220,370,66').split(' ')) {
  const [pi, pj, s] = spec.split(',').map(Number);
  const p = [emX(pi), emY(pj)];
  const r = sec.curveRangesByShape[s];
  const evenOdd = meta.metaFloats[s * meta.floatsPerShape + 13] > 0.5;
  const cs = curveRangeToContours(cf, r.begin | 0, r.end | 0);
  globalThis.__lbChainEmpty = [];
  const m = buildLoopBlinnCDT(cs, { fillRule: evenOdd ? 'evenodd' : 'nonzero' });
  if (!m) {
    console.log(`${spec}: DECLINED`);
    continue;
  }
  const cv = contoursToConverter(cs, null);
  const segs = [];
  for (const c of cv) for (const sg of c) segs.push(sg);
  // exact coverage
  let cov = 0;
  const M = 33;
  for (let g = 0; g < M; g++) {
    const y = p[1] + (900 / N) * ((g + 0.5) / M - 0.5);
    let spans;
    if (!evenOdd) spans = rowSpans(segs, y) || [];
    else {
      const xs = [];
      for (const sg of segs) rowCross(sg, y, (x) => xs.push(x));
      xs.sort((a, b) => a - b);
      spans = [];
      for (let z = 0; z + 1 < xs.length; z += 2) spans.push([xs[z], xs[z + 1]]);
    }
    let c3 = 0;
    for (const sp of spans)
      c3 += Math.max(0, Math.min(p[0] + SCX / 2, sp[1]) - Math.max(p[0] - SCX / 2, sp[0]));
    cov += c3 / SCX / M;
  }
  console.log(
    `px(${pi},${pj}) em(${p[0].toFixed(2)},${p[1].toFixed(2)}) s${s}  exact coverage ${cov.toFixed(4)}`,
  );
  // interior faces containing it
  const I = m.interior,
    nF = I ? (I.length / 6) | 0 : 0;
  const CH = [
    'interiorChainA',
    'interiorChainB',
    'interiorChainC',
    'interiorChainD',
    'interiorChainE',
  ].map((k) => m[k]);
  let hit = 0;
  for (let f = 0; f < nF; f++) {
    const a = [I[f * 6], I[f * 6 + 1]],
      b = [I[f * 6 + 2], I[f * 6 + 3]],
      c = [I[f * 6 + 4], I[f * 6 + 5]];
    if (!inTri(p, a, b, c)) continue;
    hit++;
    // FOUR FLOATS PER VERTEX, not two per face: chainA holds (p0.xy, p1.xy) at vertex*4, chainB
    // (p2.xy, p3.xy), chainC (p4.xy, mode, 0). Face f's first vertex is 3f. Read per face, the
    // points come out as somebody else's outline entirely.
    const v0 = f * 3 * 4;
    const A = CH[0],
      B = CH[1],
      C = CH[2];
    const pts =
      A && B && C
        ? [
            [A[v0], A[v0 + 1]],
            [A[v0 + 2], A[v0 + 3]],
            [B[v0], B[v0 + 1]],
            [B[v0 + 2], B[v0 + 3]],
            [C[v0], C[v0 + 1]],
          ]
        : [];
    const mode = C ? C[v0 + 2] : 0;
    const zero = !pts.length || pts.every((q) => q[0] === 0 && q[1] === 0);
    console.log(
      `  INTERIOR face ${f}: ${[a, b, c].map((q) => `(${q[0].toFixed(1)},${q[1].toFixed(1)})`).join(' ')}`,
    );
    console.log(
      `    chain ${zero ? 'ALL ZERO  -> chainBoxCov returns a flat 1' : pts.map((q) => `(${q[0].toFixed(1)},${q[1].toFixed(1)})`).join(' ')}` +
        `   mode ${mode}   hasChain2 ${m.interiorHasChain2 ? m.interiorHasChain2[f] : '-'}`,
    );
  }
  // Every other bucket, by fan: a hull is not always a triangle, and testing only its first three
  // points reports "nothing covers this" for a piece that plainly does.
  const inHull = (H) => {
    const n = H.length / 2;
    for (let i = 1; i + 1 < n; i++)
      if (inTri(p, [H[0], H[1]], [H[2 * i], H[2 * i + 1]], [H[2 * i + 2], H[2 * i + 3]]))
        return true;
    return false;
  };
  for (const [name, arr] of [
    ['CUBIC', m.cubics],
    ['QUAD', m.quads],
    ['EDGE', m.edges],
    ['STRIP', m.stripArcs],
    ['FALLBACK', m.fallback],
  ]) {
    for (const c of arr || []) {
      const H = c && c.hull ? c.hull : null;
      if (!H) continue;
      if (!inHull(H)) continue;
      hit++;
      const n = H.length / 2;
      console.log(
        `  ${name}${name === 'CUBIC' ? (c.klmn ? ' klmn' : ' bezout') : ''} sign ${c.sign}, ${n} pts: ` +
          Array.from(
            { length: n },
            (_, i) => `(${H[2 * i].toFixed(1)},${H[2 * i + 1].toFixed(1)})`,
          ).join(' '),
      );
    }
  }
  // THE PACKED CHAIN, which is the one the kernel reads. The builder's interiorChainA/B/C are
  // distributed by the packer into aC3 (P0, P1), aC0/vLine2 (P2, P3) and aTC.yz (P4), and a
  // mismatch between the two readings is invisible from either alone.
  if (process.env.PACKCHAIN) {
    try {
      const pk2 = packLoopBlinnMesh(m);
      const V2 = pk2 && (pk2.verts || pk2.data || pk2.buffer || pk2.v);
      const FL2 = 24;
      for (let z = 0; z + FL2 <= V2.length; z += FL2) {
        if (Math.abs(V2[z + 5]) > 0.3) continue; // interior kind only
        const A2 = [V2[z], V2[z + 1]];
        // the three vertices of this face are consecutive
        const B2 = [V2[z + FL2], V2[z + FL2 + 1]],
          C2 = [V2[z + 2 * FL2], V2[z + 2 * FL2 + 1]];
        if (!inTri(p, A2, B2, C2)) continue;
        const P0 = [V2[z + 19], V2[z + 20]],
          P1 = [V2[z + 21], V2[z + 22]];
        const P2 = [V2[z + 7], V2[z + 8]],
          P3 = [V2[z + 9], V2[z + 10]];
        const P4 = [V2[z + 3], V2[z + 4]];
        const EPPx = 900 / N;
        const loc = (q) =>
          `(${((q[0] - p[0]) / EPPx).toFixed(3)},${((q[1] - p[1]) / EPPx).toFixed(3)})`;
        console.log(`  PACKED face at vert ${z / FL2}: mode aTC.x=${V2[z + 2].toFixed(2)}`);
        console.log(`    chain in PIXEL-LOCAL coords: ${[P0, P1, P2, P3, P4].map(loc).join(' ')}`);
        break;
      }
    } catch (e) {
      console.log('  PACKCHAIN threw ' + e.message);
    }
  }
  // WHAT actually SHIPS. The exterior ring is a PACK-time construct -- it does not exist on the
  // mesh the builder returns -- so counting the builder's buckets cannot tell whether the band
  // outside the curve was emitted at all.
  try {
    const pk = packLoopBlinnMesh(m);
    const V = pk && (pk.verts || pk.data || pk.buffer || pk.v);
    const FL = 24;
    if (V && V.length) {
      const kc = new Map();
      for (let z = 0; z + FL <= V.length; z += FL) kc.set(V[z + 5], (kc.get(V[z + 5]) || 0) + 1);
      console.log(
        `  PACKED kinds (verts): ` +
          [...kc]
            .sort((a, b) => a[0] - b[0])
            .map(([k, n2]) => `${k}:${n2}`)
            .join(' '),
      );
    } else console.log(`  PACKED: ${pk ? Object.keys(pk).join(' ') : 'null'}`);
  } catch (e) {
    console.log('  PACKED: threw ' + e.message);
  }
  console.log(
    `  buckets: ` +
      [
        ['interior', nF],
        ['cubics', (m.cubics || []).length],
        ['quads', (m.quads || []).length],
        ['edges', (m.edges || []).length],
        ['stripArcs', (m.stripArcs || []).length],
        ['fallback', (m.fallback || []).length],
      ]
        .map(([k, v]) => k + ':' + v)
        .join(' '),
  );
  if (!hit) console.log('  NOTHING in the mesh contains this pixel center');
  if (process.env.DUMPF) {
    // Does each face's chain actually touch that face? A chain whose points are nowhere near the
    // triangle is either a real defect or a misread of the layout, and the two look identical from
    // one face. Over a run of faces the answer is obvious.
    const [f0, f1] = process.env.DUMPF.split(',').map(Number);
    for (let f = f0; f <= f1 && f < nF; f++) {
      const a = [I[f * 6], I[f * 6 + 1]],
        b = [I[f * 6 + 2], I[f * 6 + 3]],
        c = [I[f * 6 + 4], I[f * 6 + 5]];
      const v0 = f * 3 * 4,
        A = CH[0],
        B = CH[1],
        C = CH[2];
      if (!A) break;
      const pts = [
        [A[v0], A[v0 + 1]],
        [A[v0 + 2], A[v0 + 3]],
        [B[v0], B[v0 + 1]],
        [B[v0 + 2], B[v0 + 3]],
        [C[v0], C[v0 + 1]],
      ];
      const cen = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3];
      const R = Math.max(...[a, b, c].map((q) => Math.hypot(q[0] - cen[0], q[1] - cen[1])));
      const far = Math.min(...pts.map((q) => Math.hypot(q[0] - cen[0], q[1] - cen[1])));
      console.log(
        `  face ${f}: tri r=${R.toFixed(1)}  nearest chain pt ${far.toFixed(1)} from centroid` +
          `   ${far > 4 * R ? 'CHAIN IS ELSEWHERE' : 'ok'}`,
      );
    }
  }
  const emp = globalThis.__lbChainEmpty || [];
  const near = emp.filter((e) => Math.hypot(e.cx - p[0], e.cy - p[1]) < 6 * SCX);
  console.log(
    `  empty-chain faces in this shape: ${emp.length}   within 6px of this pixel: ${near.length}` +
      (near.length ? '  nearest outline ' + (near[0].near / SCX).toFixed(2) + 'px' : ''),
  );
}
