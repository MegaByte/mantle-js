// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// gdefReader.js — GDEF (Glyph Definition) table.
//
// Sub-tables consumed:
//   - GlyphClassDef:     base / ligature / mark / component
//   - LigCaretList:      ligature-caret X positions for cursor placement
//   - MarkAttachClassDef: per-gid mark-attachment class (lookupFlag
//                         MarkAttachmentType filtering)
//   - MarkGlyphSetsDef (v1.2+): per-set glyph membership (lookupFlag
//                         UseMarkFilteringSet)
//
// Spec: https://learn.microsoft.com/en-us/typography/opentype/spec/gdef

import { classOf, coverageIndex } from './otCommon.js';
import { ItemVariationStore } from './itemVariationStore.js';

/** Glyph classes from GDEF GlyphClassDef. */
export const GdefClass = Object.freeze({
  Unassigned: 0,
  Base: 1,
  Ligature: 2,
  Mark: 3,
  Component: 4,
});

export class GdefReader {
  constructor(tables) {
    this._view = tables.view;
    if (!tables.gdef) {
      this._tableOff = -1;
      this._glyphClassDefOff = -1;
      this._markAttachClassDefOff = -1;
      this._ligCaretListOff = -1;
      this._markGlyphSetsDefOff = -1;
      this._ivsOff = -1;
      return;
    }
    const off = tables.gdef[0];
    const v = this._view;
    this._tableOff = off;
    // Header (v1.0):
    //   u16 majorVersion, u16 minorVersion (0|2|3),
    //   u16 glyphClassDefOff, u16 attachListOff,
    //   u16 ligCaretListOff, u16 markAttachClassDefOff
    // v1.2 adds u16 markGlyphSetsDefOff; v1.3 adds u32 itemVarStoreOff.
    const minor = v.getUint16(off + 2, false);
    const gcdRel = v.getUint16(off + 4, false);
    const _attachRel = v.getUint16(off + 6, false);
    const lcdRel = v.getUint16(off + 8, false);
    const macdRel = v.getUint16(off + 10, false);
    this._glyphClassDefOff = gcdRel ? off + gcdRel : -1;
    this._ligCaretListOff = lcdRel ? off + lcdRel : -1;
    this._markAttachClassDefOff = macdRel ? off + macdRel : -1;
    this._markGlyphSetsDefOff = -1;
    if (minor >= 2) {
      const mgsdRel = v.getUint16(off + 12, false);
      this._markGlyphSetsDefOff = mgsdRel ? off + mgsdRel : -1;
    }
    // v1.3: Offset32 itemVarStoreOffset follows markGlyphSetsDefOff. It holds the deltas that GPOS VariationIndex
    // device tables (and the caret / anchor ones) point into.
    this._ivsOff = -1;
    if (minor >= 3) {
      const ivsRel = v.getUint32(off + 14, false);
      this._ivsOff = ivsRel ? off + ivsRel : -1;
    }
  }

  /// The GDEF ItemVariationStore (v1.3) or null. Built on first use.
  get itemVarStore() {
    if (this._ivs === undefined) {
      this._ivs =
        this._ivsOff >= 0
          ? new ItemVariationStore(
              {
                view: this._view,
                bytes: new Uint8Array(
                  this._view.buffer,
                  this._view.byteOffset,
                  this._view.byteLength,
                ),
              },
              this._ivsOff,
            )
          : null;
    }
    return this._ivs;
  }

  get hasTable() {
    return this._tableOff >= 0;
  }

  /// True when the table carries a glyph class definition: marks are then the glyphs it says, not the characters' categories.
  get hasGlyphClasses() {
    return this._glyphClassDefOff >= 0;
  }

  /// GDEF glyph class for `gid` (Base/Ligature/Mark/Component or
  /// Unassigned). Drives GSUB/GPOS lookupFlag class-skip filtering.
  getGlyphClass(gid) {
    if (this._glyphClassDefOff < 0) return GdefClass.Unassigned;
    const c = classOf(this._view, this._glyphClassDefOff, gid);
    if (c >= GdefClass.Base && c <= GdefClass.Component) return c;
    return GdefClass.Unassigned;
  }

  /// Mark-attachment class for `gid` (0 if not a mark or not
  /// classified). Drives the lookupFlag MarkAttachmentType field.
  getMarkAttachClass(gid) {
    if (this._markAttachClassDefOff < 0) return 0;
    return classOf(this._view, this._markAttachClassDefOff, gid);
  }

  /// True iff `gid` is a member of MarkGlyphSet `setIdx` (lookupFlag
  /// UseMarkFilteringSet, v1.2+).
  isInMarkGlyphSet(gid, setIdx) {
    if (this._markGlyphSetsDefOff < 0) return false;
    const v = this._view;
    const off = this._markGlyphSetsDefOff;
    const format = v.getUint16(off, false);
    if (format !== 1) return false;
    const count = v.getUint16(off + 2, false);
    if (setIdx >= count) return false;
    const covRel = v.getUint32(off + 4 + setIdx * 4, false);
    if (covRel === 0) return false;
    return coverageIndex(v, off + covRel, gid) >= 0;
  }

  /// Ligature carets for `gid`: array of X positions (font units) for
  /// caret placement inside a ligature, or null when the glyph has no
  /// LigGlyph entry. Formats 1 (coordinate), 2 (contour point), 3
  /// (device) supported; device/point-hint tweaks ignored (base X only).
  getLigatureCarets(gid) {
    if (this._ligCaretListOff < 0) return null;
    const v = this._view;
    const off = this._ligCaretListOff;
    const coverageRel = v.getUint16(off, false);
    const covIdx = coverageIndex(v, off + coverageRel, gid);
    if (covIdx < 0) return null;
    const ligGlyphCount = v.getUint16(off + 2, false);
    if (covIdx >= ligGlyphCount) return null;
    const ligGlyphOff = off + v.getUint16(off + 4 + covIdx * 2, false);
    const caretCount = v.getUint16(ligGlyphOff, false);
    const out = new Array(caretCount);
    for (let i = 0; i < caretCount; i++) {
      const caretValueOff = ligGlyphOff + v.getUint16(ligGlyphOff + 2 + i * 2, false);
      const format = v.getUint16(caretValueOff, false);
      let x = 0;
      if (format === 1) {
        // u16 caretFormat=1, s16 coordinate
        x = v.getInt16(caretValueOff + 2, false);
      } else if (format === 2) {
        // u16 caretFormat=2, u16 caretValuePointIndex.
        // Contour-point resolution skipped; device-grid alignment isn't
        // critical for cursor placement.
        x = 0;
      } else if (format === 3) {
        // u16 caretFormat=3, s16 coordinate, u16 deviceTableOffset
        x = v.getInt16(caretValueOff + 2, false);
      }
      out[i] = x;
    }
    return out;
  }
}
