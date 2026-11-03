// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbPairCubicPlanSmoke.mjs — smooth-cubic morphs keep their GPU morph mesh.
//
// Three rules keep a smooth-cubic morph (an ellipse, a ring, a circle into an irregular outline) on its GPU mesh; without
// any one of them it falls to Slug with a correct picture, which only route counters notice:
//
//   - CONTAINMENT and FAITHFULNESS splitting cut the static partition's cubics at parameters a morph pair re-deriving them
//     without either rule would miss, and the pair would meet vertices it never registered. Both poses cut at one merged
//     plan from the builder's own cubicSplitPlan9.
//   - FLOAT32 STORAGE. The pair registers points by float64 key and looks up the float32 vertices the mesh returns; a
//     coordinate at a key bucket's edge can round into the next bucket. The lookup finds the registration whose float32
//     image is the stored vertex.
//   - A CIRCLE pairs with an ELLIPSE as SDF records: a circle is the ellipse of equal radii.
//
// No GPU. With SDF primitives on and off:
//   - a circle growing into an ellipse pairs as SDF discs (6 vertices) with primitives on, and as a mesh with them off;
//   - an even-odd ring morph is served by the partition pair itself;
//   - a circle into an irregular outline changes a piece's classification mid-morph, so it takes the t-segmented pair;
//   - an identity morph (the same pose twice) packs a source mesh byte-identical to the partition build of that pose,
//     which pins the plan the pair hands the builder to the plan the builder computes for itself.
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { setSdfPrimitivesEnabled } = await import('../src/geom/shapeRecognize.js');
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const { curveRangeToContours } = await import('../src/renderer/loopBlinn.js');
const { buildLoopBlinnPartitionPair } = await import('../src/renderer/lbPartitionPair.js');
const { buildLoopBlinnPartition } = await import('../src/renderer/lbPartition.js');
const { buildMorphShape } = await import('../src/renderer/lbMorphCore.js');
const { packLoopBlinnMesh } = await import('../src/renderer/lbPack.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

const K = 0.5522847498;
const ellipsePath = (cx, cy, rx, ry) =>
  `M ${cx + rx} ${cy} ` +
  `C ${cx + rx} ${cy - K * ry} ${cx + K * rx} ${cy - ry} ${cx} ${cy - ry} ` +
  `C ${cx - K * rx} ${cy - ry} ${cx - rx} ${cy - K * ry} ${cx - rx} ${cy} ` +
  `C ${cx - rx} ${cy + K * ry} ${cx - K * rx} ${cy + ry} ${cx} ${cy + ry} ` +
  `C ${cx + K * rx} ${cy + ry} ${cx + rx} ${cy + K * ry} ${cx + rx} ${cy} Z`;
const svg = (vb, d, extra = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}"><path d="${d}" fill="#3366cc" ${extra}/></svg>`;
const ring = (a, b, c, d) =>
  svg(
    '0 0 200 200',
    `${ellipsePath(100, 100, a, b)} ${ellipsePath(100, 100, c, d)}`,
    'fill-rule="evenodd"',
  );
// unifiedMorphSmoke's solid morph: a circle into an irregular four-cubic outline.
const A = 'M20 4 C31 4 36 9 36 20 C36 31 31 36 20 36 C9 36 4 31 4 20 C4 9 9 4 20 4 Z';
const B = 'M20 8 C28 2 34 10 33 20 C32 30 28 34 20 33 C11 32 6 28 7 20 C8 10 12 2 20 8 Z';

const pose = async (s) => {
  const b = await importSvg(s, { preserveViewport: true });
  const pm = parseMetaBin(b.meta, b.metaFloatsPerShape);
  const cf = new Float32Array(b.curves),
    r = b.curveRangesByShape[0];
  return { pm, contours: curveRangeToContours(cf, r.begin, r.end) };
};
const morphMesh = (S, D) => {
  const res = buildMorphShape(
    S.contours,
    D.contours,
    S.pm.metaFloats,
    D.pm.metaFloats,
    0,
    S.pm.floatsPerShape,
  );
  return res && res.mesh;
};
const sameVerts = (a, b) =>
  a.vertexCount === b.vertexCount &&
  a.verts.length === b.verts.length &&
  a.verts.every((v, i) => Object.is(v, b.verts[i]));

try {
  for (const sdf of [true, false]) {
    setSdfPrimitivesEnabled(sdf);
    const tag = sdf ? '' : ' (SDF off)';

    {
      const S = await pose(svg('0 0 200 200', ellipsePath(100, 100, 60, 60)));
      const D = await pose(svg('0 0 200 200', ellipsePath(100, 100, 80, 40)));
      const m = morphMesh(S, D);
      ok(!!(m && m.vertexCount > 0), `circle -> ellipse${tag}: builds a morph mesh`);
      if (sdf)
        ok(
          !!m && m.vertexCount === 6 && !m.segments,
          `circle -> ellipse: pairs as one SDF disc record (${m && m.vertexCount} verts)`,
        );
    }
    {
      const S = await pose(ring(70, 70, 35, 35)),
        D = await pose(ring(80, 50, 40, 25));
      ok(!!morphMesh(S, D), `ring -> ring (even-odd)${tag}: builds a morph mesh`);
      ok(
        !!buildLoopBlinnPartitionPair(S.contours, D.contours, 'evenodd'),
        `ring -> ring (even-odd)${tag}: the partition pair serves it`,
      );
    }
    {
      const S = await pose(svg('0 0 40 40', A)),
        D = await pose(svg('0 0 40 40', B));
      const m = morphMesh(S, D);
      ok(!!(m && m.vertexCount > 0), `circle -> irregular cubic${tag}: builds a morph mesh`);
      ok(
        !!(m && m.segments && m.segments.length > 1),
        `circle -> irregular cubic${tag}: takes the t-segmented pair (${m && m.segments ? m.segments.length : 0} segments)`,
      );
    }
    {
      // Identity morph: the merged plan is the pose's own, so the pair's source must pack exactly what the builder packs
      // when it plans the same pose itself, under the pair's build options.
      const P = await pose(ring(80, 50, 40, 25));
      const pair = buildLoopBlinnPartitionPair(P.contours, P.contours, 'evenodd');
      const opts = {
        fillRule: 'evenodd',
        skipCurveInterior: true,
        noReorient: true,
        keyContours: P.contours,
        pairChains9: true,
      };
      // The pair's chain route reads each piece's destination (`pairDstPiece9`), and an identity morph's is the piece.
      const pieces = new Map();
      for (const r of (buildLoopBlinnPartition(P.contours, opts) || {}).cubicRecs9 || [])
        pieces.set(r.ci9 + '|' + r.si9 + '|' + r.pi9, r.cp);
      const own = buildLoopBlinnPartition(P.contours, {
        ...opts,
        pairDstPiece9: (ci, si, pi) => pieces.get(ci + '|' + si + '|' + pi) || null,
      });
      ok(!!pair && !!own, `identity ring${tag}: pair and partition both build`);
      if (pair && own) {
        // A pair packs in the builder's order (`_keepOrder9`, see lbPack's emission order), so the plan is compared
        // packed the same way: the question is whether the two PLANS agree, not the order a static mesh is emitted in.
        own._keepOrder9 = true;
        const a = packLoopBlinnMesh(pair.src),
          b = packLoopBlinnMesh(own);
        ok(
          sameVerts(a, b),
          `identity ring${tag}: the pair's source packs byte-identical to the builder's own plan (${a.vertexCount} vs ${b.vertexCount} verts)`,
        );
      }
    }
  }
} finally {
  setSdfPrimitivesEnabled(true);
}

console.log(fail ? `\n${fail} failure(s)` : '\nLB-PAIR-CUBIC-PLAN PASS');
process.exit(fail ? 1 : 0);
