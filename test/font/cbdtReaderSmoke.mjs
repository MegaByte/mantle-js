// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Verifies the CBDT/CBLC reader against a synthesized minimal v3.0
// CBLC + CBDT pair.
//
// Covers IndexSubTable format 1 + image format 17. Strike has gids 1..3
// with bitmaps; gid 0 is .notdef without a bitmap.

import { CbdtReader } from '../../src/font/color/cbdtReader.js';

let failures = 0;
const fail = (msg) => {
  console.error('FAIL:', msg);
  failures++;
};
const ok = (msg) => console.log('ok ' + msg);

class Be {
  constructor() {
    this.bytes = [];
  }
  u8(n) {
    this.bytes.push(n & 0xff);
  }
  u16(n) {
    this.bytes.push((n >> 8) & 0xff, n & 0xff);
  }
  s8(n) {
    this.bytes.push(n & 0xff);
  }
  u32(n) {
    this.bytes.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  }
  raw(arr) {
    for (const b of arr) this.bytes.push(b & 0xff);
  }
  get length() {
    return this.bytes.length;
  }
  toArray() {
    return new Uint8Array(this.bytes);
  }
}

// Same minimal PNG as the sbix smoke — reader passes bytes through.
function tinyPng() {
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0x99, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
    0x00, 0x00, 0x03, 0x00, 0x01, 0x9a, 0x9c, 0x18, 0x00, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
    0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
}

// Build the CBDT side: one bitmap data record per populated gid.
// Returns the byte array plus the per-gid offset table (relative
// to imageDataOffset, which we'll set to 0).
//   record (format 17) = SmallGlyphMetrics(5) + u32 dataLen + PNG.
function buildCbdt(populatedGids /* Map<gid, true> */, png) {
  const b = new Be();
  // CBDT header is just u32 version. Data records pile up after; their
  // offsets come from CBLC's IndexSubTable.
  b.u32(0x00030000); // version 3.0
  // We need to record per-gid offsets RELATIVE to imageDataOffset.
  // imageDataOffset is where the IndexSubTable starts pointing — we
  // set it to the byte right after the version header (offset 4).
  const dataBase = b.length;
  // Each populated gid gets a (5-byte metrics + 4-byte len + png) record.
  // gid → relative-offset-from-dataBase.
  const offMap = new Map();
  for (const gid of populatedGids) {
    offMap.set(gid, b.length - dataBase);
    b.u8(10); // height
    b.u8(10); // width
    b.s8(0); // bearingX
    b.s8(8); // bearingY
    b.u8(12); // advance
    b.u32(png.length);
    b.raw(Array.from(png));
  }
  return { bytes: b.toArray(), offMap, dataBase };
}

// Build the CBLC side. Single strike. IndexSubTable format 1 +
// imageFormat 17 + the offsets table that points into CBDT.
function buildCblc(populatedGids, offMap, ppem) {
  // Sort populated gids and find their min/max.
  const sorted = Array.from(populatedGids).sort((a, b) => a - b);
  const firstGid = sorted[0];
  const lastGid = sorted[sorted.length - 1];
  // Format-1 sub: u32 sbixOffsets[lastGid - firstGid + 2].
  // Slot for an empty gid (not in offMap) gets equal offsets so the
  // reader's len-check returns null.
  const sbixOffs = new Uint32Array(lastGid - firstGid + 2);
  for (let g = firstGid; g <= lastGid; g++) {
    sbixOffs[g - firstGid] = offMap.has(g) ? offMap.get(g) : 0;
  }
  // End sentinel: one byte past the last populated record. Over-estimate
  // via the max populated offset plus a record length.
  let maxOff = 0;
  for (const v of offMap.values()) if (v > maxOff) maxOff = v;
  sbixOffs[lastGid - firstGid + 1] = maxOff + 200;
  // For empty-slot gids: copy the NEXT populated slot's offset
  // so end <= start triggers the null path. Walk in reverse.
  let nextPopulated = sbixOffs[lastGid - firstGid + 1];
  for (let g = lastGid; g >= firstGid; g--) {
    const i = g - firstGid;
    if (!offMap.has(g)) sbixOffs[i] = nextPopulated;
    else nextPopulated = sbixOffs[i];
  }

  // CBLC layout: 8-byte header + 48-byte BitmapSize record
  // + IndexSubTableArray + IndexSubTable bodies.
  const b = new Be();
  b.u32(0x00030000); // version
  b.u32(1); // numSizes
  const sizeRecStart = b.length;
  // 48-byte BitmapSize record. Many fields we leave zero.
  //   u32 indexSubTableArrayOffset (relative to CBLC start)  ← patched
  //   u32 indexTablesSize                                    ← patched
  //   u32 numberOfIndexSubTables                             ← 1
  //   u32 colorRef = 0
  //   sbitLineMetrics horizontal (12 bytes)
  //   sbitLineMetrics vertical   (12 bytes)
  //   u16 startGlyphIndex, u16 endGlyphIndex,
  //   u8  ppemX, ppemY, bitDepth, s8 flags
  for (let i = 0; i < 48; i++) b.u8(0);
  // Patch startGid/endGid/ppem/bitDepth/flags at offsets 40..47.
  const view = new DataView(new Uint8Array(b.bytes).buffer);
  view.setUint16(sizeRecStart + 40, firstGid, false);
  view.setUint16(sizeRecStart + 42, lastGid, false);
  view.setUint8(sizeRecStart + 44, ppem);
  view.setUint8(sizeRecStart + 45, ppem);
  view.setUint8(sizeRecStart + 46, 32); // bitDepth (32 for color)
  b.bytes = Array.from(new Uint8Array(view.buffer));

  // Now the IndexSubTableArray + IndexSubTable bodies.
  const subArrOff = b.length;
  // IndexSubTableArray entry (8 bytes):
  //   firstGlyphIndex u16, lastGlyphIndex u16, additionalOffset u32
  b.u16(firstGid);
  b.u16(lastGid);
  // additionalOffset is from the START of subArrOff (the array).
  // We place the IndexSubTable body right after the 8-byte entry.
  b.u32(8);
  // IndexSubTable body — format 1 header (8 bytes):
  //   u16 indexFormat = 1
  //   u16 imageFormat = 17
  //   u32 imageDataOffset (where in CBDT the bitmap data starts)
  b.u16(1);
  b.u16(17);
  b.u32(4); // CBDT data records start at byte 4 (after CBDT version header)
  // Then sbixOffsets[lastGid-firstGid+2].
  for (let i = 0; i < sbixOffs.length; i++) b.u32(sbixOffs[i]);

  const indexTablesEnd = b.length;
  // Patch the BitmapSize record's indexSubTableArrayOffset and
  // indexTablesSize.
  const view2 = new DataView(new Uint8Array(b.bytes).buffer);
  view2.setUint32(sizeRecStart + 0, subArrOff, false);
  view2.setUint32(sizeRecStart + 4, indexTablesEnd - subArrOff, false);
  view2.setUint32(sizeRecStart + 8, 1, false);
  b.bytes = Array.from(new Uint8Array(view2.buffer));

  return b.toArray();
}

function tablesWith(cblc, cbdt, numGlyphs) {
  // Concatenate the two so we have one byte buffer for both.
  const total = cblc.length + cbdt.length;
  const bytes = new Uint8Array(total);
  bytes.set(cblc, 0);
  bytes.set(cbdt, cblc.length);
  return {
    bytes,
    view: new DataView(bytes.buffer),
    cblc: [0, cblc.length],
    cbdt: [cblc.length, cbdt.length],
    numGlyphs,
  };
}

// ----- Tests --------------------------------------------------------

const png = tinyPng();

// T1: header + capability bits.
{
  const populated = new Set([1, 2, 3]);
  const { bytes: cbdt, offMap } = buildCbdt(populated, png);
  const cblc = buildCblc(populated, offMap, 32);
  const r = new CbdtReader(tablesWith(cblc, cbdt, 4));
  if (!r.hasBitmaps) fail('T1 hasBitmaps false');
  else if (r.numStrikes !== 1) fail(`T1 numStrikes=${r.numStrikes}`);
  else ok(`T1 CBLC v3.0, ${r.numStrikes} strike`);
}

// T2: gid 1 fetches PNG + metrics.
{
  const populated = new Set([1, 2, 3]);
  const { bytes: cbdt, offMap } = buildCbdt(populated, png);
  const cblc = buildCblc(populated, offMap, 32);
  const r = new CbdtReader(tablesWith(cblc, cbdt, 4));
  const g = r.getBitmapGlyph(1, 0);
  if (!g) fail('T2 gid 1 missing');
  else if (g.height !== 10 || g.width !== 10) fail(`T2 metrics ${g.width}x${g.height}`);
  else if (g.bearingY !== 8) fail(`T2 bearingY=${g.bearingY}`);
  else if (g.advance !== 12) fail(`T2 advance=${g.advance}`);
  else if (g.strikePpem !== 32) fail(`T2 ppem=${g.strikePpem}`);
  else if (g.pngBytes.length !== png.length)
    fail(`T2 png len ${g.pngBytes.length} vs ${png.length}`);
  else
    ok(
      `T2 gid 1: ${g.width}x${g.height} px, bearing (${g.bearingX},${g.bearingY}), advance ${g.advance}, ${g.pngBytes.length}-byte PNG`,
    );
}

// T3: gid not in range → null.
{
  const populated = new Set([1, 2, 3]);
  const { bytes: cbdt, offMap } = buildCbdt(populated, png);
  const cblc = buildCblc(populated, offMap, 32);
  const r = new CbdtReader(tablesWith(cblc, cbdt, 4));
  if (r.getBitmapGlyph(0, 0) !== null) fail('T3 gid 0 should be null');
  else if (r.getBitmapGlyph(4, 0) !== null) fail('T3 gid 4 should be null');
  else ok('T3 out-of-range gids return null');
}

// T4: gid in range BUT with no data (empty slot sentinel).
{
  const populated = new Set([1, 3]);
  const { bytes: cbdt, offMap } = buildCbdt(populated, png);
  const cblc = buildCblc(populated, offMap, 32);
  const r = new CbdtReader(tablesWith(cblc, cbdt, 4));
  // gid 2 is in [1, 3] but not populated → empty slot.
  if (r.getBitmapGlyph(2, 0) !== null) fail('T4 gid 2 (empty slot) should be null');
  else if (!r.getBitmapGlyph(1, 0)) fail('T4 gid 1 (populated) should return glyph');
  else ok('T4 empty slot in dense range returns null; populated returns glyph');
}

// T5: missing tables → hasBitmaps false.
{
  const r = new CbdtReader({ view: null });
  if (r.hasBitmaps) fail('T5 hasBitmaps true on empty');
  else if (r.getBitmapGlyph(0, 0) !== null) fail('T5 lookup non-null');
  else ok('T5 no CBDT/CBLC: hasBitmaps false');
}

// T6: pickStrikeForPpem with a single strike.
{
  const populated = new Set([1]);
  const { bytes: cbdt, offMap } = buildCbdt(populated, png);
  const cblc = buildCblc(populated, offMap, 32);
  const r = new CbdtReader(tablesWith(cblc, cbdt, 2));
  if (r.pickStrikeForPpem(16) !== 0) fail('T6 single strike should always be picked');
  else if (r.pickStrikeForPpem(64) !== 0)
    fail('T6 single strike picked even when smaller than target');
  else ok('T6 single-strike pickStrikeForPpem returns 0 in all cases');
}

console.log();
console.log(failures === 0 ? 'CBDT-READER PASS' : `CBDT-READER FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
