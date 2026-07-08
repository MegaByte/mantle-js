// svgInOtReaderSmoke.mjs — SVG-in-OT ('SVG ' table) reader.
// Synthesizes the table inline; no binary-font vendoring.

import { SvgInOtReader, liftGlyphSubElement, isGzipped } from '../../src/font/color/svgInOtReader.js';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
if (typeof globalThis.DOMParser === 'undefined') globalThis.DOMParser = DOMParser;
if (typeof globalThis.XMLSerializer === 'undefined') globalThis.XMLSerializer = XMLSerializer;

let failures = 0;
const fail = (msg) => { console.error('FAIL:', msg); failures++; };
const ok   = (msg) => console.log('ok ' + msg);

class Be {
  constructor() { this.bytes = []; }
  u8(n)  { this.bytes.push(n & 0xff); }
  u16(n) { this.bytes.push((n >> 8) & 0xff, n & 0xff); }
  u32(n) {
    this.bytes.push((n >>> 24) & 0xff, (n >>> 16) & 0xff,
                    (n >>>  8) & 0xff,  n         & 0xff);
  }
  raw(arr) { for (const b of arr) this.bytes.push(b & 0xff); }
  get length() { return this.bytes.length; }
}

// Build an SVG table v0 with:
//   • 2 doc records:
//      gid 1..1  → svg doc A
//      gid 5..7  → svg doc B (covers gids 5, 6, 7)
function buildSvg() {
  // SVG bytes (just any payload — reader passes through verbatim).
  const docA = new TextEncoder().encode('<svg/>A');
  const docB = new TextEncoder().encode('<svg><g id="glyph5"/><g id="glyph6"/><g id="glyph7"/></svg>');

  const b = new Be();
  // Header
  b.u16(0);            // version
  // Reserve offsets — patch later.
  const listOffPos = b.length;
  b.u32(0);            // svgDocumentListOffset
  b.u32(0);            // reserved
  // Document list starts here.
  const listStart = b.length;
  b.u16(2);            // numEntries
  // Record A
  const recAStart = b.length;
  b.u16(1); b.u16(1);  // start, end gid
  b.u32(0);            // docOff (patched)
  b.u32(docA.byteLength);
  // Record B
  const recBStart = b.length;
  b.u16(5); b.u16(7);
  b.u32(0);
  b.u32(docB.byteLength);
  // Doc A bytes
  const docAOff = b.length - listStart;
  b.raw(Array.from(docA));
  // Doc B bytes
  const docBOff = b.length - listStart;
  b.raw(Array.from(docB));

  const bytes = new Uint8Array(b.bytes);
  const view = new DataView(bytes.buffer);
  // Patch header offset.
  view.setUint32(listOffPos, listStart, false);
  // Patch record offsets (relative to listStart).
  view.setUint32(recAStart + 4, docAOff, false);
  view.setUint32(recBStart + 4, docBOff, false);
  return bytes;
}

function tablesWith(svgBytes) {
  return {
    bytes: svgBytes,
    view: new DataView(svgBytes.buffer),
    svg: [0, svgBytes.byteLength],
  };
}

// ----- Tests --------------------------------------------------------

// T1: header + capability.
{
  const r = new SvgInOtReader(tablesWith(buildSvg()));
  if (!r.hasSvg) fail('T1 hasSvg false');
  else if (r.numEntries !== 2) fail(`T1 numEntries=${r.numEntries}`);
  else ok(`T1 SVG table v0, ${r.numEntries} records`);
}

// T2: gid 1 → doc A.
{
  const r = new SvgInOtReader(tablesWith(buildSvg()));
  const g = r.getGlyph(1);
  if (!g) fail('T2 gid 1 returned null');
  else if (g.startGid !== 1 || g.endGid !== 1) fail(`T2 range ${g.startGid}..${g.endGid}`);
  else if (g.isGzipped) fail('T2 marked gzipped (should be raw)');
  else if (g.subElementId !== 'glyph1') fail(`T2 subElementId=${g.subElementId}`);
  else {
    const text = new TextDecoder().decode(g.svgBytes);
    if (text !== '<svg/>A') fail(`T2 doc payload "${text}"`);
    else ok(`T2 gid 1 → doc A: ${g.svgBytes.length} bytes, subId=${g.subElementId}`);
  }
}

// T3: gid 6 → doc B with subElementId glyph6.
{
  const r = new SvgInOtReader(tablesWith(buildSvg()));
  const g = r.getGlyph(6);
  if (!g) fail('T3 gid 6 null');
  else if (g.startGid !== 5 || g.endGid !== 7) fail(`T3 range ${g.startGid}..${g.endGid}`);
  else if (g.subElementId !== 'glyph6') fail(`T3 subElementId=${g.subElementId}`);
  else {
    const text = new TextDecoder().decode(g.svgBytes);
    if (!text.includes('glyph6')) fail(`T3 doc missing glyph6 element`);
    else ok(`T3 gid 6 → doc B subId glyph6 (shared range 5..7)`);
  }
}

// T4: gid 5 and gid 7 also resolve through doc B (same range).
{
  const r = new SvgInOtReader(tablesWith(buildSvg()));
  const g5 = r.getGlyph(5);
  const g7 = r.getGlyph(7);
  if (!g5 || g5.subElementId !== 'glyph5') fail(`T4 gid 5 subId=${g5?.subElementId}`);
  else if (!g7 || g7.subElementId !== 'glyph7') fail(`T4 gid 7 subId=${g7?.subElementId}`);
  else ok(`T4 shared-document range: 5/7 resolve to same bytes via subId`);
}

// T5: out-of-range gids return null.
{
  const r = new SvgInOtReader(tablesWith(buildSvg()));
  if (r.getGlyph(0) !== null) fail('T5 gid 0 not null');
  else if (r.getGlyph(2) !== null) fail('T5 gid 2 (gap) not null');
  else if (r.getGlyph(4) !== null) fail('T5 gid 4 (gap) not null');
  else if (r.getGlyph(8) !== null) fail('T5 gid 8 (past end) not null');
  else ok('T5 unmapped gids return null');
}

// T6: empty tables → hasSvg false.
{
  const r = new SvgInOtReader({ view: null });
  if (r.hasSvg) fail('T6 hasSvg true on empty');
  else if (r.getGlyph(0) !== null) fail('T6 lookup non-null');
  else ok('T6 no SVG table: hasSvg false');
}

// T7: gzip flag — synthesize a record whose bytes start with 1F 8B.
{
  const b = new Be();
  b.u16(0);
  const listOffPos = b.length; b.u32(0); b.u32(0);
  const listStart = b.length;
  b.u16(1);
  const recAStart = b.length;
  b.u16(1); b.u16(1);
  b.u32(0);
  b.u32(8);  // 8 bytes
  // Gzipped doc
  const gzPayload = new Uint8Array([0x1F, 0x8B, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const docOff = b.length - listStart;
  b.raw(Array.from(gzPayload));
  const bytes = new Uint8Array(b.bytes);
  const view = new DataView(bytes.buffer);
  view.setUint32(listOffPos, listStart, false);
  view.setUint32(recAStart + 4, docOff, false);
  const r = new SvgInOtReader({ bytes, view: new DataView(bytes.buffer), svg: [0, bytes.byteLength] });
  const g = r.getGlyph(1);
  if (!g) fail('T7 gid 1 null');
  else if (!g.isGzipped) fail('T7 isGzipped false on gzipped payload');
  else ok(`T7 gzip-magic detected (1F 8B): isGzipped=true`);
}

// T8: liftGlyphSubElement — sibling glyphs hidden, target untouched.
{
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">
    <defs><linearGradient id="g1"/></defs>
    <g id="glyph5"><path id="p5" d="M0 0 L1 0"/></g>
    <g id="glyph6"><path id="p6" d="M0 0 L1 0"/></g>
    <g id="glyph7"><path id="p7" d="M0 0 L1 0"/></g>
  </svg>`;
  const lifted = liftGlyphSubElement(svg, 'glyph6');
  // glyph5 and glyph7 must be display="none"; glyph6 must not be.
  if (!/<g id="glyph5"[^>]*display="none"/.test(lifted))
    fail(`T8 glyph5 not hidden:\n${lifted}`);
  else if (!/<g id="glyph7"[^>]*display="none"/.test(lifted))
    fail(`T8 glyph7 not hidden:\n${lifted}`);
  else if (/<g id="glyph6"[^>]*display="none"/.test(lifted))
    fail(`T8 glyph6 wrongly hidden:\n${lifted}`);
  else if (!lifted.includes('linearGradient'))
    fail(`T8 defs lost:\n${lifted}`);
  else ok('T8 liftGlyphSubElement hides siblings, keeps defs');
}

// T9: liftGlyphSubElement with single-glyph doc — passthrough.
{
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000">
    <g id="glyph1"><path d="M0 0 L1 0"/></g>
  </svg>`;
  const lifted = liftGlyphSubElement(svg, 'glyph1');
  if (/display="none"/.test(lifted))
    fail(`T9 single-glyph doc shouldn't get hidden:\n${lifted}`);
  else ok('T9 single-glyph doc passes through unmangled');
}

// T10: liftGlyphSubElement with null id — passthrough verbatim.
{
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><g id="glyph1"/></svg>';
  if (liftGlyphSubElement(svg, null) !== svg)
    fail('T10 null id should return svgText unchanged');
  else if (liftGlyphSubElement(svg, '') !== svg)
    fail('T10 empty id should return svgText unchanged');
  else ok('T10 null/empty id returns passthrough');
}

// T11: isGzipped — 1F 8B header detected.
{
  if (!isGzipped(new Uint8Array([0x1F, 0x8B, 0x00]))) fail('T11 gzip header missed');
  else if (isGzipped(new Uint8Array([0x3C, 0x73]))) fail('T11 ascii false-positive');
  else if (isGzipped(new Uint8Array([0x1F]))) fail('T11 1-byte should be false');
  else if (isGzipped(null)) fail('T11 null should be false');
  else ok('T11 isGzipped predicate');
}

console.log();
console.log(failures === 0 ? 'SVG-IN-OT PASS' : `SVG-IN-OT FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
