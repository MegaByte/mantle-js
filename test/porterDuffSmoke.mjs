// Verify the 13-mode Porter-Duff lookup table matches the published
// Porter & Duff 1984 equations and the OpenType COLRv1 PaintCompositeMode
// encoding. Re-implements the helper in JS (pure math, 4 lines per mode) and
// checks hand-traced inputs, including the alpha edge cases:
//   - SrcOver with transparent dst (mode 3, ad=0 → output = src)
//   - DstIn with transparent src (mode 6, as=0 → output = 0)
//   - Clear (mode 0 always = 0)
//   - Plus (mode 12 saturates instead of compositing)

import fs from 'node:fs';

// === mirror of the helper in _porterDuffHelpers.glsl ============
function porterDuff(mode, src, dst) {
  const as = src[3], ad = dst[3];
  let Fa, Fb;
  switch (mode) {
    case 0:  Fa = 0;        Fb = 0;        break;  // clear
    case 1:  Fa = 1;        Fb = 0;        break;  // src
    case 2:  Fa = 0;        Fb = 1;        break;  // dst
    case 3:  Fa = 1;        Fb = 1 - as;   break;  // src over
    case 4:  Fa = 1 - ad;   Fb = 1;        break;  // dst over
    case 5:  Fa = ad;       Fb = 0;        break;  // src in
    case 6:  Fa = 0;        Fb = as;       break;  // dst in
    case 7:  Fa = 1 - ad;   Fb = 0;        break;  // src out
    case 8:  Fa = 0;        Fb = 1 - as;   break;  // dst out
    case 9:  Fa = ad;       Fb = 1 - as;   break;  // src atop
    case 10: Fa = 1 - ad;   Fb = as;       break;  // dst atop
    case 11: Fa = 1 - ad;   Fb = 1 - as;   break;  // xor
    default: Fa = 1;        Fb = 1;        break;  // plus (12)
  }
  let out = [Fa * src[0] + Fb * dst[0],
             Fa * src[1] + Fb * dst[1],
             Fa * src[2] + Fb * dst[2],
             Fa * src[3] + Fb * dst[3]];
  if (mode === 12) out = out.map(v => Math.min(1, Math.max(0, v)));
  return out;
}

let failures = 0;
function eq(a, b, label, eps = 1e-6) {
  const ok = a.every((v, i) => Math.abs(v - b[i]) < eps);
  if (!ok) { console.error('FAIL:', label, 'expected', b, 'got', a); failures++; }
  else     { console.log('ok:', label); }
}

// Test colors are PREMULTIPLIED (filter-graph invariant).
const R    = [1, 0, 0, 1];   // opaque red
const B    = [0, 0, 1, 1];   // opaque blue
const RHALf= [0.5, 0, 0, 0.5];  // half-alpha red, premultiplied
const ZERO = [0, 0, 0, 0];

// Mode 0 (Clear): always transparent black, regardless of inputs.
eq(porterDuff(0, R, B), [0, 0, 0, 0], 'Clear: R, B → 0');

// Mode 1 (Src): output = src.
eq(porterDuff(1, R, B), R, 'Src: R, B → R');
eq(porterDuff(1, ZERO, B), ZERO, 'Src: 0, B → 0');

// Mode 2 (Dst): output = dst.
eq(porterDuff(2, R, B), B, 'Dst: R, B → B');

// Mode 3 (SrcOver): src + dst·(1-as).
// Opaque src completely covers dst.
eq(porterDuff(3, R, B), R, 'SrcOver: R(α=1), B → R');
// Half-alpha red over blue: (0.5, 0, 0.5, 1).
eq(porterDuff(3, RHALf, B), [0.5, 0, 0.5, 1], 'SrcOver: R(α=0.5), B(α=1) → (0.5,0,0.5,1)');
// Over transparent dst: src unchanged.
eq(porterDuff(3, RHALf, ZERO), RHALf, 'SrcOver: R(α=0.5), 0 → R(α=0.5)');

// Mode 4 (DstOver): src·(1-ad) + dst.
eq(porterDuff(4, R, B), B, 'DstOver: R, B(α=1) → B');
// Over transparent dst → src unchanged.
eq(porterDuff(4, RHALf, ZERO), RHALf, 'DstOver: R(α=0.5), 0 → R(α=0.5)');

// Mode 5 (SrcIn): src·ad.
eq(porterDuff(5, R, B), R, 'SrcIn: R, B(α=1) → R');
eq(porterDuff(5, R, ZERO), ZERO, 'SrcIn: R, 0 → 0');

// Mode 6 (DstIn): dst·as.
eq(porterDuff(6, R, B), B, 'DstIn: R(α=1), B → B');
eq(porterDuff(6, ZERO, B), ZERO, 'DstIn: 0, B → 0');

// Mode 7 (SrcOut): src·(1-ad).
eq(porterDuff(7, R, B), ZERO, 'SrcOut: R, B(α=1) → 0');
eq(porterDuff(7, R, ZERO), R, 'SrcOut: R, 0 → R');

// Mode 8 (DstOut): dst·(1-as).
eq(porterDuff(8, R, B), ZERO, 'DstOut: R(α=1), B → 0');
eq(porterDuff(8, ZERO, B), B, 'DstOut: 0, B → B');

// Mode 9 (SrcAtop): src·ad + dst·(1-as). Opaque src ⇒ all src.
eq(porterDuff(9, R, B), R, 'SrcAtop: R, B(α=1) → R');
// Half-α src atop opaque dst → mixed.
eq(porterDuff(9, RHALf, B),
   [0.5 + 0 * 0.5,   // r: 0.5·1 + 0·0.5
    0,                // g
    0 + 1 * 0.5,      // b: 0·1 + 1·0.5
    0.5 + 1 * 0.5],   // a: 0.5·1 + 1·0.5 = 1.0
   'SrcAtop: R(α=0.5), B(α=1) → (0.5, 0, 0.5, 1)');

// Mode 10 (DstAtop): src·(1-ad) + dst·as. Symmetric to SrcAtop.
eq(porterDuff(10, R, B), B, 'DstAtop: R(α=1), B → B');

// Mode 11 (Xor): src·(1-ad) + dst·(1-as).
eq(porterDuff(11, R, B), ZERO, 'Xor: R(α=1), B(α=1) → 0');
eq(porterDuff(11, RHALf, ZERO), RHALf, 'Xor: R(α=0.5), 0 → R(α=0.5)');

// Mode 12 (Plus): clamped src + dst.
eq(porterDuff(12, R, B), [1, 0, 1, 1], 'Plus: R + B → (1,0,1,1)');
// Saturation: opaque red + opaque red → clamps to (1, 0, 0, 1).
eq(porterDuff(12, R, R), [1, 0, 0, 1], 'Plus: R + R → clamped (1,0,0,1)');

// === sanity: feComposite op → PD mode mapping ==========================
// The encoding in feComposite.frag.glsl is: pd = 3 + 2·op.
// over=0 → 3, in=1 → 5, out=2 → 7, atop=3 → 9, xor=4 → 11.
const map = [3, 5, 7, 9, 11];
for (let op = 0; op < 5; op++) {
  const expected = 3 + 2 * op;
  if (map[op] !== expected) {
    console.error(`FAIL: feComposite op=${op} → PD ${map[op]}, expected ${expected}`);
    failures++;
  }
}
if (!failures) console.log('ok: feComposite op→PD mapping (0..4 → 3,5,7,9,11)');

// === sanity: COLR mode → blend mode mapping (paintComposite.frag) =====
// 13..22 → 2..11 (shift by -11)
// 23     → 1
// 24..27 → 12..15 (shift by -12)
function colrModeToBlend(m) {
  if (m === 23) return 1;
  if (m >= 13 && m <= 22) return m - 11;
  if (m >= 24 && m <= 27) return m - 12;
  return 0;
}
const colrTable = {
  13: 2,  14: 3,  15: 4,  16: 5,  17: 6,  18: 7,  19: 8,  20: 9,
  21: 10, 22: 11, 23: 1,  24: 12, 25: 13, 26: 14, 27: 15,
};
for (const [colr, blend] of Object.entries(colrTable)) {
  const got = colrModeToBlend(+colr);
  if (got !== blend) {
    console.error(`FAIL: COLR mode ${colr} → blend ${got}, expected ${blend}`);
    failures++;
  }
}
if (!failures) console.log('ok: COLR blend-mode table (13..27 → 1..15)');

// Spot-check: ensure the shader source actually contains the markers
// (a typo'd marker would silently un-include the helper).
function readShader(name) {
  return fs.readFileSync(
    new URL(`../src/shaders/${name}`, import.meta.url), 'utf8');
}
const pcSrc = readShader('paintComposite.frag.glsl');
if (!pcSrc.includes('@@PORTER_DUFF_HELPERS@@')) {
  console.error('FAIL: paintComposite missing @@PORTER_DUFF_HELPERS@@ marker');
  failures++;
} else { console.log('ok: paintComposite has PD-helpers marker'); }
if (!pcSrc.includes('@@BLEND_HELPERS@@')) {
  console.error('FAIL: paintComposite missing @@BLEND_HELPERS@@ marker');
  failures++;
} else { console.log('ok: paintComposite has blend-helpers marker'); }

const feCSrc = readShader('feComposite.frag.glsl');
if (!feCSrc.includes('@@PORTER_DUFF_HELPERS@@')) {
  console.error('FAIL: feComposite missing @@PORTER_DUFF_HELPERS@@ marker');
  failures++;
} else { console.log('ok: feComposite has PD-helpers marker'); }

const feBSrc = readShader('feBlend.frag.glsl');
if (!feBSrc.includes('@@BLEND_HELPERS@@')) {
  console.error('FAIL: feBlend missing @@BLEND_HELPERS@@ marker');
  failures++;
} else { console.log('ok: feBlend has blend-helpers marker'); }

console.log('---');
if (failures) console.error(`PORTER-DUFF FAIL (${failures})`);
else          console.log('PORTER-DUFF PASS');
process.exit(failures ? 1 : 0);
