#version 300 es
// feMorphology — separable per-channel max (dilate) / min (erode) over
// a rectangular kernel of pixel radius uRadius along uDir. Two-pass:
// horizontal then vertical. Premultiplied RGBA is preserved.
//
// SVG Filter Effects § feMorphology mandates `operator="erode"` to take
// the per-channel minimum and `operator="dilate"` to take the maximum.
// We compute per-channel min/max so colored inputs morph correctly
// (matching Chromium and Firefox).
precision highp float;
uniform sampler2D uTex;
uniform vec2  uTexel;     // 1 / textureSize
uniform vec2  uDir;       // (1,0) horizontal pass, (0,1) vertical pass
uniform float uRadius;    // pixels along the current axis; <0.5 → identity
uniform int   uOperator;  // 0 = erode (min), 1 = dilate (max)
in vec2 vUV;
out vec4 fragColor;

void main() {
  if (uRadius < 0.5) { fragColor = texture(uTex, vUV); return; }
  // Cap the kernel at 64 px/axis for performance. MUST match the C#
  // MantleFilterFeMorphology cap + rounding (ceil) so dilate/erode of a
  // radius in 33..64 px renders identically on both runtimes; beyond 64 px
  // the result is thick-stroke emulation where extra reach past the
  // silhouette doesn't matter visually.
  int r = int(min(ceil(uRadius), 64.0));
  // Erode picks the lowest sample (alpha collapses around silhouette
  // edges). Dilate picks the highest. We start with the center sample
  // so the running accumulator is always a real RGBA point on the
  // input surface (not an artificial sentinel).
  vec4 acc = texture(uTex, vUV);
  for (int i = 1; i <= 64; ++i) {
    if (i > r) break;
    vec2 d = uDir * uTexel * float(i);
    vec4 p = texture(uTex, vUV + d);
    vec4 n = texture(uTex, vUV - d);
    if (uOperator == 1) {
      acc = max(acc, max(p, n));   // dilate
    } else {
      acc = min(acc, min(p, n));   // erode
    }
  }
  fragColor = acc;
}
