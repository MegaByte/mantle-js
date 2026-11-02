// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// readerRegistry.js — opt-in registry for OpenType table readers.
//
// fontAsset.js + glyphReader.js consult this registry instead of
// statically importing every table reader at module load. Default
// state: only the essential readers (glyf glyphs / cmap / hmtx / GSUB /
// GPOS / GDEF / name) are registered — covers Latin / Cyrillic / Greek
// TrueType-outline fonts + standard kerning + ligatures. Optional
// readers (CFF outlines / gvar / COLR / CBDT / EBDT / sbix / SVG-in-OT /
// fvar / hvar / vvar / mvar / MATH / VORG / BASE / STAT / JSTF / AAT
// morx-mort-kerx-feat / legacy kern / WOFF2) opt in per consumer:
//
//   import { registerColorEmojiReaders }   from '@kontek/mantle/font/color';
//   import { registerVariableFontReaders } from '@kontek/mantle/font/variations';
//   import { registerMathReader }          from '@kontek/mantle/font/math';
//   registerColorEmojiReaders();
//   registerVariableFontReaders();
//
// Without the opt-in, the getter (`fontAsset.colr`, `fontAsset.fvar`,
// etc.) returns a null-object whose `hasX` flags are all false —
// text rendering still works, the optional features just no-op.
//
// This indirection is what lets a Latin-text consumer drop ~30 KB+
// gzipped of reader code their assets don't need.

// Each entry is either a constructor function or null. Constructors
// take `(tables)` and return a reader. Null means the reader isn't
// available — getters that consult an unregistered reader fall back
// to a null-object that reports "no feature data".
import { warnMissingFeature } from '../core/missingFeature.js';

const _readerCtors = {
  // Outline readers. glyf is always-on core (glyphReader handles it
  // directly); CFF/CFF2 outlines and gvar deltas are opt-in. A CFF
  // font with no `cff` reader registered renders blank glyphs (with a
  // one-time console warning); a variable font with no `gvar` reader
  // renders at its default axis position.
  cff: null, // CffReader class (handles CFF1 + CFF2) — new(bytes,off,len,version)
  gvar: null, // GvarTable — (tables) ctor
  colr: null, // ColrReader
  colrPaintToGraph: null, // pure function (not a class)
  sbix: null, // SbixReader
  cbdt: null, // CbdtReader
  ebdt: null, // EbdtReader (monochrome/grayscale embedded bitmaps)
  svgInOt: null, // SvgInOtReader
  fvar: null, // FvarTable
  hvar: null, // HvarTable
  vvar: null, // VvarTable
  mvar: null, // MvarTable
  vorg: null, // VorgReader
  base: null, // BaseReader
  jstf: null, // JstfReader (kashida justification)
  mort: null, // AatMort (AAT legacy metamorphosis)
  morx: null, // AatMorx (AAT glyph metamorphosis)
  kerx: null, // AatKerx (AAT extended kerning)
  trak: null, // AatTrak (AAT tracking)
  feat: null, // FeatReader (AAT feature names)
  stat: null, // StatReader
  math: null, // MathReader
  legacyKern: null, // LegacyKernReader
  // WOFF2 decoder. Not a reader per se — a (bytes) → bytes async
  // function. Registered via registerWoff2(). isWoff2() is the
  // synchronous detection helper; consumers gate on it before calling
  // decodeWoff2() so the async machinery can stay opt-in.
  isWoff2: null,
  decodeWoff2: null,
};

export function registerReader(name, ctor) {
  if (!(name in _readerCtors)) throw new Error(`Unknown reader: ${name}`);
  _readerCtors[name] = ctor;
}

export function getReaderCtor(name) {
  return _readerCtors[name] || null;
}

/// Convenience: try to instantiate the named reader; returns null when
/// no constructor is registered. Callers should handle null by
/// substituting a null-object (see fontAsset.js getters).
export function tryNewReader(name, tables) {
  const ctor = _readerCtors[name];
  return ctor ? ctor(tables) : null;
}

// ──────────────────────────────────────────────────────────────────
// Null-object stubs returned by fontAsset getters when the
// corresponding reader hasn't been registered. Each stub mimics the
// "no data" surface of its real reader — same flag names, same
// always-empty getters. Keeps every caller's `font.colr.hasColor`
// pattern null-safe without per-call-site checks.
// ──────────────────────────────────────────────────────────────────

const _NULL_COLR = Object.freeze({
  hasColor: false,
  hasColrV1: false,
  numBaseGlyphs: 0,
  numBaseGlyphsV1: 0,
  numPaletteEntries: 0,
  version: -1,
  getLayers() {
    return null;
  },
  getPaint() {
    return null;
  },
  getClipBox() {
    return null;
  },
});
const _NULL_BITMAP = Object.freeze({
  hasBitmaps: false,
  pickStrikeForPpem() {
    return -1;
  },
  getBitmapGlyph() {
    return null;
  },
});
const _NULL_SVG_IN_OT = Object.freeze({
  hasSvg: false,
  getGlyph() {
    return null;
  },
});
const _NULL_FVAR = Object.freeze({
  // Mirror MantleFvarTable's consumed surface: fontAsset reads `isVariable`
  // and `normalizeCoords` (the latter guarded by isVariable), not `hasFvar`.
  isVariable: false,
  axes: [],
  instances: [],
  normalizeCoords() {
    return [];
  },
  defaultCoords() {
    return null;
  },
  resolveInstance() {
    return null;
  },
});
const _NULL_HVAR = Object.freeze({
  hasHvar: false,
  advanceDelta() {
    return 0;
  },
  lsbDelta() {
    return 0;
  },
});
const _NULL_VVAR = Object.freeze({
  hasVvar: false,
  originDelta() {
    return 0;
  },
  advanceDelta() {
    return 0;
  },
  tsbDelta() {
    return 0;
  },
});
const _NULL_MVAR = Object.freeze({
  hasMvar: false,
  delta() {
    return 0;
  },
});
const _NULL_TRAK = Object.freeze({
  hasTrak: false,
  getHorizontalTracking() {
    return 0;
  },
});
const _NULL_VORG = Object.freeze({
  // Mirror VorgReader's consumed surface (fontAsset: hasTable + getVertOriginY).
  hasTable: false,
  getVertOriginY() {
    return null;
  },
});
const _NULL_BASE = Object.freeze({
  hasBase: false,
  getBaselineValue() {
    return null;
  },
});
const _NULL_JSTF = Object.freeze({
  hasJstf: false,
  getExtenderGlyphs() {
    return null;
  },
  hasPriorities() {
    return false;
  },
  hasAnyPriorities: false,
  getPriorities() {
    return null;
  },
  range: [0, 0],
});
const _NULL_MORX = Object.freeze({
  hasMorx: false,
  apply(gids) {
    return { gids: gids.slice(), src: gids.map((_, i) => i) };
  },
});
const _NULL_MORT = Object.freeze({
  hasMort: false,
  apply(gids) {
    return { gids: gids.slice(), src: gids.map((_, i) => i) };
  },
});
const _NULL_KERX = Object.freeze({
  hasKerx: false,
  getPairKerning() {
    return 0;
  },
});
const _NULL_FEAT = Object.freeze({
  hasFeat: false,
  features: [],
});
const _NULL_STAT = Object.freeze({
  // Mirror StatReader's `hasTable` (not `hasStat`).
  hasTable: false,
});
const _NULL_MATH = Object.freeze({
  hasTable: false,
  hasMathVariants: false,
  getConstants() {
    return null;
  },
  pickVariantForSize() {
    return 0;
  },
  buildAssembly() {
    return null;
  },
});
const _NULL_LEGACY_KERN = Object.freeze({
  // Interface must mirror LegacyKernReader (typography/legacyKernReader.js)
  // and what fontAsset reads (hasAnyKerning / getPairKerningFu): hasKerning +
  // getPairKerning. Lean callers that don't opt into legacy kern get this
  // safe null object → false/0, not a TypeError.
  hasKerning: false,
  hasStateKerning: false,
  getPairKerning() {
    return 0;
  },
});

// What each reader needs, for the message when a font HAS the table and the reader is not registered: the table names that
// prove the font uses it, what the font loses, the subpath, and the call.
const READER_NEEDS = Object.freeze({
  colr: {
    tables: ['colr'],
    what: 'COLR color glyphs are drawn as plain outlines',
    sub: 'font/color',
    call: 'registerColorEmojiReaders()',
  },
  sbix: {
    tables: ['sbix'],
    what: 'sbix bitmap glyphs are not drawn',
    sub: 'font/color',
    call: 'registerColorEmojiReaders()',
  },
  cbdt: {
    tables: ['cbdt', 'cblc'],
    what: 'CBDT bitmap glyphs are not drawn',
    sub: 'font/color',
    call: 'registerColorEmojiReaders()',
  },
  ebdt: {
    tables: ['ebdt', 'eblc'],
    what: 'embedded bitmap glyphs are not drawn',
    sub: 'font/color',
    call: 'registerColorEmojiReaders()',
  },
  svgInOt: {
    tables: ['svg'],
    what: 'SVG-in-OpenType glyphs are not drawn',
    sub: 'font/color',
    call: 'registerColorEmojiReaders()',
  },
  fvar: {
    tables: ['fvar'],
    what: 'the font is a variable font used at its default instance',
    sub: 'font/variations',
    call: 'registerVariableFontReaders()',
  },
  hvar: {
    tables: ['hvar'],
    what: 'variable-font advance widths are not varied',
    sub: 'font/variations',
    call: 'registerVariableFontReaders()',
  },
  vvar: {
    tables: ['vvar'],
    what: 'variable-font vertical metrics are not varied',
    sub: 'font/variations',
    call: 'registerVariableFontReaders()',
  },
  mvar: {
    tables: ['mvar'],
    what: 'variable-font global metrics are not varied',
    sub: 'font/variations',
    call: 'registerVariableFontReaders()',
  },
  stat: {
    tables: ['stat'],
    what: 'the STAT axis names are not read',
    sub: 'font/variations',
    call: 'registerVariableFontReaders()',
  },
  vorg: {
    tables: ['vorg'],
    what: 'vertical glyph origins use the default',
    sub: 'font/typography/vertical',
    call: 'registerVerticalReader()',
  },
  base: {
    tables: ['base'],
    what: 'the BASE baselines are not used',
    sub: 'font/typography/baseline',
    call: 'registerBaselineReader()',
  },
  jstf: {
    tables: ['jstf'],
    what: 'kashida justification data is not used',
    sub: 'font/typography/justification',
    call: 'registerJustificationReader()',
  },
  mort: {
    tables: ['mort'],
    what: 'AAT glyph metamorphosis is not applied',
    sub: 'font/typography/aat',
    call: 'registerAatReaders()',
  },
  morx: {
    tables: ['morx'],
    what: 'AAT glyph metamorphosis is not applied',
    sub: 'font/typography/aat',
    call: 'registerAatReaders()',
  },
  kerx: {
    tables: ['kerx'],
    what: 'AAT extended kerning is not applied',
    sub: 'font/typography/aat',
    call: 'registerAatReaders()',
  },
  feat: {
    tables: ['feat'],
    what: 'AAT feature names are not read',
    sub: 'font/typography/aat',
    call: 'registerAatReaders()',
  },
  math: {
    tables: ['math'],
    what: 'OpenType MATH data is not used',
    sub: 'font/math',
    call: 'registerMathReader()',
  },
  legacyKern: {
    tables: ['kern'],
    absent: ['gpos'],
    what: "the legacy 'kern' table is not applied",
    sub: 'font/typography/legacyKern',
    call: 'registerLegacyKernReader()',
  },
});

/**
 * The inert stand-in for an unregistered reader. Pass the font's parsed table directory as `tables` to have a font that HAS the
 * table (and so loses something) warn once, naming the import that registers the reader.
 * @param {string} name
 * @param {any} [tables]
 */
export function nullObjectFor(name, tables) {
  const need = READER_NEEDS[name];
  if (
    need &&
    tables &&
    need.tables.some((t) => tables[t]) &&
    !(need.absent && need.absent.some((t) => tables[t]))
  )
    warnMissingFeature(
      'reader:' + name,
      'this font has ' + need.tables[0].toUpperCase() + ' data and ' + need.what,
      '@kontek/mantle/' + need.sub,
      need.call,
    );
  switch (name) {
    case 'colr':
      return _NULL_COLR;
    case 'sbix':
      return _NULL_BITMAP;
    case 'cbdt':
      return _NULL_BITMAP;
    case 'ebdt':
      return _NULL_BITMAP;
    case 'svgInOt':
      return _NULL_SVG_IN_OT;
    case 'fvar':
      return _NULL_FVAR;
    case 'hvar':
      return _NULL_HVAR;
    case 'vvar':
      return _NULL_VVAR;
    case 'mvar':
      return _NULL_MVAR;
    case 'vorg':
      return _NULL_VORG;
    case 'base':
      return _NULL_BASE;
    case 'jstf':
      return _NULL_JSTF;
    case 'mort':
      return _NULL_MORT;
    case 'morx':
      return _NULL_MORX;
    case 'kerx':
      return _NULL_KERX;
    case 'trak':
      return _NULL_TRAK;
    case 'feat':
      return _NULL_FEAT;
    case 'stat':
      return _NULL_STAT;
    case 'math':
      return _NULL_MATH;
    case 'legacyKern':
      return _NULL_LEGACY_KERN;
    default:
      return null;
  }
}
