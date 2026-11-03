// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// overridesSmoke.mjs — createOverrideTable parity.
//
// Validates that the packed override buffer matches the byte layout
// expected by mantle.vert.glsl (and Unity's MantleAnimator) without
// requiring a real GL context. We stub gl with a minimal shim that
// records the texture upload data.

import { createOverrideTable } from '../../src/animation/overrides.js';

let failures = 0;
function ok(msg) {
  console.log('ok', msg);
}
function fail(msg) {
  failures++;
  console.error('FAIL', msg);
}
function approx(a, b, eps = 1e-6) {
  return Math.abs(a - b) < eps;
}

// Minimal WebGL2 shim — just enough for createOverrideTable.
function makeGlStub() {
  const calls = [];
  let lastUpload = null;
  return {
    NEAREST: 9728,
    CLAMP_TO_EDGE: 33071,
    TEXTURE_2D: 3553,
    TEXTURE_MIN_FILTER: 10241,
    TEXTURE_MAG_FILTER: 10240,
    TEXTURE_WRAP_S: 10242,
    TEXTURE_WRAP_T: 10243,
    RGBA32F: 34836,
    RGBA: 6408,
    FLOAT: 5126,
    createTexture: () => ({ id: 'tex' }),
    bindTexture: (target, tex) => calls.push(['bind', target, tex && tex.id]),
    texParameteri: () => {},
    texImage2D(target, lvl, ifmt, w, h, _border, fmt, type, data) {
      lastUpload = { w, h, data: new Float32Array(data) };
    },
    texSubImage2D(target, lvl, x, y, w, h, fmt, type, data) {
      lastUpload = { w, h, data: new Float32Array(data) };
    },
    deleteTexture: () => {},
    get lastUpload() {
      return lastUpload;
    },
  };
}

function makeBundle(shapeIds) {
  return { numShapes: shapeIds.length, shapeIds };
}

// Per-shape stride: 6 texels × 4 floats = 24 floats. Used for index
// arithmetic into the packed buffer. Layout:
//   0..3    affine (m00, m01, m10, m11)
//   4..7    (tx, ty, visibility, overrideMask)
//   8..11   tint
//   12..15  absolute fill (gated by mask & 0x1)
//   16..19  absolute stroke (gated by mask & 0x2)
//   20..23  absolute strokeWidth (.x; .y .z .w reserved)
const STRIDE = 24;

// === T1: identity default ===========================================
{
  const gl = makeGlStub();
  const table = createOverrideTable(gl, makeBundle(['a', 'b']));
  const u = gl.lastUpload;
  if (u && u.w === 6 && u.h === 2) ok('T1 initial upload is 6xN RGBA32F');
  else fail(`T1 expected 6x2 upload, got ${u && u.w}x${u && u.h}`);
  // Shape 0, texel 0: identity 2x2 affine = (1, 0, 0, 1)
  const d = u.data;
  if (approx(d[0], 1) && approx(d[1], 0) && approx(d[2], 0) && approx(d[3], 1))
    ok('T1 affine identity packed for shape 0');
  else fail(`T1 affine: ${d[0]} ${d[1]} ${d[2]} ${d[3]}`);
  // Shape 0, texel 1: (tx, ty, vis, overrideMask) = (0, 0, 1, 0)
  if (approx(d[4], 0) && approx(d[5], 0) && approx(d[6], 1) && approx(d[7], 0))
    ok('T1 position+visibility+mask identity');
  else fail(`T1 position: ${d.slice(4, 8).join(',')}`);
  // Shape 0, texel 2: tint white
  if (approx(d[8], 1) && approx(d[9], 1) && approx(d[10], 1) && approx(d[11], 1))
    ok('T1 tint white');
  else fail(`T1 tint: ${d.slice(8, 12).join(',')}`);
  // Shape 0, texels 3..5: absolute-override slots zeroed (mask gates).
  let absZero = true;
  for (let k = 12; k < 24; k++) if (!approx(d[k], 0)) absZero = false;
  if (absZero) ok('T1 absolute-override slots zeroed');
  else fail(`T1 absolute slots not zero: ${d.slice(12, 24).join(',')}`);
  // Shape 1 must also be identity.
  const s1 = STRIDE;
  if (approx(d[s1 + 0], 1) && approx(d[s1 + 3], 1) && approx(d[s1 + 6], 1) && approx(d[s1 + 11], 1))
    ok('T1 shape 1 also identity-tiled');
  else fail(`T1 shape 1 packing wrong: ${d.slice(s1, s1 + 12).join(',')}`);
  table.dispose();
}

// === T2: set(shapeId, { tint }) ====================================
{
  const gl = makeGlStub();
  const table = createOverrideTable(gl, makeBundle(['hat', 'shirt']));
  const setRes = table.set('hat', { tint: [1, 0, 0, 1] });
  if (setRes) ok('T2 set("hat", ...) returns true');
  else fail('T2 set ret');
  table.uploadIfDirty();
  const d = gl.lastUpload.data;
  if (approx(d[8], 1) && approx(d[9], 0) && approx(d[10], 0) && approx(d[11], 1))
    ok('T2 tint red packed at shape 0 texel 2');
  else fail(`T2 tint: ${d.slice(8, 12).join(',')}`);
  // overrideMask must NOT light up for a tint-only set (tint is
  // multiplicative, not an absolute override).
  if (approx(d[7], 0)) ok('T2 overrideMask stays 0 for tint-only set');
  else fail(`T2 mask = ${d[7]}`);
  // Shape 1 must still be identity (tint at texel 2 of shape 1).
  const s1 = STRIDE;
  if (approx(d[s1 + 8], 1) && approx(d[s1 + 11], 1)) ok('T2 shape 1 still identity');
  else fail(`T2 shape 1 disturbed: ${d.slice(s1 + 8, s1 + 12).join(',')}`);
  table.dispose();
}

// === T3: rotation + scale → 2x2 packing ============================
{
  const gl = makeGlStub();
  const table = createOverrideTable(gl, makeBundle(['x']));
  // 90° rotation. Expected affine: M = R(90°)·S(1,1) = (0, -1; 1, 0)
  // Row-major storage: (m00, m01, m10, m11) = (0, -1, 1, 0).
  table.set('x', { localRotation: Math.PI / 2, localScale: [1, 1] });
  table.uploadIfDirty();
  const d = gl.lastUpload.data;
  if (approx(d[0], 0) && approx(d[1], -1) && approx(d[2], 1) && approx(d[3], 0))
    ok('T3 90° rotation packs as (0, -1, 1, 0)');
  else fail(`T3 rot: ${d[0]} ${d[1]} ${d[2]} ${d[3]}`);
  // Non-uniform scale on top.
  table.set('x', { localScale: [2, 3], localRotation: 0 });
  table.uploadIfDirty();
  const d2 = gl.lastUpload.data;
  if (approx(d2[0], 2) && approx(d2[1], 0) && approx(d2[2], 0) && approx(d2[3], 3))
    ok('T3 scale (2,3) packs as (2,0,0,3)');
  else fail(`T3 scale: ${d2[0]} ${d2[1]} ${d2[2]} ${d2[3]}`);
  table.dispose();
}

// === T4: visibility clamps + hasAny =================================
{
  const gl = makeGlStub();
  const table = createOverrideTable(gl, makeBundle(['a']));
  if (!table.hasAny) ok('T4 hasAny=false initially');
  else fail('T4 hasAny should be false initially');
  table.set('a', { visibility: 2 }); // clamps to 1
  table.uploadIfDirty();
  let d = gl.lastUpload.data;
  if (approx(d[6], 1)) ok('T4 visibility >1 clamps to 1');
  else fail(`T4 visibility = ${d[6]}`);
  table.set('a', { visibility: -1 }); // clamps to 0
  table.uploadIfDirty();
  d = gl.lastUpload.data;
  if (approx(d[6], 0)) ok('T4 visibility <0 clamps to 0');
  else fail(`T4 visibility = ${d[6]}`);
  if (table.hasAny) ok('T4 hasAny=true after set');
  else fail('T4 hasAny should be true after set');
  table.dispose();
}

// === T5: index-based addressing in addition to id ===================
{
  const gl = makeGlStub();
  const table = createOverrideTable(gl, makeBundle(['', 'tail']));
  // Set by raw index — '' ids would otherwise be unreachable.
  table.set(0, { visibility: 0 });
  table.uploadIfDirty();
  const d = gl.lastUpload.data;
  if (approx(d[6], 0)) ok('T5 set(0, …) targets first row by index');
  else fail(`T5 vis = ${d[6]}`);
  // Wrong types reject.
  if (!table.set(99, { tint: [1, 0, 0, 1] })) ok('T5 oob index rejected');
  else fail('T5 oob index should reject');
  if (!table.set(null, {})) ok('T5 null key rejected');
  else fail('T5 null key should reject');
  table.dispose();
}

// === T6: clear / clearAll restore identity =========================
{
  const gl = makeGlStub();
  const table = createOverrideTable(gl, makeBundle(['p']));
  table.set('p', {
    tint: [0.5, 0.5, 0.5, 0.5],
    visibility: 0.3,
    fill: [0.1, 0.2, 0.3, 0.4],
    strokeWidth: 2,
  });
  table.clear('p');
  table.uploadIfDirty();
  const d = gl.lastUpload.data;
  if (approx(d[6], 1) && approx(d[7], 0) && approx(d[8], 1) && approx(d[11], 1))
    ok('T6 clear restores identity row + zeros mask');
  else fail(`T6 cleared row: ${d.slice(0, 12).join(',')}`);
  // Absolute slots also cleared.
  let absZero = true;
  for (let k = 12; k < 24; k++) if (!approx(d[k], 0)) absZero = false;
  if (absZero) ok('T6 clear zeros the absolute-override slots');
  else fail(`T6 absolute slots not cleared: ${d.slice(12, 24).join(',')}`);
  if (!table.hasAny) ok('T6 hasAny=false after clear');
  else fail('T6 hasAny should be false after clear');
  table.dispose();
}

// === T7: absolute fill override =====================================
{
  const gl = makeGlStub();
  const table = createOverrideTable(gl, makeBundle(['rect']));
  table.set('rect', { fill: [0, 1, 0, 1] });
  table.uploadIfDirty();
  const d = gl.lastUpload.data;
  // Mask bit 0 (fill) set, others clear.
  if (approx(d[7], 1)) ok('T7 overrideMask = 1 for fill-only set');
  else fail(`T7 mask = ${d[7]} (expected 1)`);
  // Texel 3 = absolute fill.
  if (approx(d[12], 0) && approx(d[13], 1) && approx(d[14], 0) && approx(d[15], 1))
    ok('T7 absolute fill packed at texel 3');
  else fail(`T7 fill texel: ${d.slice(12, 16).join(',')}`);
  // Round-trip via get().
  const o = table.get('rect');
  if (o.fill && approx(o.fill[1], 1) && approx(o.fill[3], 1))
    ok('T7 get() returns the absolute fill');
  else fail(`T7 get: ${JSON.stringify(o)}`);
  table.dispose();
}

// === T8: absolute stroke + strokeWidth ==============================
{
  const gl = makeGlStub();
  const table = createOverrideTable(gl, makeBundle(['rect']));
  table.set('rect', { stroke: [0.5, 0, 0, 1], strokeWidth: 3.5 });
  table.uploadIfDirty();
  const d = gl.lastUpload.data;
  // Mask bits 1 (stroke) and 2 (strokeWidth) → 0x6.
  if (approx(d[7], 6)) ok('T8 overrideMask = 6 for stroke+strokeWidth');
  else fail(`T8 mask = ${d[7]} (expected 6)`);
  if (approx(d[16], 0.5) && approx(d[19], 1)) ok('T8 absolute stroke packed at texel 4');
  else fail(`T8 stroke texel: ${d.slice(16, 20).join(',')}`);
  if (approx(d[20], 3.5)) ok('T8 absolute strokeWidth packed at texel 5.x');
  else fail(`T8 strokeWidth = ${d[20]}`);
  // The fill slot stays zeroed (mask bit 0 clear).
  if (approx(d[12], 0) && approx(d[15], 0))
    ok('T8 fill slot untouched when only stroke is overridden');
  else fail(`T8 fill leaked: ${d.slice(12, 16).join(',')}`);
  table.dispose();
}

// === T9a: update() merges partial fields, preserves others =========
{
  const gl = makeGlStub();
  const table = createOverrideTable(gl, makeBundle(['shape']));
  // First set: full state with fill + visibility.
  table.set('shape', { fill: [1, 0, 0, 1], visibility: 0.5 });
  // update() should change visibility WITHOUT touching the fill.
  table.update('shape', { visibility: 1 });
  table.uploadIfDirty();
  const d = gl.lastUpload.data;
  if (approx(d[6], 1)) ok('T9a update() changed visibility');
  else fail(`T9a vis = ${d[6]}`);
  // Fill must survive.
  if (approx(d[7], 1) && approx(d[12], 1) && approx(d[15], 1))
    ok('T9a update() preserves the absolute fill override');
  else fail(`T9a fill leaked away: mask=${d[7]} texel3=${d.slice(12, 16).join(',')}`);
  // update with `fill: null` clears the override.
  table.update('shape', { fill: null });
  table.uploadIfDirty();
  const d2 = gl.lastUpload.data;
  if (approx(d2[7], 0) && approx(d2[12], 0))
    ok('T9a update({fill: null}) clears the fill override');
  else fail(`T9a fill not cleared: mask=${d2[7]} texel3.r=${d2[12]}`);
  table.dispose();
}

// === T9: combined fill + stroke + transform + tint ==================
{
  const gl = makeGlStub();
  const table = createOverrideTable(gl, makeBundle(['ball']));
  table.set('ball', {
    localPosition: [10, 20],
    localRotation: 0,
    localScale: [2, 2],
    tint: [1, 1, 0.5, 1],
    fill: [0.9, 0.1, 0.1, 1],
    stroke: [0, 0, 0, 1],
    strokeWidth: 1.5,
    visibility: 0.8,
  });
  table.uploadIfDirty();
  const d = gl.lastUpload.data;
  if (approx(d[7], 7)) ok('T9 overrideMask = 7 (fill | stroke | strokeWidth)');
  else fail(`T9 mask = ${d[7]} (expected 7)`);
  if (approx(d[6], 0.8)) ok('T9 visibility preserved alongside absolute overrides');
  else fail(`T9 vis = ${d[6]}`);
  if (approx(d[0], 2) && approx(d[3], 2)) ok('T9 scale (2,2) packs into affine');
  else fail(`T9 affine: ${d.slice(0, 4).join(',')}`);
  table.dispose();
}

console.log('---');
if (failures) console.error(`OVERRIDES-SMOKE FAIL (${failures})`);
else console.log('OVERRIDES-SMOKE PASS');
process.exit(failures ? 1 : 0);
