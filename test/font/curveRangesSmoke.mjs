// curveRangesSmoke.mjs — bundle.curveRangesByShape parity.
//
// Verifies that `createBundle` exposes per-shape curve-float ranges
// derived from meta texel 4 (glyphLoc), with the last shape's end
// pinned to the UNPADDED curve float count, so exact last-shape
// matching never absorbs trailing row padding.

import { createBundle } from '../../src/renderer/bundle.js';

let failures = 0;
function ok(msg)   { console.log('ok', msg); }
function fail(msg) { failures++; console.error('FAIL', msg); }

// Minimal GL2 stub — createBundle pokes textures but never reads them
// back. We don't need a full impl, just the API surface it touches.
function makeGlStub() {
  return {
    NEAREST: 9728, LINEAR: 9729, CLAMP_TO_EDGE: 33071,
    LINEAR_MIPMAP_LINEAR: 9987,
    TEXTURE_2D: 3553, TEXTURE_MIN_FILTER: 10241, TEXTURE_MAG_FILTER: 10240,
    TEXTURE_WRAP_S: 10242, TEXTURE_WRAP_T: 10243,
    RGBA32F: 34836, RGBA: 6408, FLOAT: 5126, RGBA8: 32856,
    UNSIGNED_BYTE: 5121,
    createTexture: () => ({ id: 'tex' }),
    bindTexture() {}, texParameteri() {},
    texImage2D() {}, texSubImage2D() {},
    generateMipmap() {},
    deleteTexture() {},
  };
}

const TEX_W = 4096;
const STRIDE = 48;
const META_TEXEL_4 = 16;

// Build a `sections` dict createBundle accepts. Each shape gets a
// curve texel at a specified (gx, gy). The curve buffer length is
// the unpadded float total — createBundle's row-padding shouldn't
// affect curveRangesByShape's reported `end`.
function makeSections(shapesSpec, curveFloatLen) {
  const n = shapesSpec.length;
  // Meta body (Float32) — write texel-4 glyphLoc per shape.
  const metaBody = new Float32Array(n * STRIDE);
  for (let i = 0; i < n; i++) {
    metaBody[i * STRIDE + META_TEXEL_4]     = shapesSpec[i].gx;
    metaBody[i * STRIDE + META_TEXEL_4 + 1] = shapesSpec[i].gy;
    // Fill α = 1 so anything that gates on visibility doesn't drop.
    metaBody[i * STRIDE + 7] = 1.0;
  }
  // 32-byte header (numShapes + globalBBox) + body.
  const meta = new ArrayBuffer(32 + metaBody.byteLength);
  const mdv = new DataView(meta);
  mdv.setUint32(0, n, true);
  mdv.setFloat32(4, 0, true); mdv.setFloat32(8, 0, true);
  mdv.setFloat32(12, 100, true); mdv.setFloat32(16, 100, true);
  new Uint8Array(meta, 32).set(new Uint8Array(metaBody.buffer));
  // Curves: pattern fill is irrelevant — only length matters.
  const curves = new Float32Array(curveFloatLen).buffer;
  // Bands: any non-zero size keeps createBundle happy.
  const bands = new Float32Array(16).buffer;
  return {
    flags: 0,
    metaFloatsPerShape: STRIDE,
    meta,
    curves,
    bands,
    curveGeom: null,
    gradients: null, gradientStops: null, gradientStopsCount: 0,
    dashes: null, strokeMesh: null, clipMesh: null, maskMesh: null,
    filterTab: null, imageAtlas: null, imageAtlasDim: null,
    shapeIds: shapesSpec.map((_, i) => `s${i}`),
  };
}

// === T1: empty bundle has empty ranges =============================
{
  const gl = makeGlStub();
  const b = createBundle(gl, makeSections([], 0));
  if (Array.isArray(b.curveRangesByShape) && b.curveRangesByShape.length === 0)
    ok('T1 zero-shape bundle has empty curveRangesByShape');
  else fail(`T1 ranges = ${JSON.stringify(b.curveRangesByShape)}`);
  b.dispose();
}

// === T2: single shape — end is the unpadded curve float count =====
{
  const gl = makeGlStub();
  // Curve buffer is 100 floats — far less than one row (TEX_W*4 = 16384).
  // The row-padded curve plane is one row, but curveRangesByShape's
  // `end` must be 100, not 16384.
  const b = createBundle(gl, makeSections(
    [{ gx: 0, gy: 0 }],
    100));
  const r = b.curveRangesByShape;
  if (r.length === 1 && r[0].begin === 0 && r[0].end === 100)
    ok('T2 single shape: [0, 100) (unpadded end)');
  else fail(`T2 ranges = ${JSON.stringify(r)}`);
  b.dispose();
}

// === T3: multiple shapes — end of shape i = begin of shape i+1 ====
{
  const gl = makeGlStub();
  // Three shapes at texel offsets 0, 8, 20. Curve buf length = 200.
  // Expected float ranges:
  //   shape 0: [0,  4*8  = 32)
  //   shape 1: [32, 4*20 = 80)
  //   shape 2: [80, 200)  (last shape ends at unpadded total)
  const b = createBundle(gl, makeSections(
    [{ gx: 0, gy: 0 }, { gx: 8, gy: 0 }, { gx: 20, gy: 0 }],
    200));
  const r = b.curveRangesByShape;
  if (r.length === 3) ok('T3 three shapes → three ranges');
  else fail(`T3 length = ${r.length}`);
  if (r[0].begin === 0 && r[0].end === 32) ok('T3 shape 0: [0, 32)');
  else fail(`T3 shape 0: ${JSON.stringify(r[0])}`);
  if (r[1].begin === 32 && r[1].end === 80) ok('T3 shape 1: [32, 80)');
  else fail(`T3 shape 1: ${JSON.stringify(r[1])}`);
  if (r[2].begin === 80 && r[2].end === 200) ok('T3 shape 2: [80, 200) (unpadded)');
  else fail(`T3 shape 2: ${JSON.stringify(r[2])}`);
  b.dispose();
}

// === T4: shape at row > 0 — gy * TEX_W contributes to begin =======
{
  const gl = makeGlStub();
  // Two shapes: one at row 0 col 0, one at row 1 col 0.
  // Float index of row 1 col 0 = 4 * (1 * TEX_W + 0) = 4 * TEX_W.
  const b = createBundle(gl, makeSections(
    [{ gx: 0, gy: 0 }, { gx: 0, gy: 1 }],
    /* curveFloatLen = */ 4 * TEX_W + 100));
  const r = b.curveRangesByShape;
  if (r[1].begin === 4 * TEX_W)
    ok(`T4 second-row shape begin = ${4 * TEX_W} (4 * TEX_W)`);
  else fail(`T4 shape 1 begin = ${r[1].begin}`);
  if (r[0].end === 4 * TEX_W) ok('T4 first shape ends where second begins');
  else fail(`T4 shape 0 end = ${r[0].end}`);
  if (r[1].end === 4 * TEX_W + 100) ok('T4 last shape ends at unpadded total');
  else fail(`T4 shape 1 end = ${r[1].end}`);
  b.dispose();
}

// === T5: row-padded curve plane doesn't leak into ranges ===========
{
  const gl = makeGlStub();
  // 12 unpadded floats; createBundle's curve plane will pad up to
  // 1 row = 16384 floats. The reported `end` must still be 12.
  const b = createBundle(gl, makeSections(
    [{ gx: 0, gy: 0 }],
    12));
  if (b.curveRangesByShape[0].end === 12)
    ok('T5 row-padding does not leak — end = unpadded 12');
  else fail(`T5 end = ${b.curveRangesByShape[0].end} (row padding leaked)`);
  b.dispose();
}

console.log('---');
if (failures) console.error(`CURVE-RANGES FAIL (${failures})`);
else          console.log('CURVE-RANGES PASS');
process.exit(failures ? 1 : 0);
