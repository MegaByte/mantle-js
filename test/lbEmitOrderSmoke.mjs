// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbEmitOrderSmoke — the packer emits what does the exact work together.
//
// A GPU shades a draw's quads in submission order, packed into lockstep SIMD groups, and a group costs its slowest lane.
// The lanes of a Bezout ring (the exact arc kernel) and of an interior face carrying a cubic chain (near its arc) cost
// ~500 float ops where their neighbours cost ~250, and every lane of a group they share waits for them. So the packer
// emits every Bezout ring after every cubic's hull, and the interior faces that carry a cubic chain before the others:
// probes/lbAccuracy/_lbSimdCost.mjs puts tiger 512 at 1.364x -> 1.307x of a base build's lockstep cost (1.532x -> 1.372x
// serialized), the 64-point star at 1.249x -> 1.213x (1.468x -> 1.260x).
//
// Every fragment computes what it did -- the kernel reads nothing of the order -- so the checks are: the order holds, the
// same raw mesh packed in the builder's order (the TEST HOOK `__LB_EMIT_ORDER = false`) paints the same coverage, and a
// morph pair, whose poses are lerped vertex for vertex, keeps the builder's order either way.
import { readFileSync } from 'fs';

if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const A = await import('./_assets.mjs');
const R = await import('../probes/lbAccuracy/_lbRaster.mjs');
const { packLoopBlinnMesh, LB_VERT_FLOATS: VF } = await import('../src/renderer/lbPack.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const warn = console.warn;
console.warn = () => {};

/// Run fn with the TEST HOOK set (false: the builder's order), under __MANTLE_DEBUG__.
function withOrder(on, fn) {
  globalThis.__MANTLE_DEBUG__ = true;
  if (!on) globalThis.__LB_EMIT_ORDER = false;
  try {
    return fn();
  } finally {
    delete globalThis.__LB_EMIT_ORDER;
    delete globalThis.__MANTLE_DEBUG__;
  }
}
/// The order's two properties on one pack, and the vertex counts they rest on.
function orderOf(pk) {
  const v = pk.verts,
    n = pk.vertexCount;
  let lastHull = -1,
    firstRing = Infinity,
    lastCubicFace = -1,
    firstOtherFace = Infinity,
    rings = 0,
    cubicFaces = 0,
    otherFaces = 0;
  for (let i = 0; i < n; i++) {
    const o = i * VF,
      kind = Math.floor(v[o + 5] + 1e-4),
      seam = v[o + 23]; // (a blend flag rides the kind's fraction)
    if (kind === 4 && seam > 8.5) {
      rings++;
      firstRing = Math.min(firstRing, i);
    } else if (kind === 4 || kind === 2) lastHull = i;
    if (kind === 0 && i % 3 === 0) {
      const cubic = v[o + 2] > 3.5 || seam > 0.5;
      if (cubic) {
        cubicFaces++;
        lastCubicFace = i;
      } else {
        otherFaces++;
        firstOtherFace = Math.min(firstOtherFace, i);
      }
    }
  }
  return {
    ringsLast: !rings || firstRing > lastHull,
    cubicFirst: !cubicFaces || !otherFaces || lastCubicFace < firstOtherFace,
    rings,
    cubicFaces,
    otherFaces,
  };
}
/// Twin coverage of one pack (per-shape OVER), for comparing two orders of the same mesh.
function coverage(pk, view, N) {
  const acc = new Float64Array(N * N).fill(1);
  R.rasterMesh(
    pk,
    view,
    acc,
    {},
    new Int32Array(N * N),
    new Int32Array(N * N).fill(-1),
    new Float64Array(N * N),
  );
  return acc;
}
async function check(label, bundle, N, want) {
  const { shapes, bbox } = await R.shapesOf(bundle);
  const view = R.viewOf(bbox, N);
  let packs = 0,
    bad = 0,
    rings = 0,
    cubicFaces = 0,
    otherFaces = 0,
    differ = 0,
    worst = 0,
    reordered = 0;
  for (const sh of shapes) {
    const b = await R.buildMesh(sh);
    if (!b || !b.pk || !(b.pk.vertexCount > 0)) continue;
    packs++;
    const o = orderOf(b.pk);
    if (!o.ringsLast || !o.cubicFirst) bad++;
    rings += o.rings;
    cubicFaces += o.cubicFaces;
    otherFaces += o.otherFaces;
    const kept = withOrder(false, () => packLoopBlinnMesh(b.raw));
    if (kept.verts.subarray(0, kept.vertexCount * VF).some((x, k) => !Object.is(x, b.pk.verts[k])))
      reordered++;
    const a = coverage(b.pk, view, N),
      k = coverage(kept, view, N);
    for (let q = 0; q < a.length; q++) {
      const d = Math.abs(a[q] - k[q]);
      if (d > 0) differ++;
      worst = Math.max(worst, d);
    }
  }
  ok(
    bad === 0 && (!want.rings || rings > 0) && (!want.faces || (cubicFaces > 0 && otherFaces > 0)),
    `${label}: ${packs} packs, every Bezout ring after every cubic hull (${rings} ring vertices) and every cubic-chain face before the others (${cubicFaces} / ${otherFaces} faces); ${bad} out of order`,
  );
  ok(
    reordered > 0 && worst < 1e-12,
    `${label}: ${reordered} packs differ from the builder's order, and paint the same coverage (${differ} px differ by rounding alone, worst ${worst.toExponential(2)})`,
  );
}

// The S-curve: its concave dip's interior faces carry the arc, the rest a straight chain.
const SCURVE =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 384 384"><path d="M40 300 C80 230 160 380 200 300 S300 240 340 330 L340 370 L40 370 Z" fill="#000"/></svg>';
{
  const { default: importSvg } = await import('../src/svg/importer.js');
  await check('S-curve', await importSvg(SCURVE, { preserveViewport: true }), 384, { faces: true });
}
const TIGER = A.example('tiger.svg');
if (!A.have(TIGER)) A.noteSkip(`examples/tiger.svg is absent -- ${A.missingHint(TIGER)}`);
else await check('tiger', await R.loadSvg(TIGER), 512, { rings: true, faces: true });

{
  // A morph pair keeps its order: its two poses are lerped vertex for vertex, and the packer's order sorts by what a
  // pose carries, which the two need not agree on.
  const { buildMorphBundle } = await import('../src/renderer/lbMorphCore.js');
  const { parseMetaBin } = await import('../src/core/metaBin.js');
  const { default: importSvg } = await import('../src/svg/importer.js');
  const S = readFileSync(
    new URL('../examples/smoke/lbMorphEvenOdd__SRC.svg', import.meta.url),
    'utf8',
  );
  const D = readFileSync(
    new URL('../examples/smoke/lbMorphEvenOdd__DST.svg', import.meta.url),
    'utf8',
  );
  const a = await importSvg(S, { preserveViewport: true }),
    d = await importSvg(D, { preserveViewport: true });
  const pa = parseMetaBin(a.meta, a.metaFloatsPerShape),
    pd = parseMetaBin(d.meta, d.metaFloatsPerShape);
  const input = {
    srcCurve: new Float32Array(a.curves),
    dstCurve: new Float32Array(d.curves),
    srcMeta: pa.metaFloats,
    dstMeta: pd.metaFloats,
    metaStride: pa.floatsPerShape,
    ranges: a.curveRangesByShape,
    numShapes: a.numShapes,
    bb: a.globalBBox,
  };
  // (a pair's VBO interleaves the poses, vertex src, vertex dst, ...; a t-segmented pair holds one per segment)
  const vbos = (m) =>
    (m ? (m.segments ? m.segments.map((g) => g.vbo) : [m.vbo]) : []).filter(Boolean);
  const ord = vbos(withOrder(true, () => buildMorphBundle(input)).meshes[0]),
    old = vbos(withOrder(false, () => buildMorphBundle(input)).meshes[0]);
  const n = ord.reduce((t, v) => t + v.length / (2 * VF), 0);
  const same =
    ord.length === old.length &&
    ord.every((v, k) => v.length === old[k].length && v.every((x, q) => Object.is(x, old[k][q])));
  ok(
    n > 0 && same,
    `lbMorphEvenOdd's pair: ${n} vertices, byte for byte the builder's order with the packer's order on or off`,
  );
}

console.warn = warn;
console.log(fail ? `\n${fail} FAILED` : '\nlbEmitOrderSmoke: all passed');
process.exit(fail ? 1 : 0);
