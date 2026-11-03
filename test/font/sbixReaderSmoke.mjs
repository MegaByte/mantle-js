// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// sbixReaderSmoke.mjs — Apple bitmap-glyph table reader. Synthesizes
// a minimal sbix table from spec layout, no binary-font vendoring.

import { SbixReader } from '../../src/font/color/sbixReader.js';

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
  s16(n) {
    this.u16(n & 0xffff);
  }
  u32(n) {
    this.bytes.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  }
  raw(arr) {
    for (const b of arr) this.bytes.push(b & 0xff);
  }
  align4() {
    while (this.bytes.length & 3) this.bytes.push(0);
  }
  get length() {
    return this.bytes.length;
  }
  toArrayBuffer() {
    return new Uint8Array(this.bytes).buffer;
  }
}

// A minimal valid 1×1 RGBA PNG (67 bytes). Constants from RFC 2083.
// Pixel content here doesn't matter — the reader passes raw bytes
// through verbatim; we just need a byte-distinguishable payload.
function tinyPng() {
  // PNG signature + IHDR + IDAT + IEND, hand-crafted.
  return new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a, // signature
    0x00,
    0x00,
    0x00,
    0x0d, // IHDR length 13
    0x49,
    0x48,
    0x44,
    0x52, // 'IHDR'
    0x00,
    0x00,
    0x00,
    0x01,
    0x00,
    0x00,
    0x00,
    0x01, // 1x1
    0x08,
    0x02,
    0x00,
    0x00,
    0x00, // 8bpp RGB, default filters
    0x90,
    0x77,
    0x53,
    0xde, // CRC (precomputed)
    0x00,
    0x00,
    0x00,
    0x0c, // IDAT length 12
    0x49,
    0x44,
    0x41,
    0x54, // 'IDAT'
    0x08,
    0x99,
    0x63,
    0xf8,
    0xcf,
    0xc0,
    0x00,
    0x00,
    0x00,
    0x03,
    0x00,
    0x01,
    0x9a,
    0x9c,
    0x18,
    0x00, // CRC (placeholder)
    0x00,
    0x00,
    0x00,
    0x00, // IEND length 0
    0x49,
    0x45,
    0x4e,
    0x44, // 'IEND'
    0xae,
    0x42,
    0x60,
    0x82, // CRC
  ]);
}

// Build an sbix table:
//   • two strikes (ppem 20 and 32),
//   • numGlyphs = 4 (gids 0..3).
//   • Strike 20: gids 1,2 have bitmaps. gid 0,3 empty.
//   • Strike 32: only gid 1 has a bitmap.
function buildSbix(numGlyphs = 4) {
  const png = tinyPng();
  const headerBytes = 8; // version + flags + numStrikes
  const offTableBytes = 4 * 2; // 2 strikes × u32

  // Build each strike's body:
  //   header(4) = ppem, ppi
  //   glyphOffsets[numGlyphs + 1]
  //   per-glyph: 8-byte header + png bytes when present
  function buildStrike(ppem, ppi, populatedGids) {
    const s = new Be();
    s.u16(ppem);
    s.u16(ppi);
    // Reserve glyphOffsets table; we'll patch in offsets after we
    // know each glyph's position.
    const glyphOffTableStart = s.length;
    for (let g = 0; g <= numGlyphs; g++) s.u32(0);
    const dataStart = s.length;

    const offs = new Uint32Array(numGlyphs + 1);
    let cursor = dataStart - 4; // glyph offsets are relative to strike start? No: they're relative to strike start. Adjust.
    // Per spec: glyphOffsets[i] is offset of glyph i's data FROM the
    // START of the strike. End sentinel at index numGlyphs.
    offs[0] = dataStart;
    for (let g = 0; g < numGlyphs; g++) {
      if (populatedGids.has(g)) {
        // 8-byte header + PNG
        s.s16(2); // originX
        s.s16(3); // originY
        s.u32(0x706e6720); // 'png '
        s.raw(Array.from(png));
        offs[g + 1] = s.length;
      } else {
        // Empty glyph — same offset as before.
        offs[g + 1] = offs[g];
      }
    }
    // Patch offsets into the table.
    const view = new DataView(new Uint8Array(s.bytes).buffer);
    for (let g = 0; g <= numGlyphs; g++) {
      view.setUint32(glyphOffTableStart + g * 4, offs[g], false);
    }
    s.bytes = Array.from(new Uint8Array(view.buffer));
    return s.toArrayBuffer();
  }

  const strikeA = buildStrike(20, 72, new Set([1, 2]));
  const strikeB = buildStrike(32, 144, new Set([1]));

  // Compose full sbix table.
  const t = new Be();
  t.u16(1); // version
  t.u16(0); // flags
  t.u32(2); // numStrikes
  // Strike offset table — placeholders, patched after we know.
  const offTableStart = t.length;
  t.u32(0);
  t.u32(0);
  // Strike A
  while (t.length & 3) t.u8(0);
  const strikeAOff = t.length;
  t.raw(Array.from(new Uint8Array(strikeA)));
  // Strike B
  while (t.length & 3) t.u8(0);
  const strikeBOff = t.length;
  t.raw(Array.from(new Uint8Array(strikeB)));
  // Patch strike offsets in.
  const view = new DataView(new Uint8Array(t.bytes).buffer);
  view.setUint32(offTableStart + 0, strikeAOff, false);
  view.setUint32(offTableStart + 4, strikeBOff, false);
  t.bytes = Array.from(new Uint8Array(view.buffer));
  return t.toArrayBuffer();
}

function tablesWith(sbixAb, numGlyphs) {
  const bytes = new Uint8Array(sbixAb);
  return {
    bytes,
    view: new DataView(bytes.buffer),
    sbix: [0, bytes.byteLength],
    numGlyphs,
  };
}

// ----- Tests --------------------------------------------------------

// T1: header bootstraps; numStrikes correct.
{
  const r = new SbixReader(tablesWith(buildSbix(), 4));
  if (!r.hasBitmaps) fail('T1 hasBitmaps false');
  else if (r.numStrikes !== 2) fail(`T1 numStrikes=${r.numStrikes}`);
  else ok(`T1 sbix v1, ${r.numStrikes} strikes`);
}

// T2: gid 1 has a bitmap in strike 0 (ppem 20).
{
  const r = new SbixReader(tablesWith(buildSbix(), 4));
  const g = r.getBitmapGlyph(1, 0);
  if (!g) fail('T2 gid 1 strike 0 missing');
  else if (!g.isPng) fail(`T2 not PNG (graphicType=${g.graphicType.toString(16)})`);
  else if (g.originX !== 2 || g.originY !== 3) fail(`T2 origin (${g.originX},${g.originY})`);
  else if (g.strikePpem !== 20) fail(`T2 ppem=${g.strikePpem}`);
  else if (g.pngBytes.length < 8) fail(`T2 png too short (${g.pngBytes.length})`);
  else
    ok(
      `T2 gid 1 strike 0: ppem=${g.strikePpem}, origin=(${g.originX},${g.originY}), ${g.pngBytes.length}-byte PNG`,
    );
}

// T3: gid 0 + 3 have no bitmap in strike 0 (empty slot).
{
  const r = new SbixReader(tablesWith(buildSbix(), 4));
  if (r.getBitmapGlyph(0, 0) !== null) fail('T3 gid 0 should be empty');
  else if (r.getBitmapGlyph(3, 0) !== null) fail('T3 gid 3 should be empty');
  else ok('T3 empty glyph slots return null');
}

// T4: strike 1 (ppem 32) only has gid 1.
{
  const r = new SbixReader(tablesWith(buildSbix(), 4));
  if (!r.getBitmapGlyph(1, 1)) fail('T4 gid 1 missing in strike 1');
  else if (r.getBitmapGlyph(2, 1) !== null) fail('T4 gid 2 should be empty in strike 1');
  else ok('T4 strike-1 selectivity: gid 1 has bitmap, gid 2 does not');
}

// T5: pickStrikeForPpem picks the smallest >= target, else largest.
{
  const r = new SbixReader(tablesWith(buildSbix(), 4));
  // Strikes at ppem 20 and 32.
  const lowTarget = r.pickStrikeForPpem(16); // both >= 16 → pick smaller = 20
  const midTarget = r.pickStrikeForPpem(25); // 32 >= 25; 20 < 25 → pick 32
  const highTarget = r.pickStrikeForPpem(40); // both < 40 → fallback largest = 32
  // Strike order isn't guaranteed; check via ppem
  const sLow = r.getBitmapGlyph(1, lowTarget).strikePpem;
  const sMid = r.getBitmapGlyph(1, midTarget).strikePpem;
  const sHigh = r.getBitmapGlyph(1, highTarget).strikePpem;
  if (sLow !== 20) fail(`T5 target 16 → ppem ${sLow} (expected 20)`);
  else if (sMid !== 32) fail(`T5 target 25 → ppem ${sMid} (expected 32)`);
  else if (sHigh !== 32) fail(`T5 target 40 → ppem ${sHigh} (expected 32 — largest fallback)`);
  else ok(`T5 strike selection: t=16→20, t=25→32, t=40→32`);
}

// T6: missing table → hasBitmaps false, lookups null.
{
  const r = new SbixReader({ view: null });
  if (r.hasBitmaps) fail('T6 hasBitmaps true on empty');
  else if (r.getBitmapGlyph(0, 0) !== null) fail('T6 lookup returned non-null');
  else ok('T6 no sbix table: hasBitmaps false, lookups null');
}

console.log();
console.log(failures === 0 ? 'SBIX-READER PASS' : `SBIX-READER FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
