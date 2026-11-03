// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// ttfTables.js — TTF/OTF table reader.
//
// All offsets returned by parseTtfTables() are absolute offsets into the
// source Uint8Array; downstream readers (glyphReader.js) read directly
// from the DataView with no per-call allocation.

import { noteMalformedTable } from './fontTableGuard.js';

const WOFF2_SIG = 0x774f4632; // 'wOF2'
const WOFF1_SIG = 0x774f4646; // 'wOFF'
const TAG_OTTO = 0x4f54544f;
const TAG_TRUE = 0x74727565;
const TAG_TYP1 = 0x74797031;
const SFNT_TTF = 0x00010000;

const T_cmap = 0x636d6170,
  T_head = 0x68656164,
  T_hhea = 0x68686561;
const T_hmtx = 0x686d7478,
  T_maxp = 0x6d617870,
  T_glyf = 0x676c7966;
const T_loca = 0x6c6f6361,
  T_name = 0x6e616d65,
  T_OS2 = 0x4f532f32;
const T_gpos = 0x47504f53,
  T_gsub = 0x47535542,
  T_kern = 0x6b65726e;
const T_cff = 0x43464620; // 'CFF ' — Adobe outlines
const T_cff2 = 0x43464632; // 'CFF2' — Adobe outlines with variations
const T_post = 0x706f7374; // 'post' — underline metrics live here
const T_COLR = 0x434f4c52; // 'COLR' — color-font layer table
const T_CPAL = 0x4350414c; // 'CPAL' — color-font palette table
const T_sbix = 0x73626978; // 'sbix' — Apple bitmap glyphs
const T_CBDT = 0x43424454; // 'CBDT' — Google bitmap data
const T_CBLC = 0x43424c43; // 'CBLC' — Google bitmap location
const T_EBDT = 0x45424454; // 'EBDT' — monochrome/grayscale bitmap data
const T_EBLC = 0x45424c43; // 'EBLC' — monochrome/grayscale bitmap location
const T_SVG = 0x53564720; // 'SVG ' — Twemoji-style embedded SVG glyphs
// Variable-font tables.
const T_fvar = 0x66766172; // 'fvar' — axis definitions + named instances
const T_gvar = 0x67766172; // 'gvar' — per-glyph variation deltas (TTF)
const T_avar = 0x61766172; // 'avar' — axis value mappings
const T_HVAR = 0x48564152; // 'HVAR' — horizontal advance variations
const T_VVAR = 0x56564152; // 'VVAR' — vertical advance variations
const T_MVAR = 0x4d564152; // 'MVAR' — global font metrics variations
const T_STAT = 0x53544154; // 'STAT' — style attributes (axis names/ranges)
const T_GDEF = 0x47444546; // 'GDEF' — glyph definition (classes + caret + mark sets)
const T_VORG = 0x564f5247; // 'VORG' — vertical glyph origins
const T_BASE = 0x42415345; // 'BASE' — baseline alignment per script
const T_JSTF = 0x4a535446; // 'JSTF' — justification (kashida extenders)
const T_mort = 0x6d6f7274; // 'mort' — AAT legacy glyph metamorphosis
const T_morx = 0x6d6f7278; // 'morx' — AAT extended glyph metamorphosis
const T_kerx = 0x6b657278; // 'kerx' — AAT extended kerning
const T_feat = 0x66656174; // 'feat' — AAT feature-name table
const T_trak = 0x7472616b; // 'trak' — AAT tracking
const T_ankr = 0x616e6b72; // 'ankr' — AAT anchor-point table (kerx fmt4 type1)
const T_MATH = 0x4d415448; // 'MATH' — math typesetting (italic correction, top-accent, kern, constants)
const T_vhea = 0x76686561; // 'vhea' — vertical header
const T_vmtx = 0x766d7478; // 'vmtx' — vertical metrics (advance + topSideBearing per gid)
const TAG_TTC = 0x74746366; // 'ttcf' — TrueType collection wrapper

/**
 * @param {Uint8Array} ttfBytes
 * @param {number} [faceIndex=0]  TTC face to pick; ignored for plain TTF/OTF.
 *   Throws if the index is out of range for the collection's face count.
 * @returns {object} tables descriptor; see properties below
 */
export function parseTtfTables(ttfBytes, faceIndex = 0) {
  if (!ttfBytes || ttfBytes.length < 12) throw new Error('TTF too small');
  const view = new DataView(ttfBytes.buffer, ttfBytes.byteOffset, ttfBytes.byteLength);
  const sig = view.getUint32(0, false);
  if (sig === WOFF1_SIG)
    throw new Error(
      'WOFF 1.0 needs async pre-decoding; call decodeIfWoff2() first (it decodes WOFF 1.0 and woff2)',
    );
  if (sig === WOFF2_SIG) {
    // woff2 decoding is async (DecompressionStream); callers must
    // pre-decode via decodeIfWoff2() from './fontAsset.js' before
    // passing bytes to MantleFontAsset.
    throw new Error('woff2 needs async pre-decoding; call decodeIfWoff2() first');
  }
  // TTC support: open the container, parse face `faceIndex`'s table
  // directory INTO THE ORIGINAL BUFFER (do NOT slice). Per OpenType
  // spec, TTC table offsets are absolute in the file, so a slice
  // would misalign every offset.
  if (sig === TAG_TTC) {
    if (ttfBytes.length < 16) throw new Error('TTC header too short');
    const numFonts = view.getUint32(8, false);
    if (numFonts === 0) throw new Error('TTC has no faces');
    if (faceIndex < 0 || faceIndex >= numFonts)
      throw new Error(`TTC faceIndex ${faceIndex} out of range (collection has ${numFonts} faces)`);
    const offTableOff = 12 + faceIndex * 4;
    if (offTableOff + 4 > ttfBytes.length) throw new Error('TTC face offset table truncated');
    const faceOff = view.getUint32(offTableOff, false);
    if (faceOff + 12 > ttfBytes.length)
      throw new Error(`TTC face ${faceIndex} offset out of bounds`);
    const t = _parseTtfTablesFromHeaderOffset(ttfBytes, view, faceOff);
    t.ttcFaceCount = numFonts;
    t.ttcFaceIndex = faceIndex;
    return t;
  }

  if (sig !== SFNT_TTF && sig !== TAG_OTTO && sig !== TAG_TRUE && sig !== TAG_TYP1)
    throw new Error('Not a TTF/OTF: 0x' + sig.toString(16));

  if (faceIndex !== 0)
    throw new Error(`faceIndex=${faceIndex} but this is a plain TTF/OTF (single face only)`);
  return _parseTtfTablesFromHeaderOffset(ttfBytes, view, 0);
}

/// Inspect a TTC byte buffer's face count WITHOUT parsing any face's
/// table directory. Returns 1 for plain TTF/OTF, or N for a TTC. Throws
/// on unrecognized signatures (mirrors parseTtfTables validation but
/// stops at the header). Useful for callers that want to enumerate
/// faces and pick by name before building MantleFontAsset.
export function ttcFaceCount(ttfBytes) {
  if (!ttfBytes || ttfBytes.length < 12) throw new Error('TTF too small');
  const view = new DataView(ttfBytes.buffer, ttfBytes.byteOffset, ttfBytes.byteLength);
  const sig = view.getUint32(0, false);
  if (sig === TAG_TTC) {
    if (ttfBytes.length < 16) throw new Error('TTC header too short');
    return view.getUint32(8, false);
  }
  if (sig === SFNT_TTF || sig === TAG_OTTO || sig === TAG_TRUE || sig === TAG_TYP1) return 1;
  if (sig === WOFF1_SIG || sig === WOFF2_SIG)
    throw new Error(
      (sig === WOFF1_SIG ? 'WOFF 1.0' : 'woff2') +
        ' face count needs async decode; call decodeIfWoff2() first',
    );
  throw new Error('Not a TTF/OTF/TTC: 0x' + sig.toString(16));
}

/// Parse the sfnt header at `hdrOff` (0 for plain TTF/OTF; face N's
/// offset for a TTC) and build the tables record. Table offsets in
/// the directory are absolute file positions, so the original buffer
/// is used as-is — no slicing needed.
function _parseTtfTablesFromHeaderOffset(ttfBytes, view, hdrOff) {
  const numTables = view.getUint16(hdrOff + 4, false);
  const t = {
    bytes: ttfBytes,
    view,
    cmap: null,
    head: null,
    hhea: null,
    hmtx: null,
    maxp: null,
    glyf: null,
    loca: null,
    name: null,
    os2: null,
    gpos: null,
    gsub: null,
    kern: null,
    cff: null,
    cff2: null,
    post: null,
    colr: null,
    cpal: null,
    sbix: null,
    cbdt: null,
    cblc: null,
    ebdt: null,
    eblc: null,
    svg: null,
    // Variable-font tables.
    fvar: null,
    gvar: null,
    avar: null,
    hvar: null,
    vvar: null,
    mvar: null,
    stat: null,
    gdef: null,
    vorg: null,
    base: null,
    math: null,
    jstf: null,
    mort: null,
    morx: null,
    kerx: null,
    trak: null,
    feat: null,
    ankr: null,
    // Vertical writing.
    vhea: null,
    vmtx: null,
    // populated below:
    unitsPerEm: 0,
    indexToLocFormat: 0,
    ascender: 0,
    descender: 0,
    lineGap: 0,
    // OS/2 typographic metrics (em-units, FUnits). Populated by
    // _decodeOs2; both default to 0 when the table is missing or its
    // version < 2 (sxHeight/sCapHeight were added in OS/2 v2). Callers
    // that need a robust fallback (MantleFontAsset.capHeight/xHeight)
    // measure 'H' / 'x' glyph bbox heights when these are zero.
    os2CapHeight: 0,
    os2xHeight: 0,
    // OS/2 yStrikeoutSize / yStrikeoutPosition (FUnits; position = the TOP of the stroke above the baseline).
    // 0 when the table is missing or too short.
    os2StrikeoutSize: 0,
    os2StrikeoutPosition: 0,
    // OS/2 ySubscriptYOffset (below the baseline) and ySuperscriptYOffset (above it), FUnits.
    os2SubscriptOffset: 0,
    os2SuperscriptOffset: 0,
    numberOfHMetrics: 0,
    numGlyphs: 0,
    postUnderlinePosition: 0,
    postUnderlineThickness: 0,
    // post table italicAngle (degrees). 0 for upright fonts; typical
    // real italics are -12 (lean to the right). Synthetic italic
    // fallback shears glyphs by tan(-this) when no italic face is
    // available on a span requesting `<i>`.
    postItalicAngle: 0,
    _cmapOff: 0,
    _cmapFormat: 0,
  };

  let r = hdrOff + 12;
  for (let i = 0; i < numTables; i++) {
    if (r + 16 > view.byteLength) {
      noteMalformedTable(
        t,
        'sfnt',
        'the table directory runs past the file',
        'read as far as it goes',
      );
      break;
    }
    const tag = view.getUint32(r, false);
    const off = view.getUint32(r + 8, false);
    const len = view.getUint32(r + 12, false);
    r += 16;
    switch (tag) {
      case T_cmap:
        t.cmap = [off, len];
        break;
      case T_head:
        t.head = [off, len];
        break;
      case T_hhea:
        t.hhea = [off, len];
        break;
      case T_hmtx:
        t.hmtx = [off, len];
        break;
      case T_maxp:
        t.maxp = [off, len];
        break;
      case T_glyf:
        t.glyf = [off, len];
        break;
      case T_loca:
        t.loca = [off, len];
        break;
      case T_name:
        t.name = [off, len];
        break;
      case T_OS2:
        t.os2 = [off, len];
        break;
      case T_gpos:
        t.gpos = [off, len];
        break;
      case T_gsub:
        t.gsub = [off, len];
        break;
      case T_kern:
        t.kern = [off, len];
        break;
      case T_cff:
        t.cff = [off, len];
        break;
      case T_cff2:
        t.cff2 = [off, len];
        break;
      case T_post:
        t.post = [off, len];
        break;
      case T_COLR:
        t.colr = [off, len];
        break;
      case T_CPAL:
        t.cpal = [off, len];
        break;
      case T_sbix:
        t.sbix = [off, len];
        break;
      case T_CBDT:
        t.cbdt = [off, len];
        break;
      case T_CBLC:
        t.cblc = [off, len];
        break;
      case T_EBDT:
        t.ebdt = [off, len];
        break;
      case T_EBLC:
        t.eblc = [off, len];
        break;
      case T_SVG:
        t.svg = [off, len];
        break;
      case T_fvar:
        t.fvar = [off, len];
        break;
      case T_gvar:
        t.gvar = [off, len];
        break;
      case T_avar:
        t.avar = [off, len];
        break;
      case T_HVAR:
        t.hvar = [off, len];
        break;
      case T_VVAR:
        t.vvar = [off, len];
        break;
      case T_MVAR:
        t.mvar = [off, len];
        break;
      case T_STAT:
        t.stat = [off, len];
        break;
      case T_GDEF:
        t.gdef = [off, len];
        break;
      case T_VORG:
        t.vorg = [off, len];
        break;
      case T_BASE:
        t.base = [off, len];
        break;
      case T_JSTF:
        t.jstf = [off, len];
        break;
      case T_mort:
        t.mort = [off, len];
        break;
      case T_morx:
        t.morx = [off, len];
        break;
      case T_kerx:
        t.kerx = [off, len];
        break;
      case T_trak:
        t.trak = [off, len];
        break;
      case T_feat:
        t.feat = [off, len];
        break;
      case T_ankr:
        t.ankr = [off, len];
        break;
      case T_MATH:
        t.math = [off, len];
        break;
      case T_vhea:
        t.vhea = [off, len];
        break;
      case T_vmtx:
        t.vmtx = [off, len];
        break;
    }
  }

  _decodeTable(t, 'head', _decodeHead);
  // No readable upem: the default HarfBuzz uses (hb-face.cc), so a font scales to something rather than to nothing.
  if (!t.unitsPerEm) {
    noteMalformedTable(t, 'head', 'no usable unitsPerEm', 'read as 1000 units per em');
    t.unitsPerEm = 1000;
  }
  _decodeTable(t, 'hhea', _decodeHhea);
  // hmtx means nothing without its hhea count: as with no hmtx, glyphs advance half an em.
  if (!t.numberOfHMetrics && t._malformed && t._malformed.has('hhea')) t.hmtx = null;
  _decodeTable(t, 'vhea', _decodeVhea);
  _decodeTable(t, 'maxp', _decodeMaxp);
  _decodeTable(t, 'post', _decodePost);
  _decodeTable(t, 'OS/2', _decodeOs2);
  _decodeTable(t, 'cmap', _selectCmap);

  // These stay in the font when one read fails: a bad entry costs that glyph or code point, not every glyph of the font.
  t.codepointToGlyphIndex = (cp) => _entry(t, 'cmap', _cmapLookup, cp, 0, 0);
  t.hasUvs = t._uvsOff > 0;
  t.resolveVariationGlyph = (baseCp, selectorCp) =>
    _entry(t, 'cmap', _resolveUvs, baseCp, selectorCp, 0);
  t.glyphRange = (gid) => _entry(t, 'loca', _glyphRange, gid, 0, _NO_RANGE);
  t.glyphAdvanceWidth = (gid) => _entry(t, 'hmtx', _glyphAdvance, gid, 0, t.unitsPerEm >> 1);
  t.glyphLeftSideBearing = (gid) => _entry(t, 'hmtx', _glyphLsb, gid, 0, 0);
  t.glyphAdvanceHeight = (gid) => _entry(t, 'vmtx', _glyphVAdvance, gid, 0, t.unitsPerEm);
  t.glyphTopSideBearing = (gid) => _entry(t, 'vmtx', _glyphTsb, gid, 0, 0);

  return t;
}

const _NO_RANGE = Object.freeze([0, 0]);

function _entry(t, tag, read, a, b, fallback) {
  try {
    return read(t, a, b);
  } catch (e) {
    noteMalformedTable(t, tag, e, 'kept, this entry falling back');
    return fallback;
  }
}

/// One table's fixed fields. A table that is absent or runs off the file leaves the defaults `t` was made with.
function _decodeTable(t, tag, decode) {
  try {
    decode(t);
  } catch (e) {
    noteMalformedTable(t, tag, e, 'read as defaults');
  }
}

function _decodeHead(t) {
  if (!t.head) throw new Error("the font has no 'head' table");
  t.unitsPerEm = t.view.getUint16(t.head[0] + 18, false);
  t.indexToLocFormat = t.view.getInt16(t.head[0] + 50, false);
}

function _decodeHhea(t) {
  if (!t.hhea) throw new Error("the font has no 'hhea' table");
  t.ascender = t.view.getInt16(t.hhea[0] + 4, false);
  t.descender = t.view.getInt16(t.hhea[0] + 6, false);
  t.lineGap = t.view.getInt16(t.hhea[0] + 8, false);
  t.numberOfHMetrics = t.view.getUint16(t.hhea[0] + 34, false);
}

/// vhea is optional — only fonts that ship vertical metrics carry it
/// (mostly CJK + ideograph fonts). Layout-defaults are baked in here
/// when absent so callers can always query without null-checking.
function _decodeVhea(t) {
  if (!t.vhea) {
    t.numberOfVMetrics = 0;
    t.vertTypoAscender = 0;
    t.vertTypoDescender = 0;
    t.vertTypoLineGap = 0;
    return;
  }
  // vhea layout (version 1.0/1.1):
  //   Fixed   version         (4)
  //   FWord   vertTypoAscender(2)   — distance from origin to top of glyph (typically +half upem)
  //   FWord   vertTypoDescender(2)  — distance from origin to bottom (negative)
  //   FWord   vertTypoLineGap (2)
  //   ufWord  advanceHeightMax(2)
  //   FWord   minTopSideBearing (2)
  //   FWord   minBottomSideBearing (2)
  //   FWord   yMaxExtent       (2)
  //   ...     reserved
  //   uint16  numOfLongVerMetrics (2) — at offset 34
  t.vertTypoAscender = t.view.getInt16(t.vhea[0] + 4, false);
  t.vertTypoDescender = t.view.getInt16(t.vhea[0] + 6, false);
  t.vertTypoLineGap = t.view.getInt16(t.vhea[0] + 8, false);
  t.numberOfVMetrics = t.view.getUint16(t.vhea[0] + 34, false);
}

function _decodeMaxp(t) {
  if (!t.maxp) throw new Error("the font has no 'maxp' table");
  t.numGlyphs = t.view.getUint16(t.maxp[0] + 4, false);
}

function _decodeOs2(t) {
  // USE_TYPO_METRICS selects OS/2 horizontal line metrics; otherwise retain hhea.
  if (t.os2 && t.os2[1] >= 74 && t.view.getUint16(t.os2[0] + 62, false) & 0x80) {
    t.ascender = t.view.getInt16(t.os2[0] + 68, false);
    t.descender = t.view.getInt16(t.os2[0] + 70, false);
    t.lineGap = t.view.getInt16(t.os2[0] + 72, false);
  }

  if (t.os2 && t.os2[1] >= 30) {
    t.os2SubscriptOffset = t.view.getInt16(t.os2[0] + 16, false);
    t.os2SuperscriptOffset = t.view.getInt16(t.os2[0] + 24, false);
    t.os2StrikeoutSize = t.view.getInt16(t.os2[0] + 26, false);
    t.os2StrikeoutPosition = t.view.getInt16(t.os2[0] + 28, false);
  }

  if (!t.os2 || t.os2[1] < 90) return;
  const ver = t.view.getUint16(t.os2[0], false);
  if (ver < 2) return;
  t.os2xHeight = t.view.getInt16(t.os2[0] + 86, false);
  t.os2CapHeight = t.view.getInt16(t.os2[0] + 88, false);
}

function _decodePost(t) {
  // 'post' is optional; fall back to default metrics when absent.
  if (!t.post || t.post[1] < 12) {
    t.postUnderlinePosition = Math.round(-t.unitsPerEm * 0.1);
    t.postUnderlineThickness = Math.round(t.unitsPerEm * 0.05);
    return;
  }
  // Fixed 16.16 italicAngle at offset 4.
  const ihi = t.view.getInt16(t.post[0] + 4, false);
  const ilo = t.view.getUint16(t.post[0] + 6, false);
  t.postItalicAngle = ihi + ilo / 65536;
  t.postUnderlinePosition = t.view.getInt16(t.post[0] + 8, false);
  t.postUnderlineThickness = t.view.getInt16(t.post[0] + 10, false);
}

const _SUPPORTED_CMAP_FORMATS = new Set([0, 2, 4, 6, 8, 10, 12, 13]);

function _selectCmap(t) {
  t._cmapFormat = -1; // no usable subtable: every code point is .notdef
  if (!t.cmap) throw new Error("the font has no 'cmap' table");
  const numSub = t.view.getUint16(t.cmap[0] + 2, false);
  let bestRank = Infinity,
    bestOff = 0,
    bestPlat = -1,
    bestEnc = -1,
    bestFmt = -1;
  let uvsOff = 0;
  for (let i = 0; i < numSub; i++) {
    const recOff = t.cmap[0] + 4 + i * 8;
    if (recOff + 8 > t.view.byteLength) break;
    const plat = t.view.getUint16(recOff, false);
    const enc = t.view.getUint16(recOff + 2, false);
    const sub = t.view.getUint32(recOff + 4, false) + t.cmap[0];
    if (sub + 2 > t.view.byteLength) continue;
    const fmt = t.view.getUint16(sub, false);
    if (fmt === 14) {
      uvsOff = sub;
      continue;
    } // UVS — handled separately
    if (!_SUPPORTED_CMAP_FORMATS.has(fmt)) continue;
    const rank = _rankCmap(plat, enc);
    // Strictly-better rank wins; on a tie keep the first (directory order).
    if (rank < bestRank) {
      bestRank = rank;
      bestOff = sub;
      bestPlat = plat;
      bestEnc = enc;
      bestFmt = fmt;
    }
  }
  // Format-14 UVS subtable offset (0 = none). Consumed by the variation-
  // sequence resolver; the default (non-selector) lookup ignores it.
  t._uvsOff = uvsOff;
  if (bestRank === Infinity) throw new Error('no supported cmap subtable');
  t._cmapOff = bestOff;
  t._cmapFormat = bestFmt;
  t._cmapPlat = bestPlat;
  t._cmapEnc = bestEnc;
  // Windows Symbol cmaps (3,0) map the ASCII / Latin-1 repertoire into
  // the U+F000–U+F0FF Private Use Area. A direct lookup of 'A' (0x41)
  // misses; the glyph lives at 0xF041. Flag so _cmapLookup retries there.
  t._cmapSymbol = bestPlat === 3 && bestEnc === 0;
}

function _rankCmap(plat, enc) {
  // Unicode subtables preferred (best repertoire first)…
  if (plat === 3 && enc === 10) return 0; // Windows UCS-4 (SMP)
  if (plat === 0 && enc === 6) return 1; // Unicode full
  if (plat === 0 && enc === 4) return 2; // Unicode 2.0+ full
  if (plat === 3 && enc === 1) return 3; // Windows BMP
  if (plat === 0 && enc === 3) return 4; // Unicode 2.0 BMP
  if (plat === 0) return 5; // any other Unicode
  // …then legacy/symbol fallbacks so a font with NO Unicode cmap (old
  // Mac TrueType, Windows Symbol icon fonts) still renders instead of
  // throwing.
  if (plat === 3 && enc === 0) return 6; // Windows Symbol (F0xx PUA)
  if (plat === 1 && enc === 0) return 7; // Mac Roman
  if (plat === 3) return 8; // other Windows (legacy CJK)
  if (plat === 1) return 9; // other Mac
  return Infinity;
}

function _cmapLookup(t, cp) {
  let gid = _cmapLookupRaw(t, cp);
  // Windows Symbol fallback: glyphs live in the U+F000 PUA block. Retry
  // there when the direct lookup of a low codepoint misses.
  if (gid === 0 && t._cmapSymbol && cp <= 0xff) gid = _cmapLookupRaw(t, 0xf000 + cp);
  return gid;
}

function _cmapLookupRaw(t, cp) {
  switch (t._cmapFormat) {
    case 0:
      return _cmapFmt0(t, cp);
    case 2:
      return _cmapFmt2(t, cp);
    case 4:
      return _cmapFmt4(t, cp);
    case 6:
      return _cmapFmt6(t, cp);
    case 8:
      return _cmapFmt8(t, cp);
    case 10:
      return _cmapFmt10(t, cp);
    case 12:
      return _cmapFmt12(t, cp);
    case 13:
      return _cmapFmt13(t, cp);
    default:
      return 0;
  }
}

/// Format 8 — mixed 16-bit/32-bit coverage. Header: format(2) reserved(2)
/// length(4) language(4) is32[8192] numGroups(4), then groups of
/// { startChar(4), endChar(4), startGlyph(4) }. The is32 bitmap only
/// classifies which 16-bit code units begin a 32-bit char; codepoint→gid
/// is a plain group search like format 12.
function _cmapFmt8(t, cp) {
  const v = t.view,
    o = t._cmapOff;
  // header(12: format,reserved,length,language) + is32[8192], then
  // numGroups(4), then the groups.
  const nGroups = v.getUint32(o + 12 + 8192, false);
  const base = o + 12 + 8192 + 4;
  let lo = 0,
    hi = nGroups - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const g = base + mid * 12;
    const start = v.getUint32(g, false);
    const end = v.getUint32(g + 4, false);
    if (cp < start) hi = mid - 1;
    else if (cp > end) lo = mid + 1;
    else return (v.getUint32(g + 8, false) + (cp - start)) & 0xffff;
  }
  return 0;
}

/// Format 10 — trimmed array, 32-bit. Header: format(2) reserved(2)
/// length(4) language(4) startCharCode(4) numChars(4), then
/// glyphs[numChars] (u16). Covers a single contiguous codepoint range.
function _cmapFmt10(t, cp) {
  const v = t.view,
    o = t._cmapOff;
  const start = v.getUint32(o + 12, false);
  const numChars = v.getUint32(o + 16, false);
  if (cp < start || cp >= start + numChars) return 0;
  return v.getUint16(o + 20 + (cp - start) * 2, false);
}

/// Format 0 — byte-encoding table: a flat 256-entry glyphIdArray indexed
/// by a single-byte code. Used by old Mac (1,0) and some Symbol (3,0)
/// fonts. Header: format(2) length(2) language(2) glyphIdArray[256].
function _cmapFmt0(t, cp) {
  if (cp > 0xff) return 0;
  return t.view.getUint8(t._cmapOff + 6 + cp);
}

/// Format 2 — high-byte mapping through subheaders (legacy CJK multibyte:
/// Shift-JIS, Big5, …). The codepoint is interpreted as the font's legacy
/// encoding, so for Unicode input this resolves the ASCII / single-byte
/// subset and any codepoints that happen to equal the legacy value.
/// Full Unicode→legacy transcoding (the giant per-encoding codecs) is out
/// of scope; mainstream CJK fonts also ship a Unicode format-4/12 cmap,
/// which _selectCmap prefers. Mirrors FreeType's tt_cmap2_char_index.
function _cmapFmt2(t, cp) {
  if (cp > 0xffff) return 0;
  const v = t.view,
    o = t._cmapOff;
  const subKeysOff = o + 6; // subHeaderKeys[256] (uint16)
  const subHeadersBase = subKeysOff + 512;
  const high = (cp >> 8) & 0xff;
  const low = cp & 0xff;
  let subIdxByteOff, testByte;
  if (high === 0) {
    // Single-byte candidate: the byte selects its own subheader key.
    const k = v.getUint16(subKeysOff + low * 2, false);
    if (k !== 0) return 0; // `low` is a lead byte, not a glyph on its own
    subIdxByteOff = 0;
    testByte = low;
  } else {
    subIdxByteOff = v.getUint16(subKeysOff + high * 2, false); // already ×8
    // subHeaderKeys[high] == 0 means `high` is NOT a lead byte — a
    // two-byte code with it is invalid (FreeType rejects). Falling
    // through would decode via subheader 0, which is reserved for
    // single-byte codes.
    if (subIdxByteOff === 0) return 0;
    testByte = low;
  }
  const sh = subHeadersBase + subIdxByteOff;
  const firstCode = v.getUint16(sh, false);
  const entryCount = v.getUint16(sh + 2, false);
  const idDelta = v.getInt16(sh + 4, false);
  const idRangeOffset = v.getUint16(sh + 6, false);
  if (testByte < firstCode || testByte >= firstCode + entryCount) return 0;
  // glyphIndexArray address = (addr of idRangeOffset) + idRangeOffset +
  //   2*(testByte - firstCode).
  const glyphAddr = sh + 6 + idRangeOffset + 2 * (testByte - firstCode);
  const gid = v.getUint16(glyphAddr, false);
  return gid === 0 ? 0 : (gid + idDelta) & 0xffff;
}

function _readUint24(v, o) {
  return (v.getUint8(o) << 16) | (v.getUint8(o + 1) << 8) | v.getUint8(o + 2);
}

/// Format 14 (Unicode Variation Sequences). Resolve a (base, selector)
/// codepoint pair to a glyph. The selector is a registered variation
/// selector (U+FE00–FE0F or U+E0100–E01EF). Returns:
///   >0 : an explicit non-default variant glyph — e.g. the emoji
///        presentation of a base when followed by VS16 (U+FE0F), or a
///        CJK ideographic variant for an IVS selector.
///    0 : the sequence isn't registered for this font, OR it's a
///        "default UVS" entry — either way the caller should fall back
///        to the ordinary cmap glyph for the base codepoint.
function _resolveUvs(t, baseCp, selectorCp) {
  const off = t._uvsOff;
  if (!off) return 0;
  const v = t.view;
  // format(2) length(4) numVarSelectorRecords(4), then records of:
  //   uint24 varSelector, uint32 defaultUVSOffset, uint32 nonDefaultUVSOffset
  const numRecords = v.getUint32(off + 6, false);
  let lo = 0,
    hi = numRecords - 1,
    recOff = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = off + 10 + mid * 11;
    const sel = _readUint24(v, r);
    if (selectorCp < sel) hi = mid - 1;
    else if (selectorCp > sel) lo = mid + 1;
    else {
      recOff = r;
      break;
    }
  }
  if (recOff < 0) return 0; // selector not a registered variation here
  const nonDefOff = v.getUint32(recOff + 7, false);
  if (nonDefOff) {
    // NonDefaultUVS: numUVSMappings(4), then { uint24 unicode, uint16 gid }.
    const base = off + nonDefOff;
    const num = v.getUint32(base, false);
    let a = 0,
      b = num - 1;
    while (a <= b) {
      const mid = (a + b) >> 1;
      const m = base + 4 + mid * 5;
      const uni = _readUint24(v, m);
      if (baseCp < uni) b = mid - 1;
      else if (baseCp > uni) a = mid + 1;
      else return v.getUint16(m + 3, false);
    }
  }
  // DefaultUVS (base keeps its ordinary glyph) or base not listed: the
  // caller's normal cmap lookup already produced the right glyph.
  return 0;
}

/// Format 13 — many-to-one ranges. Same byte layout as format 12, but
/// startGlyphID maps every codepoint in the group to the same glyph
/// (used by LastResort-style fonts that draw one box per Unicode block).
function _cmapFmt13(t, cp) {
  const v = t.view,
    o = t._cmapOff;
  const numGroups = v.getUint32(o + 12, false);
  const base = o + 16;
  let lo = 0,
    hi = numGroups - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const g = base + mid * 12;
    const start = v.getUint32(g, false);
    const end = v.getUint32(g + 4, false);
    if (cp < start) hi = mid - 1;
    else if (cp > end) lo = mid + 1;
    else return v.getUint32(g + 8, false) & 0xffff; // constant glyph for the whole range
  }
  return 0;
}

function _cmapFmt4(t, cp) {
  if (cp > 0xffff) return 0;
  const v = t.view,
    o = t._cmapOff;
  const segCountX2 = v.getUint16(o + 6, false);
  const segCount = segCountX2 >> 1;
  const endOff = o + 14;
  const startOff = endOff + 2 + segCountX2;
  const idDeltaOff = startOff + segCountX2;
  const idRangeOffOff = idDeltaOff + segCountX2;
  // Binary search on endCode (spec: sorted ascending) — this runs per
  // codepoint per layout and CJK cmaps carry thousands of segments, so
  // a front-to-back scan would be the per-glyph hot spot on large fonts.
  let lo = 0,
    hi = segCount - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (v.getUint16(endOff + mid * 2, false) < cp) lo = mid + 1;
    else hi = mid;
  }
  if (lo < segCount && cp <= v.getUint16(endOff + lo * 2, false)) {
    const i = lo;
    const start = v.getUint16(startOff + i * 2, false);
    if (cp < start) return 0;
    const idDelta = v.getInt16(idDeltaOff + i * 2, false);
    const idRangeOff = v.getUint16(idRangeOffOff + i * 2, false);
    if (idRangeOff === 0) return (cp + idDelta) & 0xffff;
    const glyphIdAddr = idRangeOffOff + i * 2 + idRangeOff + 2 * (cp - start);
    const gid = v.getUint16(glyphIdAddr, false);
    return gid === 0 ? 0 : (gid + idDelta) & 0xffff;
  }
  return 0;
}

function _cmapFmt6(t, cp) {
  const v = t.view,
    o = t._cmapOff;
  const firstCode = v.getUint16(o + 6, false);
  const entryCount = v.getUint16(o + 8, false);
  if (cp < firstCode || cp >= firstCode + entryCount) return 0;
  return v.getUint16(o + 10 + (cp - firstCode) * 2, false);
}

function _cmapFmt12(t, cp) {
  const v = t.view,
    o = t._cmapOff;
  const numGroups = v.getUint32(o + 12, false);
  const base = o + 16;
  let lo = 0,
    hi = numGroups - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const g = base + mid * 12;
    const start = v.getUint32(g, false);
    const end = v.getUint32(g + 4, false);
    if (cp < start) hi = mid - 1;
    else if (cp > end) lo = mid + 1;
    else {
      const startGid = v.getUint32(g + 8, false);
      return (startGid + (cp - start)) & 0xffff;
    }
  }
  return 0;
}

function _glyphRange(t, gid) {
  if (!t.loca || !t.glyf || gid >= t.numGlyphs) return [0, 0];
  let start, end;
  if (t.indexToLocFormat === 0) {
    start = t.view.getUint16(t.loca[0] + gid * 2, false) * 2;
    end = t.view.getUint16(t.loca[0] + (gid + 1) * 2, false) * 2;
  } else {
    start = t.view.getUint32(t.loca[0] + gid * 4, false);
    end = t.view.getUint32(t.loca[0] + (gid + 1) * 4, false);
  }
  if (end <= start) return [0, 0];
  return [t.glyf[0] + start, end - start];
}

/// A font with no hmtx table has no horizontal metrics; its glyphs advance half
/// an em, the default HarfBuzz applies (hb-ot-hmtx-table.hh).
function _glyphAdvance(t, gid) {
  if (!t.hmtx) return t.unitsPerEm >> 1;
  if (t.numberOfHMetrics === 0) return 0;
  const idx = gid < t.numberOfHMetrics ? gid : t.numberOfHMetrics - 1;
  return t.view.getUint16(t.hmtx[0] + idx * 4, false);
}

function _glyphLsb(t, gid) {
  if (!t.hmtx) return 0;
  if (gid < t.numberOfHMetrics) return t.view.getInt16(t.hmtx[0] + gid * 4 + 2, false);
  const tailStart = t.hmtx[0] + t.numberOfHMetrics * 4;
  return t.view.getInt16(tailStart + (gid - t.numberOfHMetrics) * 2, false);
}

/// vmtx vertical advance — height of the glyph cell along the
/// stretching direction in font units. Falls back to the font's
/// upem (a sensible CJK default) when vmtx absent.
function _glyphVAdvance(t, gid) {
  if (!t.vmtx || t.numberOfVMetrics === 0) return t.unitsPerEm;
  const idx = gid < t.numberOfVMetrics ? gid : t.numberOfVMetrics - 1;
  // vmtx record: advanceHeight (u16), topSideBearing (i16).
  return t.view.getUint16(t.vmtx[0] + idx * 4, false);
}

/// vmtx top side bearing — distance from the top of the em-box down
/// to the glyph's top edge, in font units. Falls back to 0 when
/// vmtx absent (which means the glyph sits at the cell's top edge).
function _glyphTsb(t, gid) {
  if (!t.vmtx) return 0;
  if (gid < t.numberOfVMetrics) return t.view.getInt16(t.vmtx[0] + gid * 4 + 2, false);
  const tailStart = t.vmtx[0] + t.numberOfVMetrics * 4;
  return t.view.getInt16(tailStart + (gid - t.numberOfVMetrics) * 2, false);
}
