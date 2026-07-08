// Codepoint -> uint8 property trie with block dedup + RLE blob serialization.
//
// Compression (UAX-table packing):
//   - split the 0..0x110000 codepoint space into 256-cp blocks
//   - deduplicate identical blocks (most of Unicode is the default value)
//   - stage1[cp>>8] indexes the unique block; value = block[(cp&255)]
//   - serialize [stage1 || uniqueBlocks] under a byte-oriented RLE so the long
//     default runs collapse to a few bytes
//
// The decoder is intentionally tiny and branch-light so the JS and C# runtime
// loaders stay bit-identical.

export const MAX_CP = 0x110000;
export const BLOCK_SHIFT = 8;
export const BLOCK_SIZE = 1 << BLOCK_SHIFT; // 256
export const BLOCK_MASK = BLOCK_SIZE - 1;
export const BLOCK_COUNT = MAX_CP >> BLOCK_SHIFT; // 4352

const MAGIC = 0x4d555432; // "MUT2"
const CHUNK = 32; // stage-1 dedup chunk size
const NUM_CHUNKS_RAW = BLOCK_COUNT / CHUNK; // 136

// RLE: escape 0xFF; 0xFF 0x00 = literal 0xFF;
//   0xFF n byte (3<=n<=255) = run of n copies of byte.
const RLE_ESC = 0xff;
const RLE_MIN_RUN = 3;
const RLE_MAX_RUN = 255;

function rleEncode(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const b = src[i];
    if (b === RLE_ESC) {
      out.push(RLE_ESC, 0x00);
      i++;
      continue;
    }
    let run = 1;
    while (i + run < src.length && run < RLE_MAX_RUN && src[i + run] === b) run++;
    if (run >= RLE_MIN_RUN) {
      out.push(RLE_ESC, run, b);
      i += run;
    } else {
      for (let k = 0; k < run; k++) out.push(b);
      i += run;
    }
  }
  return Uint8Array.from(out);
}

function rleDecode(src, outLen) {
  const out = new Uint8Array(outLen);
  let i = 0;
  let o = 0;
  while (i < src.length) {
    const b = src[i++];
    if (b === RLE_ESC) {
      const n = src[i++];
      if (n === 0x00) {
        out[o++] = RLE_ESC;
      } else {
        const v = src[i++];
        for (let k = 0; k < n; k++) out[o++] = v;
      }
    } else {
      out[o++] = b;
    }
  }
  if (o !== outLen) throw new Error(`RLE length mismatch: ${o} != ${outLen}`);
  return out;
}

// values: Uint8Array | number[] of length <= MAX_CP (missing entries = default).
// Returns { stage1: Uint16Array(BLOCK_COUNT), blocks: Uint8Array(n*256), numBlocks, def }.
export function buildTrie(values, def = 0) {
  const raw = new Uint8Array(MAX_CP);
  if (def !== 0) raw.fill(def);
  const n = Math.min(values.length, MAX_CP);
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v !== undefined) raw[i] = v;
  }

  const stage1 = new Uint16Array(BLOCK_COUNT);
  const blocks = []; // array of Uint8Array(256)
  const seen = new Map(); // block-key -> index
  for (let b = 0; b < BLOCK_COUNT; b++) {
    const start = b * BLOCK_SIZE;
    const blk = raw.subarray(start, start + BLOCK_SIZE);
    const key = blockKey(blk);
    let idx = seen.get(key);
    if (idx === undefined) {
      idx = blocks.length;
      seen.set(key, idx);
      blocks.push(blk.slice());
    }
    stage1[b] = idx;
  }

  const flat = new Uint8Array(blocks.length * BLOCK_SIZE);
  for (let i = 0; i < blocks.length; i++) flat.set(blocks[i], i * BLOCK_SIZE);
  return { stage1, blocks: flat, numBlocks: blocks.length, def };
}

function blockKey(blk) {
  // Latin1 string key is fast and collision-free for byte blocks.
  let s = "";
  for (let i = 0; i < blk.length; i++) s += String.fromCharCode(blk[i]);
  return s;
}

// Serialize to the .mut blob (MUT2). Three-stage trie: the stage-1 block-index
// array is deduplicated in CHUNK-sized chunks (top[] -> chunkPool), and block
// indices are 1 byte when there are <=256 unique blocks. Everything is then RLE
// compressed. header(32) + RLE(top) + RLE(chunkPool) + RLE(blocks).
export function serializeTrie(trie) {
  const { stage1, blocks, numBlocks, def } = trie;
  const stage1Bytes = numBlocks <= 256 ? 1 : 2;

  const seen = new Map();
  const chunkPool = []; // each = CHUNK block indices
  const top = new Uint8Array(NUM_CHUNKS_RAW);
  for (let c = 0; c < NUM_CHUNKS_RAW; c++) {
    let key = "";
    for (let k = 0; k < CHUNK; k++) key += stage1[c * CHUNK + k] + ",";
    let idx = seen.get(key);
    if (idx === undefined) {
      idx = chunkPool.length;
      seen.set(key, idx);
      const ch = new Array(CHUNK);
      for (let k = 0; k < CHUNK; k++) ch[k] = stage1[c * CHUNK + k];
      chunkPool.push(ch);
    }
    top[c] = idx; // chunkPool.length <= 136 < 256
  }
  const numChunks = chunkPool.length;
  const chunkBytes = new Uint8Array(numChunks * CHUNK * stage1Bytes);
  let p = 0;
  for (const ch of chunkPool) {
    for (const v of ch) {
      chunkBytes[p++] = v & 0xff;
      if (stage1Bytes === 2) chunkBytes[p++] = (v >> 8) & 0xff;
    }
  }

  const rTop = rleEncode(top);
  const rChunk = rleEncode(chunkBytes);
  const rBlock = rleEncode(blocks);

  const header = new Uint8Array(32);
  const dv = new DataView(header.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint8(4, BLOCK_SHIFT);
  dv.setUint8(5, def);
  dv.setUint8(6, stage1Bytes);
  dv.setUint16(8, numChunks, true);
  dv.setUint32(12, rTop.length, true);
  dv.setUint32(16, rChunk.length, true);
  dv.setUint32(20, rBlock.length, true);
  dv.setUint32(24, blocks.length, true); // uncompressed block-pool length
  const out = new Uint8Array(32 + rTop.length + rChunk.length + rBlock.length);
  out.set(header, 0);
  let o = 32;
  out.set(rTop, o); o += rTop.length;
  out.set(rChunk, o); o += rChunk.length;
  out.set(rBlock, o);
  return out;
}

// Reference decoder (the spec the C#/JS runtime loaders mirror).
export function decodeTrie(blob) {
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error("bad trie magic");
  const def = dv.getUint8(5);
  const stage1Bytes = dv.getUint8(6);
  const numChunks = dv.getUint16(8, true);
  const rTopLen = dv.getUint32(12, true);
  const rChunkLen = dv.getUint32(16, true);
  const rBlockLen = dv.getUint32(20, true);
  const poolLen = dv.getUint32(24, true);
  let off = 32;
  const top = rleDecode(blob.subarray(off, off + rTopLen), NUM_CHUNKS_RAW);
  off += rTopLen;
  const chunkBytes = rleDecode(blob.subarray(off, off + rChunkLen), numChunks * CHUNK * stage1Bytes);
  off += rChunkLen;
  const blocks = rleDecode(blob.subarray(off, off + rBlockLen), poolLen);
  const chunkPool = new Uint16Array(numChunks * CHUNK);
  if (stage1Bytes === 1) for (let i = 0; i < chunkPool.length; i++) chunkPool[i] = chunkBytes[i];
  else for (let i = 0; i < chunkPool.length; i++) chunkPool[i] = chunkBytes[i * 2] | (chunkBytes[i * 2 + 1] << 8);
  return {
    def,
    lookup(cp) {
      if (cp < 0 || cp >= MAX_CP) return def;
      const blockNum = cp >> BLOCK_SHIFT;
      const blockIdx = chunkPool[top[blockNum >> 5] * CHUNK + (blockNum & 31)];
      return blocks[blockIdx * BLOCK_SIZE + (cp & BLOCK_MASK)];
    },
  };
}

// Variable-length uint32 array as LEB128 varints (optionally delta-encoded for
// sorted/monotonic arrays). Used for the NFC/case/bidi/RGI key+data arrays.
export function encodeVarintArray(arr, delta) {
  const out = [];
  let prev = 0;
  for (let i = 0; i < arr.length; i++) {
    let v = delta ? arr[i] - prev : arr[i];
    prev = arr[i];
    while (v >= 0x80) { out.push((v & 0x7f) | 0x80); v >>>= 7; }
    out.push(v);
  }
  return Uint8Array.from(out);
}
