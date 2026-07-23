// gposReader.js — GPOS pair-adjustment kerning.

import { coverageIndex, classOf, valueRecordSize, valueRecordXAdvance, findFeatureLookups } from './otCommon.js';
import { makeLookupFilter, readLookupFlags, nextNonSkippedForward, nextNonSkippedBackward } from './lookupFlag.js';

export class GposReader {
  /** @param {object} tables result of parseTtfTables */
  constructor(tables) {
    this._view = tables.view;
    if (!tables.gpos) {
      this._lookups = null;
      this._cursLookups = null;
      this._gposTableOff = null;
      this._lookupListOff = null;
      this._featureCache = null;
      return;
    }
    const off = tables.gpos[0];
    this._gposTableOff = off;
    this._lookupListOff = off + this._view.getUint16(off + 8, false);
    this._featureCache = null;
    this._lookups = findFeatureLookups(this._view, off, 0x6B65726E /* 'kern' */);
    // 'curs' = cursive positioning. Arabic baseline-attachment via
    // entry/exit anchors (GPOS lookup type 3).
    this._cursLookups = findFeatureLookups(this._view, off, 0x63757273 /* 'curs' */);
    // 'mark' = mark-to-base attachment (GPOS type 4). Harakat sit
    // above/below their base letter via paired anchor records.
    this._markLookups = findFeatureLookups(this._view, off, 0x6D61726B /* 'mark' */);
    // 'mkmk' = mark-to-mark attachment (GPOS type 6). Stacks marks
    // like shadda+fatha (U+0651+U+064E).
    this._mkmkLookups = findFeatureLookups(this._view, off, 0x6D6B6D6B /* 'mkmk' */);
    // 'mark' feature can dispatch to GPOS type 5 (MarkLigPos) as well
    // — mark attached to a specific component of a ligature glyph.
    // No separate feature tag; both 4 and 5 sit under 'mark'.
    // GDEF reader injected lazily by fontAsset so lookupFlag-driven
    // glyph-class skipping in contextual pos can fire.
    this._gdef = null;
  }

  setGdef(gdef) { this._gdef = gdef; }

  /// Build the GDEF-aware skip filter for a lookup at lookupOff.
  /// Returns a { skip(gid)→bool, rtl } record. No-op when GDEF absent.
  _filterForLookup(lookupOff) {
    const { lookupFlag, markFilteringSet } = readLookupFlags(this._view, lookupOff);
    return makeLookupFilter(lookupFlag, markFilteringSet, this._gdef);
  }

  /// Walk seq[start..]: return the n-th non-skipped position (n=0 → start).
  static _nthInput(seq, start, n, filter) {
    let pos = start, cnt = 0;
    while (pos < seq.length) {
      if (!filter.skip(seq[pos])) {
        if (cnt === n) return pos;
        cnt++;
      }
      pos++;
    }
    return -1;
  }

  /// Walk seq[start-1..0]: return the n-th non-skipped position
  /// going backwards (n=0 → first non-skipped before start).
  static _nthBacktrack(seq, start, n, filter) {
    let pos = start - 1, cnt = 0;
    while (pos >= 0) {
      if (!filter.skip(seq[pos])) {
        if (cnt === n) return pos;
        cnt++;
      }
      pos--;
    }
    return -1;
  }

  get hasKerning() { return this._lookups != null && this._lookups.length > 0; }
  get hasCursive() { return this._cursLookups != null && this._cursLookups.length > 0; }
  get hasMarkBase() { return this._markLookups != null && this._markLookups.length > 0; }
  get hasMarkMark() { return this._mkmkLookups != null && this._mkmkLookups.length > 0; }

  /**
   * Get the cursive entry and exit anchor positions for `gid` (font
   * units). Returns null when the gid has neither entry nor exit
   * anchor. When only one of the two is present, the corresponding
   * field is null. Only AnchorTable format 1 (plain x/y) is decoded;
   * formats 2/3 (with hint indices / device tables) return their
   * x/y but skip the hint/device adjustments.
   */
  getCursiveAnchors(gid) {
    if (!this._cursLookups) return null;
    const v = this._view;
    for (const lookupOff of this._cursLookups) {
      // Per OT spec, the RIGHT_TO_LEFT lookupFlag (0x0001) on a curs
      // lookup flips which glyph (current vs preceding) receives the
      // Y adjustment when chaining the cursive baseline. Real Arabic
      // Naskh fonts set this bit; without it we'd glue glyphs in the
      // wrong direction. Return alongside the anchors so the caller
      // can apply the offset correctly.
      const lookupFlag = v.getUint16(lookupOff + 2, false);
      const rtl = (lookupFlag & 0x0001) !== 0;
      for (const subOff of this._effSubtables(lookupOff, 3)) {
        const fmt = v.getUint16(subOff, false);
        if (fmt !== 1) continue;
        const covAbs = subOff + v.getUint16(subOff + 2, false);
        const covIdx = coverageIndex(v, covAbs, gid);
        if (covIdx < 0) continue;
        const entryExitCount = v.getUint16(subOff + 4, false);
        if (covIdx >= entryExitCount) continue;
        // EntryExitRecord — 4 bytes per record:
        //   entryAnchorOffset (u16), exitAnchorOffset (u16)
        const recOff = subOff + 6 + covIdx * 4;
        const entryOff = v.getUint16(recOff,     false);
        const exitOff  = v.getUint16(recOff + 2, false);
        const entry = entryOff !== 0 ? this._readAnchor(subOff + entryOff) : null;
        const exit  = exitOff  !== 0 ? this._readAnchor(subOff + exitOff)  : null;
        if (entry || exit) return { entry, exit, rtl };
      }
    }
    return null;
  }

  _readAnchor(off) {
    const v = this._view;
    const fmt = v.getUint16(off, false);
    // Formats 1, 2, and 3 all share the same 6-byte prefix:
    //   anchorFormat(2), xCoordinate(s16), yCoordinate(s16)
    // Format 2 adds a 16-bit anchor point hint; format 3 adds device
    // table offsets. For our purposes (vector positioning, no
    // hinting), x/y suffice.
    if (fmt < 1 || fmt > 3) return null;
    const x = v.getInt16(off + 2, false);
    const y = v.getInt16(off + 4, false);
    return { x, y };
  }

  /**
   * Compute mark-to-base attachment offset for (baseGid, markGid).
   * Returns { dx, dy } in font units to shift the mark, or null if
   * the pair isn't covered.
   *
   * Searches both 'mark' (mark-to-base) and 'mkmk' (mark-to-mark)
   * — the caller passes whichever rolling base context they need.
   * Per the OpenType pipeline, marks resolve against either:
   *   - their preceding non-mark glyph (mark-to-base, lookup type 4)
   *   - their preceding mark glyph (mark-to-mark, lookup type 6)
   * The two share the same anchor-record machinery (MarkArray +
   * MarkArray for mkmk, MarkArray + BaseArray for mark), so one
   * helper covers both with a `mkmk` flag.
   */
  getMarkBaseAttachment(baseGid, markGid) {
    return this._scanMarkLookups(this._markLookups, baseGid, markGid, /*type*/ 4);
  }

  getMarkMarkAttachment(prevMarkGid, markGid) {
    return this._scanMarkLookups(this._mkmkLookups, prevMarkGid, markGid, /*type*/ 6);
  }

  /**
   * Mark-to-ligature (GPOS type 5). Lives under 'mark' alongside
   * type 4. The ligature glyph carries N component anchor sets, one
   * per ligature component; the mark binds to the component
   * specified by `componentIdx` (0-based).
   */
  getMarkLigAttachment(ligGid, markGid, componentIdx) {
    if (!this._markLookups) return null;
    const v = this._view;
    for (const lookupOff of this._markLookups) {
      for (const subOff of this._effSubtables(lookupOff, 5)) {
        const fmt = v.getUint16(subOff, false);
        if (fmt !== 1) continue;
        const markCovAbs = subOff + v.getUint16(subOff + 2, false);
        const ligCovAbs  = subOff + v.getUint16(subOff + 4, false);
        const markCovIdx = coverageIndex(v, markCovAbs, markGid);
        if (markCovIdx < 0) continue;
        const ligCovIdx  = coverageIndex(v, ligCovAbs, ligGid);
        if (ligCovIdx < 0) continue;
        const markClassCount = v.getUint16(subOff + 6, false);
        const markArrayOff   = subOff + v.getUint16(subOff + 8,  false);
        const ligArrayOff    = subOff + v.getUint16(subOff + 10, false);

        // MarkArray same as type 4.
        const markCount = v.getUint16(markArrayOff, false);
        if (markCovIdx >= markCount) continue;
        const markRecOff = markArrayOff + 2 + markCovIdx * 4;
        const markClass = v.getUint16(markRecOff, false);
        if (markClass >= markClassCount) continue;
        const markA = this._readAnchor(markArrayOff + v.getUint16(markRecOff + 2, false));
        if (!markA) continue;

        // LigatureArray: u16 ligatureCount, then u16 offsets to
        // LigatureAttach tables.
        const ligCount = v.getUint16(ligArrayOff, false);
        if (ligCovIdx >= ligCount) continue;
        const attachOff = ligArrayOff + v.getUint16(ligArrayOff + 2 + ligCovIdx * 2, false);

        // LigatureAttach: u16 componentCount, then ComponentRecord[]:
        //   u16 ligatureAnchorOffset[markClassCount]
        const compCount = v.getUint16(attachOff, false);
        if (componentIdx >= compCount) continue;
        const compRecOff = attachOff + 2 + componentIdx * (2 * markClassCount);
        const ligAnchorOff16 = v.getUint16(compRecOff + markClass * 2, false);
        if (ligAnchorOff16 === 0) continue;
        const ligA = this._readAnchor(attachOff + ligAnchorOff16);
        if (!ligA) continue;
        return { dx: ligA.x - markA.x, dy: ligA.y - markA.y };
      }
    }
    return null;
  }

  _scanMarkLookups(lookups, baseGid, markGid, wantType) {
    if (!lookups) return null;
    const v = this._view;
    for (const lookupOff of lookups) {
      for (const subOff of this._effSubtables(lookupOff, wantType)) {
        // Mark-to-base format 1 and mark-to-mark format 1 share an
        // identical layout (the spec literally aliases base→mark2
        // for mkmk):
        //   posFormat(2)=1
        //   markCoverageOff(2)         (mark1 for mkmk)
        //   baseCoverageOff(2)         (mark2 for mkmk)
        //   markClassCount(2)
        //   markArrayOff(2)            (mark1Array for mkmk)
        //   baseArrayOff(2)            (mark2Array for mkmk)
        const fmt = v.getUint16(subOff, false);
        if (fmt !== 1) continue;
        const markCovAbs = subOff + v.getUint16(subOff + 2, false);
        const baseCovAbs = subOff + v.getUint16(subOff + 4, false);
        const markCovIdx = coverageIndex(v, markCovAbs, markGid);
        if (markCovIdx < 0) continue;
        const baseCovIdx = coverageIndex(v, baseCovAbs, baseGid);
        if (baseCovIdx < 0) continue;
        const markClassCount = v.getUint16(subOff + 6, false);
        const markArrayOff   = subOff + v.getUint16(subOff + 8,  false);
        const baseArrayOff   = subOff + v.getUint16(subOff + 10, false);

        // MarkArray: u16 markCount, MarkRecord[markCount] (4 bytes
        // each: u16 markClass, u16 markAnchorOff).
        const markCount = v.getUint16(markArrayOff, false);
        if (markCovIdx >= markCount) continue;
        const markRecOff = markArrayOff + 2 + markCovIdx * 4;
        const markClass = v.getUint16(markRecOff, false);
        if (markClass >= markClassCount) continue;
        const markAnchorOff = markArrayOff + v.getUint16(markRecOff + 2, false);
        const markA = this._readAnchor(markAnchorOff);
        if (!markA) continue;

        // BaseArray: u16 baseCount, BaseRecord[baseCount] (2 *
        // markClassCount bytes each: anchor offset per class).
        const baseCount = v.getUint16(baseArrayOff, false);
        if (baseCovIdx >= baseCount) continue;
        const baseRecOff = baseArrayOff + 2 + baseCovIdx * (2 * markClassCount);
        const baseAnchorOff16 = v.getUint16(baseRecOff + markClass * 2, false);
        if (baseAnchorOff16 === 0) continue; // no anchor for this class
        const baseA = this._readAnchor(baseArrayOff + baseAnchorOff16);
        if (!baseA) continue;

        // Shift the mark so its anchor lands on the base's anchor.
        // Both are in font units relative to the glyph's origin.
        return { dx: baseA.x - markA.x, dy: baseA.y - markA.y };
      }
    }
    return null;
  }

  /** @returns {number} font-units delta */
  getPairKerning(a, b) {
    if (!this._lookups) return 0;
    let total = 0;
    for (const lookupOff of this._lookups) {
      // Within a lookup, subtables are ALTERNATIVES: the first one that
      // actually matches the pair ends the search (a matched value of 0
      // included) — summing every subtable double-kerns pairs present in
      // two subtables. Values still accumulate ACROSS lookups.
      for (const subOff of this._effSubtables(lookupOff, 2)) {
        const adj = this._readPairAdjustment(subOff, a, b);
        if (adj !== null) { total += adj; break; }
      }
    }
    return total;
  }

  /// Pair adjustment for (a, b) from one PairPos subtable. Returns the
  /// x-advance delta on a MATCH (which may legitimately be 0), or null
  /// when the subtable doesn't cover the pair — the caller uses the
  /// distinction for first-match-wins subtable search.
  _readPairAdjustment(subOff, a, b) {
    const v = this._view;
    const format = v.getUint16(subOff, false);
    const covAbs = subOff + v.getUint16(subOff + 2, false);
    const aCovIdx = coverageIndex(v, covAbs, a);
    if (aCovIdx < 0) return null;
    const vf1 = v.getUint16(subOff + 4, false);
    const vf2 = v.getUint16(subOff + 6, false);
    const v1Size = valueRecordSize(vf1);
    const v2Size = valueRecordSize(vf2);
    if (format === 1) {
      const pairSetCount = v.getUint16(subOff + 8, false);
      if (aCovIdx >= pairSetCount) return null;
      const pairSetOff = subOff + v.getUint16(subOff + 10 + aCovIdx * 2, false);
      const recCount = v.getUint16(pairSetOff, false);
      const recBase = pairSetOff + 2;
      const recStride = 2 + v1Size + v2Size;
      let lo = 0, hi = recCount - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const rOff = recBase + mid * recStride;
        const second = v.getUint16(rOff, false);
        if (second < b) lo = mid + 1;
        else if (second > b) hi = mid - 1;
        else return valueRecordXAdvance(v, rOff + 2, vf1);
      }
      return null;
    }
    if (format === 2) {
      const classDef1 = subOff + v.getUint16(subOff + 8, false);
      const classDef2 = subOff + v.getUint16(subOff + 10, false);
      const class1Count = v.getUint16(subOff + 12, false);
      const class2Count = v.getUint16(subOff + 14, false);
      const aClass = classOf(v, classDef1, a);
      const bClass = classOf(v, classDef2, b);
      if (aClass >= class1Count || bClass >= class2Count) return null;
      const c1Stride = class2Count * (v1Size + v2Size);
      const matrixBase = subOff + 16;
      const cellOff = matrixBase + aClass * c1Stride + bClass * (v1Size + v2Size);
      return valueRecordXAdvance(v, cellOff, vf1);
    }
    return null;
  }

  // ---- GPOS lookup 1 (SinglePos) -------------------------------

  /**
   * X-advance delta from any SinglePos lookup under the 'kern' feature.
   * Composes additively with pair kerning. Returns 0 when no SinglePos
   * lookup covers this glyph.
   */
  getSingleXAdvanceDelta(gid) {
    if (!this._lookups) return 0;
    let total = 0;
    for (const lookupOff of this._lookups) {
      // First covering subtable wins within a lookup (see getPairKerning).
      for (const subOff of this._effSubtables(lookupOff, 1)) {
        const adj = this._readSinglePos(subOff, gid);
        if (adj !== null) { total += adj; break; }
      }
    }
    return total;
  }

  /// SinglePos x-advance for gid from one subtable: the delta on a match
  /// (may be 0), null when the subtable doesn't cover the glyph.
  _readSinglePos(subOff, gid) {
    const v = this._view;
    const fmt = v.getUint16(subOff, false);
    const covAbs = subOff + v.getUint16(subOff + 2, false);
    const covIdx = coverageIndex(v, covAbs, gid);
    if (covIdx < 0) return null;
    const vf = v.getUint16(subOff + 4, false);
    const vSize = valueRecordSize(vf);
    if (fmt === 1) {
      return valueRecordXAdvance(v, subOff + 6, vf);
    } else if (fmt === 2) {
      const valueCount = v.getUint16(subOff + 6, false);
      if (covIdx >= valueCount) return null;
      const recOff = subOff + 8 + covIdx * vSize;
      return valueRecordXAdvance(v, recOff, vf);
    }
    return null;
  }

  // ================================================================
  // GPOS type 9 — extension. Auto-deref to inner GPOS subtable.
  // ================================================================
  // ExtensionPos format 1:
  //   posFormat(2) = 1
  //   extensionLookupType(2) — inner GPOS lookup type (1..8)
  //   extensionOffset(uint32)
  _derefExt9(subOff) {
    const v = this._view;
    const fmt = v.getUint16(subOff, false);
    if (fmt !== 1) return null;
    const innerType = v.getUint16(subOff + 2, false);
    const innerOff  = subOff + v.getUint32(subOff + 4, false);
    return { innerType, innerOff };
  }

  /// Effective subtable offsets of `lookupOff` whose (Extension-deref'd)
  /// type is `wantType`. Large fonts wrap lookups in Extension (type 9)
  /// when the table outgrows 16-bit offsets — a scanner that gates on the
  /// OUTER lookup type silently no-ops on them (kerning, cursive and mark
  /// attachment all vanish).
  _effSubtables(lookupOff, wantType) {
    const v = this._view;
    const type = v.getUint16(lookupOff, false);
    const subCount = v.getUint16(lookupOff + 4, false);
    const out = [];
    for (let s = 0; s < subCount; s++) {
      let subOff = lookupOff + v.getUint16(lookupOff + 6 + s * 2, false);
      let effType = type;
      if (effType === 9) {
        const inner = this._derefExt9(subOff);
        if (!inner) continue;
        effType = inner.innerType;
        subOff = inner.innerOff;
      }
      if (effType === wantType) out.push(subOff);
    }
    return out;
  }

  // ================================================================
  // GPOS types 7 (ContextPos) + 8 (ChainContextPos) — match the
  // sequence and identify which nested GPOS lookups to apply at
  // which positions. The actual x-advance / anchor application is
  // done by the caller via existing per-type entry points.
  //
  // Returns null on miss. On match, returns
  //   { inputLen, nested: [{ seqIdx, lookupListIdx }, ...] }
  // where seqIdx is the offset from `start` and lookupListIdx is
  // the global lookupList index of the nested GPOS lookup to apply.
  // The caller can resolve that to a (lookupType, lookupOff) pair
  // via the lookup list and apply standard GPOS effects.
  // ================================================================
  _tryContextPos7(subOff, seq, start, filter = null) {
    const v = this._view;
    const fmt = v.getUint16(subOff, false);
    if (fmt === 1) {
      const covAbs = subOff + v.getUint16(subOff + 2, false);
      const covIdx = coverageIndex(v, covAbs, seq[start]);
      if (covIdx < 0) return null;
      const ruleSetCount = v.getUint16(subOff + 4, false);
      if (covIdx >= ruleSetCount) return null;
      const ruleSetOff = subOff + v.getUint16(subOff + 6 + covIdx * 2, false);
      const ruleCount = v.getUint16(ruleSetOff, false);
      for (let r = 0; r < ruleCount; r++) {
        const ruleOff = ruleSetOff + v.getUint16(ruleSetOff + 2 + r * 2, false);
        const hit = this._matchContextRule(ruleOff, seq, start, /*glyphMatch*/ true, null, filter);
        if (hit) return hit;
      }
      return null;
    }
    if (fmt === 2) {
      const covAbs = subOff + v.getUint16(subOff + 2, false);
      if (coverageIndex(v, covAbs, seq[start]) < 0) return null;
      const classDefAbs = subOff + v.getUint16(subOff + 4, false);
      const classSetCount = v.getUint16(subOff + 6, false);
      const startClass = classOf(v, classDefAbs, seq[start]);
      if (startClass >= classSetCount) return null;
      const classSetOffRel = v.getUint16(subOff + 8 + startClass * 2, false);
      if (classSetOffRel === 0) return null;
      const classSetOff = subOff + classSetOffRel;
      const ruleCount = v.getUint16(classSetOff, false);
      for (let r = 0; r < ruleCount; r++) {
        const ruleOff = classSetOff + v.getUint16(classSetOff + 2 + r * 2, false);
        const hit = this._matchContextRule(ruleOff, seq, start, /*glyphMatch*/ false, classDefAbs, filter);
        if (hit) return hit;
      }
      return null;
    }
    if (fmt === 3) {
      const glyphCount = v.getUint16(subOff + 2, false);
      const lookupCount = v.getUint16(subOff + 4, false);
      // Filter-aware walk: get the absolute positions of the glyphCount
      // non-skipped slots starting at `start`. With no filter or a
      // no-op filter, this is contiguous and matches the legacy walk.
      const pos = new Array(glyphCount);
      pos[0] = start;
      if (filter && filter.skip) {
        for (let i = 1; i < glyphCount; i++) {
          const p = GposReader._nthInput(seq, start, i, filter);
          if (p < 0) return null;
          pos[i] = p;
        }
      } else {
        if (start + glyphCount > seq.length) return null;
        for (let i = 1; i < glyphCount; i++) pos[i] = start + i;
      }
      for (let i = 0; i < glyphCount; i++) {
        const covAbs = subOff + v.getUint16(subOff + 6 + i * 2, false);
        if (coverageIndex(v, covAbs, seq[pos[i]]) < 0) return null;
      }
      const recordsBase = subOff + 6 + glyphCount * 2;
      return { inputLen: glyphCount, inputPos: pos, nested: this._readPosLookupRecords(recordsBase, lookupCount) };
    }
    return null;
  }

  _matchContextRule(ruleOff, seq, start, glyphMatch, classDefAbs, filter = null) {
    const v = this._view;
    const glyphCount = v.getUint16(ruleOff, false);
    const lookupCount = v.getUint16(ruleOff + 2, false);
    const inputBase = ruleOff + 4;
    // Build position list (filter-aware) or contiguous.
    const pos = new Array(glyphCount);
    pos[0] = start;
    if (filter && filter.skip) {
      for (let i = 1; i < glyphCount; i++) {
        const p = GposReader._nthInput(seq, start, i, filter);
        if (p < 0) return null;
        pos[i] = p;
      }
    } else {
      if (start + glyphCount > seq.length) return null;
      for (let i = 1; i < glyphCount; i++) pos[i] = start + i;
    }
    for (let i = 1; i < glyphCount; i++) {
      const want = v.getUint16(inputBase + (i - 1) * 2, false);
      const have = seq[pos[i]];
      if (glyphMatch) {
        if (have !== want) return null;
      } else {
        if (classOf(v, classDefAbs, have) !== want) return null;
      }
    }
    const recordsBase = inputBase + (glyphCount - 1) * 2;
    return { inputLen: glyphCount, inputPos: pos, nested: this._readPosLookupRecords(recordsBase, lookupCount) };
  }

  _tryChainContextPos8(subOff, seq, start, filter = null) {
    const v = this._view;
    const fmt = v.getUint16(subOff, false);
    if (fmt === 1) {
      const covAbs = subOff + v.getUint16(subOff + 2, false);
      if (coverageIndex(v, covAbs, seq[start]) < 0) return null;
      const ruleSetCount = v.getUint16(subOff + 4, false);
      const covIdx = coverageIndex(v, covAbs, seq[start]);
      if (covIdx >= ruleSetCount) return null;
      const ruleSetOff = subOff + v.getUint16(subOff + 6 + covIdx * 2, false);
      const ruleCount = v.getUint16(ruleSetOff, false);
      for (let r = 0; r < ruleCount; r++) {
        const ruleOff = ruleSetOff + v.getUint16(ruleSetOff + 2 + r * 2, false);
        const hit = this._matchChainRuleFmt12(ruleOff, seq, start, /*glyphMatch*/ true, null, null, null, filter);
        if (hit) return hit;
      }
      return null;
    }
    if (fmt === 2) {
      const covAbs = subOff + v.getUint16(subOff + 2, false);
      if (coverageIndex(v, covAbs, seq[start]) < 0) return null;
      const backtrackCD = subOff + v.getUint16(subOff + 4, false);
      const inputCD     = subOff + v.getUint16(subOff + 6, false);
      const lookaheadCD = subOff + v.getUint16(subOff + 8, false);
      const classSetCount = v.getUint16(subOff + 10, false);
      const inputClass = classOf(v, inputCD, seq[start]);
      if (inputClass >= classSetCount) return null;
      const classSetOffRel = v.getUint16(subOff + 12 + inputClass * 2, false);
      if (classSetOffRel === 0) return null;
      const classSetOff = subOff + classSetOffRel;
      const ruleCount = v.getUint16(classSetOff, false);
      for (let r = 0; r < ruleCount; r++) {
        const ruleOff = classSetOff + v.getUint16(classSetOff + 2 + r * 2, false);
        const hit = this._matchChainRuleFmt12(ruleOff, seq, start, false, backtrackCD, inputCD, lookaheadCD, filter);
        if (hit) return hit;
      }
      return null;
    }
    if (fmt === 3) {
      let off = subOff + 2;
      const backtrackGlyphCount = v.getUint16(off, false); off += 2;
      const backCov = [];
      for (let i = 0; i < backtrackGlyphCount; i++) { backCov.push(subOff + v.getUint16(off, false)); off += 2; }
      const inputGlyphCount = v.getUint16(off, false); off += 2;
      const inCov = [];
      for (let i = 0; i < inputGlyphCount; i++) { inCov.push(subOff + v.getUint16(off, false)); off += 2; }
      const lookaheadGlyphCount = v.getUint16(off, false); off += 2;
      const lookCov = [];
      for (let i = 0; i < lookaheadGlyphCount; i++) { lookCov.push(subOff + v.getUint16(off, false)); off += 2; }
      const lookupCount = v.getUint16(off, false); off += 2;
      // Build filter-aware backtrack/input/lookahead position lists.
      const useFilter = !!(filter && filter.skip);
      const backPos = new Array(backtrackGlyphCount);
      const inPos = new Array(inputGlyphCount);
      const lookPos = new Array(lookaheadGlyphCount);
      if (useFilter) {
        for (let i = 0; i < backtrackGlyphCount; i++) {
          const p = GposReader._nthBacktrack(seq, start, i, filter);
          if (p < 0) return null;
          backPos[i] = p;
        }
        inPos[0] = start;
        for (let i = 1; i < inputGlyphCount; i++) {
          const p = GposReader._nthInput(seq, start, i, filter);
          if (p < 0) return null;
          inPos[i] = p;
        }
        const lookStart = inputGlyphCount > 0 ? inPos[inputGlyphCount - 1] + 1 : start + 1;
        for (let i = 0; i < lookaheadGlyphCount; i++) {
          const p = GposReader._nthInput(seq, lookStart, i, filter);
          if (p < 0) return null;
          lookPos[i] = p;
        }
      } else {
        if (start < backtrackGlyphCount) return null;
        for (let i = 0; i < backtrackGlyphCount; i++) backPos[i] = start - 1 - i;
        if (start + inputGlyphCount > seq.length) return null;
        for (let i = 0; i < inputGlyphCount; i++) inPos[i] = start + i;
        if (start + inputGlyphCount + lookaheadGlyphCount > seq.length) return null;
        for (let i = 0; i < lookaheadGlyphCount; i++) lookPos[i] = start + inputGlyphCount + i;
      }
      for (let i = 0; i < backtrackGlyphCount; i++)
        if (coverageIndex(v, backCov[i], seq[backPos[i]]) < 0) return null;
      for (let i = 0; i < inputGlyphCount; i++)
        if (coverageIndex(v, inCov[i], seq[inPos[i]]) < 0) return null;
      for (let i = 0; i < lookaheadGlyphCount; i++)
        if (coverageIndex(v, lookCov[i], seq[lookPos[i]]) < 0) return null;
      return { inputLen: inputGlyphCount, inputPos: inPos, nested: this._readPosLookupRecords(off, lookupCount) };
    }
    return null;
  }

  _matchChainRuleFmt12(ruleOff, seq, start, glyphMatch, backtrackCD, inputCD, lookaheadCD, filter = null) {
    const v = this._view;
    let off = ruleOff;
    const backtrackCount = v.getUint16(off, false); off += 2;
    const useFilter = !!(filter && filter.skip);
    // Pre-compute positions per section.
    const backPos = new Array(backtrackCount);
    if (useFilter) {
      for (let i = 0; i < backtrackCount; i++) {
        const p = GposReader._nthBacktrack(seq, start, i, filter);
        if (p < 0) return null;
        backPos[i] = p;
      }
    } else {
      if (start < backtrackCount) return null;
      for (let i = 0; i < backtrackCount; i++) backPos[i] = start - 1 - i;
    }
    for (let i = 0; i < backtrackCount; i++) {
      const want = v.getUint16(off, false); off += 2;
      const have = seq[backPos[i]];
      if (glyphMatch) { if (have !== want) return null; }
      else { if (classOf(v, backtrackCD, have) !== want) return null; }
    }
    const inputCount = v.getUint16(off, false); off += 2;
    const inPos = new Array(inputCount);
    inPos[0] = start;
    if (useFilter) {
      for (let i = 1; i < inputCount; i++) {
        const p = GposReader._nthInput(seq, start, i, filter);
        if (p < 0) return null;
        inPos[i] = p;
      }
    } else {
      if (start + inputCount > seq.length) return null;
      for (let i = 1; i < inputCount; i++) inPos[i] = start + i;
    }
    for (let i = 1; i < inputCount; i++) {
      const want = v.getUint16(off, false); off += 2;
      const have = seq[inPos[i]];
      if (glyphMatch) { if (have !== want) return null; }
      else { if (classOf(v, inputCD, have) !== want) return null; }
    }
    const lookaheadCount = v.getUint16(off, false); off += 2;
    const lookPos = new Array(lookaheadCount);
    if (useFilter) {
      const lookStart = inputCount > 0 ? inPos[inputCount - 1] + 1 : start + 1;
      for (let i = 0; i < lookaheadCount; i++) {
        const p = GposReader._nthInput(seq, lookStart, i, filter);
        if (p < 0) return null;
        lookPos[i] = p;
      }
    } else {
      if (start + inputCount + lookaheadCount > seq.length) return null;
      for (let i = 0; i < lookaheadCount; i++) lookPos[i] = start + inputCount + i;
    }
    for (let i = 0; i < lookaheadCount; i++) {
      const want = v.getUint16(off, false); off += 2;
      const have = seq[lookPos[i]];
      if (glyphMatch) { if (have !== want) return null; }
      else { if (classOf(v, lookaheadCD, have) !== want) return null; }
    }
    const lookupCount = v.getUint16(off, false); off += 2;
    return { inputLen: inputCount, inputPos: inPos, nested: this._readPosLookupRecords(off, lookupCount) };
  }

  _readPosLookupRecords(base, count) {
    const v = this._view;
    const out = [];
    for (let i = 0; i < count; i++) {
      const recOff = base + i * 4;
      out.push({
        seqIdx: v.getUint16(recOff, false),
        lookupListIdx: v.getUint16(recOff + 2, false),
      });
    }
    return out;
  }

  // ================================================================
  // Feature-tag plumbing (additive).
  // ================================================================
  _lookupsByTag(tag) {
    const cached = this._featureCachedLookup(tag);
    if (cached !== undefined) return cached;
    if (this._gposTableOff == null) return null;
    if (!this._featureCache) this._featureCache = {};
    if (tag in this._featureCache) return this._featureCache[tag];
    const tagU32 =
      (tag.charCodeAt(0) << 24) | (tag.charCodeAt(1) << 16) |
      (tag.charCodeAt(2) <<  8) |  tag.charCodeAt(3);
    const r = findFeatureLookups(this._view, this._gposTableOff, tagU32 >>> 0);
    this._featureCache[tag] = r;
    return r;
  }

  _featureCachedLookup(tag) {
    switch (tag) {
      case 'kern': return this._lookups;
      case 'curs': return this._cursLookups;
      case 'mark': return this._markLookups;
      case 'mkmk': return this._mkmkLookups;
      default:     return undefined;
    }
  }

  /// True iff `featureTag` has at least one lookup in the GPOS table.
  hasFeature(featureTag) {
    const l = this._lookupsByTag(featureTag);
    return !!(l && l.length > 0);
  }

  /// Get the global lookupList offset (for callers that want to
  /// resolve nested-lookup indices).
  get lookupListOff() { return this._lookupListOff; }

  /// Get the RAW (lookupType, lookupOff) for a global lookupListIdx —
  /// the type is the outer lookup type (an Extension wrapper reports 9;
  /// deref happens per SUBTABLE via _effSubtables/_derefExt9). Returns
  /// null when out of range.
  getLookupAt(lookupListIdx) {
    if (this._lookupListOff == null) return null;
    const v = this._view;
    const lookupCount = v.getUint16(this._lookupListOff, false);
    if (lookupListIdx >= lookupCount) return null;
    const lookupOff = this._lookupListOff + v.getUint16(this._lookupListOff + 2 + lookupListIdx * 2, false);
    const type = v.getUint16(lookupOff, false);
    return { type, lookupOff };
  }
}
