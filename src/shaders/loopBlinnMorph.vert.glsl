#version 300 es
// loopBlinnMorph.vert.glsl — GPU-resident Loop-Blinn morph vertex stage.
//
// Lerps em-space control points between two endpoint shapes by uT and
// RECOMPUTES the per-curve klmn implicit (cubics, p1000-loop §4.4) and
// straight-edge normals (strips) per frame, so a morph reuses ONE static mesh
// with zero CPU rebuild. Produces exactly the varyings loopBlinn.frag.glsl
// consumes, so it shares that coverage stage unchanged.
//
// Lean morph layout (10 floats / vertex):
//   loc0 aPosSrc vec2   em-space position at t=0
//   loc1 aPosDst vec2   em-space position at t=1
//   loc2 aFlags  vec2   (kind, sign)
//   loc3 aParam  vec4   quad:(u,v,_,_) · cubic:(primTexel,ctrlIdx,_,_)
//                       · strip:(primTexel,dilate,outwardSign,_)
// uPrim holds per-primitive control points (src texels then dst texels):
//   cubic → 4 texels [P0,P1][P2,P3] src, [P0,P1][P2,P3] dst
//   strip → 2 texels [p1,p2] src, [p1,p2] dst

layout(location=0) in vec2 aPosSrc;
layout(location=1) in vec2 aPosDst;
layout(location=2) in vec2 aFlags;
layout(location=3) in vec4 aParam;

uniform float uT;               // morph parameter [0,1]
uniform highp sampler2D uPrim;  // per-primitive control points
uniform int  uPrimW;            // primData texel width

uniform vec4 uGlobalBBox;       // [xmin, ymin, w, h] em-space
uniform vec2 uCanvasAR;         // aspect-ratio correction
uniform mat3 uWorldM;           // per-draw world transform (column-major)
uniform int  uHasWorldM;
uniform vec2 uViewportSize;     // drawing-buffer px (strip AA dilation)
uniform vec4 uColor;            // solid paint

out vec2 vEm;
out vec3 vTC;
flat out float vKind;
flat out float vSign;
flat out vec3  cM00;
flat out vec3  cM01;
flat out vec3  cM02;
flat out float cM11a;
flat out float cM12;
flat out float cM22;
flat out vec2  cCen;
flat out float cScale;
flat out float cHalf;   // kind-7 annulus half-width — static-only, unused by morph
flat out float vEmPerPx; // em per device pixel — analytic ∇f for the interior/strip line-edge ramps
flat out float vTP;      // kind-8 corner cap payload — unused by morph (no caps), keep for shared frag
flat out float vSeam;    // kind-1 tangent-clip payload — unused by morph, keep for shared frag
flat out vec2  vNa;      // kind-1 crescent clip normals for the shared frag; morph derives them
flat out vec2  vNb;      // per-frame from the lerped control points (arc tangents, no neighbour data)
flat out vec3  vLine2;   // kind-0 second-line combined coverage — not wired on the morph path
flat out float vLineT;
flat out vec4  vColor;

vec4 fetchTexel(int idx) { return texelFetch(uPrim, ivec2(idx % uPrimW, idx / uPrimW), 0); }

// klmn for control point `idx` (0..3) of an integral cubic (d's normalized to
// O(1) before cubing for fp32 accuracy; serpentine orientation flip folded in).
// Caller guarantees a non-degenerate cubic (Bezout-fallback cubics never reach
// the GPU path); a transient near-cusp at intermediate t self-clamps in the
// fragment coverage.
vec3 cubicKLMN(vec2 P0, vec2 P1, vec2 P2, vec2 P3, int idx) {
  vec2 C1 = -3.0 * P0 + 3.0 * P1;
  vec2 C2 =  3.0 * P0 - 6.0 * P1 + 3.0 * P2;
  vec2 C3 = -P0 + 3.0 * P1 - 3.0 * P2 + P3;
  float d1 = C2.x * C3.y - C2.y * C3.x;
  float d2 = C3.x * C1.y - C3.y * C1.x;
  float d3 = C1.x * C2.y - C1.y * C2.x;
  float scale = abs(d1) + abs(d2) + abs(d3) + 1e-12;
  float inv = 1.0 / scale; d1 *= inv; d2 *= inv; d3 *= inv;
  float disc = 3.0 * d2 * d2 - 4.0 * d1 * d3;
  vec4 fk, fl, fm;
  if (disc > 0.0) {                                   // serpentine
    float r = sqrt(disc / 3.0), tl = d2 + r, sl = 2.0 * d1, tm = d2 - r, sm = 2.0 * d1;
    fk = vec4(tl * tm, -sm * tl - sl * tm, sl * sm, 0.0);
    fl = vec4(tl * tl * tl, -3.0 * sl * tl * tl, 3.0 * sl * sl * tl, -sl * sl * sl);
    fm = vec4(tm * tm * tm, -3.0 * sm * tm * tm, 3.0 * sm * sm * tm, -sm * sm * sm);
    float flip = d1 < 0.0 ? -1.0 : 1.0; fk *= flip; fl *= flip;
  } else {                                            // loop
    float r = sqrt(-disc), td = d2 + r, sd = 2.0 * d1, te = d2 - r, se = 2.0 * d1;
    fk = vec4(td * te, -se * td - sd * te, sd * se, 0.0);
    fl = vec4(td * td * te, -se * td * td - 2.0 * sd * td * te, te * sd * sd + 2.0 * se * sd * td, -sd * sd * se);
    fm = vec4(td * te * te, -sd * te * te - 2.0 * se * td * te, td * se * se + 2.0 * sd * se * te, -sd * se * se);
  }
  vec4 row = idx == 0 ? vec4(1.0, 0.0, 0.0, 0.0)
           : idx == 1 ? vec4(1.0, 1.0 / 3.0, 0.0, 0.0)
           : idx == 2 ? vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 0.0)
           :            vec4(1.0, 1.0, 1.0, 1.0);
  return vec3(dot(row, fk), dot(row, fl), dot(row, fm));
}

void main() {
  vColor = uColor;
  vTP = 0.0;
  vSeam = 0.0;
  vNa = vec2(0.0);
  vNb = vec2(0.0);
  vLine2 = vec3(0.0);
  vLineT = 0.0;
  float kind = aFlags.x;
  vKind = kind;
  vSign = aFlags.y;
  vTC = vec3(0.0);
  cM00 = vec3(0.0); cM01 = vec3(0.0); cM02 = vec3(0.0);
  cM11a = 0.0; cM12 = 0.0; cM22 = 0.0; cCen = vec2(0.0); cScale = 0.0; cHalf = 0.0;

  vec2 emPos = mix(aPosSrc, aPosDst, uT);

  float emPerPx = uGlobalBBox.z / max(uCanvasAR.x * uViewportSize.x, 1.0);
  if (uHasWorldM == 1) emPerPx /= max(length(vec2(uWorldM[0][0], uWorldM[0][1])), 1e-4);
  vEmPerPx = emPerPx;

  if (kind < 0.5) {                          // interior — ramp inner AA if it has a boundary edge
    if (aParam.w > 0.5) {
      int base = int(aParam.x + 0.5);
      vec4 s = fetchTexel(base), d = fetchTexel(base + 1);
      vec2 p1 = mix(s.xy, d.xy, uT), p2 = mix(s.zw, d.zw, uT);
      vec2 e = p2 - p1; float L = max(length(e), 1e-9);
      vec2 N = vec2(-e.y, e.x) / L * aParam.z;
      cCen = N; cScale = dot(N, p1);
    }
  } else if (kind > 0.5 && kind < 1.5) {     // quad
    if (aParam.w > 0.5) {
      // TILED crescent: lerp the control points (a,ctrl,b) from uPrim, DILATE this vertex about
      // the centroid (affine → UV follows, arc unchanged), and set the tangent-clip payload
      // (aC3 = a.xy/b.xy, aSeamM = ctrl.x, tc.z = ctrl.y) so the shared fragment tiles it exactly
      // like the static path — no morph seam scallop/over.
      int base = int(aParam.z + 0.5);
      vec4 t0 = fetchTexel(base), t1 = fetchTexel(base + 1), t2 = fetchTexel(base + 2);
      vec4 t3 = fetchTexel(base + 3), t4 = fetchTexel(base + 4);
      vec2 a = mix(t0.xy, t1.zw, uT), ctrl = mix(t0.zw, t2.xy, uT), b = mix(t1.xy, t2.zw, uT);
      vec2 cen = (a + ctrl + b) / 3.0;
      float S = 1.3;                                   // CRESCENT_DILATE
      emPos = cen + S * (emPos - cen);
      vec2 meanUV = vec2(0.5, 1.0 / 3.0);
      vTC = vec3(meanUV + S * (aParam.xy - meanUV), ctrl.y);
      cCen = a; cScale = b.x; cHalf = b.y; vSeam = ctrl.x;
      // Endpoint clip normals lerped from uPrim: corner BISECTORS on the CDT-pair path
      // (concave corners clip AT the corner, like static), arc tangents on the earcut path.
      vNa = mix(t3.xy, t4.xy, uT); vNb = mix(t3.zw, t4.zw, uT);
    } else {
      vTC = vec3(aParam.x, aParam.y, 0.0);
    }
  } else if (kind > 1.5 && kind < 2.5) {     // cubic — recompute klmn from lerp
    int base = int(aParam.x + 0.5), ci = int(aParam.y + 0.5);
    vec4 t0 = fetchTexel(base), t1 = fetchTexel(base + 1), t2 = fetchTexel(base + 2), t3 = fetchTexel(base + 3);
    vec2 P0 = mix(t0.xy, t2.xy, uT);
    vec2 P1 = mix(t0.zw, t2.zw, uT);
    vec2 P2 = mix(t1.xy, t3.xy, uT);
    vec2 P3 = mix(t1.zw, t3.zw, uT);
    vTC = cubicKLMN(P0, P1, P2, P3, ci);
  } else if (kind > 2.5 && kind < 3.5) {     // strip — recompute edge normal
    int base = int(aParam.x + 0.5);
    vec4 s = fetchTexel(base), d = fetchTexel(base + 1);
    vec2 p1 = mix(s.xy, d.xy, uT);
    vec2 p2 = mix(s.zw, d.zw, uT);
    vec2 e = p2 - p1; float L = max(length(e), 1e-9);
    vec2 N = vec2(-e.y, e.x) / L * aParam.z;   // left-perp · outwardSign
    cCen = N; cScale = dot(N, p1);
    if (aParam.y > 0.5) emPos += N * (1.25 * emPerPx);   // outer-flagged: dilate the strip (worldScale-corrected)
  } else if (kind > 4.5) {                    // rational quad (arc) — homogeneous
    vTC = aParam.xyz;                          // (Ũ,Ṽ,R): position-independent, no lerp
  }

  vEm = emPos;
  vec2 uv = (emPos - uGlobalBBox.xy) / uGlobalBBox.zw;
  vec2 plane = (uv * 2.0 - 1.0) * uCanvasAR;
  vec3 clip3 = vec3(plane.x, -plane.y, 1.0);
  if (uHasWorldM == 1) clip3 = uWorldM * clip3;
  gl_Position = vec4(clip3.xy, 0.0, clip3.z);
}
