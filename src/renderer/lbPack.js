// lbPack.js — the mesh's exit door: GPU vertex packing plus the
// similarity-invariant reuse machinery. packLoopBlinnMesh flattens an
// assembled raw mesh into the interleaved LB_VERT_FLOATS vertex stream the
// draw path uploads; lbCanonicalFrame/lbCanonicalHash key a contour set by
// its similarity orbit (centroid/RMS-scale/farthest-axis canonical form) and
// transformLoopBlinnRaw clones a cached raw mesh through a similarity so one
// build serves every translated/rotated/uniformly-scaled instance.
import { fatArc } from './lbContour.js';

export const LB_VERT_FLOATS = 24;


// Generous crescent dilation (× about the centroid). Big enough that the covered region
// reaches past the arc AA band at BOTH endpoints (so no pinch/notch); the per-fragment
// chord-span clip trims the excess so neighbours tile. Affine → texcoords follow exactly,
// so the implicit (hence the arc + its coverage) is unchanged.
const CRESCENT_DILATE = 1.3;
// Dilate a control triangle (tri = 6 floats) and its per-vertex texcoords (tc = 9 floats)
// about the shared centroid by S; returns {T (6), C (9)}.
function dilateCrescent(tri, tc, S) {
  const cx = (tri[0] + tri[2] + tri[4]) / 3, cy = (tri[1] + tri[3] + tri[5]) / 3;
  const m0 = (tc[0] + tc[3] + tc[6]) / 3, m1 = (tc[1] + tc[4] + tc[7]) / 3, m2 = (tc[2] + tc[5] + tc[8]) / 3;
  const T = new Float32Array(6), C = new Float32Array(9);
  for (let k = 0; k < 3; k++) {
    T[2 * k] = cx + S * (tri[2 * k] - cx); T[2 * k + 1] = cy + S * (tri[2 * k + 1] - cy);
    C[3 * k] = m0 + S * (tc[3 * k] - m0); C[3 * k + 1] = m1 + S * (tc[3 * k + 1] - m1); C[3 * k + 2] = m2 + S * (tc[3 * k + 2] - m2);
  }
  return { T, C };
}

// ---- SIMILARITY-INVARIANT mesh reuse --------------------------------------
// Loop-Blinn's per-vertex quantities (klmn, homogeneous texcoords, signs,
// barycentric values) are affine-invariant: a mesh built for shape S serves
// T(S) for any orientation-preserving similarity T (translate+rotate+uniform
// scale) by transforming only coordinates, line equations, direction vectors,
// and 1/length curvatures. Games bake motion into the curve floats, so a
// content-keyed cache misses on every moved sprite/flipbook pose; hashing the
// CANONICAL form (centroid origin, RMS-radius scale, farthest-point axis)
// hits across the whole similarity orbit, and the hit path clones + transforms
// the FULL assembly output — CDT, crescents, strips, caps, healing all come
// along; nothing is replayed. Reflections (det<0) are excluded: turn signs and
// fill orientation would flip.

// Canonical frame of a contour set: centroid, RMS radius, axis to the farthest
// control point (deterministic; ties resolve by first-in-order).
export function lbCanonicalFrame(contours) {
  let sx = 0, sy = 0, n = 0;
  for (const c of contours) for (const sg of c) for (const P of [sg.p1, sg.p2, sg.p3, sg.p4]) {
    if (P) { sx += P[0]; sy += P[1]; n++; }
  }
  if (!n) return null;
  const cx = sx / n, cy = sy / n;
  let rms = 0, far2 = -1, fx = 1, fy = 0;
  for (const c of contours) for (const sg of c) for (const P of [sg.p1, sg.p2, sg.p3, sg.p4]) {
    if (!P) continue;
    const dx = P[0] - cx, dy = P[1] - cy, d2 = dx * dx + dy * dy;
    rms += d2;
    if (d2 > far2 + 1e-18) { far2 = d2; fx = dx; fy = dy; }
  }
  const sc = Math.sqrt(rms / n);
  if (!(sc > 1e-12)) return null;
  const fl = Math.hypot(fx, fy);
  if (!(fl > 1e-9 * sc)) return null;   // axis ill-conditioned (all points ~centroid)
  // Near-symmetric shapes (train cars ≈ rectangles) have several control points
  // within fp noise of the farthest distance; tiny rotations flip which one wins
  // and the canonical frame jumps — every lookup misses. Collect ALL candidates
  // within a relative band of the max; callers try each (store under the first).
  const cands = [];
  const band = far2 * (1 - 1e-3);
  for (const c of contours) for (const sg of c) for (const P of [sg.p1, sg.p2, sg.p3, sg.p4]) {
    if (!P) continue;
    const dx = P[0] - cx, dy = P[1] - cy, d2 = dx * dx + dy * dy;
    if (d2 >= band) {
      const L = Math.hypot(dx, dy);
      if (L > 1e-9 * sc) cands.push({ cx, cy, scale: sc, cos: dx / L, sin: dy / L });
      if (cands.length >= 8) break;
    }
  }
  const fr = { cx, cy, scale: sc, cos: fx / fl, sin: fy / fl };
  fr.cands = cands.length > 1 ? cands : null;
  return fr;
}

// FNV pair over the canonical-space quantized outline (plus seg types and
// rational weights). Quantum = scale/4096: sub-visible differences may alias
// (fine); fp jitter at bucket boundaries costs only a miss.
export function lbCanonicalHash(contours, fr) {
  let h1 = 0x811c9dc5, h2 = 0x01000193, cnt = 0;
  const q = 4096 / fr.scale;
  const co = fr.cos, si = fr.sin;
  const mix = (bits) => {
    h1 = ((h1 ^ bits) * 0x01000193) >>> 0;
    h2 = ((h2 + bits) * 0x85ebca6b + 0xc2b2ae35) >>> 0;
  };
  for (const c of contours) {
    mix(0x7fff);   // contour boundary
    for (const sg of c) {
      mix(sg.type + 16);
      if (sg.w && sg.w !== 1) mix((sg.w * 4096) | 0);
      for (const P of [sg.p1, sg.p2, sg.p3, sg.p4]) {
        if (!P) continue;
        const dx = P[0] - fr.cx, dy = P[1] - fr.cy;
        mix(Math.round((co * dx + si * dy) * q));
        mix(Math.round((-si * dx + co * dy) * q));
        cnt++;
      }
    }
  }
  return h1 + 'S' + h2 + '_' + cnt;
}

// Apply similarity M { s, cos, sin, dx, dy } (p' = s*R*p + d) to a raw mesh,
// producing an independent clone. VALUES (klmn, tc, signs, w, types, _topo)
// are similarity-invariant and shared or copied verbatim; COORDS map by M;
// unit normals/direction vectors rotate; line constants c' = s*c + n'.d;
// lengths/radii scale by s; curvatures scale by 1/s.
export function transformLoopBlinnRaw(mesh, M) {
  const { s, cos: co, sin: si, dx, dy } = M;
  const TP = (x, y) => [s * (co * x - si * y) + dx, s * (si * x + co * y) + dy];
  const flatP = (src) => {
    if (!src || !src.length) return src ? new Float32Array(0) : src;
    const out = new Float32Array(src.length);
    for (let i = 0; i < src.length; i += 2) {
      const x = src[i], y = src[i + 1];
      out[i] = s * (co * x - si * y) + dx;
      out[i + 1] = s * (si * x + co * y) + dy;
    }
    return out;
  };
  const rotV = (v) => v ? [co * v[0] - si * v[1], si * v[0] + co * v[1]] : v;
  // line rows: n' = R*n (unit stays unit), c' = s*c + n'.d
  const lineRows = (src, stride) => {
    if (!src || !src.length) return src;
    const out = (src instanceof Float32Array) ? new Float32Array(src.length) : src.slice();
    for (let i = 0; i + stride <= src.length; i += stride) {
      const nx = src[i], ny = src[i + 1], c = src[i + 2];
      const nX = co * nx - si * ny, nY = si * nx + co * ny;
      out[i] = nX; out[i + 1] = nY; out[i + 2] = s * c + nX * dx + nY * dy;
      for (let k = 3; k < stride; k++) out[i + k] = src[i + k];
    }
    return out;
  };
  const _qPair = new Map();
  const out = {
    interior: flatP(mesh.interior),
    interiorEdges: lineRows(mesh.interiorEdges, 3),
    interiorEdges2: lineRows(mesh.interiorEdges2, 4),
    interiorEdges3: lineRows(mesh.interiorEdges3, 4),
    hasConcave: mesh.hasConcave,
    fallback: [],
    curveStrips: mesh.curveStrips,
    quads: (mesh.quads || []).map((q) => {
      // identity-mapped below for stripArcs (a SEMANTIC subset of quads — the
      // pack-time filter fallback is NOT equivalent; dropping it changed strip
      // planning and diverged from a fresh build in validation)
      const o = { tri: flatP(q.tri), sign: q.sign, w: q.w };
      _qPair.set(q, o);
      if (q.tc) o.tc = q.tc;
      if (q._fat !== undefined) o._fat = q._fat;
      if (q.na) o.na = rotV(q.na);
      if (q.nb) o.nb = rotV(q.nb);
      if (q.circle) o.circle = { cx: s * (co * q.circle.cx - si * q.circle.cy) + dx, cy: s * (si * q.circle.cx + co * q.circle.cy) + dy, r: s * q.circle.r };
      return o;
    }),
    cubics: (mesh.cubics || []).map((c) => {
      const o = { hull: flatP(c.hull), sign: c.sign };
      if (c.klmn) o.klmn = c.klmn;
      if (c.F) {
        const F = c.F, rm = (m) => ({ a: m.a, b: co * m.b - si * m.c, c: si * m.b + co * m.c });
        o.F = Object.assign({}, F, {
          m00: rm(F.m00), m01: rm(F.m01), m02: rm(F.m02),
          cx: s * (co * F.cx - si * F.cy) + dx, cy: s * (si * F.cx + co * F.cy) + dy, s: s * F.s,
        });
      }
      return o;
    }),
    edges: (mesh.edges || []).map((e) => {
      const o = Object.assign({}, e);
      o.p1 = TP(e.p1[0], e.p1[1]); o.p2 = TP(e.p2[0], e.p2[1]);
      const nX = co * e.nx - si * e.ny, nY = si * e.nx + co * e.ny;
      o.nx = nX; o.ny = nY;
      for (const key of ['e1', 'e2']) {
        const m = e[key];
        if (m) o[key] = Object.assign({}, m, { nN: rotV(m.nN), k: m.k / s });
      }
      return o;
    }),
    caps: (mesh.caps || []).map((cp) => {
      const o = Object.assign({}, cp);
      if (cp.p) o.p = TP(cp.p[0], cp.p[1]);
      if (cp.nA) { o.nA = rotV(cp.nA); o.cA = s * cp.cA + o.nA[0] * dx + o.nA[1] * dy; }
      if (cp.nB) { o.nB = rotV(cp.nB); o.cB = s * cp.cB + o.nB[0] * dx + o.nB[1] * dy; }
      if (cp.nx !== undefined) { const v = rotV([cp.nx, cp.ny]); o.nx = v[0]; o.ny = v[1]; }
      if (cp.k !== undefined) o.k = cp.k / s;
      if (cp.kA !== undefined) o.kA = cp.kA / s;
      if (cp.kB !== undefined) o.kB = cp.kB / s;
      return o;
    }),
    circles: (mesh.circles || []).map((ci) => Object.assign({}, ci, { cx: s * (co * ci.cx - si * ci.cy) + dx, cy: s * (si * ci.cx + co * ci.cy) + dy, r: s * ci.r })),
    annuli: (mesh.annuli || []).map((an) => Object.assign({}, an, { cx: s * (co * an.cx - si * an.cy) + dx, cy: s * (si * an.cx + co * an.cy) + dy, rMid: s * an.rMid, halfW: s * an.halfW })),
    _topo: mesh._topo || null,   // index/sign topology is similarity-invariant
  };
  // stripArcs entries are INDEPENDENT quad-like records ({tri, sign, w}), not
  // references into quads (verified) — transform them directly.
  if (mesh.stripArcs) out.stripArcs = mesh.stripArcs.map((q) => (_qPair.get(q) || { tri: flatP(q.tri), sign: q.sign, w: q.w }));
  if (!mesh.circles) delete out.circles;
  if (!mesh.annuli) delete out.annuli;
  if (!mesh.caps) delete out.caps;
  return out;
}

// ---- pack the mesh into one interleaved VBO (the renderer's draw format) ---
// 24 floats / vertex, matching loopBlinn.vert.glsl's unified layout:
//   [0,1]   aPos.xy
//   [2,3,4] aTC.xyz  (INTERP): quad (u,v,_) · cubic-klmn (k,l,m) · strip (dilate,_,_)
//   [5,6]   aFlags (kind, sign)  [flat]
//   [7..10]  aC0 = M00.xyz, M01.x        [11..14] aC1 = M01.yz, M02.xy   [flat, kind 4]
//   [15..18] aC2 = M02.z, M11a, M12, M22 [19..22] aC3 = cen.xy, scale, _ [flat]
//   [23] pad.  kind: 0 interior · 1 quad · 2 cubic-klmn · 3 edge-strip · 4 cubic-bezout.
// aC3 doubles as the strip's (normal.xy, line-const) at [19,20,21].
export function packLoopBlinnMesh(mesh, reuse) {
  const { interior, quads, cubics } = mesh;
  const interiorEdges = mesh.interiorEdges || null;
  const edges = mesh.edges || [];
  const circles = mesh.circles || [];                    // exact circular-SDF discs (kind 6)
  const annuli = mesh.annuli || [];                      // exact concentric-ring SDF (kind 7)
  const caps = mesh.caps || [];                          // convex-corner caps (kind 8)
  const nInterior = interior.length / 2;                 // xy pairs → verts
  let nQuad = 0; for (const q of quads) nQuad += 3;
  let nCubic = 0; for (const c of cubics) nCubic += c.hull.length / 2;
  // plan cubic exterior rings (static only, 3-vert klmn hulls): one quad per hull edge,
  // outward = away from the opposite vertex; klm gradient from the affine frame.
  if (mesh.curveStrips) for (const c of cubics) {
    const nH9 = c.hull.length / 2;
    if (!c.klmn || (nH9 !== 3 && nH9 !== 4)) continue;
    // perimeter edges with their owning fan triangle (klm is affine PER TRI on a fan)
    /** @type {Array<[number, number, [number, number, number]]>} */
    const edges9 = nH9 === 3
      ? [[0, 1, [0, 1, 2]], [1, 2, [0, 1, 2]], [2, 0, [0, 1, 2]]]
      : [[0, 1, [0, 1, 2]], [1, 2, [0, 1, 2]], [2, 3, [0, 2, 3]], [3, 0, [0, 2, 3]]];
    c._ring = [];
    for (const [i9, j9, tri9] of edges9) {
      const [A9, B9, C9] = tri9;
      const e1x = c.hull[2 * B9] - c.hull[2 * A9], e1y = c.hull[2 * B9 + 1] - c.hull[2 * A9 + 1];
      const e2x = c.hull[2 * C9] - c.hull[2 * A9], e2y = c.hull[2 * C9 + 1] - c.hull[2 * A9 + 1];
      const det9 = e1x * e2y - e1y * e2x;
      if (Math.abs(det9) < 1e-12) continue;
      const grad9 = (ci9) => {
        const d19 = c.klmn[3 * B9 + ci9] - c.klmn[3 * A9 + ci9], d29 = c.klmn[3 * C9 + ci9] - c.klmn[3 * A9 + ci9];
        return [(d19 * e2y - d29 * e1y) / det9, (d29 * e1x - d19 * e2x) / det9];
      };
      const gk9 = grad9(0), gl9 = grad9(1), gm9 = grad9(2);
      const t9 = tri9.find(v9 => v9 !== i9 && v9 !== j9);
      let nx9 = -(c.hull[2 * j9 + 1] - c.hull[2 * i9 + 1]), ny9 = c.hull[2 * j9] - c.hull[2 * i9];
      const nL9 = Math.hypot(nx9, ny9); if (nL9 < 1e-12) continue;
      nx9 /= nL9; ny9 /= nL9;
      if (nx9 * (c.hull[2 * t9] - c.hull[2 * i9]) + ny9 * (c.hull[2 * t9 + 1] - c.hull[2 * i9 + 1]) > 0) { nx9 = -nx9; ny9 = -ny9; }
      c._ring.push({ base: [i9, j9, j9, i9, j9, i9], ext: [0, 0, 1, 0, 1, 1], nx: nx9, ny: ny9,
        dk: gk9[0] * nx9 + gk9[1] * ny9, dl: gl9[0] * nx9 + gl9[1] * ny9, dm: gm9[0] * nx9 + gm9[1] * ny9 });
    }
    if (!c._ring.length) delete c._ring;
    else nCubic += c._ring.length * 6;
  }
  const nEdge = edges.length * 6;                        // 2 tris per AA strip
  const nCircle = circles.length * 6;                    // 2 tris per disc bbox quad
  const nAnnulus = annuli.length * 6;                    // 2 tris per ring bbox quad
  const nCap = caps.length * 6;                          // 2 tris per corner cap quad
  // Curve strips (kind 9, static only): the chord of each integral-quad crescent extruded
  // outward by ~1.25px in the VS. A THIN crescent (a near-straight font quad bulging a
  // fraction of a pixel) has geometry smaller than its own AA band — most band pixels get
  // no fragment and the boundary renders hard. The strip's fragments carry the SAME affine
  // frame (Δuv = J·n̂ per em), discard inside the hull (crescent's turf) and on the fill
  // side (interior's turf), so it paints exactly the exterior band the hull can't span.
  const curveStripQuads = mesh.curveStrips ? (mesh.stripArcs || quads.filter(q => !q.circle && !q.tc && (!q.w || q.w === 1))) : [];
  // RING strips (15 verts) for fat arcs on the CDT path; padded-bbox (6) otherwise.
  // Ring mode requires the source-seg strip list (stripArcs) so the strip and the
  // kind-11 mode derive from the SAME hull geometry — earcut-path meshes stay bbox.
  const ringMode = !!mesh.stripArcs;
  const stripFat = q => ringMode && fatArc(q.tri[0], q.tri[1], q.tri[2], q.tri[3], q.tri[4], q.tri[5]);
  // Per-arc strip plan: 6 verts (bbox: shallow arc), 15 (fat, exterior toward ctrl —
  // two ctrl-edge quads + wedge fan), or 6 (fat CONCAVE — exterior beyond the CHORD:
  // one chord-edge quad). The exterior side is where f increases (ov ∝ −sign·∇v).
  const stripPlanOf = q => {
    if (!stripFat(q)) return 6;
    const ax = q.tri[0], ay = q.tri[1], cx = q.tri[2], cy = q.tri[3], bx = q.tri[4], by = q.tri[5];
    const e1x = cx - ax, e1y = cy - ay, e2x = bx - ax, e2y = by - ay;
    const det = e1x * e2y - e1y * e2x;
    if (Math.abs(det) < 1e-12) return 6;
    const Jvx = -e1y / det, Jvy = e1x / det;
    const ovx = -q.sign * Jvx, ovy = -q.sign * Jvy;
    const ctrlSide = (cx - (ax + bx) / 2) * ovx + (cy - (ay + by) / 2) * ovy > 0;
    return ctrlSide ? 15 : 6;
  };
  let nCurveStrip = 0;
  for (const q of curveStripQuads) nCurveStrip += stripPlanOf(q);
  const total = nInterior + nQuad + nCubic + nEdge + nCircle + nAnnulus + nCap + nCurveStrip;
  // Fixed-topology streaming reuse: when a prior pack of the SAME vertex
  // count is handed in (updateBundleGeometryLB passes the previous frame's
  // packed result), refill that Float32Array in place instead of allocating
  // a fresh one. Every shader-READ slot ([0..6] for kinds 0/1/2/3, [7..21]
  // for kind-4/edges) is overwritten below, and the per-vertex KIND is
  // stable across frames for a fixed topology, so no stale slot is ever
  // read. Falls back to a fresh buffer on a vertex-count change.
  const v = (reuse && reuse.verts && reuse.verts.length === total * LB_VERT_FLOATS)
    ? reuse.verts : new Float32Array(total * LB_VERT_FLOATS);
  let o = 0;
  // audit-marginal shapes ride a BLEND flag in the kind fraction (bit 11 of
  // the 8192-grain: 2048/8192 = 0.25, so kind tests at .5 midpoints stay
  // exact and the combined route's painter ordinal (≤2047) still fits below).
  const blendBit = mesh._blendTier9 ? 2048 / 8192 : 0;
  const head = (x, y, t0, t1, t2, kind, sign) => {
    v[o] = x; v[o + 1] = y; v[o + 2] = t0; v[o + 3] = t1; v[o + 4] = t2; v[o + 5] = kind + blendBit; v[o + 6] = sign;
  };
  const bezout = (F) => {
    v[o + 7] = F.m00.a; v[o + 8] = F.m00.b; v[o + 9] = F.m00.c; v[o + 10] = F.m01.a;
    v[o + 11] = F.m01.b; v[o + 12] = F.m01.c; v[o + 13] = F.m02.a; v[o + 14] = F.m02.b;
    v[o + 15] = F.m02.c; v[o + 16] = F.m11a; v[o + 17] = F.m12; v[o + 18] = F.m22;
    v[o + 19] = F.cx; v[o + 20] = F.cy; v[o + 21] = F.s;
  };
  const interiorEdges2 = mesh.interiorEdges2 || null;
  const interiorEdges3 = mesh.interiorEdges3 || null;
  // DEPTH-CARVE ORDER: interiors are emitted LAST (emitInterior9 call at the
  // bottom). Within one draw, earlier primitives' depth rejects later ones
  // under LEQUAL — pieces at nearer z must rasterize BEFORE the z=0 solids so
  // a covered interior fragment is REJECTED instead of the piece blending
  // OVER an already-saturated pixel (partials read 1.00 without this).
  const emitInterior9 = () => {
  for (let i = 0, e = 0, e2 = 0; i < interior.length; i += 2, e += 3, e2 += 4) {
    // kind-0's aTC is otherwise unused: a THIRD boundary line (nx,ny,c) rides it, its
    // corner type rides aC3.w — no VS changes (vTC/cHalf already flow through).
    if (interiorEdges3) head(interior[i], interior[i + 1], interiorEdges3[e2], interiorEdges3[e2 + 1], interiorEdges3[e2 + 2], 0, 0);
    else head(interior[i], interior[i + 1], 0, 0, 0, 0, 0);
    // aC3 [19,20,21] = straight boundary-edge line (nx,ny,c) for the fragment's
    // kind-0 inner AA ramp; 0 → solid interior (no boundary edge).
    if (interiorEdges) { v[o + 19] = interiorEdges[e]; v[o + 20] = interiorEdges[e + 1]; v[o + 21] = interiorEdges[e + 2]; }
    else { v[o + 19] = 0; v[o + 20] = 0; v[o + 21] = 0; }
    v[o + 22] = interiorEdges3 ? interiorEdges3[e2 + 3] : 0;
    // aC0 [7..10] = optional SECOND boundary line + corner type (thin strokes / corners →
    // combined box coverage). Written unconditionally so the streaming in-place reuse
    // never reads a stale slot.
    if (interiorEdges2) { v[o + 7] = interiorEdges2[e2]; v[o + 8] = interiorEdges2[e2 + 1]; v[o + 9] = interiorEdges2[e2 + 2]; v[o + 10] = interiorEdges2[e2 + 3]; }
    else { v[o + 7] = 0; v[o + 8] = 0; v[o + 9] = 0; v[o + 10] = 0; }
    o += LB_VERT_FLOATS;
  }  };

  for (const q of quads) {
    if (q.circle) {
      // Circular arc crescent → kind 6 (exact circular SDF, seam-free across
      // co-circular pieces). Control-tri geometry; aC3 = (cx, cy, r).
      for (let k = 0; k < 3; k++) { head(q.tri[2 * k], q.tri[2 * k + 1], 0, 0, 0, 6, q.sign); v[o + 19] = q.circle.cx; v[o + 20] = q.circle.cy; v[o + 21] = q.circle.r; o += LB_VERT_FLOATS; }
    } else if (q.tc) {
      // ADOPTED sub-triangle of a subdivided quad/rquad hull — per-vertex
      // texcoords already interpolated. STATIC integral pieces are kind 11: kind 1
      // has no side discard (its clip block skips on zero aC3), so an adopted face
      // paints BOTH sides of its arc and DOUBLE-COMPOSITES with the kind-9 strip's
      // exterior coverage — 1−(1−c)² partials all along shallow curves (the 0.25-class
      // runs at large scales: a@5.3 271px, u 206px).
      const kind = (!q.w || q.w === 1) ? (mesh.curveStrips ? 11 : 1) : 5;
      // a FLIPPED piece must not pack fat: ±2 is sign-blind (curveCov is
      // homogeneous), so the audit's paint-side flip was a no-op on fat
      // crescents — the Museo-'0' 4px residue
      const fatTc = kind === 11 && q._fat === true && !q.flip;   // undefined (earcut-path/unknown) → shallow mode = status quo
      const pSign = (q.flip ? -1 : 1) * q.sign;   // truth-audit paint flip (fragment discard side only)
      for (let k = 0; k < 3; k++) { head(q.tri[2 * k], q.tri[2 * k + 1], q.tc[3 * k], q.tc[3 * k + 1], q.tc[3 * k + 2], kind, fatTc ? pSign * 2 : pSign); v[o + 19] = 0; v[o + 20] = 0; v[o + 21] = 0; o += LB_VERT_FLOATS; }
    } else if (!q.w || q.w === 1) {
      // integral quadratic: kind 1, f = u²−v. GENEROUSLY DILATED about the centroid so the
      // crescent covers its whole arc AA band incl. the endpoints (no pinch → no seam
      // notch); the affine dilation carries the texcoords, so the implicit/arc is UNCHANGED.
      // Clip payload for the fragment's EXACT tangent partition: aC3 = on-curve endpoints
      // (a.xy, b.xy); the control point rides aSeamM (ctrl.x) + aTC.z (ctrl.y, constant over
      // the tri). The fragment clips each crescent to the wedge between the endpoint tangents
      // (tangent at a = ctrl−a, at b = b−ctrl) — tangent-continuous, so neighbours' clip lines
      // COINCIDE → exact partition, no seam overlap (over) or gap (notch).
      const cxo = q.tri[2], cyo = q.tri[3];   // original off-curve control point
      // Static meshes (curveStrips) get NO dilation: the kind-9 strips + kind-8 caps own the
      // whole exterior band, so hull-only crescents give an exact pixel partition (a dilated
      // crescent would double-paint the strip's zone under the direct-OVER route). Streaming/
      // morph meshes have no strips and keep the dilation for the seam pinch coverage.
      const d = dilateCrescent(q.tri, [0, 0, cyo, 0.5, 0, cyo, 1, 1, cyo], mesh.curveStrips ? 1.0 : CRESCENT_DILATE);
      // Clip-plane normals at endpoints a=(tri0,tri1), b=(tri4,tri5). DEFAULT = the arc's own
      // tangent (ctrl−a, ctrl−b) → the exact plane the old ctrl-based clip used (byte-identical
      // where no neighbour data is supplied). buildLoopBlinnCDT overrides with the CORNER
      // BISECTOR (q.na/q.nb) so a curve meeting a straight edge / another curve at an angle is
      // clipped at the corner instead of the dilated crescent spilling past it.
      const naX = q.na ? q.na[0] : cxo - q.tri[0], naY = q.na ? q.na[1] : cyo - q.tri[1];
      const nbX = q.nb ? q.nb[0] : cxo - q.tri[4], nbY = q.nb ? q.nb[1] : cyo - q.tri[5];
      // STATIC (curveStrips) crescents are UNDILATED — their geometry is the exact CDT hull
      // face, already a partition — so the span clip (a relic of the dilated design) must be
      // OFF: with it, the hull sliver beyond an endpoint's tangent plane (obtuse hull corner
      // at a shallow joint) was discarded by the crescent while kind-9/10 both defer to the
      // hull → a dead zone. Zeroed aC3 span data skips the whole clip block.
      // STATIC (curveStrips) crescents are UNDILATED exact CDT hull faces → kind 11: no
      // span/emission clips (relics of the dilated design that punched dead slivers at
      // obtuse hull corners); instead the crescent owns exactly the FILL side of its own
      // implicit and the kind-9 strip owns the exterior side — a consistent f-sign
      // partition. Streaming/morph keep the dilated kind-1 with its clips.
      const st = !!mesh.curveStrips;
      // both-sides mode ONLY where a ring strip exists (CDT path): the earcut path keeps
      // bbox strips, whose exterior coverage would DOUBLE with a both-sides hull.
      const fat11 = st && !!mesh.stripArcs && (q._fat !== undefined ? q._fat : fatArc(q.tri[0], q.tri[1], q.tri[2], q.tri[3], q.tri[4], q.tri[5]));
      for (let k = 0; k < 3; k++) { head(d.T[2 * k], d.T[2 * k + 1], d.C[3 * k], d.C[3 * k + 1], d.C[3 * k + 2], st ? 11 : 1, fat11 ? q.sign * 2 : q.sign); v[o + 7] = naX; v[o + 8] = naY; v[o + 9] = nbX; v[o + 10] = nbY;
        if (st) { v[o + 19] = 0; v[o + 20] = 0; v[o + 21] = 0; v[o + 22] = 0; } else { v[o + 19] = q.tri[0]; v[o + 20] = q.tri[1]; v[o + 21] = q.tri[4]; v[o + 22] = q.tri[5]; }
        v[o + 23] = cxo; o += LB_VERT_FLOATS; }
    } else {
      // rational quadratic (arc, weight w): kind 5, f = Ũ²−Ṽ·R with homogeneous texcoords
      // P0=(0,0,1), ctrl=(1/2w,0,1/w), P2=(1,1,1). Same dilate + chord-span clip.
      const iw = 1 / q.w;
      const d = dilateCrescent(q.tri, [0, 0, 1, 0.5 * iw, 0, iw, 1, 1, 1], CRESCENT_DILATE);
      for (let k = 0; k < 3; k++) { head(d.T[2 * k], d.T[2 * k + 1], d.C[3 * k], d.C[3 * k + 1], d.C[3 * k + 2], 5, q.sign); v[o + 19] = q.tri[0]; v[o + 20] = q.tri[1]; v[o + 21] = q.tri[4]; v[o + 22] = q.tri[5]; o += LB_VERT_FLOATS; }
    }
  }
  let hasBezout = false;   // any kind-4 (cusp/d1≈0) cubic → needs the full program
  for (const c of cubics) {
    const n = c.hull.length / 2;
    for (let k = 0; k < n; k++) {
      if (c.klmn) { head(c.hull[2 * k], c.hull[2 * k + 1], c.klmn[3 * k], c.klmn[3 * k + 1], c.klmn[3 * k + 2], 2, c.sign);
        v[o + 7] = 0; v[o + 8] = 0; v[o + 9] = 0; v[o + 10] = 0; v[o + 23] = 0; }
      else { head(c.hull[2 * k], c.hull[2 * k + 1], 0, 0, 0, 4, c.sign); bezout(c.F); hasBezout = true; }
      o += LB_VERT_FLOATS;
    }
    if (!c._ring) continue;
    // CUBIC EXTERIOR RINGS: cubic crescents had NO strip machinery (kind-9 is
    // integral-quad-only), so a thin cubic hull cannot span its own AA band — SVG
    // icon arcs rendered with a HARD outer edge (the restart icon: zero intermediate
    // pixels on outer arcs while Slug shows a full ramp). k,l,m are affine over the
    // hull, so ring quads extruded from the hull edges carry the EXACT implicit:
    // inner verts share the hull's coordinates AND klm (watertight and value-
    // consistent — the watertight-partition principle), outer verts extend klm by the directional
    // gradient — plain kind-2 fragments, no shader coverage changes.
    for (const R9 of c._ring) {
      for (let k = 0; k < 6; k++) {
        const b9 = R9.base[k], ext9 = R9.ext[k];
        head(c.hull[2 * b9], c.hull[2 * b9 + 1], c.klmn[3 * b9], c.klmn[3 * b9 + 1], c.klmn[3 * b9 + 2], 2, c.sign);
        if (ext9) { v[o + 7] = R9.nx; v[o + 8] = R9.ny; v[o + 9] = R9.dk; v[o + 10] = R9.dl; v[o + 19] = R9.dm; v[o + 23] = 9; }
        else { v[o + 7] = 0; v[o + 8] = 0; v[o + 9] = 0; v[o + 10] = 0; v[o + 23] = 0; }
        o += LB_VERT_FLOATS;
      }
    }
  }
  // Straight-edge AA strip: kind 3. aC3.xy=outward normal N, aC3.z=line const
  // c=N·p1; aTC.x=dilate flag (1 → shader pushes the vert outward ½px+).
  const strip = (px, py, dilate, e) => {
    head(px, py, dilate, 0, 0, 3, 0);
    v[o + 19] = e.nx; v[o + 20] = e.ny; v[o + 21] = e.nx * e.p1[0] + e.ny * e.p1[1];
    o += LB_VERT_FLOATS;
  };
  // Kind-10 unified edge cap-strip (static only): one primitive per straight edge owning
  // the WHOLE exterior band plus both end wedges, partitioned watertight against the
  // neighbouring cap-strips (shared bisector plane) or curve strips (the arc's tangent
  // plane). It carries THREE features — prev tangent+κ, own line, next tangent+κ — so
  // pixels whose box is cut by several features (short edges, acute tips, shallow joints)
  // get the exact chained box coverage. Replaces kind-3 strips AND per-corner caps for
  // line-involved corners; streaming/morph meshes keep the plain kind-3.
  const strip10 = (e) => {
    const tdx0 = e.p2[0] - e.p1[0], tdy0 = e.p2[1] - e.p1[1], tL = Math.hypot(tdx0, tdy0) || 1;
    const sig = (-tdy0 / tL) * e.nx + (tdx0 / tL) * e.ny > 0 ? 1 : -1;   // outward = left-perp·σ
    const codeA = (e.e1.type + 1) * 4 + (e.e1.curve ? 2 : 0) + e.e1.tsign;
    const codeB = (e.e2.type + 1) * 4 + (e.e2.curve ? 2 : 0) + e.e2.tsign;
    const packed = codeA * 16 + codeB;
    const sv10 = (role) => {
      const tR = role % 2, base = tR === 0 ? e.p1 : e.p2;
      head(base[0], base[1], role, e.e1.k, e.e2.k, 10, sig);
      v[o + 7] = e.e1.nN[0]; v[o + 8] = e.e1.nN[1]; v[o + 9] = e.e2.nN[0]; v[o + 10] = e.e2.nN[1];
      v[o + 19] = e.p1[0]; v[o + 20] = e.p1[1]; v[o + 21] = e.p2[0]; v[o + 22] = e.p2[1];
      v[o + 23] = packed;
      o += LB_VERT_FLOATS;
    };
    sv10(0); sv10(1); sv10(3);
    sv10(0); sv10(3); sv10(2);
  };
  for (const e of edges) {
    if (mesh.curveStrips && e.e1) { strip10(e); continue; }
    strip(e.p1[0], e.p1[1], 0, e); strip(e.p2[0], e.p2[1], 0, e); strip(e.p2[0], e.p2[1], 1, e);
    strip(e.p1[0], e.p1[1], 0, e); strip(e.p2[0], e.p2[1], 1, e); strip(e.p1[0], e.p1[1], 1, e);
  }
  // Circular-SDF disc: kind 6. One bbox quad; the fragment computes
  // f = sign·(length(em−centre)−r) and slugCov AA's it — exact, seam-free.
  // aC3 [19,20,21] = (cx, cy, r). Quad dilated past r to hold the outer AA band.
  const disc = (px, py, c) => { head(px, py, 0, 0, 0, 6, 1); v[o + 19] = c.cx; v[o + 20] = c.cy; v[o + 21] = c.r; o += LB_VERT_FLOATS; };
  for (const c of circles) {
    const H = 1.2 * c.r + 2, x0 = c.cx - H, x1 = c.cx + H, y0 = c.cy - H, y1 = c.cy + H;
    disc(x0, y0, c); disc(x1, y0, c); disc(x1, y1, c);
    disc(x0, y0, c); disc(x1, y1, c); disc(x0, y1, c);
  }
  // Concentric-ring disc: kind 7. aC3 = (cx, cy, rMid, halfW); f = |‖em−C‖−rMid|−halfW.
  const ring = (px, py, a) => { head(px, py, 0, 0, 0, 7, 1); v[o + 19] = a.cx; v[o + 20] = a.cy; v[o + 21] = a.rMid; v[o + 22] = a.halfW; o += LB_VERT_FLOATS; };
  for (const a of annuli) {
    const H = 1.2 * (a.rMid + a.halfW) + 2, x0 = a.cx - H, x1 = a.cx + H, y0 = a.cy - H, y1 = a.cy + H;
    ring(x0, y0, a); ring(x1, y0, a); ring(x1, y1, a);
    ring(x0, y0, a); ring(x1, y1, a); ring(x0, y1, a);
  }
  // CONVEX-corner cap: kind 8. A small scale-blind quad at a junction whose tangents turn
  // convexly; it owns the exterior wedge beyond BOTH tangent spans (crescents/strips are
  // span-clipped, interior is inside — nobody else paints there, which rendered those
  // boundary pixels hard). aPos = the junction; aTC.xy = (±1,±1) offsets in the (bisector,
  // perp) frame the VS builds; aC3 = tangent line A (nx,ny,c), aC0 = tangent line B. The
  // fragment discards centres inside either half-plane (others' turf) and paints the exact
  // two-line box coverage.
  const cap = (cornerX, cornerY, c) => { head(c.p[0], c.p[1], cornerX, cornerY, c.p[1], 8, 1);
    v[o + 7] = c.nB[0]; v[o + 8] = c.nB[1]; v[o + 9] = c.cB; v[o + 10] = c.kA;
    v[o + 19] = c.nA[0]; v[o + 20] = c.nA[1]; v[o + 21] = c.cA; v[o + 22] = c.kB; v[o + 23] = c.p[0]; o += LB_VERT_FLOATS; };
  for (const c of caps) {
    cap(-1, -1, c); cap(1, -1, c); cap(1, 1, c);
    cap(-1, -1, c); cap(1, 1, c); cap(-1, 1, c);
  }
  // Curve strip (kind 9): 4 verts (a, b on the boundary + their outward-pushed twins) as
  // 2 tris. aC3 = (a.xy, b.xy) span; aTC = (u,v, ctrl.y), aSeamM = ctrl.x — same payload a
  // crescent carries, so the fragment reuses the kind-1 coverage. Push verts carry
  // aC0 = (n̂.xy, Δuv.xy); base verts aC0 = 0. The VS adds n̂·1.25px to the position and
  // Δuv·1.25px to the texcoords — Δuv = J·n̂ keeps the interpolated UV on the SAME global
  // affine map at any scale, so curveCov's derivatives stay exact.
  for (const q of curveStripQuads) {
    const ax = q.tri[0], ay = q.tri[1], cx = q.tri[2], cy = q.tri[3], bx = q.tri[4], by = q.tri[5];
    // Affine map (em → uv) from the control triangle: uv(a)=(0,0), uv(ctrl)=(½,0), uv(b)=(1,1).
    const e1x = cx - ax, e1y = cy - ay, e2x = bx - ax, e2y = by - ay;
    const det = e1x * e2y - e1y * e2x;
    if (Math.abs(det) < 1e-12) { for (let k = 0; k < 6; k++) { head(ax, ay, 0, 0, 0, 9, q.sign); v[o + 7] = 0; v[o + 8] = 0; v[o + 9] = 0; v[o + 10] = 0; v[o + 19] = ax; v[o + 20] = ay; v[o + 21] = ax; v[o + 22] = ay; v[o + 23] = cx; o += LB_VERT_FLOATS; } continue; }
    const i11 = e2y / det, i12 = -e2x / det, i21 = -e1y / det, i22 = e1x / det;   // inverse em basis
    const Jux = 0.5 * i11 + 1 * i21, Juy = 0.5 * i12 + 1 * i22;                    // ∇u (em)
    const Jvx = 0 * i11 + 1 * i21, Jvy = 0 * i12 + 1 * i22;                        // ∇v (em)
    // Outward = the direction f increases at the boundary: ∇f|arc ∝ −sign·∇v.
    const ovx0 = -q.sign * Jvx, ovy0 = -q.sign * Jvy;
    const ovL = Math.hypot(ovx0, ovy0) || 1, ovx = ovx0 / ovL, ovy = ovy0 / ovL;
    const ctrlSide9 = (cx - (ax + bx) / 2) * ovx + (cy - (ay + by) / 2) * ovy > 0;
    if (stripFat(q)) {
      // RING footprint (fat arcs): one quad per ctrl-side hull edge + a ctrl-wedge fan.
      // Inner verts are the hull's EXACT vertices with the hull's exact uv — bit-identical
      // edge equations and attribute planes, so rasterization partitions ring↔hull
      // watertight and value-consistent (the strip rides the same global affine uv map).
      // The paired kind-11 paints BOTH sides (|sign|=2) — no f-sign tie anywhere.
      const UV = { a: [0, 0], c: [0.5, 0], b: [1, 1] };
      const ring = (P0, uv0, P1, uv1, T3) => {
        // outward = away from the hull's third vertex (∇f at the midpoint misorients
        // strongly-curved arcs' edge normals)
        let nx = -(P1[1] - P0[1]), ny = P1[0] - P0[0];
        const nL = Math.hypot(nx, ny) || 1; nx /= nL; ny /= nL;
        if (nx * (T3[0] - P0[0]) + ny * (T3[1] - P0[1]) > 0) { nx = -nx; ny = -ny; }
        const tx9 = (P1[0] - P0[0]) / (nL * 0 + Math.hypot(P1[0] - P0[0], P1[1] - P0[1]) || 1), ty9 = (P1[1] - P0[1]) / (Math.hypot(P1[0] - P0[0], P1[1] - P0[1]) || 1);
        const rv = (px, py, u, vv, dx9, dy9) => {
          head(px, py, u, vv, cy, 9, q.sign);
          v[o + 7] = dx9; v[o + 8] = dy9; v[o + 9] = Jux * dx9 + Juy * dy9; v[o + 10] = Jvx * dx9 + Jvy * dy9;
          v[o + 19] = ax; v[o + 20] = ay; v[o + 21] = bx; v[o + 22] = by; v[o + 23] = cx;
          o += LB_VERT_FLOATS;
        };
        // outer corners extend DIAGONALLY (n̂ ± t̂, the bbox's own √2 precedent): pixels
        // just past the endpoints inside the span-acceptance wedge were bbox-covered but
        // ring-missed (the d@0.6 dead-pixel row). The span clips trim the excess exactly.
        rv(P0[0], P0[1], uv0[0], uv0[1], 0, 0); rv(P1[0], P1[1], uv1[0], uv1[1], 0, 0); rv(P1[0], P1[1], uv1[0], uv1[1], nx + tx9, ny + ty9);
        rv(P0[0], P0[1], uv0[0], uv0[1], 0, 0); rv(P1[0], P1[1], uv1[0], uv1[1], nx + tx9, ny + ty9); rv(P0[0], P0[1], uv0[0], uv0[1], nx - tx9, ny - ty9);
        return [nx, ny];
      };
      if (!ctrlSide9) {
        // CONCAVE arc: the exterior band lies beyond the CHORD — one quad on a→b,
        // extruded away from ctrl. (The ctrl-edge rings cover only the convex case;
        // the bbox used to cover this side by area — the d@0.6 dead-pixel class.)
        ring([ax, ay], UV.a, [bx, by], UV.b, [cx, cy]);
        continue;
      }
      const n1 = ring([ax, ay], UV.a, [cx, cy], UV.c, [bx, by]);
      const n2 = ring([cx, cy], UV.c, [bx, by], UV.b, [ax, ay]);
      // ctrl-wedge fan: the two quads extrude along different normals, leaving a pie gap
      // beyond ctrl whose pixels sit inside the arc's AA band.
      const wv = (extN) => {
        head(cx, cy, UV.c[0], UV.c[1], cy, 9, q.sign);
        if (extN) { v[o + 7] = extN[0]; v[o + 8] = extN[1]; v[o + 9] = Jux * extN[0] + Juy * extN[1]; v[o + 10] = Jvx * extN[0] + Jvy * extN[1]; }
        else { v[o + 7] = 0; v[o + 8] = 0; v[o + 9] = 0; v[o + 10] = 0; }
        v[o + 19] = ax; v[o + 20] = ay; v[o + 21] = bx; v[o + 22] = by; v[o + 23] = cx;
        o += LB_VERT_FLOATS;
      };
      wv(null); wv(n1); wv(n2);
      continue;
    }
    // BULLETPROOF footprint: the padded bbox of the control hull. Hand-fitted trapezoids
    // around fat/tiny/seamed arcs kept leaving geometric slivers (the o's apex-seam dead
    // pixels); the bbox + 1.5px pad covers every pixel the arc can influence at ANY scale,
    // and the fragment's span / f-sign / coverage tests trim it exactly. Fill-side and far
    // fragments discard or emit ~0, so the overdraw is cheap for static text.
    const bx0 = Math.min(ax, cx, bx), by0 = Math.min(ay, cy, by);
    const bx1 = Math.max(ax, cx, bx), by1 = Math.max(ay, cy, by);
    const sv = (px, py, dxs, dys) => {
      // uv of the UNPADDED corner via the affine frame; the pad rides aC0 (dir + Δuv/em)
      const relx = px - ax, rely = py - ay;
      const u = Jux * relx + Juy * rely, vv = Jvx * relx + Jvy * rely;
      head(px, py, u, vv, cy, 9, q.sign);
      v[o + 7] = dxs; v[o + 8] = dys; v[o + 9] = Jux * dxs + Juy * dys; v[o + 10] = Jvx * dxs + Jvy * dys;
      v[o + 19] = ax; v[o + 20] = ay; v[o + 21] = bx; v[o + 22] = by; v[o + 23] = cx;
      o += LB_VERT_FLOATS;
    };
    sv(bx0, by0, -1, -1); sv(bx1, by0, 1, -1); sv(bx1, by1, 1, 1);
    sv(bx0, by0, -1, -1); sv(bx1, by1, 1, 1); sv(bx0, by1, -1, 1);
  }
  emitInterior9();
  // hasBezout lets the renderer pick the lean program (no Bezout attributes /
  // varyings / kind-4 branch) for the common cusp-free case.
  return { verts: v, vertexCount: total, fallback: mesh.fallback, hasBezout };
}
