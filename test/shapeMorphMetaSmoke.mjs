// Verifies createShapeMorph's lerps:
//   • meta-plane lerp (fill/stroke colors + strokeWidth + bbox + imageRect)
//   • gradient param-texel lerp (transform matrix + focal point + axis)
//   • stop-byte lerp covers stop POSITIONS (offset byte)
//
// Headless: fakes the WebGL context, captures texSubImage2D uploads, and
// checks the lerp math directly against the captured Float32Array /
// Uint8Array contents.

import { createShapeMorph } from '../src/animation/shapeMorph.js';

let failures = 0;
function ok(msg)   { console.log('ok', msg); }
function fail(msg) { failures++; console.error('FAIL', msg); }
function approx(a, b, eps = 1e-4) { return Math.abs(a - b) < eps; }

// ────────────────────────────────────────────────────────────────
// Fake GL — captures texSubImage2D uploads keyed by bound texture.
// ────────────────────────────────────────────────────────────────
let _texCtr = 0;
function makeFakeGL() {
  const fake = {
    TEXTURE_2D: 1, RGBA: 2, FLOAT: 3, UNSIGNED_BYTE: 4, RGBA32F: 5, RGBA8: 6,
    TEXTURE_MIN_FILTER: 6, TEXTURE_MAG_FILTER: 7, TEXTURE_WRAP_S: 8, TEXTURE_WRAP_T: 9,
    NEAREST: 10, CLAMP_TO_EDGE: 11, LINEAR: 12,
    _boundTex: null,
    _uploadsByTex: new Map(),
    bindTexture(target, tex) { fake._boundTex = tex; },
    texImage2D() {},
    texParameteri() {},
    texSubImage2D(target, level, xOff, yOff, w, h, fmt, type, data) {
      if (!fake._boundTex || !data) return;
      let copy = null;
      if (data.constructor === Float32Array) copy = new Float32Array(data);
      else if (data.constructor === Uint8Array) copy = new Uint8Array(data);
      if (copy) fake._uploadsByTex.set(fake._boundTex, copy);
    },
    createTexture() { return { _id: `tex-${++_texCtr}` }; },
    deleteTexture() {}, pixelStorei() {}, activeTexture() {}, useProgram() {},
    uniform1i() {}, uniform1f() {}, uniform2f() {}, uniform4f() {},
    bindFramebuffer() {}, deleteFramebuffer() {}, createFramebuffer() { return { _id: 'fb' }; },
    framebufferTexture2D() {}, checkFramebufferStatus() { return 0x8CD5; },
    FRAMEBUFFER: 0, FRAMEBUFFER_COMPLETE: 0x8CD5, COLOR_ATTACHMENT0: 0,
  };
  return fake;
}

// Build a fake src/dst bundle pair with matched topology so the
// curve / meta / gradient lerps all engage. Both bundles have 1 shape
// (curve = a unit square's 4-point list) and 1 linear gradient. The
// caller can override meta values + gradient params for the dst pose.
const FULL_META_W = 12;
function fakeBundle(opts = {}) {
  const stride = FULL_META_W * 4;   // 48 floats per shape
  const numShapes = 1;
  const meta = new Float32Array(numShapes * stride);
  // Pre-populate with sensible defaults — bbox + fillColor + strokeColor + sw + imageRect.
  // (texel 0: bbox)
  meta[0] = opts.bbox?.[0] ?? 0;  meta[1] = opts.bbox?.[1] ?? 0;
  meta[2] = opts.bbox?.[2] ?? 10; meta[3] = opts.bbox?.[3] ?? 10;
  // (texel 1: fillColor RGBA)
  const fc = opts.fillColor ?? [1, 0, 0, 1];
  meta[4] = fc[0]; meta[5] = fc[1]; meta[6] = fc[2]; meta[7] = fc[3];
  // (texel 2: strokeColor RGBA)
  const sc = opts.strokeColor ?? [0, 1, 0, 1];
  meta[8] = sc[0]; meta[9] = sc[1]; meta[10] = sc[2]; meta[11] = sc[3];
  // (texel 3: strokeWidth)
  meta[12] = opts.strokeWidth ?? 1;
  // texel 4: glyphLoc → (0, 0)
  meta[16] = 0; meta[17] = 0;
  // texel 9: imageRect (offsets 36..39)
  const ir = opts.imageRect ?? [0, 0, 0, 0];
  meta[36] = ir[0]; meta[37] = ir[1]; meta[38] = ir[2]; meta[39] = ir[3];
  // Gradient: 16 floats per gradient = 1 RGBA32F record × 4 texels.
  // Layout: [type, spread, units, fyFrac, ia, ib, ic, id, ie, if,
  //          stopsOffset, stopsCount, x1, y1, x2, y2]   (linear)
  const gradFloats = new Float32Array(16);
  gradFloats[0] = 0;     // type = LINEAR
  gradFloats[1] = 0;     // spread = PAD
  gradFloats[2] = 0;     // units
  // gradient_transform inverse (identity by default)
  gradFloats[4] = 1; gradFloats[5] = 0; gradFloats[6] = 0; gradFloats[7] = 1;
  gradFloats[8] = 0; gradFloats[9] = 0;
  gradFloats[10] = 0; gradFloats[11] = 2;   // stopsOffset, stopsCount=2
  const ax = opts.axis ?? [0, 0, 10, 0];
  gradFloats[12] = ax[0]; gradFloats[13] = ax[1]; gradFloats[14] = ax[2]; gradFloats[15] = ax[3];
  if (opts.transformInv) {
    gradFloats[4] = opts.transformInv[0]; gradFloats[5] = opts.transformInv[1];
    gradFloats[6] = opts.transformInv[2]; gradFloats[7] = opts.transformInv[3];
    gradFloats[8] = opts.transformInv[4]; gradFloats[9] = opts.transformInv[5];
  }
  // Two stops: red→blue (premultiplied), offsets 0 and 255.
  const stopsBytes = new Uint8Array(opts.stops ?? [
    255, 0, 0, 0,
    0, 0, 255, 255,
  ]);
  // Curve floats — minimal (4 floats = a single line endpoint pair).
  const curveFloats = new Float32Array(opts.curves ?? [0, 0, 1, 0]);
  return {
    numShapes,
    shapeIds: [opts.id ?? 's0'],
    metaFloats: meta,
    metaFloatsPerShape: stride,
    globalBBox: [0, 0, 100, 100],
    curveFloats,
    curveTex: { _id: `curveTex-${++_texCtr}` },
    metaTex:  { _id: `metaTex-${++_texCtr}` },
    gradientTex:      { _id: `gradTex-${++_texCtr}` },
    gradientStopsTex: { _id: `gradStops-${++_texCtr}` },
    gradientFloats:     gradFloats,
    gradientStopsBytes: stopsBytes,
    gradientStopsCount: stopsBytes.length / 4,
    flags: 0,
    curveRangesByShape: [{ begin: 0, end: curveFloats.length }],
  };
}

// Pull the upload that landed on a specific texture object.
function uploadFor(gl, tex) {
  return tex ? gl._uploadsByTex.get(tex) : null;
}

// ────────────────────────────────────────────────────────────────
// 1) Meta-plane lerp
// ────────────────────────────────────────────────────────────────

(() => {
  // src has red fill, dst has blue fill. At t=0.5 → (0.5, 0, 0.5, 1).
  const gl = makeFakeGL();
  const src = fakeBundle({ fillColor: [1, 0, 0, 1] });
  const dst = fakeBundle({ fillColor: [0, 0, 1, 1] });
  const morph = createShapeMorph(gl, src, dst);
  morph.setT(0.5);
  const meta = uploadFor(gl, morph.bundle.metaTex);
  if (!meta) fail(`metaTex upload missing at t=0.5`);
  else {
    const r = meta[4], g = meta[5], b = meta[6], a = meta[7];
    if (!approx(r, 0.5) || !approx(g, 0) || !approx(b, 0.5) || !approx(a, 1))
      fail(`fillColor lerp t=0.5: expected (0.5, 0, 0.5, 1), got (${r}, ${g}, ${b}, ${a})`);
    else ok(`meta fillColor lerp: red→blue @0.5 → (${r}, ${g}, ${b}, ${a})`);
  }
  morph.dispose();
})();

(() => {
  // strokeWidth lerp: src=2, dst=10 → @0.25 = 4.
  const gl = makeFakeGL();
  const src = fakeBundle({ strokeWidth: 2 });
  const dst = fakeBundle({ strokeWidth: 10 });
  const morph = createShapeMorph(gl, src, dst);
  morph.setT(0.25);
  const meta = uploadFor(gl, morph.bundle.metaTex);
  if (!meta) fail(`metaTex upload missing for strokeWidth`);
  else if (!approx(meta[12], 4))
    fail(`strokeWidth lerp @0.25: expected 4, got ${meta[12]}`);
  else ok(`meta strokeWidth lerp: 2→10 @0.25 → ${meta[12]}`);
  morph.dispose();
})();

(() => {
  // bbox lerp.
  const gl = makeFakeGL();
  const src = fakeBundle({ bbox: [0, 0, 10, 10] });
  const dst = fakeBundle({ bbox: [4, 4, 14, 14] });
  const morph = createShapeMorph(gl, src, dst);
  morph.setT(0.5);
  const meta = uploadFor(gl, morph.bundle.metaTex);
  if (!meta) fail(`metaTex upload missing for bbox`);
  else if (!approx(meta[0], 2) || !approx(meta[1], 2) || !approx(meta[2], 12) || !approx(meta[3], 12))
    fail(`bbox lerp @0.5: expected (2,2,12,12), got (${meta[0]},${meta[1]},${meta[2]},${meta[3]})`);
  else ok(`meta bbox lerp: (0,0,10,10)→(4,4,14,14) @0.5 → (${meta[0]},${meta[1]},${meta[2]},${meta[3]})`);
  morph.dispose();
})();

(() => {
  // imageRect lerp.
  const gl = makeFakeGL();
  const src = fakeBundle({ imageRect: [0, 0, 10, 10] });
  const dst = fakeBundle({ imageRect: [20, 30, 40, 50] });
  const morph = createShapeMorph(gl, src, dst);
  morph.setT(0.5);
  const meta = uploadFor(gl, morph.bundle.metaTex);
  if (!meta) fail(`metaTex upload missing for imageRect`);
  else if (!approx(meta[36], 10) || !approx(meta[37], 15) || !approx(meta[38], 25) || !approx(meta[39], 30))
    fail(`imageRect lerp @0.5: expected (10,15,25,30), got (${meta[36]},${meta[37]},${meta[38]},${meta[39]})`);
  else ok(`meta imageRect lerp: (0,0,10,10)→(20,30,40,50) @0.5 → (${meta[36]},${meta[37]},${meta[38]},${meta[39]})`);
  morph.dispose();
})();

(() => {
  // Structural slots stay at src (don't get clobbered by the lerp).
  // glyphLoc (offset 16, 17), flagsShape (offset 27), gradient ids
  // (offset 28..31), filterId (offset 32), blendMode (offset 33).
  const gl = makeFakeGL();
  const src = fakeBundle({ fillColor: [1, 0, 0, 1] });
  const dst = fakeBundle({ fillColor: [0, 0, 1, 1] });
  // Inject distinct values into src's structural slots to verify
  // they survive the lerp.
  src.metaFloats[27] = 42;   // flagsShape
  src.metaFloats[28] = 7;    // fillGradId
  dst.metaFloats[27] = 0;
  dst.metaFloats[28] = 0;
  const morph = createShapeMorph(gl, src, dst);
  morph.setT(0.5);
  const meta = uploadFor(gl, morph.bundle.metaTex);
  if (!meta) fail(`metaTex upload missing for structural-slot test`);
  else if (meta[27] !== 42 || meta[28] !== 7)
    fail(`structural slots clobbered: flagsShape=${meta[27]} (want 42), fillGradId=${meta[28]} (want 7)`);
  else ok(`meta structural slots preserved: flagsShape=42, fillGradId=7 stay at src across lerp`);
  morph.dispose();
})();

// ────────────────────────────────────────────────────────────────
// 2) Gradient param-texel lerp
// ────────────────────────────────────────────────────────────────

(() => {
  // Lerp the gradient axis endpoints.
  const gl = makeFakeGL();
  const src = fakeBundle({ axis: [0, 0, 10, 0]  });
  const dst = fakeBundle({ axis: [4, 4, 14, 14] });
  const morph = createShapeMorph(gl, src, dst);
  morph.setT(0.5);
  const gpx = uploadFor(gl, morph.bundle.gradientTex);
  if (!gpx) fail(`gradientTex upload missing`);
  else {
    // Slots 12..15 are the axis endpoints.
    const v = [gpx[12], gpx[13], gpx[14], gpx[15]];
    if (!approx(v[0], 2) || !approx(v[1], 2) || !approx(v[2], 12) || !approx(v[3], 7))
      fail(`gradient axis lerp @0.5: expected (2,2,12,7), got (${v.join(',')})`);
    else ok(`gradient axis lerp: linear endpoints lerp slots 12..15 @0.5 → (${v.join(',')})`);
  }
  morph.dispose();
})();

(() => {
  // Lerp the gradient inverse-transform matrix.
  const gl = makeFakeGL();
  // src has identity inv; dst has uniform 2× inv (so user→grad space halves).
  const src = fakeBundle({ transformInv: [1, 0, 0, 1, 0, 0] });
  const dst = fakeBundle({ transformInv: [0.5, 0, 0, 0.5, 0, 0] });
  const morph = createShapeMorph(gl, src, dst);
  morph.setT(0.5);
  const gpx = uploadFor(gl, morph.bundle.gradientTex);
  if (!gpx) fail(`gradientTex upload missing for transform-inv`);
  else if (!approx(gpx[4], 0.75) || !approx(gpx[7], 0.75))
    fail(`gradient transform-inv lerp @0.5: expected ia=id=0.75, got ia=${gpx[4]}, id=${gpx[7]}`);
  else ok(`gradient transform-inv lerp: ia/id @0.5 → ${gpx[4]}/${gpx[7]}`);
  // Structural slots (0..2, 10, 11) must NOT have changed.
  if (gpx[0] !== 0 || gpx[1] !== 0 || gpx[2] !== 0)
    fail(`gradient structural slots type/spread/units clobbered: ${gpx[0]},${gpx[1]},${gpx[2]}`);
  else if (gpx[10] !== 0 || gpx[11] !== 2)
    fail(`gradient structural slots stopsOffset/stopsCount clobbered: ${gpx[10]},${gpx[11]}`);
  else ok(`gradient structural slots preserved across lerp (type/spread/units/stopsOff/stopsCount)`);
  morph.dispose();
})();

(() => {
  // Type mismatch: src LINEAR, dst RADIAL → no param lerp for that
  // pair (falls back to src params). We test by checking that the
  // dst-style axis fields do NOT appear at t=0.5.
  const gl = makeFakeGL();
  const src = fakeBundle();
  const dst = fakeBundle();
  // Mutate dst's gradient type to RADIAL via the underlying float
  // view (gradientFloats is a Uint8Array view of the Float32 buffer).
  const dF = new Float32Array(dst.gradientFloats.buffer,
                              dst.gradientFloats.byteOffset,
                              dst.gradientFloats.byteLength >> 2);
  dF[0] = 1;   // type = RADIAL
  dF[12] = 999; dF[13] = 999;   // would be cx, cy — wildly different from src's x1, y1
  const morph = createShapeMorph(gl, src, dst);
  morph.setT(0.5);
  const gpx = uploadFor(gl, morph.bundle.gradientTex);
  if (gpx && (approx(gpx[12], 499.5) || approx(gpx[13], 499.5)))
    fail(`gradient type-mismatch should NOT lerp axis: got [12]=${gpx[12]}, [13]=${gpx[13]} (drift toward dst)`);
  else ok(`gradient type-mismatch: lerp skipped (linear vs radial — src values preserved)`);
  morph.dispose();
})();

// ────────────────────────────────────────────────────────────────
// 3) Stop position byte lerp (confirm offset byte is covered)
// ────────────────────────────────────────────────────────────────

(() => {
  // Stops: src offsets at [0, 255], dst at [50, 200]. Verify at t=0.5
  // the offset bytes (the .a channel of each 4-byte stop record) lerp.
  const gl = makeFakeGL();
  const src = fakeBundle({
    stops: [255, 0, 0, 0,     // stop 0: red, offset 0
            0, 0, 255, 255],  // stop 1: blue, offset 255
  });
  const dst = fakeBundle({
    stops: [255, 0, 0, 50,    // stop 0: red, offset 50
            0, 0, 255, 200],  // stop 1: blue, offset 200
  });
  const morph = createShapeMorph(gl, src, dst);
  morph.setT(0.5);
  const stops = uploadFor(gl, morph.bundle.gradientStopsTex);
  if (!stops) fail(`gradientStopsTex upload missing`);
  else {
    // Offset bytes at indices 3 and 7.
    // 0   * 0.5 +  50 * 0.5 + 0.5 = 25.5 → round → 25 (or 26 from rounding).
    // 255 * 0.5 + 200 * 0.5 + 0.5 = 228.0 → 228.
    if (!(stops[3] >= 24 && stops[3] <= 26))
      fail(`stop 0 offset lerp @0.5: expected ~25, got ${stops[3]}`);
    else if (!(stops[7] >= 227 && stops[7] <= 229))
      fail(`stop 1 offset lerp @0.5: expected ~228, got ${stops[7]}`);
    else ok(`gradient stop OFFSET lerp: stop[0]=${stops[3]}, stop[1]=${stops[7]} (positions interpolate)`);
  }
  morph.dispose();
})();

// ────────────────────────────────────────────────────────────────

if (failures === 0) console.log('\nSHAPE-MORPH-META PASS');
else { console.error(`\nSHAPE-MORPH-META FAIL (${failures})`); process.exit(1); }
