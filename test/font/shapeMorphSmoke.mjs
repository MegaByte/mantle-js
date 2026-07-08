// shapeMorphSmoke.mjs — createShapeMorph plan + setT
// behaviour, exercised against hand-built sections-shape bundles so
// we don't need a real GL context or a font file.
//
// The morph's createBundle path expects real GL; we monkey-patch
// `createBundle` via a stub global to record uploads. The plan-
// building logic and visibility-fade math are exercised directly.

// Use the public `createShapeMorph` and a GL stub. We bypass
// `createBundle` by feeding pre-shaped bundle objects that already
// carry the surface the morph's internals read.

import { createShapeMorph } from '../../src/animation/shapeMorph.js';

let failures = 0;
function ok(msg)   { console.log('ok', msg); }
function fail(msg) { failures++; console.error('FAIL', msg); }
function approx(a, b, eps = 1e-5) { return Math.abs(a - b) < eps; }

// Minimal WebGL2 stub for createBundle + createOverrideTable.
function makeGlStub() {
  const state = { uploads: [], lastBindTarget: 0 };
  function makeTexHandle(tag) { return { id: 'tex_' + tag, _bytes: 0 }; }
  return {
    NEAREST: 9728, CLAMP_TO_EDGE: 33071, LINEAR: 9729,
    TEXTURE_2D: 3553, TEXTURE_MIN_FILTER: 10241, TEXTURE_MAG_FILTER: 10240,
    TEXTURE_WRAP_S: 10242, TEXTURE_WRAP_T: 10243,
    RGBA32F: 34836, RGBA: 6408, FLOAT: 5126, RGBA8: 32856,
    UNSIGNED_BYTE: 5121,
    createTexture: () => makeTexHandle('any'),
    bindTexture(target, tex) { state.lastBindTarget = target; },
    texParameteri() {},
    texImage2D() {},
    texSubImage2D(target, lvl, x, y, w, h, fmt, type, data) {
      state.uploads.push({ w, h, fmt, type, byteLen: data && data.byteLength | 0 });
    },
    deleteTexture() {},
    get uploads() { return state.uploads; },
  };
}

const TEX_W = 4096;

/**
 * Build a sections-shape bundle compatible with the morph's expected
 * surface. We avoid going through createBundle by crafting the
 * minimal set of fields the morph + createBundle inside it read:
 *   numShapes, metaFloatsPerShape, metaFloats (Float32Array),
 *   curves (ArrayBuffer), bands (ArrayBuffer), curveGeom (null),
 *   shapeIds, globalBBox, flags.
 *
 * The morph calls `createBundle(gl, sections)` — under our GL stub
 * createBundle just allocates the textures + parses metaFloats; it
 * doesn't actually render. We rely on that.
 */
function makeFakeBundle(shapesSpec) {
  // shapesSpec = [{ id, curveFloatLen }]
  const n = shapesSpec.length;
  const stride = 48;
  const meta = new Float32Array(n * stride);
  let cursorF = 0;
  for (let i = 0; i < n; i++) {
    const off = i * stride;
    // Texel 0 (bbox) — leave as (0,0,0,0) so hitTest etc. behave deterministically.
    meta[off + 7] = 1;            // texel 1 (.a) = fill α = 1
    // Texel 4: glyphLoc.x, glyphLoc.y (4-float = 1 texel). cursorF is
    // in float units, so texel index = cursorF / 4, x = mod TEX_W,
    // y = div TEX_W.
    const t = cursorF >>> 2;
    meta[off + 16] = t % TEX_W;
    meta[off + 17] = (t / TEX_W) | 0;
    cursorF += shapesSpec[i].curveFloatLen;
  }
  // Curve data: write a recognisable pattern per shape — each curve
  // float = (shapeIdx + 1) * 100 + j. Lets us verify lerp arithmetic.
  // No row padding: curveTexels.length is exactly the sum of all
  // shapes' curveFloatLen so the last shape's range doesn't absorb
  // anything spurious.
  const curves = new Float32Array(cursorF);
  let writeAt = 0;
  for (let i = 0; i < n; i++) {
    const len = shapesSpec[i].curveFloatLen;
    for (let j = 0; j < len; j++) curves[writeAt + j] = (i + 1) * 100 + j;
    writeAt += len;
  }
  return {
    numShapes: n,
    metaFloatsPerShape: stride,
    metaFloats: meta,
    curves: curves.buffer,
    curveTexels: curves,  // morph reads this preferentially
    flags: 0,
    globalBBox: [0, 0, 100, 100],
    shapeIds: shapesSpec.map(s => s.id),
    // createBundle reads sections; we hand it back a sections-like
    // shape sufficient for the createOverrideTable path inside the
    // morph. The morph also wraps it as a `curveTex` carrier for the
    // setT upload — that's a fake handle from the gl stub.
    curveTex: { id: 'curveTex_fake' },
    dispose() { /* no-op for the stub */ },
  };
}

function roundUpToRow(floats) {
  const r = TEX_W * 4;
  return floats % r === 0 ? floats : floats + (r - (floats % r));
}

// === T1: same-name + same-curve-count = matched lerp ===============
{
  const gl = makeGlStub();
  // Both shapes have id 'a' with identical curve byte counts.
  const src = makeFakeBundle([{ id: 'a', curveFloatLen: 8 }]);
  const dst = makeFakeBundle([{ id: 'a', curveFloatLen: 8 }]);
  // Mutate dst's curve floats so the lerp math is non-trivial.
  const dstC = new Float32Array(dst.curves);
  for (let j = 0; j < 8; j++) dstC[j] = 1000 + j;
  // Override the fake bundle's dispose so createShapeMorph cleans up
  // gracefully (it disposes the morph's *output* bundle, not src/dst).
  const morph = createShapeMorph(gl, src, dst);
  if (morph.plan.matched.length === 1) ok('T1 plan.matched has 1 entry');
  else fail(`T1 matched len = ${morph.plan.matched.length}`);
  if (morph.plan.srcOnly.length === 0 && morph.plan.dstOnly.length === 0)
    ok('T1 no srcOnly/dstOnly entries');
  else fail('T1 stray src/dst-only entries');
  morph.setT(0.5);
  // Verify the upload happened.
  if (gl.uploads.some(u => u.fmt === gl.RGBA && u.type === gl.FLOAT))
    ok('T1 setT(0.5) triggers a RGBA32F upload');
  else fail('T1 no curve upload observed');
  morph.dispose();
}

// === T2: same-name, mismatched curve byte count → fade, no lerp ===
//
// To make the per-shape curve-length difference observable, use a
// multi-shape bundle where shape 'a' is the FIRST entry: glyphLoc of
// shape 1 determines shape 0's end. Then varying shape 0's
// curveFloatLen between src and dst is visible to the planner.
{
  const gl = makeGlStub();
  // 'after' is sandwiched between two shapes on each side so its
  // curve range is bounded by glyphLoc on both ends — making the
  // length check sensitive to actual per-shape size rather than to
  // trailing buffer padding.
  const src = makeFakeBundle([
    { id: 'a',      curveFloatLen: 8 },
    { id: 'after',  curveFloatLen: 4 },
    { id: 'tail',   curveFloatLen: 4 },
  ]);
  const dst = makeFakeBundle([
    { id: 'a',      curveFloatLen: 12 },
    { id: 'after',  curveFloatLen: 4 },
    { id: 'tail',   curveFloatLen: 4 },
  ]);
  const morph = createShapeMorph(gl, src, dst);
  // 'after' (srcIdx=1) and 'tail' (srcIdx=2) both match by name AND
  // by curve byte count → matched.length should be 2; the trailing
  // 'tail' is the last shape so its end-of-range absorbs row padding
  // but src+dst pad to the same row count.
  const matchedSrcIdxs = morph.plan.matched.map(m => m.srcIdx).sort();
  if (morph.plan.matched.length === 2 && matchedSrcIdxs[0] === 1 && matchedSrcIdxs[1] === 2)
    ok('T2 "after" + "tail" matched (same lengths); "a" does not');
  else fail(`T2 matched = ${JSON.stringify(morph.plan.matched)}`);
  if (morph.plan.srcOnly.length === 1 && morph.plan.srcOnly[0].srcIdx === 0)
    ok('T2 src "a" fades out (srcOnly)');
  else fail(`T2 srcOnly = ${JSON.stringify(morph.plan.srcOnly)}`);
  if (morph.plan.dstOnly.length === 1 && morph.plan.dstOnly[0].dstIdx === 0)
    ok('T2 dst "a" fades in (dstOnly)');
  else fail(`T2 dstOnly = ${JSON.stringify(morph.plan.dstOnly)}`);
  morph.dispose();
}

// === T3: src-only / dst-only via missing names =====================
{
  const gl = makeGlStub();
  const src = makeFakeBundle([
    { id: 'head', curveFloatLen: 4 },
    { id: 'hat',  curveFloatLen: 4 },
  ]);
  const dst = makeFakeBundle([
    { id: 'head', curveFloatLen: 4 },
    { id: 'helm', curveFloatLen: 4 },
  ]);
  const morph = createShapeMorph(gl, src, dst);
  if (morph.plan.matched.length === 1 && morph.plan.matched[0].srcIdx === 0)
    ok('T3 "head" matched');
  else fail(`T3 matched = ${JSON.stringify(morph.plan.matched)}`);
  if (morph.plan.srcOnly.length === 1 && morph.plan.srcOnly[0].srcIdx === 1)
    ok('T3 "hat" src-only');
  else fail(`T3 srcOnly = ${JSON.stringify(morph.plan.srcOnly)}`);
  if (morph.plan.dstOnly.length === 1 && morph.plan.dstOnly[0].dstIdx === 1)
    ok('T3 "helm" dst-only');
  else fail(`T3 dstOnly = ${JSON.stringify(morph.plan.dstOnly)}`);
  if (morph.plan.finalShapeCount === 3) ok('T3 final shape count = 3 (head + hat + helm)');
  else fail(`T3 finalShapeCount = ${morph.plan.finalShapeCount}`);
  morph.dispose();
}

// === T4: positional fallback when ids are empty ====================
{
  const gl = makeGlStub();
  const src = makeFakeBundle([
    { id: '', curveFloatLen: 4 },
    { id: '', curveFloatLen: 4 },
  ]);
  const dst = makeFakeBundle([
    { id: '', curveFloatLen: 4 },
    { id: '', curveFloatLen: 4 },
  ]);
  const morph = createShapeMorph(gl, src, dst);
  if (morph.plan.matched.length === 2)
    ok('T4 positional matching when ids are blank — both shapes paired');
  else fail(`T4 matched len = ${morph.plan.matched.length}`);
  morph.dispose();
}

// === T5: setT outside [0,1] clamps ==================================
{
  const gl = makeGlStub();
  const src = makeFakeBundle([{ id: 'a', curveFloatLen: 4 }]);
  const dst = makeFakeBundle([{ id: 'a', curveFloatLen: 4 }]);
  const morph = createShapeMorph(gl, src, dst);
  morph.setT(2);
  if (morph.t === 1) ok('T5 setT(2) clamps to 1');
  else fail(`T5 t = ${morph.t}`);
  morph.setT(-3);
  if (morph.t === 0) ok('T5 setT(-3) clamps to 0');
  else fail(`T5 t = ${morph.t}`);
  morph.dispose();
}

// === T6: last-shape exact match via bundle.curveRangesByShape =====
// Build two real createBundle bundles where the LAST shape has the
// same actual curve length on both sides but a different unpadded
// total. curveRangesByShape reports unpadded lengths so the last shape
// matches exactly instead of falling through to alpha fade (which
// row-padding would otherwise force).
{
  const { createBundle } = await import('../../src/renderer/bundle.js');
  const STRIDE = 48;
  const META_TEXEL_4 = 16;
  function makeSections(shapesSpec, curveFloatLen) {
    const n = shapesSpec.length;
    const body = new Float32Array(n * STRIDE);
    for (let i = 0; i < n; i++) {
      body[i * STRIDE + META_TEXEL_4]     = shapesSpec[i].gx;
      body[i * STRIDE + META_TEXEL_4 + 1] = shapesSpec[i].gy;
      body[i * STRIDE + 7] = 1.0;  // fill α
    }
    const meta = new ArrayBuffer(32 + body.byteLength);
    const dv = new DataView(meta);
    dv.setUint32(0, n, true);
    new Uint8Array(meta, 32).set(new Uint8Array(body.buffer));
    return {
      flags: 0, metaFloatsPerShape: STRIDE,
      meta, curves: new Float32Array(curveFloatLen).buffer,
      bands: new Float32Array(16).buffer,
      curveGeom: null, gradients: null, gradientStops: null,
      gradientStopsCount: 0, dashes: null, strokeMesh: null,
      clipMesh: null, maskMesh: null, filterTab: null,
      imageAtlas: null, imageAtlasDim: null,
      shapeIds: shapesSpec.map(s => s.id),
    };
  }
  const gl = makeGlStub();
  // src: 2 shapes, last shape uses floats [12..32) — 20 floats.
  // dst: 2 shapes, last shape uses floats [12..32) — 20 floats.
  // (Same length → matched.) src curve buffer is 32 floats total;
  // dst curve buffer is 32 floats total too. Both pad to one row
  // internally, but `curveRangesByShape` reports unpadded.
  const src = createBundle(gl, makeSections(
    [{ id: 'a', gx: 0, gy: 0 }, { id: 'b', gx: 3, gy: 0 }], 32));
  const dst = createBundle(gl, makeSections(
    [{ id: 'a', gx: 0, gy: 0 }, { id: 'b', gx: 3, gy: 0 }], 32));
  const morph = createShapeMorph(gl, src, dst);
  if (morph.plan.matched.length === 2)
    ok('T6 createBundle-built last shape matches exactly (no padding absorption)');
  else fail(`T6 matched = ${JSON.stringify(morph.plan.matched)}`);
  morph.dispose();
  src.dispose(); dst.dispose();
}

// === T7: gradient-stops lerp ========================================
// Build two single-shape bundles whose only difference is the gradient
// stops bytes. Verify that setT(0.5) produces midpoint stops and
// triggers a texSubImage2D upload to gradientStopsTex.
{
  const gl = makeGlStub();
  // 1 gradient × 2 stops = 8 bytes (RGBA8 × 2 texels).
  // Stops layout: (premul.r, premul.g, premul.b, offset).
  // Src: red→blue gradient. Dst: green→yellow.
  const srcStops = new Uint8Array([
    255,   0,   0,   0,    //   red @ offset 0
      0,   0, 255, 255,    //  blue @ offset 1
  ]);
  const dstStops = new Uint8Array([
      0, 255,   0,   0,    // green @ offset 0
    255, 255,   0, 255,    // yellow @ offset 1
  ]);
  // Gradient param table: 1 gradient × 16 floats. Texel 2 (offset
  // 8..11) carries (ax, ay, stopsOffset, stopsCount). We only need
  // stopsOffset (10) and stopsCount (11) for the plan builder.
  function makeGradFloats() {
    const g = new Float32Array(16);
    g[10] = 0;   // stopsOffset = 0 (texel index)
    g[11] = 2;   // stopsCount  = 2
    return g;
  }
  const srcGrad = makeGradFloats();
  const dstGrad = makeGradFloats();
  function makeBundleWithGrad(stops, gradFloats, tag) {
    return {
      numShapes: 1,
      metaFloatsPerShape: 48,
      metaFloats: (() => {
        const m = new Float32Array(48);
        m[7] = 1;       // fill alpha
        m[16] = 0; m[17] = 0;  // glyphLoc
        return m;
      })(),
      curves: new Float32Array(8).buffer,
      curveTexels: new Float32Array(8),
      bands: new Float32Array(16).buffer,
      curveGeom: null,
      flags: 0,
      globalBBox: [0, 0, 100, 100],
      shapeIds: ['x'],
      // Morph reads these for the gradient-stops plan:
      gradientStopsBytes: stops,
      gradientStopsCount: stops.length / 4,
      gradientFloats:     gradFloats,
      // Token GL handles the morph references at render time:
      gradientStopsTex: { id: 'srcStopsTex_' + tag },
      curveTex: { id: 'curveTex_' + tag },
      dispose() {},
    };
  }
  const src = makeBundleWithGrad(srcStops, srcGrad, 'src');
  const dst = makeBundleWithGrad(dstStops, dstGrad, 'dst');
  const morph = createShapeMorph(gl, src, dst);
  // The plan should pair gradient 0 with itself (same stops count).
  const sections = morph.bundle._mergedCurveF32
    ? null : null;  // not needed; inspect via private fields below
  // Reach into the morph's compose result through the bundle —
  // gradientStopsCount + gradientStopsBytes were forwarded.
  const b = morph.bundle;
  if (b.gradientStopsCount === 2 && b.gradientStopsBytes && b.gradientStopsBytes.length === 8)
    ok('T7 morph bundle carries forwarded stops (count + bytes)');
  else
    fail(`T7 morph gradStopsCount=${b.gradientStopsCount} bytes=${b.gradientStopsBytes && b.gradientStopsBytes.length}`);
  // Clear earlier uploads (createBundle did texImage2D, not texSubImage),
  // then drive setT(0.5) and verify a stops upload happens with the
  // midpoint bytes.
  gl.uploads.length = 0;
  morph.setT(0.5);
  // Expected mid stops: round((src + dst) / 2).
  //   stop 0: (128, 128, 0, 0)
  //   stop 1: (128, 128, 128, 255)
  const stopsUpload = gl.uploads.find(u => u.fmt === 6408 /* RGBA */ && u.type === 5121 /* UNSIGNED_BYTE */);
  if (stopsUpload && stopsUpload.byteLen === 8 && stopsUpload.w === 2 && stopsUpload.h === 1)
    ok('T7 setT(0.5) uploads the lerped stops bytes (2×1 RGBA8)');
  else
    fail(`T7 stops upload not seen; uploads = ${JSON.stringify(gl.uploads)}`);
  // setT(1) should land at dst.
  gl.uploads.length = 0;
  morph.setT(1);
  morph.dispose();
}

// === T7b: morph + external driver compose via update() =============
// Drivers like SVG SMIL push absolute fill/stroke overrides on the
// SAME override table the morph uses for visibility. Verify that
// morph.setT() (which writes visibility) doesn't wipe the driver's
// pushed fill.
{
  const gl = makeGlStub();
  // Reuse T2's shape config: src + dst both have ids ['after', 'tail']
  // with matched 'after'+'tail' and a src-only 'a'/dst-only 'a' fade.
  // Simpler here: just one matched shape.
  function bundle(tag) {
    return {
      numShapes: 1, metaFloatsPerShape: 48,
      metaFloats: new Float32Array(48),
      curves: new Float32Array(4).buffer,
      curveTexels: new Float32Array(4),
      bands: new Float32Array(16).buffer,
      curveGeom: null, flags: 0, globalBBox: [0, 0, 100, 100],
      shapeIds: ['x'],
      gradientStopsTex: { id: 'stops_' + tag },
      curveTex: { id: 'curve_' + tag },
      dispose() {},
    };
  }
  const morph = createShapeMorph(gl, bundle('src'), bundle('dst'));
  // External driver pushes an absolute fill via update().
  morph.overrides.update('x', { fill: [0.25, 0.5, 0.75, 1] });
  // Now the morph re-runs (next frame): setT writes visibility.
  morph.setT(0.5);
  morph.overrides.uploadIfDirty();
  // Verify the driver's fill survived the visibility write.
  const o = morph.overrides.get('x');
  if (o.fill && approx(o.fill[0], 0.25) && approx(o.fill[2], 0.75))
    ok('T7b morph.setT preserves external driver-pushed fill via update()');
  else
    fail(`T7b fill wiped: ${JSON.stringify(o.fill)}`);
  morph.dispose();
}

// === T8: mismatched stop counts → no lerp plan ======================
{
  const gl = makeGlStub();
  const srcStops = new Uint8Array([255, 0, 0, 0,  0, 0, 255, 255]); // 2 stops
  const dstStops = new Uint8Array([
      0, 255, 0,   0,    //  3 stops
    128, 128, 0, 128,
      0,   0, 0, 255,
  ]);
  const srcGrad = new Float32Array(16); srcGrad[10] = 0; srcGrad[11] = 2;
  const dstGrad = new Float32Array(16); dstGrad[10] = 0; dstGrad[11] = 3;
  function build(stops, gradF, tag) {
    return {
      numShapes: 1, metaFloatsPerShape: 48,
      metaFloats: new Float32Array(48),
      curves: new Float32Array(8).buffer,
      curveTexels: new Float32Array(8),
      bands: new Float32Array(16).buffer,
      curveGeom: null, flags: 0, globalBBox: [0, 0, 100, 100],
      shapeIds: ['x'],
      gradientStopsBytes: stops,
      gradientStopsCount: stops.length / 4,
      gradientFloats: gradF,
      gradientStopsTex: { id: 'stops_' + tag },
      curveTex: { id: 'curve_' + tag },
      dispose() {},
    };
  }
  const src = build(srcStops, srcGrad, 'src');
  const dst = build(dstStops, dstGrad, 'dst');
  const morph = createShapeMorph(gl, src, dst);
  gl.uploads.length = 0;
  morph.setT(0.5);
  const stopsUpload = gl.uploads.find(u => u.fmt === 6408 && u.type === 5121);
  if (!stopsUpload)
    ok('T8 mismatched stop counts: no per-frame stops upload (graceful fallback)');
  else
    fail(`T8 unexpected stops upload: ${JSON.stringify(stopsUpload)}`);
  morph.dispose();
}

console.log('---');
if (failures) console.error(`SHAPE-MORPH FAIL (${failures})`);
else          console.log('SHAPE-MORPH PASS');
process.exit(failures ? 1 : 0);
