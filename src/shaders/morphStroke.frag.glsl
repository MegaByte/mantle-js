#version 300 es
// Stroke coverage for the GPU-resident MORPH. This is an ANALYTIC SDF stroke,
// NOT the Loop-Blinn algorithm — LB is the FILL coverage (klmn/Bezout implicits,
// loopBlinnMorph.*). The morph VS lerps each segment's control points + neighbour
// tangents by uT (GPU-resident, no per-frame curve upload); this frag computes
// the EXACT analytic distance with caps/joins/dashes via the shared
// strokeCubicAccum (_strokeMath.glsl, the same code the ubershader's Slug stroke
// uses) over control points relative to the fragment, then the same AA falloff as
// mantle.frag's stroke. MAX-blended across segments. vStartDist (VS prefix-sum) =
// cumulative arc length to the subpath start.
precision highp float;
precision highp int;
precision highp sampler2D;  // uDashTex is RGBA32F em-space data (lowp default crushes it)

flat in vec2  vP0, vP1, vP2, vP3;
flat in float vHalfW, vMiterLimit;
flat in vec2  vInTan, vOutTan;        // prev/next neighbour tangents (joins)
flat in float vFreeStart, vFreeEnd;
flat in int   vCap, vJoin;            // cap: 0 butt·1 round·2 square; join: 0 miter·1 round·2 bevel
flat in float vStartDist;
in vec2 vEm;
out vec4 o;

uniform int       uDashId;            // 0 = no dash; >0 = uDashTex row (stroke-dasharray)
uniform sampler2D uDashTex;

@@CURVE_ARCLEN@@
@@BUNDLE_LAYOUT@@
@@STROKE_MATH@@

void main() {
  vec2 ePx = fwidth(vEm);
  float pxSize = max(0.5 * (ePx.x + ePx.y), 1e-6);
  // Control points relative to the fragment; free ends pass reach 1e9 (no
  // neighbour → strokeCapsJoinsDash takes the cap branch), joins pass 0 (finite).
  vec4 p12 = vec4(vP0 - vEm, vP1 - vEm);
  vec4 p34 = vec4(vP2 - vEm, vP3 - vEm);
  float reachS = vFreeStart > 0.5 ? 1e9 : 0.0;
  float reachE = vFreeEnd > 0.5 ? 1e9 : 0.0;
  // Arcs join: this segment's own morphed endpoint curvatures κ = cross(B',B'')/
  // |B'|³ (kSelfStart, kSelfEnd) — computed here from the morphed control points.
  // The neighbour curvatures (curv.z/.w) aren't reachable in the morph frag (only
  // one neighbour control point per side rides the VBO), so they stay 0 — arcs
  // reduces to miter for straight edges and uses this edge's real curvature for
  // curved ones. Non-arcs joins pass zero (unused).
  vec4 curv = vec4(0.0);
  if (vJoin == 4) {
    vec2 d1s = 3.0 * (vP1 - vP0), d2s = 6.0 * (vP0 - 2.0 * vP1 + vP2);
    vec2 d1e = 3.0 * (vP3 - vP2), d2e = 6.0 * (vP1 - 2.0 * vP2 + vP3);
    float ms = length(d1s), me = length(d1e);
    curv.x = ms > 1e-9 ? (d1s.x * d2s.y - d1s.y * d2s.x) / (ms * ms * ms) : 0.0;
    curv.y = me > 1e-9 ? (d1e.x * d2e.y - d1e.y * d2e.x) / (me * me * me) : 0.0;
  }
  float md = strokeCubicAccum(p12, p34, vFreeStart > 0.5, vFreeEnd > 0.5, vCap, vCap,
                              vJoin, vMiterLimit, vHalfW, vInTan, vOutTan,
                              uDashId, vStartDist, reachS, reachE, curv, 1e20);
  // AA falloff identical to mantle.frag's stroke (½px halfWVis floor + hairline fade).
  float halfWVis = max(vHalfW, 0.5 * pxSize);
  float weightFade = vHalfW / halfWVis;
  float dfe = md - halfWVis;
  float cov = (dfe <= 0.5 * pxSize) ? clamp(0.5 - dfe / pxSize, 0.0, 1.0) * weightFade : 0.0;
  if (cov <= 0.0) discard;
  o = vec4(cov);
}
