// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// streamDerivedStatsSmoke — a streamed bundle's derived stats follow its geometry.
//
// createBundle derives four numbers from the import that the engine selectors read every draw: meanFillShapeArea and
// numFillShapes (aacFill: 'auto'), meanSegsPerShape (the LB size gate, the no-AA segment cap) and segTypeMask (typeOmit
// compiles out the kernels of segment types the bundle lacks). Left at the FIRST frame's by updateBundleGeometry, a
// streamed shape would be priced at its first size -- 2768 against a rebuild's 4128 on streamGeometryRenderDiffSmoke's
// wobble -- and under typeOmit a segment type that first appears mid-stream would be drawn without its kernel. Node only,
// on the recording WebGL stand-in (test/_fakeGl.mjs):
//   (a) the full rebuild path: after streaming frame A's bundle to frame B, meanFillShapeArea, numFillShapes and
//       meanSegsPerShape equal a fresh build of frame B's, and the type mask holds B's types;
//   (b) THE MASK only GROWS: a frame that brings in a line adds the line bit, and a later frame without it keeps it (a
//       program that has a kernel is never switched to one without);
//   (c) the lightweight (GPU-resident LB) path refreshes the same stats.
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { createFakeGl } = await import('./_fakeGl.mjs');
const { createBundle, buildStreamableSections, updateBundleGeometry } =
  await import('../src/index.js');
const { mkLine, mkCubic, SEG_LINE, SEG_CUBIC } = await import('../src/primitives/seg.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const gl = createFakeGl({ width: 256, height: 256 }).gl;

const K = 0.5522847498;
function blob(cx, cy, rx, ry) {
  const kx = K * rx,
    ky = K * ry;
  const E = [cx + rx, cy],
    N = [cx, cy - ry],
    W = [cx - rx, cy],
    S = [cx, cy + ry];
  return [
    mkCubic(E, [cx + rx, cy - ky], [cx + kx, cy - ry], N),
    mkCubic(N, [cx - kx, cy - ry], [cx - rx, cy - ky], W),
    mkCubic(W, [cx - rx, cy + ky], [cx - kx, cy + ry], S),
    mkCubic(S, [cx + kx, cy + ry], [cx + rx, cy + ky], E),
  ];
}
// a blob with its last cubic replaced by a straight chord: the same topology count, a LINE among its segments
const blobWithLine = (cx, cy, rx, ry) => {
  const s = blob(cx, cy, rx, ry);
  s[3] = mkLine([cx, cy + ry], [cx + rx, cy]);
  return s;
};
const FILLS = [
  [0.78, 0.2, 0.2, 1],
  [0.2, 0.55, 0.78, 1],
];
const shapesOf = (segsList) => segsList.map((segs, i) => ({ segs, fill: FILLS[i] }));
const A = [blob(70, 70, 30, 30), blob(160, 160, 22, 22)];
const B = [blob(85, 60, 42, 38), blob(150, 175, 18, 26)];
const L = [blobWithLine(85, 60, 42, 38), blob(150, 175, 18, 26)];
const bit = (t) => 1 << t;
const stats = (b) => ({
  area: b.meanFillShapeArea,
  fills: b.numFillShapes,
  segs: b.meanSegsPerShape,
  mask: b.segTypeMask,
});
const show = (s) =>
  `area ${s.area.toFixed(1)}, fills ${s.fills}, segs/shape ${s.segs}, mask 0x${(s.mask | 0).toString(16)}`;

for (const [path, lightweight] of [
  ['full rebuild', false],
  ['lightweight', true],
]) {
  const tag = path === 'full rebuild' ? '(a)' : '(c)';
  const fresh = createBundle(gl, buildStreamableSections(shapesOf(B), null, { lightweight }));
  const st = createBundle(gl, buildStreamableSections(shapesOf(A), null, { lightweight }));
  const authored = lightweight ? null : new Float64Array(st.curveFloats);
  if (authored) st.curveFloats64 = authored;
  const before = stats(st);
  const up = updateBundleGeometry(gl, st, B, lightweight ? { lightweight: true } : {});
  const got = stats(st),
    want = stats(fresh);
  ok(up.ok, `${tag} ${path}: the update takes (${up.reason || 'ok'})`);
  ok(
    Math.abs(got.area - want.area) <= 1e-9 * want.area &&
      got.fills === want.fills &&
      got.segs === want.segs &&
      (got.mask & want.mask) === want.mask &&
      before.area !== want.area,
    `${tag} ${path}: frame A's bundle streamed to B reads B's stats (${show(got)}; a build of B: ${show(want)}; before: ${show(before)})`,
  );
  if (lightweight) continue;
  ok(
    st.curveFloats64 !== authored &&
      st.curveFloats64.length === st.curveFloats.length &&
      st.curveFloats64.every((v, i) => Math.fround(v) === st.curveFloats[i]),
    'streaming replaces an imported precision plane with the current geometry',
  );
  // (b) the mask only grows
  updateBundleGeometry(gl, st, L);
  const withLine = stats(st).mask;
  updateBundleGeometry(gl, st, B);
  const after = stats(st).mask;
  ok(
    withLine & bit(SEG_LINE) && withLine & bit(SEG_CUBIC) && after === withLine,
    `(b) a frame with a line adds its bit (0x${withLine.toString(16)}), and a frame without it keeps it (0x${after.toString(16)})`,
  );
}

// Streaming must transfer LB ownership and invalidate CPatch preparation.
{
  const { buildCPatchBundle } = await import('../src/renderer/cpatchBuild.js');
  const { buildLbBundle } = await import('../src/renderer/lbBuildCore.js');
  const { claimFillMeshes, MESH_OWNER } = await import('../src/renderer/fillMeshOwner.js');
  const { setSdfPrimitivesEnabled } = await import('../src/geom/shapeRecognize.js');
  setSdfPrimitivesEnabled(false);
  try {
    for (const owner of [MESH_OWNER.LB, MESH_OWNER.CPATCH]) {
      const b = createBundle(gl, buildStreamableSections(shapesOf(A), null));
      if (owner === MESH_OWNER.CPATCH) {
        ok(
          buildCPatchBundle(gl, b, { pool: false }),
          'prepare real CPatch geometry before streaming',
        );
      } else {
        const built = buildLbBundle({
          curveFloats: b.curveFloats,
          metaFloats: b.metaFloats,
          metaFloatsPerShape: b.metaFloatsPerShape,
          ranges: b.curveRangesByShape,
          numShapes: b.numShapes,
        });
        ok(claimFillMeshes(b, owner, built.packed), 'prepare real LB geometry before streaming');
        b._lbGen = b._geomGen | 0;
      }
      const up = updateBundleGeometry(gl, b, B, { lightweight: true });
      ok(
        up.ok && !(b._fillMeshStomps | 0),
        owner + ': streaming publishes without a refused ownership claim',
      );
      if (owner === MESH_OWNER.LB) {
        ok(
          b._fillMeshOwner === MESH_OWNER.STREAM && b._lbStream && b._lbGen === b._geomGen,
          'LB preparation transfers to the current lightweight stream',
        );
      } else {
        ok(
          !b._lbStream && b._lbGen !== b._geomGen,
          'CPatch uses fresh full geometry instead of marking the old mesh current',
        );
        ok(
          buildCPatchBundle(gl, b, { pool: false }) && b._lbGen === b._geomGen,
          'explicit CPatch preparation rebuilds the streamed geometry',
        );
      }
      b.dispose();
    }
  } finally {
    setSdfPrimitivesEnabled(true);
  }
}

console.log(fail ? `STREAM-DERIVED-STATS FAIL (${fail})` : 'STREAM-DERIVED-STATS PASS');
process.exit(fail ? 1 : 0);
