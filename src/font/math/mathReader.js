// mathReader.js — OpenType 'MATH' table (math typesetting).
//
// For math-equipped fonts (STIX Two Math, Cambria Math, Latin Modern
// Math) the MATH table provides:
//
//   1. Per-glyph italic correction — extra X advance after a slanted
//      math letter when followed by non-italic content (else 'f('
//      overlaps).
//   2. Top-accent attachment — anchor X for combining math accents
//      (U+20D6..U+20E1) above slanted glyphs.
//   3. Per-corner math kern — sub/sup placement relative to base.
//   4. MathConstants — font-wide constants (axis height, fraction
//      bar thickness, subscript shift, etc.) used by layout.
//   5. MathVariants — stretchy parens / integrals / roots with
//      pre-built variants + assembly recipes.
//
// Spec: https://learn.microsoft.com/en-us/typography/opentype/spec/math

import { coverageIndex } from '../otCommon.js';

/// Selected MathConstants fields. Order matches the spec; device-table
/// tweaks are not exposed.
export class MathConstants {
  constructor() {
    // Defaults match Microsoft's recommended fallback values; real
    // fonts override.
    this.scriptPercentScaleDown          = 80;
    this.scriptScriptPercentScaleDown    = 60;
    this.delimitedSubFormulaMinHeight    = 0;
    this.displayOperatorMinHeight        = 0;
    this.mathLeading                     = 0;
    this.axisHeight                      = 0;
    this.accentBaseHeight                = 0;
    this.flattenedAccentBaseHeight       = 0;
    this.subscriptShiftDown              = 0;
    this.subscriptTopMax                 = 0;
    this.subscriptBaselineDropMin        = 0;
    this.superscriptShiftUp              = 0;
    this.superscriptShiftUpCramped       = 0;
    this.superscriptBottomMin            = 0;
    this.superscriptBaselineDropMax      = 0;
    this.subSuperscriptGapMin            = 0;
    this.superscriptBottomMaxWithSubscript = 0;
    this.spaceAfterScript                = 0;
    this.upperLimitGapMin                = 0;
    this.upperLimitBaselineRiseMin       = 0;
    this.lowerLimitGapMin                = 0;
    this.lowerLimitBaselineDropMin       = 0;
    this.stackTopShiftUp                 = 0;
    this.stackTopDisplayStyleShiftUp     = 0;
    this.stackBottomShiftDown            = 0;
    this.stackBottomDisplayStyleShiftDown = 0;
    this.stackGapMin                     = 0;
    this.stackDisplayStyleGapMin         = 0;
    this.stretchStackTopShiftUp          = 0;
    this.stretchStackBottomShiftDown     = 0;
    this.stretchStackGapAboveMin         = 0;
    this.stretchStackGapBelowMin         = 0;
    this.fractionNumeratorShiftUp        = 0;
    this.fractionNumeratorDisplayStyleShiftUp = 0;
    this.fractionDenominatorShiftDown    = 0;
    this.fractionDenominatorDisplayStyleShiftDown = 0;
    this.fractionNumeratorGapMin         = 0;
    this.fractionNumDisplayStyleGapMin   = 0;
    this.fractionRuleThickness           = 0;
    this.fractionDenominatorGapMin       = 0;
    this.fractionDenomDisplayStyleGapMin = 0;
    this.skewedFractionHorizontalGap     = 0;
    this.skewedFractionVerticalGap       = 0;
    this.overbarVerticalGap              = 0;
    this.overbarRuleThickness            = 0;
    this.overbarExtraAscender            = 0;
    this.underbarVerticalGap             = 0;
    this.underbarRuleThickness           = 0;
    this.underbarExtraDescender          = 0;
    this.radicalVerticalGap              = 0;
    this.radicalDisplayStyleVerticalGap  = 0;
    this.radicalRuleThickness            = 0;
    this.radicalExtraAscender            = 0;
    this.radicalKernBeforeDegree         = 0;
    this.radicalKernAfterDegree          = 0;
    this.radicalDegreeBottomRaisePercent = 0;
  }
}

/// Math kern corner (matches OT MATH MathKernInfoRecord ordering).
export const MathKernCorner = Object.freeze({
  TopRight:    0,
  TopLeft:     1,
  BottomRight: 2,
  BottomLeft:  3,
});

export class MathReader {
  constructor(tables) {
    this._view = tables.view;
    this._tableOff = -1;
    this._mathConstantsOff = -1;
    this._mathGlyphInfoOff = -1;
    this._mathVariantsOff = -1;
    if (!tables.math) return;
    const off = tables.math[0];
    const v = this._view;
    const major = v.getUint16(off + 0, false);
    if (major !== 1) return;
    this._tableOff = off;
    const constRel = v.getUint16(off + 4, false);
    const giRel    = v.getUint16(off + 6, false);
    const varRel   = v.getUint16(off + 8, false);
    this._mathConstantsOff = constRel ? off + constRel : -1;
    this._mathGlyphInfoOff = giRel    ? off + giRel    : -1;
    this._mathVariantsOff  = varRel   ? off + varRel   : -1;

    // Pre-resolve MathGlyphInfo sub-offsets (cheap).
    if (this._mathGlyphInfoOff >= 0) {
      const gi = this._mathGlyphInfoOff;
      const icRel  = v.getUint16(gi + 0, false);
      const taRel  = v.getUint16(gi + 2, false);
      const esRel  = v.getUint16(gi + 4, false);
      const mkRel  = v.getUint16(gi + 6, false);
      this._italicCorrectionOff   = icRel ? gi + icRel : -1;
      this._topAccentAttachOff    = taRel ? gi + taRel : -1;
      this._extendedShapeCovOff   = esRel ? gi + esRel : -1;
      this._mathKernInfoOff       = mkRel ? gi + mkRel : -1;
    } else {
      this._italicCorrectionOff = this._topAccentAttachOff = -1;
      this._extendedShapeCovOff = this._mathKernInfoOff = -1;
    }
  }

  get hasTable() { return this._tableOff >= 0; }
  get hasMathGlyphInfo() { return this._mathGlyphInfoOff >= 0; }
  get hasMathVariants() { return this._mathVariantsOff >= 0; }

  /// Read MathConstants. Returns a fresh MathConstants object with
  /// all ~57 fields populated from the font (or zeros if absent).
  getConstants() {
    const c = new MathConstants();
    if (this._mathConstantsOff < 0) return c;
    const v = this._view;
    const o = this._mathConstantsOff;
    // First two fields are i16 percentages (no device table).
    c.scriptPercentScaleDown          = v.getInt16(o + 0, false);
    c.scriptScriptPercentScaleDown    = v.getInt16(o + 2, false);
    // Next two are UFWORD (u16) min heights (no device table).
    c.delimitedSubFormulaMinHeight    = v.getUint16(o + 4, false);
    c.displayOperatorMinHeight        = v.getUint16(o + 6, false);
    // Remaining are MathValueRecord (i16 value + u16 device-off); device
    // tables skipped. 51 records × 4 bytes each starting at o+8.
    const fields = [
      'mathLeading', 'axisHeight', 'accentBaseHeight', 'flattenedAccentBaseHeight',
      'subscriptShiftDown', 'subscriptTopMax', 'subscriptBaselineDropMin',
      'superscriptShiftUp', 'superscriptShiftUpCramped',
      'superscriptBottomMin', 'superscriptBaselineDropMax',
      'subSuperscriptGapMin', 'superscriptBottomMaxWithSubscript', 'spaceAfterScript',
      'upperLimitGapMin', 'upperLimitBaselineRiseMin',
      'lowerLimitGapMin', 'lowerLimitBaselineDropMin',
      'stackTopShiftUp', 'stackTopDisplayStyleShiftUp',
      'stackBottomShiftDown', 'stackBottomDisplayStyleShiftDown',
      'stackGapMin', 'stackDisplayStyleGapMin',
      'stretchStackTopShiftUp', 'stretchStackBottomShiftDown',
      'stretchStackGapAboveMin', 'stretchStackGapBelowMin',
      'fractionNumeratorShiftUp', 'fractionNumeratorDisplayStyleShiftUp',
      'fractionDenominatorShiftDown', 'fractionDenominatorDisplayStyleShiftDown',
      'fractionNumeratorGapMin', 'fractionNumDisplayStyleGapMin',
      'fractionRuleThickness',
      'fractionDenominatorGapMin', 'fractionDenomDisplayStyleGapMin',
      'skewedFractionHorizontalGap', 'skewedFractionVerticalGap',
      'overbarVerticalGap', 'overbarRuleThickness', 'overbarExtraAscender',
      'underbarVerticalGap', 'underbarRuleThickness', 'underbarExtraDescender',
      'radicalVerticalGap', 'radicalDisplayStyleVerticalGap',
      'radicalRuleThickness', 'radicalExtraAscender',
      'radicalKernBeforeDegree', 'radicalKernAfterDegree',
    ];
    for (let i = 0; i < fields.length; i++) {
      c[fields[i]] = v.getInt16(o + 8 + i * 4, false);
    }
    // radicalDegreeBottomRaisePercent is the final field; it's i16
    // (not MathValueRecord — no device offset).
    c.radicalDegreeBottomRaisePercent = v.getInt16(o + 8 + fields.length * 4, false);
    return c;
  }

  /// Italic correction for `gid` (font units). Returns 0 when no
  /// per-glyph entry. The italic correction is the extra X advance
  /// added AFTER a slanted glyph so the next glyph doesn't overlap
  /// the slant.
  getItalicCorrection(gid) {
    if (this._italicCorrectionOff < 0) return 0;
    const v = this._view;
    const o = this._italicCorrectionOff;
    const covAbs = o + v.getUint16(o, false);
    const covIdx = coverageIndex(v, covAbs, gid);
    if (covIdx < 0) return 0;
    const count = v.getUint16(o + 2, false);
    if (covIdx >= count) return 0;
    // MathValueRecord at o + 4 + covIdx * 4: i16 value, u16 device.
    return v.getInt16(o + 4 + covIdx * 4, false);
  }

  /// Top-accent attachment X for `gid` (font units, from glyph origin).
  /// Returns NaN when no per-glyph entry; callers should fall back to
  /// glyph-bbox center.
  getTopAccentAttachment(gid) {
    if (this._topAccentAttachOff < 0) return NaN;
    const v = this._view;
    const o = this._topAccentAttachOff;
    const covAbs = o + v.getUint16(o, false);
    const covIdx = coverageIndex(v, covAbs, gid);
    if (covIdx < 0) return NaN;
    const count = v.getUint16(o + 2, false);
    if (covIdx >= count) return NaN;
    return v.getInt16(o + 4 + covIdx * 4, false);
  }

  /// True iff `gid` is in the extendedShapes coverage (font marks it
  /// as a "tall" glyph that should use postscript shift behavior).
  isExtendedShape(gid) {
    if (this._extendedShapeCovOff < 0) return false;
    return coverageIndex(this._view, this._extendedShapeCovOff, gid) >= 0;
  }

  /// MathVariants — vertical/horizontal stretchy glyph variants +
  /// assembly recipes. Returns null when the font has no variants
  /// for `gid` along `axis`.
  ///
  /// `axis` = 'v' (vertical, default for tall delimiters like parens
  /// and n-ary operators) or 'h' (horizontal, for over/under braces).
  ///
  /// Return shape: { variants: [{ glyphID, advance }, ...],
  ///                 assembly?: { italicsCorrection,
  ///                              parts: [{ glyphID, startConn,
  ///                                        endConn, fullAdvance,
  ///                                        isExtender }, ...] } }
  ///
  /// Variants are sorted by advance ascending; advance is in font
  /// units (height for vertical, width for horizontal).
  getMathVariants(gid, axis = 'v') {
    if (this._mathVariantsOff < 0) return null;
    const v = this._view;
    const o = this._mathVariantsOff;
    // u16 minConnectorOverlap, Offset16 vertCovOff, Offset16 horizCovOff,
    // u16 vertGlyphCount, u16 horizGlyphCount, then offsets[]
    const vertCovRel  = v.getUint16(o + 2, false);
    const horizCovRel = v.getUint16(o + 4, false);
    const vertCount   = v.getUint16(o + 6, false);
    const horizCount  = v.getUint16(o + 8, false);
    let covOff, count, offsetsBase;
    if (axis === 'v') {
      if (vertCovRel === 0 || vertCount === 0) return null;
      covOff = o + vertCovRel;
      count = vertCount;
      offsetsBase = o + 10;
    } else {
      if (horizCovRel === 0 || horizCount === 0) return null;
      covOff = o + horizCovRel;
      count = horizCount;
      offsetsBase = o + 10 + vertCount * 2;
    }
    const covIdx = coverageIndex(v, covOff, gid);
    if (covIdx < 0) return null;
    const constructionOff = o + v.getUint16(offsetsBase + covIdx * 2, false);
    // MathGlyphConstruction:
    //   Offset16 glyphAssemblyOff (0 = no assembly)
    //   u16 variantCount
    //   MathGlyphVariantRecord[variantCount] (u16 gid + UFWORD advance, 4 bytes each)
    const asmRel = v.getUint16(constructionOff, false);
    const variantCount = v.getUint16(constructionOff + 2, false);
    const variants = [];
    for (let i = 0; i < variantCount; i++) {
      const recOff = constructionOff + 4 + i * 4;
      variants.push({
        glyphID: v.getUint16(recOff, false),
        advance: v.getUint16(recOff + 2, false),
      });
    }
    let assembly = null;
    if (asmRel !== 0) {
      const asmOff = constructionOff + asmRel;
      // GlyphAssembly:
      //   MathValueRecord italicsCorrection (i16 value + u16 device)
      //   u16 partCount
      //   GlyphPartRecord[partCount] (u16 gid + 3×u16 + u16 flags, 10 bytes)
      const italicsCorr = v.getInt16(asmOff, false);
      const partCount = v.getUint16(asmOff + 4, false);
      const parts = [];
      for (let i = 0; i < partCount; i++) {
        const recOff = asmOff + 6 + i * 10;
        parts.push({
          glyphID:        v.getUint16(recOff, false),
          startConn:      v.getUint16(recOff + 2, false),
          endConn:        v.getUint16(recOff + 4, false),
          fullAdvance:    v.getUint16(recOff + 6, false),
          isExtender:     (v.getUint16(recOff + 8, false) & 1) !== 0,
        });
      }
      assembly = { italicsCorrection: italicsCorr, parts };
    }
    return { variants, assembly };
  }

  /// Pick the smallest variant whose advance ≥ `targetSize` (font
  /// units). Returns `gid` itself if no variants exist or if all
  /// variants are smaller than the target. `axis`: 'v' or 'h'.
  pickVariantForSize(gid, targetSize, axis = 'v') {
    const v = this.getMathVariants(gid, axis);
    if (!v || v.variants.length === 0) return gid;
    // Variants are spec'd as sorted by advance ascending.
    for (const rec of v.variants) {
      if (rec.advance >= targetSize) return rec.glyphID;
    }
    // No variant big enough → return the largest pre-built variant.
    // Use buildAssembly() to stitch a multi-piece glyph for sizes that
    // exceed every pre-built variant.
    return v.variants[v.variants.length - 1].glyphID;
  }

  /// Stitch a multi-piece variant when no single pre-built variant
  /// reaches targetSize. Returns:
  ///   - null if no assembly exists OR a single pre-built variant
  ///     suffices (caller should use pickVariantForSize instead)
  ///   - { axis, totalAdvance, parts: [{ glyphID, offset }, ...] }
  ///     where `offset` is the part's start coordinate in font units
  ///     along the stretching axis (0 = base of the assembly), and
  ///     `totalAdvance` is the assembled glyph's full extent.
  ///
  /// The assembly procedure follows OT MATH spec §6.5 GlyphAssembly:
  ///   1. Sum non-extender part advances minus their pairwise
  ///      overlaps. Each overlap is min(prev.endConn, this.startConn,
  ///      max(minConnectorOverlap, ...)) → call this baseSum.
  ///   2. If baseSum ≥ target → no extenders needed.
  ///   3. Else compute how many extender repetitions n are needed so
  ///      baseSum + n × (extender.fullAdvance − overlap) ≥ target.
  ///      The extender overlap is computed the same way against its
  ///      neighbors.
  ///   4. Emit parts in order, accumulating offsets minus per-pair
  ///      overlaps.
  ///
  /// Returns the largest gid as a fallback when assembly produces
  /// invalid output (zero parts, or extender that doesn't grow).
  buildAssembly(gid, targetSize, axis = 'v') {
    const v = this.getMathVariants(gid, axis);
    if (!v || !v.assembly || v.assembly.parts.length === 0) return null;
    // Read minConnectorOverlap from MathVariants header.
    const minOverlap = this._view.getUint16(this._mathVariantsOff, false);
    const parts = v.assembly.parts;
    // Find extender vs non-extender groups.
    const exts = parts.filter(p => p.isExtender);
    const nonExts = parts.filter(p => !p.isExtender);
    if (nonExts.length === 0 && exts.length === 0) return null;

    // Step 1: pairwise overlap helper between two adjacent parts a,b.
    // Overlap = max(minOverlap, min(a.endConn, b.startConn)). The OT
    // spec says the overlap can be REDUCED toward minOverlap if the
    // assembly is being squeezed; for our "grow to target" path we
    // use the max-possible overlap (= min(endConn, startConn)).
    const pairOverlap = (a, b) => Math.max(minOverlap,
                                    Math.min(a.endConn, b.startConn));

    // Step 2: compute baseSum from non-extenders in order (preserving
    // original spec order from `parts` array).
    let baseSum = 0;
    let prev = null;
    for (const p of nonExts) {
      if (prev) baseSum += p.fullAdvance - pairOverlap(prev, p);
      else baseSum += p.fullAdvance;
      prev = p;
    }

    // If baseSum already covers target, we still need to know
    // extender count = 0; layout uses non-extenders only.
    let extReps = 0;
    if (baseSum < targetSize && exts.length > 0) {
      // Step 3: figure out extender contribution per repetition. With
      // R extenders, each contributes (fullAdvance - pairOverlap).
      // We choose the rep count such that total ≥ target.
      // Take FIRST extender for sizing (most fonts have only one).
      const ext = exts[0];
      const extInc = Math.max(1, ext.fullAdvance - Math.max(minOverlap, ext.startConn));
      extReps = Math.ceil((targetSize - baseSum) / extInc);
      if (extReps < 0) extReps = 0;
    }

    // Step 4: emit parts in spec order, intercalating extender
    // repetitions where extenders appear. The OT model: parts come
    // in declared sequence (e.g. [top-cap, ext, body, ext, bot-cap]);
    // each extender entry can be REPEATED extReps times.
    const out = [];
    let offset = 0;
    let prevPart = null;
    for (const p of parts) {
      const reps = p.isExtender ? extReps : 1;
      for (let r = 0; r < reps; r++) {
        if (prevPart) {
          const overlap = pairOverlap(prevPart, p);
          offset -= overlap;
        }
        out.push({ glyphID: p.glyphID, offset });
        offset += p.fullAdvance;
        prevPart = p;
      }
    }
    return { axis, totalAdvance: offset, parts: out };
  }

  /// Math kern value for `gid` at `corner` (MathKernCorner.*) at the
  /// specified `correctionHeight` (font units from baseline). Returns
  /// 0 when no entry.
  ///
  /// Per spec: MathKern table has correctionHeights[] (sorted ascending
  /// y) + kernValues[N+1]. We pick kernValues[i] where i is the index
  /// of the first correctionHeight > correctionHeight (i.e. find the
  /// "band" the y falls into).
  getMathKern(gid, corner, correctionHeight) {
    if (this._mathKernInfoOff < 0) return 0;
    const v = this._view;
    const o = this._mathKernInfoOff;
    const covAbs = o + v.getUint16(o, false);
    const covIdx = coverageIndex(v, covAbs, gid);
    if (covIdx < 0) return 0;
    const count = v.getUint16(o + 2, false);
    if (covIdx >= count) return 0;
    // MathKernInfoRecord at o + 4 + covIdx * 8:
    //   Offset16 topRightMathKern, Offset16 topLeftMathKern,
    //   Offset16 bottomRightMathKern, Offset16 bottomLeftMathKern
    const recOff = o + 4 + covIdx * 8;
    const cornerOffs = [
      v.getUint16(recOff + 0, false),
      v.getUint16(recOff + 2, false),
      v.getUint16(recOff + 4, false),
      v.getUint16(recOff + 6, false),
    ];
    const kernRel = cornerOffs[corner];
    if (kernRel === 0) return 0;
    const kernOff = o + kernRel;
    // MathKern: u16 heightCount, MathValueRecord correctionHeights[heightCount],
    //           MathValueRecord kernValues[heightCount + 1]
    const heightCount = v.getUint16(kernOff, false);
    // Find first heights[i] > correctionHeight
    let band = 0;
    for (let i = 0; i < heightCount; i++) {
      const h = v.getInt16(kernOff + 2 + i * 4, false);
      if (h > correctionHeight) { band = i; break; }
      band = i + 1;
    }
    return v.getInt16(kernOff + 2 + heightCount * 4 + band * 4, false);
  }
}
