// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _scale1 — THE SCALE-1 SURVEY. What replacing a scale-dependent bar does at the size the constants
// were tuned at, pair by pair, shape by shape.
//
// The renderer must be correct at any scale, and "it moves output at scale 1" is not a reason to keep
// a scale-dependent tolerance -- but the new scale-1 output has to be SHOWN correct rather than
// explained. That starts with knowing exactly which morphs moved and by how much, which is what this
// writes: one digest line per pair, diffable between two trees.
//
// Per pair: whether the pair builds at all (and by which route), the two packed meshes' vertex
// counts and kind masks, and a checksum over every packed float. A checksum change with equal
// counts is a coefficient move; a count change is a topology move; a build/decline change is a
// route move (the morph falls to Slug, or stops doing so).
//
//   node probes/morphScale/_scale1.mjs > a.txt      STEP=1  KIND=...
//   (check out the other tree, run again, diff)
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
const { default: importSvg } = await import('../../src/svg/importer.js');
const { parseMetaBin } = await import('../../src/core/metaBin.js');
const { curveRangeToContours } = await import('../../src/geom/lbContour.js');
const { buildLoopBlinnPartitionPair } = await import('../../src/renderer/lbPartitionPair.js');
const { segmentPartitionPairMorph } = await import('../../src/renderer/loopBlinnMorph.js');
const { packLoopBlinnMesh, LB_VERT_FLOATS } = await import('../../src/renderer/lbPack.js');
const { assetPairs, synthPairs, selfPairs } = await import('./_morphPairs.mjs');

const KINDS = new Set((process.env.KIND || 'asset,synth,mixed,self,selfMixed').split(','));
const STEP = +(process.env.STEP || 1);
const SELF = process.env.SELF || '../MantleSamples/Assets/Mantle/tiger.svg';
const _warn = console.warn;
console.warn = () => {};

/// A checksum over every packed float, order-sensitive and exact on the bits (a float that changed
/// in its last mantissa bit has to show, or a coefficient move reads as "identical").
const f32 = new Float32Array(1),
  u32 = new Uint32Array(f32.buffer);
function sum(a) {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < a.length; i++) {
    f32[0] = a[i];
    let v = u32[0];
    h = (Math.imul(h ^ (v & 0xff), 16777619) ^ ((v >>> 8) & 0xff)) >>> 0;
    h = (Math.imul(h, 16777619) ^ ((v >>> 16) & 0xff)) >>> 0;
    h = (Math.imul(h, 16777619) ^ (v >>> 24)) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
const pk = (m) => {
  const p = packLoopBlinnMesh(m);
  return p
    ? `${p.vertexCount}:${p.kindMask | 0}:${sum(p.verts.subarray(0, p.vertexCount * LB_VERT_FLOATS))}`
    : 'null';
};

const pairs = [
  ...(await assetPairs(importSvg, parseMetaBin, curveRangeToContours)),
  ...(await synthPairs(importSvg, parseMetaBin, curveRangeToContours)),
  ...(SELF !== 'none'
    ? await selfPairs(importSvg, parseMetaBin, curveRangeToContours, { file: SELF, step: STEP })
    : []),
].filter((p) => KINDS.has(p.kind));

for (const p of pairs) {
  const fr = p.evenOdd ? 'evenodd' : 'nonzero';
  let route = 'slug',
    body = '-';
  try {
    let pr = buildLoopBlinnPartitionPair(p.src, p.dst, fr);
    if (pr) route = 'pair';
    else {
      pr = buildLoopBlinnPartitionPair(p.src, p.dst, fr, { plainDstRows: true });
      if (pr) route = 'pairPlain';
    }
    if (pr) body = `${pk(pr.src)} / ${pk(pr.dst)}`;
    else {
      const segs = segmentPartitionPairMorph(p.src, p.dst, fr);
      if (segs) {
        route = 'segmented';
        body = segs
          .map(
            (s) => `${s.tLo.toFixed(6)}-${s.tHi.toFixed(6)} ${pk(s.pair.src)} / ${pk(s.pair.dst)}`,
          )
          .join(' | ');
      }
    }
  } catch (e) {
    route = 'throw';
    body = String((e && e.message) || e).slice(0, 60);
  }
  console.log(`${p.kind}/${p.name}\t${route}\t${body}`);
}
console.warn = _warn;
