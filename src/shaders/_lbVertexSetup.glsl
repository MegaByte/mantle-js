// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _lbVertexSetup.glsl — the LB vertex stage's per-kind varying setup.
//
// Mirror of _lbCoverage.glsl on the vertex side: computes every LB coverage
// varying (vTC/vKind/vSign/vSeam/vEmPerPx and the four vLB slots) and returns
// the DILATED em position, leaving the caller to do the em->clip projection with
// whatever pipeline it owns. That split is the point — the ubershader projects
// cover quads its own way, and this is the part it needs to share.
//
// Spliced textually, so it writes the includer's varyings. emPerPxFor() is the unified stream's
// shared vertex helper and is spliced ahead of this (both routes dilate in pixel space). The per-curve attributes arrive as PARAMETERS rather
// than being read at file scope, because the morph-pair variant mixes the A and
// B streams into locals before any of this runs.
// ---- the cubic curve band's klm GRADIENT PAIR (aC0.z) -------------------------------------------------------

// What the kernel needs from the lane is 11 significant bits (the pair is multiplied by the 1.5px ring push and
// added to klm, so its error lands on the edge as a fraction of a pixel; half's 2^-11 is already far more than
// the ramp can show). What it needs is RANGE. So: one 8-bit exponent shared by both components, and 11 bits of
// magnitude plus a sign each.
//
//   bit 31      sign of dk
//   bits 30:23  the shared exponent E, IN THE FLOAT'S own EXPONENT FIELD
//   bits 22:12  |dk| * 1024 / 2^(E-127), 0..2047
//   bits 11:1   |dl| * 1024 / 2^(E-127), 0..2047
//   bit 0       sign of dl
//
// E is 2^floor(log2 max(|dk|,|dl|)) read straight off the float, so the larger component lands in [1024, 2047]
// and carries an 11-bit significand -- the same relative precision half gave it (<= 2^-11) -- while both
// components' absolute error is bounded by the same 2^-11 of the pair's magnitude. The range is float32's
// own, 2^-126 to 2^127, which is the floor everything else in the builder already sits on.
//
// Putting e in the float's exponent field is not cosmetic. A vertex attribute is a float, and the pattern this
// writes is always either a normal float or a signed zero -- never a denormal, an Inf or a NaN. packHalf2x16
// could not promise that: with dl == 0 and dk != 0 the top sixteen bits are zero and the slot IS a denormal,
// which a driver is free to flush on load and take dk with it. It also makes the morph's plain `mix()` of the
// slot harmless before it is overwritten.
//
// Cost: ZERO bytes (the same 32-bit lane, the same stride, the same attribute count) against the 8 bytes per
// LB vertex that widening the pair to two floats would have cost on every kind, not just this one. Decode is
// one AND, one bitcast, two shifts, two masks and two int-to-floats, in the VERTEX stage, once per ring vertex.
vec2 lbUnpackKlmGrad(float f) {
  uint u = floatBitsToUint(f);
  float s = uintBitsToFloat(u & 0x7F800000u) * (1.0 / 1024.0);   // 2^(E-137), exact
  vec2 d = vec2(float((u >> 12) & 0x7FFu), float((u >> 1) & 0x7FFu)) * s;
  return vec2((u & 0x80000000u) != 0u ? -d.x : d.x, (u & 1u) != 0u ? -d.y : d.y);
}
#ifdef MANTLE_LB_MORPH
// The morph re-packs, because lbVertexSetup takes the vec4 and the two endpoints must be mixed as the VECTOR
// they hold. G == 0 (or a denormal pair) gives E == 0 and zero magnitudes, i.e. a signed zero, which decodes
// back to exactly (0, 0) -- the welded inner-ring vertex stays welded.
float lbPackKlmGrad(vec2 d) {
  vec2 a = abs(d);
  uint E = floatBitsToUint(max(a.x, a.y)) & 0x7F800000u;
  // E == 0 is a zero or denormal pair and E == 0x7F800000 an infinite or NaN one: both pack as a plain zero,
  // which decodes back to exactly (0, 0) and leaves the extruded vertex welded to its hull. THE SIGN BITS GO
  // Too -- bit 0 is a mantissa bit, so keeping dl's sign beside a zero exponent would make the slot a denormal
  // float, the one pattern this format exists to rule out.
  if (E == 0u || E == 0x7F800000u) return 0.0;
  // DIVIDING by the exponent rather than multiplying by its reciprocal is what makes this total: a.x/s and
  // a.y/s are exact (s is a power of two) and below 2 by construction, while 1024/s overflows float32 for s
  // under 2^-116. The larger component is at least 1, so at least one magnitude field is at least 1024.
  float s = uintBitsToFloat(E);
  uint mk = min(uint(a.x / s * 1024.0 + 0.5), 2047u), ml = min(uint(a.y / s * 1024.0 + 0.5), 2047u);
  return uintBitsToFloat((d.x < 0.0 ? 0x80000000u : 0u) | E | (mk << 12) | (ml << 1) | (d.y < 0.0 ? 1u : 0u));
}
float lbMixKlmGrad(float a, float b, float t) {
  return lbPackKlmGrad(mix(lbUnpackKlmGrad(a), lbUnpackKlmGrad(b), t));
}
#endif

// The pixel box's reach along a unit em-space direction n, in em: how far past a line with normal n a
// pixel's CENTER can lie while its box still touches the line -- 0.5 (|w.x| + |w.y|) with w = C^-T n, C the em -> pixel
// linear map (basePx and the world matrix's linear part, conjugated by the plane's y-flip, as lbChainCellMap). With no
// world matrix that is 0.5 basePx (|n.x| + |n.y|): half a pixel along an axis, sqrt(2)/2 (CP_AA_REACH) at 45 degrees.
// An exterior ring pushed this far reaches every pixel whose box meets the edge it grows from, and no farther; the
// coverage kernel then bounds what such a pixel may claim (the ring bounds in _lbCoverage.glsl).
float lbBoxReach(vec2 n, float basePx) {
  if (uHasWorldM == 0) return 0.5 * basePx * (abs(n.x) + abs(n.y));
  mat2 W = mat2(uWorldM[0].xy, uWorldM[1].xy);
  mat2 Fy = mat2(1.0, 0.0, 0.0, -1.0);
  mat2 C = (Fy * W * Fy) * (1.0 / basePx);
  vec2 w = transpose(inverse(C)) * n;
  return 0.5 * (abs(w.x) + abs(w.y));
}
// The reach of a curve band's PUSH VECTOR v (aC0.xy), per unit of v. Every band push is v = n + s t, n the unit normal of
// an edge the vertex ends and t that edge's direction -- a klm ring's and the control corner's are the normal itself, a
// fat ring's end n +- t, a hull box's corner (+-1, +-1) -- so a unit of v moves the ring's far edge exactly 1 along n, and
// v leans acos(1 / |v|) off n to one side or the other. The larger reach of the two candidates is at least n's.
float lbBandReach(vec2 v, float basePx) {
  float L = length(v);
  if (!(L > 0.0)) return 0.0;
  vec2 u = v / L;
  float c = 1.0 / max(L, 1.0), s = sqrt(max(1.0 - c * c, 0.0));
  return max(lbBoxReach(vec2(c * u.x - s * u.y, s * u.x + c * u.y), basePx),
             lbBoxReach(vec2(c * u.x + s * u.y, -s * u.x + c * u.y), basePx));
}

#ifdef MANTLE_NO_BEZOUT
vec2 lbVertexSetup(vec2 aPos, vec3 aTC, vec4 aC0, vec4 aC3) {
#else
vec2 lbVertexSetup(vec2 aPos, vec3 aTC, vec4 aC0, vec4 aC1, vec4 aC2, vec4 aC3) {
#endif
  vTC = aTC;
  vKind = aFlags.x;
  vSign = aFlags.y;
  vSeam = aSeamM;   // EDGE_STRIP end codes / cubic morph clip marker
  // The per-kind names (vNa, cM00, vCh2A, cCen, …) are VIEWS over these four —
  // see _lbVaryings.glsl. Forwarding the attributes is exactly what per-name
  // assignments would do, one re-slice at a time.
  vLB0 = aC0;
  vLB3 = aC3;
#ifndef MANTLE_NO_BEZOUT
  vLB1 = aC1;
  vLB2 = aC2;
  // INTERIOR chain mode reads the face's SECOND outline arc (Q0..Q3) from these
  // same aC1/aC2 slots — disjoint kinds, and a mesh carrying chain 2 is flagged
  // so it binds the full program. All-zero when the face has one arc.
#endif

  // Straight-edge AA: the kind-3 strip is dilated OUTWARD (aTC.x>0.5) along the
  // edge normal N=cCen by ~1.25px and the fragment ramps the OUTER half; the INTERIOR
  // interior carries the same edge line in aC3 and ramps the INNER half, meeting at
  // ½-coverage on the edge (CUBIC klmn also sets aTC.x, so the guard excludes it;
  // CUBIC_BEZ aTC=0 so it's inert). emPerPx is per-DEVICE-pixel; the em→plane→NDC map is
  // scaled by uWorldM, so a shrinking world transform puts FEWER screen px per em →
  // true em-per-px is LARGER by 1/worldScale. Divide it in, else the dilation
  // collapses sub-pixel on scaled-down shapes (the stroke path does the same).
  //
#ifndef LB_DISC_PUSH
#define LB_DISC_PUSH 2.0
#endif
#ifndef LB_STRIP_NEXT
#define LB_STRIP_NEXT 0.8
#endif
#ifndef LB_KLM_RING
#define LB_KLM_RING 0.25
#endif
#ifndef LB_BEZ_RING
#define LB_BEZ_RING 0.25
#endif
  float basePx = uGlobalBBox.z / max(uCanvasAR.x * uViewportSize.x, 1.0);
  // INTERIOR straight-edge normal (aC3.xy). A CHAIN face (aTC.x >= 2) carries its first POINT there,
  // and its kernel maps through lbChainCellMap instead, so it takes the directionless scale rather
  // than one that moves with where the drawing sits.
  vEmPerPx = emPerPxFor(aTC.x > 1.5 ? vec2(0.0) : aC3.xy, basePx);
  vec2 emPos = aPos;
  if (aFlags.x > 3.5 && aFlags.x < 4.5) {
    // CUBIC_BEZ Bezout crescent. The implicit is evaluated from POSITION rather than from
    // interpolated attributes, so the hull can be extended with no attribute correction at all --
    // which is what makes the exterior ring below possible, and makes it the EASY case next to the
    // klm crescents, whose ring has to carry the klm gradient out with it (kind 12).
    //
    vEmPerPx = emPerPxFor(aPos - cCen, basePx);

    if (aSeamM > 5.0) {
      vec2 n4 = unpackHalf2x16(floatBitsToUint(aC3.w));
#ifdef MANTLE_LB_MORPH
      if (dot(n4, n4) > 0.0) emPos += n4 * (LB_BEZ_RING * emPerPxFor(n4, basePx));
#else
      // THE BOX FILTER'S REACH, and the edge it grows from. The ring reaches every pixel whose box meets
      // its hull edge (lbBoxReach), and the fragment bounds such a pixel by the box's share of that edge's half-plane
      // with the keep plane's. The edge's offset rides vEmPerPx, which the kind-4 kernel does not read (its keep
      // plane releases by the em derivatives); flat, it comes from the provoking vertex, which on every ring
      // triangle is an extruded one and so carries the edge's own normal (the packer's ring order, lbPack.js).
      if (dot(n4, n4) > 0.0) {
        vec2 u4 = normalize(n4);
        vEmPerPx = dot(u4, aPos);
        emPos += u4 * lbBoxReach(u4, basePx);
      }
#endif
      // A RING THAT CARRIES ITS ARC (aSeamM = 10, lbPack): the fragment maps the arc into its pixel cell, which takes
      // the directionless scale, as a chain-mode interior face does.
      if (aSeamM > 9.5) vEmPerPx = emPerPxFor(vec2(0.0), basePx);
    }
#ifdef MANTLE_CPATCH
  } else if (aFlags.x > CP_STREAM_TAG - 0.5 && aFlags.x < CP_STREAM_TAG + 0.5) {
    // A DIFFERENT ENGINE, sharing this stream, recognized by ITS tag rather than by a slot in the
    // kind chain around it. Its setup lives in _cpatchVertexSetup.glsl.
    emPos = cpatchVertexSetup(aPos, aTC, aC0, basePx, vEmPerPx);
#endif
  } else if (aFlags.x > 6.5 && aFlags.x < 7.5) {

    vec2 out7 = aPos - aC3.xy;
    float L7 = max(length(out7), 1e-30);
    vEmPerPx = emPerPxFor(out7, basePx);
    emPos = aPos + (out7 / L7) * (LB_DISC_PUSH * emPerPxFor(out7, basePx));
  } else if (aFlags.x > 9.5 && aFlags.x < 10.5) {
    // Edge cap-strip (EDGE_STRIP): quad spanning the edge's exterior band [0, +nExt]px plus
    // tangential end extensions ±tExt so it covers both corner wedges; the fragment's
    // watertight plane tests trim to this edge's exact zone. Role: aTC.x = tEnd + 2·sOuter.
    vec2 p1k = aC3.xy, p2k = vec2(aC3.z, aC3.w);
    vec2 tdk = (p2k - p1k) / max(length(p2k - p1k), 1e-30);
    vec2 nOutk = vec2(-tdk.y, tdk.x) * aFlags.y;
    float tR = mod(aTC.x, 2.0), sR = floor(aTC.x / 2.0 + 0.25);
    vec2 basek = tR < 0.5 ? p1k : p2k;
    vEmPerPx = emPerPxFor(nOutk, basePx);
    // Tip reach: 3.2px base; acute line–line ends boost so START's extruded
    // quad covers the intersecting-lines bulb (END cedes that zone in the FS).
    // Keep the boost modest: over-reach creates isolated solid spikes on the
    // tip fringe relative to the reference coverage paths.
    // THE NORMAL REACH IS LB_STRIP_NEXT (0.8px), not the 3.2px tip reach: 3.2 is 4.5x what the filter
    // can see. The fragment's own watertight plane tests trim this strip to the edge's exact zone, so
    // every pixel of reach past CP_AA_REACH (0.7072) is a fragment shaded to be thrown away -- and the
    // strip's area is linear in it. A wider normal reach draws a byte-identical frame and only costs
    // time. tExt is different and stays: it is the TANGENTIAL extension that makes the quad cover
    // both corner wedges, which is a geometric requirement, not a filter one.
    float tExt = 3.2, nExt = LB_STRIP_NEXT;
    if (sR >= 0.5) {
      float codeA10 = floor((aSeamM + 0.5) / 16.0), codeB10 = aSeamM - codeA10 * 16.0;
      float code10 = tR < 0.5 ? codeA10 : codeB10;
      float ty10 = floor((code10 + 0.5) / 4.0) - 1.0;
      bool curve10 = mod(code10, 4.0) >= 1.5;
      if (ty10 > 0.5 && !curve10) {
        vec2 nN10 = tR < 0.5 ? aC0.xy : aC0.zw;
        float nDot10 = dot(nOutk, nN10);
        if (nDot10 < -0.35) {
          float boost10 = 1.0 + 0.55 * clamp(-0.35 - nDot10, 0.0, 1.35);
          tExt *= boost10;
          nExt *= boost10;
        }
      }
    }
    // inner boundary exactly on the edge AND inner verts exactly the outline endpoints:
    // shared coordinates give bit-identical edge equations, so rasterization tie-break
    // partitions strip vs interior watertight. Only the OUTER verts extend for
    // corner-wedge candidate coverage.
    emPos = basek + tdk * ((tR < 0.5 ? -tExt : tExt) * (sR < 0.5 ? 0.0 : emPerPxFor(tdk, basePx))) + nOutk * ((sR < 0.5 ? 0.0 : nExt) * emPerPxFor(nOutk, basePx));
  } else if (aFlags.x > 11.5 && aFlags.x < 12.5) {
    // Unified curve band (CURVE_BAND): same push as kind-9 (1.5px). Footprint is the
    // kind-9 ring/bbox (Loop §5 exterior coverage geometry); end partitions trim it.
    // aTC=(Ũ,Ṽ,R) for quads; cubic mode (|sign|≥8192) uses aTC=(k,l,m) with
    // aC0=(n̂, lbPackKlmGrad(dk,dl), dm) so aC3 can hold (a,b) for end chaining.
#ifdef MANTLE_LB_MORPH
    // A quad band reaches the box filter's own distance and takes the bound from its own end data (mode 2), as a static
    // band does: its arc is the lerped conic, whose end tangents are lerped with it. A klm ring keeps the constant ring and
    // no bound (its support along the normal would need both poses').
    bool quadBand12 = abs(aFlags.y) < 8192.0;
    float amt12 = quadBand12 ? lbBandReach(aC0.xy, basePx) : LB_KLM_RING * emPerPxFor(aC0.xy, basePx);
    vLB0 = quadBand12 ? vec4(0.0, 0.0, 0.0, 2.0) : vec4(0.0);
#else
    // THE BOX FILTER'S REACH, and the band's bound for the fragment, in vLB0 -- which the kind-12 kernel
    // does not otherwise read (aC0 is the push and the klm gradient, spent here): a klm ring carries its unit normal and
    // the arc's support along it (packed in the seam slot, lbPack.js), mode 1; a quad band takes its bound from its own
    // end data, mode 2.
    float L12 = length(aC0.xy);
    float amt12 = lbBandReach(aC0.xy, basePx);
    vLB0 = abs(aFlags.y) >= 8192.0 ? vec4(L12 > 0.0 ? aC0.xy / L12 : vec2(0.0), aSeamM, 1.0) : vec4(0.0, 0.0, 0.0, 2.0);
#endif
    vEmPerPx = emPerPxFor(aC0.xy, basePx);
    emPos = aPos + aC0.xy * amt12;
    if (abs(aFlags.y) >= 8192.0) {
      vec2 dkl12 = lbUnpackKlmGrad(aC0.z);
      vTC = aTC + vec3(dkl12, aC0.w) * amt12;
    } else {
      // R pushes with U and V: R = 1 + 2(1 - w)(U - V), the factor in the seam slot (lbPack.js). A morph pair holds one
      // weight across both poses (lbPartitionPair bails on a different one), so the A stream's factor is every lerped
      // frame's, and a lerped frame (U, V, R each affine, the relation linear) keeps the relation.
      vTC = vec3(aTC.xy + aC0.zw * amt12, aTC.z + aSeamM * (aC0.z - aC0.w) * amt12);
    }
  }
  return emPos;
}
