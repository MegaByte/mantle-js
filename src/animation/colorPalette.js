// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { deleteGlResource, trackGlResource } from '../renderer/contextResources.js';
// colorPalette.js — per-draw color palette LUT for indexed recoloring.
//
// Companion to colorMatrix.js. Where the matrix transforms colors
// linearly (continuous), the palette does discrete substitution:
// sample one channel of the shape's resolved fill, treat that as an
// index into a small RGBA8 lookup table, replace the output RGB.
// Alpha passthrough by default.
//
// Use cases (where color matrix can't help):
//   - Discrete color substitution: SVG content authored with N distinct
//     fill colors → look up each in a palette of N replacement colors.
//   - Theme palettes mutated per frame.
//   - Stylized rendering: posterization, palette-cycled gradients.
//
// The palette texture is mutable at will: rewrite the whole palette or
// any single entry every frame (`gl.texSubImage2D` for a 256×1 RGBA8 =
// ~1 KB upload). No re-binding or re-compilation needed.
//
// Composition with color matrix:
//   resolved vFill (post override + tint)
//   → palette lookup (replaces RGB, keeps A)   [opt-in via opts.palette]
//   → color matrix transform                    [opt-in via opts.colorMatrix]
//   → coverage modulation
//   → output
// Both are independent — caller can use either, both, or neither.
//
// Usage:
//   const palette = createPalette(gl, [
//     [255, 0,   0,   255],   // index 0 → red
//     [0,   255, 0,   255],   // index 1 → green
//     [0,   0,   255, 255],   // index 2 → blue
//     // ...up to 256 entries
//   ]);
//   renderer.drawBundle(bundle, { palette });
//
//   // Mutate per frame (cheap):
//   palette.set(0, [255, 128, 0, 255]);     // single entry
//   palette.update(newEntriesArray);         // bulk replace
//
//   palette.dispose();                       // releases GL texture

const PALETTE_WIDTH = 256;
const BYTES_PER_ENTRY = 4;

/** The palette createPalette returns. Declared because the public @returns
 *  names it and the generated .d.ts inherits that name (as in
 *  animation/overrides.js and textBundle.js).
 *
 *  @typedef {Object} MantleColorPalette
 *  @property {WebGLTexture} texture   256x1 RGBA8, NEAREST-sampled
 *  @property {number} size            entry count (PALETTE_WIDTH)
 *  @property {Uint8Array} _bytes      CPU mirror; WebGL2 has no getTexImage
 *  @property {(index: number, rgba: [number,number,number,number]) => void} set
 *    one entry; a 4-byte texSubImage2D, cheap enough to call per frame
 *  @property {(entries: Array<[number,number,number,number]>) => void} update
 *    replace the whole palette; entries past the new length reset to opaque
 *  @property {() => void} dispose
 */

/** One palette channel: a number in [0, 255] CLAMPED (300 is 255, -5 is 0; never wrapped) and truncated;
 *  a missing or non-numeric channel is `missing` (0 for r, g, b; 255 for alpha). */
function channel(v, missing) {
  v = v == null ? missing : +v;
  return v !== v ? missing : v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

/** Build a palette LUT from an array of [r, g, b, a] entries (each
 *  in [0, 255]). Up to PALETTE_WIDTH (256) entries; extra entries
 *  beyond 256 are ignored. Missing entries default to opaque black.
 *
 *  @param {WebGL2RenderingContext} gl
 *  @param {Array<[number,number,number,number]>} entries
 *  @returns {MantleColorPalette}
 */
export function createPalette(gl, entries) {
  if (!gl) throw new Error('createPalette: gl required');
  if (!Array.isArray(entries)) throw new Error('createPalette: entries must be an array');
  const bytes = new Uint8Array(PALETTE_WIDTH * BYTES_PER_ENTRY);
  // Default alpha=255 for unused slots so the dummy fallback path
  // doesn't paint with alpha=0 if the shader accidentally sampled.
  for (let i = 0; i < PALETTE_WIDTH; i++) bytes[i * 4 + 3] = 255;
  const cap = Math.min(entries.length, PALETTE_WIDTH);
  for (let i = 0; i < cap; i++) {
    const e = entries[i];
    if (!e) continue;
    bytes[i * 4 + 0] = channel(e[0], 0);
    bytes[i * 4 + 1] = channel(e[1], 0);
    bytes[i * 4 + 2] = channel(e[2], 0);
    bytes[i * 4 + 3] = channel(e[3], 255);
  }
  const tex = trackGlResource(gl, gl.createTexture(), 'overrides');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, PALETTE_WIDTH, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
  // NEAREST: the index is a discrete bucket; linear interpolation
  // between neighboring palette entries is a bug, not a feature
  // (palette entries are unrelated colors).
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  return {
    texture: tex,
    size: PALETTE_WIDTH,
    // CPU mirror of the palette bytes. Kept so single-entry mutation
    // doesn't have to round-trip through gl.getTexImage (which doesn't
    // exist in WebGL2 anyway).
    _bytes: bytes,

    /** Set one palette entry. Cheap — 4-byte gl.texSubImage2D update.
     *  Call as often as needed; no dirty-flag plumbing.
     *  @param {number} index  in [0, 255]
     *  @param {[number, number, number, number]} rgba in [0, 255]
     */
    set(index, rgba) {
      const i = index | 0;
      if (i < 0 || i >= PALETTE_WIDTH) return;
      bytes[i * 4 + 0] = channel(rgba[0], 0);
      bytes[i * 4 + 1] = channel(rgba[1], 0);
      bytes[i * 4 + 2] = channel(rgba[2], 0);
      bytes[i * 4 + 3] = channel(rgba[3], 255);
      const single = bytes.subarray(i * 4, i * 4 + 4);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, i, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, single);
    },

    /** Replace the whole palette. Bulk upload (~1 KB). Cheaper than
     *  256 individual `set` calls when most entries change.
     *  @param {Array<[number, number, number, number]>} entries
     */
    update(entries) {
      // Reset to alpha=255 default first so partial updates don't
      // carry stale colors past the new length.
      bytes.fill(0);
      for (let i = 0; i < PALETTE_WIDTH; i++) bytes[i * 4 + 3] = 255;
      const cap = Math.min(entries.length, PALETTE_WIDTH);
      for (let i = 0; i < cap; i++) {
        const e = entries[i];
        if (!e) continue;
        bytes[i * 4 + 0] = channel(e[0], 0);
        bytes[i * 4 + 1] = channel(e[1], 0);
        bytes[i * 4 + 2] = channel(e[2], 0);
        bytes[i * 4 + 3] = channel(e[3], 255);
      }
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, PALETTE_WIDTH, 1, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    },

    /** Release the GL texture. */
    dispose() {
      if (tex) deleteGlResource(gl, 'Texture', tex);
    },
  };
}
