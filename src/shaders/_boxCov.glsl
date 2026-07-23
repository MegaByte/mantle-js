// EXACT coverage of a pixel box by a half-plane {p : n·p <= d}, |n| = 1, box = [-½,½]².
//
// ONE source of truth, included by both the band engines (@@COVERAGE@@ → _coverage.glsl, used by
// Slug's exact-edge branch and GWN's SDF combine) and the Loop-Blinn fragment shader. It used to
// exist as two byte-identical copies whose comments each said "the two MUST stay identical, or LB
// and Slug disagree at every AA edge" — a rule with nothing enforcing it. Now there is nothing to
// keep in sync.
//
// Slug's default combiner reconstructs 2D area from two 1D axis-ray coverages blended by a
// centre-proximity weight; that is exact only for axis-aligned edges. Measured against the true
// area: 0.000/255 at 0°, mean 10.6 and max 31.9 at 45°, mean 5.57 over a full angle/offset sweep.
//
// But the two ray crossings Slug already computes — the edge's crossing of the horizontal centre
// line at (rx,0) and of the vertical centre line at (0,ry) — DETERMINE the line, so the exact area
// is available in closed form for ~10 flops. With a = max(|nx|,|ny|) and b = min(|nx|,|ny|), the
// area is piecewise: two quadratic corners and a linear middle.
float exactBoxCov(vec2 n, float d) {
  float a = max(abs(n.x), abs(n.y));
  float b = min(abs(n.x), abs(n.y));
  float s = 0.5 * (a + b);           // |d| beyond which the box is fully in/out
  float t = 0.5 * (a - b);           // |d| below which the cut is a full-width band
  // Branchy ON PURPOSE. A branchless four-ramp form (r(d±s)², r(d±t)²) is algebraically
  // identical (checked to 1.5e-12 over 200k samples) but MEASURED SLOWER: most fragments are
  // fully inside or fully outside, and the two early-outs skip everything.
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
// Is the cell centre (0,0) on the FILL (left) side of the chain? Nearest-segment
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
// half-plane (exactBoxCov). The old binary in/out resolution was a razor edge:
// a box GRAZING a chain endpoint loses the Liang–Barsky clip by an ulp and
// snapped to solid 1.0 — the crotch-core over-fill class (N (38,159): the same
// fragment flipped between exact 0.53 and solid 1.0 across shader recompiles).
// The nearest segment's line is the correct local model wherever the chain is
// locally straight, extends the segment past its endpoint for grazing misses,
// and degenerates to exactly 1.0 / 0.0 for far boxes — no threshold at all.
// Fill is LEFT of A→B, so the outward normal is the right perp (d.y, −d.x).
// Returns −1.0 when every segment is degenerate (padding-only chain).
float chainMissCov(vec2 p0, vec2 p1, vec2 p2, vec2 p3, vec2 p4) {
  float best = 1e30; vec2 bA = vec2(0.0), bd2 = vec2(0.0); bool found = false;
  for (int s = 0; s < 4; s++) {
    vec2 A = s == 0 ? p0 : (s == 1 ? p1 : (s == 2 ? p2 : p3));
    vec2 B = s == 0 ? p1 : (s == 1 ? p2 : (s == 2 ? p3 : p4));
    vec2 d = B - A; float L2 = dot(d, d); if (L2 < 1e-20) continue;
    float t = clamp(dot(-A, d) / L2, 0.0, 1.0);
    vec2 c = A + t * d; float dd = dot(c, c);
    if (dd < best) { best = dd; bA = A; bd2 = d; found = true; }
  }
  // GATED to grazing reach: the linear model is only meaningful where the box
  // can actually see the boundary (≤ ~1.4 cells). A FAR segment's line must not
  // extend its judgment across the glyph — chain 2's min() turned that into
  // 253-value holes on every junction glyph (measured). Far ⇒ −1 ⇒ caller's
  // binary, where "far" correctly means "no opinion" (forceInside).
  if (!found || best > 2.0) return -1.0;
  vec2 nOut = normalize(vec2(bd2.y, -bd2.x));
  return exactBoxCov(nOut, dot(nOut, bA));
}

// ── EXACT CONIC CHAIN ───────────────────────────────────────────────────────
// area(box ∩ fill) where the boundary is TWO QUADRATIC BÉZIER segments
// p0 –c0→ p1 –c1→ p2 (fill on the LEFT), instead of four straight ones. One
// conic segment represents a whole glyph arc EXACTLY, so there is no sagitta
// to trade against chain reach — the accuracy floor the polyline chain has.
//
// Same kernel as chainBoxCov plus one closed-form term per segment: shoelace
// the clipped CHORDS, then add the exact area between each chord and its arc,
// (2/3)·cross(P1−P0, P2−P0) — Archimedes' quadrature of the parabola. A
// straight segment is the degenerate case c = midpoint, where that cross is
// exactly 0, so lines and curves share ONE path with no branch.
//
// Validated on the CPU twin (probes/_polyClipConic.mjs) against the polyline
// kernel at 16384 pieces/arc: 20 named cases 0.00/255, 2292 random arcs
// 0.16/255. Two constructions the curved case needs and the straight one does
// not: the fill side comes from the exit TANGENT (a curved clipped chord can
// point far from the tangent; near-tangential exits otherwise flip the walk
// and return exactly the complement), and pieces are closed INDIVIDUALLY along
// the border (a chain that leaves and re-enters must walk the corner, not jump).
vec2 qAtC(vec2 A, vec2 C, vec2 B, float t) {
  float u = 1.0 - t;
  return u * u * A + 2.0 * u * t * C + t * t * B;
}
vec2 qTanC(vec2 A, vec2 C, vec2 B, float t) {
  float u = 1.0 - t;
  return 2.0 * (u * (C - A) + t * (B - C));
}
vec2 qSubCtrlC(vec2 A, vec2 C, vec2 B, float u, float v) {
  return (1.0 - u) * (1.0 - v) * A + (u * (1.0 - v) + v * (1.0 - u)) * C + (u * v) * B;
}
// EXACT side of a quadratic arc, for the box the clip missed.
//
// In the arc's own affine frame (e1 = C−A, e2 = B−A) a point on the curve is
// Q(t) − A = 2t(1−t)·e1 + t²·e2, so its barycentric pair is (a,b) = (2t(1−t), t²).
// Then t = √b and a + 2b = 2√b, i.e. u² = v exactly, with u = a/2 + b, v = b —
// the Loop-Blinn implicit, but derived here rather than assumed, because the
// FRAME matters: this is the segment's own frame, not the shape's.
//
// u²−v > 0 is the CONTROL-POINT side (C itself gives ¼). Fill is LEFT of A→B,
// and C lies left of A→B exactly when cross(e1,e2) < 0, so the fill side is
//     (u²−v)·cross(e1,e2) < 0
// in BOTH the convex and the concave case, with no orientation tag. Returns 0
// for a degenerate segment, meaning "no opinion".
float quadArcSide(vec2 A, vec2 C, vec2 B, vec2 p) {
  vec2 e1 = C - A, e2 = B - A, r = p - A;
  float det = e1.x * e2.y - e1.y * e2.x;
  if (abs(det) < 1e-20) return 0.0;
  float a = (r.x * e2.y - r.y * e2.x) / det;
  float b = (e1.x * r.y - e1.y * r.x) / det;
  float u = 0.5 * a + b, v = b;
  return (u * u - v) * det;
}
float conicChainBoxCov(vec2 p0, vec2 c0, vec2 p1, vec2 c1, vec2 p2, float forceInside) {
  if (forceInside > 1.5) {
    vec2 lo = min(min(min(p0, c0), min(p1, c1)), p2);
    vec2 hi = max(max(max(p0, c0), max(p1, c1)), p2);
    if (hi.x < -0.500001 || lo.x > 0.500001 || hi.y < -0.500001 || lo.y > 0.500001) return 1.0;
  }
  vec2 poly[16];
  vec2 tanAt[16];         // exit tangent carried per emitted vertex
  bool isEntry[16];       // vertex starts a new inside PIECE
  int n = 0;
  float corr = 0.0;       // Σ 2×(arc − chord) area
  for (int s = 0; s < 2; s++) {
    vec2 A = s == 0 ? p0 : p1;
    vec2 C = s == 0 ? c0 : c1;
    vec2 B = s == 0 ? p1 : p2;
    if (dot(B - A, B - A) < 1e-12 && dot(C - A, C - A) < 1e-12) continue;   // padding
    vec2 lo = min(A, min(C, B)), hi = max(A, max(C, B));
    if (hi.x < -0.500001 || lo.x > 0.500001 || hi.y < -0.500001 || lo.y > 0.500001) continue;
    // roots of x(t)=±½, y(t)=±½ → candidate split params, plus the ends
    float ts[10];
    int m = 0;
    ts[m++] = 0.0; ts[m++] = 1.0;
    for (int ax = 0; ax < 2; ax++) {
      float Aa = ax == 0 ? A.x : A.y, Ca = ax == 0 ? C.x : C.y, Ba = ax == 0 ? B.x : B.y;
      float qa = Aa - 2.0 * Ca + Ba, qb = 2.0 * (Ca - Aa);
      for (int li = 0; li < 2; li++) {
        float qc = Aa - (li == 0 ? -0.5 : 0.5);
        if (abs(qa) < 1e-14) {
          if (abs(qb) > 1e-14) { float t = -qc / qb; if (t > 1e-9 && t < 1.0 - 1e-9 && m < 10) ts[m++] = t; }
        } else {
          float disc = qb * qb - 4.0 * qa * qc;
          if (disc >= 0.0) {
            float sq = sqrt(disc);
            float qq = -0.5 * (qb + (qb >= 0.0 ? sq : -sq));
            float r0 = qq / qa, r1 = abs(qq) > 1e-30 ? qc / qq : 1e9;
            if (r0 > 1e-9 && r0 < 1.0 - 1e-9 && m < 10) ts[m++] = r0;
            if (r1 > 1e-9 && r1 < 1.0 - 1e-9 && m < 10) ts[m++] = r1;
          }
        }
      }
    }
    for (int i = 1; i < 10; i++) {           // insertion sort (m ≤ 10)
      if (i >= m) break;
      float key = ts[i]; int j = i - 1;
      for (int k = 0; k < 10; k++) { if (j < 0 || ts[j] <= key) break; ts[j + 1] = ts[j]; j--; }
      ts[j + 1] = key;
    }
    for (int i = 0; i < 9; i++) {
      if (i + 1 >= m) break;
      float u = ts[i], v = ts[i + 1];
      if (v - u < 1e-12) continue;
      vec2 mid = qAtC(A, C, B, 0.5 * (u + v));
      if (max(abs(mid.x), abs(mid.y)) > 0.5 + 1e-9) continue;      // this span is outside
      vec2 P0 = qAtC(A, C, B, u), P2 = qAtC(A, C, B, v);
      vec2 P1 = qSubCtrlC(A, C, B, u, v);
      corr += (2.0 / 3.0) * ((P1.x - P0.x) * (P2.y - P0.y) - (P1.y - P0.y) * (P2.x - P0.x));
      bool join = n > 0 && dot(poly[n - 1] - P0, poly[n - 1] - P0) < 1e-18;
      if (!join && n < 16) { poly[n] = P0; tanAt[n] = qTanC(A, C, B, u); isEntry[n] = true; n++; }
      if (n < 16) { poly[n] = P2; tanAt[n] = qTanC(A, C, B, v); isEntry[n] = false; n++; }
    }
  }
  if (n < 2) {
    // The ARC does not cross the box, so the box lies ENTIRELY on one side of
    // it and the exact coverage is exactly 0 or 1 — a partial model is not an
    // approximation here, it is a wrong answer. chainMissCov's is the CHORD's
    // half-plane, and a box between a convex chord and its arc is inside the
    // fill while reading outside the chord: that sagitta IS the quad-seam
    // under-coverage (maxUnder 0.384 against maxOver 0.004, all of it at the
    // arc joints where the miss path is taken). Resolve on the exact quadratic
    // instead, choosing the segment whose chord is nearest the box centre.
    float dA = 1e30, dB = 1e30;
    { vec2 d = p1 - p0; float L2 = dot(d, d);
      if (L2 > 1e-20) { vec2 c = p0 + clamp(dot(-p0, d) / L2, 0.0, 1.0) * d; dA = dot(c, c); } }
    { vec2 d = p2 - p1; float L2 = dot(d, d);
      if (L2 > 1e-20) { vec2 c = p1 + clamp(dot(-p1, d) / L2, 0.0, 1.0) * d; dB = dot(c, c); } }
    // GATED TO GRAZING REACH — the guard chainMissCov had and this replacement
    // dropped. An arc's implicit side test is only meaningful NEAR that arc; for a
    // box far from the chain it still returns a confident verdict, and when that
    // verdict is "outside" a DEEP INTERIOR pixel comes back 0. That is missing
    // paint inside the shape: measured 193 white pixels at up to 0.68 on real art
    // (word-bubbles/fish8.30) where Slug and AAC have none.
    //
    // chainMissCov's own threshold was `best > 2.0` (squared cell distance, ~1.4
    // cells) returning -1 = "no opinion", which the caller resolves with
    // forceInside. Keep exactly that reach so the quad-seam fix — which lives AT
    // the arc joints, i.e. within reach — is unaffected.
    // Reach is ONE CELL (squared), not chainMissCov's 2.0 (~1.41 cells). The
    // implicit side test is only locally valid, and a box a cell and a half from
    // the arc can still be handed a confident wrong verdict: at 2.0 real art kept
    // 18 interior holes at 0.68 (word-bubbles/fish8.37), at 1.0 it keeps NONE.
    // Loosening confirms the direction — 8.0 gives 37 holes, ungated 178. Values
    // below 1.0 measure identically, so this sits on the plateau rather than on a
    // tuned edge. A pixel box's half-diagonal is 0.707 cells (0.5 squared), so one
    // cell is "the arc passes through or immediately beside this box".
    // An INTERIOR face (forceInside > 1.5) is inside the fill BY CONSTRUCTION —
    // that assertion is what the caller is passing down. A single arc's implicit
    // cannot outrank it: the arc may belong to a DIFFERENT part of the outline,
    // in which case "outside this arc" says nothing about the shape. Measured on
    // real art: the last interior row before a boundary came back 0 (a 20px
    // horizontal run of missing paint, word-bubbles/fish8.30) because a nearby
    // arc's side test vetoed a face the builder had already classified interior.
    // Tightening the reach does not reach it — the arc is within a twentieth of a
    // cell, so no distance gate can separate the two situations.
    //
    // The side test still decides for STRIPS (forceInside <= 1.5), which straddle
    // the boundary and genuinely need it.
    if (forceInside > 1.5) return 1.0;
    float near2 = min(dA, dB);
    if (near2 > 1.0) return forceInside > 0.5 ? 1.0 : 0.0;
    float sd = dA <= dB ? quadArcSide(p0, c0, p1, vec2(0.0)) : quadArcSide(p1, c1, p2, vec2(0.0));
    if (sd == 0.0) sd = dA <= dB ? quadArcSide(p1, c1, p2, vec2(0.0)) : quadArcSide(p0, c0, p1, vec2(0.0));
    if (sd != 0.0) return sd < 0.0 ? 1.0 : 0.0;
    return forceInside > 0.5 ? 1.0 : 0.0;          // degenerate chain → caller's default
  }
  // ENDS-ON-BORDER INVARIANT — extend along the terminal TANGENT, not the chord.
  if (max(abs(poly[n - 1].x), abs(poly[n - 1].y)) < 0.5 - 1e-4 && n < 16) {
    vec2 dn = normalize(tanAt[n - 1]);
    float tx = abs(dn.x) > 1e-6 ? ((dn.x > 0.0 ? 0.5 : -0.5) - poly[n - 1].x) / dn.x : 1e9;
    float ty = abs(dn.y) > 1e-6 ? ((dn.y > 0.0 ? 0.5 : -0.5) - poly[n - 1].y) / dn.y : 1e9;
    poly[n] = poly[n - 1] + dn * min(tx, ty); tanAt[n] = tanAt[n - 1]; isEntry[n] = false; n++;
  }
  if (max(abs(poly[0].x), abs(poly[0].y)) < 0.5 - 1e-4 && n < 16) {
    vec2 dn = normalize(-tanAt[0]);
    float tx = abs(dn.x) > 1e-6 ? ((dn.x > 0.0 ? 0.5 : -0.5) - poly[0].x) / dn.x : 1e9;
    float ty = abs(dn.y) > 1e-6 ? ((dn.y > 0.0 ? 0.5 : -0.5) - poly[0].y) / dn.y : 1e9;
    vec2 E2 = poly[0] + dn * min(tx, ty);
    for (int i = 15; i >= 1; i--) if (i <= n) { poly[i] = poly[i - 1]; tanAt[i] = tanAt[i - 1]; isEntry[i] = isEntry[i - 1]; }
    // The shifted original head is no longer a piece START — it is joined to the
    // extension by the tangent. Leaving its entry flag set makes the closure
    // insert a spurious border walk between two connected points, and the walk
    // then runs the wrong way round the box: the coverage comes back as the
    // COMPLEMENT (measured on o (116,118): 238 where the truth is 10).
    poly[0] = E2; isEntry[0] = true; isEntry[1] = false; n++;
  }
  // Close each PIECE along the border: from a piece's exit to the next piece's
  // entry (wrapping), heading into the fill per the exit TANGENT.
  float area = 0.0;
  for (int i = 0; i < 16; i++) {
    if (i >= n) break;
    int jn = (i + 1 == n) ? 0 : i + 1;
    vec2 a = poly[i], b = poly[jn];
    bool gap = (jn == 0) || isEntry[jn];        // piece boundary → border walk
    if (!gap) { area += a.x * b.y - a.y * b.x; continue; }
    vec2 dX = tanAt[i];
    vec2 leftN = vec2(-dX.y, dX.x);
    vec2 tCCW;
    if (abs(a.y + 0.5) < 1e-4 && a.x < 0.5 - 1e-4) tCCW = vec2(1.0, 0.0);
    else if (abs(a.x - 0.5) < 1e-4 && a.y < 0.5 - 1e-4) tCCW = vec2(0.0, 1.0);
    else if (abs(a.y - 0.5) < 1e-4 && a.x > -0.5 + 1e-4) tCCW = vec2(-1.0, 0.0);
    else tCCW = vec2(0.0, -1.0);
    bool ccw = dot(tCCW, leftN) >= 0.0;
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
  return clamp(abs(area + corr) * 0.5, 0.0, 1.0);
}

// THE analytic interior coverage: area(pixel box ∩ fill), fill = LEFT of the local
// outline chain p0→p1→p2→p3 (CELL coords, box [-½,½]²). Clips the chain to the box
// (Liang–Barsky per segment) and shoelaces the fill polygon, closed along the box
// border on the fill side (border-walk direction = the box tangent on the fill
// side of the exit segment). Exact for edges, stems, convex AND reflex corners,
// tips, and junctions — NO corner-type tag, NO proximity gate: span falls out of
// clipping segments to the box (probes/_polyClip.mjs, 0.5/255 vs 256× supersample).
// An interior triangle whose box the chain misses is fully inside ⇒ returns 1.
// forceInside=1 → a box the chain misses is INSIDE (kind-0 interior faces are
// inside the fill by construction). forceInside=0 → resolve by chainFillSide
// (strips, whose band straddles the edge into the exterior).
float chainBoxCov(vec2 p0, vec2 p1, vec2 p2, vec2 p3, vec2 p4, float forceInside) {
  vec2 poly[12];
  int n = 0;
  vec2 X = vec2(0.0);
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
    vec2 A2 = A + t0 * d, B2 = A + t1 * d;
    if (n == 0) { poly[0] = A2; n = 1; }
    else if (dot(poly[n - 1] - A2, poly[n - 1] - A2) > 1e-10 && n < 12) { poly[n] = A2; n++; }
    if (n < 12) { poly[n] = B2; n++; }
    X = B2;
  }
  // miss → three modes by caller role. forceInside=2: the face's OWN chain —
  // grazing misses get the nearest segment's LINE coverage (razor-edge clip
  // losses snapped to solid 1.0 otherwise: the crotch over-fill class); far
  // misses stay 1.0. forceInside=1: AUXILIARY chain (chain 2/3) — its role is
  // to CARVE what the own chain can't see, and a mis-oriented near-window line
  // carves real fill (measured 157–242 holes), so its only safe miss is 1.0.
  // forceInside=0: strip mode, nearest-segment side (kind-13, dormant).
  if (n < 2) {
    if (forceInside > 1.5) { float mc = chainMissCov(p0, p1, p2, p3, p4);
      return mc < 0.0 ? 1.0 : mc; }
    return (forceInside > 0.5 || chainFillSide(p0, p1, p2, p3, p4)) ? 1.0 : 0.0;
  }
  // ENDS-ON-BORDER INVARIANT, by construction: a chain END strictly inside the
  // box (a real outline end, a crotch corner, a window cut) breaks the border
  // walk — bparamOf(interior point) closes a garbage polygon that can read
  // solid 1.0 on a half-covered box (the residual junction over-fill route).
  // Extend the interior endpoint along its terminal segment's DIRECTION to the
  // border (tangent continuation — the same local model as the grazing-miss
  // fix; error = the outline's bend past the end, small at grazing range).
  {
    vec2 dEnd = poly[n - 1] - poly[n - 2];
    if (max(abs(poly[n - 1].x), abs(poly[n - 1].y)) < 0.5 - 1e-4 && dot(dEnd, dEnd) > 1e-12 && n < 12) {
      vec2 dn = normalize(dEnd);
      float tx = abs(dn.x) > 1e-6 ? ((dn.x > 0.0 ? 0.5 : -0.5) - poly[n - 1].x) / dn.x : 1e9;
      float ty = abs(dn.y) > 1e-6 ? ((dn.y > 0.0 ? 0.5 : -0.5) - poly[n - 1].y) / dn.y : 1e9;
      poly[n] = poly[n - 1] + dn * min(tx, ty); n++;
      X = poly[n - 1];
    }
    vec2 dBeg = poly[1] - poly[0];
    if (max(abs(poly[0].x), abs(poly[0].y)) < 0.5 - 1e-4 && dot(dBeg, dBeg) > 1e-12 && n < 12) {
      vec2 dn = normalize(-dBeg);                       // backward along the first segment
      float tx = abs(dn.x) > 1e-6 ? ((dn.x > 0.0 ? 0.5 : -0.5) - poly[0].x) / dn.x : 1e9;
      float ty = abs(dn.y) > 1e-6 ? ((dn.y > 0.0 ? 0.5 : -0.5) - poly[0].y) / dn.y : 1e9;
      vec2 E2 = poly[0] + dn * min(tx, ty);
      for (int i = 11; i >= 1; i--) if (i <= n) poly[i] = poly[i - 1];   // shift right
      poly[0] = E2; n++;
    }
  }
  vec2 E = poly[0];
  vec2 dX = poly[n - 1] - poly[n - 2];
  vec2 leftN = vec2(-dX.y, dX.x);                           // fill side of the exit segment
  vec2 tCCW;                                                // CCW border tangent at exit X
  if (abs(X.y + 0.5) < 1e-4 && X.x < 0.5 - 1e-4) tCCW = vec2(1.0, 0.0);
  else if (abs(X.x - 0.5) < 1e-4 && X.y < 0.5 - 1e-4) tCCW = vec2(0.0, 1.0);
  else if (abs(X.y - 0.5) < 1e-4 && X.x > -0.5 + 1e-4) tCCW = vec2(-1.0, 0.0);
  else tCCW = vec2(0.0, -1.0);
  bool ccw = dot(tCCW, leftN) >= 0.0;                       // walk the border toward the fill
  // Corner candidates span TWO laps (8, index j%4): a walk that crosses the
  // param-0 origin needs the wrapped corners too. With only one lap, a chain
  // exiting at param 3.4 and re-entering at 1.6 (e.g. a leftward horizontal
  // edge, fill above) walked 3.4→5.6 but could never insert corner 5 (=1+4),
  // so the closure lost a box corner and the fill rectangle shoelaced as a
  // triangle — EXACTLY HALF the true coverage (the H crossbar-band bug).
  float pa = bparamOf(X), pb = bparamOf(E);
  if (ccw) { float pbW = pb < pa ? pb + 4.0 : pb;
    for (int j = 0; j < 8; j++) { float cp = float(j + 1);
      if (cp > pa + 1e-5 && cp < pbW - 1e-5 && n < 12) { poly[n] = cornerOf(j - (j / 4) * 4); n++; } }
  } else { float pbW = pb > pa ? pb - 4.0 : pb;
    for (int j = 7; j >= 0; j--) { float cp = float(j + 1) - 4.0;
      if (cp < pa - 1e-5 && cp > pbW + 1e-5 && n < 12) { poly[n] = cornerOf(j - (j / 4) * 4); n++; } }
  }
  float area = 0.0;
  for (int i = 0; i < 12; i++) {
    if (i >= n) break;
    vec2 a = poly[i], b = poly[(i + 1 == n) ? 0 : i + 1];
    area += a.x * b.y - a.y * b.x;
  }
  return clamp(abs(area) * 0.5, 0.0, 1.0);
}
