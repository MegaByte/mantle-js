#version 300 es
// feGaussianBlur — separable two-pass blur using linear-sampled Gaussian
// (Rákos 2010, "Efficient Gaussian Blur With Linear Sampling").
//
// Naive Gaussian samples each integer offset within ±3σ. By exploiting
// hardware bilinear filtering, we can combine adjacent texel pairs into
// a single weighted bilinear fetch:
//
//   For weights w(i), w(i+1) at integer offsets i, i+1,
//     combined_weight = w(i) + w(i+1)
//     combined_offset = (i·w(i) + (i+1)·w(i+1)) / combined_weight
//
// The texture unit interpolates between the two texels at the fractional
// offset, yielding exactly w(i)·tex[i] + w(i+1)·tex[i+1] in one sample.
// We halve the tap count without changing the output (modulo bilinear
// rounding, negligible for premultiplied RGBA8).
//
// Pairing scheme:
//   - Center tap at i=0 stays alone.
//   - Symmetric pairs (1,2), (3,4), (5,6), ... are merged on each side.
//
// Truncation: ±3σ covers 99.7% of the Gaussian; pure floating-point
// truncation at the boundary is what SVG / Skia / Firefox all do.
// Cap is 16 sample fetches per side (≈32 original taps, σ ≤ ~10).
// For σ > 10 the implementation falls back on truncation.
precision highp float;
uniform sampler2D uTex;
uniform vec2  uTexel;     // 1 / inRect.size — one CANVAS pixel, in input uv
uniform vec4  uInMap;     // vUV → input uv (see @@FILTER_RECT@@)
uniform vec2  uDir;       // (1,0) horizontal, (0,1) vertical
uniform float uSigma;     // pixels along current axis; <=0.5 → identity
in vec2 vUV;
out vec4 fragColor;

@@FILTER_RECT@@

void main() {
  vec2 uv = mapIn(vUV, uInMap);
  if (uSigma <= 0.5) { fragColor = sampleIn(uTex, uv); return; }
  float twoS2 = 2.0 * uSigma * uSigma;
  // Naive radius in integer-tap units, ±3σ truncation, ≤32.
  int radius = int(min(ceil(uSigma * 3.0), 32.0));
  // Center tap.
  vec4 acc = sampleIn(uTex, uv);
  float wsum = 1.0;
  // Iterate pairs (1,2), (3,4), ..., up to (radius-1, radius) or
  // (radius, radius+1) depending on parity. Hard cap at 16 pairs.
  for (int k = 0; k < 16; ++k) {
    int i0 = 2 * k + 1;
    int i1 = i0 + 1;
    if (i0 > radius) break;
    float w0 = exp(-float(i0 * i0) / twoS2);
    // Boundary case: if i1 is past the truncation radius, treat its
    // weight as 0 — the pair degenerates to a plain integer tap at i0.
    float w1 = (i1 <= radius) ? exp(-float(i1 * i1) / twoS2) : 0.0;
    float wPair = w0 + w1;
    // Combined fractional offset between i0 and i1 weighted by their
    // contributions. When w1=0 this collapses to exactly i0.
    float offset = (float(i0) * w0 + float(i1) * w1) / wPair;
    vec2 d = uDir * uTexel * offset;
    acc += sampleIn(uTex, uv + d) * wPair;
    acc += sampleIn(uTex, uv - d) * wPair;
    wsum += 2.0 * wPair;
  }
  fragColor = acc / wsum;
}
