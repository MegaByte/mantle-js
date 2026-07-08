// woff2Reader.js — woff2 → sfnt reconstruction.
// Uses the runtime-provided
// DecompressionStream API for Brotli (Chrome 80+, Firefox 113+,
// Safari 16.4+, Node 18+).

import { untransformGlyfLoca } from './woff2GlyfTransform.js';
import {
  MAX_DECOMPRESS_BYTES,
  assertDecompressInputSize,
  assertDecompressOutputSize,
} from '../../core/decompress.js';

const TAG_woff2 = 0x774F4632;
const TAG_ttcf  = 0x74746366;

// Spec §4.4 known-tags table (63 entries; tag idx 63 = explicit follow).
const KNOWN_TAGS = [
  'cmap','head','hhea','hmtx','maxp','name','OS/2','post',
  'cvt ','fpgm','glyf','loca','prep','CFF ','VORG','EBDT',
  'EBLC','gasp','hdmx','kern','LTSH','PCLT','VDMX','vhea',
  'vmtx','BASE','GDEF','GPOS','GSUB','EBSC','JSTF','MATH',
  'CBDT','CBLC','COLR','CPAL','SVG ','sbix','acnt','avar',
  'bdat','bloc','bsln','cvar','fdsc','feat','fmtx','fvar',
  'gvar','hsty','just','lcar','mort','morx','opbd','prop',
  'trak','Zapf','Silf','Glat','Gloc','Feat','Sill',
].map(s => (s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3));

export function isWoff2(bytes) {
  if (!bytes || bytes.length < 4) return false;
  return readU32BE(bytes, 0) === TAG_woff2;
}

/**
 * Decode a woff2 byte blob into a sfnt-format byte blob.
 * @param {Uint8Array} woff2
 * @returns {Promise<Uint8Array>}
 */
export async function decodeWoff2(woff2) {
  if (!isWoff2(woff2)) throw new Error('Not a woff2 file');
  if (woff2.length < 48) throw new Error('woff2 header truncated');

  const flavor    = readU32BE(woff2, 4);
  const numTables = readU16BE(woff2, 12);
  const totalCompressed = readU32BE(woff2, 20);
  const isCollection = flavor === TAG_ttcf;

  let cursor = 48;
  const entries = [];
  for (let i = 0; i < numTables; i++) {
    const flags = woff2[cursor++];
    const knownIdx = flags & 0x3F;
    const transformVersion = (flags >> 6) & 0x03;
    let tag;
    if (knownIdx === 0x3F) {
      tag = readU32BE(woff2, cursor); cursor += 4;
    } else tag = KNOWN_TAGS[knownIdx];
    const r1 = readUIntBase128(woff2, cursor);
    const origLength = r1.value; cursor = r1.cursor;
    const isGlyf = tag === 0x676C7966;
    const isLoca = tag === 0x6C6F6361;
    const isHmtx = tag === 0x686D7478;
    let transformLength = -1;
    let transformed = false;
    // glyf/loca use transformVersion 0 for the transform (3 = null);
    // hmtx uses transformVersion 1 (0 = null) — the LSB arrays are dropped
    // and reconstructed from glyf xMin. Transformed tables carry an extra
    // transformLength after origLength.
    if (isGlyf || isLoca) transformed = transformVersion === 0;
    else if (isHmtx)      transformed = transformVersion === 1;
    if (transformed) {
      const r2 = readUIntBase128(woff2, cursor);
      transformLength = r2.value; cursor = r2.cursor;
    }
    entries.push({ tag, origLength, transformLength, transformed,
      decompressedOffset: 0, decompressedLength: 0, sfntOffset: 0, sfntLength: 0 });
  }

  // For a collection, the §6 CollectionDirectory (version, numFonts, and a
  // per-font {flavor, table-index list}) sits between the table directory and
  // the compressed body. Faces reference the shared tables above by index.
  let collection = null;
  if (isCollection) {
    const cd = parseCollectionDir(woff2, cursor);
    collection = cd; cursor = cd.cursor;
  }

  // Brotli-decompress the body.
  const compStart = cursor;
  const compEnd = compStart + totalCompressed;
  if (compEnd > woff2.length) throw new Error('woff2 truncated compressed body');
  const compressed = woff2.subarray(compStart, compEnd);
  assertDecompressInputSize(compressed.length, 'woff2 compressed body');
  const decompressed = await brotliDecompress(compressed);
  assertDecompressOutputSize(decompressed.length, 'woff2 decompressed body');

  // Slice each entry from the body.
  let bodyCursor = 0;
  for (const e of entries) {
    const sliceLen = e.transformed ? e.transformLength : e.origLength;
    if (bodyCursor + sliceLen > decompressed.length)
      throw new Error('woff2 table body overrun');
    e.decompressedOffset = bodyCursor;
    e.decompressedLength = sliceLen;
    bodyCursor += sliceLen;
  }

  // Untransform glyf/loca.
  let glyfOut = null, locaOut = null;
  for (const e of entries) {
    if (e.tag === 0x676C7966 && e.transformed) {
      ({ glyf: glyfOut, loca: locaOut } = untransformGlyfLoca(
        decompressed, e.decompressedOffset, e.decompressedLength));
    }
  }

  // Reconstruct a transformed hmtx: its dropped LSB arrays are recovered
  // from each glyph's xMin (the transform is only applied when lsb == xMin).
  let hmtxOut = null;
  const hmtxEntry = entries.find(e => e.tag === 0x686D7478 && e.transformed);
  if (hmtxEntry) {
    const hhea = entries.find(e => e.tag === 0x68686561);
    const maxp = entries.find(e => e.tag === 0x6D617870);
    if (!hhea || !maxp) throw new Error('woff2 transformed hmtx needs hhea + maxp');
    const numHMetrics = readU16BE(decompressed, hhea.decompressedOffset + 34);
    const numGlyphs   = readU16BE(decompressed, maxp.decompressedOffset + 4);
    // Final glyf + loca (reconstructed if transformed, else the raw bytes).
    let fGlyf = glyfOut, fLoca = locaOut;
    if (!fGlyf || !fLoca) {
      const ge = entries.find(e => e.tag === 0x676C7966);
      const le = entries.find(e => e.tag === 0x6C6F6361);
      if (!ge || !le) throw new Error('woff2 transformed hmtx needs glyf + loca');
      fGlyf = decompressed.subarray(ge.decompressedOffset, ge.decompressedOffset + ge.decompressedLength);
      fLoca = decompressed.subarray(le.decompressedOffset, le.decompressedOffset + le.decompressedLength);
    }
    const xMins = glyphXMins(fGlyf, fLoca, numGlyphs);
    hmtxOut = reconstructHmtx(decompressed, hmtxEntry.decompressedOffset, numHMetrics, numGlyphs, xMins);
  }

  // Each table's final bytes (reconstructed for transformed glyf/loca/hmtx).
  const finalOf = (e) => {
    if (e.tag === 0x676C7966 && glyfOut) return glyfOut;
    if (e.tag === 0x6C6F6361 && locaOut) return locaOut;
    if (e.tag === 0x686D7478 && hmtxOut) return hmtxOut;
    return decompressed.subarray(e.decompressedOffset, e.decompressedOffset + e.decompressedLength);
  };

  if (isCollection) {
    // Realistic TTCs share one glyf/loca/hmtx across faces; we don't handle
    // multiple distinct transformed glyf/loca/hmtx within a single collection.
    for (const tag of [0x676C7966, 0x6C6F6361, 0x686D7478]) {
      if (entries.filter(e => e.tag === tag && e.transformed).length > 1)
        throw new Error('woff2 collection with multiple transformed glyf/loca/hmtx not supported');
    }
    return assembleTtc(collection.version, collection.fonts, entries, finalOf);
  }
  return assembleSfnt(flavor, entries.map(e => ({ tag: e.tag, bytes: finalOf(e) })));
}

// Build a single sfnt from { tag, bytes } tables.
function assembleSfnt(flavor, tables) {
  const sorted = tables.slice().sort((a, b) => a.tag - b.tag);
  let size = 12 + sorted.length * 16;
  const offs = [];
  for (const t of sorted) { offs.push(size); size += (t.bytes.length + 3) & ~3; }
  const out = new Uint8Array(size);
  writeSfntHeader(out, 0, flavor, sorted.length);
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i], r = 12 + i * 16;
    writeU32BE(out, r, t.tag); writeU32BE(out, r + 4, 0);
    writeU32BE(out, r + 8, offs[i]); writeU32BE(out, r + 12, t.bytes.length);
    out.set(t.bytes, offs[i]);
  }
  return out;
}

// Build a TTC: one shared blob of reconstructed table data + a per-face sfnt
// offset table whose records point into it (faces sharing a table by index
// share its bytes).
function assembleTtc(version, fonts, entries, finalOf) {
  const tableBytes = entries.map(finalOf);
  let pos = 12 + fonts.length * 4;
  const fontDirPos = fonts.map(f => { const p = pos; pos += 12 + f.indices.length * 16; return p; });
  const tableOffset = new Array(entries.length).fill(-1);
  for (const f of fonts) for (const idx of f.indices) {
    if (idx >= entries.length) throw new Error('woff2 collection table index out of range');
    if (tableOffset[idx] < 0) { tableOffset[idx] = pos; pos += (tableBytes[idx].length + 3) & ~3; }
  }
  const out = new Uint8Array(pos);
  writeU32BE(out, 0, TAG_ttcf);
  writeU32BE(out, 4, version);
  writeU32BE(out, 8, fonts.length);
  for (let i = 0; i < fonts.length; i++) writeU32BE(out, 12 + i * 4, fontDirPos[i]);
  for (let fi = 0; fi < fonts.length; fi++) {
    const f = fonts[fi], base = fontDirPos[fi];
    const recs = f.indices.map(idx => ({ tag: entries[idx].tag, idx })).sort((a, b) => a.tag - b.tag);
    writeSfntHeader(out, base, f.flavor, recs.length);
    for (let i = 0; i < recs.length; i++) {
      const r = base + 12 + i * 16, idx = recs[i].idx;
      writeU32BE(out, r, entries[idx].tag); writeU32BE(out, r + 4, 0);
      writeU32BE(out, r + 8, tableOffset[idx]); writeU32BE(out, r + 12, tableBytes[idx].length);
    }
  }
  for (let idx = 0; idx < entries.length; idx++)
    if (tableOffset[idx] >= 0) out.set(tableBytes[idx], tableOffset[idx]);
  return out;
}

function writeSfntHeader(out, base, flavor, numTables) {
  writeU32BE(out, base, flavor);
  writeU16BE(out, base + 4, numTables);
  const es = numTables > 0 ? Math.floor(Math.log2(numTables)) : 0;
  const sr = (1 << es) * 16;
  writeU16BE(out, base + 6, sr);
  writeU16BE(out, base + 8, es);
  writeU16BE(out, base + 10, numTables * 16 - sr);
}

// §6 CollectionDirectory: version, numFonts, then per-font { numTables,
// flavor, table-index[] } where each index points into the table directory.
function parseCollectionDir(b, cursor) {
  const version = readU32BE(b, cursor); cursor += 4;
  let r = read255U16(b, cursor); const numFonts = r.value; cursor = r.cursor;
  const fonts = [];
  for (let i = 0; i < numFonts; i++) {
    r = read255U16(b, cursor); const numTables = r.value; cursor = r.cursor;
    const fontFlavor = readU32BE(b, cursor); cursor += 4;
    const indices = [];
    for (let j = 0; j < numTables; j++) { r = read255U16(b, cursor); indices.push(r.value); cursor = r.cursor; }
    fonts.push({ flavor: fontFlavor, indices });
  }
  return { version, fonts, cursor };
}

// 255UInt16 (WOFF2 §6): 253 → next u16; 254 → next byte + 506; 255 → next byte + 253; else literal.
function read255U16(b, cursor) {
  const first = b[cursor++];
  if (first === 253) return { value: (b[cursor] << 8) | b[cursor + 1], cursor: cursor + 2 };
  if (first === 254) return { value: b[cursor] + 506, cursor: cursor + 1 };
  if (first === 255) return { value: b[cursor] + 253, cursor: cursor + 1 };
  return { value: first, cursor };
}

// Parse each glyph's xMin from a standard glyf+loca pair. Empty glyphs
// (zero-length loca span) have no outline → xMin 0.
function glyphXMins(glyf, loca, numGlyphs) {
  const long = loca.length >= (numGlyphs + 1) * 4;
  const locaAt = g => long ? readU32BE(loca, g * 4) : (readU16BE(loca, g * 2) * 2);
  const x = new Int16Array(numGlyphs);
  for (let g = 0; g < numGlyphs; g++) {
    const s = locaAt(g), e = locaAt(g + 1);
    x[g] = e > s ? readI16BE(glyf, s + 2) : 0;   // glyf record: [numberOfContours, xMin, …]
  }
  return x;
}

// Rebuild a standard hmtx from the woff2 transform (spec §5.4): a flags
// byte, the advanceWidth array, then the lsb / leftSideBearing arrays —
// either of which may be omitted (flags bit 0 / bit 1) and reconstructed
// from glyf xMin.
function reconstructHmtx(src, off, numHMetrics, numGlyphs, xMins) {
  let p = off;
  const flags = src[p++];
  const lsbAbsent    = (flags & 0x01) !== 0;
  const lsbExtAbsent = (flags & 0x02) !== 0;
  const adv = new Array(numHMetrics);
  for (let i = 0; i < numHMetrics; i++) { adv[i] = readU16BE(src, p); p += 2; }
  let lsb = null, lsbExt = null;
  const nExt = Math.max(0, numGlyphs - numHMetrics);
  if (!lsbAbsent)    { lsb = new Array(numHMetrics); for (let i = 0; i < numHMetrics; i++) { lsb[i] = readI16BE(src, p); p += 2; } }
  if (!lsbExtAbsent) { lsbExt = new Array(nExt);     for (let i = 0; i < nExt; i++)       { lsbExt[i] = readI16BE(src, p); p += 2; } }
  const out = new Uint8Array(numHMetrics * 4 + nExt * 2);
  let o = 0;
  for (let i = 0; i < numHMetrics; i++) {
    writeU16BE(out, o, adv[i]); o += 2;
    writeI16BE(out, o, lsbAbsent ? (xMins[i] | 0) : lsb[i]); o += 2;
  }
  for (let i = 0; i < nExt; i++) {
    const gid = numHMetrics + i;
    writeI16BE(out, o, lsbExtAbsent ? (xMins[gid] | 0) : lsbExt[i]); o += 2;
  }
  return out;
}

async function brotliDecompress(compressed) {
  assertDecompressInputSize(compressed.length, 'brotli input');
  if (typeof DecompressionStream !== 'undefined') {
    try {
      let ds;
      try { ds = new DecompressionStream('br'); }
      catch { ds = new DecompressionStream('brotli'); }
      const stream = new Blob([compressed]).stream().pipeThrough(ds);
      const chunks = [];
      const reader = stream.getReader();
      let len = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (len + value.length > MAX_DECOMPRESS_BYTES) {
          throw new Error(`brotli output exceeds ${MAX_DECOMPRESS_BYTES} byte decompress limit`);
        }
        chunks.push(value);
        len += value.length;
      }
      const out = new Uint8Array(len);
      let o = 0;
      for (const c of chunks) { out.set(c, o); o += c.length; }
      return out;
    } catch (e) {
      if (e?.message?.includes('decompress limit')) throw e;
      /* Node 18–21: DecompressionStream exists but Brotli may not */
    }
  }
  const zlib = await import('zlib');
  return new Uint8Array(zlib.brotliDecompressSync(compressed, { maxOutputLength: MAX_DECOMPRESS_BYTES }));
}

function readUIntBase128(b, cursor) {
  let result = 0;
  for (let i = 0; i < 5; i++) {
    const v = b[cursor++];
    if (i === 0 && v === 0x80) throw new Error('UIntBase128 leading zero');
    if (result & 0xFE000000) throw new Error('UIntBase128 overflow');
    result = (result << 7) | (v & 0x7F);
    if ((v & 0x80) === 0) return { value: result >>> 0, cursor };
  }
  throw new Error('UIntBase128 too long');
}

function readU16BE(b, o) { return (b[o] << 8) | b[o + 1]; }
function readI16BE(b, o) { const v = (b[o] << 8) | b[o + 1]; return v >= 0x8000 ? v - 0x10000 : v; }
function writeI16BE(b, o, v) { if (v < 0) v += 0x10000; b[o] = (v >> 8) & 0xFF; b[o + 1] = v & 0xFF; }
function readU32BE(b, o) {
  // Use unsigned 32-bit math so big tags (e.g. 'wOF2' = 0x774F4632) survive.
  return ((b[o] * 0x1000000) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]) >>> 0;
}
function writeU16BE(b, o, v) { b[o] = (v >> 8) & 0xFF; b[o + 1] = v & 0xFF; }
function writeU32BE(b, o, v) {
  b[o] = (v >>> 24) & 0xFF; b[o + 1] = (v >>> 16) & 0xFF;
  b[o + 2] = (v >>> 8) & 0xFF; b[o + 3] = v & 0xFF;
}
