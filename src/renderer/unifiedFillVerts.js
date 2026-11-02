// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// unifiedFillVerts.js — one interleaved vertex stream for cover quads AND
// Loop-Blinn triangles.
//
// WHY: correct compositing needs fills and strokes interleaved in ONE draw,
// because within a single draw call fragments hitting the same pixel blend in
// PRIMITIVE order. That gives exact painter order for translucent paint and AA
// fringes with no depth buffer, no sort pass and no overlap analysis — ordering
// never leaves the draw call. Splitting into two draws reintroduces the ordering
// problem that depth cannot solve at AA edges, where every shape is partially
// transparent for a pixel or two all the way around.
//
// This is assembled in the RENDERER, not the importer: COVER_QUAD_STRIDE is a
// wire-format constant, and widening it would break
// that contract for a layout only the GPU cares about. Bundles carry
// 12-float cover quads; this fattens them at LB-build time, cached like the
// existing combined LB VBO.
//
// UNIFIED VERTEX — 29 floats / 116 bytes. A vertex is either a cover quad or an
// LB triangle, so the two occupy disjoint fields and each leaves the other's
// zeroed:
//
//   off  floats  loc  cover quad        LB triangle
//     0     2     0   position          position
//     8     2     1   bisector normal   (unused)
//    16     2     2   native em coord   (unused)
//    24     3    14   (unused)          texcoord / klmn
//    36     3    15   (unused, 0)       kind+1, sign, seamM
//    48     1     7   shape index       shape index
//    52    16   3-6   (unused)          aC0..aC3 per-curve coefficients
//
// The kind field is BIASED BY ONE. An unbound vertex attribute reads (0,0,0,1),
// so a raw kind would make every cover quad look like an INTERIOR piece and take
// the LB path; biased, 0 means "not LB" and an all-cover-quad buffer needs no
// binding at slot 15 at all.

// MORPH (the B half). A morph vertex carries the SECOND endpoint's pack in the
// same vertex, and the vertex shader mixes the two by uMorphT — the same
// dual-stream trick loopBlinn.vert already uses (MANTLE_LB_MORPH_PAIR), so one
// static mesh serves every t. Only the endpoint-VARYING fields need a twin:
// kind, sign, seamM and the shape index are endpoint-invariant by construction
// (both packs come from the same partition), so they are not duplicated.
//
//   off  floats  loc  morph B half
//    50     2     8   position B
//    58     3     9   texcoord / klmn B
//    68    16  10-13  aC0B..aC3B
//
// That is exactly the six free attribute locations: the static half uses 0-7, 14
// and 15, so the pair fills the 16-attribute budget with nothing to spare. Any
// future per-vertex field has to displace something or move to a texture.

// WHY THE STREAM IS NOT NARROWED FURTHER. On desktop GPUs this draw is fragment bound:
// a fixed cost per draw plus a per-pixel term, with vertex work invisible, and padding
// the stream to twice its bytes changes nothing measurable. So the per-curve texture,
// attribute packing, indexed draws and morph B-half dedup optimize a component that
// does not cost anything on that class of GPU: there they pay for themselves in memory,
// not speed.
//
// Per-vertex byte shares of the wide layout:
//
//          U_C0..C3    64B  55%  per-curve coefficients — precision sensitive
//          U_LBTC      12B  10%  texcoord/klmn — LB coverage math
//          U_LBMETA    12B  10%  (kind+1, sign, seamM)
//          U_POS        8B   7%  em position
//          U_NORMAL     8B   7%  UN-NORMALIZED outward bisector
//          U_EMCOORD    8B   7%  em coord (gradients/patterns)
//          U_SHAPEIDX   4B   3%  integer index
//
//        Two structural blockers. (a) 55% of the vertex is per-curve coefficients,
//        and FP16 is not safe there — the coverage kernel is precision sensitive
//        (cubic sign, hull sign). (b) YOU CANNOT NARROW ONE COMPONENT OF AN
//        ATTRIBUTE: vertexAttribPointer takes one type for the whole attribute, so
//        kind being 0..21 buys nothing while it shares aLbMeta with sign and seamM,
//        which need FP32 range. aNormal is un-normalized (see the vertex shader), so
//        snorm needs a scale factor — complexity for 4 bytes.
//        The best regroup, kind+shapeIdx into one ushort2 with aLbMeta dropping to
//        vec2 (16B -> 12B, i.e. 3.4%), costs mixed-type writes in the hot builder and
//        a second vertex layout (hence extra PSOs on Metal). Not worth it.
//
// Per-vertex byte shares of the curve-texture layout before the index pair:
//
//          UC_LBTC     12B 21%   UC_LBMETA  12B 21%   UC_POS     8B 14%
//          UC_NORMAL    8B 14%   UC_EMCOORD  8B 14%   UC_SHAPEIDX 4B 7%
//          UC_CURVEIDX  4B  7%
//
//        Mobile bandwidth favors narrowing more than desktop does; a mixed-type
//        hot-path builder for it should be validated on a mobile device first.
//
// ── MINIMAL NARROWING (the curve-texture layout's index pair) ───────────────
// The 7.1% does NOT require the aLbMeta surgery costed above. UC_SHAPEIDX and
// UC_CURVEIDX are two small non-negative integers, 8 bytes as two one-float
// attributes; packing them into ONE unsigned-short pair (UC_IDXPAIR) captures the
// entire saving and touches nothing else.

export const UNIFIED_STRIDE = 29; // floats per vertex (static half)
export const UNIFIED_STRIDE_BYTES = UNIFIED_STRIDE * 4;
/// Morph stream: the static half, then the B endpoint's varying fields.
export const UNIFIED_MORPH_STRIDE = 50;
export const UNIFIED_MORPH_STRIDE_BYTES = UNIFIED_MORPH_STRIDE * 4;

// Field offsets, in floats, within one unified vertex.
export const U_POS = 0,
  U_NORMAL = 2,
  U_EMCOORD = 4,
  U_LBTC = 6,
  U_LBMETA = 9,
  U_SHAPEIDX = 12,
  U_C0 = 13;
// ...and within the morph B half.
export const U_POS_B = 29,
  U_LBTC_B = 31,
  U_C0_B = 34;

// Source strides.
const COVER_STRIDE = 12; // wire format (see coverQuadChunks.js)
const LB_STRIDE = 24; // packLoopBlinnMesh's interleaved vertex
const LB_PAIR_STRIDE = LB_STRIDE * 2; // morph pair: [A 24f | B 24f]

/// Attribute binding table for the unified stream: [location, size, byteOffset].
/// Exported so the VAO setup and this layout cannot drift apart.
export const UNIFIED_ATTRIBS = Object.freeze([
  [0, 2, U_POS * 4],
  [1, 2, U_NORMAL * 4],
  [2, 2, U_EMCOORD * 4],
  [14, 3, U_LBTC * 4],
  [15, 3, U_LBMETA * 4],
  [7, 1, U_SHAPEIDX * 4],
  [3, 4, (U_C0 + 0) * 4],
  [4, 4, (U_C0 + 4) * 4],
  [5, 4, (U_C0 + 8) * 4],
  [6, 4, (U_C0 + 12) * 4],
]);

// ── CURVE-TEXTURE LAYOUT (opt-in: unifiedFillCurveTex) ──────────────────────
// The 16 per-curve coefficient floats leave the vertex and live in an RGBA32F
// texture, 4 texels per unique block, addressed by ONE index float. RGBA32F keeps
// them FP32, so this is a placement change with no precision change.
//
//   static  29 floats/116B -> 13 floats/52B   (55% smaller)
//   morph   50 floats/200B -> 19 floats/76B   (62% smaller)
//
export const UC_STRIDE = 13;
export const UC_STRIDE_BYTES = UC_STRIDE * 4;
export const UC_MORPH_STRIDE = 19;
export const UC_MORPH_STRIDE_BYTES = UC_MORPH_STRIDE * 4;
export const UC_POS = 0,
  UC_NORMAL = 2,
  UC_EMCOORD = 4,
  UC_LBTC = 6,
  UC_LBMETA = 9,
  UC_IDXPAIR = 12;
export const UC_POS_B = 13,
  UC_LBTC_B = 15,
  UC_CURVEIDX_B = 18;
/// Both packed values must fit an unsigned short. Above this the builder REFUSES
/// (returns null) and the caller falls back to the wide float layout, rather than
/// wrapping silently — a wrapped block index reads someone else's coefficients.
export const UC_IDX_MAX = 65535;
/// The limit buildCurveTexStream enforces; a TEST HOOK lowers it so a small bundle overflows (the renderer itself never changes it).
let _idxLimit = UC_IDX_MAX;
export function _setUcIdxLimitForTest(n) {
  _idxLimit = n > 0 ? n | 0 : UC_IDX_MAX;
}

// ── 32-BIT INDEX LAYOUT (a bundle past the 16-bit limit) ─────────────────────────────────────────────────────────────────────
// The (shapeIdx, coefBlock) pair rides one unsigned-short pair while both fit (the layout above, byte for byte, so a bundle
// under the limit pays nothing). A bundle with more than 65,535 shapes or distinct coefficient blocks is
// rebuilt with the pair in two unsigned 32-bit slots, converted to float UNNORMALIZED by the vertex fetch, so the shader and
// the program are the same; the index is then exact to 2^24. One more float a vertex (13 -> 14, 19 -> 20), against the wide
// layout's 29 and 50.
export const UC32_STRIDE = 14;
export const UC32_STRIDE_BYTES = UC32_STRIDE * 4;
export const UC32_MORPH_STRIDE = 20;
export const UC32_MORPH_STRIDE_BYTES = UC32_MORPH_STRIDE * 4;
export const UC32_POS_B = 14,
  UC32_LBTC_B = 16,
  UC32_CURVEIDX_B = 19;
export const UC32_IDX_MAX = 16777215;
let _idxLimit32 = UC32_IDX_MAX;
export function _setUcIdx32LimitForTest(n) {
  _idxLimit32 = n > 0 ? n | 0 : UC32_IDX_MAX;
}
/// The coefficient texture is at most this many texels wide and tall: the width doubles from UC_TEX_W until the rows fit.
export const UC_TEX_MAX_W = 4096,
  UC_TEX_MAX_H = 4096;
/// 4 texels per coefficient block; texture width in TEXELS.
export const UC_TEXELS_PER_BLOCK = 4;
export const UC_TEX_W = 256;

/// [location, size, byteOffset, type?] — type defaults to FLOAT. 'ushort' is read
/// UNNORMALIZED, so the integer arrives in the shader's float verbatim.
export const UC_ATTRIBS = Object.freeze([
  [0, 2, UC_POS * 4],
  [1, 2, UC_NORMAL * 4],
  [2, 2, UC_EMCOORD * 4],
  [14, 3, UC_LBTC * 4],
  [15, 3, UC_LBMETA * 4],
  [7, 2, UC_IDXPAIR * 4, 'ushort'], // (shapeIdx, coefBlock)
]);
export const UC32_ATTRIBS = Object.freeze([
  [0, 2, UC_POS * 4],
  [1, 2, UC_NORMAL * 4],
  [2, 2, UC_EMCOORD * 4],
  [14, 3, UC_LBTC * 4],
  [15, 3, UC_LBMETA * 4],
  [7, 2, UC_IDXPAIR * 4, 'uint'], // (shapeIdx, coefBlock)
]);
export const UC32_MORPH_ATTRIBS = Object.freeze([
  [8, 2, UC32_POS_B * 4],
  [9, 3, UC32_LBTC_B * 4],
  [10, 1, UC32_CURVEIDX_B * 4],
]);
export const UC_MORPH_ATTRIBS = Object.freeze([
  [8, 2, UC_POS_B * 4],
  [9, 3, UC_LBTC_B * 4],
  [10, 1, UC_CURVEIDX_B * 4],
]);

/// Builds the coefficient texture from an already-built full-width stream, and
/// returns the narrow stream plus the texture data.
///
///   feature      t      curve tex        baseline
///   solid        0/.5/1 269/538/240      269/538/240   IDENTICAL
///   translucent  0/.5/1 172/503/166      172/503/166   IDENTICAL
///   strokeOnly   0/.5/1 0/0/0            0/0/0         IDENTICAL
///   clipped      0      155px w11        155px w11     identical
///   clipped      0.5    13444px w192     333px w70     BROKEN
///   clipped      1      11418px w192     152px w16     BROKEN
///
/// So the layout itself is right — every unclipped morph is bit-identical at every t,
/// and clipped is right at t=0. Only clip x morph x t>0 fails. Correct at t=0 and
/// wrong as t rises points at the B endpoint's contribution, but the obvious
/// candidate (dedup merging the A and B blocks) is RULED OUT: keying on exact bit
/// patterns instead of toFixed text left the pixels identical.
///
/// CONTAINED (unifiedFillDraw declines curve-tex for morph bundles with clip content,
/// gate `curvetex-morph-clip`), so the combination is unreachable and every other
/// morph keeps the 46.7% saving. That is containment, NOT a root-cause fix.
///
/// Narrowed to exactly morph x clip x curve-tex. Forcing the composed path with the
/// texture still on renders correctly (176/330/177), which is why declining is a safe
/// answer, and static clipped is clean too.
///
/// RULED OUT, each by measurement rather than reading:
///   - the dedup key merging a vertex's A and B blocks. toFixed(7) genuinely does
///     collapse values agreeing to 7 decimals, and it would fit "right at t=0, wrong
///     after" — but keying on exact BIT PATTERNS left the pixels IDENTICAL.
///   - a variant mismatch caught by the draw's own bail: it fires 3 times during
///     warm-up on the WORKING solid case too and does not grow with t.
///   - a texture-unit collision: 11 and 12 are unused by the fill pass (ext clip is
///     14, palette 13).
///   - the per-draw EXTERNAL clip: gating on R.draw.extClipTex never fired, because
///     this clip is bundle-level. The variant key is the signal that works.
///
/// Root cause still open. The next thing I would check is what the extra clip draw
/// does to the morph's uMorphT / segment state, since t=0 is correct and only t>0
/// fails — that points at the B endpoint's contribution rather than at the layout.
export function buildCurveTexStream(verts, vertexCount, morph, into = null) {
  const nz = makeNarrower(vertexCount, morph, into, false);
  if (nz.push(verts, vertexCount, 0)) {
    const fin = nz.finish();
    if (fin) return fin;
  }
  // Past the 16-bit limit: the same stream with 32-bit indices (a pooled buffer is the 16-bit layout's size, so it is not reused).
  const nz32 = makeNarrower(vertexCount, morph, null, true);
  return nz32.push(verts, vertexCount, 0) ? nz32.finish() : null;
}

/// The narrowing as a STATE MACHINE, so a stream can be narrowed a run of vertices at a time. buildCurveTexStream is this over
/// the whole wide stream; buildUnifiedFillVertsNarrow feeds it one entry at a time and never holds the wide stream (the wide
/// stream is 29 or 50 floats a vertex against 13 or 19).
///
/// Interning is by exact BIT PATTERN, through an open-addressing table over the blocks' own int32 view
/// instead of one 100-byte string key per unique block in a Map plus a boxed-double array of the blocks. Blocks are numbered in
/// the order their first vertex is pushed, so pushing the same vertices in the same order yields the same indices and the same
/// texture. push() returns false when an index would not fit an unsigned short (the caller falls back to the wide layout).
function makeNarrower(vertexCount, morph, into, idx32) {
  const wide = morph ? UNIFIED_MORPH_STRIDE : UNIFIED_STRIDE;
  const narrow = idx32
    ? morph
      ? UC32_MORPH_STRIDE
      : UC32_STRIDE
    : morph
      ? UC_MORPH_STRIDE
      : UC_STRIDE;
  const posB = idx32 ? UC32_POS_B : UC_POS_B,
    lbtcB = idx32 ? UC32_LBTC_B : UC_LBTC_B,
    curveIdxB = idx32 ? UC32_CURVEIDX_B : UC_CURVEIDX_B;
  const limit = idx32 ? _idxLimit32 : _idxLimit;
  // Refill a pooled buffer when it is exactly the right size — the narrow stream is
  // the one that reaches the GPU, so a streamed bundle has to pool this as well as
  // the wide scratch it is built from, or it still allocates every frame.
  const out =
    into && into.length === narrow * vertexCount ? into : new Float32Array(narrow * vertexCount);
  const u16 = new Uint16Array(out.buffer),
    u32 = new Uint32Array(out.buffer); // same bytes: the index pair as two shorts or two ints
  let blocks = new Float32Array(64 * 16),
    bbits = new Int32Array(blocks.buffer); // 16 floats a block, copied bit-exactly
  let nBlocks = 0,
    tcap = 128,
    table = new Int32Array(tcap); // 0 = empty, else block index + 1
  const find = (vb, at) => {
    let h = 0x811c9dc5 | 0;
    for (let i = 0; i < 16; i++) h = Math.imul(h ^ vb[at + i], 0x01000193);
    for (let t = (h ^ (h >>> 15)) & (tcap - 1); ; t = (t + 1) & (tcap - 1)) {
      const e = table[t];
      if (!e) return { t, idx: -1, h };
      const o = (e - 1) * 16;
      let same = true;
      for (let i = 0; i < 16; i++)
        if (bbits[o + i] !== vb[at + i]) {
          same = false;
          break;
        }
      if (same) return { t, idx: e - 1, h };
    }
  };
  const grow = () => {
    if ((nBlocks + 1) * 16 > blocks.length) {
      const nb = new Float32Array(blocks.length * 2);
      nb.set(blocks);
      blocks = nb;
      bbits = new Int32Array(blocks.buffer);
    }
    if ((nBlocks + 1) * 2 > tcap) {
      // rehash at 50% load
      tcap *= 2;
      table = new Int32Array(tcap);
      for (let b = 0; b < nBlocks; b++) {
        let h = 0x811c9dc5 | 0;
        const o = b * 16;
        for (let i = 0; i < 16; i++) h = Math.imul(h ^ bbits[o + i], 0x01000193);
        let t = (h ^ (h >>> 15)) & (tcap - 1);
        while (table[t]) t = (t + 1) & (tcap - 1);
        table[t] = b + 1;
      }
    }
  };
  const intern = (vb, at) => {
    let r = find(vb, at);
    if (r.idx >= 0) return r.idx;
    grow();
    r = find(vb, at); // the table may have been rehashed: probe again
    const idx = nBlocks++,
      o = idx * 16;
    for (let i = 0; i < 16; i++) bbits[o + i] = vb[at + i];
    table[r.t] = idx + 1;
    return idx;
  };
  let lastVerts = null,
    lastBits = null;
  return {
    out,
    /// Narrow `count` wide vertices from `verts` (vertex 0 of `verts` is stream vertex `outStart`).
    push(verts, count, outStart) {
      // Int32 view over the same bytes, so a block's identity is its exact bit pattern.
      if (verts !== lastVerts) {
        lastVerts = verts;
        lastBits = new Int32Array(verts.buffer, verts.byteOffset, verts.length);
      }
      const vb = lastBits;
      for (let v = 0; v < count; v++) {
        const s = v * wide,
          d = (outStart + v) * narrow;
        out[d + UC_POS] = verts[s + U_POS];
        out[d + UC_POS + 1] = verts[s + U_POS + 1];
        out[d + UC_NORMAL] = verts[s + U_NORMAL];
        out[d + UC_NORMAL + 1] = verts[s + U_NORMAL + 1];
        out[d + UC_EMCOORD] = verts[s + U_EMCOORD];
        out[d + UC_EMCOORD + 1] = verts[s + U_EMCOORD + 1];
        for (let i = 0; i < 3; i++) out[d + UC_LBTC + i] = verts[s + U_LBTC + i];
        for (let i = 0; i < 3; i++) out[d + UC_LBMETA + i] = verts[s + U_LBMETA + i];
        // The pair rides one 4-byte slot (two 4-byte slots in the 32-bit layout), written through an integer view over the
        // same buffer. Byte offset (d + UC_IDXPAIR) * 4 in shorts is (d + UC_IDXPAIR) * 2.
        const sh = verts[s + U_SHAPEIDX] | 0,
          ci = intern(vb, s + U_C0);
        if (sh > limit || ci > limit) return false;
        if (idx32) {
          u32[d + UC_IDXPAIR] = sh;
          u32[d + UC_IDXPAIR + 1] = ci;
        } else {
          u16[(d + UC_IDXPAIR) * 2] = sh;
          u16[(d + UC_IDXPAIR) * 2 + 1] = ci;
        }
        if (morph) {
          out[d + posB] = verts[s + U_POS_B];
          out[d + posB + 1] = verts[s + U_POS_B + 1];
          for (let i = 0; i < 3; i++) out[d + lbtcB + i] = verts[s + U_LBTC_B + i];
          out[d + curveIdxB] = intern(vb, s + U_C0_B);
        }
      }
      return true;
    },
    /// The coefficient texture: 4 RGBA texels per block, row-major in a UC_TEX_W-wide texture (UC_TEX_W = 256 texels = 1024
    /// floats = exactly 64 blocks a row, so a block never straddles a row and the fetch index stays idx*4 + i). null on overflow.
    finish() {
      // Belt and braces: the per-vertex check above only sees the indices actually USED, so a table that overflows without any
      // single vertex referencing a high block would slip through. The table size is the honest bound.
      if (nBlocks > limit) return null;
      const texels = nBlocks * UC_TEXELS_PER_BLOCK;
      // Width doubles (staying a multiple of 4 texels, so a block never straddles a row) until the rows fit the 4096-row
      // minimum device; the shader reads the width from a uniform. Past 4096 x 4096 texels the stream is refused.
      let W = UC_TEX_W;
      while (Math.ceil(texels / W) > UC_TEX_MAX_H && W < UC_TEX_MAX_W) W *= 2;
      if (Math.ceil(texels / W) > UC_TEX_MAX_H) return null;
      const h = Math.max(1, Math.ceil(texels / W));
      // The block store IS the texture's rows: it is zero past the last block (fresh storage, grown by copy) and its length is a
      // whole number of rows, so a view of the first h rows is byte-identical to a copy.
      const need = W * h * 4;
      let data;
      if (blocks.length >= need) data = blocks.subarray(0, need);
      else {
        data = new Float32Array(need);
        data.set(blocks.subarray(0, Math.min(nBlocks * 16, need)));
      }
      return {
        verts: out,
        vertexCount,
        coefData: data,
        coefW: W,
        coefH: h,
        blocks: nBlocks,
        idx32,
      };
    },
  };
}

/// buildUnifiedFillVerts + buildCurveTexStream without ever holding the wide stream: each entry is built into ONE reusable wide
/// scratch (zero-filled per entry, exactly the zeros a fresh whole-stream array gives its unwritten fields) and narrowed straight
/// into the output. Same entries stamped with the same vStart/vCount, same stream bytes, same coefficient texture, same null
/// (-> `{ overflow: true }`) when an index does not fit. Not for a streamed bundle, whose wide scratch is pooled across frames.
export function buildUnifiedFillVertsNarrow(
  entries,
  coverFloats,
  shapeIdxFloats,
  morph = false,
  into = null,
) {
  const r = buildUnifiedFillVertsNarrowAs(entries, coverFloats, shapeIdxFloats, morph, into, false);
  // Past the 16-bit limit the whole stream is built again with 32-bit indices (the entries are re-stamped; a pooled buffer is not reused).
  return r.overflow
    ? buildUnifiedFillVertsNarrowAs(entries, coverFloats, shapeIdxFloats, morph, null, true)
    : r;
}
function buildUnifiedFillVertsNarrowAs(entries, coverFloats, shapeIdxFloats, morph, into, idx32) {
  const total = unifiedVertexCount(entries);
  const stride = morph ? UNIFIED_MORPH_STRIDE : UNIFIED_STRIDE;
  if (!total) return { verts: new Float32Array(0), vertexCount: 0, stride, entries };
  let maxN = 0;
  for (const e of entries) {
    if (e.kind === 'groupBegin' || e.kind === 'groupEnd') continue;
    maxN = Math.max(maxN, e.kind === 'lb' ? e.vertexCount | 0 : e.count | 0);
  }
  const scratch = new Float32Array(maxN * stride);
  const nz = makeNarrower(total, morph, into, idx32);
  let v = 0;
  for (const e of entries) {
    const v0 = v;
    if (e.kind === 'groupBegin' || e.kind === 'groupEnd') {
      e.vStart = v0;
      e.vCount = 0;
      continue;
    }
    const n = e.kind === 'lb' ? e.vertexCount | 0 : e.count | 0; // what buildUnifiedFillVerts appends (not what unifiedVertexCount sized the stream by)
    scratch.fill(0, 0, n * stride);
    if (e.kind === 'lb') {
      if (morph) appendLbMeshMorph(scratch, 0, e.verts, e.vertexCount, e.shapeIdx);
      else appendLbMesh(scratch, 0, e.verts, e.vertexCount, e.shapeIdx);
    } else {
      appendCoverQuads(
        scratch,
        0,
        e.floats || coverFloats,
        e.srcVert,
        e.count,
        shapeIdxFloats,
        stride,
        e.coverKid | 0,
        e.floats ? e.shapeIdx : -1,
      );
    }
    if (!nz.push(scratch, n, v0)) return { overflow: true };
    v = v0 + n;
    e.vStart = v0;
    e.vCount = n;
  }
  const fin = nz.finish();
  if (!fin) return { overflow: true };
  return {
    verts: fin.verts,
    vertexCount: v,
    stride,
    entries,
    coefData: fin.coefData,
    coefW: fin.coefW,
    coefH: fin.coefH,
    blocks: fin.blocks,
    idx32,
  };
}

/// The B half, appended to UNIFIED_ATTRIBS for a morph VAO.
export const UNIFIED_MORPH_ATTRIBS = Object.freeze([
  [8, 2, U_POS_B * 4],
  [9, 3, U_LBTC_B * 4],
  [10, 4, (U_C0_B + 0) * 4],
  [11, 4, (U_C0_B + 4) * 4],
  [12, 4, (U_C0_B + 8) * 4],
  [13, 4, (U_C0_B + 12) * 4],
]);

/// Widen `count` cover-quad vertices starting at `srcVert` into `out` at
/// `outVert`. Everything an LB vertex would use stays zero, which is exactly the
/// "not LB" encoding.
///
/// `coverKid` is the PER-ENTRY COVER KERNEL ID.
/// It rides `aLbMeta.y`, the one slot a cover vertex leaves free: `.x` must stay 0 because
/// `aLbMeta.x > 0.5` IS the "this is an LB vertex" test, and `.z` is NOT free because the fragment
/// reads it as vSeam. No new attribute, no wider stride, and 0 (the default) writes the same zero
/// this function has always written — so a caller that does not stamp ids produces a byte-identical
/// stream.
export function appendCoverQuads(
  out,
  outVert,
  coverFloats,
  srcVert,
  count,
  shapeIdxFloats,
  stride = UNIFIED_STRIDE,
  coverKid = 0,
  fixedShapeIdx = -1,
) {
  for (let i = 0; i < count; i++) {
    const s = (srcVert + i) * COVER_STRIDE,
      d = (outVert + i) * stride;
    out[d + U_POS] = coverFloats[s];
    out[d + U_POS + 1] = coverFloats[s + 1];
    out[d + U_NORMAL] = coverFloats[s + 2];
    out[d + U_NORMAL + 1] = coverFloats[s + 3];
    out[d + U_EMCOORD] = coverFloats[s + 4];
    out[d + U_EMCOORD + 1] = coverFloats[s + 5];
    out[d + U_SHAPEIDX] =
      fixedShapeIdx >= 0 ? fixedShapeIdx : shapeIdxFloats ? shapeIdxFloats[srcVert + i] : 0;
    // U_LBMETA.x stays 0 → "not an LB vertex", and .z stays 0 → no seam mark. Only .y carries
    // anything, and only the kernel id, which a program without MANTLE_COVER_KERNEL never reads.
    out[d + U_LBMETA + 1] = coverKid;
    // In a morph stream the B position must MIRROR A, not stay zero: the vertex
    // shader mixes unconditionally, so a zeroed twin would drag every cover quad
    // toward the origin as t rises. A cover quad's own morphing is already done —
    // its corners come from the per-frame lerped shape bbox.
    if (stride >= UNIFIED_MORPH_STRIDE) {
      out[d + U_POS_B] = out[d + U_POS];
      out[d + U_POS_B + 1] = out[d + U_POS + 1];
    }
  }
  return outVert + count;
}

/// Append one packed LB mesh's vertices, stamping every vertex with the shape it
/// belongs to so the fragment can fetch that shape's paint from the meta texture
/// exactly as a cover quad does. That is what removes the per-shape uniform, and
/// with it the per-shape draw.
export function appendLbMesh(out, outVert, packedVerts, vertexCount, shapeIdx) {
  for (let i = 0; i < vertexCount; i++) {
    const s = i * LB_STRIDE,
      d = (outVert + i) * UNIFIED_STRIDE;
    out[d + U_POS] = packedVerts[s];
    out[d + U_POS + 1] = packedVerts[s + 1];
    out[d + U_LBTC] = packedVerts[s + 2]; // aTC.xyz
    out[d + U_LBTC + 1] = packedVerts[s + 3];
    out[d + U_LBTC + 2] = packedVerts[s + 4];
    out[d + U_LBMETA] = packedVerts[s + 5] + 1; // kind, BIASED
    out[d + U_LBMETA + 1] = packedVerts[s + 6]; // sign
    out[d + U_LBMETA + 2] = packedVerts[s + 23]; // seamM (the pad float)
    out[d + U_SHAPEIDX] = shapeIdx;
    for (let k = 0; k < 16; k++) out[d + U_C0 + k] = packedVerts[s + 7 + k]; // aC0..aC3
  }
  return outVert + vertexCount;
}

/// Append one PAIR-packed LB mesh (the morph mesh: [A 24f | B 24f] per vertex,
/// the layout _ensureBundleMorphMeshes builds). The A half lands exactly where a
/// static mesh's would, so everything downstream is shared; only the endpoint-
/// varying fields get a twin.
///
/// kind, sign and seamM are NOT duplicated, and that is a contract rather than an
/// omission: both endpoint packs come from the same partition, so a vertex is the
/// same KIND of piece at both ends. If that ever stops holding, the mesh is not a
/// valid morph pair and mixing its coefficients would be meaningless anyway.
export function appendLbMeshMorph(out, outVert, pairVerts, vertexCount, shapeIdx) {
  for (let i = 0; i < vertexCount; i++) {
    const s = i * LB_PAIR_STRIDE,
      sB = s + LB_STRIDE,
      d = (outVert + i) * UNIFIED_MORPH_STRIDE;
    out[d + U_POS] = pairVerts[s];
    out[d + U_POS + 1] = pairVerts[s + 1];
    out[d + U_LBTC] = pairVerts[s + 2];
    out[d + U_LBTC + 1] = pairVerts[s + 3];
    out[d + U_LBTC + 2] = pairVerts[s + 4];
    out[d + U_LBMETA] = pairVerts[s + 5] + 1; // kind, BIASED
    out[d + U_LBMETA + 1] = pairVerts[s + 6]; // sign
    out[d + U_LBMETA + 2] = pairVerts[s + 23]; // seamM (the pad float)
    out[d + U_SHAPEIDX] = shapeIdx;
    for (let k = 0; k < 16; k++) out[d + U_C0 + k] = pairVerts[s + 7 + k];
    out[d + U_POS_B] = pairVerts[sB];
    out[d + U_POS_B + 1] = pairVerts[sB + 1];
    out[d + U_LBTC_B] = pairVerts[sB + 2];
    out[d + U_LBTC_B + 1] = pairVerts[sB + 3];
    out[d + U_LBTC_B + 2] = pairVerts[sB + 4];
    for (let k = 0; k < 16; k++) out[d + U_C0_B + k] = pairVerts[sB + 7 + k];
  }
  return outVert + vertexCount;
}

/// Total vertices needed for a run of {coverVerts} / {lbMesh} entries.
export function unifiedVertexCount(entries) {
  let n = 0;
  for (const e of entries) {
    if (e.kind === 'groupBegin' || e.kind === 'groupEnd') continue; // markers, no geometry
    n += e.kind === 'lb' || e.kind === 'stroke' ? e.vertexCount | 0 : e.count | 0;
  }
  return n;
}

/// Assemble the whole stream. `entries` are already in PAINTER ORDER — that
/// ordering is the only thing making the single draw composite correctly, so it
/// is the caller's job to preserve it rather than something this can recover.
///
/// Stamps each entry with its VERTEX RANGE (`vStart`, `vCount`) in the assembled
/// stream. That is what lets a caller draw a SUBSET of the stream — one shape
/// alone into a filter's isolation target, or the runs either side of it — with
/// `drawArrays(TRIANGLES, vStart, vCount)` and no second buffer. Ranges are
/// contiguous and in painter order by construction: entries are appended one
/// after another here, so consecutive entries' ranges abut and a run of them is
/// itself one range.
///
/// The ranges survive `buildCurveTexStream`, which rewrites each vertex into a
/// narrower stride but preserves vertex ORDER and COUNT one-for-one.
export function buildUnifiedFillVerts(
  entries,
  coverFloats,
  shapeIdxFloats,
  morph = false,
  into = null,
) {
  const total = unifiedVertexCount(entries);
  const stride = morph ? UNIFIED_MORPH_STRIDE : UNIFIED_STRIDE;
  // Refill in place when the caller hands back a buffer of exactly the right size.
  // A streamed bundle rebuilds its geometry every frame, so allocating a fresh
  // multi-megabyte Float32Array per frame is the difference between streaming and
  // stuttering — the classic combined VBO pooled for the same reason. Exact length
  // only: a subarray view would leave stale vertices past the end.
  const out = into && into.length === total * stride ? into : new Float32Array(total * stride);
  let v = 0;
  for (const e of entries) {
    const v0 = v;
    // A group bracket carries no geometry — it is a marker the draw walk acts on.
    // It still gets a (zero-length) range so entry indices line up with the spans.
    if (e.kind === 'groupBegin' || e.kind === 'groupEnd') {
      e.vStart = v0;
      e.vCount = 0;
      continue;
    }
    v =
      e.kind === 'lb'
        ? morph
          ? appendLbMeshMorph(out, v, e.verts, e.vertexCount, e.shapeIdx)
          : appendLbMesh(out, v, e.verts, e.vertexCount, e.shapeIdx)
        : appendCoverQuads(
            out,
            v,
            e.floats || coverFloats,
            e.srcVert,
            e.count,
            shapeIdxFloats,
            stride,
            e.coverKid | 0,
            e.floats ? e.shapeIdx : -1,
          );
    e.vStart = v0;
    e.vCount = v - v0;
  }
  return { verts: out, vertexCount: v, stride, entries };
}
