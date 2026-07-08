#version 300 es
// Vertex stage of the GPU-resident stroke-coverage pass for the MORPH. NOT the
// Loop-Blinn algorithm (that's the FILL coverage); this is the analytic SDF
// stroke. ONE band quad per outline segment (no separate join/cap primitives):
// the VS lerps the segment's control points + neighbour tangent points by uT
// (GPU-resident, no per-frame curve upload) and passes the morphed cubic +
// tangents + free-end flags to the frag, which calls the shared strokeCubicAccum.
// The band AABB grows to cover the miter reach (halfW·miterLimit) so a sharp
// miter tip isn't cropped. For dashes the VS prefix-sums preceding segments'
// MORPHED arc lengths within the subpath (resets at aContourStart) → vStartDist,
// using the shared cubicCoeff/slugCubicArcLen.
//
// VBO (4 floats / vertex): aPrimBase, aCorner(0..3), aSegFlags(freeStart|freeEnd<<1),
//   aContourStart (subpath first-segment texel, for the dash-phase reset).
// uPrim per segment = 6 texels:
//   [src P0,P1][src P2,P3][dst P0,P1][dst P2,P3][prevP2 src,dst][nextP1 src,dst].
precision highp float;
precision highp int;

layout(location=0) in float aPrimBase;
layout(location=1) in float aCorner;
layout(location=2) in float aSegFlags;
layout(location=3) in float aContourStart;

uniform highp sampler2D uPrim;
uniform int   uPrimW;
uniform float uT, uHalfW, uMiterLimit;
uniform int   uCapStyle, uJoinStyle, uDashId;
uniform vec4  uGlobalBBox;
uniform vec2  uCanvasAR;
uniform mat3  uWorldM;
uniform int   uHasWorldM;
uniform vec2  uViewportSize;

flat out vec2  vP0, vP1, vP2, vP3;
flat out float vHalfW, vMiterLimit;
flat out vec2  vInTan, vOutTan;
flat out float vFreeStart, vFreeEnd;
flat out int   vCap, vJoin;
flat out float vStartDist;
out vec2 vEm;

// VS needs ONLY the curve coeff + arc-length helpers (cubicCoeff, slugCubicArcLen)
// for the dash-phase prefix sum — NOT the stroke-distance math or dashCovered (so
// no uDashTex in the vertex stage). @@STROKE_MATH@@ lives in morphStroke.frag.
@@CURVE_ARCLEN@@

vec4 ftx(int i) { return texelFetch(uPrim, ivec2(i % uPrimW, i / uPrimW), 0); }
vec2 nrm(vec2 v) { return v / max(length(v), 1e-9); }
// Morphed arc length of segment at texel base b (shared cubicCoeff/slugCubicArcLen).
float segArcLen(int b) {
  vec4 s0 = ftx(b), s1 = ftx(b + 1), d0 = ftx(b + 2), d1 = ftx(b + 3);
  vec2 P0 = mix(s0.xy, d0.xy, uT), P1 = mix(s0.zw, d0.zw, uT);
  vec2 P2 = mix(s1.xy, d1.xy, uT), P3 = mix(s1.zw, d1.zw, uT);
  return slugCubicArcLen(cubicCoeff(P0.x, P1.x, P2.x, P3.x), cubicCoeff(P0.y, P1.y, P2.y, P3.y), 1.0);
}

void main() {
  int base = int(aPrimBase + 0.5);
  vec4 s0 = ftx(base), s1 = ftx(base + 1), d0 = ftx(base + 2), d1 = ftx(base + 3), nb = ftx(base + 4), nx = ftx(base + 5);
  vec2 P0 = mix(s0.xy, d0.xy, uT), P1 = mix(s0.zw, d0.zw, uT);
  vec2 P2 = mix(s1.xy, d1.xy, uT), P3 = mix(s1.zw, d1.zw, uT);
  vec2 prevP2 = mix(nb.xy, nb.zw, uT), nextP1 = mix(nx.xy, nx.zw, uT);
  vP0 = P0; vP1 = P1; vP2 = P2; vP3 = P3;
  vHalfW = uHalfW; vMiterLimit = max(uMiterLimit, 1.0);
  vCap = uCapStyle; vJoin = uJoinStyle;
  int fl = int(aSegFlags + 0.5);
  vFreeStart = float(fl & 1); vFreeEnd = float((fl >> 1) & 1);
  vInTan = nrm(P0 - prevP2); vOutTan = nrm(nextP1 - P3);

  vStartDist = 0.0;
  if (uDashId > 0) {
    int segIdx = base / 6, startSeg = int(aContourStart + 0.5) / 6;
    for (int j = 0; j < 4096; j++) { int jj = startSeg + j; if (jj >= segIdx) break; vStartDist += segArcLen(jj * 6); }
  }

  vec2 mn = min(min(P0, P1), min(P2, P3)), mx = max(max(P0, P1), max(P2, P3));
  float emPerPx = uGlobalBBox.z / max(uCanvasAR.x * uViewportSize.x, 1.0);
  // Band reach = the stroke half-width, PLUS (miter joins only) the ACTUAL per-join
  // miter extent — NOT the worst-case halfW·miterLimit. This mirrors the frag's
  // strokeCapsJoinsDash exactly: miterLen = halfW/cosHalf, used iff ≤ halfW·limit
  // (else the join bevels → halfW). On a smooth curve (cosHalf≈1) this collapses to
  // ~halfW instead of up to 8×halfW, so far fewer fragments are discarded. Round/
  // bevel joins + caps never exceed halfW. (+3px AA margin.)
  float reach = uHalfW;
  if (uJoinStyle == 0) {
    float worst = uHalfW * max(uMiterLimit, 1.0);
    vec2 dS = P1 - P0, dE = P3 - P2;
    float mS = uHalfW, mE = uHalfW;
    if (vFreeStart < 0.5) {
      if (length(dS) < 1e-6) mS = worst;   // degenerate start tangent → conservative
      else { float ch = sqrt(max(0.5 * (1.0 + dot(-nrm(dS), vInTan)), 1e-9));
             float m = uHalfW / max(ch, 1e-6); mS = (m <= worst) ? m : uHalfW; }
    }
    if (vFreeEnd < 0.5) {
      if (length(dE) < 1e-6) mE = worst;
      else { float ch = sqrt(max(0.5 * (1.0 + dot(nrm(dE), -vOutTan)), 1e-9));
             float m = uHalfW / max(ch, 1e-6); mE = (m <= worst) ? m : uHalfW; }
    }
    reach = max(mS, mE);
  }
  reach += 3.0 * emPerPx;
  mn -= vec2(reach); mx += vec2(reach);
  int ci = int(aCorner + 0.5);
  vec2 emPos = (ci == 0) ? mn : (ci == 1) ? vec2(mx.x, mn.y) : (ci == 2) ? mx : vec2(mn.x, mx.y);

  vEm = emPos;
  vec2 uv = (emPos - uGlobalBBox.xy) / uGlobalBBox.zw;
  vec2 plane = (uv * 2.0 - 1.0) * uCanvasAR;
  vec3 clip3 = vec3(plane.x, -plane.y, 1.0);
  if (uHasWorldM == 1) clip3 = uWorldM * clip3;
  gl_Position = vec4(clip3.xy, 0.0, clip3.z);
}
