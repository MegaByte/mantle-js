// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _lbVaryings.glsl — LB coverage varyings: the four per-curve attributes, and
// the per-kind NAMES that view them.
//
// lbCoverage() reads ~40 components' worth of names (cM00, vNa, cCen, vCh2A, …),
// but there are not 40 components of data behind them: every one is a re-slice
// of the same four attributes:
//
//   vNa vNb vLine2 vLineT cM00 <- aC0        cM01 vCh2A <- aC0.w + aC1
//   cM02 vCh2B <- aC1.zw + aC2               cCen cScale cHalf <- aC3
//   cM11a cM12 cM22 <- aC2.yzw
//
// One exception: an EDGE_STRIP's vLB1/vLB2 are its two corner partition planes in CANVAS PIXELS, which mantle.vert
// maps from the em planes aC1/aC2 carry, after lbVertexSetup (both strips at a corner must test the
// fragment's exact center against the same bits).
//
// So the varyings ARE aC0..aC3, re-sliced. Passing the four vec4s and defining
// the names as views over them is exactly faithful — 16 components instead of
// 40, with no repacking to get wrong. That is what lets the fill ubershader host
// LB coverage: 21 (mantle's own) + 16 + 7 always-on = 44 of the GLES 3.0 floor
// of 60, leaving room for the split-stroke kind.

// ── KIND NAMES ──────────────────────────────────────────────────────────────
// vKind is a float, and a bare numeric range test against it
// (`vKind > 9.5 && vKind < 10.5`) says nothing about what the piece IS.
// These name the eight live kinds and give each a predicate. The numbers are the
// packer's wire values (lbPack's `head(..., kind, ...)`) and must not change; only
// the names are new.
//
//   INTERIOR    solid interior triangle, optionally ramping across a straight
//               boundary edge it carries
//   CUBIC       cubic outline via the Loop-Blinn klmn implicit (k^3 - l*m)
//   CUBIC_BEZ   cubic fallback for cusps / d1~0, via the exact 3x3 Bezout
//               determinant (the expensive path; MANTLE_NO_BEZOUT drops it)
//   ARC         rational-quadratic crescent — arcs and ellipse segments, exact
//   DISC        circle / annulus / ellipse as an analytic SDF, seam-free across
//               co-circular pieces
//   EDGE_STRIP  the exterior AA band + both end wedges of one STRAIGHT edge
//   CURVE_BAND  the unified exterior band around a curve (quads and cubic rings)
//   CHAIN_STRIP thin +/-band quad hugging one outline edge, analytic poly-clip
//
// Dead wire values 1, 3, 8, 9 and 11 had their handlers removed with their
// emitters; 6 is a legacy DISC still accepted on read.
#define LBK_INTERIOR     0.0
#define LBK_CUBIC        2.0
#define LBK_CUBIC_BEZ    4.0
#define LBK_ARC          5.0
#define LBK_DISC         7.0
#define LBK_EDGE_STRIP  10.0
#define LBK_CURVE_BAND  12.0
#define LBK_CHAIN_STRIP 13.0

#define LB_IS(k)         (vKind > (k) - 0.5 && vKind < (k) + 0.5)
#define LB_IS_INTERIOR   (vKind < LBK_INTERIOR + 0.5)
#define LB_IS_CUBIC      LB_IS(LBK_CUBIC)
#define LB_IS_ARC        LB_IS(LBK_ARC)
#define LB_IS_DISC_ANY   (vKind > 5.5 && vKind < LBK_DISC + 0.5)   // 7, or legacy 6
#define LB_IS_EDGE_STRIP LB_IS(LBK_EDGE_STRIP)
#define LB_IS_CURVE_BAND LB_IS(LBK_CURVE_BAND)
#define LB_IS_CHAIN_STRIP LB_IS(LBK_CHAIN_STRIP)


// The includer defines LB_FLAT / LB_SMOOTH as its in/out direction first.
LB_FLAT vec4 vLB0;        // aC0
LB_FLAT vec4 vLB1;        // aC1
LB_FLAT vec4 vLB2;        // aC2
LB_FLAT vec4 vLB3;        // aC3
LB_SMOOTH vec3 vTC;
LB_FLAT float vKind;
LB_FLAT float vSign;
LB_FLAT float vEmPerPx;   // em per device pixel — straight-edge ramps derive grad(f) from this
LB_FLAT float vSeam;      // kind-10 end codes / cubic morph clip marker

// kind 4 — Bezout cubic implicit matrix (aC0.w + aC1 + aC2 straddle vec4s, so
// these three are read-only views; nothing assigns them.)
#define cM00   vLB0.xyz
#define cM01   vec3(vLB0.w, vLB1.xy)
#define cM02   vec3(vLB1.zw, vLB2.x)
#define cM11a  vLB2.y
#define cM12   vLB2.z
#define cM22   vLB2.w
// kind 0 — second outline arc of a chained interior
#define vCh2A  vLB1
// CPatch's SKIRT carries its edge's outward unit normal here. The slot is Bezout's cM01/cM02 for
// Loop-Blinn kinds and untouched by CPatch, which is the same re-slicing every other name above
// does -- a varying is read by the kind that wrote it.
// CPatch's own BOUNDING BOX, as the paper defines the primitive: its curves "inside a bounding box
// represented as four lines". Oriented, not axis-aligned (patchOBB), because a diagonal sliver's
// axis-aligned box is many times its own area and every corner of that slack is somewhere the
// implicits can agree by accident. Carried as the box's axis and its two extents along that axis
// and its perpendicular -- six floats, two dot products, and no fetch at all.
#define cBoxA  vLB1.xy
#define cBoxU  vLB1.zw
#define cBoxV  vLB2.xy
#define vCh2B  vLB2
// kind 0/10/12 — neighbor clip normals and the second boundary line
#define vNa    vLB0.xy
#define vNb    vLB0.zw
#define vLine2 vLB0.xyz
#define vLineT vLB0.w
// kind 7/10/13 — center, scale, half-width
#define cCen   vLB3.xy
#define cScale vLB3.z
#define cHalf  vLB3.w

//
const float LB_COV_WROTE_O = -2.0;
#define LBCOV_OUT(c) (c)
