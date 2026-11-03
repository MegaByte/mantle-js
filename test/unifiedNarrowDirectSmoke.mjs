// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// unifiedNarrowDirectSmoke -- buildUnifiedFillVertsNarrow (one entry's wide scratch at a time) must equal building the whole wide
// stream and narrowing it (buildUnifiedFillVerts + buildCurveTexStream): same bytes, same coefficient texture, same entry ranges,
// same overflow answer. It exists because the wide stream is 29/50 floats a vertex against 13/19: holding it whole costs tens of MB of
// transient memory on a large morph at first draw.
import {
  UNIFIED_STRIDE,
  UNIFIED_MORPH_STRIDE,
  UC_STRIDE,
  UC_MORPH_STRIDE,
  U_POS,
  U_NORMAL,
  U_EMCOORD,
  U_LBTC,
  U_LBMETA,
  U_SHAPEIDX,
  U_C0,
  U_POS_B,
  U_LBTC_B,
  U_C0_B,
  UC_POS,
  UC_NORMAL,
  UC_EMCOORD,
  UC_LBTC,
  UC_LBMETA,
  UC_IDXPAIR,
  UC_POS_B,
  UC_LBTC_B,
  UC_CURVEIDX_B,
  UC_TEXELS_PER_BLOCK,
  UC_TEX_W,
  UC_IDX_MAX,
  buildUnifiedFillVerts,
  buildCurveTexStream,
  buildUnifiedFillVertsNarrow,
  _setUcIdxLimitForTest,
  _setUcIdx32LimitForTest,
  UC32_STRIDE,
  UC32_MORPH_STRIDE,
  UC32_POS_B,
  UC32_LBTC_B,
  UC32_CURVEIDX_B,
} from '../src/renderer/unifiedFillVerts.js';
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
let seed = 12345;
const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;
const bytes = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
const same = (a, b) => a.length === b.length && Buffer.compare(bytes(a), bytes(b)) === 0;

function scene(nCover, nLb, morph, dupFrac) {
  const cover = new Float32Array(nCover * 12).map(() => Math.fround(rnd() * 100));
  const sidx = new Float32Array(nCover).map((_, i) => i % 7);
  const pool = [];
  for (let k = 0; k < 6; k++) pool.push(new Float32Array(16).map(() => Math.fround(rnd() * 10))); // blocks that repeat
  const stride = morph ? 48 : 24;
  const entries = [];
  let coverAt = 0;
  for (let i = 0; i < nLb + 3; i++) {
    if (coverAt < nCover && i % 3 === 0) {
      const c = Math.min(nCover - coverAt, 1 + (i % 4));
      entries.push({ kind: 'cover', srcVert: coverAt, count: c, coverKid: i % 3 });
      coverAt += c;
    }
    if (i < nLb) {
      const n = 3 + (i % 5) * 3,
        verts = new Float32Array(n * stride);
      for (let v = 0; v < n; v++)
        for (const half of morph ? [0, 24] : [0]) {
          const o = v * stride + half;
          for (let f = 0; f < 24; f++) verts[o + f] = Math.fround(rnd() * 50);
          const blk = pool[Math.floor(rnd() * pool.length)];
          if (rnd() < dupFrac) for (let k = 0; k < 16; k++) verts[o + 7 + k] = blk[k];
          verts[o + 5] = i % 5;
          verts[o + 6] = i % 2 ? 1 : -1;
        }
      entries.push({ kind: 'lb', verts, vertexCount: n, shapeIdx: 10 + i });
    }
    if (i % 4 === 1) entries.push({ kind: 'groupBegin' }, { kind: 'groupEnd' });
  }
  return { cover, sidx, entries };
}

// A reference buildCurveTexStream (string-keyed Map, boxed-double block array), as the oracle.
function referenceNarrow(verts, vertexCount, morph) {
  const wide = morph ? UNIFIED_MORPH_STRIDE : UNIFIED_STRIDE,
    narrow = morph ? UC_MORPH_STRIDE : UC_STRIDE;
  const out = new Float32Array(narrow * vertexCount),
    u16 = new Uint16Array(out.buffer);
  const blocks = [],
    seen = new Map(),
    bits = new Int32Array(verts.buffer, verts.byteOffset, verts.length);
  const key16 = (at) => {
    let k = '';
    for (let i = 0; i < 16; i++) k += bits[at + i].toString(36) + ',';
    return k;
  };
  const intern = (src, at) => {
    const k = key16(at);
    let idx = seen.get(k);
    if (idx === undefined) {
      idx = blocks.length / 16;
      for (let i = 0; i < 16; i++) blocks.push(src[at + i]);
      seen.set(k, idx);
    }
    return idx;
  };
  for (let v = 0; v < vertexCount; v++) {
    const s = v * wide,
      d = v * narrow;
    out[d + UC_POS] = verts[s + U_POS];
    out[d + UC_POS + 1] = verts[s + U_POS + 1];
    out[d + UC_NORMAL] = verts[s + U_NORMAL];
    out[d + UC_NORMAL + 1] = verts[s + U_NORMAL + 1];
    out[d + UC_EMCOORD] = verts[s + U_EMCOORD];
    out[d + UC_EMCOORD + 1] = verts[s + U_EMCOORD + 1];
    for (let i = 0; i < 3; i++) out[d + UC_LBTC + i] = verts[s + U_LBTC + i];
    for (let i = 0; i < 3; i++) out[d + UC_LBMETA + i] = verts[s + U_LBMETA + i];
    const sh = verts[s + U_SHAPEIDX] | 0,
      ci = intern(verts, s + U_C0);
    u16[(d + UC_IDXPAIR) * 2] = sh;
    u16[(d + UC_IDXPAIR) * 2 + 1] = ci;
    if (morph) {
      out[d + UC_POS_B] = verts[s + U_POS_B];
      out[d + UC_POS_B + 1] = verts[s + U_POS_B + 1];
      for (let i = 0; i < 3; i++) out[d + UC_LBTC_B + i] = verts[s + U_LBTC_B + i];
      out[d + UC_CURVEIDX_B] = intern(verts, s + U_C0_B);
    }
  }
  const nBlocks = blocks.length / 16,
    h = Math.max(1, Math.ceil((nBlocks * UC_TEXELS_PER_BLOCK) / UC_TEX_W));
  const data = new Float32Array(UC_TEX_W * h * 4);
  const n = Math.min(blocks.length, data.length);
  for (let i = 0; i < n; i++) data[i] = blocks[i];
  return { verts: out, coefData: data, blocks: nBlocks, coefH: h };
}
const clone = (es) => es.map((e) => ({ ...e }));
for (const morph of [false, true])
  for (const [nc, nl, dup] of [
    [5, 4, 0.5],
    [40, 30, 0.2],
    [0, 12, 0.9],
    [20, 0, 0],
  ]) {
    const sc = scene(nc, nl, morph, dup),
      tag = `${morph ? 'morph' : 'static'} ${nc} cover ${nl} lb`;
    const eA = clone(sc.entries),
      eB = clone(sc.entries);
    const wide = buildUnifiedFillVerts(eA, sc.cover, sc.sidx, morph, null);
    const ref = referenceNarrow(wide.verts, wide.vertexCount, morph);
    ok(
      same(ref.verts, buildCurveTexStream(wide.verts, wide.vertexCount, morph, null).verts),
      `${tag}: buildCurveTexStream still equals the original`,
    );
    const got = buildUnifiedFillVertsNarrow(eB, sc.cover, sc.sidx, morph, null);
    ok(
      !got.overflow && got.vertexCount === wide.vertexCount,
      `${tag}: vertex count ${got.vertexCount}`,
    );
    ok(
      same(ref.verts, got.verts),
      `${tag}: narrow stream bytes identical (${ref.verts.length} floats)`,
    );
    ok(
      same(ref.coefData, got.coefData) && ref.blocks === got.blocks && ref.coefH === got.coefH,
      `${tag}: coefficient texture identical (${ref.blocks} blocks)`,
    );
    ok(
      eA.every((e, i) => e.vStart === eB[i].vStart && e.vCount === eB[i].vCount),
      `${tag}: entry ranges identical`,
    );
  }
// past the 16-bit limit the stream is rebuilt with 32-bit indices, identically by either builder; past both limits both refuse
for (const morph of [false, true]) {
  const sc = scene(10, 20, morph, 0),
    tag = morph ? 'morph' : 'static';
  const wide = buildUnifiedFillVerts(clone(sc.entries), sc.cover, sc.sidx, morph, null);
  const under = buildCurveTexStream(wide.verts, wide.vertexCount, morph, null);
  _setUcIdxLimitForTest(3);
  const ref = buildCurveTexStream(wide.verts, wide.vertexCount, morph, null),
    got = buildUnifiedFillVertsNarrow(clone(sc.entries), sc.cover, sc.sidx, morph, null);
  _setUcIdxLimitForTest(0);
  ok(
    !under.idx32 && under.verts.length === (morph ? UC_MORPH_STRIDE : UC_STRIDE) * wide.vertexCount,
    `${tag}: under the limit the 16-bit layout is built (stride ${morph ? UC_MORPH_STRIDE : UC_STRIDE})`,
  );
  ok(
    ref &&
      ref.idx32 === true &&
      ref.verts.length === (morph ? UC32_MORPH_STRIDE : UC32_STRIDE) * wide.vertexCount,
    `${tag}: an index past the 16-bit limit builds the 32-bit layout (stride ${morph ? UC32_MORPH_STRIDE : UC32_STRIDE})`,
  );
  ok(
    got &&
      !got.overflow &&
      got.idx32 === true &&
      same(ref.verts, got.verts) &&
      same(ref.coefData, got.coefData),
    `${tag}: the direct builder agrees with building wide and narrowing`,
  );
  const u32 = new Uint32Array(ref.verts.buffer),
    stride = morph ? UC32_MORPH_STRIDE : UC32_STRIDE;
  let idxOk = true;
  for (let v = 0; v < wide.vertexCount; v++) {
    const sh = wide.verts[v * (morph ? UNIFIED_MORPH_STRIDE : UNIFIED_STRIDE) + U_SHAPEIDX];
    if (u32[v * stride + UC_IDXPAIR] !== sh) idxOk = false;
  }
  ok(idxOk, `${tag}: the shape index rides the first 32-bit slot unchanged`);
  _setUcIdxLimitForTest(3);
  _setUcIdx32LimitForTest(3);
  const none = buildCurveTexStream(wide.verts, wide.vertexCount, morph, null),
    noneDirect = buildUnifiedFillVertsNarrow(clone(sc.entries), sc.cover, sc.sidx, morph, null);
  _setUcIdxLimitForTest(0);
  _setUcIdx32LimitForTest(0);
  ok(
    none === null && noneDirect.overflow === true,
    `${tag}: an index past both limits makes both refuse`,
  );
}
// ...and a stream far past 65,535 blocks (and past the 4096 rows of a 256-texel-wide texture, 262,144 blocks) is built and addressable
{
  const N = 300000,
    wide = new Float32Array(N * UNIFIED_STRIDE);
  for (let v = 0; v < N; v++) {
    wide[v * UNIFIED_STRIDE + U_SHAPEIDX] = v % 70000;
    for (let i = 0; i < 16; i++) wide[v * UNIFIED_STRIDE + U_C0 + i] = v * 16 + i + 0.5;
  }
  const got = buildCurveTexStream(wide, N, false, null);
  ok(
    got && got.idx32 && got.blocks === N,
    `${N} distinct blocks build in the 32-bit layout (the 16-bit limit is 65535)`,
  );
  ok(
    got &&
      got.coefW === 512 &&
      got.coefH === Math.ceil((N * UC_TEXELS_PER_BLOCK) / 512) &&
      got.coefH <= 4096,
    `the texture widens to ${got && got.coefW}x${got && got.coefH} texels to stay within 4096 rows`,
  );
  const u32 = new Uint32Array(got.verts.buffer);
  let wrong = 0;
  for (const v of [0, 65535, 65536, 70000, 123456, N - 1]) {
    const sh = u32[v * UC32_STRIDE + UC_IDXPAIR],
      ci = u32[v * UC32_STRIDE + UC_IDXPAIR + 1];
    if (sh !== v % 70000 || ci !== v) wrong++;
    for (let i = 0; i < 16; i++) if (got.coefData[ci * 16 + i] !== v * 16 + i + 0.5) wrong++;
  }
  ok(
    wrong === 0,
    "shape and block indices past 65,535 round-trip, and the block read through the index is the vertex's own",
  );
}
process.exit(fail ? 1 : 0);
