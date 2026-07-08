// Verify buildNineSliceMesh expands a single fill cover-quad into the
// expected 18-triangle 3×3 grid (54 verts) and patches the chunk header
// `n` field.
import { COVER_QUAD_STRIDE } from '../src/renderer/coverQuadChunks.js';
import { buildNineSliceMesh } from '../src/renderer/nineSlice.js';

let failures = 0;
const ok   = (m) => console.log('ok', m);
const fail = (m) => { failures++; console.error('FAIL', m); };
const near = (a, b, tol = 1e-5) => Math.abs(a - b) <= tol;

// Build a synthetic 1-chunk cover quads: 12-float header + 6 verts.
// Native em-bbox: (0, 0)–(100, 50). Border: (10, 10, 10, 10).
// Target world: 200 × 100.
// Expected: 18 triangles × 3 verts = 54 verts; the 4×4 grid em
// positions span: x ∈ {0, 10, 190, 200}, y ∈ {0, 10, 90, 100}.
const meshFloats = (() => {
  // header(12) + 6 verts × 12 floats = 12 + 72 = 84 floats.
  const arr = new Float32Array(12 + 6 * 12);
  // Header: n=6, gid=1, r=0.5, g=0.6, b=0.7, aFlag=1.0, rest zero.
  arr[0] = 6;   arr[1] = 1;   arr[2] = 0.5; arr[3] = 0.6;
  arr[4] = 0.7; arr[5] = 1.0;
  // 6 verts of the fill bbox-quad. The exact (x,y) per vert mirrors
  // the importer's writeFillBboxQuad: 2 triangles spanning (0,0)–(100,50).
  // Order: (0,0), (100,0), (0,50), (100,0), (100,50), (0,50).
  // Per vert: aPos.xy + 8 unused slots + kind=1 + zone=-1.
  const verts = [
    [0,  0],  [100, 0],  [0, 50],
    [100, 0], [100, 50], [0, 50],
  ];
  for (let v = 0; v < 6; v++) {
    const o = 12 + v * 12;
    arr[o + 0]  = verts[v][0];
    arr[o + 1]  = verts[v][1];
    // slots 2..9 unused — leave zero.
    arr[o + 10] = 1;   // kind = cover quad
    arr[o + 11] = -1;  // zone = hull interior
  }
  return arr;
})();

const chunks = [{ start: 1, count: 6, gid: 1, fillColor: [0.5, 0.6, 0.7, 1.0] }];
const gidToShapeIdx = new Map([[1, 0]]);
// Minimal metaFloats: stride 48; row 0 has FLAG=0 (renderable).
const metaStride = 48;
const metaFloats = new Float32Array(metaStride);
// row 0, gid slot 14 = 1, flags slot 27 = 0.
metaFloats[14] = 1;

// ---- T1: border=0 → passthrough (no rewrite) -----------------------
{
  const out = buildNineSliceMesh({
    meshFloats, chunks, gidToShapeIdx, metaFloats, metaStride,
    border: [0, 0, 0, 0], worldSize: [200, 100],
    nativeBBox: [0, 0, 100, 50],
  });
  if (out.meshFloats === meshFloats && out.chunks === chunks)
    ok('T1 zero border → passthrough (identical references returned)');
  else
    fail('T1 zero border should passthrough');
}

// ---- T2: worldSize=0 → passthrough -------------------------------
{
  const out = buildNineSliceMesh({
    meshFloats, chunks, gidToShapeIdx, metaFloats, metaStride,
    border: [10, 10, 10, 10], worldSize: [0, 0],
    nativeBBox: [0, 0, 100, 50],
  });
  if (out.meshFloats === meshFloats)
    ok('T2 zero worldSize → passthrough');
  else
    fail('T2 zero worldSize should passthrough');
}

// ---- T3: full rewrite — expand 6-vert quad to 54-vert grid ----------
{
  const out = buildNineSliceMesh({
    meshFloats, chunks, gidToShapeIdx, metaFloats, metaStride,
    border: [10, 10, 10, 10], worldSize: [200, 100],
    nativeBBox: [0, 0, 100, 50],
  });
  // Expect 1 chunk, count 54.
  if (out.chunks.length === 1 && out.chunks[0].count === 54)
    ok(`T3 chunk count → 54 (was 6)`);
  else
    fail(`T3 chunk count: ${JSON.stringify(out.chunks)}`);
  // Header n-slot patched.
  if (out.meshFloats[0] === 54)
    ok(`T3 header.n patched to 54`);
  else
    fail(`T3 header.n = ${out.meshFloats[0]} (expected 54)`);
  // Total floats = 12 header + 54 × 12 verts = 660.
  if (out.meshFloats.length === 12 + 54 * 12)
    ok(`T3 meshFloats length = 660 (12 header + 648 verts)`);
  else
    fail(`T3 meshFloats length = ${out.meshFloats.length}`);
  // shapeIdxFloats has one float per vert.
  if (out.shapeIdxFloats && out.shapeIdxFloats.length === 55)
    ok(`T3 shapeIdxFloats length matches vert count (55)`);
  else
    fail(`T3 shapeIdxFloats: ${out.shapeIdxFloats && out.shapeIdxFloats.length}`);
  // All shapeIdxFloats body slots reference shape 0.
  const allZero = Array.from(out.shapeIdxFloats.slice(1)).every(x => x === 0);
  if (allZero) ok(`T3 shapeIdxFloats body slots all reference shape 0`);
  else fail(`T3 shapeIdxFloats body has non-zero entries`);
}

// ---- T4: corner sample — (0,0), (10,0), (190,0), (200,0) vert row ---
{
  const out = buildNineSliceMesh({
    meshFloats, chunks, gidToShapeIdx, metaFloats, metaStride,
    border: [10, 10, 10, 10], worldSize: [200, 100],
    nativeBBox: [0, 0, 100, 50],
  });
  // Sweep ALL 54 body verts; the union of unique (x, y) pairs MUST be
  // the 4×4 grid: x ∈ {0, 10, 190, 200}, y ∈ {0, 10, 90, 100}.
  const expectedXs = new Set([0, 10, 190, 200]);
  const expectedYs = new Set([0, 10, 90, 100]);
  const seenXs = new Set();
  const seenYs = new Set();
  for (let v = 1; v <= 54; v++) {
    const o = v * 12;
    seenXs.add(out.meshFloats[o + 0]);
    seenYs.add(out.meshFloats[o + 1]);
  }
  const xsMatch = expectedXs.size === seenXs.size
    && [...expectedXs].every(x => seenXs.has(x));
  const ysMatch = expectedYs.size === seenYs.size
    && [...expectedYs].every(y => seenYs.has(y));
  if (xsMatch && ysMatch)
    ok(`T4 grid covers expected 4×4 (x ∈ {0,10,190,200}, y ∈ {0,10,90,100})`);
  else
    fail(`T4 grid mismatch: xs=${[...seenXs].sort((a,b)=>a-b)}, ys=${[...seenYs].sort((a,b)=>a-b)}`);
}

// ---- T5: chunk count > 6 (not a simple quad) → passthrough -----------
{
  const bigMesh = new Float32Array(12 + 12 * 12);
  bigMesh[0] = 12; bigMesh[1] = 2;  // n=12, gid=2
  for (let v = 0; v < 12; v++) {
    bigMesh[12 + v * 12 + 10] = 1;
    bigMesh[12 + v * 12 + 11] = -1;
  }
  const bigChunks = [{ start: 1, count: 12, gid: 2, fillColor: [1, 0, 0, 1] }];
  const bigMap = new Map([[2, 0]]);
  const out = buildNineSliceMesh({
    meshFloats: bigMesh, chunks: bigChunks,
    gidToShapeIdx: bigMap, metaFloats, metaStride,
    border: [10, 10, 10, 10], worldSize: [200, 100],
    nativeBBox: [0, 0, 100, 50],
  });
  if (out.chunks[0].count === 12)
    ok(`T5 non-quad chunk (count=12) passes through unchanged`);
  else
    fail(`T5 non-quad rewrote to count=${out.chunks[0].count}`);
}

// ---- T6: border sum > emW → clamped ----------------------------------
{
  // emW = 100. Asking for L=80, R=80 → sum 160 > 100. Clamp to 50/50.
  // Expected x cuts: {0, 50, 150, 200}.
  const out = buildNineSliceMesh({
    meshFloats, chunks, gidToShapeIdx, metaFloats, metaStride,
    border: [80, 10, 80, 10], worldSize: [200, 100],
    nativeBBox: [0, 0, 100, 50],
  });
  const expectedXs = new Set([0, 50, 150, 200]);
  const seenXs = new Set();
  for (let v = 1; v <= 54; v++) {
    seenXs.add(out.meshFloats[v * 12 + 0]);
  }
  const xsMatch = expectedXs.size === seenXs.size
    && [...expectedXs].every(x => seenXs.has(x));
  if (xsMatch) ok(`T6 oversized border clamps (x ∈ {0, 50, 150, 200})`);
  else fail(`T6 clamp xs=${[...seenXs].sort((a,b)=>a-b)}`);
}

// ---- T7: FLAG_LAYER row → passthrough --------------------------------
{
  const layerMeta = new Float32Array(metaStride);
  layerMeta[14] = 1;
  layerMeta[27] = 0x100;  // FLAG_LAYER
  const out = buildNineSliceMesh({
    meshFloats, chunks, gidToShapeIdx,
    metaFloats: layerMeta, metaStride,
    border: [10, 10, 10, 10], worldSize: [200, 100],
    nativeBBox: [0, 0, 100, 50],
  });
  if (out.chunks[0].count === 6)
    ok(`T7 FLAG_LAYER shape passes through (no 9-slice)`);
  else
    fail(`T7 FLAG_LAYER chunk rewrote to count=${out.chunks[0].count}`);
}

// ---- T4b: aEmCoord (native em) grid spans 4×4 native frame ----------
{
  const out = buildNineSliceMesh({
    meshFloats, chunks, gidToShapeIdx, metaFloats, metaStride,
    border: [10, 10, 10, 10], worldSize: [200, 100],
    nativeBBox: [0, 0, 100, 50],
  });
  // For each body vert, floats 4..5 hold aEmCoord. Expected unique
  // values: x ∈ {0, 10, 90, 100}, y ∈ {0, 10, 40, 50} (clamped to
  // native frame, NOT the stretched target).
  const expectedExs = new Set([0, 10, 90, 100]);
  const expectedEys = new Set([0, 10, 40, 50]);
  const seenExs = new Set();
  const seenEys = new Set();
  for (let v = 1; v <= 54; v++) {
    const o = v * 12;
    seenExs.add(out.meshFloats[o + 4]);
    seenEys.add(out.meshFloats[o + 5]);
  }
  const xsMatch = expectedExs.size === seenExs.size
    && [...expectedExs].every(x => seenExs.has(x));
  const ysMatch = expectedEys.size === seenEys.size
    && [...expectedEys].every(y => seenEys.has(y));
  if (xsMatch && ysMatch)
    ok('T4b aEmCoord grid covers NATIVE frame (ex ∈ {0,10,90,100}, ey ∈ {0,10,40,50})');
  else
    fail(`T4b aEmCoord mismatch: exs=${[...seenExs].sort((a,b)=>a-b)}, eys=${[...seenEys].sort((a,b)=>a-b)}`);
}

// ---- T4c: corner-cell verts have aPos == aEmCoord ------------------
{
  const out = buildNineSliceMesh({
    meshFloats, chunks, gidToShapeIdx, metaFloats, metaStride,
    border: [10, 10, 10, 10], worldSize: [200, 100],
    nativeBBox: [0, 0, 100, 50],
  });
  // Find any vert with aPos.x ∈ {0, 10} AND aPos.y ∈ {0, 10} (the
  // top-left corner cell). aEmCoord MUST equal aPos in that cell
  // (corner cells are identity-scaled).
  let cornerVerts = 0;
  let cornerMatches = 0;
  for (let v = 1; v <= 54; v++) {
    const o = v * 12;
    const px = out.meshFloats[o + 0], py = out.meshFloats[o + 1];
    const ex = out.meshFloats[o + 4], ey = out.meshFloats[o + 5];
    if ((px === 0 || px === 10) && (py === 0 || py === 10)) {
      cornerVerts++;
      if (near(px, ex) && near(py, ey)) cornerMatches++;
    }
  }
  if (cornerVerts > 0 && cornerVerts === cornerMatches)
    ok(`T4c top-left corner cell: ${cornerVerts} verts, all with aPos == aEmCoord (identity)`);
  else
    fail(`T4c corner identity: ${cornerMatches}/${cornerVerts}`);
}

// ---- T4d: middle-cell verts have aPos ≠ aEmCoord -------------------
{
  const out = buildNineSliceMesh({
    meshFloats, chunks, gidToShapeIdx, metaFloats, metaStride,
    border: [10, 10, 10, 10], worldSize: [200, 100],
    nativeBBox: [0, 0, 100, 50],
  });
  // The right-edge cell verts span aPos.x ∈ {190, 200}. The
  // corresponding aEmCoord.x ∈ {90, 100}. So aPos != aEmCoord on x.
  let edgeVerts = 0;
  let edgeDivergent = 0;
  for (let v = 1; v <= 54; v++) {
    const o = v * 12;
    const px = out.meshFloats[o + 0];
    const ex = out.meshFloats[o + 4];
    if (px === 190 || px === 200) {
      edgeVerts++;
      if (Math.abs(px - ex) > 1) edgeDivergent++;
    }
  }
  if (edgeVerts > 0 && edgeVerts === edgeDivergent)
    ok(`T4d right-edge cell: ${edgeVerts} verts, all with aPos != aEmCoord (stretched)`);
  else
    fail(`T4d edge divergence: ${edgeDivergent}/${edgeVerts}`);
}

// ---- T8: bundle.applyNineSlice + roundtrip restore -------------------
{
  // Fake bundle that mimics the slots applyNineSlice touches. No GL.
  const baselineMesh = new Float32Array(meshFloats);
  const baselineChunks = chunks.map(c => ({ ...c }));
  const baselineShapeIdx = new Float32Array([0, 0, 0, 0, 0, 0, 0]);

  const fakeBundle = {
    numShapes: 1,
    globalBBox: [0, 0, 100, 50],
    metaFloats, metaFloatsPerShape: metaStride,
    coverQuadFloats: baselineMesh,
    coverQuadChunks: baselineChunks,
    hybridShapeIdxFloats: baselineShapeIdx,
    chunkByShape: [baselineChunks[0]],
    gidToShapeIdx,
    drawList: [{ kind: 'fill', chunk: baselineChunks[0] }],
    filterGraphs: null,
  };
  // Exercise buildNineSliceMesh the way applyNineSlice would (this smoke
  // focuses on the pure rewrite function; renderer integration is covered
  // elsewhere).
  const result = buildNineSliceMesh({
    meshFloats: fakeBundle.coverQuadFloats,
    chunks: fakeBundle.coverQuadChunks,
    gidToShapeIdx: fakeBundle.gidToShapeIdx,
    metaFloats: fakeBundle.metaFloats,
    metaStride: fakeBundle.metaFloatsPerShape,
    border: [10, 10, 10, 10],
    worldSize: [200, 100],
    fallbackBBox: fakeBundle.globalBBox,
  });
  if (result.meshFloats.length === 12 + 54 * 12 && result.chunks[0].count === 54)
    ok('T8 fallbackBBox path (no explicit nativeBBox) rewrites against globalBBox');
  else
    fail(`T8 fallbackBBox: chunks=${JSON.stringify(result.chunks)}`);
}

// ---- T9: stroke shape (count=6 cover quad on a stroke chunk) -------
{
  // Strokes use the SAME cover-quad layout as fills — getCoverQuadMesh
  // doesn't differentiate; the meta row carries the stroke/fill
  // distinction. So buildNineSliceMesh treats a stroke chunk the same
  // way: count=6 + non-LAYER row → 9-slice.
  const strokeMeta = new Float32Array(metaStride);
  strokeMeta[14] = 1;
  strokeMeta[27] = 0;  // not LAYER / GROUP
  // Mark this as a stroke (fillAlpha=0, strokeAlpha>0, sw>0) — but
  // buildNineSliceMesh's check ignores stroke vs fill, gating only on
  // FLAG_LAYER / GROUP. So pass-through works.
  strokeMeta[7]  = 0;     // fillAlpha
  strokeMeta[11] = 1;     // strokeAlpha
  strokeMeta[12] = 2;     // sw
  const out = buildNineSliceMesh({
    meshFloats, chunks, gidToShapeIdx, metaFloats: strokeMeta, metaStride,
    border: [10, 10, 10, 10], worldSize: [200, 100],
    nativeBBox: [0, 0, 100, 50],
  });
  if (out.chunks[0].count === 54)
    ok('T9 stroke cover-quad 9-slices the same as fills (54 verts)');
  else
    fail(`T9 stroke chunk count: ${out.chunks[0].count}`);
}

if (failures > 0) {
  console.error(`\nNINE-SLICE FAIL (${failures})`);
  process.exit(1);
}
console.log('\nNINE-SLICE PASS');
