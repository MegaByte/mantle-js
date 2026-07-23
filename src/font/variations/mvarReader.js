// mvarReader.js — OpenType 'MVAR' table reader (Metrics Variations).
// Maps font-wide metric tags ('hasc', 'hdsc', 'unds' etc.) to
// per-axis deltas via a shared ItemVariationStore.
//
// Without MVAR, variable fonts keep static hhea/OS-2/post metrics
// regardless of axis position — so line height / underline thickness
// don't grow at heavier weights. Most modern VFs ship MVAR.
//
// Spec: https://learn.microsoft.com/en-us/typography/opentype/spec/mvar

import { ItemVariationStore } from '../itemVariationStore.js';

// Tag → string helper (4-char ASCII).
const TAG_HASC = 0x68617363;  // 'hasc' — hhea ascender
const TAG_HDSC = 0x68647363;  // 'hdsc' — hhea descender
const TAG_HLGP = 0x686C6770;  // 'hlgp' — hhea lineGap
const TAG_HCLA = 0x68636C61;  // 'hcla' — OS/2 winAscent
const TAG_HCLD = 0x68636C64;  // 'hcld' — OS/2 winDescent
const TAG_UNDS = 0x756E6473;  // 'unds' — post underline pos
const TAG_UNDO = 0x756E646F;  // 'undo' — post underline thickness
const TAG_STRS = 0x73747273;  // 'strs' — OS/2 strikeout pos
const TAG_STRO = 0x7374726F;  // 'stro' — OS/2 strikeout size
const TAG_XHGT = 0x78686774;  // 'xhgt' — OS/2 x-height
const TAG_CPHT = 0x63706874;  // 'cpht' — OS/2 cap height

export class MvarTable {
  constructor(tables) {
    this._present = false;
    this._records = null;
    if (!tables.mvar) return;
    const v = tables.view;
    const off = tables.mvar[0];
    const major = v.getUint16(off + 0, false);
    if (major !== 1) return;
    // Header: minorVersion (+2), reserved (+4), valueRecordSize (+6),
    // valueRecordCount (+8), itemVariationStoreOffset (+10).
    const recSize  = v.getUint16(off + 6, false);
    const recCount = v.getUint16(off + 8, false);
    const ivsOff   = v.getUint16(off + 10, false);
    if (recSize !== 8) {
      // Unknown record layout — bail.
      return;
    }
    // Records start immediately after the header (12 bytes).
    const recBase = off + 12;
    const recs = new Map();
    for (let i = 0; i < recCount; i++) {
      const r = recBase + i * recSize;
      const tag    = v.getUint32(r + 0, false);
      const outer  = v.getUint16(r + 4, false);
      const inner  = v.getUint16(r + 6, false);
      recs.set(tag, { outer, inner });
    }
    this._records = recs;
    // Lazy-build IVS — only when a caller asks for a delta.
    this._tables = tables;
    this._ivsOff = off + ivsOff;
    this._ivs = null;
    this._present = true;
  }

  get hasMvar() { return this._present; }

  /// Font-unit delta for `tag` (4-char ASCII; e.g. "hasc") at
  /// normalized coords. Returns 0 when MVAR isn't present or the
  /// tag isn't covered.
  delta(tag, nCoords) {
    if (!this._present) return 0;
    const tagInt = (tag.charCodeAt(0) << 24) | (tag.charCodeAt(1) << 16)
                 | (tag.charCodeAt(2) <<  8) |  tag.charCodeAt(3);
    return this.deltaInt(tagInt, nCoords);
  }

  deltaInt(tagInt, nCoords) {
    if (!this._present) return 0;
    const rec = this._records.get(tagInt);
    if (!rec) return 0;
    if (this._ivs == null) {
      this._ivs = new ItemVariationStore(this._tables, this._ivsOff);
    }
    return this._ivs.getDelta(rec.outer, rec.inner, nCoords);
  }
}

