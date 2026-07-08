// Minimal sfnt with an OpenType 'SVG ' table so SVG-in-OT tests need
// no external color-font binary.
//
// Tables: head, hhea, hmtx, maxp, cmap, loca, glyf, post, SVG.
// gid 1 carries a circle-shaped SVG document. The cmap maps a chosen
// codepoint (default 'A') to gid 1.

const TAG = (s) => (s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3);

class Be {
  constructor() { this.bytes = []; }
  u8(n)  { this.bytes.push(n & 0xff); }
  u16(n) { this.bytes.push((n >> 8) & 0xff, n & 0xff); }
  s16(n) { this.u16(n & 0xffff); }
  u32(n) { this.bytes.push((n >>> 24) & 0xff, (n >>> 16) & 0xff,
                           (n >>>  8) & 0xff,  n         & 0xff); }
  fixed(major, minor) { this.u16(major); this.u16(minor); }
  longDateTime() { this.u32(0); this.u32(0); }
  raw(arr) { for (const b of arr) this.bytes.push(b & 0xff); }
  pad4()   { while (this.bytes.length & 3) this.bytes.push(0); }
  get length() { return this.bytes.length; }
  toUint8() { return new Uint8Array(this.bytes); }
}

function buildHead(unitsPerEm) {
  const b = new Be();
  b.fixed(1, 0); b.fixed(1, 0); b.u32(0); b.u32(0x5F0F3CF5);
  b.u16(0); b.u16(unitsPerEm); b.longDateTime(); b.longDateTime();
  b.s16(0); b.s16(-200); b.s16(unitsPerEm); b.s16(unitsPerEm);
  b.u16(0); b.u16(8); b.s16(2); b.s16(0); b.s16(0);
  return b.toUint8();
}
function buildHhea(unitsPerEm, numHMetrics) {
  const b = new Be();
  b.fixed(1, 0); b.s16(unitsPerEm); b.s16(-200); b.s16(0);
  b.u16(unitsPerEm); b.s16(0); b.s16(0); b.s16(unitsPerEm);
  b.s16(1); b.s16(0); b.s16(0); b.s16(0); b.s16(0); b.s16(0); b.s16(0); b.s16(0);
  b.u16(numHMetrics);
  return b.toUint8();
}
function buildHmtx(adv, lsb) {
  const b = new Be();
  for (let i = 0; i < adv.length; i++) { b.u16(adv[i]); b.s16(lsb[i] || 0); }
  return b.toUint8();
}
function buildMaxp(n) {
  const b = new Be();
  b.fixed(1, 0); b.u16(n);
  for (let i = 0; i < 13; i++) b.u16(0);
  return b.toUint8();
}
function buildCmap(codepoint) {
  const sub = new Be();
  const length = 16 + 8 * 2;
  sub.u16(4); sub.u16(length); sub.u16(0); sub.u16(4); sub.u16(4); sub.u16(1); sub.u16(0);
  sub.u16(codepoint); sub.u16(0xFFFF);
  sub.u16(0);
  sub.u16(codepoint); sub.u16(0xFFFF);
  sub.s16((1 - codepoint) & 0xffff); sub.s16(1);
  sub.u16(0); sub.u16(0);
  const b = new Be();
  b.u16(0); b.u16(1); b.u16(3); b.u16(1); b.u32(12);
  b.raw(Array.from(sub.toUint8()));
  return b.toUint8();
}
function buildGlyfAndLoca() {
  // gid 0 + gid 1 are empty outlines (the SVG table carries the visuals).
  const offs = [0, 0];
  const glyf = new Uint8Array(0);
  const loca = new Be();
  for (const o of offs) loca.u16(o >> 1);
  return { glyf, loca: loca.toUint8() };
}
function buildPost() {
  const b = new Be();
  b.fixed(3, 0); b.u32(0); b.s16(-100); b.s16(50); b.u32(1);
  b.u32(0); b.u32(0); b.u32(0); b.u32(0);
  return b.toUint8();
}

// 'SVG ' table v0 with ONE doc record: gid 1 only. The doc is a single
// red circle, rendered through the SVG importer. Coordinates are in
// font design units with +Y up per spec, so the path uses positive Y
// for the "top" of the glyph.
function buildSvgTable(svgText) {
  const docBytes = new TextEncoder().encode(svgText);
  const b = new Be();
  b.u16(0);                  // version
  const listOffPos = b.length;
  b.u32(0);                  // svgDocumentListOffset
  b.u32(0);                  // reserved
  const listStart = b.length;
  b.u16(1);                  // numEntries
  const recStart = b.length;
  b.u16(1); b.u16(1);        // startGid, endGid
  b.u32(0);                  // docOff (patched)
  b.u32(docBytes.byteLength);
  const docOff = b.length - listStart;
  b.raw(Array.from(docBytes));
  const bytes = b.toUint8();
  const dv = new DataView(bytes.buffer);
  dv.setUint32(listOffPos, listStart, false);
  dv.setUint32(recStart + 4, docOff, false);
  return bytes;
}

function tableDir(records) {
  const n = records.length;
  const dirSize = 12 + 16 * n;
  let cursor = dirSize;
  const offsets = [];
  for (const r of records) {
    offsets.push(cursor);
    cursor += r.bytes.length;
    while (cursor & 3) cursor++;
  }
  const total = cursor;
  const sorted = records.slice().sort((a, b) => a.tag - b.tag);
  const tagToOffset = new Map();
  for (let i = 0; i < records.length; i++) tagToOffset.set(records[i].tag, offsets[i]);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x00010000, false);
  dv.setUint16(4, n, false);
  let pow = 1, log = 0;
  while ((pow << 1) <= n) { pow <<= 1; log++; }
  dv.setUint16(6, pow * 16, false);
  dv.setUint16(8, log, false);
  dv.setUint16(10, n * 16 - pow * 16, false);
  let dirCursor = 12;
  for (const r of sorted) {
    dv.setUint32(dirCursor + 0, r.tag, false);
    dv.setUint32(dirCursor + 4, 0, false);
    dv.setUint32(dirCursor + 8, tagToOffset.get(r.tag), false);
    dv.setUint32(dirCursor + 12, r.bytes.length, false);
    dirCursor += 16;
  }
  for (let i = 0; i < records.length; i++) out.set(records[i].bytes, offsets[i]);
  return out;
}

/// Returns a Uint8Array containing the synthesized SVG-in-OT sfnt.
/// gid 1 renders the supplied svgText (default = a red circle, 1000em).
export function buildSvgInOtTestFont({
  codepoint = 0x41,
  unitsPerEm = 1000,
  svgText = null,
} = {}) {
  const text = svgText ?? defaultGlyphSvg(unitsPerEm);
  const numGlyphs = 2;
  const advances = [unitsPerEm, unitsPerEm];
  const lsbs     = [0, 0];
  const { glyf, loca } = buildGlyfAndLoca();
  const records = [
    { tag: TAG('head'), bytes: buildHead(unitsPerEm) },
    { tag: TAG('hhea'), bytes: buildHhea(unitsPerEm, numGlyphs) },
    { tag: TAG('hmtx'), bytes: buildHmtx(advances, lsbs) },
    { tag: TAG('maxp'), bytes: buildMaxp(numGlyphs) },
    { tag: TAG('cmap'), bytes: buildCmap(codepoint) },
    { tag: TAG('loca'), bytes: loca },
    { tag: TAG('glyf'), bytes: glyf },
    { tag: TAG('post'), bytes: buildPost() },
    { tag: TAG('SVG '), bytes: buildSvgTable(text) },
  ];
  return tableDir(records);
}

// A circle filled red. Centered in em-space, radius = upem/4.
// Important: SVG-in-OT coords are in font design units with +Y up.
// The importer treats SVG as +Y down, so what we draw at the "top"
// (mathematically +Y up) lands at the bottom of the SVG canvas —
// which is FINE here because the textrun applies scale(sx, -sy) to
// flip Y back into Mantle's +Y down convention.
function defaultGlyphSvg(upem) {
  // Use <path> instead of <circle> so the path parser is exercised.
  const cx = upem / 2, cy = upem / 2, r = upem / 4;
  // Cubic arcs approximating the circle (enough to verify the pipeline).
  const k = 0.5522847498; // unit-circle Bezier handle length
  const h = r * k;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${upem} ${upem}">
    <g id="glyph1">
      <path fill="red" d="M ${cx} ${cy - r}
        C ${cx + h} ${cy - r} ${cx + r} ${cy - h} ${cx + r} ${cy}
        C ${cx + r} ${cy + h} ${cx + h} ${cy + r} ${cx} ${cy + r}
        C ${cx - h} ${cy + r} ${cx - r} ${cy + h} ${cx - r} ${cy}
        C ${cx - r} ${cy - h} ${cx - h} ${cy - r} ${cx} ${cy - r} Z"/>
    </g>
  </svg>`;
}
