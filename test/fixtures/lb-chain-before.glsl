// The straight-chain closure's own helpers (the border parameter and corner table of the conic walk, which _boxCov.glsl
// does not carry): this fixture is the closure in full, so it brings what it calls.
// CCW border param of a box-border point: bottom[0,1) right[1,2) top[2,3) left[3,4).
float bparamOf(vec2 p) {
  if (abs(p.y + 0.5) < 1e-4) return clamp(p.x + 0.5, 0.0, 1.0);
  if (abs(p.x - 0.5) < 1e-4) return 1.0 + clamp(p.y + 0.5, 0.0, 1.0);
  if (abs(p.y - 0.5) < 1e-4) return 2.0 + clamp(0.5 - p.x, 0.0, 1.0);
  return 3.0 + clamp(0.5 - p.y, 0.0, 1.0);
}
vec2 cornerOf(int j) {   // box corner at CCW param j+1 (1..4)
  return j == 0 ? vec2(0.5, -0.5) : (j == 1 ? vec2(0.5, 0.5) : (j == 2 ? vec2(-0.5, 0.5) : vec2(-0.5, -0.5)));
}
// Control arm: the straight-chain closure.
float chainBoxCovBefore(vec2 p0, vec2 p1, vec2 p2, vec2 p3, vec2 p4, float forceInside) {
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
  // WHICH POINTS START A PIECE. The chain can clip into the box as SEVERAL disjoint runs (a
  // corner box that two far-apart edges of a closed outline both cross; a thin feature the
  // outline leaves and re-enters), and the gap between one run's exit and the next run's entry
  // is BORDER, not outline — it has to be walked round the box on the fill side exactly the way
  // the wrap is. Shoelacing it as a straight chord is what made a RECTANGLE's own chain read
  // 113/255 at its corner pixel and a 12-gon's 213/255: two runs, one fabricated chord, and the
  // fill rectangle closed as a triangle — exactly half the true coverage, the same shape of
  // error as the one-lap corner bug below. One bit per point, so a 12-point polygon costs one
  // int; `conicChainBoxCov` carries the same information in a `bool isEntry[16]`.
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
    // LERP, NOT `A + t * d`. The two agree in exact arithmetic and not in float32: `A + 1.0 * d`
    // is `A + (B - A)`, which CANCELS — on a chain segment 512 cells long it reproduces B to
    // about 1.4e-5 rather than exactly, and at 94 cells to 6e-6. `mix` is exact at t == 0 and
    // t == 1 by construction, which is what the three identity tests downstream need. In float32
    // (`test/_glslEmu.mjs`) all three fail on the subtract-and-add form: the zero-length test below
    // sees a 8e-6 sliver instead of a touch and returns 0 for an auxiliary chain (a hole); the
    // `join` test between segments sharing an interior vertex stops firing; and the ring test falls
    // on the wrong side, walks a FULL LAP of the box and returns a solid 1.0 where the truth is 0.895.
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
  // miss → three modes by caller role. forceInside=2: the face's own chain —
  // grazing misses get the nearest segment's LINE coverage (razor-edge clip
  // losses snapped to solid 1.0 otherwise: the crotch over-fill class); far
  // misses stay 1.0. forceInside=1: AUXILIARY chain (chain 2/3) — its role is
  // to CARVE what the own chain can't see, and a mis-oriented near-window line
  // carves real fill (hundreds of holes), so its only safe miss is 1.0.
  // forceInside=0: strip mode, nearest-segment side (kind-13, dormant).
  if (n < 2) {
    if (forceInside > 1.5) { float mc = chainMissCov(p0, p1, p2, p3, p4);
      return mc < 0.0 ? 1.0 : mc; }
    return (forceInside > 0.5 || chainFillSide(p0, p1, p2, p3, p4)) ? 1.0 : 0.0;
  }
  // A CLOSED chain (p4 == p0) whose join point falls INSIDE the box is a RING, not two loose
  // ends: the last run's exit and the first run's entry are the same point, joined by the
  // outline itself. Extending both of them to the border (below) fabricates a wedge that is not
  // there — the outline does not continue past a join, it turns. Detected from the chain's own
  // points, so it costs one dot product and nothing else changes.
  bool ring = dot(p4 - p0, p4 - p0) < 1e-12
              && dot(poly[0] - poly[n - 1], poly[0] - poly[n - 1]) <= 1e-10 && n > 2;
  if (ring) { n--; entryMask = entryMask & ~1; }            // drop the duplicated join point
  // ENDS-ON-BORDER INVARIANT, by construction: a chain END strictly inside the
  // box (a real outline end, a crotch corner, a window cut) breaks the border
  // walk — bparamOf(interior point) closes a garbage polygon that can read
  // solid 1.0 on a half-covered box (the residual junction over-fill route).
  // Extend the interior endpoint along its terminal segment's DIRECTION to the
  // border (tangent continuation — the same local model as the grazing-miss
  // fix; error = the outline's bend past the end, small at grazing range).
  if (!ring) {
    vec2 dEnd = poly[n - 1] - poly[n - 2];
    if (max(abs(poly[n - 1].x), abs(poly[n - 1].y)) < 0.5 - 1e-4 && dot(dEnd, dEnd) > 1e-12 && n < 12) {
      vec2 dn = normalize(dEnd);
      float tx = abs(dn.x) > 1e-6 ? ((dn.x > 0.0 ? 0.5 : -0.5) - poly[n - 1].x) / dn.x : 1e9;
      float ty = abs(dn.y) > 1e-6 ? ((dn.y > 0.0 ? 0.5 : -0.5) - poly[n - 1].y) / dn.y : 1e9;
      poly[n] = poly[n - 1] + dn * min(tx, ty); n++;
    }
    vec2 dBeg = poly[1] - poly[0];
    if (max(abs(poly[0].x), abs(poly[0].y)) < 0.5 - 1e-4 && dot(dBeg, dBeg) > 1e-12 && n < 12) {
      vec2 dn = normalize(-dBeg);                       // backward along the first segment
      float tx = abs(dn.x) > 1e-6 ? ((dn.x > 0.0 ? 0.5 : -0.5) - poly[0].x) / dn.x : 1e9;
      float ty = abs(dn.y) > 1e-6 ? ((dn.y > 0.0 ? 0.5 : -0.5) - poly[0].y) / dn.y : 1e9;
      vec2 E2 = poly[0] + dn * min(tx, ty);
      for (int i = 11; i >= 1; i--) if (i <= n) poly[i] = poly[i - 1];   // shift right
      // Every flag rides its own point. The shifted head is no longer a piece START — it is
      // joined to the extension by the tangent — and the extension becomes the start.
      entryMask = ((entryMask << 1) | 1) & ~2;
      poly[0] = E2; n++;
    }
  }
  // CLOSE each PIECE along the border: from a piece's exit to the next piece's entry, wrapping.
  // A single-piece chain — every chain with one clipped run, which is the overwhelming majority —
  // has exactly one gap, the wrap, and walks it with the same tangent, the same tCCW and the same
  // two-lap corner scan as before: this is INERT there, by construction.
  float area = 0.0;
  for (int i = 0; i < 12; i++) {
    if (i >= n) break;
    int jn = (i + 1 == n) ? 0 : i + 1;
    vec2 a = poly[i], b = poly[jn];
    bool gap = (jn == 0 && !ring) || ((entryMask >> jn) & 1) != 0;
    if (!gap) { area += a.x * b.y - a.y * b.x; continue; }
    // The exit DIRECTION at `a` is its own run's last sub-segment; a straight chain's clipped
    // chord IS its tangent (which is why this needs no tanAt array, where the conic kernel does).
    // `i > 0` only guards the index: a run of ONE point needs n == 11 on entry, which cannot
    // happen at i == 0.
    vec2 dX = a - poly[i > 0 ? i - 1 : 1];
    vec2 leftN = vec2(-dX.y, dX.x);                         // fill side of the exit segment
    vec2 tCCW;                                              // CCW border tangent at the exit
    if (abs(a.y + 0.5) < 1e-4 && a.x < 0.5 - 1e-4) tCCW = vec2(1.0, 0.0);
    else if (abs(a.x - 0.5) < 1e-4 && a.y < 0.5 - 1e-4) tCCW = vec2(0.0, 1.0);
    else if (abs(a.y - 0.5) < 1e-4 && a.x > -0.5 + 1e-4) tCCW = vec2(-1.0, 0.0);
    else tCCW = vec2(0.0, -1.0);
    bool ccw = dot(tCCW, leftN) >= 0.0;                     // walk the border toward the fill
    // Corner candidates span TWO laps (8, index j%4): a walk that crosses the
    // param-0 origin needs the wrapped corners too. With only one lap, a chain
    // exiting at param 3.4 and re-entering at 1.6 (e.g. a leftward horizontal
    // edge, fill above) walked 3.4→5.6 but could never insert corner 5 (=1+4),
    // so the closure lost a box corner and the fill rectangle shoelaced as a
    // triangle — exactly HALF the true coverage (the H crossbar-band bug).
    float pa = bparamOf(a), pb = bparamOf(b);
    vec2 prev = a;
    if (ccw) { float pbW = pb < pa ? pb + 4.0 : pb;
      for (int j = 0; j < 8; j++) { float cp = float(j + 1);
        if (cp > pa + 1e-5 && cp < pbW - 1e-5) { vec2 cnr = cornerOf(j - (j / 4) * 4);
          area += prev.x * cnr.y - prev.y * cnr.x; prev = cnr; } }
    } else { float pbW = pb > pa ? pb - 4.0 : pb;
      for (int j = 7; j >= 0; j--) { float cp = float(j + 1) - 4.0;
        if (cp < pa - 1e-5 && cp > pbW + 1e-5) { vec2 cnr = cornerOf(j - (j / 4) * 4);
          area += prev.x * cnr.y - prev.y * cnr.x; prev = cnr; } }
    }
    area += prev.x * b.y - prev.y * b.x;
  }
  return clamp(abs(area) * 0.5, 0.0, 1.0);
}
