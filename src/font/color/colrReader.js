// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// colrReader.js — COLR v0 + v1 + CPAL v0/v1 readers.
//
// COLR v0: base glyph → ordered list of (layerGlyph, paletteIndex)
// records, each a filled glyph painted in the looked-up color. CPAL
// provides the palette.
//
// COLR v1 EXTENDS v0 with a paint graph: each base glyph maps to a
// tagged-union Paint subtree where nodes are gradients, transforms,
// composites, or solid colors that reference glyphs as alpha masks.
// This reader exposes both:
//   - `hasColor` / `getLayers(gid)`  (v0 surface, unchanged)
//   - `hasColrV1` / `getPaint(gid)`  (v1 surface — returns paint tree)
// Some fonts ship both (v0 as fallback for renderers that don't
// understand v1); a v1 reader checks hasColrV1 first and only falls
// back to v0 when the glyph isn't present in BaseGlyphList.
//
// Paint formats: 1 PaintColrLayers, 2 PaintSolid, gradients (4/6/8),
// transforms (12..29), glyph/composite refs (10/11/32), and their
// variable-axis variants. Unknown formats return a { unsupported }
// sentinel so callers can fall back to v0 or monochrome.
//
// References:
//   https://learn.microsoft.com/en-us/typography/opentype/spec/colr
//   https://learn.microsoft.com/en-us/typography/opentype/spec/cpal

import { ItemVariationStore } from '../itemVariationStore.js';
import { DeltaSetIndexMap } from '../deltaSetIndexMap.js';
import { mantleWarn } from '../../core/diagnostics.js';
import { GlyphOutlineError } from '../glyphReader.js';

const _warnedColrFormats = new Set();

/// One layer of a COLR base glyph. The paint is a flat RGBA tuple
/// (0..1) resolved from CPAL palette 0 by paletteIndex.
/// paletteIndex == 0xFFFF is the foreground-text-color sentinel:
/// callers should substitute the run's primary fill color when
/// rendering. (Used for monochrome layered glyphs that get tinted
/// at render time, e.g. variable-weight emoji.)
export class ColrLayer {
  constructor(glyphId, paletteIndex, rgba) {
    this.glyphId = glyphId;
    this.paletteIndex = paletteIndex;
    this.rgba = rgba; // [r, g, b, a] each 0..1, or null when paletteIndex==0xFFFF
  }
}

/// Paint nodes one glyph may read. The largest real color fonts stay in the low thousands per glyph.
export const MAX_COLR_PAINT_NODES = 1 << 16;

export class ColrReader {
  /** @param {object} tables result of parseTtfTables */
  constructor(tables) {
    this._view = tables.view;
    this._version = -1;
    this._numBase = 0;
    this._baseOff = 0;
    this._layerOff = 0;
    this._numLayers = 0;
    // v1 extension fields. Each *Off is an absolute view-offset (in
    // bytes from view start), 0 if absent.
    this._baseGlyphListOff = 0;
    this._numBaseGlyphV1 = 0;
    this._layerListOff = 0;
    this._numLayerV1 = 0;
    this._clipListOff = 0;
    // Cached palette 0 colors (RGBA 0..1) plus 0xFFFF foreground sentinel.
    this._palette0 = null;
    this._numPaletteEntries = 0;

    if (!tables.colr || !tables.cpal) return;

    const v = this._view;
    const colrOff = tables.colr[0];
    const colrLen = tables.colr[1] || 0;
    this._version = v.getUint16(colrOff + 0, false);
    // v0 fields exist in both v0 and v1 headers (v1 keeps them for
    // backwards-compat fallback). Always read them when present.
    this._numBase = v.getUint16(colrOff + 2, false);
    const baseRel = v.getUint32(colrOff + 4, false);
    const layerRel = v.getUint32(colrOff + 8, false);
    this._baseOff = baseRel ? colrOff + baseRel : 0;
    this._layerOff = layerRel ? colrOff + layerRel : 0;
    this._numLayers = v.getUint16(colrOff + 12, false);

    // v1 header EXTENDS the v0 header by 20 bytes (5 × Offset32).
    // Guard against fonts that claim version=1 but truncate the
    // extension fields (malformed but seen in the wild).
    if (this._version >= 1 && colrLen >= 34) {
      // v1 header continues at offset 14:
      //   Offset32 baseGlyphListOffset
      //   Offset32 layerListOffset
      //   Offset32 clipListOffset
      //   Offset32 varIndexMapOffset
      //   Offset32 itemVariationStoreOffset
      const bglRel = v.getUint32(colrOff + 14, false);
      const llRel = v.getUint32(colrOff + 18, false);
      // ClipList (read lazily by getClipBox).
      const clipRel = v.getUint32(colrOff + 22, false);
      this._clipListOff = clipRel ? colrOff + clipRel : 0;
      if (bglRel) {
        this._baseGlyphListOff = colrOff + bglRel;
        this._numBaseGlyphV1 = v.getUint32(this._baseGlyphListOff, false);
      }
      if (llRel) {
        this._layerListOff = colrOff + llRel;
        this._numLayerV1 = v.getUint32(this._layerListOff, false);
      }
      // varIndexMap + itemVariationStore live in the second half of the
      // v1 header. Parsed lazily by _ensureVarStore() the first time a
      // var-format Paint is read with non-null coords.
      const vimRel = v.getUint32(colrOff + 26, false);
      const ivsRel = v.getUint32(colrOff + 30, false);
      this._varIndexMapAbs = vimRel ? colrOff + vimRel : 0;
      this._ivsAbs = ivsRel ? colrOff + ivsRel : 0;
      this._tables = tables;
    }

    this._loadPalette0(tables.cpal[0]);
  }

  /// True iff a usable v0 COLR table is present. v1 fonts often
  /// include v0 records as a fallback for renderers that don't grok
  /// v1; both can be true simultaneously.
  get hasColor() {
    return this._version >= 0 && this._numBase > 0;
  }
  /// True iff a v1 BaseGlyphList exists with at least one paint record.
  get hasColrV1() {
    return this._version >= 1 && this._numBaseGlyphV1 > 0;
  }
  get version() {
    return this._version;
  }
  get numBaseGlyphs() {
    return this._numBase;
  }
  get numBaseGlyphsV1() {
    return this._numBaseGlyphV1;
  }
  get numPaletteEntries() {
    return this._numPaletteEntries;
  }

  /// Returns an array of ColrLayer for the given base glyph id, or
  /// null if the glyph isn't a color glyph. Layers are in paint-order
  /// (back to front).
  getLayers(glyphId) {
    if (!this.hasColor) return null;
    // Base records are sorted by glyphID — binary search.
    let lo = 0,
      hi = this._numBase - 1;
    const v = this._view;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const recOff = this._baseOff + mid * 6;
      const gid = v.getUint16(recOff, false);
      if (gid === glyphId) {
        const firstLayer = v.getUint16(recOff + 2, false);
        const numLayer = v.getUint16(recOff + 4, false);
        const out = new Array(numLayer);
        for (let i = 0; i < numLayer; i++) {
          const lrOff = this._layerOff + (firstLayer + i) * 4;
          const lGid = v.getUint16(lrOff, false);
          const lPal = v.getUint16(lrOff + 2, false);
          out[i] = new ColrLayer(lGid, lPal, this._resolveColor(lPal));
        }
        return out;
      }
      if (gid < glyphId) lo = mid + 1;
      else hi = mid - 1;
    }
    return null;
  }

  /// Returns the COLR v1 paint tree for the given base glyph as a
  /// nested JS object, or null if the glyph isn't a v1 base glyph.
  /// Each paint node has the shape:
  ///   { format: int, ... format-specific fields }
  ///
  /// Implemented Paint formats:
  ///    1  PaintColrLayers      { format, layers: PaintNode[] }
  ///    2  PaintSolid           { format, paletteIndex, alpha,
  ///                              rgba: [r,g,b,a] | null }
  ///   10  PaintGlyph           { format, child: PaintNode, glyphId }
  ///   11  PaintColrGlyph       { format, glyphId } — references another
  ///                            base glyph's paint tree by ID
  ///   12  PaintTransform       { format, child, affine: [xx,yx,xy,yy,dx,dy] }
  ///   14  PaintTranslate       { format, child, dx, dy }
  ///   16  PaintScale           { format, child, sx, sy }
  ///   18  PaintScaleUniform    { format, child, s }
  ///   20  PaintScaleAroundCenter { format, child, sx, sy, cx, cy }
  ///   22  PaintRotate          { format, child, angleDeg }
  ///   24  PaintRotateAroundCenter { format, child, angleDeg, cx, cy }
  ///   26  PaintSkew            { format, child, skewXDeg, skewYDeg }
  ///   28  PaintSkewAroundCenter { format, child, skewXDeg, skewYDeg, cx, cy }
  ///   32  PaintComposite       { format, src, dst, mode }
  ///
  /// Variable-axis variants (formats 3, 5, 7, 9, 13, 15, 17, 19, 21,
  /// 23, 25, 27, 29) interpolate via the IVS when `coords` is supplied.
  ///
  /// Gradients (formats 4, 6, 8) parse to:
  ///    4  PaintLinearGradient  { format, stops, p0, p1, p2, extend }
  ///    6  PaintRadialGradient  { format, stops, c0, r0, c1, r1, extend }
  ///    8  PaintSweepGradient   { format, stops, center, startAngle,
  ///                              endAngle, extend }
  /// `stops` is an array of { offset, paletteIndex, alpha, rgba }.
  ///
  /// Unknown formats return { format, unsupported: true } so callers
  /// can detect gaps without null-propagation.
  ///
  /// Paint trees can reference layers from the shared LayerList, which
  /// itself contains paint subtrees. The walker resolves these
  /// references inline so the returned tree is fully expanded.
  /// Returns the paint tree for `glyphId`, optionally interpolated to
  /// normalized variation coords `coords` (a Float32Array or number[]
  /// of length axisCount). When `coords` is null or the font has no
  /// COLR variation data, the paint tree is the static / default
  /// instance. PaintVar* nodes that reference a missing IVS or out-of-
  /// range index gracefully fall back to their static values.
  getPaint(glyphId, coords = null) {
    if (!this.hasColrV1) return null;
    const v = this._view;
    // BaseGlyphList:
    //   uint32 numBaseGlyphPaintRecords  (at this._baseGlyphListOff)
    //   BaseGlyphPaintRecord[N] at +4:
    //     uint16 glyphID
    //     Offset32 paintOffset (from BaseGlyphList start)
    // Sorted by glyphID — binary search.
    const listOff = this._baseGlyphListOff;
    const recsOff = listOff + 4;
    const recSize = 6;
    let lo = 0,
      hi = this._numBaseGlyphV1 - 1;
    let paintAbsOff = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const recOff = recsOff + mid * recSize;
      const gid = v.getUint16(recOff, false);
      if (gid === glyphId) {
        const paintRel = v.getUint32(recOff + 2, false);
        paintAbsOff = listOff + paintRel;
        break;
      }
      if (gid < glyphId) lo = mid + 1;
      else hi = mid - 1;
    }
    if (!paintAbsOff) return null;
    if (coords && this._ivsAbs) this._ensureVarStore();
    this._paintBudget = MAX_COLR_PAINT_NODES;
    return this._readPaint(paintAbsOff, coords);
  }

  /// The ClipList clip box of a base glyph, [xMin, yMin, xMax, yMax] in font units (ClipBox format 2 gets its
  /// variation deltas at `coords`), or null when the font has no ClipList or no Clip record covers the glyph.
  /// ClipList: u8 format = 1, u32 numClips, Clip[] { u16 startGlyphID, u16 endGlyphID, Offset24 clipBox (from the
  /// ClipList) }, sorted by startGlyphID. ClipBox: u8 format (1, or 2 with a trailing u32 varIndexBase for the four
  /// deltas, in field order), FWORD xMin, yMin, xMax, yMax. A malformed list is treated as absent (no clip).
  getClipBox(glyphId, coords = null) {
    const listOff = this._clipListOff;
    if (!listOff) return null;
    const v = this._view;
    try {
      if (v.getUint8(listOff) !== 1) return null;
      const n = v.getUint32(listOff + 1, false);
      let lo = 0,
        hi = n - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const rec = listOff + 5 + mid * 7;
        if (glyphId < v.getUint16(rec, false)) {
          hi = mid - 1;
          continue;
        }
        if (glyphId > v.getUint16(rec + 2, false)) {
          lo = mid + 1;
          continue;
        }
        const box = listOff + this._readOffset24(rec + 4);
        const format = v.getUint8(box);
        if (format !== 1 && format !== 2) return null;
        const out = [
          v.getInt16(box + 1, false),
          v.getInt16(box + 3, false),
          v.getInt16(box + 5, false),
          v.getInt16(box + 7, false),
        ];
        if (format === 2 && coords) {
          if (this._ivsAbs) this._ensureVarStore();
          const varIndexBase = v.getUint32(box + 9, false);
          for (let k = 0; k < 4; k++) out[k] += this._varDelta(varIndexBase, k, coords);
        }
        return out;
      }
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
    }
    return null;
  }

  /// Lazily build the ItemVariationStore + DeltaSetIndexMap on first
  /// var-aware paint read. Idempotent.
  _ensureVarStore() {
    if (this._ivs !== undefined) return;
    this._ivs = this._ivsAbs ? new ItemVariationStore(this._tables, this._ivsAbs) : null;
    this._varIndexMap = this._varIndexMapAbs
      ? new DeltaSetIndexMap(this._tables, this._varIndexMapAbs)
      : null;
  }

  /// Resolve a (varIndexBase, fieldIndex) pair to a font-unit delta at
  /// the supplied normalized `coords`. Returns 0 when:
  ///   - varIndexBase is 0xFFFFFFFF (spec sentinel "no delta"),
  ///   - the IVS is absent,
  ///   - coords is null,
  ///   - the index is out of range.
  _varDelta(varIndexBase, fieldIdx, coords) {
    if (!coords || !this._ivs) return 0;
    if (varIndexBase === 0xffffffff) return 0;
    const idx = (varIndexBase + fieldIdx) >>> 0;
    let outer, inner;
    if (this._varIndexMap) {
      const m = this._varIndexMap.lookup(idx);
      outer = m.outer;
      inner = m.inner;
    } else {
      // Per spec: when no map, decompose 32-bit idx as outer/inner =
      // (idx >> 16, idx & 0xFFFF).
      outer = (idx >>> 16) & 0xffff;
      inner = idx & 0xffff;
    }
    return this._ivs.getDelta(outer, inner, coords);
  }

  /// Read a Paint table at the given absolute view-offset. Returns a
  /// paint-tree node (see getPaint) or null on malformed data.
  /// Recursive; format-specific cases handle their own sub-paints.
  ///
  _readPaint(off, coords = null) {
    // Paints can share a child, so a few bytes can name an exponential tree (HarfBuzz caps edges for the same reason).
    if (--this._paintBudget < 0)
      throw new GlyphOutlineError(
        `COLR paint graph exceeds its budget (${MAX_COLR_PAINT_NODES} nodes)`,
      );
    const v = this._view;
    const format = v.getUint8(off);
    if (format === 1) {
      // PaintColrLayers:
      //   uint8 format = 1
      //   uint8 numLayers
      //   uint32 firstLayerIndex (into LayerList)
      // LayerList[k] is an Offset32 from LayerList start → Paint.
      const numLayers = v.getUint8(off + 1);
      const firstLayer = v.getUint32(off + 2, false);
      const layers = new Array(numLayers);
      // LayerList header is a uint32 count followed by Offset32[count].
      const layerArrayOff = this._layerListOff + 4;
      for (let i = 0; i < numLayers; i++) {
        const slotOff = layerArrayOff + (firstLayer + i) * 4;
        const paintRel = v.getUint32(slotOff, false);
        layers[i] = this._readPaint(this._layerListOff + paintRel, coords);
      }
      return { format: 1, layers };
    }
    if (format === 2 || format === 3) {
      // PaintSolid / PaintVarSolid:
      //   uint8 format
      //   uint16 paletteIndex
      //   F2DOT14 alpha (sint16 / 16384)
      //   [PaintVarSolid only] uint32 varIndexBase
      const paletteIndex = v.getUint16(off + 1, false);
      let alpha = v.getInt16(off + 3, false) / 16384;
      if (format === 3 && coords) {
        // Single deltable field: alpha. Stored as F2DOT14, so the
        // delta is also in 1/16384ths.
        const varIndexBase = v.getUint32(off + 5, false);
        alpha += this._varDelta(varIndexBase, 0, coords) / 16384;
      }
      let rgba = null;
      if (paletteIndex !== 0xffff) {
        const palCol = this._resolveColor(paletteIndex);
        rgba = [palCol[0], palCol[1], palCol[2], palCol[3] * alpha];
      }
      return { format: 2, paletteIndex, alpha, rgba };
    }
    if (format === 4 || format === 5) {
      // PaintLinearGradient / Var:
      //   u8 format
      //   Offset24 colorLineOffset (from this paint's start)
      //   FWORD x0, y0, x1, y1, x2, y2  (sint16, in font units)
      //   [PaintVarLinearGradient only] u32 varIndexBase
      const clRel = this._readOffset24(off + 1);
      let x0 = v.getInt16(off + 4, false);
      let y0 = v.getInt16(off + 6, false);
      let x1 = v.getInt16(off + 8, false);
      let y1 = v.getInt16(off + 10, false);
      let x2 = v.getInt16(off + 12, false);
      let y2 = v.getInt16(off + 14, false);
      const isVar = format === 5;
      if (isVar && coords) {
        const varIndexBase = v.getUint32(off + 16, false);
        x0 += this._varDelta(varIndexBase, 0, coords);
        y0 += this._varDelta(varIndexBase, 1, coords);
        x1 += this._varDelta(varIndexBase, 2, coords);
        y1 += this._varDelta(varIndexBase, 3, coords);
        x2 += this._varDelta(varIndexBase, 4, coords);
        y2 += this._varDelta(varIndexBase, 5, coords);
      }
      const cl = this._readColorLine(off + clRel, isVar, coords);
      return {
        format: 4,
        p0: [x0, y0],
        p1: [x1, y1],
        p2: [x2, y2],
        stops: cl.stops,
        extend: cl.extend,
      };
    }
    if (format === 6 || format === 7) {
      // PaintRadialGradient / Var:
      //   u8 format
      //   Offset24 colorLineOffset
      //   FWORD x0, y0; UFWORD r0; FWORD x1, y1; UFWORD r1
      //   [PaintVarRadialGradient only] u32 varIndexBase
      const clRel = this._readOffset24(off + 1);
      let x0 = v.getInt16(off + 4, false);
      let y0 = v.getInt16(off + 6, false);
      let r0 = v.getUint16(off + 8, false);
      let x1 = v.getInt16(off + 10, false);
      let y1 = v.getInt16(off + 12, false);
      let r1 = v.getUint16(off + 14, false);
      const isVar = format === 7;
      if (isVar && coords) {
        const varIndexBase = v.getUint32(off + 16, false);
        x0 += this._varDelta(varIndexBase, 0, coords);
        y0 += this._varDelta(varIndexBase, 1, coords);
        r0 += this._varDelta(varIndexBase, 2, coords);
        x1 += this._varDelta(varIndexBase, 3, coords);
        y1 += this._varDelta(varIndexBase, 4, coords);
        r1 += this._varDelta(varIndexBase, 5, coords);
      }
      const cl = this._readColorLine(off + clRel, isVar, coords);
      return { format: 6, c0: [x0, y0], r0, c1: [x1, y1], r1, stops: cl.stops, extend: cl.extend };
    }
    if (format === 8 || format === 9) {
      // PaintSweepGradient / Var:
      //   u8 format
      //   Offset24 colorLineOffset
      //   FWORD centerX, centerY
      //   F2DOT14 startAngle, endAngle (degrees / 180 as in rotate)
      //   [PaintVarSweepGradient only] u32 varIndexBase
      const clRel = this._readOffset24(off + 1);
      let cx = v.getInt16(off + 4, false);
      let cy = v.getInt16(off + 6, false);
      let startStored = v.getInt16(off + 8, false);
      let endStored = v.getInt16(off + 10, false);
      const isVar = format === 9;
      if (isVar && coords) {
        const varIndexBase = v.getUint32(off + 12, false);
        cx += this._varDelta(varIndexBase, 0, coords);
        cy += this._varDelta(varIndexBase, 1, coords);
        startStored += this._varDelta(varIndexBase, 2, coords);
        endStored += this._varDelta(varIndexBase, 3, coords);
      }
      // COLR spec: sweep angles are F2DOT14 with a BIAS of 1.0 —
      // angle = (value + 1.0) × 180°. (Rotate/skew paints are unbiased.)
      const startAngle = (startStored / 16384 + 1) * 180;
      const endAngle = (endStored / 16384 + 1) * 180;
      const cl = this._readColorLine(off + clRel, isVar, coords);
      return {
        format: 8,
        center: [cx, cy],
        startAngle,
        endAngle,
        stops: cl.stops,
        extend: cl.extend,
      };
    }
    if (format === 10) {
      // PaintGlyph:
      //   u8 format = 10
      //   Offset24 paintOffset (from this PaintGlyph's start) → sub-Paint
      //   uint16 glyphID
      // The sub-paint is what gets painted; glyphID is the clip mask.
      const childRel = this._readOffset24(off + 1);
      const glyphId = v.getUint16(off + 4, false);
      const child = this._readPaint(off + childRel, coords);
      return { format: 10, child, glyphId };
    }
    if (format === 11) {
      // PaintColrGlyph:
      //   u8 format = 11
      //   uint16 glyphID
      // The glyph's own paint tree (resolved at draw time, allowing
      // recursive paint definitions and DAG sharing).
      const glyphId = v.getUint16(off + 1, false);
      return { format: 11, glyphId };
    }
    if (format === 12 || format === 13) {
      // PaintTransform / PaintVarTransform:
      //   u8 format
      //   Offset24 paintOffset      -> sub-Paint (from this paint's start)
      //   Offset24 transformOffset  -> Affine2x3 / VarAffine2x3 (from this paint's start)
      // Affine2x3 is Fixed[6] (16.16): xx, yx, xy, yy, dx, dy. VarAffine2x3 adds a uint32 varIndexBase after
      // them. The affine is NOT inline in the paint (fontTools and every real font put it behind the second
      // offset).
      const childRel = this._readOffset24(off + 1);
      const affOff = off + this._readOffset24(off + 4);
      let xx = v.getInt32(affOff + 0, false) / 65536;
      let yx = v.getInt32(affOff + 4, false) / 65536;
      let xy = v.getInt32(affOff + 8, false) / 65536;
      let yy = v.getInt32(affOff + 12, false) / 65536;
      let dx = v.getInt32(affOff + 16, false) / 65536;
      let dy = v.getInt32(affOff + 20, false) / 65536;
      if (format === 13 && coords) {
        const varIndexBase = v.getUint32(affOff + 24, false);
        xx += this._varDelta(varIndexBase, 0, coords) / 65536;
        yx += this._varDelta(varIndexBase, 1, coords) / 65536;
        xy += this._varDelta(varIndexBase, 2, coords) / 65536;
        yy += this._varDelta(varIndexBase, 3, coords) / 65536;
        dx += this._varDelta(varIndexBase, 4, coords) / 65536;
        dy += this._varDelta(varIndexBase, 5, coords) / 65536;
      }
      const child = this._readPaint(off + childRel, coords);
      return { format: 12, child, affine: [xx, yx, xy, yy, dx, dy] };
    }
    if (format === 14 || format === 15) {
      // PaintTranslate / PaintVarTranslate:
      //   u8 format
      //   Offset24 paintOffset
      //   FWORD dx, dy (sint16)
      //   [PaintVarTranslate only] uint32 varIndexBase
      const childRel = this._readOffset24(off + 1);
      let dx = v.getInt16(off + 4, false);
      let dy = v.getInt16(off + 6, false);
      if (format === 15 && coords) {
        const varIndexBase = v.getUint32(off + 8, false);
        dx += this._varDelta(varIndexBase, 0, coords);
        dy += this._varDelta(varIndexBase, 1, coords);
      }
      const child = this._readPaint(off + childRel, coords);
      return { format: 14, child, dx, dy };
    }
    if (format === 16 || format === 17) {
      // PaintScale / PaintVarScale:
      //   u8 format, Offset24 paint, F2DOT14 sx, F2DOT14 sy
      //   [PaintVarScale only] uint32 varIndexBase
      const childRel = this._readOffset24(off + 1);
      let sx = v.getInt16(off + 4, false) / 16384;
      let sy = v.getInt16(off + 6, false) / 16384;
      if (format === 17 && coords) {
        const varIndexBase = v.getUint32(off + 8, false);
        sx += this._varDelta(varIndexBase, 0, coords) / 16384;
        sy += this._varDelta(varIndexBase, 1, coords) / 16384;
      }
      const child = this._readPaint(off + childRel, coords);
      return { format: 16, child, sx, sy };
    }
    if (format === 18 || format === 19) {
      // PaintScaleAroundCenter / Var:
      //   u8 format, Offset24 paint, F2DOT14 sx, sy, FWORD cx, cy
      //   [PaintVarScaleAroundCenter only] uint32 varIndexBase
      const childRel = this._readOffset24(off + 1);
      let sx = v.getInt16(off + 4, false) / 16384;
      let sy = v.getInt16(off + 6, false) / 16384;
      let cx = v.getInt16(off + 8, false);
      let cy = v.getInt16(off + 10, false);
      if (format === 19 && coords) {
        const varIndexBase = v.getUint32(off + 12, false);
        sx += this._varDelta(varIndexBase, 0, coords) / 16384;
        sy += this._varDelta(varIndexBase, 1, coords) / 16384;
        cx += this._varDelta(varIndexBase, 2, coords);
        cy += this._varDelta(varIndexBase, 3, coords);
      }
      const child = this._readPaint(off + childRel, coords);
      return { format: 18, child, sx, sy, cx, cy };
    }
    if (format === 20 || format === 21) {
      // PaintScaleUniform / PaintVarScaleUniform:
      //   u8 format, Offset24 paint, F2DOT14 s
      //   [PaintVarScaleUniform only] uint32 varIndexBase
      const childRel = this._readOffset24(off + 1);
      let s = v.getInt16(off + 4, false) / 16384;
      if (format === 21 && coords) {
        const varIndexBase = v.getUint32(off + 6, false);
        s += this._varDelta(varIndexBase, 0, coords) / 16384;
      }
      const child = this._readPaint(off + childRel, coords);
      return { format: 20, child, s };
    }
    if (format === 22 || format === 23) {
      // PaintScaleUniformAroundCenter / Var:
      //   u8 format, Offset24 paint, F2DOT14 s, FWORD cx, cy
      //   [PaintVarScaleUniformAroundCenter only] uint32 varIndexBase
      const childRel = this._readOffset24(off + 1);
      let s = v.getInt16(off + 4, false) / 16384;
      let cx = v.getInt16(off + 6, false);
      let cy = v.getInt16(off + 8, false);
      if (format === 23 && coords) {
        const varIndexBase = v.getUint32(off + 10, false);
        s += this._varDelta(varIndexBase, 0, coords) / 16384;
        cx += this._varDelta(varIndexBase, 1, coords);
        cy += this._varDelta(varIndexBase, 2, coords);
      }
      const child = this._readPaint(off + childRel, coords);
      return { format: 22, child, s, cx, cy };
    }
    if (format === 24 || format === 25) {
      // PaintRotate / PaintVarRotate:
      //   u8 format, Offset24 paint, F2DOT14 angle (degrees / 180)
      //   [PaintVarRotate only] uint32 varIndexBase
      const childRel = this._readOffset24(off + 1);
      let angleStored = v.getInt16(off + 4, false);
      if (format === 25 && coords) {
        const varIndexBase = v.getUint32(off + 6, false);
        angleStored += this._varDelta(varIndexBase, 0, coords);
      }
      const angleDeg = (angleStored / 16384) * 180;
      const child = this._readPaint(off + childRel, coords);
      return { format: 24, child, angleDeg };
    }
    if (format === 26 || format === 27) {
      // PaintRotateAroundCenter / Var:
      //   u8 format, Offset24 paint, F2DOT14 angle, FWORD cx, cy
      //   [PaintVarRotateAroundCenter only] uint32 varIndexBase
      const childRel = this._readOffset24(off + 1);
      let angleStored = v.getInt16(off + 4, false);
      let cx = v.getInt16(off + 6, false);
      let cy = v.getInt16(off + 8, false);
      if (format === 27 && coords) {
        const varIndexBase = v.getUint32(off + 10, false);
        angleStored += this._varDelta(varIndexBase, 0, coords);
        cx += this._varDelta(varIndexBase, 1, coords);
        cy += this._varDelta(varIndexBase, 2, coords);
      }
      const angleDeg = (angleStored / 16384) * 180;
      const child = this._readPaint(off + childRel, coords);
      return { format: 26, child, angleDeg, cx, cy };
    }
    if (format === 28 || format === 29) {
      // PaintSkew / PaintVarSkew:
      //   u8 format, Offset24 paint, F2DOT14 skewX, F2DOT14 skewY
      //   [PaintVarSkew only] uint32 varIndexBase
      const childRel = this._readOffset24(off + 1);
      let skewXStored = v.getInt16(off + 4, false);
      let skewYStored = v.getInt16(off + 6, false);
      if (format === 29 && coords) {
        const varIndexBase = v.getUint32(off + 8, false);
        skewXStored += this._varDelta(varIndexBase, 0, coords);
        skewYStored += this._varDelta(varIndexBase, 1, coords);
      }
      const skewXDeg = (skewXStored / 16384) * 180;
      const skewYDeg = (skewYStored / 16384) * 180;
      const child = this._readPaint(off + childRel, coords);
      return { format: 28, child, skewXDeg, skewYDeg };
    }
    if (format === 30 || format === 31) {
      // PaintSkewAroundCenter / Var:
      //   u8 format, Offset24 paint, F2DOT14 skewX, skewY, FWORD cx, cy
      //   [PaintVarSkewAroundCenter only] uint32 varIndexBase
      const childRel = this._readOffset24(off + 1);
      let skewXStored = v.getInt16(off + 4, false);
      let skewYStored = v.getInt16(off + 6, false);
      let cx = v.getInt16(off + 8, false);
      let cy = v.getInt16(off + 10, false);
      if (format === 31 && coords) {
        const varIndexBase = v.getUint32(off + 12, false);
        skewXStored += this._varDelta(varIndexBase, 0, coords);
        skewYStored += this._varDelta(varIndexBase, 1, coords);
        cx += this._varDelta(varIndexBase, 2, coords);
        cy += this._varDelta(varIndexBase, 3, coords);
      }
      const skewXDeg = (skewXStored / 16384) * 180;
      const skewYDeg = (skewYStored / 16384) * 180;
      const child = this._readPaint(off + childRel, coords);
      return { format: 30, child, skewXDeg, skewYDeg, cx, cy };
    }
    if (format === 32) {
      // PaintComposite:
      //   u8 format = 32
      //   Offset24 sourcePaintOffset
      //   u8 compositeMode (0..27 — superset of feBlend's 16 modes
      //                     plus Porter-Duff)
      //   Offset24 backdropPaintOffset
      const srcRel = this._readOffset24(off + 1);
      const mode = v.getUint8(off + 4);
      const dstRel = this._readOffset24(off + 5);
      const src = this._readPaint(off + srcRel, coords);
      const dst = this._readPaint(off + dstRel, coords);
      return { format: 32, src, dst, mode };
    }
    // Unknown format — sentinel; warn once per format id.
    if (!_warnedColrFormats.has(format)) {
      _warnedColrFormats.add(format);
      mantleWarn(`COLR paint format ${format} not supported — substituting transparent`);
    }
    return { format, unsupported: true };
  }

  /// Read a ColorLine table (gradient stops + extend mode) at the
  /// given absolute view-offset. Format:
  ///   u8 extend (0=PAD, 1=REPEAT, 2=REFLECT)
  ///   u16 numStops
  ///   ColorStop[numStops]
  ///     F2DOT14 stopOffset (signed; usually [0,1])
  ///     u16 paletteIndex
  ///     F2DOT14 alpha
  ///
  /// `isVar` selects the stop layout: false = 6-byte ColorStop,
  /// true = 10-byte VarColorStop (trailing u32 varIndexBase per stop).
  /// `coords` is only consulted when `isVar` is true; pass null to read
  /// the static (master) form even from a VarColorLine.
  ///
  /// Two deltable fields per VarColorStop: 0=stopOffset (F2DOT14),
  /// 1=alpha (F2DOT14). VarColorLine is only valid as the colorLine
  /// of a PaintVar*Gradient.
  ///
  /// Returns { extend, stops: [{ offset, paletteIndex, alpha, rgba }] }
  /// where rgba is null for the 0xFFFF foreground-color sentinel.
  _readColorLine(off, isVar = false, coords = null) {
    const v = this._view;
    const extend = v.getUint8(off);
    const numStops = v.getUint16(off + 1, false);
    const stops = new Array(numStops);
    const stopSize = isVar ? 10 : 6;
    let cur = off + 3;
    for (let i = 0; i < numStops; i++) {
      let stopStored = v.getInt16(cur, false);
      const paletteIndex = v.getUint16(cur + 2, false);
      let alphaStored = v.getInt16(cur + 4, false);
      if (isVar && coords) {
        const varIndexBase = v.getUint32(cur + 6, false);
        stopStored += this._varDelta(varIndexBase, 0, coords);
        alphaStored += this._varDelta(varIndexBase, 1, coords);
      }
      const stopOffset = stopStored / 16384;
      const alpha = alphaStored / 16384;
      let rgba = null;
      if (paletteIndex !== 0xffff) {
        const palCol = this._resolveColor(paletteIndex);
        rgba = [palCol[0], palCol[1], palCol[2], palCol[3] * alpha];
      }
      stops[i] = { offset: stopOffset, paletteIndex, alpha, rgba };
      cur += stopSize;
    }
    return { extend, stops };
  }

  /// Read a COLR Offset24 (3-byte big-endian unsigned) at `off`.
  /// Used for sub-paint references in PaintTransform / PaintGlyph /
  /// PaintComposite etc. Returns 0 for null offsets per spec.
  _readOffset24(off) {
    const v = this._view;
    return (v.getUint8(off) << 16) | (v.getUint8(off + 1) << 8) | v.getUint8(off + 2);
  }

  _resolveColor(paletteIndex) {
    if (paletteIndex === 0xffff) return null; // foreground sentinel
    if (!this._palette0) return [0, 0, 0, 1];
    if (paletteIndex >= this._numPaletteEntries) return [0, 0, 0, 1];
    return this._palette0[paletteIndex];
  }

  _loadPalette0(cpalAbsOff) {
    const v = this._view;
    const cpalVersion = v.getUint16(cpalAbsOff + 0, false);
    if (cpalVersion !== 0 && cpalVersion !== 1) return; // unknown CPAL
    this._numPaletteEntries = v.getUint16(cpalAbsOff + 2, false);
    const numPalettes = v.getUint16(cpalAbsOff + 4, false);
    if (numPalettes === 0) return;
    const numColorRec = v.getUint16(cpalAbsOff + 6, false);
    const colorRecOff = cpalAbsOff + v.getUint32(cpalAbsOff + 8, false);
    // colorRecordIndices: u16[numPalettes], starts at offset 12.
    // Palette 0's first record index:
    const pal0First = v.getUint16(cpalAbsOff + 12, false);
    if (pal0First + this._numPaletteEntries > numColorRec) return;

    const colors = new Array(this._numPaletteEntries);
    for (let i = 0; i < this._numPaletteEntries; i++) {
      const recOff = colorRecOff + (pal0First + i) * 4;

      const b = v.getUint8(recOff + 0) / 255;
      const g = v.getUint8(recOff + 1) / 255;
      const r = v.getUint8(recOff + 2) / 255;
      const a = v.getUint8(recOff + 3) / 255;
      colors[i] = [r, g, b, a];
    }
    this._palette0 = colors;
  }
}
