// _paintSample.glsl — gradient paint sampling, shared (spliced via @@PAINT_SAMPLE@@)
// between the Slug fill and the Loop-Blinn direct path. Requires
// @@GRADIENT_HELPERS@@ (sampleStops, gradientSpreadToExtend) included before it,
// and the includer to declare `uniform sampler2D uGradientTex;`. Guarded so the
// solid-only fill variant drops it.
#ifndef MANTLE_NO_GRADIENT
// Compute paint color for a gradient at an em coord with a shape bbox. gid is 1-based.
vec4 sampleGradient(int gid, vec2 emCoord, vec4 shapeBB) {
  int row = gid - 1;
  vec4 g0 = texelFetch(uGradientTex, ivec2(GR_G0, row), 0);
  vec4 g1 = texelFetch(uGradientTex, ivec2(GR_G1, row), 0);
  vec4 g2 = texelFetch(uGradientTex, ivec2(GR_G2, row), 0);
  vec4 g3 = texelFetch(uGradientTex, ivec2(GR_G3, row), 0);
  int gType = int(g0.x + 0.5);
  int spread = int(g0.y + 0.5);
  float unitsFlag = g0.z;
  // Texel 2 (g2) slots zw carry (stopsOffset, stopsCount) — pointers
  // into uGradientStops. Replaces the per-gradient ramp atlas row.
  int stopsOffset = int(g2.z + 0.5);                    // TEXEL offset into uGradientStops
  // stopsCount is signed (negative = 1-texel opaque fast path) — round away
  // from zero so the magnitude survives for negatives.
  int stopsCount  = int(g2.w >= 0.0 ? g2.w + 0.5 : g2.w - 0.5);
  vec2 gp = emCoord;
  if (unitsFlag > 0.5) {
    vec2 bboxMin = shapeBB.xy;
    vec2 bboxSize = max(shapeBB.zw - bboxMin, vec2(1e-6));
    gp = (emCoord - bboxMin) / bboxSize;
  }
  float ax = g1.x, ay = g1.y, bx = g1.z, by = g1.w;
  float ex = g2.x, ey = g2.y;
  vec2 gpos = vec2(ax * gp.x + bx * gp.y + ex,
                   ay * gp.x + by * gp.y + ey);
  float t;
  if (gType == 0) {
    vec2 p1 = g3.xy;
    vec2 p2 = g3.zw;
    vec2 d = p2 - p1;
    float dd = max(dot(d, d), 1e-12);
    t = dot(gpos - p1, d) / dd;
  } else {
    vec2 c = g3.xy;
    float r = g3.z;
    float fxFrac = g3.w;
    float fyFrac = g0.w;
    vec2 f = c + vec2(fxFrac, fyFrac) * r;
    vec2 d = gpos - f;
    vec2 cf = c - f;
    float A = dot(d, d);
    float B = 2.0 * dot(cf, d);
    float C = dot(cf, cf) - r * r;
    float disc = B * B - 4.0 * A * C;
    if (disc < 0.0 || A < 1e-12) return vec4(0);
    float tParam = (B + sqrt(disc)) / (2.0 * A);
    t = 1.0 / tParam;
  }
  return sampleStops(t, stopsOffset, stopsCount, gradientSpreadToExtend(spread));
}
#endif
