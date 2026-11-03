// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// colorMatrix.js — build 4×4 color matrices + offset for the per-draw
// recolor path.
//
// Renderer expects column-major mat4 (16 floats) + vec4 offset (4 floats).
// Apply as `out = M * in + offset`, then clamp to [0, 1] in the
// fragment shader. Input vFill is straight (non-premultiplied) RGBA.
//
// Usage:
//   import { dualTint, identity } from '@kontek/mantle';
//   const { matrix, offset } = dualTint(
//     [0.92, 0.09, 0.41, 1.0],  // primary  (mapped from R channel)
//     [0.0,  0.0,  0.0,  1.0],  // contrast (mapped from B channel)
//   );
//   renderer.drawBundle(bundle, {
//     worldMatrix: id,
//     colorMatrix: matrix,
//     colorMatrixOffset: offset,
//   });

const _ID_MATRIX = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const _ID_OFFSET = new Float32Array(4);

/** Identity recolor (passthrough). */
export function identity() {
  return {
    matrix: new Float32Array(_ID_MATRIX),
    offset: new Float32Array(_ID_OFFSET),
  };
}

/** Dual-tint recolor: input R channel selects `primary`, input B
 *  channel selects `contrast`. Output alpha = input alpha (so
 *  per-shape fill alpha + opts.alpha still gate the AA edge / fade).
 *
 *  Channel encoding: body painted `fill="#FF0000"` takes the primary
 *  tint, accents painted `fill="#0000FF"` take the contrast tint; the
 *  green channel is ignored. For the 3-tint variant that preserves
 *  green-channel highlights toward white, see `tripleTint`.
 *
 *  Out-of-gamut input (e.g. R+G+B = (1, 1, 1) white) sums all tints;
 *  the fragment shader clamps to [0, 1].
 *
 *  @param {[number, number, number, number]} primary  rgba in [0, 1]
 *  @param {[number, number, number, number]} contrast rgba in [0, 1]
 *  @returns {{ matrix: Float32Array, offset: Float32Array }}
 */
export function dualTint(primary, contrast) {
  // Output row r: primary.r * in.r + contrast.r * in.b
  // Output row g: primary.g * in.r + contrast.g * in.b
  // Output row b: primary.b * in.r + contrast.b * in.b
  // Output row a: in.a (passthrough)
  //
  // Column-major mat4 layout (GLSL): column N starts at index N*4.
  // For `out = M * in`:
  //   M[col_r] contributes to all out rows from in.r
  //   M[col_g] contributes to all out rows from in.g
  //   M[col_b] contributes to all out rows from in.b
  //   M[col_a] contributes to all out rows from in.a
  return {
    matrix: new Float32Array([
      // col 0 (in.r → out)
      primary[0],
      primary[1],
      primary[2],
      0,
      // col 1 (in.g → out) — zero, no green contribution to body color
      0,
      0,
      0,
      0,
      // col 2 (in.b → out)
      contrast[0],
      contrast[1],
      contrast[2],
      0,
      // col 3 (in.a → out) — alpha passthrough
      0,
      0,
      0,
      1,
    ]),
    offset: new Float32Array([0, 0, 0, 0]),
  };
}

/** Triple-tint recolor: R selects `primary`, G selects `highlight`,
 *  B selects `contrast`. Output alpha = input alpha. The 3-channel
 *  generalization of `dualTint` — preserves green-encoded highlights.
 *  Useful when SVG content carries per-pixel shading in its green channel.
 *
 *  Lerp-to-white via the green channel: pass `[1, 1, 1, 1]` for
 *  `highlight` to get the classic "shading toward white".
 *
 *  @param {[number, number, number, number]} primary
 *  @param {[number, number, number, number]} highlight
 *  @param {[number, number, number, number]} contrast
 *  @returns {{ matrix: Float32Array, offset: Float32Array }}
 */
export function tripleTint(primary, highlight, contrast) {
  return {
    matrix: new Float32Array([
      // col 0 (in.r → out)
      primary[0],
      primary[1],
      primary[2],
      0,
      // col 1 (in.g → out)
      highlight[0],
      highlight[1],
      highlight[2],
      0,
      // col 2 (in.b → out)
      contrast[0],
      contrast[1],
      contrast[2],
      0,
      // col 3 (in.a → out)
      0,
      0,
      0,
      1,
    ]),
    offset: new Float32Array([0, 0, 0, 0]),
  };
}

/** Monochrome (luminance) recolor: collapse RGB to a single tint
 *  weighted by perceptual luminance (Rec. 709 coefficients), then
 *  scale by `color`. Alpha passthrough.
 *
 *  @param {[number, number, number, number]} color tint applied to the
 *    monochrome output. Defaults to white (true grayscale).
 */
export function monochrome(color = [1, 1, 1, 1]) {
  const [lr, lg, lb] = [0.2126, 0.7152, 0.0722];
  return {
    matrix: new Float32Array([
      lr * color[0],
      lr * color[1],
      lr * color[2],
      0,
      lg * color[0],
      lg * color[1],
      lg * color[2],
      0,
      lb * color[0],
      lb * color[1],
      lb * color[2],
      0,
      0,
      0,
      0,
      1,
    ]),
    offset: new Float32Array([0, 0, 0, 0]),
  };
}

/** Build parameters for the renderer's `channelLerp` recolor option.
 *
 *  Formula:
 *    tint = R·primary + B·contrast
 *    out  = mix(tint, highlight, G + 1 - A)
 *
 *  Preserves WHITE pixels (R=G=B=1 → highlight) while recoloring R/B
 *  channel-encoded body/accent regions. The non-linearity (R·G, B·G,
 *  R·A, B·A cross terms) can't be expressed via the linear
 *  `colorMatrix*` family — `channelLerp` is the dedicated path.
 *
 *  Pass this object directly to `drawBundle({ channelLerp: ... })`.
 *
 *  @param {[number, number, number, number]} primary
 *  @param {[number, number, number, number]} contrast
 *  @param {[number, number, number, number]} [highlight=[1,1,1,1]]
 *  @returns {{primary: number[], contrast: number[], highlight: number[]}}
 */
export function channelLerpParams(primary, contrast, highlight) {
  return {
    primary: primary,
    contrast: contrast,
    highlight: highlight || [1, 1, 1, 1],
  };
}

/** Compose two color-matrix transforms: apply B then A.
 *  `combine(A, B)` produces a transform whose effect is `A(B(in))`.
 *  Both matrices in column-major mat4 form.
 *
 *  @param {{matrix: Float32Array, offset: Float32Array}} a
 *  @param {{matrix: Float32Array, offset: Float32Array}} b
 *  @returns {{matrix: Float32Array, offset: Float32Array}}
 */
export function combine(a, b) {
  // out = A * (B * in + b.offset) + a.offset
  //     = (A*B) * in + (A * b.offset + a.offset)
  const A = a.matrix,
    B = b.matrix;
  const M = new Float32Array(16);
  // Column-major mat4 product: M[col=i] = A * B[col=i].
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      let s = 0;
      for (let k = 0; k < 4; k++) {
        // A[row=j, col=k] * B[row=k, col=i]
        s += A[k * 4 + j] * B[i * 4 + k];
      }
      M[i * 4 + j] = s;
    }
  }
  // A * b.offset (treat b.offset as a vec4).
  const bOff = b.offset;
  const newOff = new Float32Array(4);
  for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let c = 0; c < 4; c++) s += A[c * 4 + r] * bOff[c];
    newOff[r] = s + a.offset[r];
  }
  return { matrix: M, offset: newOff };
}
