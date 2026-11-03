#version 300 es
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
// Vertex stage of the split-stroke coverage pass, whose one caller is incrementalStroke
// (the paint stroke). NOT Loop-Blinn (that's the FILL coverage); this is the analytic SDF
// stroke. ONE band quad per outline segment (no separate join/cap primitives): the VS reads
// the segment in the main renderer's format (encodeSeg: header, native control points, join
// texel) and hands it to the frag. The band box grows by each join's actual miter reach, so
// a sharp miter tip isn't cropped.
//
// VBO (2 floats / vertex): aPrimBase (the segment header's texel index), aCorner (0..3).
precision highp float;
precision highp int;

layout(location=0) in float aPrimBase;
layout(location=1) in float aCorner;


uniform highp sampler2D uPrim;
uniform int   uPrimW;
uniform float uHalfW, uMiterLimit;   // uT is gone: nothing morphs through this pass
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
flat out float vSegType;      // which solve the fragment runs: line, quad or cubic
flat out int   vCap, vJoin;
flat out float vStartDist;
out vec2 vEm;

// VS needs only the curve coeff + arc-length helpers (cubicCoeff, slugCubicArcLen)
// for the dash-phase prefix sum — NOT the stroke-distance math or dashOut (so
// no uDashTex in the vertex stage). @@STROKE_MATH@@ lives in splitStroke.frag.
@@CURVE_ARCLEN@@
// The setup writes its varyings through these macros; here they are plain assignments.
#define STROKE_SET_CAPJOIN(c, j) vCap = (c); vJoin = (j)
#define STROKE_SET_TYPE(t) vSegType = (t)
#define STROKE_SET_FREE(s, e)    vFreeStart = (s); vFreeEnd = (e)
#define STROKE_SET_DASH(d)
// The band-quad setup itself.
@@STROKE_VERTEX_SETUP@@

void main() {
  vec2 emPos = strokeVertexSetup(aPrimBase, aCorner,
                                 uHalfW, uMiterLimit, uCapStyle, uJoinStyle, uDashId,
                                 uGlobalBBox, uCanvasAR, uViewportSize, uWorldM, uHasWorldM);
  vEm = emPos;
  vec2 uv = (emPos - uGlobalBBox.xy) / uGlobalBBox.zw;
  vec2 plane = (uv * 2.0 - 1.0) * uCanvasAR;
  vec3 clip3 = vec3(plane.x, -plane.y, 1.0);
  if (uHasWorldM == 1) clip3 = uWorldM * clip3;
  gl_Position = vec4(clip3.xy, 0.0, clip3.z);
}
