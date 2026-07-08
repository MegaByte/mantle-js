#version 300 es
// Box-blur kernel — used by the dispatch's 3-pass Gaussian
// approximation (Wells 1986, "Efficient Generation of Gaussian Masks";
// Kovacs 2011 closed-form radius). Three iterations of a box of
// radius r converge to a Gaussian with σ ≈ r·√(K/3) = r for K=3.
//
// Per Kovacs 2011 §5, the integer radius that best approximates σ
// with 3 box iterations is:
//   r = floor((√(12σ²/3 + 1) − 1) / 2)
// (computed CPU-side; this shader just samples a [-r, +r] box).
//
// Exploits hardware bilinear filtering: a single sample at offset
// (k + 0.5) averages texels k and k+1 in one fetch — halves the
// fetch count. Total samples per pixel per pass = r + 1 (center +
// r pair-fetches) instead of 2r+1. 3-pass box is O(r), so it beats
// the linear-sampled Gaussian (whose tap count grows with r) at large σ.

precision highp float;
uniform sampler2D uTex;
uniform vec2  uTexel;
uniform vec2  uDir;
uniform int   uRadius;     // box radius in pixels (per Kovacs σ→r formula)
in vec2 vUV;
out vec4 fragColor;

void main() {
  if (uRadius <= 0) { fragColor = texture(uTex, vUV); return; }
  vec4 acc = texture(uTex, vUV);
  // Pair fetches: sample at (k + 0.5) averages texels k and k+1.
  // Cover offsets 1..radius via pair fetches at 1.5, 3.5, ..., (k+0.5).
  // 32-fetch cap → supports radius up to 64.
  float n = 1.0;
  for (int k = 0; k < 32; ++k) {
    int off = 2 * k + 1;       // odd offsets only; pair-fetched
    if (off > uRadius) break;
    // Pair (off, off+1). When off+1 > radius, fall back to a single-texel
    // sample at integer offset `off` (the right-edge case below).
    float pairCount;            // how many texels this fetch averages
    float fOff;                 // sample offset (texel space)
    if (off + 1 <= uRadius) {
      fOff = float(off) + 0.5;  // bilinear midpoint of [off, off+1]
      pairCount = 2.0;
    } else {
      fOff = float(off);        // single texel at the right edge
      pairCount = 1.0;
    }
    vec2 d = uDir * uTexel * fOff;
    // Bilinear sample averages the two texels; multiply by 2 to get
    // their sum, then we divide by total count at the end.
    acc += texture(uTex, vUV + d) * pairCount;
    acc += texture(uTex, vUV - d) * pairCount;
    n += 2.0 * pairCount;
  }
  fragColor = acc / n;
}
