// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

//
// Each entry returns a graph object compatible with filterGraph.js:
//   { nodes: [...], rootOut: int }
// Drivers call these once per material — graphs are static for the
// lifetime of a given effect configuration. Animated parameters (e.g.
// animated tint color) rebuild the graph on parameter change.
//
// All synthesizers consume `SourceGraphic` (sentinel -1) and produce
// a single root output. Composability with other primitives is the
// caller's responsibility: feMerge / feComposite as needed.

import { SRC_GRAPHIC } from '../filterGraph/sourceTags.js';

// Build a feComponentTransfer LUT row that reads `table` (an array
// of floats on [0, 1]) and interpolates linearly between adjacent
// entries. Same baking as the SVG <feFuncR type="table"> path.
function bakeTableRow(table) {
  // Pad to a usable length; minimum 2 points to interpolate.
  if (!table || table.length < 2) {
    if (table && table.length === 1) table = [table[0], table[0]];
    else table = [0, 1];
  }
  const out = new Uint8Array(256);
  const n = table.length - 1;
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    const t = Math.max(0, Math.min(1, x)) * n;
    const idx = Math.floor(t);
    const f = t - idx;
    const v = idx >= n ? table[n] : table[idx] * (1 - f) + table[idx + 1] * f;
    out[i] = Math.max(0, Math.min(255, Math.round(v * 255)));
  }
  return out;
}

// Pack 4 256-byte LUT rows into the 256×4 RGBA8 layout
// feComponentTransfer expects in its params.lutBytes. Row order:
// R, G, B, A.
function packLutBytes(rowR, rowG, rowB, rowA) {
  const lut = new Uint8Array(256 * 4 * 4);
  for (let i = 0; i < 256; i++) lut[(0 * 256 + i) * 4 + 0] = rowR[i];
  for (let i = 0; i < 256; i++) lut[(1 * 256 + i) * 4 + 0] = rowG[i];
  for (let i = 0; i < 256; i++) lut[(2 * 256 + i) * 4 + 0] = rowB[i];
  for (let i = 0; i < 256; i++) lut[(3 * 256 + i) * 4 + 0] = rowA[i];
  return lut;
}

// ────────────────────────────────────────────────────────────────
// Tint — two-color luminance remap (black → c0, white → c1)
// ────────────────────────────────────────────────────────────────
// Lottie "Tint" layer effect (matches AE: input.luminance picks
// between Color1 and Color2). `amount` ∈ [0,1] is the blend back to
// the source (1 = fully tinted, 0 = identity).
//
// Pipeline:
//   1. feColorMatrix: collapse RGB into a luminance value and splat
//      it across R,G,B,A.  Output = (L, L, L, L) where L is Rec.601
//      luminance of the source.
//   2. feComponentTransfer with per-channel `table` fn: row 0 maps
//      L→r1, row 1 maps L→g1, row 2 maps L→b1, row 3 leaves alpha
//      untouched (uses source alpha for masking).
//
// Inputs: c0, c1 are [r,g,b,a] in [0,1]. Source alpha is preserved.
export function tintGraph(c0, c1) {
  const lumR = 0.299,
    lumG = 0.587,
    lumB = 0.114;
  // Step 1: 4×5 colorMatrix — splat L = lumR*r + lumG*g + lumB*b into
  // RGB while passing source alpha through unchanged.
  const splat = [
    lumR,
    lumG,
    lumB,
    0,
    0,
    lumR,
    lumG,
    lumB,
    0,
    0,
    lumR,
    lumG,
    lumB,
    0,
    0,
    0,
    0,
    0,
    1,
    0,
  ];
  // Step 2: gradient lookup. row R: at L=0 -> c0.r, L=1 -> c1.r.
  // Simple 2-point linear table.
  const rowR = bakeTableRow([c0[0], c1[0]]);
  const rowG = bakeTableRow([c0[1], c1[1]]);
  const rowB = bakeTableRow([c0[2], c1[2]]);
  const rowA = bakeTableRow([0, 1]); // identity (alpha row reads from src.a after splat)
  const lut = packLutBytes(rowR, rowG, rowB, rowA);
  return {
    nodes: [
      { type: 'feColorMatrix', inputs: [SRC_GRAPHIC], params: { matrix: splat } },
      { type: 'feComponentTransfer', inputs: [0], params: { lutBytes: lut } },
    ],
    rootOut: 1,
  };
}

// ────────────────────────────────────────────────────────────────
// Tritone — three-color luminance remap
// ────────────────────────────────────────────────────────────────
// Lottie "Tritone" layer effect: shadow→midtone→highlight remap of
// source luminance. `dark`, `mid`, `light` are RGBA colors; the
// table is a 3-stop ramp through them.
export function tritoneGraph(dark, mid, light) {
  const lumR = 0.299,
    lumG = 0.587,
    lumB = 0.114;
  const splat = [
    lumR,
    lumG,
    lumB,
    0,
    0,
    lumR,
    lumG,
    lumB,
    0,
    0,
    lumR,
    lumG,
    lumB,
    0,
    0,
    0,
    0,
    0,
    1,
    0,
  ];
  // 3-stop table per channel: at L=0 dark, L=0.5 mid, L=1 light.
  const rowR = bakeTableRow([dark[0], mid[0], light[0]]);
  const rowG = bakeTableRow([dark[1], mid[1], light[1]]);
  const rowB = bakeTableRow([dark[2], mid[2], light[2]]);
  const rowA = bakeTableRow([0, 1]);
  const lut = packLutBytes(rowR, rowG, rowB, rowA);
  return {
    nodes: [
      { type: 'feColorMatrix', inputs: [SRC_GRAPHIC], params: { matrix: splat } },
      { type: 'feComponentTransfer', inputs: [0], params: { lutBytes: lut } },
    ],
    rootOut: 1,
  };
}

// Internal: shared luminance-splat 4×5 matrix.
export const LUMA_SPLAT_MATRIX = Object.freeze([
  0.299, 0.587, 0.114, 0, 0, 0.299, 0.587, 0.114, 0, 0, 0.299, 0.587, 0.114, 0, 0, 0, 0, 0, 1, 0,
]);

// ────────────────────────────────────────────────────────────────
// Feather (Rive's single layer-effect primitive)
// ────────────────────────────────────────────────────────────────
// Rive's Feather is the *entire* layer-effect surface in one knob:
//   { strength, offsetX, offsetY, transformSpace }
// strength = Gaussian blur radius in transform-space; non-zero offset
// turns it into a drop shadow. transformSpace controls whether the
// blur scales with the shape's transform (0 = local / scales with
// transform; 1 = world / fixed in pixels).
//
// If the caller wants the SVG drop-shadow shape ("shape over its own
// blurred shadow") they should compose `featherGraph(...)` with a
// feMerge against SourceGraphic — same pattern as feDropShadow.
export function featherGraph(strengthX, strengthY = strengthX, offsetX = 0, offsetY = 0) {
  // strength is the spatial standard deviation (Gaussian σ), already a
  // radius per Rive's convention. Negative strength clamps to 0; σ ≤ 0.5
  // is a passthrough (handled by the feGaussianBlur dispatch).
  const sigmaX = Math.max(0, strengthX);
  const sigmaY = Math.max(0, strengthY);
  // Heterogeneous by design — feOffset's params are {dx,dy}, not {sigmaX,sigmaY}
  // — so the element type must not be inferred from the first entry.
  /** @type {{type: string, inputs: number[], params: object}[]} */
  const nodes = [{ type: 'feGaussianBlur', inputs: [SRC_GRAPHIC], params: { sigmaX, sigmaY } }];
  let root = 0;
  if (offsetX !== 0 || offsetY !== 0) {
    nodes.push({ type: 'feOffset', inputs: [0], params: { dx: offsetX, dy: offsetY } });
    root = 1;
  }
  return { nodes, rootOut: root };
}

// Drop-shadow shape: feather composited *under* the shape via
// feMerge(blurredOffset, SourceGraphic). Identical conceptual model
// to <feDropShadow> but with the Rive Feather parameter naming. Use
// when a Rive scene applies Feather + non-zero offset and expects
// the original shape to still be visible on top.
export function featherDropShadowGraph(strengthX, strengthY, offsetX, offsetY, color) {
  // Shadow chain: blur(sourceAlpha) → offset → flood-color tint → merge over source.
  const sigmaX = Math.max(0, strengthX);
  const sigmaY = Math.max(0, strengthY);
  const nodes = [
    // 0: blurred alpha (source-alpha, blurred)
    { type: 'feGaussianBlur', inputs: [-2], params: { sigmaX, sigmaY } },
    // 1: offset the blurred alpha
    { type: 'feOffset', inputs: [0], params: { dx: offsetX, dy: offsetY } },
    // 2: a flood of the shadow color
    { type: 'feFlood', inputs: [], params: { rgba: color } },
    // 3: composite flood "in" blurred-offset alpha → colored shadow
    { type: 'feComposite', inputs: [2, 1], params: { op: 1 } }, // op=1 = "in"
    // 4: merge (shadow under source)
    { type: 'feMerge', inputs: [3, -1], params: {} },
  ];
  return { nodes, rootOut: 4 };
}
