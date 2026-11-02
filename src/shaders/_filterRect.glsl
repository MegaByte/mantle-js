// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Rect addressing for filter-graph passes.
//
// Every filter RT covers a RECT of the canvas — an origin and a size in canvas
// pixels, always 1:1 with them. A filter pass may crop or translate its output,
// never rescale it. Nothing in an SVG filter graph resamples.

// So an input's uv is an explicit affine remap of vUV, supplied per input:
//
//   uInMap.xy = outRect.size / inRect.size
//   uInMap.zw = (outRect.origin - inRect.origin) / inRect.size
//   uvIn      = vUV * uInMap.xy + uInMap.zw
//
// Both rects the whole canvas → (1, 1, 0, 0), and uvIn is vUV bit-for-bit.
//
// A primitive is transparent black OUTSIDE its subregion (Filter Effects §7), so
// a tap landing off the input's rect must read 0 — not the clamped edge texel,
// which would smear the border outward. sampleIn masks instead of branching;
// with premultiplied RGBA, 0 is the identity every downstream operator wants.
vec2 mapIn(vec2 uv, vec4 m) {
  return uv * m.xy + m.zw;
}

vec4 sampleIn(sampler2D tex, vec2 uv) {
  vec2 s = step(vec2(0.0), uv) * step(uv, vec2(1.0));
  return texture(tex, uv) * (s.x * s.y);
}

// COLOR SPACE (color-interpolation-filters, Filter Effects 1 §15.8). A filter RT holds premultiplied RGBA in the space its primitive
// produced it in (sRGB or linearRGB); a primitive that operates in the other space converts what it reads. mode 0 = none,
// 1 = sRGB -> linear, 2 = linear -> sRGB. Alpha is untouched: unpremultiply, convert, premultiply.
vec3 csSrgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
vec3 csLinearToSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
vec4 csConvert(vec4 p, int mode) {
  if (mode == 0 || p.a <= 0.0) return p;
  vec3 c = clamp(p.rgb / p.a, 0.0, 1.0);
  c = mode == 1 ? csSrgbToLinear(c) : csLinearToSrgb(c);
  return vec4(c * p.a, p.a);
}
