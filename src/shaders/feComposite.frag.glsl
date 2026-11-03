#version 300 es
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
// feComposite — Porter-Duff binary compositing (over, in, out, atop,
// xor) plus the SVG-specific `arithmetic` mode. Operates on
// premultiplied RGBA (filter-graph invariant; both inputs expected
// premultiplied).
//
// uOp encoding (matches importer):
//   0 = over   →  porterDuff mode 3   (src over dst)
//   1 = in     →  porterDuff mode 5   (src in)
//   2 = out    →  porterDuff mode 7   (src out)
//   3 = atop   →  porterDuff mode 9   (src atop)
//   4 = xor    →  porterDuff mode 11
//   5 = arithmetic   out = k1·in1·in2 + k2·in1 + k3·in2 + k4, per premultiplied channel
//
// The 5 Porter-Duff entries dispatch through the shared helper in
// _porterDuffHelpers.glsl (also used by paintComposite for the 12
// Colr pd modes). Arithmetic is SVG-specific and stays inline.

precision highp float;
uniform sampler2D uIn1;
uniform sampler2D uIn2;
uniform vec4 uIn1Map;     // vUV → uIn1 uv (see @@FILTER_RECT@@)
uniform vec4 uIn2Map;     // vUV → uIn2 uv — a DIFFERENT rect
uniform int uOp;
uniform vec4 uPD;        // Porter-Duff weights for operators 0..4 (see _porterDuffHelpers.glsl)
uniform vec4 uK;          // (k1, k2, k3, k4) for arithmetic mode
uniform int uCoverageResolve;
uniform int uCoveragePixelAligned;
uniform highp sampler2D uCoverageIn1;
uniform highp sampler2D uCoverageIn2;
uniform highp ivec2 uCoverageIn1Offset;
uniform highp ivec2 uCoverageIn2Offset;
uniform float uSourceCoverageScale;
uniform vec4 uSourceMaterialLo;
uniform vec4 uSourceMaterialHi;
uniform ivec2 uCsIn;      // per-input color-space conversion (csConvert)
in vec2 vUV;
out vec4 fragColor;

@@FILTER_RECT@@

@@PORTER_DUFF_HELPERS@@

const float COVERAGE_UNIT = 1.1920928955078125e-7;
const float COVERAGE_MIN_NORMAL = 1.1754943508222875e-38;

// Interval endpoints include storage, arithmetic and transfer-function error.
void coverageStoredBounds(vec4 value, out vec4 low, out vec4 high) {
  float u = COVERAGE_UNIT;
  vec3 encoded = csLinearToSrgb(clamp(value.rgb, 0.0, 1.0));
  vec3 codeLow = clamp(encoded - vec3(1.0 / 255.0 + 128.0 * u), 0.0, 1.0);
  vec3 codeHigh = clamp(encoded + vec3(1.0 / 255.0 + 128.0 * u), 0.0, 1.0);
  low = vec4(clamp(csSrgbToLinear(codeLow) - vec3(256.0 * u), 0.0, 1.0),
    clamp(value.a - 1.0 / 255.0 - 4.0 * u, 0.0, 1.0));
  high = vec4(clamp(csSrgbToLinear(codeHigh) + vec3(256.0 * u), 0.0, 1.0),
    clamp(value.a + 1.0 / 255.0 + 4.0 * u, 0.0, 1.0));
}

void coverageEncodeBounds(vec4 low, vec4 high, out vec4 encodedLow, out vec4 encodedHigh) {
  vec3 lo = vec3(0.0);
  vec3 hi = csConvert(high, 2).rgb;
  if (low.a > COVERAGE_MIN_NORMAL) lo = csConvert(low, 2).rgb;
  else hi = max(hi, high.rgb); // csConvert keeps RGB unchanged at alpha zero.
  encodedLow = vec4(max(vec3(0.0), lo - vec3(128.0 * COVERAGE_UNIT)), low.a);
  encodedHigh = vec4(min(vec3(1.0), hi + vec3(128.0 * COVERAGE_UNIT)), high.a);
}

void coverageTargetBounds(vec4 lowerLow, vec4 lowerHigh, vec4 materialLow,
    vec4 materialHigh, vec2 coverage, out vec4 targetLow, out vec4 targetHigh) {
  float u = COVERAGE_UNIT;
  vec3 linearLow = max(vec3(0.0), csSrgbToLinear(materialLow.rgb) - vec3(192.0 * u));
  vec3 linearHigh = min(vec3(1.0), csSrgbToLinear(materialHigh.rgb) + vec3(192.0 * u));
  vec4 coveredLow = vec4(materialLow.a * linearLow + (1.0 - materialHigh.a) * lowerLow.rgb,
    materialLow.a + (1.0 - materialHigh.a) * lowerLow.a);
  vec4 coveredHigh = vec4(materialHigh.a * linearHigh + (1.0 - materialLow.a) * lowerHigh.rgb,
    materialHigh.a + (1.0 - materialLow.a) * lowerHigh.a);
  coveredLow = clamp(coveredLow - vec4(8.0 * u), 0.0, 1.0);
  coveredHigh = clamp(coveredHigh + vec4(8.0 * u), 0.0, 1.0);
  vec4 underLow, underHigh, topLow, topHigh;
  coverageEncodeBounds(lowerLow, lowerHigh, underLow, underHigh);
  coverageEncodeBounds(coveredLow, coveredHigh, topLow, topHigh);
  targetLow = max(vec4(0.0), min(mix(underLow, topLow, coverage.x),
    mix(underLow, topLow, coverage.y)) - vec4(8.0 * u));
  targetHigh = min(vec4(1.0), max(mix(underHigh, topHigh, coverage.x),
    mix(underHigh, topHigh, coverage.y)) + vec4(8.0 * u));
}

void coverageRgbBounds(vec4 original, vec4 low, vec4 high, out vec3 rgbLow, out vec3 rgbHigh) {
  float alphaWidth = max(abs(original.a - low.a), abs(original.a - high.a)) + 8.0 * COVERAGE_UNIT;
  rgbLow = low.rgb - vec3(alphaWidth);
  rgbHigh = high.rgb + vec3(alphaWidth);
}

highp vec4 coverageFetch(highp sampler2D tex, highp ivec2 pixel) {
  highp ivec2 size = textureSize(tex, 0);
  if (any(lessThan(pixel, ivec2(0))) || any(greaterThanEqual(pixel, size))) return vec4(0.0);
  return texelFetch(tex, pixel, 0);
}

void coverageMeanAlphaBounds(vec4 source, float mean, vec4 fieldLow, vec4 fieldHigh,
    inout vec4 targetLow, inout vec4 targetHigh) {
  float u = COVERAGE_UNIT;
  float m = clamp(uSourceMaterialHi.a, 0.0, 1.0);
  if (m <= COVERAGE_MIN_NORMAL) return;
  float saturation = clamp(uSourceMaterialHi.a - 1.0, 0.0, 1.0);
  float q = uSourceCoverageScale / 255.0 + 16.0 * u + saturation;
  float aLow = max(0.0, source.a - q), aHigh = min(m, source.a + q);
  if (aLow > m || aHigh < aLow) return;
  float meanError = 1.0 / 255.0 + 516.0 * u;
  float meanLow = clamp(mean - meanError, 0.0, 1.0);
  float meanHigh = clamp(mean + meanError, 0.0, 1.0);
  float peak = clamp(0.5 * m, aLow, aHigh);
  float covariance = peak * (1.0 - peak / m) * (fieldHigh.a - fieldLow.a) + 32.0 * u;
  float low = max(0.0, aLow + (1.0 - aLow) * meanLow - covariance - 32.0 * u);
  float high = min(1.0, aHigh + (1.0 - aHigh) * meanHigh + covariance + 32.0 * u);
  float jointLow = max(targetLow.a, low), jointHigh = min(targetHigh.a, high);
  if (jointLow <= jointHigh) { targetLow.a = jointLow; targetHigh.a = jointHigh; }
}

vec4 coverageResolve(vec4 captured, vec4 lower, highp ivec2 center) {
  float sourceScale = uSourceCoverageScale;
  vec4 source = captured * sourceScale;
  vec4 ordinaryLinear = porterDuffK(uPD, csConvert(source, 1), lower);
  if (source.a <= 0.0 || source.a >= 1.0) return ordinaryLinear;
  vec4 ordinary = csConvert(ordinaryLinear, 2);
  float saturation = clamp(uSourceMaterialHi.a - 1.0, 0.0, 1.0);
  vec4 materialLow = clamp(uSourceMaterialLo, 0.0, 1.0);
  vec4 materialHigh = clamp(uSourceMaterialHi, 0.0, 1.0);
  materialLow = vec4(max(vec3(0.0), materialLow.rgb - vec3(saturation)), materialLow.a);
  materialHigh = vec4(min(vec3(1.0), materialHigh.rgb + vec3(saturation)), materialHigh.a);
  float aLow = max(0.0, source.a - sourceScale / 255.0 - 16.0 * COVERAGE_UNIT);
  float aHigh = min(1.0, source.a + sourceScale / 255.0 + 16.0 * COVERAGE_UNIT);
  float cLow = materialHigh.a > COVERAGE_MIN_NORMAL ? aLow / materialHigh.a : 0.0;
  float cHigh = materialLow.a > COVERAGE_MIN_NORMAL ? aHigh / materialLow.a : 1.0;
  vec2 coverage = clamp(vec2(cLow - saturation - 5.0 * COVERAGE_UNIT,
    cHigh + saturation + 5.0 * COVERAGE_UNIT), 0.0, 1.0);
  vec4 pointLow, pointHigh, pointTargetLow, pointTargetHigh;
  coverageStoredBounds(lower, pointLow, pointHigh);
  coverageTargetBounds(pointLow, pointHigh, materialLow, materialHigh, coverage, pointTargetLow, pointTargetHigh);
  vec3 pointRgbLow, pointRgbHigh;
  coverageRgbBounds(ordinary, pointTargetLow, pointTargetHigh, pointRgbLow, pointRgbHigh);
  if (all(greaterThanEqual(ordinary.rgb, pointTargetLow.rgb)) && all(lessThanEqual(ordinary.rgb, pointTargetHigh.rgb)))
    return ordinaryLinear;

  highp ivec2 size = textureSize(uCoverageIn2, 0);
  bool meanInside = all(greaterThanEqual(center, ivec2(0))) && all(lessThan(center, size));
  float lowerMean = 0.0;
  vec4 low = lower, high = lower;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    highp ivec2 q = center + ivec2(x, y);
    vec4 p = texelFetch(uCoverageIn2, clamp(q, ivec2(0), size - 1), 0);
    if (meanInside) lowerMean += (x == 0 ? 0.75 : 0.125) * (y == 0 ? 0.75 : 0.125) * p.a;
    if (any(lessThan(q, ivec2(0))) || any(greaterThanEqual(q, size))) p = vec4(0.0);
    low = min(low, p); high = max(high, p);
  }
  vec4 storedLow, storedHigh, targetLow, targetHigh;
  coverageStoredBounds(low, storedLow, storedHigh);
  vec4 unusedLow;
  coverageStoredBounds(high, unusedLow, storedHigh);
  coverageTargetBounds(min(storedLow, pointLow), max(storedHigh, pointHigh),
    materialLow, materialHigh, coverage, targetLow, targetHigh);
  // Explicit union preserves the point early-out even under endpoint rounding.
  targetLow = min(targetLow, pointTargetLow); targetHigh = max(targetHigh, pointTargetHigh);
  if (uCoveragePixelAligned != 0) coverageMeanAlphaBounds(source, lowerMean,
    min(storedLow, pointLow), max(storedHigh, pointHigh), targetLow, targetHigh);
  vec3 rgbLow, rgbHigh;
  coverageRgbBounds(ordinary, targetLow, targetHigh, rgbLow, rgbHigh);
  // The edge pixel is the coverage-weighted mix, in the encoded space, of the lower layer and of the layer covered by the full material
  // (an 8x supersampled edge averages its samples after they are encoded). The bounds only guard that estimate; clamping the linear
  // composite onto them instead leaves it at the nearest bound, which is wide wherever the lower layer varies.
  vec4 materialMid = 0.5 * (materialLow + materialHigh);
  float coverageMid = materialMid.a > COVERAGE_MIN_NORMAL ? clamp(source.a / materialMid.a, 0.0, 1.0) : 1.0;
  vec4 coveredLinear = vec4(materialMid.a * csSrgbToLinear(materialMid.rgb) + (1.0 - materialMid.a) * lower.rgb,
    materialMid.a + (1.0 - materialMid.a) * lower.a);
  vec4 estimate = mix(csConvert(lower, 2), csConvert(coveredLinear, 2), coverageMid);
  vec3 projected = clamp(estimate.rgb, rgbLow, rgbHigh);
  if (all(equal(projected, ordinary.rgb))) return ordinaryLinear;
  return csConvert(vec4(projected, ordinary.a), 1);
}

void main() {
  if (uCoverageResolve != 0 && uCoveragePixelAligned != 0) {
    highp ivec2 pixel = ivec2(floor(gl_FragCoord.xy));
    vec4 a = csConvert(coverageFetch(uCoverageIn1, pixel + uCoverageIn1Offset), uCsIn.x);
    highp ivec2 lowerPixel = pixel + uCoverageIn2Offset;
    fragColor = coverageResolve(a, coverageFetch(uCoverageIn2, lowerPixel), lowerPixel);
    return;
  }
  vec4 rawA = sampleIn(uIn1, mapIn(vUV, uIn1Map));
  vec4 rawB = sampleIn(uIn2, mapIn(vUV, uIn2Map));
  vec4 a = csConvert(rawA, uCsIn.x);
  vec4 b = csConvert(rawB, uCsIn.y);
  if (uCoverageResolve != 0) {
    fragColor = coverageResolve(a, rawB, ivec2(floor(mapIn(vUV, uIn2Map) * vec2(textureSize(uCoverageIn2, 0)))));
    return;
  }
  if (uOp == 5) {
    // arithmetic — on the PREMULTIPLIED channels, all four alike. Filter Effects 1's
    // primitives overview: "unless otherwise stated, all image filters operate on premultiplied
    // RGBA samples"; only feColorMatrix and feComponentTransfer say otherwise. It is also what
    // Chromium (Skia's arithmetic blender, enforcePMColor) and Gecko compute. Unpremultiplying
    // first gave a different picture whenever the inputs' alphas differ or k4 != 0. The result
    // is clamped to [0, 1], then its color to its alpha, so it is a valid premultiplied value.
    vec4 r = clamp(uK.x * a * b + uK.y * a + uK.z * b + vec4(uK.w), 0.0, 1.0);
    fragColor = vec4(min(r.rgb, vec3(r.a)), r.a);
    return;
  }
  // Operators 0..4 are the Porter-Duff modes 3 + 2·op (over, in, out, atop, xor), whose weights
  // the CPU sends as uPD (src/filterGraph/porterDuff.js).
  fragColor = porterDuffK(uPD, a, b);
}
