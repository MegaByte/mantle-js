// gsubReader.js — GSUB substitution support.
// Handles ligatures (lookup type 4), 'smcp'/'c2sc' single-sub
// (lookup type 1) and multiple-sub (lookup type 2).

import { coverageIndex, classOf, findFeatureLookups } from './otCommon.js';
import { makeLookupFilter, readLookupFlags } from './lookupFlag.js';

export class GsubReader {
  constructor(tables) {
    this._view = tables.view;
    // GDEF is set lazily by fontAsset so lookupFlag filtering works.
    // Without it, all class-based skip bits silently no-op.
    this._gdef = null;
    if (!tables.gsub) {
      this._ligaLookups = null;
      this._rligLookups = null;
      this._ccmpLookups = null;
      this._smcpLookups = null;
      this._c2scLookups = null;
      this._isolLookups = null;
      this._initLookups = null;
      this._mediLookups = null;
      this._finaLookups = null;
      this._ljmoLookups = null;
      this._vjmoLookups = null;
      this._tjmoLookups = null;
      this._nuktLookups = null;
      this._akhnLookups = null;
      this._rphfLookups = null;
      this._rkrfLookups = null;
      this._prefLookups = null;
      this._blwfLookups = null;
      this._halfLookups = null;
      this._vatuLookups = null;
      this._cjctLookups = null;
      this._presLookups = null;
      this._abvsLookups = null;
      this._blwsLookups = null;
      this._pstsLookups = null;
      this._halnLookups = null;
      this._caltLookups = null;
      // USE-specific
      this._abvfLookups = null;
      this._pstfLookups = null;
      this._cfarLookups = null;
      this._gsubTableOff = null;
      this._lookupListOff = null;
      this._featureCache = null;
      return;
    }
    const off = tables.gsub[0];
    this._gsubTableOff = off;
    // GSUB header: u16 majorVersion, u16 minorVersion, u16 scriptListOff,
    // u16 featureListOff, u16 lookupListOff. lookupListOff is the third
    // u16 offset after the version word.
    this._lookupListOff = off + this._view.getUint16(off + 8, false);
    this._featureCache = null;
    this._ligaLookups = findFeatureLookups(this._view, off, 0x6C696761 /* 'liga' */);
    // 'rlig' = required ligatures. Always applies regardless of styling
    // (lam-alef, contextual Arabic forms that font REQUIRES to be applied).
    this._rligLookups = findFeatureLookups(this._view, off, 0x726C6967 /* 'rlig' */);
    // 'ccmp' = glyph composition/decomposition. Pre-shaping pass that
    // splits or merges glyphs to get them into canonical shaping form
    // (e.g. precomposed alef-with-hamza-above → alef + hamza).
    this._ccmpLookups = findFeatureLookups(this._view, off, 0x63636D70 /* 'ccmp' */);
    this._smcpLookups = findFeatureLookups(this._view, off, 0x736D6370 /* 'smcp' */);
    this._c2scLookups = findFeatureLookups(this._view, off, 0x63327363 /* 'c2sc' */);
    // Arabic form features. Each maps a gid to the matching
    // contextual form. Per OpenType spec, these are exclusively
    // GSUB lookup type 1 (single substitution).
    this._isolLookups = findFeatureLookups(this._view, off, 0x69736F6C /* 'isol' */);
    this._initLookups = findFeatureLookups(this._view, off, 0x696E6974 /* 'init' */);
    this._mediLookups = findFeatureLookups(this._view, off, 0x6D656469 /* 'medi' */);
    this._finaLookups = findFeatureLookups(this._view, off, 0x66696E61 /* 'fina' */);
    // Hangul jamo features. Each maps a jamo gid to its
    // positional variant (leading / vowel / trailing). Used for raw
    // jamo runs that NFC couldn't compose (archaic + Old Korean).
    this._ljmoLookups = findFeatureLookups(this._view, off, 0x6C6A6D6F /* 'ljmo' */);
    this._vjmoLookups = findFeatureLookups(this._view, off, 0x766A6D6F /* 'vjmo' */);
    this._tjmoLookups = findFeatureLookups(this._view, off, 0x746A6D6F /* 'tjmo' */);
    // Indic features — applied in canonical OT Indic2 order around
    // the reordering pass. Pre-reorder: nukt, akhn, rphf, rkrf, pref,
    // blwf, half, vatu, cjct. Post-reorder: pres, abvs, blws, psts,
    // haln, calt. Each accepts both type-1 (single sub) and type-4
    // (ligature) lookups; the dispatch chooses per lookup type.
    this._nuktLookups = findFeatureLookups(this._view, off, 0x6E756B74 /* 'nukt' */);
    this._akhnLookups = findFeatureLookups(this._view, off, 0x616B686E /* 'akhn' */);
    this._rphfLookups = findFeatureLookups(this._view, off, 0x72706866 /* 'rphf' */);
    this._rkrfLookups = findFeatureLookups(this._view, off, 0x726B7266 /* 'rkrf' */);
    this._prefLookups = findFeatureLookups(this._view, off, 0x70726566 /* 'pref' */);
    this._blwfLookups = findFeatureLookups(this._view, off, 0x626C7766 /* 'blwf' */);
    this._halfLookups = findFeatureLookups(this._view, off, 0x68616C66 /* 'half' */);
    this._vatuLookups = findFeatureLookups(this._view, off, 0x76617475 /* 'vatu' */);
    this._cjctLookups = findFeatureLookups(this._view, off, 0x636A6374 /* 'cjct' */);
    this._presLookups = findFeatureLookups(this._view, off, 0x70726573 /* 'pres' */);
    this._abvsLookups = findFeatureLookups(this._view, off, 0x61627673 /* 'abvs' */);
    this._blwsLookups = findFeatureLookups(this._view, off, 0x626C7773 /* 'blws' */);
    this._pstsLookups = findFeatureLookups(this._view, off, 0x70737473 /* 'psts' */);
    this._halnLookups = findFeatureLookups(this._view, off, 0x68616C6E /* 'haln' */);
    this._caltLookups = findFeatureLookups(this._view, off, 0x63616C74 /* 'calt' */);
    // USE features
    this._abvfLookups = findFeatureLookups(this._view, off, 0x61627666 /* 'abvf' */);
    this._pstfLookups = findFeatureLookups(this._view, off, 0x70737466 /* 'pstf' */);
    this._cfarLookups = findFeatureLookups(this._view, off, 0x63666172 /* 'cfar' */);
  }

  /// Inject a GdefReader so lookupFlag class-based skipping (Ignore
  /// Bases/Ligatures/Marks + MarkAttachmentType + MarkFilteringSet)
  /// can fire during context matching. Called by fontAsset after
  /// construction since GDEF and GSUB are independent readers.
  setGdef(gdef) { this._gdef = gdef; }

  /// Build a LookupFilter for a single lookup, decoding its
  /// lookupFlag + optional markFilteringSet. Used by all type 5/6/8
  /// context-match functions.
  _filterForLookup(lookupOff) {
    const r = readLookupFlags(this._view, lookupOff);
    return makeLookupFilter(r.lookupFlag, r.markFilteringSet, this._gdef);
  }

  /// Filtered seq walker: from `start`, return the nth (1-based) non-
  /// skipped position. n=0 returns `start` itself (assumes start is
  /// not skipped). Returns -1 when seq exhausted.
  static _nthInput(seq, start, n, filter) {
    if (n === 0) return start;
    let count = 0;
    for (let i = start + 1; i < seq.length; i++) {
      if (filter.skip(seq[i])) continue;
      count++;
      if (count === n) return i;
    }
    return -1;
  }

  /// Filtered backtrack walker: from `start`, return the nth (1-based)
  /// non-skipped position walking BACKWARD. n=1 = first prev valid.
  static _nthBacktrack(seq, start, n, filter) {
    let count = 0;
    for (let i = start - 1; i >= 0; i--) {
      if (filter.skip(seq[i])) continue;
      count++;
      if (count === n) return i;
    }
    return -1;
  }

  /// Map input-positions array — for an input of `inputLen` glyphs
  /// starting at `start`, returns the actual seq indices (length
  /// inputLen) where each input glyph lives. Returns null when the
  /// sequence is exhausted before all inputs are found. The first
  /// element is always `start`.
  static _inputPositions(seq, start, inputLen, filter) {
    const pos = new Array(inputLen);
    pos[0] = start;
    for (let i = 1; i < inputLen; i++) {
      const p = GsubReader._nthInput(seq, start, i, filter);
      if (p < 0) return null;
      pos[i] = p;
    }
    return pos;
  }

  get hasLigatures() {
    // Either generic or required ligatures count — both go through
    // the type-4 path. Callers don't need to distinguish.
    return (this._ligaLookups != null && this._ligaLookups.length > 0) ||
           (this._rligLookups != null && this._rligLookups.length > 0);
  }
  get hasCcmp() { return this._ccmpLookups != null && this._ccmpLookups.length > 0; }
  get hasSmcp()      { return this._smcpLookups != null && this._smcpLookups.length > 0; }
  get hasC2sc()      { return this._c2scLookups != null && this._c2scLookups.length > 0; }
  get hasSmallCaps() { return this.hasSmcp || this.hasC2sc; }
  get hasArabicForms() {
    return (this._initLookups && this._initLookups.length > 0) ||
           (this._mediLookups && this._mediLookups.length > 0) ||
           (this._finaLookups && this._finaLookups.length > 0) ||
           (this._isolLookups && this._isolLookups.length > 0);
  }

  /**
   * Map `gid` to the form variant indicated by `form`. Form is the
   * ArabicForm enum value (Isol=0, Init=1, Medi=2, Fina=3). Returns
   * gid unchanged when the font doesn't carry that form's lookup or
   * the gid isn't covered by it.
   */
  substituteArabicForm(gid, form) {
    let lookups;
    switch (form) {
      case 0: lookups = this._isolLookups; break;
      case 1: lookups = this._initLookups; break;
      case 2: lookups = this._mediLookups; break;
      case 3: lookups = this._finaLookups; break;
      default: return gid;
    }
    if (!lookups) return gid;
    return this._applyType1Lookups(lookups, gid);
  }

  get hasHangulJamoForms() {
    return (this._ljmoLookups && this._ljmoLookups.length > 0) ||
           (this._vjmoLookups && this._vjmoLookups.length > 0) ||
           (this._tjmoLookups && this._tjmoLookups.length > 0);
  }

  /**
   * Map a Hangul jamo gid to its positional variant. `role`:
   *   0 = Leading (ljmo, U+1100..U+1112 + extensions)
   *   1 = Vowel   (vjmo, U+1161..U+1175 + extensions)
   *   2 = Trailing (tjmo, U+11A8..U+11C2 + extensions)
   * Returns gid unchanged when the font lacks the feature OR the
   * gid isn't in the feature's coverage. Most modern Korean fonts
   * cover ALL jamo + Old Korean archaic jamo.
   */
  substituteHangulJamo(gid, role) {
    let lookups;
    switch (role) {
      case 0: lookups = this._ljmoLookups; break;
      case 1: lookups = this._vjmoLookups; break;
      case 2: lookups = this._tjmoLookups; break;
      default: return gid;
    }
    if (!lookups) return gid;
    return this._applyType1Lookups(lookups, gid);
  }

  // ---- Indic feature dispatch -----------------------------------

  _indicLookupsByTag(tag) {
    switch (tag) {
      case 'nukt': return this._nuktLookups;
      case 'akhn': return this._akhnLookups;
      case 'rphf': return this._rphfLookups;
      case 'rkrf': return this._rkrfLookups;
      case 'pref': return this._prefLookups;
      case 'blwf': return this._blwfLookups;
      case 'half': return this._halfLookups;
      case 'vatu': return this._vatuLookups;
      case 'cjct': return this._cjctLookups;
      case 'pres': return this._presLookups;
      case 'abvs': return this._abvsLookups;
      case 'blws': return this._blwsLookups;
      case 'psts': return this._pstsLookups;
      case 'haln': return this._halnLookups;
      case 'calt': return this._caltLookups;
      // USE-specific
      case 'abvf': return this._abvfLookups;
      case 'pstf': return this._pstfLookups;
      case 'cfar': return this._cfarLookups;
      default: return null;
    }
  }

  /// True iff any USE-specific feature is present (abvf/pstf/cfar).
  /// Gates USE feature application; pre- and post-shape Indic features
  /// (nukt/blwf/pres/etc.) are picked up by hasIndicFeatures.
  get hasUseFeatures() {
    return !!(this._abvfLookups || this._pstfLookups || this._cfarLookups);
  }

  /// True iff the font carries at least one Indic feature lookup.
  /// Used to bail when the font isn't an Indic font (most Latin fonts
  /// return false here).
  get hasIndicFeatures() {
    return !!(
      this._nuktLookups || this._akhnLookups || this._rphfLookups ||
      this._rkrfLookups || this._prefLookups || this._blwfLookups ||
      this._halfLookups || this._vatuLookups || this._cjctLookups ||
      this._presLookups || this._abvsLookups || this._blwsLookups ||
      this._pstsLookups || this._halnLookups || this._caltLookups
    );
  }

  /**
   * Apply a single Indic feature's type-1 (single-substitution) lookups
   * to `gid`. Returns the substituted gid, or `gid` unchanged when the
   * feature isn't present or doesn't cover this gid.
   */
  substituteIndicSingle(gid, tag) {
    const lookups = this._indicLookupsByTag(tag);
    if (!lookups) return gid;
    return this._applyType1Lookups(lookups, gid);
  }

  /**
   * Apply a single Indic feature's type-4 (ligature) lookup starting
   * at seq[start]. Same contract as tryMatchLigature but scopes to
   * the named feature. Returns { replacement, consumed } or null.
   */
  tryMatchIndicLigature(tag, seq, start) {
    const lookups = this._indicLookupsByTag(tag);
    if (!lookups || start >= seq.length) return null;
    return this._scanLigatureLookups(lookups, seq, start);
  }

  /**
   * @param {Uint16Array|number[]} seq
   * @param {number} start
   * @returns {{ replacement: number, consumed: number } | null}
   */
  tryMatchLigature(seq, start) {
    if (start >= seq.length) return null;
    // Required ligatures (rlig) take precedence over generic (liga) —
    // some fonts only ship lam-alef in rlig. We try rlig first; on
    // miss, fall through to liga.
    if (this._rligLookups) {
      const hit = this._scanLigatureLookups(this._rligLookups, seq, start);
      if (hit) return hit;
    }
    if (this._ligaLookups) {
      const hit = this._scanLigatureLookups(this._ligaLookups, seq, start);
      if (hit) return hit;
    }
    return null;
  }

  _scanLigatureLookups(lookups, seq, start) {
    const first = seq[start];
    for (const lookupOff of lookups) {
      const filter = this._filterForLookup(lookupOff);
      const hit = this._eachSubtable(lookupOff, (effType, subOff) =>
        (effType === 4 ? this._tryLiga4(subOff, seq, start, first, filter) : null));
      if (hit) return hit;
    }
    return null;
  }

  /**
   * Apply 'ccmp' (glyph composition/decomposition) lookups starting
   * at seq[start]. Only handles GSUB type 1 (single substitution) +
   * type 2 (multiple substitution) — type 4 ligature decomposition
   * inside ccmp is rare and handled by the regular liga pass anyway.
   * Returns null when no rule matches.
   *   - On a type-1 hit: { replacements: [rep], consumed: 1 }
   *   - On a type-2 hit: { replacements: [...gids], consumed: 1 }
   */
  tryMatchCcmp(seq, start) {
    if (!this._ccmpLookups || start >= seq.length) return null;
    const first = seq[start];
    for (const lookupOff of this._ccmpLookups) {
      const hit = this._eachSubtable(lookupOff, (effType, subOff) => {
        if (effType === 1) {
          const out = this._trySingleSub1(subOff, first);
          if (out !== first) return { replacements: [out], consumed: 1 };
        } else if (effType === 2) {
          const out = this._tryMultipleSub2(subOff, first);
          if (out) return { replacements: out, consumed: 1 };
        }
        return null;
      });
      if (hit) return hit;
    }
    return null;
  }

  _tryLiga4(subOff, seq, start, first, filter = null) {
    const v = this._view;
    const fmt = v.getUint16(subOff, false);
    if (fmt !== 1) return null;
    const covAbs = subOff + v.getUint16(subOff + 2, false);
    const covIdx = coverageIndex(v, covAbs, first);
    if (covIdx < 0) return null;
    const ligSetCount = v.getUint16(subOff + 4, false);
    if (covIdx >= ligSetCount) return null;
    const ligSetOff = subOff + v.getUint16(subOff + 6 + covIdx * 2, false);
    const ligCount = v.getUint16(ligSetOff, false);
    for (let i = 0; i < ligCount; i++) {
      const ligOff = ligSetOff + v.getUint16(ligSetOff + 2 + i * 2, false);
      const rep = v.getUint16(ligOff, false);
      const compCount = v.getUint16(ligOff + 2, false);
      if (compCount === 0) continue;
      // Filter-aware component walk: when the lookup has e.g.
      // IgnoreMarks, the marks sitting between consonants must NOT
      // count as component positions. Build the position list then
      // verify each component glyph matches at its non-skipped slot.
      if (filter && filter.skip) {
        const pos = new Array(compCount);
        pos[0] = start;
        let ok = true;
        for (let c = 1; c < compCount; c++) {
          const p = GsubReader._nthInput(seq, start, c, filter);
          if (p < 0) { ok = false; break; }
          pos[c] = p;
        }
        if (!ok) continue;
        for (let c = 1; c < compCount; c++) {
          const want = v.getUint16(ligOff + 4 + (c - 1) * 2, false);
          if (seq[pos[c]] !== want) { ok = false; break; }
        }
        // Consumed = span from start through the LAST matched
        // component (inclusive), so the outer loop advances past
        // them. Skipped marks in between stay in the sequence
        // (renderer handles them via subsequent GPOS mark-attach).
        if (ok) return { replacement: rep, consumed: pos[compCount - 1] - start + 1 };
        continue;
      }
      // Legacy contiguous component walk (no filter).
      if (start + compCount > seq.length) continue;
      let ok = true;
      for (let c = 1; c < compCount; c++) {
        const want = v.getUint16(ligOff + 4 + (c - 1) * 2, false);
        if (seq[start + c] !== want) { ok = false; break; }
      }
      if (ok) return { replacement: rep, consumed: compCount };
    }
    return null;
  }

  // ---- GSUB lookup 1 (single substitution) -----------------------

  /**
   * SmallCaps: apply both 'smcp' (lowercase→small-cap) and 'c2sc'
   * (uppercase→small-cap). Returns gid unchanged when no substitution
   * applies.
   */
  substituteSmallCap(gid) {
    let g = gid;
    if (this._smcpLookups) g = this._applyType1Lookups(this._smcpLookups, g);
    if (this._c2scLookups) g = this._applyType1Lookups(this._c2scLookups, g);
    return g;
  }

  _applyType1Lookups(lookups, gid) {
    for (const lookupOff of lookups) {
      const hit = this._eachSubtable(lookupOff, (effType, subOff) => {
        if (effType !== 1) return null;
        const out = this._trySingleSub1(subOff, gid);
        return out !== gid ? out : null;
      });
      if (hit) return hit;
    }
    return gid;
  }

  _trySingleSub1(subOff, gid) {
    const v = this._view;
    const fmt = v.getUint16(subOff, false);
    const covAbs = subOff + v.getUint16(subOff + 2, false);
    const covIdx = coverageIndex(v, covAbs, gid);
    if (covIdx < 0) return gid;
    if (fmt === 1) {
      const delta = v.getInt16(subOff + 4, false);
      return (gid + delta) & 0xFFFF;
    } else if (fmt === 2) {
      const glyphCount = v.getUint16(subOff + 4, false);
      if (covIdx >= glyphCount) return gid;
      return v.getUint16(subOff + 6 + covIdx * 2, false);
    }
    return gid;
  }

  // ---- GSUB lookup 2 (multiple substitution) ---------------------

  /**
   * Multiple-substitution under the 'liga' feature. Returns an array
   * of replacement gids, or null when no substitution applies.
   */
  tryMultipleSubstitute(gid) {
    if (!this._ligaLookups) return null;
    for (const lookupOff of this._ligaLookups) {
      const hit = this._eachSubtable(lookupOff, (effType, subOff) =>
        (effType === 2 ? this._tryMultipleSub2(subOff, gid) : null));
      if (hit) return hit;
    }
    return null;
  }

  _tryMultipleSub2(subOff, gid) {
    const v = this._view;
    const fmt = v.getUint16(subOff, false);
    if (fmt !== 1) return null;
    const covAbs = subOff + v.getUint16(subOff + 2, false);
    const covIdx = coverageIndex(v, covAbs, gid);
    if (covIdx < 0) return null;
    const seqCount = v.getUint16(subOff + 4, false);
    if (covIdx >= seqCount) return null;
    const seqOff = subOff + v.getUint16(subOff + 6 + covIdx * 2, false);
    const glyphCount = v.getUint16(seqOff, false);
    if (glyphCount === 0) return null;
    const out = new Array(glyphCount);
    for (let i = 0; i < glyphCount; i++) {
      out[i] = v.getUint16(seqOff + 2 + i * 2, false);
    }
    return out;
  }

  // ====================================================================
  // Lookup type 3 — alternate substitution (salt/aalt/ss01-ss20 etc.)
  // ====================================================================
  //
  // AlternateSubst format 1:
  //   substFormat(2) = 1
  //   coverageOff(2)
  //   alternateSetCount(2)
  //   alternateSetOffsets[uint16] (one per covered glyph)
  // AlternateSet:
  //   glyphCount(2)
  //   alternateGlyphs[uint16]
  //
  // Without a stylistic-set chosen by the caller, we always pick index 0
  // (the default alternate).
  _tryAlternate3(subOff, gid, altIdx = 0) {
    const v = this._view;
    const fmt = v.getUint16(subOff, false);
    if (fmt !== 1) return gid;
    const covAbs = subOff + v.getUint16(subOff + 2, false);
    const covIdx = coverageIndex(v, covAbs, gid);
    if (covIdx < 0) return gid;
    const altSetCount = v.getUint16(subOff + 4, false);
    if (covIdx >= altSetCount) return gid;
    const altSetOff = subOff + v.getUint16(subOff + 6 + covIdx * 2, false);
    const glyphCount = v.getUint16(altSetOff, false);
    if (glyphCount === 0 || altIdx >= glyphCount) return gid;
    return v.getUint16(altSetOff + 2 + altIdx * 2, false);
  }

  // ====================================================================
  // Lookup type 7 — extension. Auto-deref to inner lookup.
  // ====================================================================
  // ExtensionSubst format 1:
  //   substFormat(2) = 1
  //   extensionLookupType(2) — inner lookup type
  //   extensionOffset(uint32) — offset from this subtable
  //
  // The deref'd inner subtable has the standard format for that lookup
  // type. We return { innerType, innerOff } so the caller can dispatch.
  _derefExt7(subOff) {
    const v = this._view;
    const fmt = v.getUint16(subOff, false);
    if (fmt !== 1) return null;
    const innerType = v.getUint16(subOff + 2, false);
    const innerOff  = subOff + v.getUint32(subOff + 4, false);
    return { innerType, innerOff };
  }

  /// Enumerate a lookup's subtables with Extension (type 7) auto-deref'd:
  /// calls fn(effType, subOff) per subtable, returns fn's first truthy
  /// result. Large fonts (Noto CJK/Arabic) wrap lookups in Extension when
  /// the table outgrows 16-bit offsets — a scanner that gates on the OUTER
  /// lookup type silently no-ops on them.
  _eachSubtable(lookupOff, fn) {
    const v = this._view;
    const type = v.getUint16(lookupOff, false);
    const subCount = v.getUint16(lookupOff + 4, false);
    for (let s = 0; s < subCount; s++) {
      let subOff = lookupOff + v.getUint16(lookupOff + 6 + s * 2, false);
      let effType = type;
      if (effType === 7) {
        const inner = this._derefExt7(subOff);
        if (!inner) continue;
        effType = inner.innerType;
        subOff = inner.innerOff;
      }
      const r = fn(effType, subOff);
      if (r) return r;
    }
    return null;
  }

  // ====================================================================
  // Context-matching engine — shared by types 5 (context), 6 (chaining
  // context), and 8 (reverse chaining context).
  //
  // Each format has its own match function. The engine is "match
  // sequence at start, calling per-position predicate". Predicates:
  //   Format 1: matchGlyph(pos, expectedGid)
  //   Format 2: matchClass(pos, expectedClass) — uses classDefOff
  //   Format 3: matchCoverage(pos, coverageOff) — uses inline cov tables
  //
  // ContextSubst (type 5) has 3 formats; each carries one or more
  // SubstLookupRecord(seqIdx, lookupListIdx) that apply nested lookups
  // at specific positions in the matched input sequence.
  //
  // ChainContextSubst (type 6) is the same but adds backtrack +
  // lookahead sequences flanking the input.
  //
  // ReverseChainSingleSubst (type 8) is unique: it operates per-glyph
  // walking RIGHT to LEFT, replacing a single glyph with the
  // substituteGlyphIDs[covIdx] when the surrounding backtrack +
  // lookahead match. Most fonts use it for Arabic / Hebrew dlig.
  // ====================================================================

  // -- Helper: apply nested lookup at seq[pos] using lookupListIdx ----
  // The nested lookup may itself be type 1-8. Returns { newSeq, advance }
  // describing the effect on the sequence. Internally recursive but
  // limited depth (OT spec caps at 4 levels).
  _applyNestedLookup(seq, pos, lookupListIdx, depth = 0) {
    if (depth >= 4) return null; // OT recursion cap
    const v = this._view;
    const lookupListOff = this._lookupListOff;
    if (lookupListOff == null) return null;
    const lookupCount = v.getUint16(lookupListOff, false);
    if (lookupListIdx >= lookupCount) return null;
    const lookupOff = lookupListOff + v.getUint16(lookupListOff + 2 + lookupListIdx * 2, false);
    let type = v.getUint16(lookupOff, false);
    const subCount = v.getUint16(lookupOff + 4, false);
    // Build filter from THIS nested lookup's flags. Each lookup may
    // have its own skip semantics — e.g. a nested chain lookup may
    // set IgnoreMarks while the parent doesn't.
    const filter = this._filterForLookup(lookupOff);
    for (let s = 0; s < subCount; s++) {
      let subOff = lookupOff + v.getUint16(lookupOff + 6 + s * 2, false);
      let effType = type;
      // Auto-deref extension subtables.
      if (effType === 7) {
        const inner = this._derefExt7(subOff);
        if (!inner) continue;
        effType = inner.innerType;
        subOff = inner.innerOff;
      }
      const gid = seq[pos];
      if (effType === 1) {
        const out = this._trySingleSub1(subOff, gid);
        if (out !== gid) { const ns = seq.slice(); ns[pos] = out; return { newSeq: ns, advance: 1 }; }
      } else if (effType === 2) {
        const out = this._tryMultipleSub2(subOff, gid);
        if (out) { const ns = seq.slice(0, pos).concat(out, seq.slice(pos + 1)); return { newSeq: ns, advance: out.length }; }
      } else if (effType === 3) {
        const out = this._tryAlternate3(subOff, gid, 0);
        if (out !== gid) { const ns = seq.slice(); ns[pos] = out; return { newSeq: ns, advance: 1 }; }
      } else if (effType === 4) {
        // Pass the NESTED lookup's own filter — the top-level ligature
        // path threads it, and without it a nested liga under
        // IgnoreMarks failed to skip marks between components.
        const hit = this._tryLiga4(subOff, seq, pos, gid, filter);
        if (hit) {
          const ns = seq.slice(0, pos).concat([hit.replacement], seq.slice(pos + hit.consumed));
          return { newSeq: ns, advance: 1 };
        }
      } else if (effType === 5) {
        const hit = this._tryContext5(subOff, seq, pos, depth + 1, filter);
        if (hit) return hit;
      } else if (effType === 6) {
        const hit = this._tryChainContext6(subOff, seq, pos, depth + 1);
        if (hit) return hit;
      } else if (effType === 8) {
        // Reverse chain in nested context is unusual; skip.
        continue;
      }
    }
    return null;
  }

  // -- Type 5 ContextSubst -------------------------------------------
  _tryContext5(subOff, seq, start, depth = 0, filter = null) {
    const v = this._view;
    const fmt = v.getUint16(subOff, false);
    // Default filter (no skip) when caller doesn't supply one (e.g.
    // nested-lookup recursion without a parent filter).
    if (!filter) filter = { skip: () => false, rtl: false };
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
        const hit = this._applyContextRule(ruleOff, seq, start, /*glyphMatch*/ true, null, depth, filter);
        if (hit) return hit;
      }
      return null;
    }
    if (fmt === 2) {
      const covAbs = subOff + v.getUint16(subOff + 2, false);
      const covIdx = coverageIndex(v, covAbs, seq[start]);
      if (covIdx < 0) return null;
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
        const hit = this._applyContextRule(ruleOff, seq, start, /*glyphMatch*/ false, classDefAbs, depth, filter);
        if (hit) return hit;
      }
      return null;
    }
    if (fmt === 3) {
      const glyphCount = v.getUint16(subOff + 2, false);
      const lookupCount = v.getUint16(subOff + 4, false);
      // Filter-aware input position resolution.
      const inputPos = GsubReader._inputPositions(seq, start, glyphCount, filter);
      if (!inputPos) return null;
      for (let i = 0; i < glyphCount; i++) {
        const covAbs = subOff + v.getUint16(subOff + 6 + i * 2, false);
        if (coverageIndex(v, covAbs, seq[inputPos[i]]) < 0) return null;
      }
      const recordsBase = subOff + 6 + glyphCount * 2;
      return this._applyNestedLookups(seq, inputPos, recordsBase, lookupCount, depth);
    }
    return null;
  }

  _applyContextRule(ruleOff, seq, start, glyphMatch, classDefAbs, depth, filter) {
    const v = this._view;
    const glyphCount = v.getUint16(ruleOff, false);
    const lookupCount = v.getUint16(ruleOff + 2, false);
    // Resolve filter-aware input positions.
    const inputPos = GsubReader._inputPositions(seq, start, glyphCount, filter);
    if (!inputPos) return null;
    const inputBase = ruleOff + 4;
    for (let i = 1; i < glyphCount; i++) {
      const want = v.getUint16(inputBase + (i - 1) * 2, false);
      const have = seq[inputPos[i]];
      if (glyphMatch) {
        if (have !== want) return null;
      } else if (classDefAbs != null) {
        if (classOf(v, classDefAbs, have) !== want) return null;
      }
    }
    const recordsBase = inputBase + (glyphCount - 1) * 2;
    return this._applyNestedLookups(seq, inputPos, recordsBase, lookupCount, depth);
  }

  // Apply SubstLookupRecord[lookupCount] starting at recordsBase to
  // seq[start..start+inputLen) at depth `depth`. Returns
  // { newSeq, advance } when any nested lookup actually substituted.
  // `inputPos` is either an array of absolute positions in `seq`
  // (filter-aware path) OR a number representing the start position
  // (legacy callers). When passed an array, seqIdx is an index into
  // the array (not an offset from start); seqIdx 0 = inputPos[0],
  // seqIdx 1 = inputPos[1] etc. With a contiguous fallback we add
  // seqIdx to start. Returns { newSeq, advance } if any nested
  // substitution fired; null otherwise.
  _applyNestedLookups(seq, inputPos, recordsBase, lookupCount, depth) {
    const v = this._view;
    let cur = seq;
    let changed = false;
    const isArr = Array.isArray(inputPos);
    const inputLen = isArr ? inputPos.length : 1; // caller passes inputLen elsewhere when not arr
    // Length-changing nested subs (multiple grows, ligature shrinks)
    // shift every later position — records were spec'd against the
    // ORIGINAL sequence, so remap each subsequent target through the
    // deltas applied so far.
    const applied = [];   // { pos, delta } in application order
    const shiftFor = (p) => {
      let s = 0;
      for (const a of applied) if (a.pos < p) s += a.delta;
      return s;
    };
    for (let i = 0; i < lookupCount; i++) {
      const recOff = recordsBase + i * 4;
      const seqIdx = v.getUint16(recOff, false);
      const lookupListIdx = v.getUint16(recOff + 2, false);
      let absPos;
      if (isArr) {
        if (seqIdx >= inputPos.length) continue;
        absPos = inputPos[seqIdx];
      } else {
        absPos = inputPos + seqIdx;
      }
      absPos += shiftFor(absPos);
      if (absPos < 0 || absPos >= cur.length) continue;
      const beforeLen = cur.length;
      const out = this._applyNestedLookup(cur, absPos, lookupListIdx, depth);
      if (out) {
        const d = out.newSeq.length - beforeLen;
        if (d !== 0) applied.push({ pos: absPos, delta: d });
        cur = out.newSeq;
        changed = true;
      }
    }
    if (!changed) return null;
    // Advance covers the whole input span (original extent + the net
    // length change the nested subs applied inside it) so the outer
    // loop lands just past the matched input in the NEW sequence.
    let advance;
    if (isArr) {
      advance = inputPos[inputPos.length - 1] - inputPos[0] + 1;
    } else {
      advance = inputLen;
    }
    for (const a of applied) advance += a.delta;
    return { newSeq: cur, advance: Math.max(1, advance) };
  }

  // -- Type 6 ChainContextSubst -------------------------------------
  _tryChainContext6(subOff, seq, start, depth = 0, filter = null) {
    const v = this._view;
    const fmt = v.getUint16(subOff, false);
    if (!filter) filter = { skip: () => false, rtl: false };
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
        const hit = this._applyChainRuleFmt12(ruleOff, seq, start, /*glyphMatch*/ true, null, null, null, depth, filter);
        if (hit) return hit;
      }
      return null;
    }
    if (fmt === 2) {
      const covAbs = subOff + v.getUint16(subOff + 2, false);
      const covIdx = coverageIndex(v, covAbs, seq[start]);
      if (covIdx < 0) return null;
      const backtrackClassDef = subOff + v.getUint16(subOff + 4, false);
      const inputClassDef     = subOff + v.getUint16(subOff + 6, false);
      const lookaheadClassDef = subOff + v.getUint16(subOff + 8, false);
      const classSetCount = v.getUint16(subOff + 10, false);
      const inputClass = classOf(v, inputClassDef, seq[start]);
      if (inputClass >= classSetCount) return null;
      const classSetOffRel = v.getUint16(subOff + 12 + inputClass * 2, false);
      if (classSetOffRel === 0) return null;
      const classSetOff = subOff + classSetOffRel;
      const ruleCount = v.getUint16(classSetOff, false);
      for (let r = 0; r < ruleCount; r++) {
        const ruleOff = classSetOff + v.getUint16(classSetOff + 2 + r * 2, false);
        const hit = this._applyChainRuleFmt12(ruleOff, seq, start, /*glyphMatch*/ false,
          backtrackClassDef, inputClassDef, lookaheadClassDef, depth, filter);
        if (hit) return hit;
      }
      return null;
    }
    if (fmt === 3) {
      let off = subOff + 2;
      const backtrackGlyphCount = v.getUint16(off, false); off += 2;
      const backtrackCovOffs = [];
      for (let i = 0; i < backtrackGlyphCount; i++) {
        backtrackCovOffs.push(subOff + v.getUint16(off, false)); off += 2;
      }
      const inputGlyphCount = v.getUint16(off, false); off += 2;
      const inputCovOffs = [];
      for (let i = 0; i < inputGlyphCount; i++) {
        inputCovOffs.push(subOff + v.getUint16(off, false)); off += 2;
      }
      const lookaheadGlyphCount = v.getUint16(off, false); off += 2;
      const lookaheadCovOffs = [];
      for (let i = 0; i < lookaheadGlyphCount; i++) {
        lookaheadCovOffs.push(subOff + v.getUint16(off, false)); off += 2;
      }
      const lookupCount = v.getUint16(off, false); off += 2;
      // Filter-aware backtrack walk
      for (let i = 0; i < backtrackGlyphCount; i++) {
        const pos = GsubReader._nthBacktrack(seq, start, i + 1, filter);
        if (pos < 0) return null;
        if (coverageIndex(v, backtrackCovOffs[i], seq[pos]) < 0) return null;
      }
      const inputPos = GsubReader._inputPositions(seq, start, inputGlyphCount, filter);
      if (!inputPos) return null;
      for (let i = 0; i < inputGlyphCount; i++) {
        if (coverageIndex(v, inputCovOffs[i], seq[inputPos[i]]) < 0) return null;
      }
      // Lookahead is positions after the LAST input.
      const lastInput = inputPos[inputPos.length - 1];
      for (let i = 0; i < lookaheadGlyphCount; i++) {
        const pos = GsubReader._nthInput(seq, lastInput, i + 1, filter);
        if (pos < 0) return null;
        if (coverageIndex(v, lookaheadCovOffs[i], seq[pos]) < 0) return null;
      }
      return this._applyNestedLookups(seq, inputPos, off, lookupCount, depth);
    }
    return null;
  }

  _applyChainRuleFmt12(ruleOff, seq, start, glyphMatch,
                        backtrackClassDef, inputClassDef, lookaheadClassDef, depth, filter) {
    const v = this._view;
    let off = ruleOff;
    const backtrackGlyphCount = v.getUint16(off, false); off += 2;
    for (let i = 0; i < backtrackGlyphCount; i++) {
      const want = v.getUint16(off, false); off += 2;
      const pos = GsubReader._nthBacktrack(seq, start, i + 1, filter);
      if (pos < 0) return null;
      const have = seq[pos];
      if (glyphMatch) { if (have !== want) return null; }
      else { if (classOf(v, backtrackClassDef, have) !== want) return null; }
    }
    const inputGlyphCount = v.getUint16(off, false); off += 2;
    const inputPos = GsubReader._inputPositions(seq, start, inputGlyphCount, filter);
    if (!inputPos) return null;
    for (let i = 1; i < inputGlyphCount; i++) {
      const want = v.getUint16(off, false); off += 2;
      const have = seq[inputPos[i]];
      if (glyphMatch) { if (have !== want) return null; }
      else { if (classOf(v, inputClassDef, have) !== want) return null; }
    }
    const lookaheadGlyphCount = v.getUint16(off, false); off += 2;
    const lastInput = inputPos[inputPos.length - 1];
    for (let i = 0; i < lookaheadGlyphCount; i++) {
      const want = v.getUint16(off, false); off += 2;
      const pos = GsubReader._nthInput(seq, lastInput, i + 1, filter);
      if (pos < 0) return null;
      const have = seq[pos];
      if (glyphMatch) { if (have !== want) return null; }
      else { if (classOf(v, lookaheadClassDef, have) !== want) return null; }
    }
    const lookupCount = v.getUint16(off, false); off += 2;
    return this._applyNestedLookups(seq, inputPos, off, lookupCount, depth);
  }

  // -- Type 8 ReverseChainSingleSubst -------------------------------
  //
  // Walks RIGHT-to-LEFT. Replaces seq[start] (single glyph) with the
  // substitute when backtrack + lookahead match.
  //
  // ReverseChainSingleSubst format 1:
  //   substFormat(2) = 1
  //   coverageOff(2)
  //   backtrackGlyphCount(2), backtrackCovOffs[uint16]
  //   lookaheadGlyphCount(2), lookaheadCovOffs[uint16]
  //   glyphCount(2), substituteGlyphIDs[uint16]
  _tryReverseChainSingle8(subOff, seq, start, filter = null) {
    if (!filter) filter = { skip: () => false, rtl: false };
    const v = this._view;
    const fmt = v.getUint16(subOff, false);
    if (fmt !== 1) return null;
    const covAbs = subOff + v.getUint16(subOff + 2, false);
    const covIdx = coverageIndex(v, covAbs, seq[start]);
    if (covIdx < 0) return null;
    let off = subOff + 4;
    const backtrackGlyphCount = v.getUint16(off, false); off += 2;
    for (let i = 0; i < backtrackGlyphCount; i++) {
      const covRel = v.getUint16(off, false); off += 2;
      const pos = GsubReader._nthBacktrack(seq, start, i + 1, filter);
      if (pos < 0) return null;
      if (coverageIndex(v, subOff + covRel, seq[pos]) < 0) return null;
    }
    const lookaheadGlyphCount = v.getUint16(off, false); off += 2;
    for (let i = 0; i < lookaheadGlyphCount; i++) {
      const covRel = v.getUint16(off, false); off += 2;
      const pos = GsubReader._nthInput(seq, start, i + 1, filter);
      if (pos < 0) return null;
      if (coverageIndex(v, subOff + covRel, seq[pos]) < 0) return null;
    }
    const glyphCount = v.getUint16(off, false); off += 2;
    if (covIdx >= glyphCount) return null;
    const substituteGid = v.getUint16(off + covIdx * 2, false);
    return substituteGid;
  }

  // ====================================================================
  // Generic per-feature application: walks a feature's lookups and
  // applies type-1/2/3/4/5/6/7/8 to the whole gid stream.
  //
  // Returns the mutated sequence (or the input unchanged on no-op).
  //
  // Used by the textRun pipeline for "apply feature X across a run":
  //   const newGids = font.gsub.applyFeatureToSeq('salt', gids);
  // ====================================================================
  applyFeatureToSeq(featureTag, seq) {
    const lookups = this._lookupsByTag(featureTag);
    if (!lookups || lookups.length === 0) return seq;
    let cur = seq;
    for (const lookupOff of lookups) {
      cur = this._applyLookupToSeq(lookupOff, cur);
    }
    return cur;
  }

  _applyLookupToSeq(lookupOff, seq) {
    const v = this._view;
    let type = v.getUint16(lookupOff, false);
    const subCount = v.getUint16(lookupOff + 4, false);
    // Build the lookup's GDEF-aware skip predicate once. Used by
    // context/chain/reverse-chain matchers below; non-context types
    // ignore the filter (their match window is the current slot only).
    const filter = this._filterForLookup(lookupOff);
    let cur = seq;
    let i = 0;
    while (i < cur.length) {
      let advance = 1;
      // Per OTL, a lookup does not apply AT a position its lookupFlag
      // skips (IgnoreMarks etc.) — skipped glyphs may only be jumped
      // over inside context/ligature matches, never start one.
      if (filter && filter.skip(cur[i])) { i++; continue; }
      for (let s = 0; s < subCount; s++) {
        let subOff = lookupOff + v.getUint16(lookupOff + 6 + s * 2, false);
        let effType = type;
        if (effType === 7) {
          const inner = this._derefExt7(subOff);
          if (!inner) continue;
          effType = inner.innerType;
          subOff = inner.innerOff;
        }
        const gid = cur[i];
        if (effType === 1) {
          const out = this._trySingleSub1(subOff, gid);
          if (out !== gid) { const ns = cur.slice(); ns[i] = out; cur = ns; advance = 1; break; }
        } else if (effType === 2) {
          const out = this._tryMultipleSub2(subOff, gid);
          if (out) { cur = cur.slice(0, i).concat(out, cur.slice(i + 1)); advance = out.length; break; }
        } else if (effType === 3) {
          const out = this._tryAlternate3(subOff, gid, 0);
          if (out !== gid) { const ns = cur.slice(); ns[i] = out; cur = ns; advance = 1; break; }
        } else if (effType === 4) {
          const hit = this._tryLiga4(subOff, cur, i, gid, filter);
          if (hit) { cur = cur.slice(0, i).concat([hit.replacement], cur.slice(i + hit.consumed)); advance = 1; break; }
        } else if (effType === 5) {
          const hit = this._tryContext5(subOff, cur, i, 0, filter);
          if (hit) { cur = hit.newSeq; advance = hit.advance; break; }
        } else if (effType === 6) {
          const hit = this._tryChainContext6(subOff, cur, i, 0, filter);
          if (hit) { cur = hit.newSeq; advance = hit.advance; break; }
        }
        // Note: type 8 reverse-chain is applied in a separate
        // right-to-left pass, not here.
      }
      i += advance;
    }
    // Type 8 reverse-chain pass (right-to-left). Collect effective type-8
    // subtables first — an Extension (type 7) wrapper hides type 8 from
    // the outer-type gate.
    const revSubs = [];
    for (let s = 0; s < subCount; s++) {
      let subOff = lookupOff + v.getUint16(lookupOff + 6 + s * 2, false);
      let effType = type;
      if (effType === 7) {
        const inner = this._derefExt7(subOff);
        if (!inner) continue;
        effType = inner.innerType;
        subOff = inner.innerOff;
      }
      if (effType === 8) revSubs.push(subOff);
    }
    if (revSubs.length) {
      cur = cur.slice();
      for (let j = cur.length - 1; j >= 0; j--) {
        for (const subOff of revSubs) {
          const out = this._tryReverseChainSingle8(subOff, cur, j, filter);
          if (out !== null && out !== cur[j]) { cur[j] = out; break; }
        }
      }
    }
    return cur;
  }

  // ====================================================================
  // Feature-tag plumbing (additive). Existing call sites still use the
  // specific cached lookups (e.g. this._ligaLookups). This method is
  // for new feature tags that don't need their own field.
  // ====================================================================
  _lookupsByTag(tag) {
    // Cached field shortcuts first
    const cached = this._featureCachedLookup(tag);
    if (cached !== undefined) return cached;
    // On-demand discovery via the existing util
    if (this._lookupListOff == null) return null;
    if (!this._featureCache) this._featureCache = {};
    if (tag in this._featureCache) return this._featureCache[tag];
    const tagU32 =
      (tag.charCodeAt(0) << 24) | (tag.charCodeAt(1) << 16) |
      (tag.charCodeAt(2) <<  8) |  tag.charCodeAt(3);
    const r = findFeatureLookups(this._view, this._gsubTableOff, tagU32 >>> 0);
    this._featureCache[tag] = r;
    return r;
  }

  _featureCachedLookup(tag) {
    switch (tag) {
      case 'liga': return this._ligaLookups;
      case 'rlig': return this._rligLookups;
      case 'ccmp': return this._ccmpLookups;
      case 'smcp': return this._smcpLookups;
      case 'c2sc': return this._c2scLookups;
      case 'isol': return this._isolLookups;
      case 'init': return this._initLookups;
      case 'medi': return this._mediLookups;
      case 'fina': return this._finaLookups;
      case 'ljmo': return this._ljmoLookups;
      case 'vjmo': return this._vjmoLookups;
      case 'tjmo': return this._tjmoLookups;
      case 'nukt': return this._nuktLookups;
      case 'akhn': return this._akhnLookups;
      case 'rphf': return this._rphfLookups;
      case 'rkrf': return this._rkrfLookups;
      case 'pref': return this._prefLookups;
      case 'blwf': return this._blwfLookups;
      case 'half': return this._halfLookups;
      case 'vatu': return this._vatuLookups;
      case 'cjct': return this._cjctLookups;
      case 'pres': return this._presLookups;
      case 'abvs': return this._abvsLookups;
      case 'blws': return this._blwsLookups;
      case 'psts': return this._pstsLookups;
      case 'haln': return this._halnLookups;
      case 'calt': return this._caltLookups;
      case 'abvf': return this._abvfLookups;
      case 'pstf': return this._pstfLookups;
      case 'cfar': return this._cfarLookups;
      default:     return undefined;
    }
  }

  /// Returns true iff `featureTag` has at least one lookup in the font.
  /// Useful for textRun to gate feature application without redundant
  /// findFeatureLookups scans on every call.
  hasFeature(featureTag) {
    const l = this._lookupsByTag(featureTag);
    return !!(l && l.length > 0);
  }

  /// Apply alternate substitution explicitly under `featureTag` (e.g.
  /// 'salt', 'aalt') with caller-chosen alternate index. Returns the
  /// new gid, or `gid` unchanged when no alternate applies.
  substituteAlternate(gid, featureTag, altIdx = 0) {
    const lookups = this._lookupsByTag(featureTag);
    if (!lookups) return gid;
    const v = this._view;
    for (const lookupOff of lookups) {
      let type = v.getUint16(lookupOff, false);
      const subCount = v.getUint16(lookupOff + 4, false);
      for (let s = 0; s < subCount; s++) {
        let subOff = lookupOff + v.getUint16(lookupOff + 6 + s * 2, false);
        let effType = type;
        if (effType === 7) {
          const inner = this._derefExt7(subOff);
          if (!inner) continue;
          effType = inner.innerType;
          subOff = inner.innerOff;
        }
        if (effType === 3) {
          const out = this._tryAlternate3(subOff, gid, altIdx);
          if (out !== gid) return out;
        } else if (effType === 1) {
          // Some fonts encode 'salt' as type 1 (single sub) — accept it.
          const out = this._trySingleSub1(subOff, gid);
          if (out !== gid) return out;
        }
      }
    }
    return gid;
  }
}
