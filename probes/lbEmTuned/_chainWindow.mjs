// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _chainWindow — what a face's CHAIN actually spans, against what the chain's polyline error is.
//
// The GPU check falsified the deviation model: the assets that moved most on screen are not the ones
// whose chain polyline moved farthest from the true arc, and the one predicted to move most
// (_arcs_circle) did not move at all. The candidate explanation is that a face's chain is not "the
// arc's polyline" but a BOUNDED WINDOW onto it -- interiorChainsFromTris hands each face at most 6
// points (chainA/B = 4, chainC = 2 more), so halving the piece length halves the arc length the
// window covers. chainBoxCov clips that window to the pixel box; a window shorter than the box does
// not cross it, and the kernel then falls to its miss modes (1.0, or the tangent-extended border
// walk) rather than to a slightly-moved edge. That is a DISCRETE change, unbounded by the deviation.
//
// So this measures, per face and per shape, both quantities in pixels at the 512-px raster:
//   win   the chain polyline's own length (chainA -> chainB -> chainC), i.e. how much outline the
//         face can see
//   dev   the maximum distance from the true arc to the n-piece polyline (the geometry-only model)
// and reports how many faces have win < 1 px, < 2 px -- the faces whose window cannot cross a pixel.
//
//   node probes/lbEmTuned/_chainWindow.mjs [file.svg#shape ...]     TOL=0.00025 (the absolute budget)
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
const { default: importSvg } = await import('../../src/svg/importer.js');
const { curveRangeToContours, emSpan } = await import('../../src/geom/lbContour.js');
const { buildLbShape } = await import('../../src/renderer/lbBuildCore.js');
const { LB_VERT_FLOATS } = await import('../../src/renderer/lbPack.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
console.warn = () => {};

const hash = (a) => {
  let h = 0x811c9dc5 >>> 0;
  const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  for (let i = 0; i < u.length; i++) {
    h ^= u[i];
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16);
};

const SPECS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['examples/smoke/aacPointsRoute__SVG_FILL.svg#ALL'];
const TOL = process.env.TOL ? +process.env.TOL : null;

/// The per-face chain, as points. interiorChainsFromTris writes the same chain across a face's three
/// vertices, stride 4: chainA = P0.xy,P1.xy ; chainB = P2.xy,P3.xy ; chainC = P4.xy and then a MODE
/// SENTINEL (2 = straight chain, 3 = conic) at chainC[o+2] -- P5 is never read by the shader, so it
/// is NOT a coordinate. The chain is FIVE points, padded by repeating the last, which makes the
/// trailing segments degenerate and inert.
function chainsOf(raw) {
  const A = raw.interiorChainA,
    B = raw.interiorChainB,
    C = raw.interiorChainC;
  if (!A) return [];
  const out = [];
  for (let f = 0; f * 12 + 11 < A.length; f++) {
    const o = f * 12; // 3 verts * 4 floats, the same chain replicated
    const P = [
      [A[o], A[o + 1]],
      [A[o + 2], A[o + 3]],
      [B[o], B[o + 1]],
      [B[o + 2], B[o + 3]],
      [C[o], C[o + 1]],
    ];
    let n = P.length; // drop the repeated-last padding
    while (n > 1 && P[n - 1][0] === P[n - 2][0] && P[n - 1][1] === P[n - 2][1]) n--;
    out.push({ P: P.slice(0, n), mode: C[o + 2] });
  }
  return out;
}
const plen = (P) => {
  let L = 0;
  for (let i = 0; i + 1 < P.length; i++)
    L += Math.hypot(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]);
  return L;
};

for (const spec of SPECS) {
  const [file, si] = spec.split('#');
  const bundle = await importSvg(readFileSync(path.resolve(ROOT, file), 'utf8'));
  const meta = new Float32Array(bundle.meta, 32),
    mst = bundle.metaFloatsPerShape;
  const cf = new Float32Array(bundle.curves);
  const list = si === 'ALL' ? [...Array(bundle.numShapes).keys()] : [+si];
  for (const s of list) {
    const r = bundle.curveRangesByShape[s];
    if (!r || r.end <= r.begin) continue;
    const bb = s * mst;
    const cs = curveRangeToContours(cf, r.begin, r.end);
    if (!cs) continue;
    const hulls = [];
    globalThis.__LB_HULLDUMP = (h) => hulls.push(h);
    if (TOL) globalThis.__MANTLE_DEBUG__ = true; // __LB_HULL_TOL is a test hook, read only under it
    if (TOL) globalThis.__LB_HULL_TOL = TOL;
    const b = buildLbShape(
      cs,
      meta[bb + 7] < 0.996 &&
        Math.floor(meta[bb + 28] + 0.5) === 0 &&
        (mst < 36 || Math.floor(meta[bb + 35] + 0.5) === 0),
      meta[bb + 13] > 0.5,
    );
    globalThis.__LB_HULLDUMP = null;
    globalThis.__LB_HULL_TOL = undefined;
    if (!b || !b.raw) continue;
    const span = hulls.length ? hulls[0].span : emSpan(),
      px = span / 512;
    const all = chainsOf(b.raw);
    const ch = all.filter((c) => c.P.length >= 2 && plen(c.P) > 0);
    const W = ch.map((c) => plen(c.P) / px).sort((a, b2) => a - b2);
    const segs = ch
      .flatMap((c) => {
        const L = [];
        for (let i = 0; i + 1 < c.P.length; i++)
          L.push(Math.hypot(c.P[i + 1][0] - c.P[i][0], c.P[i + 1][1] - c.P[i][1]) / px);
        return L;
      })
      .sort((a, b2) => a - b2);
    const qs = (p) =>
      segs.length ? segs[Math.min(segs.length - 1, Math.round(p * (segs.length - 1)))] : NaN;
    const bad = b.raw.interiorBadFaces
      ? [...b.raw.interiorBadFaces].reduce((a2, v) => a2 + v, 0)
      : 'n/a';
    const q = (p) => (W.length ? W[Math.min(W.length - 1, Math.round(p * (W.length - 1)))] : NaN);
    const ns = hulls.map((h) => h.n);
    console.log(
      `${spec.replace('examples/', '')}#${s}  verts ${b.pk ? b.pk.vertexCount : 0}  hash ${b.pk ? hash(b.pk.verts.subarray(0, b.pk.vertexCount * LB_VERT_FLOATS)) : '-'}`,
    );
    console.log(
      `   span ${span}  px ${px.toFixed(5)} em  hulls ${hulls.length} n=[${[...new Set(ns)].join(',')}]  chains ${ch.length}`,
    );
    console.log(
      `   chain window in px@512: min ${q(0).toFixed(3)} p25 ${q(0.25).toFixed(3)} p50 ${q(0.5).toFixed(3)} p75 ${q(0.75).toFixed(3)} max ${q(1).toFixed(3)}`,
    );
    console.log(
      `   windows shorter than 1 px: ${W.filter((v) => v < 1).length}/${W.length};  than 2 px: ${W.filter((v) => v < 2).length}/${W.length};  badFaces ${bad}`,
    );
    console.log(
      `   chain SEGMENT length px@512: min ${qs(0).toFixed(3)} p25 ${qs(0.25).toFixed(3)} p50 ${qs(0.5).toFixed(3)} max ${qs(1).toFixed(3)};  under 1 px: ${segs.filter((v) => v < 1).length}/${segs.length}`,
    );
  }
}
