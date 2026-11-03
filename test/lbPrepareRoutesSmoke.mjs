// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbPrepareRoutesSmoke.mjs — a prepared bundle must end up with meshes, whatever the policy thinks.
//
// A bundle that never adopts a mesh draws its cover quads for good, at pixels identical to Slug.
// Two ways to get there, both pinned here because both are invisible to a pixel test — Slug is a CORRECT picture, so losing the analytic
// route looks like success:
//
//   1. THE POLICY GATE IS NOT A BUILD GATE. lbBundleMayPick answers "would the per-shape policy give
//      any shape a mesh", and it is false for a line-only outline (and for bundles whose every row
//      is a stroke, clip, mask or filter row). Routing prepareBundle through a builder carrying that
//      gate would make those bundles build nothing, so they could never route at all -- though the
//      builder produces perfectly good meshes for them, which is what this asserts.
//
//   2. THE WORKER'S WIRE FORM IS NOT THE MAIN-THREAD PACK. packLbMeshForWire keeps only what the GPU
//      needs and drops the CPU-side fields (`cubics`, the partition's own pieces). A caller that
//      prepares and then INSPECTS the meshes needs the main-thread build, so prepareBundle cannot
//      quietly become a request to the worker.
//
// prepareBundle itself is not reachable from Node (attachMorphDraw needs a GL context), so this pins
// the decision chain it depends on. The browser-side end of it is lbHoleParitySmoke's lbDiagonalFrameParity case.
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const { buildLbBundle, packLbMeshForWire } = await import('../src/renderer/lbBuildCore.js');
const { lbBundleMayPick } = await import('../src/renderer/lbShapePolicy.js');
const { attachUnifiedFillDraw } = await import('../src/renderer/unifiedFillDraw.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

// The diagonal folded-corner frame from the lbDiagonalFrameParity case: two opposite-winding STRAIGHT
// contours. No cubic, no arc anywhere, which is exactly what the policy gate keys on.
const FRAME =
  '<svg viewBox="0 0 186 286" xmlns="http://www.w3.org/2000/svg" width="93" height="143">' +
  '<path d="M135.2 10 L176 51 V276 H10 V10 Z  M139.4 0 H0 V286 H186 V46.9 L183.1 44 L142.3 3 Z" fill="#000"/></svg>';

async function load(svg) {
  const sec = await importSvg(svg, { preserveViewport: true });
  const pm = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
  return {
    sec,
    input: {
      curveFloats: new Float32Array(sec.curves),
      metaFloats: pm.metaFloats,
      metaFloatsPerShape: pm.floatsPerShape,
      ranges: sec.curveRangesByShape,
      numShapes: sec.numShapes,
    },
    policyBundle: {
      metaFloats: pm.metaFloats,
      metaFloatsPerShape: pm.floatsPerShape,
      numShapes: sec.numShapes,
      segTypeMask: sec.segTypeMask,
      _geomGen: 0,
    },
  };
}

const frame = await load(FRAME);

// --- 1. the trap: the per-shape policy declines this bundle outright
ok(
  lbBundleMayPick(frame.policyBundle) === false,
  'a line-only frame is declined by the per-shape policy (lbBundleMayPick false)',
);

// --- ...yet the builder makes real meshes for it, so a policy-gated prepare LOSES them
const built = buildLbBundle(frame.input);
const real = built.packed.filter((m) => m && !m.slug && (m.vertexCount | 0) > 0).length;
ok(
  real > 0,
  `the builder still produces ${real} real mesh(es) for it — the decline is policy, not geometry`,
);

// --- 2. with and without those meshes, what the unified stream actually routes
const n = frame.input.numShapes;
const CQ = 12,
  VPS = 6;
const cover = new Float32Array(n * VPS * CQ);
const sidx = new Float32Array(n * VPS);
for (let s = 0; s < n; s++) {
  for (let v = 0; v < VPS; v++) {
    const o = (s * VPS + v) * CQ;
    cover[o] = 10 * s + v;
    cover[o + 1] = 20 * s + v;
    cover[o + 4] = 30 * s + v;
    sidx[s * VPS + v] = s;
  }
}
const drawList = [];
for (let s = 0; s < n; s++)
  drawList.push({ kind: 'fillShape', shapeIdx: s, chunk: { vboStart: s * VPS, count: VPS } });

const R = {
  gl: {},
  opts: {},
  draw: {},
  _lbFillMode: 'on',
  _coverChunkStart: (c) => c.vboStart | 0,
  filterRecord: () => null,
};
attachUnifiedFillDraw(R);
const entriesWith = (meshes) =>
  R._unifiedFillEntriesFor({
    _lbMeshes: meshes,
    drawList,
    numShapes: n,
    _geomGen: 0,
    metaFloats: frame.input.metaFloats,
    metaFloatsPerShape: frame.input.metaFloatsPerShape,
    coverQuadVboFloats: cover,
    hybridShapeIdxVboFloats: sidx,
  });

const unprepared = entriesWith(new Array(n));
ok(
  !!unprepared && unprepared.every((e) => e.kind === 'cover'),
  'with no meshes every shape draws its cover quad — this IS the lbRouted 0 the lane reported',
);

const prepared = entriesWith(built.packed);
const lbEntries = (prepared || []).filter((e) => e.kind === 'lb').length;
ok(lbEntries > 0, `once the meshes exist the frame routes ${lbEntries} shape(s) to Loop-Blinn`);

// --- 3. only the MAIN-THREAD build leaves CPU meshes behind, and a caller reads those
// `cubics` (the partition's own pieces) live on the RAW meshes, which the main-thread build keeps as
// bundle._lbMeshesRaw. The worker returns `packed` only -- it transfers GPU buffers and the raw
// meshes never cross -- so a bundle prepared through the worker has no raw meshes at all, and a
// caller inspecting them sees nothing. That is what took lbDegenerateCubicDropSmoke down.
const curvy = await load(
  '<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">' +
    '<path fill="#000" d="M150 40 C70 20 30 70 30 100 C30 130 70 180 150 160 L150 130' +
    ' C90 150 60 130 60 100 C60 70 90 50 150 70 Z"/></svg>',
);
const curvyBuilt = buildLbBundle(curvy.input);
const rawCubics = (curvyBuilt.raw || []).reduce(
  (n, m) => n + (m && !m.slug && m.cubics ? m.cubics.length : 0),
  0,
);
ok(
  rawCubics > 0,
  `the main-thread build leaves ${rawCubics} raw cubic piece(s) for a caller to inspect`,
);
const anyWireCubics = (curvyBuilt.packed || [])
  .map(packLbMeshForWire)
  .some((w) => w && w.cubics !== undefined);
ok(
  !anyWireCubics,
  'the wire form carries no cubics — a prepare served from the worker cannot answer an inspecting caller',
);

console.log(fail ? `\nFAIL ${fail}` : '\nall ok');
process.exit(fail ? 1 : 0);
