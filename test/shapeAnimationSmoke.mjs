// Verifies the 5 animation primitives in shapeAnimation.js without WebGL.
//
// The math is CPU-side; a fake `gl` records texSubImage2D calls and
// collects the uploaded Float32Array data into a capture buffer, then
// the expected per-vertex output is checked.

import {
  createShapeTimeline,
  createSpatialBezierMorph,
  createPathDeltaMorph,
  createSkinnedMorph,
  createPoseStack,
} from '../src/animation/shapeAnimation.js';

let failures = 0;
function ok(msg)   { console.log('ok', msg); }
function fail(msg) { failures++; console.error('FAIL', msg); }
function approx(a, b, eps = 1e-5) { return Math.abs(a - b) < eps; }

// ────────────────────────────────────────────────────────────────
// Fake GL — captures the last uploaded Float32Array.
// ────────────────────────────────────────────────────────────────
function makeFakeGL() {
  const fake = {
    TEXTURE_2D: 1, RGBA: 2, FLOAT: 3, UNSIGNED_BYTE: 4, RGBA32F: 5,
    TEXTURE_MIN_FILTER: 6, TEXTURE_MAG_FILTER: 7, TEXTURE_WRAP_S: 8, TEXTURE_WRAP_T: 9,
    NEAREST: 10, CLAMP_TO_EDGE: 11,
    _lastUpload: null,
    _lastUploadDims: null,
    _boundTex: null,
    _uploadsByTex: new Map(),     // last upload keyed by bound texture object
    bindTexture(target, tex) { fake._boundTex = tex; },
    texImage2D()     {},
    texParameteri()  {},
    texSubImage2D(target, level, xOff, yOff, w, h, fmt, type, data) {
      // Guard the WebGL2 invariant real drivers enforce: the source must
      // hold at least w*h*4 elements (RGBA), else the call would throw
      // INVALID_OPERATION. Catches under-padded curve-plane uploads that
      // a permissive fake GL would otherwise let slide.
      if (data && data.length != null && data.length < w * h * 4) {
        throw new Error(
          `texSubImage2D: not enough data for ${w}x${h} (have ${data.length}, need ${w * h * 4})`);
      }
      // Capture a copy of the data — subsequent setT calls reuse the
      // scratch buffer, so we can't keep a live reference.
      let copy = null;
      if (data && data.constructor === Float32Array) copy = new Float32Array(data);
      else if (data && data.constructor === Uint8Array) copy = new Uint8Array(data);
      fake._lastUpload = copy;
      fake._lastUploadDims = [w, h];
      // Also record by texture so the test can grab the curve upload
      // specifically, even if meta / gradient uploads happen later in
      // the same setT.
      if (fake._boundTex && copy) fake._uploadsByTex.set(fake._boundTex, copy);
    },
    createTexture() { return { _id: 'tex' }; },
    deleteTexture() {},
    pixelStorei()   {},
    // Stubs for the remaining GL calls the morph/override constructors touch.
    activeTexture() {}, useProgram() {}, uniform1i() {},
    uniform1f() {}, uniform2f() {}, uniform4f() {},
    bindFramebuffer() {}, deleteFramebuffer() {}, createFramebuffer() { return { _id:'fb' }; },
    framebufferTexture2D() {}, checkFramebufferStatus() { return 0x8CD5; /*FRAMEBUFFER_COMPLETE*/ },
    FRAMEBUFFER: 0, FRAMEBUFFER_COMPLETE: 0x8CD5, COLOR_ATTACHMENT0: 0,
  };
  return fake;
}

// ────────────────────────────────────────────────────────────────
// Fake bundle factory.
// Produces a minimal bundle dict that satisfies the primitives'
// expectations:  curveFloats + curveTex + numShapes + shapeIds +
// metaFloats + globalBBox.
// ────────────────────────────────────────────────────────────────
let _fakeTexCtr = 0;
function fakeBundle(curveFloats, numShapes = 1, ids = ['s0']) {
  const stride = 48;
  const meta = new Float32Array(numShapes * stride);
  // texel 4 (offsets 16..17): glyphLoc.x, glyphLoc.y → start at (0,0)
  // for shape 0; (TEX_W=4096, so a single curve buffer of length
  // ≤ 4096*4 lands entirely on row 0).
  for (let s = 0; s < numShapes; s++) {
    meta[s * stride + 16] = 0;   // glyphLoc.x
    meta[s * stride + 17] = 0;   // glyphLoc.y
  }
  return {
    numShapes,
    shapeIds: ids,
    metaFloats: meta,
    metaFloatsPerShape: stride,
    globalBBox: [0, 0, 100, 100],
    curveFloats,
    curveTex: { _id: `curveTex-${++_fakeTexCtr}` },
    metaTex:  { _id: `metaTex-${++_fakeTexCtr}` },
    flags: 0,
    gradientFloats: null,
    gradientStopsBytes: null,
    gradientStopsCount: 0,
    curveRangesByShape: [{ begin: 0, end: curveFloats.length }],
  };
}

// ────────────────────────────────────────────────────────────────
// 1) ShapeTimeline — bracket selection + cubic Bezier easing
// ────────────────────────────────────────────────────────────────
// Helper: grab the curve-texture upload from a morph's bundle.
function curveUploadFor(gl, morphLike) {
  // morphLike may be a timeline (with currentMorph) or a direct morph.
  const morph = morphLike.currentMorph || morphLike;
  const tex = morph && morph.bundle && morph.bundle.curveTex;
  return tex ? gl._uploadsByTex.get(tex) : null;
}

(() => {
  const gl = makeFakeGL();
  // Two-pose timeline. Both bundles same length so curves can lerp.
  const bA = fakeBundle(new Float32Array([0, 0, 1, 0]));
  const bB = fakeBundle(new Float32Array([10, 10, 11, 10]));
  const tl = createShapeTimeline(gl, [bA, bB], [
    { time: 0, bundleIndex: 0, interp: 'linear' },
    { time: 1, bundleIndex: 1, interp: 'linear' },
  ]);
  if (tl.duration !== 1) fail(`timeline duration: expected 1 got ${tl.duration}`);
  tl.setTime(0.5);
  // Expect upload — content lerped to halfway between (0,0,1,0) and (10,10,11,10).
  const buf = curveUploadFor(gl, tl);
  if (!buf) fail(`timeline: no curve upload happened at setTime(0.5)`);
  else if (!approx(buf[0], 5) || !approx(buf[1], 5) || !approx(buf[2], 6) || !approx(buf[3], 5))
    fail(`timeline: lerp at t=0.5 incorrect [${Array.from(buf).slice(0,4)}]`);
  else ok('shapeTimeline 2-key linear: midpoint at t=0.5 lerps correctly');
  tl.dispose();
})();

(() => {
  // 3-key timeline + cubicBezier between key 1 and 2.
  // Sanity: ease-in at midpoint should produce localT < 0.5 → output
  // closer to keys[1] than to keys[2].
  const gl = makeFakeGL();
  const b0 = fakeBundle(new Float32Array([0, 0]));
  const b1 = fakeBundle(new Float32Array([5, 5]));
  const b2 = fakeBundle(new Float32Array([10, 10]));
  const tl = createShapeTimeline(gl, [b0, b1, b2], [
    { time: 0, bundleIndex: 0, interp: 'linear' },
    { time: 1, bundleIndex: 1, interp: 'cubicBezier', outX: 0.5, outY: 0, inX: 1, inY: 0.5 },
    { time: 2, bundleIndex: 2, interp: 'linear' },
  ]);
  // At time=1.5, localT raw = 0.5. The easing curve (outX=0.5, outY=0,
  // inX=1, inY=0.5) is a classic ease-in shape — it maps localT=0.5
  // through x→t→y to a value < 0.5 (slow start, fast end). So the
  // output should be strictly less than the linear midpoint (7.5):
  // somewhere between 5 (key 1 value) and the linear midpoint, with
  // the eased fraction in roughly [0.1, 0.4].
  tl.setTime(1.5);
  const buf = curveUploadFor(gl, tl);
  const v = buf ? buf[0] : NaN;
  if (!buf) fail(`timeline cubic: no upload at setTime(1.5)`);
  else if (!(v > 5 && v < 7.5))
    fail(`timeline cubicBezier ease-in: expected ∈(5, 7.5) got ${v}`);
  else ok(`shapeTimeline cubicBezier ease-in: t=1.5 → ${v.toFixed(4)} (between key value 5 and linear midpoint 7.5)`);
  tl.dispose();
})();

(() => {
  // Hold (step) interpolator: t in [1, 2) should produce the lo-key value.
  const gl = makeFakeGL();
  const b0 = fakeBundle(new Float32Array([1, 2]));
  const b1 = fakeBundle(new Float32Array([10, 20]));
  const tl = createShapeTimeline(gl, [b0, b1], [
    { time: 0, bundleIndex: 0, interp: 'hold' },
    { time: 1, bundleIndex: 1, interp: 'linear' },
  ]);
  tl.setTime(0.5);
  const buf = curveUploadFor(gl, tl);
  if (!buf) fail(`timeline hold: no upload`);
  else if (!approx(buf[0], 1) || !approx(buf[1], 2))
    fail(`timeline hold: should snap to lo-key (1,2), got (${buf[0]}, ${buf[1]})`);
  else ok('shapeTimeline hold: t=0.5 snaps to lo-key value');
  tl.dispose();
})();

// ────────────────────────────────────────────────────────────────
// 2) Spatial Bezier morph
// ────────────────────────────────────────────────────────────────
(() => {
  const gl = makeFakeGL();
  // Single 2D vertex: src=(0,0), dst=(10,0). Without tangents this
  // is a straight horizontal segment.
  const bA = fakeBundle(new Float32Array([0, 0]));
  const bB = fakeBundle(new Float32Array([10, 0]));
  // outTan = (0, +5) → vertex bows upward leaving src.
  // inTan  = (0, +5) → vertex bows upward arriving at dst (negated
  //         in the Bezier eval: P2 = dst - inTan = (10, -5)).
  const out = new Float32Array([0, 5]);
  const ino = new Float32Array([0, 5]);
  const m = createSpatialBezierMorph(gl, bA, bB, { outTan: out, inTan: ino });
  m.setT(0.5);
  const buf = gl._lastUpload;
  if (!buf) fail(`spatialBezier: no upload`);
  else if (!approx(buf[0], 5, 1e-3)) fail(`spatialBezier midpoint x should be 5, got ${buf[0]}`);
  else ok(`spatialBezier: midpoint at t=0.5 lies at x=${buf[0].toFixed(3)}, y=${buf[1].toFixed(3)} (curved trajectory)`);
  // Endpoints stay anchored.
  m.setT(0);
  if (!approx(gl._lastUpload[0], 0) || !approx(gl._lastUpload[1], 0))
    fail(`spatialBezier t=0: expected (0,0), got (${gl._lastUpload[0]}, ${gl._lastUpload[1]})`);
  else ok('spatialBezier t=0: anchored at src (0,0)');
  m.setT(1);
  if (!approx(gl._lastUpload[0], 10) || !approx(gl._lastUpload[1], 0))
    fail(`spatialBezier t=1: expected (10,0), got (${gl._lastUpload[0]}, ${gl._lastUpload[1]})`);
  else ok('spatialBezier t=1: anchored at dst (10,0)');
  m.dispose();
})();

// ────────────────────────────────────────────────────────────────
// 3) Path delta morph
// ────────────────────────────────────────────────────────────────
(() => {
  const gl = makeFakeGL();
  const base = fakeBundle(new Float32Array([1, 1, 2, 2]));
  // Two keyframes: rest + offset by (10, 10).
  const d0 = { time: 0, vertexDeltas: new Float32Array([0, 0, 0, 0]) };
  const d1 = { time: 1, vertexDeltas: new Float32Array([10, 10, 10, 10]) };
  const pdm = createPathDeltaMorph(gl, base, [d0, d1]);
  pdm.setTime(0.5);
  const buf = gl._lastUpload;
  if (!buf) fail(`pathDelta: no upload`);
  else if (!approx(buf[0], 6) || !approx(buf[1], 6) || !approx(buf[2], 7) || !approx(buf[3], 7))
    fail(`pathDelta @ 0.5: expected (6,6,7,7), got (${buf[0]},${buf[1]},${buf[2]},${buf[3]})`);
  else ok('pathDelta morph: base + half-delta at time=0.5');
  // t=0 → base only.
  pdm.setTime(0);
  if (!approx(gl._lastUpload[0], 1)) fail(`pathDelta t=0: expected base[0]=1, got ${gl._lastUpload[0]}`);
  else ok('pathDelta t=0: equals base pose');
  pdm.dispose();
})();

// ────────────────────────────────────────────────────────────────
// 4) Skinned morph
// ────────────────────────────────────────────────────────────────
(() => {
  const gl = makeFakeGL();
  // 2 vertices: (1, 0), (0, 1). Both fully weighted to bone 0.
  const base = fakeBundle(new Float32Array([1, 0, 0, 1]));
  const sk = createSkinnedMorph(gl, base, [
    [{ boneId: 0, weight: 1 }],
    [{ boneId: 0, weight: 1 }],
  ]);
  if (sk.numVertices !== 2) fail(`skinned: vertex count should be 2, got ${sk.numVertices}`);
  // Bone 0 identity matrix [1,0,0,1,0,0] → vertices unchanged.
  const idMat = new Float32Array([1, 0, 0, 1, 0, 0]);
  sk.setBoneMatrices(idMat);
  const buf = gl._lastUpload;
  if (!buf) fail(`skinned: no upload`);
  else if (!approx(buf[0], 1) || !approx(buf[1], 0) || !approx(buf[2], 0) || !approx(buf[3], 1))
    fail(`skinned identity: expected (1,0,0,1), got [${Array.from(buf).slice(0,4)}]`);
  else ok('skinned identity bone matrix: vertices unchanged');
  // Translation matrix [1,0,0,1, 5,5] → all verts +5,+5.
  sk.setBoneMatrices(new Float32Array([1, 0, 0, 1, 5, 5]));
  const b2 = gl._lastUpload;
  if (!approx(b2[0], 6) || !approx(b2[1], 5) || !approx(b2[2], 5) || !approx(b2[3], 6))
    fail(`skinned translate (5,5): got [${Array.from(b2).slice(0,4)}], expected (6,5,5,6)`);
  else ok('skinned translate (+5,+5): verts shift by translation');
  // Two bones with split weight → average.
  // (1,0) skinned to bone 0 (translate +10,+0, weight 0.5) and bone 1 (translate +0,+10, weight 0.5)
  //   → 0.5*(11,0) + 0.5*(1,10) = (6, 5).
  const sk2 = createSkinnedMorph(gl, base, [
    [{ boneId: 0, weight: 0.5 }, { boneId: 1, weight: 0.5 }],
    [{ boneId: 0, weight: 1.0 }],
  ]);
  sk2.setBoneMatrices(new Float32Array([
    1, 0, 0, 1, 10, 0,   // bone 0: translate (+10, 0)
    1, 0, 0, 1,  0, 10,  // bone 1: translate (0, +10)
  ]));
  const b3 = gl._lastUpload;
  if (!approx(b3[0], 6) || !approx(b3[1], 5))
    fail(`skinned 2-bone split: vert 0 expected (6,5), got (${b3[0]}, ${b3[1]})`);
  else ok(`skinned 2-bone 50/50 split: vert 0 → (${b3[0]}, ${b3[1]})`);
  sk.dispose(); sk2.dispose();
})();

// ────────────────────────────────────────────────────────────────
// 5) Pose stack
// ────────────────────────────────────────────────────────────────
(() => {
  const gl = makeFakeGL();
  const bA = fakeBundle(new Float32Array([0, 0]), 1, ['s0']);
  const bB = fakeBundle(new Float32Array([10, 0]), 1, ['s0']);
  const bC = fakeBundle(new Float32Array([0, 10]), 1, ['s0']);
  const ps = createPoseStack(gl, [bA, bB, bC]);
  // Pure A↔B at tAB=0.5, tBC=0 — should be (5, 0). This hits the
  // fast path which uses the cached morphAB.
  ps.setState({ a: 0, b: 1, c: 0, tAB: 0.5, tBC: 0 });
  // The pose stack's bundle is the inner morph's bundle.
  const buf = gl._uploadsByTex.get(ps.bundle.curveTex);
  if (!buf) fail(`poseStack 2-pose: no curve upload`);
  else if (!approx(buf[0], 5) || !approx(buf[1], 0))
    fail(`poseStack 2-pose A→B@0.5: expected (5,0), got (${buf[0]}, ${buf[1]})`);
  else ok('poseStack 2-pose path: tBC=0 collapses to A↔B lerp');
  // 3-pose: A↔B at 0.5, then result↔C at 0.5.
  // A↔B@0.5 = (5, 0); blend toward C=(0,10) at 0.5 = (2.5, 5).
  ps.setState({ a: 0, b: 1, c: 2, tAB: 0.5, tBC: 0.5 });
  const buf2 = gl._uploadsByTex.get(ps.bundle.curveTex);
  if (!buf2) fail(`poseStack 3-pose: no curve upload`);
  else if (!approx(buf2[0], 2.5) || !approx(buf2[1], 5))
    fail(`poseStack 3-pose: expected (2.5, 5), got (${buf2[0]}, ${buf2[1]})`);
  else ok(`poseStack 3-pose blend: A↔B@0.5↔C@0.5 → (${buf2[0]}, ${buf2[1]})`);
  ps.dispose();
})();

if (failures === 0) console.log('\nSHAPE-ANIMATION PASS');
else { console.error(`\nSHAPE-ANIMATION FAIL (${failures})`); process.exit(1); }
