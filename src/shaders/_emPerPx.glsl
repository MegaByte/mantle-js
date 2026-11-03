// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _emPerPx.glsl — em-per-device-pixel for a direction, the unified fill stream's SHARED vertex
// helper. Every route that dilates a cover in pixel space needs it, which is Loop-Blinn AND
// CPatch, so it belongs to neither of them: CPatch has its own vertex stage, and a helper only one
// of the two could see would be in the wrong place -- the same rule the coverage protocol follows
// on the fragment side.

// em-per-device-pixel for an AA dilation pushed along the em-space direction
// `dirEm`. `basePx` is the em→pixel scale of the em→plane→viewport chain WITHOUT
// the world matrix. The world matrix (uWorldM) multiplies the PLANE coordinates
// (clip3 = uWorldM * vec3(plane.x, -plane.y, 1)), so its linear 2×2 stretches the
// dilation by the mapped length of the plane-space direction (note the plane Y-flip).
//   • No world matrix, or a CONFORMAL one (uniform scale + rotation → equal-length
//     orthogonal columns), or no usable direction → returns the exact legacy scalar
//     basePx/length(col0), byte-identical to the previous code (zero parity risk on
//     the common path).
//   • ANISOTROPIC scale / SKEW (reachable via a caller-supplied or animated
//     worldMatrix — SVG scale(sx,sy)/skew, synthetic-oblique text) → returns the
//     direction-correct basePx/|M·d̂|, so the dilation is ~constant screen pixels in
//     the push direction instead of collapsing on the compressed axis.
//
float emPerPxFor(vec2 dirEm, float basePx) {
  if (uHasWorldM == 0) return basePx;
  vec2 c0 = vec2(uWorldM[0][0], uWorldM[0][1]);   // linear column mapping plane.x
  vec2 c1 = vec2(uWorldM[1][0], uWorldM[1][1]);   // linear column mapping plane.y
  float l0 = length(c0), l1 = length(c1);
  float dm = max(abs(dirEm.x), abs(dirEm.y));
  if (!(dm > 0.0) ||
      (abs(l1 - l0) <= 1e-4 * max(l0, l1) && abs(dot(c0, c1)) <= 1e-4 * (l0 * l1)))
    return basePx / max(l0, 1e-30);               // conformal / directionless → legacy
  vec2 u = dirEm / dm;
  vec2 pd = vec2(u.x, -u.y) / length(u);          // plane-space unit direction (Y-flip)
  return basePx / max(length(c0 * pd.x + c1 * pd.y), 1e-30);
}
