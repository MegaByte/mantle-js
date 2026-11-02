// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// core/premultiply.js — straight RGBA8 -> premultiplied RGBA8, the one conversion every raster upload uses.
//
// A texture that is filtered (bilinear, mip, anisotropic) must hold PREMULTIPLIED texels: the blend of a red texel and a
// transparent texel whose stored RGB is 0 is red at half alpha, not half-dark red. The renderer's raster textures
// (createImage / drawImage, and the bundle's image atlas that a raster <image>, a raster <pattern> tile and a color-bitmap glyph
// sample) are therefore premultiplied at upload and the shader un-premultiplies after the filter where it needs a straight
// color (the tint and the later premultiply). Rounding is to nearest, which is what a browser does for a DOM image source
// (UNPACK_PREMULTIPLY_ALPHA_WEBGL), so an ImageBitmap and the same pixels as an array agree.

/// A premultiplied copy of `u8` (RGBA8, straight alpha), or `u8` itself when every alpha is 255. Never writes `u8`.
export function premultiplyRgba8(u8) {
  let opaque = true;
  for (let i = 3; i < u8.length; i += 4) {
    if (u8[i] !== 255) {
      opaque = false;
      break;
    }
  }
  if (opaque) return u8;
  const out = new Uint8Array(u8);
  for (let i = 0; i < out.length; i += 4) {
    const a = out[i + 3];
    if (a === 255) continue;
    // round(c * a / 255) in integers: t = c * a + 128; (t + (t >> 8)) >> 8.
    let t = out[i] * a + 128;
    out[i] = (t + (t >> 8)) >> 8;
    t = out[i + 1] * a + 128;
    out[i + 1] = (t + (t >> 8)) >> 8;
    t = out[i + 2] * a + 128;
    out[i + 2] = (t + (t >> 8)) >> 8;
  }
  return out;
}
