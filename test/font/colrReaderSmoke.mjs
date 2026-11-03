// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// colrReaderSmoke.mjs — synthesizes COLR v0 + CPAL v0 bytes from spec
// layout, then verifies ColrReader round-trips them. Exercises the exact
// byte format the OpenType spec documents (no binary-font vendoring).

import { ColrReader } from '../../src/font/color/colrReader.js';

let failures = 0;
const fail = (msg) => {
  console.error('FAIL:', msg);
  failures++;
};
const ok = (msg) => console.log('ok ' + msg);

// ---------------------------------------------------------------------
// Byte-builder helpers — write big-endian (OpenType convention).
// ---------------------------------------------------------------------
class BeBuilder {
  constructor() {
    this.bytes = [];
  }
  u8(n) {
    this.bytes.push(n & 0xff);
  }
  u16(n) {
    this.bytes.push((n >> 8) & 0xff, n & 0xff);
  }
  u32(n) {
    this.bytes.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  }
  get length() {
    return this.bytes.length;
  }
  toBuffer() {
    return new Uint8Array(this.bytes).buffer;
  }
}

// Build a COLR v0 table for a glyph mapping:
//   glyphId 0x40 → [layer(gid=0x50, palIdx=0), layer(gid=0x51, palIdx=1)]
//   glyphId 0x42 → [layer(gid=0x52, palIdx=0xFFFF /*fg*/)]
// (glyphIds chosen non-sequentially so the binary search is real.)
function buildColr() {
  const b = new BeBuilder();
  // Header: version, numBaseGlyphRecords, baseGlyphRecordsOffset,
  // layerRecordsOffset, numLayerRecords.
  const numBase = 2;
  const baseRecordsSize = numBase * 6;
  const numLayers = 3;
  const headerSize = 14;
  b.u16(0); // version
  b.u16(numBase); // numBaseGlyphRecords
  b.u32(headerSize); // baseGlyphRecordsOffset
  b.u32(headerSize + baseRecordsSize); // layerRecordsOffset
  b.u16(numLayers); // numLayerRecords

  // BaseGlyphRecords — MUST be sorted by glyphID for binary search.
  // (glyphId, firstLayerIndex, numLayers)
  b.u16(0x40);
  b.u16(0);
  b.u16(2); // 0x40 → layers [0, 2)
  b.u16(0x42);
  b.u16(2);
  b.u16(1); // 0x42 → layers [2, 3)

  // LayerRecords: (glyphId, paletteIndex)
  b.u16(0x50);
  b.u16(0); // layer 0 — gid 0x50, palette 0
  b.u16(0x51);
  b.u16(1); // layer 1 — gid 0x51, palette 1
  b.u16(0x52);
  b.u16(0xffff); // layer 2 — gid 0x52, fg sentinel

  return b.toBuffer();
}

// Build a CPAL v0 with 2 palette entries:
//   index 0 = RED   (rgba 1, 0, 0, 1)
//   index 1 = BLUE  (rgba 0, 0, 1, 1)
// One palette (palette 0). Records stored BGRA.
function buildCpal() {
  const b = new BeBuilder();
  const numPaletteEntries = 2;
  const numPalettes = 1;
  const numColorRecords = 2;
  const headerSize = 12;
  // colorRecordIndices: u16[numPalettes] = [0]   (size 2)
  const idxArrSize = numPalettes * 2;
  b.u16(0); // version
  b.u16(numPaletteEntries); // numPaletteEntries
  b.u16(numPalettes); // numPalettes
  b.u16(numColorRecords); // numColorRecords
  b.u32(headerSize + idxArrSize); // colorRecordsArrayOffset
  // colorRecordIndices
  b.u16(0); // palette 0 starts at record 0

  // colorRecords (BGRA)
  b.u8(0x00);
  b.u8(0x00);
  b.u8(0xff);
  b.u8(0xff); // BGRA: 00,00,FF,FF → RGBA red
  b.u8(0xff);
  b.u8(0x00);
  b.u8(0x00);
  b.u8(0xff); // BGRA: FF,00,00,FF → RGBA blue

  return b.toBuffer();
}

// Wire up a minimal `tables` object that ColrReader expects.
function buildTablesWith(colrAb, cpalAb) {
  // Place COLR at offset 0, CPAL right after.
  const total = colrAb.byteLength + cpalAb.byteLength;
  const combined = new Uint8Array(total);
  combined.set(new Uint8Array(colrAb), 0);
  combined.set(new Uint8Array(cpalAb), colrAb.byteLength);
  const view = new DataView(combined.buffer);
  return {
    view,
    colr: [0, colrAb.byteLength],
    cpal: [colrAb.byteLength, cpalAb.byteLength],
  };
}

// ----- Tests --------------------------------------------------------

// T1: v0 reader picks up both base glyphs + their layers.
{
  const tables = buildTablesWith(buildColr(), buildCpal());
  const r = new ColrReader(tables);
  if (!r.hasColor) fail('T1 hasColor false');
  else if (r.version !== 0) fail(`T1 version=${r.version}`);
  else if (r.numBaseGlyphs !== 2) fail(`T1 numBaseGlyphs=${r.numBaseGlyphs}`);
  else if (r.numPaletteEntries !== 2) fail(`T1 numPaletteEntries=${r.numPaletteEntries}`);
  else
    ok(
      `T1 reader bootstrap: v${r.version}, ${r.numBaseGlyphs} base, ${r.numPaletteEntries} palette`,
    );
}

// T2: lookup hits — glyph 0x40 → 2 layers with the right palette idxs.
{
  const r = new ColrReader(buildTablesWith(buildColr(), buildCpal()));
  const layers = r.getLayers(0x40);
  if (!layers) fail('T2 layers null');
  else if (layers.length !== 2) fail(`T2 expected 2 layers, got ${layers.length}`);
  else if (layers[0].glyphId !== 0x50) fail(`T2 layer0.gid=${layers[0].glyphId}`);
  else if (layers[0].paletteIndex !== 0) fail(`T2 layer0.pal=${layers[0].paletteIndex}`);
  else if (layers[1].glyphId !== 0x51) fail(`T2 layer1.gid=${layers[1].glyphId}`);
  else if (layers[1].paletteIndex !== 1) fail(`T2 layer1.pal=${layers[1].paletteIndex}`);
  else ok(`T2 0x40 → layers (gid 0x50, pal 0) + (gid 0x51, pal 1)`);
}

// T3: CPAL → RGBA conversion (BGRA storage → RGBA returned).
{
  const r = new ColrReader(buildTablesWith(buildColr(), buildCpal()));
  const layers = r.getLayers(0x40);
  const [r0, g0, b0, a0] = layers[0].rgba;
  const [r1, g1, b1, a1] = layers[1].rgba;
  // Palette 0 = red = [1, 0, 0, 1]
  if (
    Math.abs(r0 - 1) > 1e-3 ||
    Math.abs(g0) > 1e-3 ||
    Math.abs(b0) > 1e-3 ||
    Math.abs(a0 - 1) > 1e-3
  )
    fail(`T3 palette 0 ${[r0, g0, b0, a0]} expected red`);
  // Palette 1 = blue = [0, 0, 1, 1]
  else if (
    Math.abs(r1) > 1e-3 ||
    Math.abs(g1) > 1e-3 ||
    Math.abs(b1 - 1) > 1e-3 ||
    Math.abs(a1 - 1) > 1e-3
  )
    fail(`T3 palette 1 ${[r1, g1, b1, a1]} expected blue`);
  else ok(`T3 BGRA → RGBA decode: pal0=(${r0},${g0},${b0},${a0}) pal1=(${r1},${g1},${b1},${a1})`);
}

// T4: paletteIndex 0xFFFF → rgba is null (foreground sentinel).
{
  const r = new ColrReader(buildTablesWith(buildColr(), buildCpal()));
  const layers = r.getLayers(0x42);
  if (!layers || layers.length !== 1) fail(`T4 expected 1 layer, got ${layers && layers.length}`);
  else if (layers[0].paletteIndex !== 0xffff) fail(`T4 paletteIndex=${layers[0].paletteIndex}`);
  else if (layers[0].rgba !== null)
    fail(`T4 rgba=${layers[0].rgba} (expected null for fg sentinel)`);
  else ok(`T4 0x42 → layer(gid=0x52, FG sentinel) — rgba null`);
}

// T5: lookup miss returns null without throwing.
{
  const r = new ColrReader(buildTablesWith(buildColr(), buildCpal()));
  const layers = r.getLayers(0x41); // not in our COLR
  if (layers !== null) fail(`T5 expected null miss, got ${layers}`);
  else ok(`T5 miss: gid 0x41 not in COLR → null`);
}

// T6: empty tables → hasColor false, getLayers null.
{
  const r = new ColrReader({ view: null });
  if (r.hasColor) fail('T6 hasColor true on empty tables');
  else if (r.getLayers(0) !== null) fail(`T6 getLayers not null`);
  else ok('T6 empty tables: hasColor false, getLayers null');
}

// T7: COLRv1 → reader returns hasColor=false (we punt to v0-only).
{
  // Synthesize a COLR header with version=1; numBase doesn't matter
  // because the reader bails on version.
  const b = new BeBuilder();
  b.u16(1);
  b.u16(0);
  b.u32(0);
  b.u32(0);
  b.u16(0);
  const colrAb = b.toBuffer();
  const tables = buildTablesWith(colrAb, buildCpal());
  const r = new ColrReader(tables);
  if (r.hasColor) fail('T7 v1 COLR was wrongly accepted');
  else if (r.version !== 1) fail(`T7 expected version=1, got ${r.version}`);
  else ok('T7 COLR v1 → punted (version reported, hasColor false)');
}

console.log();
console.log(failures === 0 ? 'COLR-READER PASS' : `COLR-READER FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
