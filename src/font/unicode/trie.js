// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Decoder for codepoint->uint8 property tries. Three-stage block-dedup + RLE
// blob (MUT2 magic).

const MAGIC = 0x4d555432; // "MUT2"
const BLOCK_SHIFT = 8;
const BLOCK_SIZE = 256;
const BLOCK_MASK = 255;
const CHUNK = 32;
const NUM_CHUNKS_RAW = (0x110000 >> BLOCK_SHIFT) / CHUNK; // 136
const RLE_ESC = 0xff;

function rleDecode(src, start, len, outLen) {
  const out = new Uint8Array(outLen);
  let i = start;
  const end = start + len;
  let o = 0;
  while (i < end) {
    const b = src[i++];
    if (b === RLE_ESC) {
      const n = src[i++];
      if (n === 0) out[o++] = RLE_ESC;
      else {
        const v = src[i++];
        for (let k = 0; k < n; k++) out[o++] = v;
      }
    } else out[o++] = b;
  }
  return out;
}

// blobFromBase64 decodes a generated table module's base64 payload to bytes.
export function blobFromBase64(b64) {
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, 'base64')); // Node fallback
}

export class UnicodeTrie {
  constructor(blob) {
    const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    if (dv.getUint32(0, true) !== MAGIC) throw new Error('bad trie magic');
    this.def = dv.getUint8(5);
    const stage1Bytes = dv.getUint8(6);
    const numChunks = dv.getUint16(8, true);
    const rTopLen = dv.getUint32(12, true);
    const rChunkLen = dv.getUint32(16, true);
    const rBlockLen = dv.getUint32(20, true);
    const poolLen = dv.getUint32(24, true);
    let off = 32;
    this.top = rleDecode(blob, off, rTopLen, NUM_CHUNKS_RAW);
    off += rTopLen;
    const chunkBytes = rleDecode(blob, off, rChunkLen, numChunks * CHUNK * stage1Bytes);
    off += rChunkLen;
    this.blocks = rleDecode(blob, off, rBlockLen, poolLen);
    this.chunkPool = new Uint16Array(numChunks * CHUNK);
    if (stage1Bytes === 1)
      for (let i = 0; i < this.chunkPool.length; i++) this.chunkPool[i] = chunkBytes[i];
    else
      for (let i = 0; i < this.chunkPool.length; i++)
        this.chunkPool[i] = chunkBytes[i * 2] | (chunkBytes[i * 2 + 1] << 8);
  }

  get(cp) {
    if (cp < 0 || cp >= 0x110000) return this.def;
    const blockNum = cp >> BLOCK_SHIFT;
    const blockIdx = this.chunkPool[this.top[blockNum >> 5] * CHUNK + (blockNum & 31)];
    return this.blocks[blockIdx * BLOCK_SIZE + (cp & BLOCK_MASK)];
  }
}

export function loadTrie(b64) {
  return new UnicodeTrie(blobFromBase64(b64));
}

// Decode a variable-length uint32 array (LEB128 varints, optionally delta-coded)
// from base64. Layout: [count:u32 LE][delta:u8][varint bytes]. Used by the NFC,
// case, bidi-map, and RGI tables.
export function varint(b64) {
  const bytes = blobFromBase64(b64);
  const count = bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24);
  const delta = bytes[4];
  const out = new Uint32Array(count);
  let i = 5;
  let prev = 0;
  for (let j = 0; j < count; j++) {
    let v = 0,
      shift = 0,
      b;
    do {
      b = bytes[i++];
      v |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80);
    v >>>= 0;
    if (delta) v = prev + v;
    out[j] = v;
    prev = v;
  }
  return out;
}

// Decode a case-mapping blob into the flat {keys, off, data} the case engine
// expects. Single-codepoint mappings (the vast majority) are stored as a
// zigzag-varint delta from their key; multi-codepoint expansions (ß→SS, …) are
// stored separately; the two are merged back into one sorted run. Layout:
// [sCount:u32][mCount:u32] dv(sKeys) v(sZigzag) dv(mKeys) v(mLens) v(mData).
function decodeCaseMap(bytes, start) {
  let i = start;
  const rd4 = () => {
    const v = (bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24)) >>> 0;
    i += 4;
    return v;
  };
  const sCount = rd4();
  const mCount = rd4();
  const dec = (count, delta) => {
    const out = new Uint32Array(count);
    let prev = 0;
    for (let j = 0; j < count; j++) {
      let v = 0,
        s = 0,
        b;
      do {
        b = bytes[i++];
        v |= (b & 0x7f) << s;
        s += 7;
      } while (b & 0x80);
      v >>>= 0;
      if (delta) v = prev + v;
      out[j] = v;
      prev = v;
    }
    return out;
  };
  const sKeys = dec(sCount, true);
  const sZig = dec(sCount, false);
  const mKeys = dec(mCount, true);
  const mLens = dec(mCount, false);
  let mDataLen = 0;
  for (let j = 0; j < mCount; j++) mDataLen += mLens[j];
  const mData = dec(mDataLen, false);
  const mStart = new Uint32Array(mCount);
  for (let j = 0, acc = 0; j < mCount; j++) {
    mStart[j] = acc;
    acc += mLens[j];
  }

  const total = sCount + mCount;
  const keys = new Uint32Array(total);
  const off = new Uint32Array(total + 1);
  const data = new Uint32Array(sCount + mDataLen);
  let si = 0,
    mi = 0,
    ki = 0,
    di = 0;
  while (si < sCount || mi < mCount) {
    if (mi >= mCount || (si < sCount && sKeys[si] < mKeys[mi])) {
      const z = sZig[si];
      const d = z & 1 ? -((z + 1) >>> 1) : z >>> 1;
      keys[ki] = sKeys[si];
      data[di++] = sKeys[si] + d;
      si++;
    } else {
      keys[ki] = mKeys[mi];
      for (let k = 0; k < mLens[mi]; k++) data[di++] = mData[mStart[mi] + k];
      mi++;
    }
    off[++ki] = di;
  }
  return { keys, off, data };
}

export function caseMap(b64) {
  return decodeCaseMap(blobFromBase64(b64), 0);
}

// Decode a case map stored as a delta over a base map (title over upper, fold
// over lower): a bitmask marks which base keys carry the identical mapping; the
// remaining entries come from an appended exceptions case map. The two are
// merged into one sorted run. Layout: [baseKeyCount:u32][bitmask][caseMap].
export function caseMapDelta(b64, base) {
  const bytes = blobFromBase64(b64);
  const baseKeyCount = (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
  const bmStart = 4;
  const bmLen = (baseKeyCount + 7) >> 3;
  const exc = decodeCaseMap(bytes, bmStart + bmLen);

  const entries = [];
  for (let bi = 0; bi < baseKeyCount; bi++) {
    if (bytes[bmStart + (bi >> 3)] & (1 << (bi & 7))) {
      const v = [];
      for (let j = base.off[bi]; j < base.off[bi + 1]; j++) v.push(base.data[j]);
      entries.push([base.keys[bi], v]);
    }
  }
  for (let ei = 0; ei < exc.keys.length; ei++) {
    const v = [];
    for (let j = exc.off[ei]; j < exc.off[ei + 1]; j++) v.push(exc.data[j]);
    entries.push([exc.keys[ei], v]);
  }
  entries.sort((a, b) => a[0] - b[0]);

  const keys = new Uint32Array(entries.length);
  const off = new Uint32Array(entries.length + 1);
  const data = [];
  for (let n = 0; n < entries.length; n++) {
    keys[n] = entries[n][0];
    for (const x of entries[n][1]) data.push(x);
    off[n + 1] = data.length;
  }
  return { keys, off, data: Uint32Array.from(data) };
}
