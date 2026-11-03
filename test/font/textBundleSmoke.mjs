// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// textBundleSmoke.mjs — createTextBundle + setText
// produces a sections-shape bundle compatible with createBundle.
// We stub GL so the test runs headless; the assertions verify the
// sections content shape rather than actual rasterization.

import { readFileSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { createTextBundle } from '../../src/textBundle.js';

let failures = 0;
function ok(msg) {
  console.log('ok', msg);
}
function fail(msg) {
  failures++;
  console.error('FAIL', msg);
}

const fontPath = '/System/Library/Fonts/Supplemental/Arial.ttf';
let font;
try {
  font = new MantleFontAsset(new Uint8Array(readFileSync(fontPath)));
} catch (e) {
  console.error('Skipping textBundleSmoke: font not available:', e.message);
  process.exit(0);
}

// Minimal GL stub — createBundle calls a small set of methods on it.
function makeGlStub() {
  const textures = [];
  return {
    NEAREST: 9728,
    LINEAR: 9729,
    CLAMP_TO_EDGE: 33071,
    TEXTURE_2D: 3553,
    TEXTURE_MIN_FILTER: 10241,
    TEXTURE_MAG_FILTER: 10240,
    TEXTURE_WRAP_S: 10242,
    TEXTURE_WRAP_T: 10243,
    RGBA32F: 34836,
    RGBA: 6408,
    FLOAT: 5126,
    RGBA8: 32856,
    UNSIGNED_BYTE: 5121,
    createTexture: () => {
      const t = { id: 'tex_' + textures.length };
      textures.push(t);
      return t;
    },
    bindTexture() {},
    texParameteri() {},
    texImage2D() {},
    texSubImage2D() {},
    deleteTexture() {},
    get textureCount() {
      return textures.length;
    },
  };
}

const gl = makeGlStub();

// === T1: create + verify shape ====================================
{
  const tb = await createTextBundle(gl, {
    font,
    text: 'red',
    style: { fill: [1, 0, 0, 1], fontSizePx: 48 },
  });
  if (tb.bundle && tb.bundle.numShapes > 0)
    ok(`T1 builds bundle with ${tb.bundle.numShapes} shapes`);
  else fail('T1 bundle missing or empty');
  if (tb.text === 'red') ok('T1 .text getter');
  else fail(`T1 text = "${tb.text}"`);
  if (tb.bundle.shapeIds && tb.bundle.shapeIds.length === tb.bundle.numShapes)
    ok('T1 shapeIds plumbed through (length matches numShapes)');
  else fail('T1 shapeIds missing/wrong length');
  tb.dispose();
}

// === T2: setText rebuilds in place =================================
{
  const tb = await createTextBundle(gl, {
    font,
    text: 'red',
    style: { fill: [1, 0, 0, 1] },
  });
  const before = tb.bundle.numShapes;
  await tb.setText('verde longer');
  if (tb.text === 'verde longer') ok('T2 setText updates .text');
  else fail(`T2 text after setText = "${tb.text}"`);
  if (tb.bundle.numShapes > before)
    ok(`T2 longer string → more shapes (${before} → ${tb.bundle.numShapes})`);
  else fail(`T2 numShapes unchanged (${before} → ${tb.bundle.numShapes})`);
  tb.dispose();
}

// === T3: setText also accepts a new style ==========================
{
  const tb = await createTextBundle(gl, {
    font,
    text: 'A',
    style: { fill: [1, 0, 0, 1] },
  });
  await tb.setText('A', { fill: [0, 1, 0, 1] });
  // Fill color lives in meta texel 1; verify the green-only update
  // landed.
  const stride = tb.bundle.metaFloatsPerShape;
  const m = tb.bundle.metaFloats;
  if (
    m &&
    Math.abs(m[stride * 0 + 4] - 0) < 1e-3 &&
    Math.abs(m[stride * 0 + 5] - 1) < 1e-3 &&
    Math.abs(m[stride * 0 + 6] - 0) < 1e-3
  )
    ok('T3 setText with new style updates fill color');
  else fail(`T3 fill = (${m[4]}, ${m[5]}, ${m[6]}, ${m[7]})`);
  tb.dispose();
}

// === T3b: repeated text is allocation-free =========================
{
  const tb = await createTextBundle(gl, {
    font,
    text: 'same',
    style: { fill: [1, 0, 0, 1] },
  });
  const beforeBundle = tb.bundle;
  const beforeGen = tb.bundle._geomGen | 0;
  const beforeTextures = gl.textureCount;
  const result = await tb.setText('same');
  if (
    result === beforeBundle &&
    tb.bundle === beforeBundle &&
    (tb.bundle._geomGen | 0) === beforeGen &&
    gl.textureCount === beforeTextures
  )
    ok('T3b repeated setText avoids rebuild and texture allocation');
  else fail('T3b repeated setText rebuilt unchanged glyphs');
  tb.dispose();
}

// === T4: setStyle alone keeps text =================================
{
  const tb = await createTextBundle(gl, {
    font,
    text: 'unchanged',
    style: { fill: [0, 0, 1, 1] },
  });
  await tb.setStyle({ fill: [1, 1, 0, 1] });
  if (tb.text === 'unchanged') ok('T4 setStyle keeps existing text');
  else fail(`T4 text changed: "${tb.text}"`);
  tb.dispose();
}

// === T6: globalBBox + per-shape bboxes are FINITE ==================
// Guards against an undefined span size cascading NaN coords, leaving
// every shape bbox stuck at the Infinity seed and globalBBox =
// [Inf, Inf, -Inf, -Inf].
{
  const tb = await createTextBundle(gl, {
    font,
    text: 'GO',
    style: { fill: [1, 1, 1, 1], fontSizePx: 160 },
  });
  const gb = tb.bundle.globalBBox;
  const finiteBb =
    gb &&
    Number.isFinite(gb[0]) &&
    Number.isFinite(gb[1]) &&
    Number.isFinite(gb[2]) &&
    Number.isFinite(gb[3]) &&
    gb[2] > gb[0] &&
    gb[3] > gb[1];
  if (finiteBb) ok(`T6 globalBBox finite: [${gb.map((v) => v.toFixed(2)).join(', ')}]`);
  else fail(`T6 globalBBox not finite: [${gb && gb.join(', ')}]`);
  const stride = tb.bundle.metaFloatsPerShape;
  const m = tb.bundle.metaFloats;
  let allFinite = true;
  for (let s = 0; s < tb.bundle.numShapes; s++) {
    const off = s * stride;
    if (
      !Number.isFinite(m[off + 0]) ||
      !Number.isFinite(m[off + 1]) ||
      !Number.isFinite(m[off + 2]) ||
      !Number.isFinite(m[off + 3])
    ) {
      allFinite = false;
      break;
    }
  }
  if (allFinite) ok(`T6 per-shape meta bboxes all finite (${tb.bundle.numShapes} shapes)`);
  else fail('T6 a per-shape meta bbox has non-finite coord');
  tb.dispose();
}

// === T5: dispose nukes bundle reference ============================
{
  const tb = await createTextBundle(gl, { font, text: 'x' });
  tb.dispose();
  if (tb.bundle === null) ok('T5 dispose() clears bundle');
  else fail('T5 dispose did not clear bundle');
}

console.log('---');
if (failures) console.error(`TEXT-BUNDLE FAIL (${failures})`);
else console.log('TEXT-BUNDLE PASS');
process.exit(failures ? 1 : 0);
