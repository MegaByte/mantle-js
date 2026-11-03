#version 300 es
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
// Stroke coverage for incrementalStroke, the paint stroke. This is an ANALYTIC SDF
// stroke, NOT Loop-Blinn — LB is the FILL coverage. One band quad per segment in the
// main renderer's segment format; this frag computes the exact distance with caps and
// joins via the shared stroke accums (_strokeMath.glsl, the same code the ubershader's
// Slug stroke uses) over control points relative to the fragment, then the same AA
// falloff as mantle.frag's stroke. MAX-blended across segments. vStartDist is the
// segment header's cumulative arc length.
precision highp float;
precision highp int;
precision highp sampler2D;  // uDashTex is RGBA32F em-space data (lowp default crushes it)

flat in vec2  vP0, vP1, vP2, vP3;
flat in float vHalfW, vMiterLimit;
flat in vec2  vInTan, vOutTan;        // prev/next neighbor tangents (joins)
flat in float vFreeStart, vFreeEnd;
flat in float vSegType;
flat in int   vCap, vJoin;            // cap: 0 butt·1 round·2 square; join: 0 miter·1 round·2 bevel
flat in float vStartDist;
in vec2 vEm;
out vec4 o;

uniform int       uDashId;            // 0 = no dash; >0 = uDashTex row (stroke-dasharray)
uniform sampler2D uDashTex;
// Exact-area stroke AA, matching mantle.frag's uStrokeExactAa so a single
// renderer toggle moves both stroke paths. Without this the two disagree at
// every AA edge and any static-vs-decomposed comparison is unfair by
// construction — the decomposed side would be measuring a different ramp.
uniform int       uStrokeExactAa;

@@CURVE_ARCLEN@@
@@BUNDLE_LAYOUT@@
@@BOX_COV@@
@@STROKE_MATH@@
#define STROKE_DASH_ID uDashId
// The coverage itself.
@@STROKE_COVERAGE@@

void main() {
  o = vec4(strokeCoverage());
}
