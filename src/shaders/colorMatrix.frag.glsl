#version 300 es
// feColorMatrix as a generic full-screen pass for the filter-graph
// walker, operating on an arbitrary input RT between graph nodes.
//
// The matrix is a row-major 4×5 transform applied to UNpremultiplied
// RGBA per CSS Filter Effects §11.3 (color-matrix operates in straight-
// alpha space, then we re-premultiply on output to keep the filter
// graph's premultiplied-RGBA invariant).
//
// Uniforms:
//   uM0..uM3 — the four 4-vector rows of the matrix
//   uMOff    — per-row bias column (alpha-row bias in .w)
precision highp float;
uniform sampler2D uTex;
uniform vec4 uM0;
uniform vec4 uM1;
uniform vec4 uM2;
uniform vec4 uM3;
uniform vec4 uMOff;
in vec2 vUV;
out vec4 fragColor;

void main() {
  vec4 src = texture(uTex, vUV);
  // Source is premultiplied (filter-graph invariant). Unpremultiply,
  // matrix-transform, re-premultiply.
  vec3 rgb = src.a > 0.0 ? src.rgb / src.a : src.rgb;
  vec4 c = vec4(rgb, src.a);
  vec4 o;
  o.r = dot(uM0, c) + uMOff.x;
  o.g = dot(uM1, c) + uMOff.y;
  o.b = dot(uM2, c) + uMOff.z;
  o.a = dot(uM3, c) + uMOff.w;
  o = clamp(o, 0.0, 1.0);
  fragColor = vec4(o.rgb * o.a, o.a);
}
