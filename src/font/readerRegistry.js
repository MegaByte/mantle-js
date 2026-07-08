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
const _readerCtors = {
  // Outline readers. glyf is always-on core (glyphReader handles it
  // directly); CFF/CFF2 outlines and gvar deltas are opt-in. A CFF
  // font with no `cff` reader registered renders blank glyphs (with a
  // one-time console warning); a variable font with no `gvar` reader
  // renders at its default axis position.
  cff:         null,    // CffReader class (handles CFF1 + CFF2) — new(bytes,off,len,version)
  gvar:        null,    // GvarTable — (tables) ctor
  colr:        null,    // ColrReader
  colrPaintToGraph: null, // pure function (not a class)
  sbix:        null,    // SbixReader
  cbdt:        null,    // CbdtReader
  ebdt:        null,    // EbdtReader (monochrome/grayscale embedded bitmaps)
  svgInOt:     null,    // SvgInOtReader
  fvar:        null,    // FvarTable
  hvar:        null,    // HvarTable
  vvar:        null,    // VvarTable
  mvar:        null,    // MvarTable
  vorg:        null,    // VorgReader
  base:        null,    // BaseReader
  jstf:        null,    // JstfReader (kashida justification)
  mort:        null,    // AatMort (AAT legacy metamorphosis)
  morx:        null,    // AatMorx (AAT glyph metamorphosis)
  kerx:        null,    // AatKerx (AAT extended kerning)
  feat:        null,    // FeatReader (AAT feature names)
  stat:        null,    // StatReader
  math:        null,    // MathReader
  legacyKern:  null,    // LegacyKernReader
  // WOFF2 decoder. Not a reader per se — a (bytes) → bytes async
  // function. Registered via registerWoff2(). isWoff2() is the
  // synchronous detection helper; consumers gate on it before calling
  // decodeWoff2() so the async machinery can stay opt-in.
  isWoff2:     null,
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
  hasColor: false, hasColrV1: false,
  numBaseGlyphs: 0, numBaseGlyphsV1: 0, numPaletteEntries: 0,
  version: -1,
  getLayers() { return null; },
  getPaint() { return null; },
});
const _NULL_BITMAP = Object.freeze({
  hasBitmaps: false,
  pickStrikeForPpem() { return -1; },
  getBitmapGlyph() { return null; },
});
const _NULL_SVG_IN_OT = Object.freeze({
  hasSvg: false,
  getGlyph() { return null; },
});
const _NULL_FVAR = Object.freeze({
  // Mirror MantleFvarTable's consumed surface: fontAsset reads `isVariable`
  // and `normalizeCoords` (the latter guarded by isVariable), not `hasFvar`.
  isVariable: false, axes: [], instances: [],
  normalizeCoords() { return []; },
  defaultCoords() { return null; },
  resolveInstance() { return null; },
});
const _NULL_HVAR = Object.freeze({
  hasHvar: false,
  advanceDelta() { return 0; },
  lsbDelta() { return 0; },
});
const _NULL_VVAR = Object.freeze({
  hasVvar: false,
  advanceDelta() { return 0; },
  tsbDelta() { return 0; },
});
const _NULL_MVAR = Object.freeze({
  hasMvar: false,
  delta() { return 0; },
});
const _NULL_VORG = Object.freeze({
  // Mirror VorgReader's consumed surface (fontAsset: hasTable + getVertOriginY).
  hasTable: false,
  getVertOriginY() { return null; },
});
const _NULL_BASE = Object.freeze({
  hasBase: false,
  getBaselineValue() { return null; },
});
const _NULL_JSTF = Object.freeze({
  hasJstf: false,
  getExtenderGlyphs() { return null; },
  hasPriorities() { return false; },
});
const _NULL_MORX = Object.freeze({
  hasMorx: false,
  apply(gids) { return { gids: gids.slice(), src: gids.map((_, i) => i) }; },
});
const _NULL_MORT = Object.freeze({
  hasMort: false,
  apply(gids) { return { gids: gids.slice(), src: gids.map((_, i) => i) }; },
});
const _NULL_KERX = Object.freeze({
  hasKerx: false,
  getPairKerning() { return 0; },
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
  hasTable: false, hasMathVariants: false,
  getConstants() { return null; },
  pickVariantForSize() { return 0; },
  buildAssembly() { return null; },
});
const _NULL_LEGACY_KERN = Object.freeze({
  // Interface must mirror LegacyKernReader (typography/legacyKernReader.js)
  // and what fontAsset reads (hasAnyKerning / getPairKerningFu): hasKerning +
  // getPairKerning. Lean callers that don't opt into legacy kern get this
  // safe null object → false/0, not a TypeError.
  hasKerning: false,
  getPairKerning() { return 0; },
});

export function nullObjectFor(name) {
  switch (name) {
    case 'colr':       return _NULL_COLR;
    case 'sbix':       return _NULL_BITMAP;
    case 'cbdt':       return _NULL_BITMAP;
    case 'ebdt':       return _NULL_BITMAP;
    case 'svgInOt':    return _NULL_SVG_IN_OT;
    case 'fvar':       return _NULL_FVAR;
    case 'hvar':       return _NULL_HVAR;
    case 'vvar':       return _NULL_VVAR;
    case 'mvar':       return _NULL_MVAR;
    case 'vorg':       return _NULL_VORG;
    case 'base':       return _NULL_BASE;
    case 'jstf':       return _NULL_JSTF;
    case 'mort':       return _NULL_MORT;
    case 'morx':       return _NULL_MORX;
    case 'kerx':       return _NULL_KERX;
    case 'feat':       return _NULL_FEAT;
    case 'stat':       return _NULL_STAT;
    case 'math':       return _NULL_MATH;
    case 'legacyKern': return _NULL_LEGACY_KERN;
    default: return null;
  }
}
