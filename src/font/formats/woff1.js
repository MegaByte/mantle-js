// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// woff1.js -- WOFF 1.0 (W3C, 2012) to sfnt. The container is a table directory plus per-table zlib streams, so the
// decode is a directory walk and an inflate per table; no Brotli, no glyf transform. Used by decodeIfWoff2().
import { inflateZlibBytes } from '../../core/gzip.js';

export const WOFF1_SIG = 0x774f4646; // 'wOFF'
const MAX_SFNT_BYTES = 1 << 28;

export function isWoff1(bytes) {
  return (
    !!bytes &&
    bytes.length >= 4 &&
    bytes[0] === 0x77 &&
    bytes[1] === 0x4f &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46
  );
}

/// @param {Uint8Array} bytes a WOFF 1.0 file
/// @returns {Promise<Uint8Array>} the sfnt it wraps
export async function decodeWoff1(bytes) {
  if (bytes.length < 44) throw new Error('WOFF 1.0 header truncated');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flavor = v.getUint32(4, false);
  const numTables = v.getUint16(12, false);
  if (numTables === 0) throw new Error('WOFF 1.0 has no tables');
  if (44 + numTables * 20 > bytes.length) throw new Error('WOFF 1.0 table directory truncated');
  const dirSize = 12 + 16 * numTables;
  const entries = [];
  let total = dirSize;
  for (let i = 0; i < numTables; i++) {
    const e = 44 + i * 20;
    const tag = v.getUint32(e, false),
      off = v.getUint32(e + 4, false);
    const comp = v.getUint32(e + 8, false),
      orig = v.getUint32(e + 12, false),
      sum = v.getUint32(e + 16, false);
    if (comp > orig) throw new Error(`WOFF 1.0 table ${i} is larger compressed than original`);
    if (off + comp > bytes.length) throw new Error(`WOFF 1.0 table ${i} extends past the file`);
    total += (orig + 3) & ~3;
    if (total > MAX_SFNT_BYTES) throw new Error('WOFF 1.0 decodes to an unreasonably large font');
    entries.push({ tag, off, comp, orig, sum });
  }
  const out = new Uint8Array(total);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, flavor, false);
  ov.setUint16(4, numTables, false);
  let pow = 1,
    log = 0;
  while (pow << 1 <= numTables) {
    pow <<= 1;
    log++;
  }
  ov.setUint16(6, pow * 16, false);
  ov.setUint16(8, log, false);
  ov.setUint16(10, numTables * 16 - pow * 16, false);
  let cursor = dirSize;
  for (let i = 0; i < numTables; i++) {
    const t = entries[i];
    const src = bytes.subarray(t.off, t.off + t.comp);
    const data = t.comp < t.orig ? await inflateZlibBytes(src) : src;
    if (data.length !== t.orig)
      throw new Error(
        `WOFF 1.0 table ${i} inflated to ${data.length} bytes, directory says ${t.orig}`,
      );
    const d = 12 + i * 16;
    ov.setUint32(d, t.tag, false);
    ov.setUint32(d + 4, t.sum, false);
    ov.setUint32(d + 8, cursor, false);
    ov.setUint32(d + 12, t.orig, false);
    out.set(data, cursor);
    cursor += (t.orig + 3) & ~3;
  }
  return out;
}
