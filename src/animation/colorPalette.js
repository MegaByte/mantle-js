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
    bytes[i * 4 + 0] = e[0] | 0;
    bytes[i * 4 + 1] = e[1] | 0;
    bytes[i * 4 + 2] = e[2] | 0;
    bytes[i * 4 + 3] = (e[3] == null ? 255 : e[3]) | 0;
  }
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, PALETTE_WIDTH, 1, 0,
                gl.RGBA, gl.UNSIGNED_BYTE, bytes);
  // NEAREST: the index is a discrete bucket; linear interpolation
  // between neighbouring palette entries is a bug, not a feature
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
      bytes[i * 4 + 0] = rgba[0] | 0;
      bytes[i * 4 + 1] = rgba[1] | 0;
      bytes[i * 4 + 2] = rgba[2] | 0;
      bytes[i * 4 + 3] = (rgba[3] == null ? 255 : rgba[3]) | 0;
      const single = bytes.subarray(i * 4, i * 4 + 4);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, i, 0, 1, 1,
                       gl.RGBA, gl.UNSIGNED_BYTE, single);
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
        bytes[i * 4 + 0] = e[0] | 0;
        bytes[i * 4 + 1] = e[1] | 0;
        bytes[i * 4 + 2] = e[2] | 0;
        bytes[i * 4 + 3] = (e[3] == null ? 255 : e[3]) | 0;
      }
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, PALETTE_WIDTH, 1,
                       gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    },

    /** Release the GL texture. */
    dispose() {
      if (tex) gl.deleteTexture(tex);
    },
  };
}
