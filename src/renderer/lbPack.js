// lbPack.js — the mesh's exit door: GPU vertex packing plus the
// similarity-invariant reuse machinery. packLoopBlinnMesh flattens an
// assembled raw mesh into the interleaved LB_VERT_FLOATS vertex stream the
// draw path uploads; lbCanonicalFrame/lbCanonicalHash key a contour set by
// its similarity orbit (centroid/RMS-scale/farthest-axis canonical form) and
// transformLoopBlinnRaw clones a cached raw mesh through a similarity so one
// build serves every translated/rotated/uniformly-scaled instance.
import { fatArc, LB_BAND_SHARP_TURN } from './lbContour.js';
import { mantleDebugFlag } from '../core/diagnostics.js';

export const LB_VERT_FLOATS = 24;

/** Hard per-shape vertex cap. Past this the packer flags `overBudget` and callers
 *  must Slug the shape — drawing a truncated buffer is what produces
 *  `GL_INVALID_OPERATION: Vertex buffer is not big enough for the draw call`. */
export const LB_MAX_VERTS_PER_MESH = 200000;

/** Soft whole-bundle vertex cap (sum of shape packs). Exceeded → whole-bundle Slug. */
export const LB_MAX_VERTS_PER_BUNDLE = 1000000;

// Pack two f32 into one f32 via IEEE half (matches GLSL packHalf2x16). Used so
// kind-12 can keep aTC=(Ũ,Ṽ,R) while both end curvatures still ride mixed aC2.
const _hBuf = new ArrayBuffer(4);
const _hF = new Float32Array(_hBuf);
const _hU = new Uint32Array(_hBuf);
function toHalfBits(val) {
  _hF[0] = val;
  const x = _hU[0];
  const s = (x >>> 16) & 0x8000;
  const e = ((x >>> 23) & 0xff) - 127;
  const m = x & 0x7fffff;
  if (e > 15) return s | 0x7c00;
  if (e > -15) return s | ((e + 15) << 10) | (m >>> 13);
  return s;
}
function packHalf2x16(a, b) {
  _hU[0] = (toHalfBits(b) << 16) | toHalfBits(a);
  return _hF[0];
}

/** Kind-12 end chainability — any non-straight bandable neighbour.
 *  Shallow joints (|turn| < LB_BAND_SHARP_TURN) still chain, but pack κ=0
 *  (pure tangent combine) so under-sampled osculating curvature can't claim
 *  glyph-waist interior the way full-κ chaining used to. */
function band12Chainable(e) {
  return !mantleDebugFlag('lbBand2NoChain')
    && e.curve && e.qn && Math.abs(e.turn !== undefined ? e.turn : 1) > 0.02;
}

/** κ for a chained end: full sample at sharp turns, 0 at shallow. */
function band12EndKappa(e) {
  if (!e || !band12Chainable(e)) return 0;
  return Math.abs(e.turn) >= LB_BAND_SHARP_TURN ? e.k : 0;
}

/** Pack kind-12 end slots (aC1/aC2/aC3) shared by quad bands and cubic rings. */
function writeBand12Ends(v, o, e1, e2, nOwnPackA, nOwnPackB, kA, kB, ax, ay, bx, by) {
  v[o + 11] = e1.nN[0]; v[o + 12] = e1.nN[1]; v[o + 13] = e2.nN[0]; v[o + 14] = e2.nN[1];
  v[o + 15] = nOwnPackA; v[o + 16] = nOwnPackB; v[o + 17] = kA; v[o + 18] = kB;
  v[o + 19] = ax; v[o + 20] = ay; v[o + 21] = bx; v[o + 22] = by;
}

function clearBand12Ends(v, o) {
  for (let i = 11; i <= 22; i++) v[o + i] = 0;
}

function band12EndCodes(e1, e2) {
  const tyA = band12Chainable(e1) ? e1.type : 0;
  const tyB = band12Chainable(e2) ? e2.type : 0;
  return {
    codeA: (tyA + 1) * 4 + (e1.curve ? 2 : 0) + e1.tsign,
    codeB: (tyB + 1) * 4 + (e2.curve ? 2 : 0) + e2.tsign,
  };
}


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
// the FULL assembly output — CDT, crescents, bands, healing all come
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
  return lbCanonicalHashes(contours, [fr])[0];
}

/**
 * Hash several canonical frames in one contour walk (primary + near-tie
 * candidate axes). Avoids re-walking control points per candidate on the
 * sim-cache near-symmetric path.
 * @param {any[][]} contours
 * @param {object[]} frames
 * @returns {string[]}
 */
export function lbCanonicalHashes(contours, frames) {
  const n = frames.length;
  const h1 = new Array(n), h2 = new Array(n), cnt = new Array(n);
  const q = new Array(n), co = new Array(n), si = new Array(n);
  for (let f = 0; f < n; f++) {
    h1[f] = 0x811c9dc5; h2[f] = 0x01000193; cnt[f] = 0;
    q[f] = 4096 / frames[f].scale;
    co[f] = frames[f].cos; si[f] = frames[f].sin;
  }
  for (const c of contours) {
    for (let f = 0; f < n; f++) {
      h1[f] = ((h1[f] ^ 0x7fff) * 0x01000193) >>> 0;
      h2[f] = ((h2[f] + 0x7fff) * 0x85ebca6b + 0xc2b2ae35) >>> 0;
    }
    for (const sg of c) {
      const ty = sg.type + 16;
      const wBits = (sg.w && sg.w !== 1) ? ((sg.w * 4096) | 0) : 0;
      for (let f = 0; f < n; f++) {
        h1[f] = ((h1[f] ^ ty) * 0x01000193) >>> 0;
        h2[f] = ((h2[f] + ty) * 0x85ebca6b + 0xc2b2ae35) >>> 0;
        if (wBits) {
          h1[f] = ((h1[f] ^ wBits) * 0x01000193) >>> 0;
          h2[f] = ((h2[f] + wBits) * 0x85ebca6b + 0xc2b2ae35) >>> 0;
        }
      }
      for (const P of [sg.p1, sg.p2, sg.p3, sg.p4]) {
        if (!P) continue;
        const px = P[0], py = P[1];
        for (let f = 0; f < n; f++) {
          const dx = px - frames[f].cx, dy = py - frames[f].cy;
          const bx = Math.round((co[f] * dx + si[f] * dy) * q[f]) | 0;
          const by = Math.round((-si[f] * dx + co[f] * dy) * q[f]) | 0;
          h1[f] = ((h1[f] ^ bx) * 0x01000193) >>> 0;
          h2[f] = ((h2[f] + bx) * 0x85ebca6b + 0xc2b2ae35) >>> 0;
          h1[f] = ((h1[f] ^ by) * 0x01000193) >>> 0;
          h2[f] = ((h2[f] + by) * 0x85ebca6b + 0xc2b2ae35) >>> 0;
          cnt[f]++;
        }
      }
    }
  }
  const out = new Array(n);
  for (let f = 0; f < n; f++) out[f] = h1[f] + 'S' + h2[f] + '_' + cnt[f];
  return out;
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
  // Rows of (x, y, value, value): map the leading point, copy the tail verbatim.
  const flatPKeepTail = (src) => {
    if (!src || !src.length) return src ? new Float32Array(0) : src;
    const out = new Float32Array(src.length);
    for (let i = 0; i + 3 < src.length; i += 4) {
      const x = src[i], y = src[i + 1];
      out[i] = s * (co * x - si * y) + dx;
      out[i + 1] = s * (si * x + co * y) + dy;
      out[i + 2] = src[i + 2]; out[i + 3] = src[i + 3];
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
    // Analytic poly-clip chains: POSITIONS (P0,P1 / P2,P3 per vert), not lines —
    // map by flatP (rotate+scale+translate), not lineRows.
    interiorChainA: flatP(mesh.interiorChainA),
    interiorChainB: flatP(mesh.interiorChainB),
    // chainC is NOT four coordinates: its per-vertex row is (P4.x, P4.y, MODE, 0),
    // where MODE is the chain-kind sentinel (3 = conic, 2 = straight) parked in
    // the never-read P5 slot. flatP would map that pair as a POINT and add the
    // translation to it — 2.0 becomes 2·s·cos + dx — so any shape not at the
    // origin crossed the shader's `vTC.x > 2.5` conic test with a straight chain
    // and read its slots as Bezier control points. Identity-placed shapes
    // (dx = 0, s = 1) were unaffected, which is why this hid until a sheet of
    // translated tiles: whole tiles carved by garbage coverage, and ONLY the
    // x = 0 column correct (probes: lbImageBatchSmoke x16).
    interiorChainC: flatPKeepTail(mesh.interiorChainC),
    interiorChainD: flatP(mesh.interiorChainD),
    interiorChainE: flatP(mesh.interiorChainE),
    interiorHasChain2: mesh.interiorHasChain2,
    chainStripVerts: flatP(mesh.chainStripVerts),
    chainStripA: flatP(mesh.chainStripA),
    chainStripB: flatP(mesh.chainStripB),
    hasConcave: mesh.hasConcave,
    fallback: [],
    quads: (mesh.quads || []).map((q) => {
      // identity-mapped below for stripArcs (a SEMANTIC subset of quads — the
      // pack-time filter fallback is NOT equivalent; dropping it changed strip
      // planning and diverged from a fresh build in validation)
      const o = { tri: flatP(q.tri), sign: q.sign, w: q.w };
      _qPair.set(q, o);
      if (q.tc) o.tc = q.tc;
      if (q.na) o.na = rotV(q.na);
      if (q.nb) o.nb = rotV(q.nb);
      // Kind-12 band end metadata rides the similarity like the edges' (the dropped-
      // clip-planes cache-clone class): normals rotate, curvatures scale by 1/s.
      for (const key of ['e1', 'e2']) {
        const m = q[key];
        if (m) o[key] = Object.assign({}, m, { nN: rotV(m.nN), k: m.k / s });
      }
      if (q.circle) o.circle = { cx: s * (co * q.circle.cx - si * q.circle.cy) + dx, cy: s * (si * q.circle.cx + co * q.circle.cy) + dy, r: s * q.circle.r };
      return o;
    }),
    cubics: (mesh.cubics || []).map((c) => {
      const o = { hull: flatP(c.hull), sign: c.sign };
      if (c.klmn) o.klmn = c.klmn;
      // The end-tangent clip planes must ride the similarity too. Dropping them leaves the
      // DILATED hull with nothing to trim it, so a cubic mesh reached through the canonical
      // cache would render differently on a cache HIT vs a cache MISS. na/nb are directions
      // (rotate only); a/b are points on the curve (full similarity).
      if (c.na) o.na = rotV(c.na);
      if (c.nb) o.nb = rotV(c.nb);
      if (c.a) o.a = TP(c.a[0], c.a[1]);
      if (c.b) o.b = TP(c.b[0], c.b[1]);
      if (c.cp) o.cp = c.cp.map((p) => TP(p[0], p[1]));
      for (const key of ['e1', 'e2']) {
        const m = c[key];
        if (m) o[key] = Object.assign({}, m, { nN: rotV(m.nN), k: m.k / s });
      }
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
    circles: (mesh.circles || []).map((ci) => {
      if (ci.rx != null) {
        // Elliptical disc under similarity: scale radii, add rotation to φ.
        const cx = s * (co * ci.cx - si * ci.cy) + dx;
        const cy = s * (si * ci.cx + co * ci.cy) + dy;
        return { cx, cy, rx: s * ci.rx, ry: s * ci.ry, phi: (ci.phi || 0) + Math.atan2(si, co) };
      }
      return Object.assign({}, ci, { cx: s * (co * ci.cx - si * ci.cy) + dx, cy: s * (si * ci.cx + co * ci.cy) + dy, r: s * ci.r });
    }),
    annuli: (mesh.annuli || []).map((an) => Object.assign({}, an, { cx: s * (co * an.cx - si * an.cy) + dx, cy: s * (si * an.cx + co * an.cy) + dy, rMid: s * an.rMid, halfW: s * an.halfW })),
    _topo: mesh._topo || null,   // index/sign topology is similarity-invariant
    // Similarity-invariant pack flags must ride the clone: packLoopBlinnMesh
    // reads _blendTier9 to set the BLEND bit, so dropping it makes a cache
    // HIT composite differently from a MISS (the clip-planes/stripArcs class).
    _blendTier9: mesh._blendTier9 || false,
  };
  // stripArcs entries are INDEPENDENT quad-like records ({tri, sign, w, e1?, e2?}), not
  // references into quads (verified) — transform them directly, INCLUDING the kind-12
  // band end metadata (the dropped-clip-planes cache-clone class).
  if (mesh.stripArcs) out.stripArcs = mesh.stripArcs.map((q) => {
    const hit = _qPair.get(q);
    if (hit) return hit;
    const o = { tri: flatP(q.tri), sign: q.sign, w: q.w };
    for (const key of ['e1', 'e2']) {
      const m = q[key];
      if (m) o[key] = Object.assign({}, m, { nN: rotV(m.nN), k: m.k / s });
    }
    return o;
  });
  // bandArcs holds its own tri copies (earcut pre-heal snapshot, not shared with
  // mesh.quads) — transform directly or the clone silently loses exterior bands.
  if (mesh.bandArcs) out.bandArcs = mesh.bandArcs.map((q) => {
    const o = { tri: flatP(q.tri), sign: q.sign, w: q.w };
    for (const key of ['e1', 'e2']) {
      const m = q[key];
      if (m) o[key] = Object.assign({}, m, { nN: rotV(m.nN), k: m.k / s });
    }
    return o;
  });
  if (!mesh.circles) delete out.circles;
  if (!mesh.annuli) delete out.annuli;
  return out;
}

// ---- pack the mesh into one interleaved VBO (the renderer's draw format) ---
// 24 floats / vertex, matching loopBlinn.vert.glsl's unified layout:
//   [0,1]   aPos.xy
//   [2,3,4] aTC.xyz  (INTERP): quad (u,v,_) · cubic-klmn (k,l,m) · strip (dilate,_,_)
//   [5,6]   aFlags (kind, sign)  [flat]
//   [7..10]  aC0 = M00.xyz, M01.x        [11..14] aC1 = M01.yz, M02.xy   [flat, kind 4]
//   [15..18] aC2 = M02.z, M11a, M12, M22 [19..22] aC3 = cen.xy, scale, _ [flat]
//   [23] pad.  Live kinds: 0 interior · 2 cubic-klmn · 4 cubic-bezout ·
//   5 quad/rquad crescent · 7 circle/annulus SDF · 10 edge strip ·
//   12 unified curve band.
// aC3 doubles as the strip's (normal.xy, line-const) at [19,20,21].
export function packLoopBlinnMesh(mesh, reuse) {
  const { interior, quads, cubics } = mesh;
  // Quantised endpoint keys for the shape's straight edges, so a crescent can ask
  // "is my chord one of these?" in O(1). Both orientations are inserted.
  const ekey5 = (x, y) => (Math.round(x * 65536) / 65536) + ',' + (Math.round(y * 65536) / 65536);
  let edgeKeySet = null;
  if (mesh.edges && mesh.edges.length) {
    edgeKeySet = new Set();
    for (const e of mesh.edges) {
      const a = ekey5(e.p1[0], e.p1[1]), b = ekey5(e.p2[0], e.p2[1]);
      edgeKeySet.add(a + '|' + b); edgeKeySet.add(b + '|' + a);
    }
  }
  const interiorEdges = mesh.interiorEdges || null;
  const interiorChainA = mesh.interiorChainA || null;    // analytic poly-clip: P0,P1 per vert → aC3
  const interiorChainB = mesh.interiorChainB || null;    // P2,P3 per vert → aC0
  const interiorChainC = mesh.interiorChainC || null;    // P4,P5 per vert → aTC.yz
  const interiorChainD = mesh.interiorChainD || null;    // chain 2: Q0,Q1 → aC1
  const interiorChainE = mesh.interiorChainE || null;    // chain 2: Q2,Q3 → aC2
  const chainStripVerts = mesh.chainStripVerts || null;  // kind-13 thin chain strips: flat tri points
  const chainStripA = mesh.chainStripA || null;          // P0,P1 per strip vert → aC3
  const chainStripB = mesh.chainStripB || null;          // P2,P3 per strip vert → aC0
  const edges = mesh.edges || [];
  const circles = mesh.circles || [];                    // exact circular-SDF discs (kind 7 disc mode)
  const annuli = mesh.annuli || [];                      // exact concentric-ring SDF (kind 7 ring mode)
  const nInterior = interior.length / 2;                 // xy pairs → verts
  let nQuad = 0; for (const q of quads) nQuad += 3;
  let nCubic = 0; for (const c of cubics) nCubic += c.hull.length / 2;
  // A ring may only be extruded from a hull edge that BOUNDS the mesh. An edge shared with a
  // neighbouring face (a crescent's chord is shared with the interior triangle the CDT put
  // against it) extrudes into a region the partition already fills, and the ring's klm — the
  // curve's own implicit — reads "inside" there, so it paints coverage 1 a SECOND time.
  //
  // Under an opaque fill that is invisible: the same colour at coverage 1, twice. Under a
  // translucent one it is a solid double-composited line along every curve (a 0.5 fill
  // compositing to 0.75), which is what this was for years. Ring the boundary only.
  const faceEdges = new Map();
  // Integer-quantized undirected edge key (equivalent to toFixed(5), including
  // negative half-way values). Faster and allocation-free until the final key.
  const q5 = (v) => v < 0 ? -Math.round(-v * 1e5) : Math.round(v * 1e5);
  const ekey = (x0, y0, x1, y1) => {
    let ax = q5(x0), ay = q5(y0);
    let bx = q5(x1), by = q5(y1);
    if (ax > bx || (ax === bx && ay > by)) { const tx = ax, ty = ay; ax = bx; ay = by; bx = tx; by = ty; }
    return ax + ',' + ay + '|' + bx + ',' + by;
  };
  const bumpEdge = (x0, y0, x1, y1) => {
    const k = ekey(x0, y0, x1, y1);
    faceEdges.set(k, (faceEdges.get(k) || 0) + 1);
  };
  const addFace3 = (x0, y0, x1, y1, x2, y2) => {
    bumpEdge(x0, y0, x1, y1); bumpEdge(x1, y1, x2, y2); bumpEdge(x2, y2, x0, y0);
  };
  // Face-edge census for cubic exterior-ring boundary detection (shared edges
  // must not extrude into already-filled region).
  {
    for (let i = 0; i + 6 <= interior.length; i += 6)
      addFace3(interior[i], interior[i + 1], interior[i + 2], interior[i + 3], interior[i + 4], interior[i + 5]);
    for (const q of quads) {
      const t = q.tri;
      addFace3(t[0], t[1], t[2], t[3], t[4], t[5]);
    }
    for (const c of cubics) {
      const nH = c.hull.length / 2;
      const per = nH === 3 ? [[0, 1], [1, 2], [2, 0]]
        : nH === 6 ? [[0, 1], [1, 2], [4, 5], [5, 3]]
          : nH === 4 ? [[0, 1], [1, 2], [2, 3], [3, 0]] : [];
      for (const [i9, j9] of per)
        bumpEdge(c.hull[2 * i9], c.hull[2 * i9 + 1], c.hull[2 * j9], c.hull[2 * j9 + 1]);
    }
  }

  // Plan cubic exterior rings: one quad per BOUNDARY hull edge.
  for (const c of cubics) {
    const nH9 = c.hull.length / 2;
    if (!c.klmn || (nH9 !== 3 && nH9 !== 4 && nH9 !== 6)) continue;
    // perimeter edges with their owning fan triangle (klm is affine PER TRI on a fan)
    /** @type {Array<[number, number, [number, number, number]]>} */
    // nH9 === 6 is a two-triangle SOUP of a 4-gon hull ([h0,h1,h2, h0,h2,h3]), which is what
    // lbFastMesh emits — its perimeter edges live at soup slots, and each carries its OWN tri
    // (klm is affine per triangle, not across the fan).
    const edges9 = nH9 === 3
      ? [[0, 1, [0, 1, 2]], [1, 2, [0, 1, 2]], [2, 0, [0, 1, 2]]]
      : nH9 === 6
        ? [[0, 1, [0, 1, 2]], [1, 2, [0, 1, 2]], [4, 5, [3, 4, 5]], [5, 3, [3, 4, 5]]]
        : [[0, 1, [0, 1, 2]], [1, 2, [0, 1, 2]], [2, 3, [0, 2, 3]], [3, 0, [0, 2, 3]]];
    c._ring = [];
    for (const [i9, j9, tri9] of edges9) {
      // interior edge (shared with the face on the other side) → no ring, it would double-composite
      if ((faceEdges.get(ekey(c.hull[2 * i9], c.hull[2 * i9 + 1], c.hull[2 * j9], c.hull[2 * j9 + 1])) || 0) > 1) continue;
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
  // Curve bands (kind 12): prefer CDT stripArcs (fat ring mode), else earcut
  // pre-heal bandArcs (bbox mode), else any quad that already carries end meta.
  const curveStripQuads = mesh.stripArcs || mesh.bandArcs
    || quads.filter(q => !q.circle && !q.tc && q.e1 && q.e2);
  // RING strips (15 verts) for fat arcs on the CDT path; padded-bbox (6) otherwise.
  const ringMode = !!mesh.stripArcs;
  const stripFat = q => ringMode && fatArc(q.tri[0], q.tri[1], q.tri[2], q.tri[3], q.tri[4], q.tri[5]);
  // Unified curve band (kind 12): integral + rational quads with end meta.
  // aTC=(Ũ,Ṽ,R) with R≡1 for integral; κA/κB in mixed aC2.zw.
  const isBand12 = q => q.e1 && q.e2 && !q.tc && !q.circle;
  const hasBands = !!(mesh.stripArcs || mesh.bandArcs);
  // Per-arc strip plan: 6 verts (bbox: shallow), 15 (fat convex toward ctrl),
  // or 6 (fat concave beyond chord).
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
  const nChainStrip = chainStripVerts ? chainStripVerts.length / 2 : 0;   // kind-13 thin chain strips
  const total = nInterior + nQuad + nCubic + nEdge + nCircle + nAnnulus + nCurveStrip + nChainStrip;
  // Fixed-topology streaming reuse: when a prior pack of the SAME vertex
  // count is handed in (updateBundleGeometryLB passes the previous frame's
  // packed result), refill that Float32Array in place instead of allocating
  // a fresh one. Every shader-READ slot is overwritten below. Falls back to a
  // fresh buffer on a vertex-count change. The buffer GROWS if emission ever
  // exceeds the plan (TypedArray writes past length are silently ignored —
  // that used to ship a vertexCount > buffer size and trip GL_INVALID_OPERATION).
  let v = (reuse && reuse.verts && reuse.verts.length === total * LB_VERT_FLOATS)
    ? reuse.verts : new Float32Array(Math.max(total, 1) * LB_VERT_FLOATS);
  let o = 0;
  // audit-marginal shapes ride a BLEND flag in the kind fraction (bit 11 of
  // the 8192-grain: 2048/8192 = 0.25, so kind tests at .5 midpoints stay
  // exact and the combined route's painter ordinal (≤2047) still fits below).
  const blendBit = mesh._blendTier9 ? 2048 / 8192 : 0;
  const grow = () => {
    if (o + LB_VERT_FLOATS <= v.length) return;
    const nv = new Float32Array(Math.max(v.length * 2, o + LB_VERT_FLOATS * 64));
    nv.set(v.subarray(0, o));
    v = nv;
  };
  const head = (x, y, t0, t1, t2, kind, sign) => {
    grow();
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
  // ANALYTIC POLY-CLIP (chain mode): each vertex carries its triangle's local
  // outline chain as 4 POINTS — P0,P1 → aC3.xy/zw, P2,P3 → aC0.xy/zw — with a
  // aTC.z = 2.0 sentinel so the kind-0 fragment clips instead of the line combo.
  if (interiorChainA) {
    // HYBRID meshes carry BOTH row families: chain rows for analytic faces and
    // line/edge rows for the shattered junction-core shards. A face is LINE
    // mode iff its edge rows are non-zero (a face with all-zero rows of both
    // kinds is solid interior under either mode, so the inference is exact).
    let lineMask = null;
    if (interiorEdges) {
      const nF = (interior.length / 6) | 0;
      lineMask = new Uint8Array(nF);
      for (let f = 0; f < nF; f++) {
        for (let k = 0; k < 9; k++) if (interiorEdges[f * 9 + k] !== 0) { lineMask[f] = 1; break; }
        if (!lineMask[f] && interiorEdges2) for (let k = 0; k < 12; k++) if (interiorEdges2[f * 12 + k] !== 0) { lineMask[f] = 1; break; }
        if (!lineMask[f] && interiorEdges3) for (let k = 0; k < 12; k++) if (interiorEdges3[f * 12 + k] !== 0) { lineMask[f] = 1; break; }
      }
    }
    for (let i = 0, c = 0; i < interior.length; i += 2, c += 4) {
      const vi = (i / 2) | 0;
      if (lineMask && lineMask[(vi / 3) | 0]) {
        // shard vertex — identical emission to the plain line-mode loop below
        if (interiorEdges3) head(interior[i], interior[i + 1], interiorEdges3[c], interiorEdges3[c + 1], interiorEdges3[c + 2], 0, 0);
        else head(interior[i], interior[i + 1], 0, 0, 0, 0, 0);
        if (interiorEdges) { v[o + 19] = interiorEdges[vi * 3]; v[o + 20] = interiorEdges[vi * 3 + 1]; v[o + 21] = interiorEdges[vi * 3 + 2]; }
        else { v[o + 19] = 0; v[o + 20] = 0; v[o + 21] = 0; }
        v[o + 22] = interiorEdges3 ? interiorEdges3[c + 3] : 0;
        if (interiorEdges2) { v[o + 7] = interiorEdges2[c]; v[o + 8] = interiorEdges2[c + 1]; v[o + 9] = interiorEdges2[c + 2]; v[o + 10] = interiorEdges2[c + 3]; }
        else { v[o + 7] = 0; v[o + 8] = 0; v[o + 9] = 0; v[o + 10] = 0; }
        v[o + 11] = 0; v[o + 12] = 0; v[o + 13] = 0; v[o + 14] = 0;   // clear the chain-2 slots —
        v[o + 15] = 0; v[o + 16] = 0; v[o + 17] = 0; v[o + 18] = 0;   // reuse buffers are dirty
        o += LB_VERT_FLOATS;
        continue;
      }
      // aTC.x = 2 chain sentinel; aTC.yz = P4 (per-face constant, so interpolation
      // is exact). Lean-safe 5-point chain: aC3=P0,P1 · aC0=P2,P3 · aTC.yz=P4.
      // 5 points cover a 2-side corner face (pre,V1,V2,V3,post) — proven ≤3 segs/box.
      // Mode rides chainC's unused P5.x slot: 3 = CONIC chain (the five points
      // are two quadratic Béziers P0,C0,P1,C1,P2), otherwise the straight
      // 4-segment chain. Older builders leave it 0 → straight.
      const chainMode = interiorChainC && interiorChainC[c + 2] > 2.5 ? 3.0 : 2.0;
      head(interior[i], interior[i + 1], chainMode, interiorChainC ? interiorChainC[c] : 0, interiorChainC ? interiorChainC[c + 1] : 0, 0, 0);
      v[o + 19] = interiorChainA[c]; v[o + 20] = interiorChainA[c + 1];      // aC3.xy = P0
      v[o + 21] = interiorChainA[c + 2]; v[o + 22] = interiorChainA[c + 3];  // aC3.zw = P1
      v[o + 7] = interiorChainB[c]; v[o + 8] = interiorChainB[c + 1];        // aC0.xy = P2
      v[o + 9] = interiorChainB[c + 2]; v[o + 10] = interiorChainB[c + 3];   // aC0.zw = P3
      // CHAIN 2 (the face's SECOND outline arc, 4 pts) → aC1/aC2, the slots the
      // lean variant drops — so a mesh that has one forces the full program.
      // Absent → all zeros → every segment degenerate → cov 1 → min() no-op.
      if (interiorChainD && globalThis.__LB_CHAIN2 !== false) {   // __LB_CHAIN2=false → zeros → min() no-op (A/B, same program)
        v[o + 11] = interiorChainD[c]; v[o + 12] = interiorChainD[c + 1];     // aC1.xy = Q0
        v[o + 13] = interiorChainD[c + 2]; v[o + 14] = interiorChainD[c + 3]; // aC1.zw = Q1
        v[o + 15] = interiorChainE[c]; v[o + 16] = interiorChainE[c + 1];     // aC2.xy = Q2
        v[o + 17] = interiorChainE[c + 2]; v[o + 18] = interiorChainE[c + 3]; // aC2.zw = Q3
      }
      o += LB_VERT_FLOATS;
    }
    return;
  }
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
  }
  };

  for (const q of quads) {
    if (q.circle) {
      // Circular arc crescent → kind 7 disc mode (cHalf < 0): exact circular SDF,
      // seam-free across co-circular pieces. Control-tri geometry; aC3 = (cx, cy, r, −1).
      for (let k = 0; k < 3; k++) {
        head(q.tri[2 * k], q.tri[2 * k + 1], 0, 0, 0, 7, q.sign);
        v[o + 19] = q.circle.cx; v[o + 20] = q.circle.cy; v[o + 21] = q.circle.r; v[o + 22] = -1;
        o += LB_VERT_FLOATS;
      }
      continue;
    }
    // Kind-5 fill crescent. When kind-12 owns the exterior (e1/e2 on the piece,
    // or any band list on the mesh), pack undilated fill-side only (aC3=0).
    // Dilate+chord remains only for unbanded rational (no exterior band at all).
    // CHORD-IS-A-BOUNDARY: this crescent's chord coincides with a real straight
    // EDGE of the shape, so it is a shape boundary and the fragment must ramp
    // across it (see the chord clip in loopBlinn.frag.glsl). Signalled by
    // |sign| = 3 rather than 1 — the sign-magnitude idiom kind 12 uses for its
    // flags; no vertex slot is free (aC3 feeds the rquad chord-span clip, slot 23
    // carries cxo / mean(R)).
    //
    // The weaker test "this mesh has no kind-0 interior" is NOT equivalent and
    // fails: a multi-arc ellipse or squircle has no interior triangles either,
    // but its chords form the INSCRIBED polygon and are interior, not boundary.
    // Clipping there pinches every crescent (quad-seam max under-coverage 0.976,
    // ellipse off by 5790px, squircle ink ratio 0.409).
    const lone5 = edgeKeySet !== null
      && edgeKeySet.has(ekey5(q.tri[0], q.tri[1]) + '|' + ekey5(q.tri[4], q.tri[5]));
    const banded = !!(q.e1 && q.e2);
    const integral = !q.w || q.w === 1;
    const fillSide = banded || integral || hasBands;
    const pSign = (q.flip ? -1 : 1) * q.sign * (lone5 ? 3 : 1);
    if (q.tc) {
      for (let k = 0; k < 3; k++) {
        const r = integral ? 1 : q.tc[3 * k + 2];
        head(q.tri[2 * k], q.tri[2 * k + 1], q.tc[3 * k], q.tc[3 * k + 1], r, 5, pSign);
        if (fillSide) { v[o + 19] = 0; v[o + 20] = 0; v[o + 21] = 0; v[o + 22] = 0; }
        else { v[o + 19] = q.tri[0]; v[o + 20] = q.tri[1]; v[o + 21] = q.tri[4]; v[o + 22] = q.tri[5]; }
        o += LB_VERT_FLOATS;
      }
    } else if (fillSide) {
      const iw = integral ? 1 : (1 / q.w);
      const d = dilateCrescent(q.tri, [0, 0, 1, 0.5 * iw, 0, iw, 1, 1, 1], 1.0);
      const cxo = q.tri[2], cyo = q.tri[3];
      const naX = q.na ? q.na[0] : cxo - q.tri[0], naY = q.na ? q.na[1] : cyo - q.tri[1];
      const nbX = q.nb ? q.nb[0] : cxo - q.tri[4], nbY = q.nb ? q.nb[1] : cyo - q.tri[5];
      for (let k = 0; k < 3; k++) {
        head(d.T[2 * k], d.T[2 * k + 1], d.C[3 * k], d.C[3 * k + 1], d.C[3 * k + 2], 5, pSign);
        v[o + 7] = naX; v[o + 8] = naY; v[o + 9] = nbX; v[o + 10] = nbY;
        v[o + 19] = 0; v[o + 20] = 0; v[o + 21] = 0; v[o + 22] = 0;
        v[o + 23] = cxo; o += LB_VERT_FLOATS;
      }
    } else {
      // Unbanded rational: dilated + chord-span clip (kind-12 not available).
      const iw = 1 / q.w;
      const d = dilateCrescent(q.tri, [0, 0, 1, 0.5 * iw, 0, iw, 1, 1, 1], CRESCENT_DILATE);
      for (let k = 0; k < 3; k++) {
        head(d.T[2 * k], d.T[2 * k + 1], d.C[3 * k], d.C[3 * k + 1], d.C[3 * k + 2], 5, pSign);
        v[o + 19] = q.tri[0]; v[o + 20] = q.tri[1]; v[o + 21] = q.tri[4]; v[o + 22] = q.tri[5];
        o += LB_VERT_FLOATS;
      }
    }
  }
  let hasBezout = false;   // any kind-4 (cusp/d1≈0) cubic → needs the full program
  for (const c of cubics) {
    const n = c.hull.length / 2;
    for (let k = 0; k < n; k++) {
      if (c.klmn) { head(c.hull[2 * k], c.hull[2 * k + 1], c.klmn[3 * k], c.klmn[3 * k + 1], c.klmn[3 * k + 2], 2, c.sign);
        // Dilated cubic crescent: clip back to the piece's own end tangents so neighbours tile.
        // aSeamM = 1 marks a clipped hull triangle; ring verts carry 9 (outer) / 0 (inner), and
        // hull and ring triangles are separate, so the flat provoking vertex never mixes them.
        // A cubic that carries an exterior ring stays undilated and unclipped: the ring
        // reuses aC0/aC3 for its extrusion data.
        if (!c._ring && c.na && c.nb) {
          v[o + 7] = c.na[0]; v[o + 8] = c.na[1]; v[o + 9] = c.nb[0]; v[o + 10] = c.nb[1];
          v[o + 19] = c.a[0]; v[o + 20] = c.a[1]; v[o + 21] = c.b[0]; v[o + 22] = c.b[1];
          v[o + 23] = 1;
        } else { v[o + 7] = 0; v[o + 8] = 0; v[o + 9] = 0; v[o + 10] = 0; v[o + 23] = 0; } }
      else { head(c.hull[2 * k], c.hull[2 * k + 1], 0, 0, 0, 4, c.sign); bezout(c.F); hasBezout = true; }
      o += LB_VERT_FLOATS;
    }
    if (!c._ring) continue;
    // CUBIC EXTERIOR BANDS → kind-12 (cubic mode, |sign|≥8192). Bezout cubics
    // (no klmn) skip the ring — hull-only is enough for the rare cusp path.
    if (!c.klmn) continue;
    // k,l,m stay affine over the hull — inner verts share hull coords+klm
    // (watertight); outer verts extend klm by the directional gradient.
    //   aTC=(k,l,m) · aC0=(n̂.xy, packHalf2x16(dk,dl), dm)
    //   with ends: aC1=(nA,nB) · aC2=(packHalf(nOwnA), packHalf(nOwnB), κA, κB) · aC3=(a,b)
    //   |aSign|=8192 + 4096 + 2048·spanB + 1024·spanA + 16·codeA + codeB
    const hasEnds = !!(c.e1 && c.e2 && c.a && c.b && c.na && c.nb);
    let sgnC12 = c.sign * (8192 + 4096);
    let nOwnPackA = 0, nOwnPackB = 0, kA = 0, kB = 0;
    if (hasEnds) {
      const La = Math.hypot(c.na[0], c.na[1]) || 1;
      let nOAx = -c.sign * (-c.na[1] / La), nOAy = -c.sign * (c.na[0] / La);
      let nL = Math.hypot(nOAx, nOAy) || 1; nOAx /= nL; nOAy /= nL;
      const Lb = Math.hypot(c.nb[0], c.nb[1]) || 1;
      let nOBx = -c.sign * (-c.nb[1] / Lb), nOBy = -c.sign * (c.nb[0] / Lb);
      nL = Math.hypot(nOBx, nOBy) || 1; nOBx /= nL; nOBy /= nL;
      const ax = c.a[0], ay = c.a[1], bx = c.b[0], by = c.b[1];
      let cxm, cym;
      if (c.cp && c.cp[1] && c.cp[2]) {
        cxm = (c.cp[1][0] + c.cp[2][0]) / 2; cym = (c.cp[1][1] + c.cp[2][1]) / 2;
      } else { cxm = (ax + bx) / 2; cym = (ay + by) / 2; }
      let sAx = cxm - ax, sAy = cym - ay; let L12 = Math.hypot(sAx, sAy) || 1; sAx /= L12; sAy /= L12;
      let sBx = cxm - bx, sBy = cym - by; L12 = Math.hypot(sBx, sBy) || 1; sBx /= L12; sBy /= L12;
      const spanA = (-nOAy) * sAx + nOAx * sAy > 0 ? 1 : 0;
      const spanB = (-nOBy) * sBx + nOBx * sBy > 0 ? 1 : 0;
      const { codeA, codeB } = band12EndCodes(c.e1, c.e2);
      sgnC12 = c.sign * (8192 + 4096 + 2048 * spanB + 1024 * spanA + 16 * codeA + codeB);
      nOwnPackA = packHalf2x16(nOAx, nOAy);
      nOwnPackB = packHalf2x16(nOBx, nOBy);
      kA = band12EndKappa(c.e1); kB = band12EndKappa(c.e2);
    }
    for (const R9 of c._ring) {
      for (let k = 0; k < 6; k++) {
        const b9 = R9.base[k], ext9 = R9.ext[k];
        head(c.hull[2 * b9], c.hull[2 * b9 + 1], c.klmn[3 * b9], c.klmn[3 * b9 + 1], c.klmn[3 * b9 + 2], 12, sgnC12);
        if (ext9) {
          v[o + 7] = R9.nx; v[o + 8] = R9.ny;
          v[o + 9] = packHalf2x16(R9.dk, R9.dl); v[o + 10] = R9.dm;
        } else {
          v[o + 7] = 0; v[o + 8] = 0; v[o + 9] = 0; v[o + 10] = 0;
        }
        if (hasEnds) writeBand12Ends(v, o, c.e1, c.e2, nOwnPackA, nOwnPackB, kA, kB, c.a[0], c.a[1], c.b[0], c.b[1]);
        else clearBand12Ends(v, o);
        v[o + 23] = 0;
        hasBezout = true;
        o += LB_VERT_FLOATS;
      }
    }
  }
  // Kind-10 unified edge cap-strip: one primitive per straight edge owning the
  // WHOLE exterior band plus both end wedges. Edges without e1/e2 end meta are
  // skipped (builders always attach them under the current strip/band path).
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
    if (e.e1 && e.e2) strip10(e);
  }
  // Circular-SDF disc: kind 7 disc mode (aC3.w = −1). One bbox quad; the fragment
  // computes f = sign·(length(em−centre)−r) and slugCov AA's it — exact, seam-free.
  // Elliptical disc: aC3.w = −2, aC3.z = rx, aC0 = (ry, cosφ, sinφ, 0); unit-circle
  // pullback level set with screen-space derivatives (same slugCov path).
  // Quad dilated past the outline to hold the outer AA band.
  const disc = (px, py, c) => {
    if (c.rx != null) {
      head(px, py, 0, 0, 0, 7, 1);
      v[o + 7] = c.ry; v[o + 8] = Math.cos(c.phi || 0); v[o + 9] = Math.sin(c.phi || 0); v[o + 10] = 0;
      v[o + 19] = c.cx; v[o + 20] = c.cy; v[o + 21] = c.rx; v[o + 22] = -2;
    } else {
      head(px, py, 0, 0, 0, 7, 1);
      v[o + 19] = c.cx; v[o + 20] = c.cy; v[o + 21] = c.r; v[o + 22] = -1;
    }
    o += LB_VERT_FLOATS;
  };
  for (const c of circles) {
    let H;
    if (c.rx != null) {
      const ca = Math.abs(Math.cos(c.phi || 0)), sa = Math.abs(Math.sin(c.phi || 0));
      const Hx = c.rx * ca + c.ry * sa, Hy = c.rx * sa + c.ry * ca;
      H = 1.2 * Math.max(Hx, Hy) + 2;
    } else {
      H = 1.2 * c.r + 2;
    }
    const x0 = c.cx - H, x1 = c.cx + H, y0 = c.cy - H, y1 = c.cy + H;
    disc(x0, y0, c); disc(x1, y0, c); disc(x1, y1, c);
    disc(x0, y0, c); disc(x1, y1, c); disc(x0, y1, c);
  }
  // Concentric-ring disc: kind 7 ring mode. aC3 = (cx, cy, rMid, halfW ≥ 0).
  const ring = (px, py, a) => { head(px, py, 0, 0, 0, 7, 1); v[o + 19] = a.cx; v[o + 20] = a.cy; v[o + 21] = a.rMid; v[o + 22] = a.halfW; o += LB_VERT_FLOATS; };
  for (const a of annuli) {
    const H = 1.2 * (a.rMid + a.halfW) + 2, x0 = a.cx - H, x1 = a.cx + H, y0 = a.cy - H, y1 = a.cy + H;
    ring(x0, y0, a); ring(x1, y0, a); ring(x1, y1, a);
    ring(x0, y0, a); ring(x1, y1, a); ring(x0, y1, a);
  }
  // Curve band (kind 12): 4 verts (a, b on the boundary + their outward-pushed twins) as
  // 2 tris, or a fat ring (15 verts). aC3 = (a.xy, b.xy) span; aTC = (Ũ,Ṽ,R).
  // Push verts carry aC0 = (n̂.xy, Δuv.xy); base verts aC0 = 0.
  for (const q of curveStripQuads) {
    const ax = q.tri[0], ay = q.tri[1], cx = q.tri[2], cy = q.tri[3], bx = q.tri[4], by = q.tri[5];
    // Affine map (em → uv) from the control triangle: uv(a)=(0,0), uv(ctrl)=(½,0), uv(b)=(1,1).
    const e1x = cx - ax, e1y = cy - ay, e2x = bx - ax, e2y = by - ay;
    const det = e1x * e2y - e1y * e2x;
    if (Math.abs(det) < 1e-12 || !isBand12(q)) continue;
    const i11 = e2y / det, i12 = -e2x / det, i21 = -e1y / det, i22 = e1x / det;   // inverse em basis
    const Jux = 0.5 * i11 + 1 * i21, Juy = 0.5 * i12 + 1 * i22;                    // ∇u (em) integral
    const Jvx = 0 * i11 + 1 * i21, Jvy = 0 * i12 + 1 * i22;                        // ∇v (em) integral
    {
      // UNIFIED BAND (kind 12): exterior footprint + end machinery. Slot plan:
      //   aTC=(Ũ,Ṽ,R) · aC3=(a.xy,b.xy) · aC0=push (n̂, Δuv)
      //   aC1=(nA,nB) · aC2=(packHalf(nOwnA), packHalf(nOwnB), κA, κB)
      //   |aSign|=4096+2048·spanB+1024·spanA+16·codeA+codeB
      // κ rides mixed aC2.zw so morph-pair t lerps curvatures (aSeamM is A-only).
      // Homogeneous frame: a=(0,0,1), ctrl=(½/w,0,1/w), b=(1,1,1). Integral w≡1 → R≡1.
      const iw = 1 / (q.w || 1);
      const Uc = 0.5 * iw, Rc = iw;
      const Hux = Uc * i11 + 1 * i21, Huy = Uc * i12 + 1 * i22;
      const Hvx = Jvx, Hvy = Jvy;
      const Hrx = (Rc - 1) * i11, Hry = (Rc - 1) * i12;
      let nOAx = -q.sign * Hvx, nOAy = -q.sign * Hvy;
      let L12 = Math.hypot(nOAx, nOAy) || 1; nOAx /= L12; nOAy /= L12;
      let nOBx = q.sign * (2 * Hux - Hvx - Hrx), nOBy = q.sign * (2 * Huy - Hvy - Hry);
      L12 = Math.hypot(nOBx, nOBy) || 1; nOBx /= L12; nOBy /= L12;
      let sAx = cx - ax, sAy = cy - ay; L12 = Math.hypot(sAx, sAy) || 1; sAx /= L12; sAy /= L12;
      let sBx = cx - bx, sBy = cy - by; L12 = Math.hypot(sBx, sBy) || 1; sBx /= L12; sBy /= L12;
      const spanA = (-nOAy) * sAx + nOAx * sAy > 0 ? 1 : 0;
      const spanB = (-nOBy) * sBx + nOBx * sBy > 0 ? 1 : 0;
      const { codeA, codeB } = band12EndCodes(q.e1, q.e2);
      const sgn12 = q.sign * (4096 + 2048 * spanB + 1024 * spanA + 16 * codeA + codeB);
      // κA/κB ride aC2.zw (mixed under morph); nOwn packed as half in aC2.xy.
      // aSeamM stays 0 — it is A-stream-only on the morph pair VS.
      const nOwnPackA = packHalf2x16(nOAx, nOAy), nOwnPackB = packHalf2x16(nOBx, nOBy);
      const sv12 = (px, py, u, vv, r, dxs, dys) => {
        head(px, py, u, vv, r, 12, sgn12);
        v[o + 7] = dxs; v[o + 8] = dys; v[o + 9] = Hux * dxs + Huy * dys; v[o + 10] = Hvx * dxs + Hvy * dys;
        writeBand12Ends(v, o, q.e1, q.e2, nOwnPackA, nOwnPackB, band12EndKappa(q.e1), band12EndKappa(q.e2), ax, ay, bx, by);
        v[o + 23] = 0;
        o += LB_VERT_FLOATS;
      };
      const ovx0 = -q.sign * Hvx, ovy0 = -q.sign * Hvy;
      const ovL = Math.hypot(ovx0, ovy0) || 1, ovx = ovx0 / ovL, ovy = ovy0 / ovL;
      const ctrlSide12 = (cx - (ax + bx) / 2) * ovx + (cy - (ay + by) / 2) * ovy > 0;
      if (stripFat(q)) {
        const UV = { a: [0, 0, 1], c: [Uc, 0, Rc], b: [1, 1, 1] };
        const ring12 = (P0, uv0, P1, uv1, T3) => {
          let nx = -(P1[1] - P0[1]), ny = P1[0] - P0[0];
          const nL = Math.hypot(nx, ny) || 1; nx /= nL; ny /= nL;
          if (nx * (T3[0] - P0[0]) + ny * (T3[1] - P0[1]) > 0) { nx = -nx; ny = -ny; }
          const el = Math.hypot(P1[0] - P0[0], P1[1] - P0[1]) || 1;
          const tx9 = (P1[0] - P0[0]) / el, ty9 = (P1[1] - P0[1]) / el;
          sv12(P0[0], P0[1], uv0[0], uv0[1], uv0[2], 0, 0); sv12(P1[0], P1[1], uv1[0], uv1[1], uv1[2], 0, 0); sv12(P1[0], P1[1], uv1[0], uv1[1], uv1[2], nx + tx9, ny + ty9);
          sv12(P0[0], P0[1], uv0[0], uv0[1], uv0[2], 0, 0); sv12(P1[0], P1[1], uv1[0], uv1[1], uv1[2], nx + tx9, ny + ty9); sv12(P0[0], P0[1], uv0[0], uv0[1], uv0[2], nx - tx9, ny - ty9);
          return [nx, ny];
        };
        if (!ctrlSide12) {
          ring12([ax, ay], UV.a, [bx, by], UV.b, [cx, cy]);
        } else {
          const n1 = ring12([ax, ay], UV.a, [cx, cy], UV.c, [bx, by]);
          const n2 = ring12([cx, cy], UV.c, [bx, by], UV.b, [ax, ay]);
          sv12(cx, cy, UV.c[0], UV.c[1], UV.c[2], 0, 0);
          sv12(cx, cy, UV.c[0], UV.c[1], UV.c[2], n1[0], n1[1]);
          sv12(cx, cy, UV.c[0], UV.c[1], UV.c[2], n2[0], n2[1]);
        }
      } else {
        const bx0 = Math.min(ax, cx, bx), by0 = Math.min(ay, cy, by);
        const bx1 = Math.max(ax, cx, bx), by1 = Math.max(ay, cy, by);
        const uOf = (px, py) => {
          const relx = px - ax, rely = py - ay;
          return [Hux * relx + Huy * rely, Hvx * relx + Hvy * rely, 1 + Hrx * relx + Hry * rely];
        };
        let uv; uv = uOf(bx0, by0); sv12(bx0, by0, uv[0], uv[1], uv[2], -1, -1);
        uv = uOf(bx1, by0); sv12(bx1, by0, uv[0], uv[1], uv[2], 1, -1);
        uv = uOf(bx1, by1); sv12(bx1, by1, uv[0], uv[1], uv[2], 1, 1);
        uv = uOf(bx0, by0); sv12(bx0, by0, uv[0], uv[1], uv[2], -1, -1);
        uv = uOf(bx1, by1); sv12(bx1, by1, uv[0], uv[1], uv[2], 1, 1);
        uv = uOf(bx0, by1); sv12(bx0, by1, uv[0], uv[1], uv[2], -1, 1);
      }
      hasBezout = true;
    }
  }
  // KIND-13 thin chain strips (piece tier → reject the solid interior where drawn).
  // Each vert carries its edge's chain: P0,P1 → aC3.xy/zw, P2,P3 → aC0.xy/zw.
  if (chainStripVerts) {
    for (let i = 0, c = 0; i < chainStripVerts.length; i += 2, c += 4) {
      head(chainStripVerts[i], chainStripVerts[i + 1], 0, 0, 0, 13, 0);
      v[o + 19] = chainStripA[c]; v[o + 20] = chainStripA[c + 1];
      v[o + 21] = chainStripA[c + 2]; v[o + 22] = chainStripA[c + 3];
      v[o + 7] = chainStripB[c]; v[o + 8] = chainStripB[c + 1];
      v[o + 9] = chainStripB[c + 2]; v[o + 10] = chainStripB[c + 3];
      o += LB_VERT_FLOATS;
    }
  }
  emitInterior9();
  // Trim slack so GL uploads and mem accounting match the draw count exactly.
  // Never report a vertexCount past the buffer — TypedArray length is the
  // source of truth (grow should have kept them equal; this is the last gate).
  const verts = (o === v.length) ? v : v.slice(0, o);
  let vc = (o / LB_VERT_FLOATS) | 0;
  const maxVc = (verts.length / LB_VERT_FLOATS) | 0;
  if (vc > maxVc) vc = maxVc;
  if (vc > LB_MAX_VERTS_PER_MESH) {
    if (typeof console !== 'undefined') {
      console.warn('[mantle] LB mesh budget: shape has ' + vc + ' verts (cap '
        + LB_MAX_VERTS_PER_MESH + ') — rendering via Slug.');
    }
    return { verts: new Float32Array(0), vertexCount: 0, fallback: mesh.fallback,
      hasBezout: false, overBudget: true };
  }
  // chain 2 lives in aC1/aC2, which only the FULL program binds — same signal.
  return { verts, vertexCount: vc, fallback: mesh.fallback, hasBezout: hasBezout || !!mesh.interiorHasChain2 };
}
