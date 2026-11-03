// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// exact coverage of a pixel box by a half-plane {p : n·p <= d}, |n| = 1, box = [-½,½]².
//
// ONE source of truth, included by both the band engines (@@COVERAGE@@ → _coverage.glsl, used by
// Slug's exact-edge branch and GWN's SDF combine) and the Loop-Blinn fragment shader, so LB and
// Slug cannot disagree at an AA edge: there is no second copy to keep in sync.
//
// Slug's default combiner reconstructs 2D area from two 1D axis-ray coverages blended by a
// center-proximity weight; that is exact only for axis-aligned edges. Against the true area: exact
// at 0°, a mean error of about 10/255 (max about 32) at 45°, about 5.6/255 over a full angle/offset sweep.
//
// But the two ray crossings Slug already computes — the edge's crossing of the horizontal center
// line at (rx,0) and of the vertical center line at (0,ry) — DETERMINE the line, so the exact area
// is available in closed form for ~10 flops. With a = max(|nx|,|ny|) and b = min(|nx|,|ny|), the
// area is piecewise: two quadratic corners and a linear middle.
float exactBoxCov(vec2 n, float d) {
  float a = max(abs(n.x), abs(n.y));
  float b = min(abs(n.x), abs(n.y));
  float s = 0.5 * (a + b);           // |d| beyond which the box is fully in/out
  float t = 0.5 * (a - b);
  if (d <= -s) return 0.0;
  if (d >=  s) return 1.0;
  float ab = max(2.0 * a * b, 1e-12);
  if (d <= -t) return (d + s) * (d + s) / ab;          // corner triangle
  if (d >=  t) return 1.0 - (s - d) * (s - d) / ab;    // complementary corner
  return 0.5 + d / max(a, 1e-12);                      // band: linear in d
}

// Exact pixel-box coverage of the INTERSECTION of two half-planes
// {p : n1·p ≤ d1} ∩ {p : n2·p ≤ d2}, |n|=1, box = [-½,½]².
// Sutherland–Hodgman clip + shoelace — same kernel as Slug/GWN's gwnBoxCov2.
// Kind-0/10's cheap covA+covB−1 overcounts acute tip intersections.
float exactBoxCov2(vec2 n1, float d1, vec2 n2, float d2) {
  vec2 poly[8];
  poly[0] = vec2(-0.5, -0.5); poly[1] = vec2(0.5, -0.5);
  poly[2] = vec2(0.5, 0.5);   poly[3] = vec2(-0.5, 0.5);
  poly[4] = vec2(0.0); poly[5] = vec2(0.0); poly[6] = vec2(0.0); poly[7] = vec2(0.0);
  int cnt = 4;
  for (int pass = 0; pass < 2; pass++) {
    vec2 n = pass == 0 ? n1 : n2;
    float d = pass == 0 ? d1 : d2;
    vec2 tmp[8];
    int m = 0;
    for (int i = 0; i < 8; i++) {
      if (i >= cnt) break;
      vec2 a = poly[i];
      vec2 b = poly[(i + 1 == cnt) ? 0 : i + 1];
      float fa = dot(n, a) - d, fb = dot(n, b) - d;
      if (fa <= 0.0 && m < 8) { tmp[m] = a; m++; }
      if ((fa < 0.0) != (fb < 0.0) && m < 8) { tmp[m] = mix(a, b, fa / (fa - fb)); m++; }
    }
    for (int i = 0; i < 8; i++) poly[i] = i < m ? tmp[i] : vec2(0.0);
    cnt = m;
    if (cnt == 0) return 0.0;
  }
  float area = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= cnt) break;
    vec2 a = poly[i], b = poly[(i + 1 == cnt) ? 0 : i + 1];
    area += a.x * b.y - a.y * b.x;
  }
  return abs(area) * 0.5;
}

// Exact pixel-box coverage of THREE half-planes' intersection -- exactBoxCov2 with one more clip. A convex clip adds at most
// one vertex per pass, so the box's four corners never outgrow the eight slots. CPatch's relaxed seam uses it: the patch's two
// tightest outline constraints and its own side of its tightest cut.
float exactBoxCov3(vec2 n1, float d1, vec2 n2, float d2, vec2 n3, float d3) {
  vec2 poly[8];
  poly[0] = vec2(-0.5, -0.5); poly[1] = vec2(0.5, -0.5);
  poly[2] = vec2(0.5, 0.5);   poly[3] = vec2(-0.5, 0.5);
  poly[4] = vec2(0.0); poly[5] = vec2(0.0); poly[6] = vec2(0.0); poly[7] = vec2(0.0);
  int cnt = 4;
  for (int pass = 0; pass < 3; pass++) {
    vec2 n = pass == 0 ? n1 : (pass == 1 ? n2 : n3);
    float d = pass == 0 ? d1 : (pass == 1 ? d2 : d3);
    vec2 tmp[8];
    int m = 0;
    for (int i = 0; i < 8; i++) {
      if (i >= cnt) break;
      vec2 a = poly[i];
      vec2 b = poly[(i + 1 == cnt) ? 0 : i + 1];
      float fa = dot(n, a) - d, fb = dot(n, b) - d;
      if (fa <= 0.0 && m < 8) { tmp[m] = a; m++; }
      if ((fa < 0.0) != (fb < 0.0) && m < 8) { tmp[m] = mix(a, b, fa / (fa - fb)); m++; }
    }
    for (int i = 0; i < 8; i++) poly[i] = i < m ? tmp[i] : vec2(0.0);
    cnt = m;
    if (cnt == 0) return 0.0;
  }
  float area = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= cnt) break;
    vec2 a = poly[i], b = poly[(i + 1 == cnt) ? 0 : i + 1];
    area += a.x * b.y - a.y * b.x;
  }
  return abs(area) * 0.5;
}

// Is the cell center (0,0) on the FILL (left) side of the chain? Nearest-segment
// side test (strip-mode miss resolution, kind-13).
bool chainFillSide(vec2 p0, vec2 p1, vec2 p2, vec2 p3, vec2 p4) {
  float best = 1e30; bool side = true;
  for (int s = 0; s < 4; s++) {
    vec2 A = s == 0 ? p0 : (s == 1 ? p1 : (s == 2 ? p2 : p3));
    vec2 B = s == 0 ? p1 : (s == 1 ? p2 : (s == 2 ? p3 : p4));
    vec2 d = B - A; float L2 = dot(d, d); if (L2 < 1e-20) continue;
    float t = clamp(dot(-A, d) / L2, 0.0, 1.0);
    vec2 c = A + t * d; float dd = dot(c, c);
    if (dd < best) { best = dd; side = (d.y * A.x - d.x * A.y) >= 0.0; }
  }
  return side;
}

// Coverage for a box the clip MISSED, from the NEAREST chain segment's LINE
// half-plane (exactBoxCov). A binary in/out resolution would be a razor edge:
// a box GRAZING a chain endpoint loses the Liang–Barsky clip by an ulp and
// would snap to solid 1.0 — over-fill at a glyph's crotch, the same fragment
// flipping between its exact coverage and solid 1.0 across shader recompiles.
// The nearest segment's line is the correct local model wherever the chain is
// locally straight, extends the segment past its endpoint for grazing misses,
// and degenerates to exactly 1.0 / 0.0 for far boxes — no threshold at all.
// Fill is LEFT of A→B, so the outward normal is the right perp (d.y, −d.x).
// Returns −1.0 when every segment is degenerate (padding-only chain).
float chainMissCov(vec2 p0, vec2 p1, vec2 p2, vec2 p3, vec2 p4) {
  float best = 1e30; vec2 bA = vec2(0.0), bd2 = vec2(0.0); bool found = false;
  int bs = -1, firstS = 9, lastS = -1; float bt = 0.0;
  for (int s = 0; s < 4; s++) {
    vec2 A = s == 0 ? p0 : (s == 1 ? p1 : (s == 2 ? p2 : p3));
    vec2 B = s == 0 ? p1 : (s == 1 ? p2 : (s == 2 ? p3 : p4));
    vec2 d = B - A; float L2 = dot(d, d); if (L2 < 1e-20) continue;
    if (s < firstS) firstS = s;
    lastS = s;
    float tu = dot(-A, d) / L2;
    float t = clamp(tu, 0.0, 1.0);
    vec2 c = A + t * d; float dd = dot(c, c);
    if (dd < best) { best = dd; bA = A; bd2 = d; found = true; bs = s; bt = tu; }
  }

  if (!found || best > 2.0) return -1.0;
    //
  // Only a terminal gets "no opinion", which the caller reads as solid for a face's own chain.
  if ((bt < 0.0 && bs == firstS) || (bt > 1.0 && bs == lastS)) return -1.0;
  vec2 nOut = normalize(vec2(bd2.y, -bd2.x));
  float c1 = exactBoxCov(nOut, dot(nOut, bA));

  bool atEnd = bt > 1.0, atStart = bt < 0.0;
  if (atEnd || atStart) {
    int s2 = atEnd ? bs + 1 : bs - 1;
    vec2 A2 = vec2(0.0), d2 = vec2(0.0);
    for (int k = 0; k < 4; k++) {          // the neighbor past any degenerate padding
      if (s2 < 0 || s2 > 3) break;
      A2 = s2 == 0 ? p0 : (s2 == 1 ? p1 : (s2 == 2 ? p2 : p3));
      d2 = (s2 == 0 ? p1 : (s2 == 1 ? p2 : (s2 == 2 ? p3 : p4))) - A2;
      if (dot(d2, d2) >= 1e-20) break;
      s2 += atEnd ? 1 : -1;
    }
    if (s2 >= 0 && s2 <= 3 && dot(d2, d2) >= 1e-20) {
      vec2 n2 = normalize(vec2(d2.y, -d2.x));
      float c2 = exactBoxCov(n2, dot(n2, A2));
      float c12 = exactBoxCov2(nOut, dot(nOut, bA), n2, dot(n2, A2));
      vec2 dIn = atEnd ? bd2 : d2, dOut = atEnd ? d2 : bd2;
      float turn = dIn.x * dOut.y - dIn.y * dOut.x;
      if (turn > 0.0) return c12;
      if (turn < 0.0) return c1 + c2 - c12;
    }
  }
  return c1;
}

// THE analytic interior coverage: area(pixel box ∩ fill), fill = LEFT of the local
// outline chain p0→p1→p2→p3 (CELL coords, box [-½,½]²). Clips the chain to the box
// (Liang–Barsky per segment) and shoelaces the fill polygon, closed along the box
// border on the fill side (border-walk direction = the box tangent on the fill
// side of the exit segment). Exact for edges, stems, convex AND reflex corners,
// tips, and junctions — NO corner-type tag, NO proximity gate: span falls out of
// clipping segments to the box.
// An interior triangle whose box the chain misses is fully inside ⇒ returns 1.
// forceInside=1 → a box the chain misses is INSIDE (kind-0 interior faces are
// inside the fill by construction). forceInside=0 → resolve by chainFillSide
// (strips, whose band straddles the edge into the exterior).
// CCW border param of a box-border point: bottom[0,1) right[1,2) top[2,3) left[3,4). The side is the one the point's
// LARGER coordinate lies on: taking the first side within 1e-4 gave a point on one side near a corner the
// other side's parameter.
float chainBorderParam(vec2 p) {
  if (abs(p.y) >= abs(p.x)) return p.y < 0.0 ? clamp(p.x + 0.5, 0.0, 1.0) : 2.0 + clamp(0.5 - p.x, 0.0, 1.0);
  return p.x > 0.0 ? 1.0 + clamp(p.y + 0.5, 0.0, 1.0) : 3.0 + clamp(0.5 - p.y, 0.0, 1.0);
}

float chainBoxCov(vec2 p0, vec2 p1, vec2 p2, vec2 p3, vec2 p4, float forceInside) {
  // exact early out. A chain whose bbox lies past sqrt(2) cells of the center on some axis cannot
  // clip the box and chainMissCov returns -1 for it (best > 2.0), so the own chain reads 1.0; an
  // auxiliary chain (forceInside 1) reads 1.0 as soon as its bbox misses the box.
  {
    vec2 lo = min(min(min(p0, p1), min(p2, p3)), p4), hi = max(max(max(p0, p1), max(p2, p3)), p4);
    float m = forceInside > 1.5 ? 1.414215 : 0.500001;
    if (hi.x < -m || lo.x > m || hi.y < -m || lo.y > m) return (forceInside > 0.5) ? 1.0 : (chainFillSide(p0, p1, p2, p3, p4) ? 1.0 : 0.0);
  }
  vec2 poly[12];
  int n = 0;
  // Which points start a piece. The chain can clip into the box as SEVERAL disjoint runs (a
  // corner box that two far-apart edges of a closed outline both cross; a thin feature the
  // outline leaves and re-enters), and the gap after a run's exit is BORDER, not outline — it is
  // closed along the box like the wrap (below). Shoelacing it as a straight chord is what made a
  // RECTANGLE's own chain read 113/255 at its corner pixel and a 12-gon's 213/255: two runs, one
  // fabricated chord, and the fill rectangle closed as a triangle — exactly half the true
  // coverage. One bit per point, so a 12-point polygon costs one int.
  int entryMask = 0;
  for (int s = 0; s < 4; s++) {
    vec2 A = s == 0 ? p0 : (s == 1 ? p1 : (s == 2 ? p2 : p3));
    vec2 B = s == 0 ? p1 : (s == 1 ? p2 : (s == 2 ? p3 : p4));
    vec2 d = B - A;
    if (dot(d, d) < 1e-12) continue;                       // degenerate (padding) segment
    vec2 lo = min(A, B), hi = max(A, B);
    if (hi.x < -0.500001 || lo.x > 0.500001 || hi.y < -0.500001 || lo.y > 0.500001) continue;
    float t0 = 0.0, t1 = 1.0; bool ok = true;              // Liang–Barsky clip to box
    for (int k = 0; k < 4; k++) {
      float P = k == 0 ? -d.x : (k == 1 ? d.x : (k == 2 ? -d.y : d.y));
      float Q = k == 0 ? A.x + 0.5 : (k == 1 ? 0.5 - A.x : (k == 2 ? A.y + 0.5 : 0.5 - A.y));
      if (abs(P) < 1e-12) { if (Q < 0.0) ok = false; }
      else { float r = Q / P;
        if (P < 0.0) { if (r > t1) ok = false; else if (r > t0) t0 = r; }
        else { if (r < t0) ok = false; else if (r < t1) t1 = r; } }
    }
    if (!ok || t1 < t0) continue;

    vec2 A2 = mix(A, B, t0), B2 = mix(A, B, t1);
    // A ZERO-LENGTH RUN IS A TOUCH, NOT A RUN. An outline VERTEX sitting on the box border clips
    // its two segments to t0 == t1 there: the run has no length, no area and no direction, so it
    // can neither carry the shoelace nor orient a border walk. Kept, it defeated the `n < 2` miss
    // path — two coincident points are n == 2 — and the closure then walked a zero-length border
    // arc and returned area 0. For an AUXILIARY chain, whose whole contract is that its only safe
    // miss is 1.0, that 0 went through the caller's min() and punched a HOLE: a 12-gon's vertex
    // pixel read 0/255 where the path covers 0.837 (213/255 of missing ink, its worst pixel).
    if (dot(B2 - A2, B2 - A2) < 1e-12) continue;
    bool join = n > 0 && dot(poly[n - 1] - A2, poly[n - 1] - A2) <= 1e-10;
    if (!join && n < 12) { poly[n] = A2; entryMask |= 1 << n; n++; }
    if (n < 12) { poly[n] = B2; n++; }
  }

  if (n < 2) {
    if (forceInside > 1.5) { float mc = chainMissCov(p0, p1, p2, p3, p4);
      return mc < 0.0 ? 1.0 : mc; }
    return (forceInside > 0.5 || chainFillSide(p0, p1, p2, p3, p4)) ? 1.0 : 0.0;
  }
  // A closed chain (p4 == p0) whose join point falls INSIDE the box is a RING, not two loose
  // ends: the last run's exit and the first run's entry are the same point, joined by the
  // outline itself. Extending both of them to the border (below) fabricates a wedge that is not
  // there — the outline does not continue past a join, it turns. Detected from the chain's own
  // points, so it costs one dot product and nothing else changes.
  bool ring = dot(p4 - p0, p4 - p0) < 1e-12
              && dot(poly[0] - poly[n - 1], poly[0] - poly[n - 1]) <= 1e-10 && n > 2;
  if (ring) { n--; entryMask = entryMask & ~1; }            // drop the duplicated join point
  // ENDS-ON-BORDER INVARIANT, by construction: a chain END strictly inside the
  // box (a real outline end, a crotch corner, a window cut) breaks the border
  // walk — chainBorderParam(interior point) closes a garbage polygon that can read
  // solid 1.0 on a half-covered box (the residual junction over-fill route).
  // Extend the interior endpoint along its terminal segment's DIRECTION to the
  // border (tangent continuation — the same local model as the grazing-miss
  // fix; error = the outline's bend past the end, small at grazing range).
  // WHETHER to extend is the ray's to say, not the end's distance from the border: an
  // end within 1e-4 of one border whose ray runs back across the box, left as if the outline
  // entered there, would read up to the complement. An end on the border whose ray leaves the box --
  // every clipped exit and entry -- has t = 0 up to rounding, and a rounding-sized extension lies
  // on the border with it.
  if (!ring) {
    vec2 dEnd = poly[n - 1] - poly[n - 2];
    if (dot(dEnd, dEnd) > 1e-12 && n < 12) {
      vec2 dn = normalize(dEnd);
      float tx = abs(dn.x) > 1e-6 ? ((dn.x > 0.0 ? 0.5 : -0.5) - poly[n - 1].x) / dn.x : 1e9;
      float ty = abs(dn.y) > 1e-6 ? ((dn.y > 0.0 ? 0.5 : -0.5) - poly[n - 1].y) / dn.y : 1e9;
      float t = min(tx, ty);
      if (t > 0.0) { poly[n] = poly[n - 1] + dn * t; n++; }
    }
    vec2 dBeg = poly[1] - poly[0];
    if (dot(dBeg, dBeg) > 1e-12 && n < 12) {
      vec2 dn = normalize(-dBeg);                       // backward along the first segment
      float tx = abs(dn.x) > 1e-6 ? ((dn.x > 0.0 ? 0.5 : -0.5) - poly[0].x) / dn.x : 1e9;
      float ty = abs(dn.y) > 1e-6 ? ((dn.y > 0.0 ? 0.5 : -0.5) - poly[0].y) / dn.y : 1e9;
      float t = min(tx, ty);
      if (t > 0.0) {
        vec2 E2 = poly[0] + dn * t;
        for (int i = 11; i >= 1; i--) if (i <= n) poly[i] = poly[i - 1];   // shift right
        // Every flag rides its own point. The shifted head is not a piece START any more — it is
        // joined to the extension by the tangent — and the extension becomes the start.
        entryMask = ((entryMask << 1) | 1) & ~2;
        poly[0] = E2; n++;
      }
    }
  }
  // CLOSE ALONG THE BORDER BY SUMS, as the cubic chain does. The fill region's boundary is the chain's
  // runs inside the box and, from each run's exit, the border walked counterclockwise to the NEXT crossing, which is
  // an entry -- of whichever run meets the border there first, not of the next run in chain order: runs that
  // interleave along the border (a chain that leaves the box and re-enters it past where it will leave again), closed
  // exit-to-next-run's-entry, would read up to the complement. By
  // Green's theorem the area is (1/2) the runs' shoelace plus (1/4) the border length inside the fill; with the border
  // parameterized counterclockwise from (-1/2, -1/2) (chainBorderParam), that length is sum(entry p) - sum(exit p), + 4 when
  // the crossing of least p is an entry. A chain that closes on itself inside the box with no crossing (a RING in
  // the box) bounds its own area, or the box less it when it winds clockwise.
  float area2 = 0.0, bsum = 0.0, minP = 8.0;
  bool minEntry = false, anyGap = false;
  for (int i = 0; i < 12; i++) {
    if (i >= n) break;
    int jn = (i + 1 == n) ? 0 : i + 1;
    vec2 a = poly[i], b = poly[jn];
    bool gap = (jn == 0 && !ring) || ((entryMask >> jn) & 1) != 0;
    if (!gap) { area2 += a.x * b.y - a.y * b.x; continue; }
    anyGap = true;
    float pa = chainBorderParam(a), pb = chainBorderParam(b);                // a run's exit, a run's entry
    bsum += pb - pa;
    if (pa < minP) { minP = pa; minEntry = false; }
    if (pb < minP) { minP = pb; minEntry = true; }
  }
  if (!anyGap) return clamp(0.5 * area2 + (area2 < 0.0 ? 1.0 : 0.0), 0.0, 1.0);
  return clamp(0.5 * area2 + 0.25 * (bsum + (minEntry ? 4.0 : 0.0)), 0.0, 1.0);
}
