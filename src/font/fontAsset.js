// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// fontAsset.js — one per .ttf; glyphs extracted JIT
// and held in an LRU keyed by codepoint. Outline + metrics only —
// bundle assembly lives in textRun.

import { parseTtfTables, ttcFaceCount } from './ttfTables.js';
import { isWoff1, decodeWoff1 } from './formats/woff1.js';
export { ttcFaceCount };
import { readGlyph, glyphGvarAdvanceFu, glyphVerticalOriginFu } from './glyphReader.js';
import { MantleGlyphCache } from './glyphCache.js';
import { segBboxInto } from '../svg/bbox.js';
// Always-on readers — every text render needs them.
// GSUB for ligatures + Indic / Arabic features, GPOS for kerning +
// mark attachment, GDEF for lookupFlag (IgnoreMarks etc.), name for
// face metadata. Stripping any of these would break basic Latin text.
import { GposReader } from './gposReader.js';
import { GsubReader } from './gsubReader.js';
import { GdefReader } from './gdefReader.js';
import { NameTable } from './nameReader.js';
import { openTypeFeatureCatalog } from './featureCatalog.js';

// Optional readers — looked up via the registry so consumers opt in
// per subsystem and unused readers tree-shake. See
// font/{color,variations,math,formats}/** subpaths. A Latin-text
// consumer pays nothing for COLR / CBDT / sbix / SVG-in-OT /
// fvar+friends / MATH / VORG / BASE / STAT / legacy kern / WOFF2.
import { tryNewReader, nullObjectFor, getReaderCtor } from './readerRegistry.js';
import {
  guardReader,
  unguarded,
  unguardedOr,
  rebuildGuarded,
  dropTable,
  noteMalformedTable,
} from './fontTableGuard.js';

// Each reader's sfnt tag, for a warning, and the directory entries a malformed table takes with it.
const READER_TABLES = Object.freeze({
  gsub: ['GSUB', 'gsub'],
  gpos: ['GPOS', 'gpos'],
  gdef: ['GDEF', 'gdef'],
  name: ['name', 'name'],
  legacyKern: ['kern', 'kern'],
  colr: ['COLR', 'colr', 'cpal'],
  sbix: ['sbix', 'sbix'],
  cbdt: ['CBDT', 'cbdt', 'cblc'],
  ebdt: ['EBDT', 'ebdt', 'eblc'],
  svgInOt: ['SVG ', 'svg'],
  fvar: ['fvar', 'fvar', 'avar'],
  hvar: ['HVAR', 'hvar'],
  vvar: ['VVAR', 'vvar'],
  mvar: ['MVAR', 'mvar'],
  vorg: ['VORG', 'vorg'],
  base: ['BASE', 'base'],
  jstf: ['JSTF', 'jstf'],
  morx: ['morx', 'morx'],
  mort: ['mort', 'mort'],
  kerx: ['kerx', 'kerx', 'ankr'],
  trak: ['trak', 'trak'],
  feat: ['feat', 'feat'],
  stat: ['STAT', 'stat'],
  math: ['MATH', 'math'],
});

// The readers a layout asks about every glyph; each is held in the field of the name with an underscore.
const LAYOUT_READERS = new Set([
  'gpos',
  'gsub',
  'gdef',
  'kerx',
  'legacyKern',
  'math',
  'trak',
  'morx',
  'mort',
]);

/**
 * Async pre-decoder: if `bytes` is a WOFF 1.0 or woff2 file, decompress + reassemble
 * into a regular sfnt byte buffer (WOFF 1.0 needs no registration; woff2 needs the
 * formats/woff2 subpath). If already sfnt (TTF/OTF), returns
 * the input unchanged.
 *
 * Use this before constructing a MantleFontAsset for fonts that might
 * arrive as woff2 (e.g. fetched from a Google Fonts CDN).
 *
 *   const raw = new Uint8Array(await (await fetch(url)).arrayBuffer());
 *   const sfnt = await decodeIfWoff2(raw);
 *   const font = new MantleFontAsset(sfnt);
 *
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>}
 */
export async function decodeIfWoff2(bytes) {
  // WOFF 1.0 is plain zlib per table: always available, no registration (the name predates it).
  if (isWoff1(bytes)) return await decodeWoff1(bytes);
  // WOFF2 support is opt-in: register via the formats/woff2 subpath
  // before passing woff2 bytes here. Without registration, woff2
  // input throws (since detection still works but decode isn't
  // available). Detection lives in the same opt-in module so the
  // ~brotli WASM payload only loads when a consumer actually expects
  // to handle woff2.
  //
  //   import { registerWoff2Reader } from '@kontek/mantle/font/formats/woff2';
  //   registerWoff2Reader();
  const isWoff2 = getReaderCtor('isWoff2');
  const decodeWoff2 = getReaderCtor('decodeWoff2');
  if (!isWoff2 || !decodeWoff2) return bytes; // No WOFF2 registered → pass through.
  // If `bytes` is woff2 the downstream
  // sfnt parser will throw, surfacing the
  // "register the woff2 subpath" message
  // to the developer.
  return isWoff2(bytes) ? await decodeWoff2(bytes) : bytes;
}

/**
 * @typedef {Object} MantleGlyphMetrics
 * @property {number} advance      em-units / unitsPerEm
 * @property {number} leftBearing
 * @property {number} ascent
 * @property {number} descent
 * @property {number[]} bbox       [xmin, ymin, xmax, ymax], em-normalized
 */

export class MantleFontAsset {
  /**
   * @param {Uint8Array} ttfBytes
   * @param {{ byteBudget?: number, faceIndex?: number, compat?: 'spec'|'harfbuzz'|'chrome'|('harfbuzz'|'chrome')[], statNaming?: 'spec'|'fonttools' }} [opts]
   *   faceIndex selects a face from a TTC; ignored for plain TTF/OTF. `statNaming` picks the order in which STAT axis value
   *   names compose a style name: 'spec' (default) follows each axis's axisOrdering, 'fonttools' follows the design-axis
   *   index as fontTools' instancer does.
   */
  constructor(ttfBytes, opts = {}) {
    this._ttfBytes = ttfBytes;
    this._faceIndex = opts.faceIndex | 0;
    // 'harfbuzz' reads the name table and STAT the way HarfBuzz does; 'chrome' interpolates COLR gradients the way Chrome does (sRGB-encoded,
    // not premultiplied). They govern different tables, so an array takes both. The default follows the OpenType specification in each.
    const compat = [].concat(opts.compat ?? []);
    this._compat = compat.includes('harfbuzz') ? 'harfbuzz' : 'spec';
    this._colrChrome = compat.includes('chrome');
    this._statNaming = opts.statNaming === 'fonttools' ? 'fonttools' : 'spec';
    this._tables = null;
    this._cache = new MantleGlyphCache(opts.byteBudget);
    this._advanceCache = null;
    this._layoutGuards = new Map();
    this._layoutUnguarded = false;
    this._layoutSuspect = false;
    this._gpos = null;
    this._gsub = null;
    this._legacyKern = null;
    this._colr = null;
    this._sbix = null;
    this._cbdt = null;
    this._ebdt = null;
    this._svgInOt = null;
    this._name = null;
    this._fvar = null;
    this._hvar = null;
    this._vvar = null;
    this._mvar = null;
    this._gdef = null;
    this._vorg = null;
    this._base = null;
    this._jstf = null;
    this._morx = null;
    this._mort = null;
    this._kerx = null;
    this._trak = null;
    this._feat = null;
    this._stat = null;
    this._math = null;

    this.familyName = '';
    this.styleName = '';
    this.fullName = '';
    this.postScriptName = '';
    this.unitsPerEm = 0;
    this.ascent = 0;
    this.descent = 0;
    this.lineGap = 0;
    this.underlinePosition = 0;
    this.underlineThickness = 0;
    /** em; TOP of the line-through stroke above the baseline (OS/2 yStrikeoutPosition), and its thickness. */
    this.strikeoutPosition = 0;
    this.strikeoutSize = 0;
    /** em; OS/2 ySubscriptYOffset (below the baseline) and ySuperscriptYOffset (above it). */
    this.subscriptOffset = 0;
    this.superscriptOffset = 0;
    /** post.italicAngle in degrees (0 for upright fonts). */
    this.italicAngle = 0;
  }

  /** A reader behind its guard: a malformed table is dropped, see fontTableGuard.js. An unregistered reader is its null-object. */
  _reader(name, build = null) {
    const t = this._tables;
    if (!build && !getReaderCtor(name)) return nullObjectFor(name, t);
    const [tag, ...keys] = READER_TABLES[name];
    const guard = guardReader(t, tag, keys, build || (() => tryNewReader(name, t)));
    if (!LAYOUT_READERS.has(name)) return guard;
    this._layoutGuards.set('_' + name, guard);
    return this._layoutUnguarded ? unguarded(guard) : guard;
  }

  /// Layout crosses the guards of these readers many times per glyph, for tables that are nearly always good. A layout pass that
  /// answers for what they throw (`layoutPass`) reads them directly until `_guardLayoutReaders`. False when the font is already in
  /// such a pass, or has had a fault in one.
  _unguardLayoutReaders() {
    if (this._layoutUnguarded || this._layoutSuspect) return false;
    this._layoutUnguarded = true;
    for (const [field, guard] of this._layoutGuards) this[field] = unguarded(guard);
    this._setReadersGdef();
    return true;
  }

  _guardLayoutReaders() {
    this._layoutUnguarded = false;
    for (const [field, guard] of this._layoutGuards) this[field] = guard;
    this._setReadersGdef();
  }

  /// GSUB and GPOS read GDEF as this font's accessor does, so a bad GDEF read from inside them reads as GDEF's fault behind the guards.
  _setReadersGdef() {
    if (!this._gdef) return;
    if (this._gpos) unguardedOr(this._gpos)._gdef = this._gdef;
    if (this._gsub) unguardedOr(this._gsub)._gdef = this._gdef;
  }

  /// A pass reading these directly threw. From here on the guards say which table it is, over readers that have seen no abandoned call.
  _distrustLayoutReaders() {
    this._layoutSuspect = true;
    for (const guard of this._layoutGuards.values()) rebuildGuarded(guard);
  }

  /**
   * The sfnt tags of the tables found malformed so far. A layout or color table on this list has been dropped and the font works
   * without it; glyf, CFF, cmap and metric tables stay, and the one glyph or code point that failed draws blank or falls back.
   * @returns {string[]}
   */
  get malformedTables() {
    this._ensure();
    return this._tables._malformed ? Array.from(this._tables._malformed) : [];
  }

  /// An outline, whatever the bytes say. A variation read that fails over a good default outline is the variation data's fault: gvar
  /// is dropped, so a variable font keeps drawing at its default. Otherwise this glyph draws blank and the table stays, since a font
  /// with one bad outline still has the others.
  _outline(gid, coords = null) {
    const t = this._tables;
    try {
      return readGlyph(t, gid, coords);
    } catch (e) {
      if (coords != null) {
        let plain;
        try {
          plain = readGlyph(t, gid, null);
        } catch {
          plain = undefined;
        }
        if (plain !== undefined) {
          if (t.gvar) {
            dropTable(t, 'gvar', ['gvar'], e);
            t._gvarReader = null;
          } else noteMalformedTable(t, 'CFF2', e, 'kept, this glyph at its default outline');
          return plain;
        }
      }
      noteMalformedTable(t, t.cff ? 'CFF ' : t.cff2 ? 'CFF2' : 'glyf', e, 'kept, this glyph blank');
      return null;
    }
  }

  /// A metric read from gvar phantom points; null, which callers read as "use the static metric", when gvar is malformed.
  _gvarMetric(read) {
    const t = this._tables;
    try {
      return read();
    } catch (e) {
      if (t.gvar) {
        dropTable(t, 'gvar', ['gvar'], e);
        t._gvarReader = null;
      } else noteMalformedTable(t, 'glyf', e, 'kept, this glyph at its static metric');
      return null;
    }
  }

  /** GPOS reader; lazily built. */
  get gpos() {
    this._ensure();
    if (this._gpos == null) {
      this._gpos = this._reader('gpos', () => {
        const reader = new GposReader(this._tables);
        // Inject GDEF so context/chain-context pos can honor lookupFlag
        // (IgnoreMarks etc.). Cheap when GDEF absent — reader no-ops.
        reader.setGdef(this.gdef);
        return reader;
      });
    }
    return this._gpos;
  }
  /** GSUB reader; lazily built. */
  get gsub() {
    this._ensure();
    if (this._gsub == null) {
      this._gsub = this._reader('gsub', () => {
        const reader = new GsubReader(this._tables);
        // Inject GDEF so context/chain-context/reverse-chain sub +
        // ligature component walks honor lookupFlag skips.
        reader.setGdef(this.gdef);
        return reader;
      });
    }
    return this._gsub;
  }
  /** Legacy 'kern' table reader; lazily built. Returns a null-object
   *  (hasKern=false, pairKern=>0) when the optional reader hasn't
   *  been registered via font/typography/legacyKern. */
  get legacyKern() {
    this._ensure();
    if (this._legacyKern == null) this._legacyKern = this._reader('legacyKern');
    return this._legacyKern;
  }
  /** COLR + CPAL reader; lazily built. Returns a null-object
   *  (hasColor=false, getLayers=>null, getPaint=>null) when font/color
   *  hasn't been registered. */
  get colr() {
    this._ensure();
    if (this._colr == null) this._colr = this._reader('colr');
    return this._colr;
  }
  /** Whether the COLR reader reports color-layer records. */
  get hasColor() {
    return this.colr.hasColor;
  }

  /** Sbix reader; lazily built. Null-object (hasBitmaps=false) when
   *  font/color (which registers sbix alongside colr/cbdt/svgInOt)
   *  hasn't been registered. */
  get sbix() {
    this._ensure();
    if (this._sbix == null) this._sbix = this._reader('sbix');
    return this._sbix;
  }
  /** CBDT/CBLC reader; lazily built. Null-object when not registered. */
  get cbdt() {
    this._ensure();
    if (this._cbdt == null) this._cbdt = this._reader('cbdt');
    return this._cbdt;
  }
  /** EBDT/EBLC monochrome/grayscale bitmap reader; lazily built. */
  get ebdt() {
    this._ensure();
    if (this._ebdt == null) this._ebdt = this._reader('ebdt');
    return this._ebdt;
  }
  /** True iff this font carries bitmap glyphs (sbix OR CBDT OR EBDT). */
  get hasBitmaps() {
    return this.sbix.hasBitmaps || this.cbdt.hasBitmaps || this.ebdt.hasBitmaps;
  }

  /** SVG-in-OT reader (Twemoji format); lazily built. Null-object
   *  when not registered. */
  get svgInOt() {
    this._ensure();
    if (this._svgInOt == null) this._svgInOt = this._reader('svgInOt');
    return this._svgInOt;
  }
  /** True iff this font carries SVG-in-OT glyph documents. */
  get hasSvgGlyphs() {
    return this.svgInOt.hasSvg;
  }

  /// Resolves the SVG-in-OT document for `gid`. Returns null when
  /// no record covers this gid (or when the font has no 'SVG ' table).
  /// Returned object: { svgBytes, isGzipped, subElementId,
  ///                    startGid, endGid, advanceEm }
  /// Callers gunzip when isGzipped, parse the SVG, and render the
  /// sub-element with id=subElementId through the SVG importer.
  getSvgGlyphByGid(gid) {
    this._ensure();
    if (!this.svgInOt.hasSvg) return null;
    const g = this.svgInOt.getGlyph(gid);
    if (!g) return null;
    const inv = this.unitsPerEm > 0 ? 1 / this.unitsPerEm : 0;
    return {
      svgBytes: g.svgBytes,
      isGzipped: g.isGzipped,
      subElementId: g.subElementId,
      startGid: g.startGid,
      endGid: g.endGid,
      advanceEm: this._tables.glyphAdvanceWidth(gid) * inv,
    };
  }

  /// Codepoint convenience for getSvgGlyphByGid.
  getSvgGlyph(codepoint) {
    this._ensure();
    if (!this.hasSvgGlyphs) return null;
    const gid = this._tables.codepointToGlyphIndex(codepoint);
    if (gid === 0 && codepoint !== 0) return null;
    return this.getSvgGlyphByGid(gid);
  }

  /// Resolves a bitmap glyph for `gid` at the requested target
  /// rendering size (ppem = px per em-square). Picks the best
  /// strike (closest >= target, largest fallback). Returns
  /// null when no bitmap is available.
  ///
  getBitmapGlyphByGid(gid, targetPpem = 32) {
    this._ensure();
    // Prefer sbix if available (Apple ecosystem); fall back to CBDT.
    if (this.sbix.hasBitmaps) {
      const strikeIdx = this.sbix.pickStrikeForPpem(targetPpem);
      if (strikeIdx < 0) return null;
      const g = this.sbix.getBitmapGlyph(gid, strikeIdx);
      if (!g || !g.isPng) return null;
      // sbix originOffsetX/Y are PIXELS at the strike's ppem (they offset
      // the bitmap, so they scale with it — HarfBuzz applies the same
      // strike scale). Em-normalize via the strike ppem, not unitsPerEm.
      const inv = this.unitsPerEm > 0 ? 1 / this.unitsPerEm : 0;
      const px2em = g.strikePpem > 0 ? 1 / g.strikePpem : 0;

      return {
        pngBytes: g.pngBytes,
        originXEm: g.originX * px2em,
        originYEm: g.originY * px2em,
        widthEm: 0, // sbix doesn't include width metric — caller reads PNG header
        heightEm: 0, // ditto
        advanceEm: this._tables.glyphAdvanceWidth(gid) * inv,
        strikePpem: g.strikePpem,
        source: 'sbix',
      };
    }
    if (this.cbdt.hasBitmaps) {
      const strikeIdx = this.cbdt.pickStrikeForPpem(targetPpem);
      if (strikeIdx < 0) return null;
      const g = this.cbdt.getBitmapGlyph(gid, strikeIdx);
      if (!g) return null;
      // CBDT SmallGlyphMetrics: bearingX/Y, advance, W/H are ALL in
      // PIXELS at the strike's ppem (spec: metrics are pixel values).
      const px2em = g.strikePpem > 0 ? 1 / g.strikePpem : 0;
      return {
        pngBytes: g.pngBytes,
        originXEm: g.bearingX * px2em,
        originYEm: g.bearingY * px2em,
        widthEm: g.width * px2em,
        heightEm: g.height * px2em,
        advanceEm: g.advance * px2em,
        strikePpem: g.strikePpem,
        source: 'cbdt',
      };
    }
    if (this.ebdt.hasBitmaps) {
      const strikeIdx = this.ebdt.pickStrikeForPpem(targetPpem);
      if (strikeIdx < 0) return null;
      const g = this.ebdt.getBitmapGlyph(gid, strikeIdx);
      if (!g) return null;
      // EBDT carries raw coverage (not PNG): `alphaBitmap` is one 8-bit
      // coverage byte per pixel (row-major, width*height). bearingX/Y,
      // advance, W/H are ALL in PIXELS at the strike's ppem (spec:
      // SmallGlyphMetrics are pixel values). The glyph is monochrome/
      // grayscale — consumers tint by the fill color.
      const px2em = g.strikePpem > 0 ? 1 / g.strikePpem : 0;
      return {
        alphaBitmap: g.alphaBitmap,
        bitDepth: g.bitDepth,
        pixelWidth: g.width,
        pixelHeight: g.height,
        originXEm: g.bearingX * px2em,
        originYEm: g.bearingY * px2em,
        widthEm: g.width * px2em,
        heightEm: g.height * px2em,
        advanceEm: g.advance * px2em,
        strikePpem: g.strikePpem,
        source: 'ebdt',
      };
    }
    return null;
  }

  /// Codepoint convenience for getBitmapGlyphByGid.
  getBitmapGlyph(codepoint, targetPpem = 32) {
    this._ensure();
    if (!this.hasBitmaps) return null;
    const gid = this._tables.codepointToGlyphIndex(codepoint);
    if (gid === 0 && codepoint !== 0) return null;
    return this.getBitmapGlyphByGid(gid, targetPpem);
  }

  /** True iff GPOS, AAT kerx, or legacy kern has any pair data. */
  get hasAnyKerning() {
    return this.gpos.hasKerning || this.kerx.hasKerx || this.legacyKern.hasKerning;
  }

  /** Listed GPOS kern replaces legacy. Required GPOS alone retains legacy; AAT priority is unchanged. */
  getPairKerningFu(a, b, preferKerx = false) {
    // preferKerx: a font with AAT 'kerx' pair data uses it in place of GPOS (the layout's preferAat default).
    if (preferKerx && this.kerx.hasKerx) return this.kerx.getPairKerning(a, b);
    if (this.gpos.hasKerning) {
      const delta = this.gpos.getPairKerning(a, b);
      return (
        delta +
        (!this.gpos.hasListedKerning && !this.kerx.hasKerx
          ? this.legacyKern.getPairKerning(a, b)
          : 0)
      );
    }
    if (this.kerx.hasKerx) return this.kerx.getPairKerning(a, b);
    return this.legacyKern.getPairKerning(a, b);
  }

  /** Codepoint → glyph index. 0 = .notdef. */
  codepointToGlyphId(cp) {
    this._ensure();
    return this._tables.codepointToGlyphIndex(cp);
  }

  /** True when the font ships a format-14 Unicode-Variation-Sequence cmap. */
  get hasVariationSelectors() {
    this._ensure();
    return this._tables.hasUvs;
  }

  /// Resolve a (base, variation-selector) pair via the format-14 UVS
  /// cmap. Returns an explicit variant glyph id (>0) when the font
  /// defines one for this sequence (e.g. emoji presentation for VS16, or
  /// a CJK ideographic variant), or 0 to mean "use the ordinary glyph
  /// for `baseCp`". 0 when the font has no UVS table.
  codepointToVariationGlyphId(baseCp, selectorCp) {
    this._ensure();
    return this._tables.resolveVariationGlyph(baseCp, selectorCp);
  }

  /** Outline for an already-resolved glyph id. No codepoint cache lookup. */
  getGlyphSegsByGid(gid) {
    this._ensure();
    return this._outline(gid);
  }

  /// Variable-font variant: outline for `gid` morphed by the supplied
  /// USER-SPACE axis coordinates (an axis-tag map or a vector, in each axis's native
  /// range e.g. wght=400..1000). Coords shorter than axisCount fall
  /// back to each axis default; null/undefined → returns the default
  /// outline (identical to getGlyphSegsByGid).
  ///
  /// avar value mapping is applied when an 'avar' table is present
  /// (handled in normalizeCoords by the fvar reader).
  getGlyphSegsByGidVar(gid, userCoords) {
    this._ensure();
    if (!this.isVariable || userCoords == null) {
      return this._outline(gid);
    }
    return this._outline(gid, this._normCoords(userCoords));
  }

  /// Memoized fvar.normalizeCoords: layout calls the variable-glyph
  /// accessors once PER GLYPH with the same coords object, and
  /// normalization (clamp + avar remap + an array allocation) is pure —
  /// cache on identity + content (in-place mutation still invalidates
  /// via the content compare).
  _normCoords(userCoords) {
    const tagged = userCoords != null && typeof userCoords.length !== 'number';
    const axes = tagged ? this.fvar.axes || [] : null;
    const count = tagged ? axes.length : userCoords.length;
    const c = this._ncCache;
    if (c && c.src === userCoords && c.key.length === count) {
      let same = true;
      for (let i = 0; i < count; i++) {
        if (c.key[i] !== (tagged ? userCoords[axes[i].tag] : userCoords[i])) {
          same = false;
          break;
        }
      }
      if (same) return c.norm;
    }
    const norm = this.fvar.normalizeCoords(userCoords);
    const key = tagged
      ? axes.map((axis) => userCoords[axis.tag])
      : Array.prototype.slice.call(userCoords);
    this._ncCache = { src: userCoords, key, norm };
    return norm;
  }

  /** Metrics for an already-resolved glyph id. */
  getMetricsByGid(gid) {
    this._ensure();
    const segs = this._outline(gid);
    return this._computeMetrics(gid, segs);
  }

  /// getMetricsByGid(gid).advance for layout, which asks per slot and would decode the outline each time for a bbox it does not read.
  /// The first ask for a glyph still reads the outline, so a bad one is found and reported at that first ask.
  _advanceByGid(gid) {
    let cache = this._advanceCache;
    if (cache === null) {
      this._ensure();
      cache = this._advanceCache = new Float64Array(this._tables.numGlyphs).fill(-1);
    }
    const known = cache[gid]; // (undefined past the array, for a gid maxp does not count)
    if (known >= 0) return known;
    return (cache[gid] = this.getMetricsByGid(gid).advance);
  }

  /**
   * Layered color-glyph layers for a resolved gid. Returns null
   * when the font has no COLR table OR the gid isn't a color glyph
   * (regular monochrome glyphs aren't in COLR). Callers should fall
   * back to getGlyphSegsByGid(gid) for monochrome rendering.
   *
   * Each layer entry: { segs, rgba, isForeground, glyphId }
   *   segs         em-space outline of the layer's glyph
   *   rgba         [r, g, b, a] resolved from CPAL palette 0, or
   *                null when isForeground === true
   *   isForeground true when the layer's paletteIndex is 0xFFFF
   *                (callers substitute the run color)
   *   glyphId      the layer glyph's own gid (info / debug)
   *
   * Layer order is paint-order (back to front).
   *
   * Advance + bbox of the COLORED glyph are the BASE glyph's
   * (use getMetricsByGid on the base gid). Layers may extend
   * slightly past the base's ink bbox; that's a property of how
   * the font is authored.
   *
   * @param {number} gid
   * @returns {{segs: object[], rgba: number[]|null, isForeground: boolean, glyphId: number}[]|null}
   */
  getColoredGlyphByGid(gid, userCoords = null) {
    this._ensure();
    if (!this.colr.hasColor) return null;
    const layerInfos = this.colr.getLayers(gid);
    if (!layerInfos) return null;
    const out = new Array(layerInfos.length);
    for (let i = 0; i < layerInfos.length; i++) {
      const li = layerInfos[i];
      out[i] = {
        segs: this.getGlyphSegsByGidVar(li.glyphId, userCoords),
        rgba: li.rgba,
        isForeground: li.paletteIndex === 0xffff,
        glyphId: li.glyphId,
      };
    }
    return out;
  }

  /** Codepoint convenience for getColoredGlyphByGid. Returns null
   *  when the codepoint isn't a color glyph (caller falls back to
   *  getGlyphSegs). */
  getColoredGlyph(codepoint) {
    this._ensure();
    if (!this.colr.hasColor) return null;
    const gid = this._tables.codepointToGlyphIndex(codepoint);
    if (gid === 0 && codepoint !== 0) return null;
    return this.getColoredGlyphByGid(gid);
  }

  /** True when the font ships a COLRv1 BaseGlyphList in addition to or
   *  instead of the v0 LayerList. v1 glyphs use richer paint trees
   *  (gradients, transforms, composites) and dispatch through the
   *  filter-graph evaluator rather than emitting flat layer shapes. */
  get hasColrV1() {
    this._ensure();
    return this.colr.hasColrV1;
  }

  /** COLRv1: return a `{ graph, glyphSegs, glyphIds }` triple for
   *  a v1-painted glyph, or null when the gid has no v1 paint tree.
   *
   *
   *  Returns null when the font has no COLRv1 table or this gid has
   *  no v1 paint record (caller falls back to v0 layers via
   *  getColoredGlyphByGid, then to the monochrome outline).
   *
   *  @param {number} gid
   *  @param {Float32Array|number[]|null} [coords]  normalized variation
   *    coords; when supplied, PaintVar* nodes interpolate the paint
   *    tree to that instance. Default null = static / default master.
   *  @returns {{ graph: object, glyphSegs: object[], glyphIds: number[],
   *              glyphSegsByGid: Map<number, object[]> }|null}
   */
  getColrV1GraphByGid(gid, coords = null) {
    this._ensure();
    if (!this.colr.hasColrV1) return null;
    const paintTree = this.colr.getPaint(gid, coords);
    if (!paintTree) return null;
    // colrPaintToGraph is registered alongside the COLR reader by
    // font/color (it has no value without colr). Treat as a guard:
    // if COLR is registered but the paint-graph converter isn't,
    // skip v1 rendering and let the caller fall back.
    const colrPaintToGraph = getReaderCtor('colrPaintToGraph');
    if (!colrPaintToGraph) return null;
    let graph;
    try {
      graph = colrPaintToGraph(paintTree, this.colr, coords, gid);
    } catch (e) {
      dropTable(this._tables, 'COLR', ['colr', 'cpal'], e);
      this._colr = null;
      return null;
    }
    if (!graph || !graph.nodes.length) return null;
    if (this._colrChrome) {
      for (const n of graph.nodes) if (n.type.endsWith('Gradient')) n.params.stopsChrome = true;
    }
    // Collect every glyphId referenced by PaintGlyph nodes — the
    // renderer needs to render each one's silhouette into a mask
    // before evaluating the graph.
    const glyphIds = new Set([gid]);
    for (const n of graph.nodes) {
      if (n.type === 'PaintGlyph' && n.params && typeof n.params.glyphId === 'number') {
        glyphIds.add(n.params.glyphId);
      }
    }

    let glyphSegs = this._outline(gid, coords) || [];
    if (glyphSegs.length === 0) {
      for (const n of graph.nodes) {
        if (n.type === 'PaintGlyph' && n.params && typeof n.params.glyphId === 'number') {
          const alt = this._outline(n.params.glyphId, coords);
          if (alt && alt.length) {
            glyphSegs = alt;
            break;
          }
        }
      }
    }
    // Per-PaintGlyph silhouette outlines: one segs array per distinct
    // PaintGlyph.glyphId referenced inside the graph. The renderer
    // bakes each into its own alpha mask FBO so PaintGlyph nodes at
    // non-root positions clip by their own gid's outline (not the
    // top-level silhouette). Map<gid → segs[]>. Always includes the
    // primary gid keyed under `gid` for completeness.
    const glyphSegsByGid = new Map();
    glyphSegsByGid.set(gid, glyphSegs);
    for (const n of graph.nodes) {
      if (n.type === 'PaintGlyph' && n.params && typeof n.params.glyphId === 'number') {
        const g = n.params.glyphId;
        if (!glyphSegsByGid.has(g)) {
          glyphSegsByGid.set(g, this._outline(g, coords) || []);
        }
      }
    }
    return {
      graph,
      glyphSegs,
      glyphIds: Array.from(glyphIds),
      glyphSegsByGid,
    };
  }

  /**
   * @param {number} codepoint
   * @returns {Array|null} segs in em-space (+Y up), or null if no glyph
   */
  getGlyphSegs(codepoint) {
    this._ensure();
    const hit = this._cache.tryGet(codepoint);
    if (hit) return hit.segs;
    const gid = this._tables.codepointToGlyphIndex(codepoint);
    if (gid === 0 && codepoint !== 0) return null;
    const segs = this._outline(gid);
    const metrics = this._computeMetrics(gid, segs);
    this._cache.put(codepoint, segs, metrics);
    return segs;
  }

  /**
   * @param {number} codepoint
   * @returns {MantleGlyphMetrics}
   */
  getMetrics(codepoint) {
    this._ensure();
    const hit = this._cache.tryGet(codepoint);
    if (hit) return hit.metrics;
    const gid = this._tables.codepointToGlyphIndex(codepoint);
    if (gid === 0 && codepoint !== 0) {
      return { advance: 0, leftBearing: 0, ascent: 0, descent: 0, bbox: [0, 0, 0, 0] };
    }
    const segs = this._outline(gid);
    const metrics = this._computeMetrics(gid, segs);
    this._cache.put(codepoint, segs, metrics);
    return metrics;
  }

  /** Legacy no-op stub — always returns 0. Kerning is applied by the
   *  GPOS pass during shaping, not through this hook. */
  getKerning(_a, _b) {
    return 0;
  }

  _ensure() {
    if (this._tables) return;
    if (!this._ttfBytes || this._ttfBytes.length === 0)
      throw new Error('MantleFontAsset has no .ttf bytes');
    this._tables = parseTtfTables(this._ttfBytes, this._faceIndex);
    this.unitsPerEm = this._tables.unitsPerEm;
    const inv = this.unitsPerEm > 0 ? 1 / this.unitsPerEm : 0;
    this.ascent = this._tables.ascender * inv;
    this.descent = this._tables.descender * inv;
    this.lineGap = this._tables.lineGap * inv;

    this.capHeight = this._tables.os2CapHeight * inv;
    this.xHeight = this._tables.os2xHeight * inv;
    if (!(this.capHeight > 0)) this.capHeight = this._measureGlyphHeight('H'.charCodeAt(0));
    if (!(this.xHeight > 0)) this.xHeight = this._measureGlyphHeight('x'.charCodeAt(0));
    this.underlinePosition = this._tables.postUnderlinePosition * inv;
    this.underlineThickness = this._tables.postUnderlineThickness * inv;
    // A font without a usable OS/2 strikeout takes the underline's thickness, centered at half the x-height.
    this.strikeoutSize =
      this._tables.os2StrikeoutSize > 0
        ? this._tables.os2StrikeoutSize * inv
        : this.underlineThickness;
    this.strikeoutPosition =
      this._tables.os2StrikeoutSize > 0
        ? this._tables.os2StrikeoutPosition * inv
        : this.xHeight * 0.5 + this.strikeoutSize * 0.5;
    this.subscriptOffset = this._tables.os2SubscriptOffset * inv;
    this.superscriptOffset = this._tables.os2SuperscriptOffset * inv;
    this.italicAngle = this._tables.postItalicAngle || 0;
    // Populate display names from the 'name' table when present.
    // Preferred typographic names (IDs 16/17) win over legacy 1/2.
    this._tables.nameCompat = this._compat;
    this._name = this._reader('name', () => new NameTable(this._tables));
    if (this._name.hasNames) {
      const { family, subfamily } = this._name.resolveFamily();
      this.familyName = family;
      this.styleName = subfamily;
      this.fullName = this._name.get(4) || '';
      this.postScriptName = this._name.postScriptName || '';
    }
  }

  /** Name table accessor; lazily populated by _ensure. */
  get name() {
    this._ensure();
    return this._name;
  }

  /// fvar reader. Null-object (isVariable=false) when font/variations
  /// hasn't been registered. font/variations registers fvar + hvar +
  /// vvar + mvar + (transitive) gvar + avar + IVS as a group.
  get fvar() {
    this._ensure();
    if (this._fvar == null) this._fvar = this._reader('fvar');
    return this._fvar;
  }
  /** True iff this font ships variation axes (fvar table present). */
  get isVariable() {
    return this.fvar.isVariable;
  }

  /// HVAR (horizontal metric variations). Null-object (0-delta) when
  /// font/variations not registered or font has no HVAR.
  get hvar() {
    this._ensure();
    if (this._hvar == null) this._hvar = this._reader('hvar');
    return this._hvar;
  }

  /// VVAR (vertical metric variations). Null-object when font/variations
  /// not registered.
  get vvar() {
    this._ensure();
    if (this._vvar == null) this._vvar = this._reader('vvar');
    return this._vvar;
  }

  /// GDEF (Glyph Definition) — always ON. Used by GSUB/GPOS
  /// lookupFlag filtering and cursor placement inside ligatures;
  /// dropping it would break basic kerning + ligature behavior.
  get gdef() {
    this._ensure();
    if (this._gdef == null) this._gdef = this._reader('gdef', () => new GdefReader(this._tables));
    return this._gdef;
  }

  /// VORG (Vertical Origin). Null-object when font/vertical not
  /// registered. Used only in vertical writing-mode rendering.
  get vorg() {
    this._ensure();
    if (this._vorg == null) this._vorg = this._reader('vorg');
    return this._vorg;
  }

  /// BASE (Baseline alignment). Null-object when font/baseline not
  /// registered. Used for mixed-script line alignment.
  get base() {
    this._ensure();
    if (this._base == null) this._base = this._reader('base');
    return this._base;
  }

  /// JSTF (justification) reader; lazily built. Null-object when not
  /// registered. Supplies Arabic kashida extender glyphs for the
  /// justify path.
  get jstf() {
    this._ensure();
    if (this._jstf == null) this._jstf = this._reader('jstf');
    return this._jstf;
  }

  /// AAT 'morx' glyph-metamorphosis reader; lazily built. Null-object
  /// when not registered. Drives shaping for AAT-only fonts.
  get morx() {
    this._ensure();
    if (this._morx == null) this._morx = this._reader('morx');
    return this._morx;
  }

  /// AAT 'kerx' extended-kerning reader; lazily built. Null-object when
  /// not registered.
  get kerx() {
    this._ensure();
    if (this._kerx == null) this._kerx = this._reader('kerx');
    return this._kerx;
  }

  /// AAT 'trak' tracking reader; lazily built. Null-object when not registered.
  get trak() {
    this._ensure();
    if (this._trak == null) this._trak = this._reader('trak');
    return this._trak;
  }

  /// True when AAT contextual/anchor kerning (kerx format 1/4) should run:
  /// the font ships such a subtable and has NO GSUB (HarfBuzz uses the AAT
  /// positioning path when the OpenType one isn't present).
  get usesAatKerning() {
    this._ensure();
    return (
      !this._tables.gsub &&
      (this.kerx.hasContextualKerning || (!this.kerx.hasKerx && this.legacyKern.hasStateKerning))
    );
  }

  /// AAT 'feat' feature-name reader; lazily built. Metadata for a
  /// feature-picker UI; does not change default shaping.
  get feat() {
    this._ensure();
    if (this._feat == null) this._feat = this._reader('feat');
    return this._feat;
  }

  // ---- Font-picker API -----------------------------------------------------------------------------------------
  // Describes what a font offers (axes with named values, named instances, layout features) and names a location.
  // Requires the opt-in readers it reads: font/variations (fvar, STAT), font/typography/aat (feat).

  /** A complete axis location: `partial` ({ tag: value }) over the fvar defaults. */
  styleLocation(partial = null) {
    const loc = {};
    for (const a of this.fvar.axes || []) loc[a.tag] = a.default;
    if (partial) for (const k of Object.keys(partial)) loc[k] = partial[k];
    return loc;
  }

  /** The STAT naming order this font uses by default: 'spec' (axisOrdering) or 'fonttools' (design-axis index). */
  get statNaming() {
    return this._statNaming;
  }

  /** STAT AxisValue tables that name `location` (defaults for the unset axes), in name order. `naming` overrides the font's statNaming. */
  styleAxisValues(location = null, naming = this._statNaming) {
    return this.stat.hasTable
      ? this.stat.selectAxisValues(
          this.styleLocation(location),
          naming === 'fonttools' ? 'fonttools' : 'spec',
        )
      : [];
  }

  /**
   * The automatic style name of `location` per the STAT specification (non-elidable axis value names joined in
   * axisOrdering order; the elided fallback name when all are elidable). With `naming` (or the font's statNaming)
   * 'fonttools' the names join in design-axis order, as fontTools does. Without STAT: the name of the fvar named instance
   * at exactly that location, else null.
   */
  instanceStyleName(location = null, naming = this._statNaming) {
    const loc = this.styleLocation(location);
    const nameOf = (id) => this.name.get(id);
    if (this.stat.hasTable && this.stat.axisValues.length > 0)
      return this.stat.styleName(loc, nameOf, naming === 'fonttools' ? 'fonttools' : 'spec');
    const axes = this.fvar.axes || [];
    for (const inst of this.fvar.instances || [])
      if (axes.every((a, i) => inst.coords[i] === loc[a.tag])) return inst.subfamilyName || null;
    return null;
  }

  /**
   * Legacy RIBBI name records for `location`, as fontTools' instancer writes them (`_updateNameRecords`): the STAT values that
   * are Regular/Italic/Bold/Bold Italic make the style-linked subfamily (ID 2), the rest extend the family (ID 1) and form
   * the typographic subfamily (ID 17) under the typographic family (ID 16). Always design-axis order. Needs STAT and name
   * records 1, 2 and the STAT elided fallback. Returns null when a specified axis has no exact nominal STAT value;
   * range-based picker naming is unchanged.
   * @returns {{ familyName: string, subfamilyName: string, typographicFamilyName: string|null,
   *   typographicSubfamilyName: string|null, fullName: string, postScriptName: string }|null}
   */
  ribbiNames(location = null) {
    if (!this.stat.hasTable) return null;
    const loc = this.styleLocation(location);
    const nm = this.name;
    const elided = this.stat.elidedFallbackNameID;
    const elidedName = elided !== 0xffff ? nm.get(elided) : null;
    const fam1 = nm.get(1),
      sub2 = nm.get(2);
    if (!fam1 || !sub2 || !elidedName) return null;
    const selected = statInstancingValues(this.stat, loc);
    if (!selected) return null;
    const RIBBI = new Set(['Regular', 'Italic', 'Bold', 'Bold Italic']);
    // FontTools classifies the name ID by its Windows Unicode English record, even when returning another platform's names.
    const english = new Map();
    for (const r of nm.decodedRecords())
      if (
        r.platformID === 3 &&
        r.encodingID === 1 &&
        r.languageID === 0x409 &&
        !english.has(r.nameID)
      )
        english.set(r.nameID, r.text);
    const isRibbi = (id) => RIBBI.has(english.get(id));
    const values = selected
      .filter((av) => !av.elidable)
      .map((av) => ({ id: av.valueNameID, name: nm.get(av.valueNameID) }));
    if (values.some((v) => !v.name)) return null;
    const names = values.map((v) => v.name);
    const ribbi = values.filter((v) => isRibbi(v.id)).map((v) => v.name);
    const other = values.filter((v) => !isRibbi(v.id)).map((v) => v.name);
    let subfamily = ribbi.join(' ');
    let typo = other.length ? names.join(' ') : '';
    if (!typo && !subfamily) {
      if (isRibbi(elided)) subfamily = elidedName;
      else typo = elidedName;
    }
    const curFamily = nm.get(16) || fam1;
    const familyName = typo ? `${curFamily} ${other.join(' ')}`.trim() : curFamily;
    const subfamilyName = subfamily || 'Regular';
    const typographicFamilyName = typo ? curFamily : null;
    const typographicSubfamilyName = typo || null;
    const newFamily = typographicFamilyName || familyName,
      newStyle = typographicSubfamilyName || subfamilyName;
    let ps = `${nm.get(25) || newFamily}-${newStyle}`.replace(/[^A-Za-z0-9-]/g, '');
    if (ps.length > 127) ps = `${ps.slice(0, 124)}...`;
    return {
      familyName,
      subfamilyName,
      typographicFamilyName,
      typographicSubfamilyName,
      fullName: `${newFamily} ${newStyle}`,
      postScriptName: ps,
    };
  }

  /**
   * Everything a font-picker UI needs, as plain owned data:
   *   axes: [{ tag, name, min, default, max, hidden, ordering, values: [{ name, value, rangeMin, rangeMax,
   *            linkedValue, elidable, olderSibling }] }]   (fvar axes; STAT design axes for a static font)
   *   combinations: [{ name, elidable, records: [{ axisTag, value }] }]   (STAT format 4)
   *   instances: [{ name, postScriptName, location: { tag: value }, styleName }]
   *   features: openTypeFeatureCatalog entries with `name` resolved; aatFeatures: feat entries with names resolved.
   */
  pickerCatalog() {
    const nameOf = (id) => (id ? this.name.get(id) || '' : '');
    const fvarAxes = this.fvar.axes || [];
    const statAxes = this.stat.axes || [];
    const ordering = new Map(statAxes.map((a) => [a.tag, a.ordering]));
    const tagStr = (t) =>
      String.fromCharCode((t >>> 24) & 255, (t >>> 16) & 255, (t >>> 8) & 255, t & 255);
    const avs = this.stat.hasTable ? this.stat.axisValues : [];
    const valuesFor = (tag) =>
      avs
        .filter((a) => a.format !== 4 && a.axisTag === tag)
        .map((a) => ({
          name: nameOf(a.valueNameID),
          value: a.value,
          rangeMin: a.rangeMin,
          rangeMax: a.rangeMax,
          linkedValue: a.linkedValue,
          elidable: a.elidable,
          olderSibling: a.olderSibling,
        }));
    const axes = fvarAxes.length
      ? fvarAxes.map((a) => ({
          tag: a.tag,
          name: a.name || '',
          min: a.min,
          default: a.default,
          max: a.max,
          hidden: a.hidden,
          ordering: ordering.get(a.tagInt) ?? null,
          values: valuesFor(a.tag),
        }))
      : statAxes.map((a) => ({
          tag: tagStr(a.tag),
          name: nameOf(a.nameID),
          min: null,
          default: null,
          max: null,
          hidden: false,
          ordering: a.ordering,
          values: valuesFor(tagStr(a.tag)),
        }));
    const combinations = avs
      .filter((a) => a.format === 4)
      .map((a) => ({
        name: nameOf(a.valueNameID),
        elidable: a.elidable,
        records: a.records.map((r) => ({ axisTag: r.axisTag, value: r.value })),
      }));
    const instances = (this.fvar.instances || []).map((inst) => {
      const location = {};
      fvarAxes.forEach((a, i) => {
        location[a.tag] = inst.coords[i];
      });
      return {
        name: inst.subfamilyName || '',
        postScriptName: inst.postScriptName || '',
        location,
        styleName: this.instanceStyleName(location),
      };
    });
    let catalog = [];
    try {
      catalog = openTypeFeatureCatalog(this._tables);
    } catch (e) {
      noteMalformedTable(this._tables, 'GSUB/GPOS', e, 'kept, its feature list not read');
    }
    const features = catalog.map((f) => ({ ...f, name: nameOf(f.uiNameID) }));
    const aatFeatures = (this.feat.features || []).map((f) => ({
      id: f.feature,
      exclusive: f.exclusive,
      name: f.nameIndex > 0 ? nameOf(f.nameIndex) : '',
      settings: f.settings.map((s) => ({
        value: s.value,
        name: s.nameIndex > 0 ? nameOf(s.nameIndex) : '',
      })),
    }));
    return { axes, combinations, instances, features, aatFeatures };
  }

  /// AAT legacy 'mort' metamorphosis reader; lazily built. Null-object
  /// when not registered. Preferred only when there's no 'morx'.
  get mort() {
    this._ensure();
    if (this._mort == null) this._mort = this._reader('mort');
    return this._mort;
  }

  /// True when the font carries AAT glyph metamorphosis (morx or legacy mort), whatever else it has.
  get hasAatSubstitution() {
    this._ensure();
    return this.morx.hasMorx || this.mort.hasMort;
  }

  /// True when the font shapes via AAT (has morx or legacy mort) and
  /// carries no GSUB table. Layout can also select AAT for fonts with both
  /// through preferAat or HarfBuzz compatibility.
  get usesAatShaping() {
    this._ensure();
    return (this.morx.hasMorx || this.mort.hasMort) && !this._tables.gsub;
  }

  /// Run AAT glyph metamorphosis over a glyph-id run, preferring the
  /// modern 'morx' table over the legacy 'mort' (matching CoreText /
  /// HarfBuzz). Returns { gids, src } — see AatMorx.apply.
  applyAatShaping(gids, rtl = false) {
    this._ensure();
    if (this.morx.hasMorx) return this.morx.apply(gids, rtl);
    if (this.mort.hasMort) return this.mort.apply(gids);
    return { gids: gids.slice(), src: gids.map((_, i) => i) };
  }

  /// STAT (Style Attributes). Null-object when font/variations not
  /// registered (STAT lives in the same opt-in group as fvar etc.).
  get stat() {
    this._ensure();
    if (this._stat == null) this._stat = this._reader('stat');
    return this._stat;
  }

  /// MATH (Math typesetting). Null-object when font/math not
  /// registered. Pairs with the math script-shaper at the textRun
  /// level: math content needs both font/scripts/math (stretchy
  /// codepoint detection) AND font/math (the MATH table reader).
  get math() {
    this._ensure();
    if (this._math == null) this._math = this._reader('math');
    return this._math;
  }

  /// MVAR (font-wide metrics variations). Null-object when
  /// font/variations not registered.
  get mvar() {
    this._ensure();
    if (this._mvar == null) this._mvar = this._reader('mvar');
    return this._mvar;
  }

  /// Variation-aware font-wide metrics (ascender, descender, lineGap,
  /// underlinePosition, underlineThickness) at USER-SPACE axis coords.
  /// Returns an object with em-normalized values. Falls back to the
  /// static font.ascent / .descent / etc when this font isn't variable
  /// or doesn't ship MVAR.
  getMetricsVar(userCoords) {
    this._ensure();
    const inv = this.unitsPerEm > 0 ? 1 / this.unitsPerEm : 0;
    if (!this.isVariable || userCoords == null || !this.mvar.hasMvar) {
      return {
        ascent: this.ascent,
        descent: this.descent,
        lineGap: this.lineGap,
        capHeight: this.capHeight,
        xHeight: this.xHeight,
        underlinePosition: this.underlinePosition,
        underlineThickness: this.underlineThickness,
        strikeoutPosition: this.strikeoutPosition,
        strikeoutSize: this.strikeoutSize,
      };
    }
    const n = this._normCoords(userCoords);
    return {
      ascent: this.ascent + this.mvar.delta('hasc', n) * inv,
      descent: this.descent + this.mvar.delta('hdsc', n) * inv,
      lineGap: this.lineGap + this.mvar.delta('hlgp', n) * inv,
      // OS/2 capHeight + xHeight variations live under MVAR tags
      // 'cpht' (cap height) and 'xhgt' (x-height). Falls back to the
      // static values when the font's MVAR doesn't carry those tags.
      capHeight: this.capHeight + this.mvar.delta('cpht', n) * inv,
      xHeight: this.xHeight + this.mvar.delta('xhgt', n) * inv,
      underlinePosition: this.underlinePosition + this.mvar.delta('undo', n) * inv,
      underlineThickness: this.underlineThickness + this.mvar.delta('unds', n) * inv,
      strikeoutPosition: this.strikeoutPosition + this.mvar.delta('stro', n) * inv,
      strikeoutSize: this.strikeoutSize + this.mvar.delta('strs', n) * inv,
    };
  }

  /// Font-wide metrics packet. Returns the FONT's
  /// typographic metrics (NOT per-string ink bounds) in em-normalized
  /// form, ready for layout consumers to scale + position text
  /// against `fontSize × emHeight` instead of the per-string bbox.
  ///
  /// Ascent / descent are positive distances FROM the baseline (the font's
  /// internal `descent` field is NEGATIVE; this getter returns its
  /// magnitude so layout doesn't have to think about sign).
  ///
  /// `emHeight = ascent + descent` is the canonical "line height of a
  /// single line, no extra leading" — the value the layout
  /// scales screen px against to keep on-screen heights consistent
  /// across strings.
  ///
  /// When `userCoords` is supplied AND this font is variable, returns
  /// metrics interpolated to those axis values via MVAR. The result
  /// is also stable across `setText()` for the same bundle (the
  /// bundle snapshots them at build time).
  fontMetrics(userCoords = null) {
    this._ensure();
    const m = userCoords != null ? this.getMetricsVar(userCoords) : null;
    const ascent = m ? m.ascent : this.ascent;
    const descNeg = m ? m.descent : this.descent; // negative
    const lineGap = m ? m.lineGap : this.lineGap;
    const capH = m ? m.capHeight : this.capHeight;
    const xH = m ? m.xHeight : this.xHeight;
    const descent = -descNeg; // positive
    return {
      unitsPerEm: this.unitsPerEm,
      ascent,
      descent,
      lineGap,
      capHeight: capH,
      xHeight: xH,
      emHeight: ascent + descent,
    };
  }

  /// Advance width for `gid` morphed by USER-SPACE axis coords.
  /// Falls back to static hmtx when:
  ///   * the font isn't variable, OR
  ///   * userCoords is null, OR
  ///   * HVAR is absent — phantom-point advance from gvar when present.
  /// Returns advance in em units.
  getGlyphAdvanceVar(gid, userCoords) {
    this._ensure();
    const inv = this.unitsPerEm > 0 ? 1 / this.unitsPerEm : 0;
    const baseFu = this._tables.glyphAdvanceWidth(gid);
    if (!this.isVariable || userCoords == null) {
      return baseFu * inv;
    }
    if (this.hvar.hasHvar) {
      const n = this._normCoords(userCoords);
      const deltaFu = this.hvar.advanceDelta(gid, n);
      return (baseFu + deltaFu) * inv;
    }
    const n = this._normCoords(userCoords);
    // Default-instance layout uses hmtx; nondefault gvar instances may inherit component phantoms.
    if (n.every((value) => value === 0)) return baseFu * inv;
    const advFu = this._gvarMetric(() => glyphGvarAdvanceFu(gid, this._tables, n));
    if (advFu != null) return advFu * inv;
    return baseFu * inv;
  }

  _computeMetrics(gid, segs) {
    const inv = this.unitsPerEm > 0 ? 1 / this.unitsPerEm : 0;
    const adv = this._tables.glyphAdvanceWidth(gid) * inv;
    const lsb = this._tables.glyphLeftSideBearing(gid) * inv;
    let bbox = [0, 0, 0, 0];
    if (segs && segs.length > 0) {
      let xmin = Infinity,
        ymin = Infinity,
        xmax = -Infinity,
        ymax = -Infinity;
      const acc = (p) => {
        if (p[0] < xmin) xmin = p[0];
        if (p[0] > xmax) xmax = p[0];
        if (p[1] < ymin) ymin = p[1];
        if (p[1] > ymax) ymax = p[1];
      };
      for (const s of segs) {
        acc(s.p1);
        if (s.type === 0) acc(s.p2);
        else if (s.type === 1) {
          acc(s.p2);
          acc(s.p3);
        } else if (s.type === 2) {
          acc(s.p2);
          acc(s.p3);
          acc(s.p4);
        }
      }
      bbox = [xmin * inv, ymin * inv, xmax * inv, ymax * inv];
    }
    return { advance: adv, leftBearing: lsb, ascent: this.ascent, descent: this.descent, bbox };
  }

  /// Em-normalized distance from baseline (y=0) to the topmost y of
  /// the glyph for `codepoint`. Used as the capHeight / xHeight
  /// fallback when OS/2 v2+ sxHeight / sCapHeight aren't present.
  /// Returns 0 when the glyph is missing or has no segments
  /// (e.g. .notdef on a stripped font); callers can detect 0 and
  /// substitute a reasonable default (typical capHeight ≈ 0.7 em,
  /// xHeight ≈ 0.5 em).
  _measureGlyphHeight(codepoint) {
    const inv = this.unitsPerEm > 0 ? 1 / this.unitsPerEm : 0;
    if (inv === 0) return 0;
    const gid = this._tables.codepointToGlyphIndex(codepoint);
    if (!gid) return 0;
    const segs = this._outline(gid);
    if (!segs || segs.length === 0) return 0;
    let ymax = -Infinity;
    const acc = (p) => {
      if (p[1] > ymax) ymax = p[1];
    };
    for (const s of segs) {
      acc(s.p1);
      if (s.type === 0) acc(s.p2);
      else if (s.type === 1) {
        acc(s.p2);
        acc(s.p3);
      } else if (s.type === 2) {
        acc(s.p2);
        acc(s.p3);
        acc(s.p4);
      }
    }
    return ymax === -Infinity ? 0 : ymax * inv;
  }

  /// Vertical metrics — returns advance height (em) + topSideBearing
  /// (em) for vertical-writing layout. Falls back to advance=1.0 (one
  /// em-box height) when the font has no vmtx, which is the
  /// conventional default for ideograph fonts.
  getVerticalMetricsByGid(gid) {
    this._ensure();
    const inv = this.unitsPerEm > 0 ? 1 / this.unitsPerEm : 0;
    return {
      advanceHeight: this._tables.glyphAdvanceHeight(gid) * inv,
      topSideBearing: this._tables.glyphTopSideBearing(gid) * inv,
    };
  }

  /// Vertical advance at user-space axis coordinates. VVAR is authoritative;
  /// otherwise use available gvar phantom-point metrics, then static vmtx.
  /// @param {number} gid
  /// @param {Record<string, number>|number[]|null} userCoords
  getGlyphVerticalAdvanceVar(gid, userCoords) {
    this._ensure();
    const inv = this.unitsPerEm > 0 ? 1 / this.unitsPerEm : 0;
    const base = this._tables.glyphAdvanceHeight(gid);
    if (!this.isVariable || userCoords == null) return base * inv;
    const normalized = this._normCoords(userCoords);
    if (this.vvar.hasVvar) return (base + this.vvar.advanceDelta(gid, normalized)) * inv;
    if (!this.hasVerticalMetrics || normalized.every((value) => value === 0)) return base * inv;
    const varied = this._gvarMetric(() => glyphGvarAdvanceFu(gid, this._tables, normalized, true));
    return (varied == null ? base : varied) * inv;
  }

  /// True iff this font ships a vmtx table.
  get hasVerticalMetrics() {
    this._ensure();
    return this._tables.vmtx != null;
  }

  /// Unified vertical origin (em) — distance from the glyph cell's
  /// baseline up to the glyph's vertical origin point. Used by
  /// vertical-mode layout to position each glyph in its cell.
  ///
  /// @param {number} gid
  /// @param {Record<string, number>|number[]|null} [userCoords]
  getVerticalOriginY(gid, userCoords = null) {
    this._ensure();
    const inv = this.unitsPerEm > 0 ? 1 / this.unitsPerEm : 0;
    const normalized = this.isVariable && userCoords != null ? this._normCoords(userCoords) : null;
    if (this.vorg.hasTable) {
      const delta =
        normalized != null && this._tables.cff2 ? this.vvar.originDelta(gid, normalized) : 0;
      return (this.vorg.getVertOriginY(gid) + delta) * inv;
    }
    if (this.hasVerticalMetrics && this._tables.glyf) {
      const origin = this._gvarMetric(() => glyphVerticalOriginFu(gid, this._tables, normalized));
      if (origin != null) return origin * inv;
      // glyf bounds include off-curve controls; use the declared yMax.
      const [offset, length] = this._tables.glyphRange(gid);
      const top =
        length >= 10 && offset + 10 <= this._tables.view.byteLength
          ? this._tables.view.getInt16(offset + 8, false)
          : 0;
      return (top + this._tables.glyphTopSideBearing(gid)) * inv;
    }
    if (this.hasVerticalMetrics) {
      // CFF/CFF2 have no stored glyph bounds. The vertical origin uses
      // the CharString's curve bounds plus its top side bearing.
      const segs = this._outline(gid, normalized);
      let top = -Infinity;
      const box = [0, 0, 0, 0];
      if (segs)
        for (const seg of segs) {
          segBboxInto(seg, box, 0);
          top = Math.max(top, box[3]);
        }
      const delta =
        normalized != null && this._tables.cff2 ? this.vvar.tsbDelta(gid, normalized) : 0;
      return (
        ((Number.isFinite(top) ? top : 0) + this._tables.glyphTopSideBearing(gid) + delta) * inv
      );
    }
    // No vmtx, no VORG — use vertTypoAscender if available, else half em.
    return (this._tables.vertTypoAscender || this.unitsPerEm * 0.5) * inv;
  }

  /// vhea typographic ascender (em) — distance from origin up to top
  /// of glyph cell. Used by vertical-mode line spacing. 0 when no vhea.
  get vertTypoAscender() {
    this._ensure();
    return (this._tables.vertTypoAscender || 0) * (this.unitsPerEm > 0 ? 1 / this.unitsPerEm : 0);
  }
  get vertTypoDescender() {
    this._ensure();
    return (this._tables.vertTypoDescender || 0) * (this.unitsPerEm > 0 ? 1 / this.unitsPerEm : 0);
  }
  get vertTypoLineGap() {
    this._ensure();
    return (this._tables.vertTypoLineGap || 0) * (this.unitsPerEm > 0 ? 1 / this.unitsPerEm : 0);
  }
}

// Instancer naming uses exact nominal values, independently of the STAT range names shown in a font picker.
function statInstancingValues(stat, location) {
  const values = stat.axisValues;
  if (values.some((v) => v.format === 4 && v.records.length === 0)) return null;
  const matches = values.filter((v) =>
    v.format === 4
      ? v.records.every((r) => location[r.axisTag] === r.value)
      : location[v.axisTag] === (v.format === 2 ? v.nominalValue : v.value),
  );
  const relevant = new Set(),
    covered = new Set();
  for (const v of values)
    for (const tag of v.format === 4 ? v.records.map((r) => r.axisTag) : [v.axisTag])
      relevant.add(tag);
  for (const v of matches)
    for (const tag of v.format === 4 ? v.records.map((r) => r.axisTag) : [v.axisTag])
      covered.add(tag);
  if (Object.keys(location).some((tag) => relevant.has(tag) && !covered.has(tag))) return null;
  const visible = matches.filter((v) => !v.elidable);
  const taken = new Set(),
    picked = [];
  for (const v of visible
    .filter((v) => v.format === 4)
    .sort((a, b) => b.records.length - a.records.length)) {
    const indices = v.records.map((r) => r.axisIndex);
    if (indices.some((i) => taken.has(i))) continue;
    for (const i of indices) taken.add(i);
    picked.push({ value: v, index: Math.min(...indices) });
  }
  for (const v of visible)
    if (v.format !== 4 && !taken.has(v.axisIndex)) {
      taken.add(v.axisIndex);
      picked.push({ value: v, index: v.axisIndex });
    }
  return picked.sort((a, b) => a.index - b.index).map((p) => p.value);
}
