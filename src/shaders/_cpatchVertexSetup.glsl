// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _cpatchVertexSetup.glsl — CPATCH's vertex stage. Its own file, for the same reason its coverage
// kernel is: CPatch is its own engine, not a Loop-Blinn kind. What the two share is the unified
// fill draw's vertex STREAM — one buffer, one drawArrays, one set of varyings — and sharing a wire
// is not being a kind of the thing you share it with.
//
// Spliced by its own marker before the LB vertex setup, whose kind dispatch calls this for kind
// 14, and after the includer's emPerPxFor(). A spliced file must not spell any marker name in its
// own text -- the splicer is textual, so a marker mentioned in a COMMENT is expanded there too,
// which is how LB's whole setup function landed inside this file's header and took the vertex
// shader's compile with it.

// CPatch's stream tag, repeated here because this file is spliced into the VERTEX shader and the
// coverage kernel that also defines it is fragment-only. Guarded so the two cannot disagree by
// being defined twice in one stage. It is CPatch's tag, not a Loop-Blinn kind — see the longer
// note in _cpatchCoverage.glsl.
#ifndef CP_STREAM_TAG
#define CP_STREAM_TAG    14.0
#endif

#ifdef MANTLE_CPATCH
/// The cover vertex in its contour's frame. A CPatch cover vertex arrives relative to its
/// contour's corner O (aC2.zw) -- the frame the kernel's texels are packed in -- and this is it, dilated:
/// small, so float32 holds it to the precision a contour at the origin has. The vertex stage projects from it
/// and hands it to the fragment as the kernel's position; the world position (it plus O) is only for paint.
vec2 gCpLocal = vec2(0.0);
vec2 gCpPixelX=vec2(0.0),gCpPixelY=vec2(0.0);
bool gCpPixelValid=false;
#ifndef MANTLE_CPATCH_NO_QUADRATIC_AREA
// Upper bound on the inverse composed affine pixel map. Set before dispatch.
float gCpAreaEpp = 0.0;
#endif
/// The dilated em position for one CPatch cover-polygon vertex, in its contour's frame, and the em-per-pixel
/// the fragment stage divides its distances by.
vec2 cpatchVertexSetup(vec2 aPos, vec3 aTC, vec4 cell, float basePx, out float emPerPxOut) {
  // CPATCH cover polygon. Two things ride on this dilation, and neither is optional:
  //
  //  - the AA RAMP lives OUTSIDE the patch boundary (coverage below 1/2 is by definition on the
  //    exterior side), so a cover tight to that boundary generates only the ramp's inner half
  //    and every boundary pixel comes out under-covered. Not a crack -- a uniform thinning along
  //    every straight edge.
  //  - the seam between two patches sharing a cut is computed from separately derived vertices,
  //    so it cracks in the last bits where they disagree.
  //
  // aTC.xy is the packer's per-vertex offset direction (edge-normal bisector / cos, so every
  // EDGE moves out by the full amount rather than only the corners). It rides aTC and not aC0
  // because in the compact unified stream aC0..aC3 are a per-CURVE block fetched from a data
  // texture and deduplicated by content -- a patch triangle's three vertices share one entry
  // there, so per-vertex data cannot live in it. aTC is per-vertex and CPatch leaves it empty.
  //
  // aC3.xy is (block, count) here, NOT a direction, so vEmPerPx has to come from aTC as well or
  // an anisotropic world matrix would scale the fragment's distance-to-curve by a direction
  // read out of an array index.
  float epp = emPerPxFor(aTC.xy, basePx);
#ifndef MANTLE_CPATCH_NO_QUADRATIC_AREA
  if (aTC.z > 1500.0 && aTC.z < 2500.0) epp = gCpAreaEpp;
#endif
  emPerPxOut = epp;
    //
  gCpLocal = aPos + aTC.xy * (1.5 * epp);
  if(aTC.z>2999.5 && aTC.z<3000.5 && gCpPixelValid)
    gCpLocal=aPos+((abs(gCpPixelX)+abs(gCpPixelY))*aTC.xy)*(0.5+1.0/256.0);
  return gCpLocal;
}
#endif
