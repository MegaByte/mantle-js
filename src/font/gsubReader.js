// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// gsubReader.js — GSUB substitution support.
// Reads lookup types 1–8, with script/language selection and glyph source tracking.

import {
  coverageIndex,
  coverageRanges,
  classOf,
  findFeatureLookups,
  selectedScriptTag,
  ANY_FEATURE,
  findFeatureSubstitutions,
  requiredFeatureTag,
  featureTagU32,
} from './otCommon.js';
import { makeLookupFilter, readLookupFlags } from './lookupFlag.js';

// The Indic2 feature set the per-syllable dispatch applies, plus cfar,
// which only USE uses. Pre-reorder: nukt, akhn, rphf, rkrf, pref, blwf,
// abvf, half, pstf, vatu, cjct. Post-reorder: init, pres, abvs, blws,
// psts, haln, calt. abvf and pstf belong to both shapers.
const _INDIC_TAGS = new Set([
  'nukt',
  'akhn',
  'rphf',
  'rkrf',
  'pref',
  'blwf',
  'half',
  'vatu',
  'cjct',
  'pres',
  'abvs',
  'blws',
  'psts',
  'haln',
  'calt',
  'abvf',
  'pstf',
  'cfar',
]);

const ARABIC_JOINING_TAGS = new Set([
  'arab',
  'syrc',
  'mong',
  'nko ',
  'mand',
  'phag',
  'mani',
  'psal',
  'adlm',
  'rohg',
  'sogd',
  'chrs',
]);
const INDIC_TAGS = new Set([
  'dev2',
  'dev3',
  'deva',
  'bng2',
  'bng3',
  'beng',
  'gur2',
  'gur3',
  'guru',
  'gjr2',
  'gjr3',
  'gujr',
  'ory2',
  'ory3',
  'orya',
  'tml2',
  'tml3',
  'taml',
  'tel2',
  'tel3',
  'telu',
  'knd2',
  'knd3',
  'knda',
  'mlm2',
  'mlm3',
  'mlym',
  'sinh',
]);

/// Work a malformed font can ask for, bounded as HarfBuzz bounds it (HB_BUFFER_MAX_OPS_FACTOR, HB_BUFFER_MAX_LEN_FACTOR). A context
/// lookup may name itself, and a rule of N records with four levels of nesting is N^4 calls per glyph (64 records: tens of seconds for
/// one glyph in a 1 KB font), each copying the sequence. Past the budget nested lookups stop applying; real fonts stay many orders below it.
const NESTED_LOOKUP_BUDGET = 1 << 16,
  NESTED_LOOKUPS_PER_GLYPH = 256;
/// A multiple substitution stops growing the sequence here: each lookup can multiply it, so a few of them exhaust the heap.
export const MAX_SHAPED_GLYPHS = 1 << 18;

export class GsubReader {
  constructor(tables) {
    this._view = tables.view;
    // GDEF is set lazily by fontAsset so lookupFlag filtering works.
    // Without it, all class-based skip bits silently no-op.
    this._gdef = null;
    this._gsubTableOff = tables.gsub ? tables.gsub[0] : null;
    // GSUB header: u16 majorVersion, u16 minorVersion, u16 scriptListOff,
    // u16 featureListOff, u16 lookupListOff. lookupListOff is the third
    // u16 offset after the version word.
    this._lookupListOff =
      this._gsubTableOff == null
        ? null
        : this._gsubTableOff + this._view.getUint16(this._gsubTableOff + 8, false);
    // Which lookups a feature reaches depends on the run's script and
    // language system — a font's 'dev2' script can carry features its
    // DFLT script does not — so they resolve on demand and cache per
    // selection (see setShapingScript). The features this reader
    // substitutes with:
    //   'liga' generic and 'rlig' required ligatures (type 4); 'rlig'
    //     wins, since some fonts ship lam-alef only there
    //   'ccmp' composition/decomposition, the pre-shaping pass that
    //     splits a precomposed alef-with-hamza into alef + hamza
    //   'smcp' / 'c2sc' small caps
    //   'isol' / 'init' / 'medi' / 'fina' Arabic positional forms
    //   'ljmo' / 'vjmo' / 'tjmo' Hangul jamo positional variants, for
    //     raw jamo runs NFC could not compose (archaic and Old Korean)
    //   the Indic2 set, applied around the reorder: nukt, akhn, rphf,
    //     rkrf, pref, blwf, half, vatu, cjct, then pres, abvs, blws,
    //     psts, haln, calt
    //   the USE set: abvf, pstf, cfar
    this._byLangSys = new Map();
    this._anchorSets = new Map();
    this._selTags = null;
    this._selLang = 0;
    this._cur = this._langSysCache(null, 0);
    this.hasFeatureVariations =
      this._gsubTableOff != null &&
      tables.gsub[1] >= 14 &&
      this._view.getUint16(this._gsubTableOff + 2, false) >= 1 &&
      this._view.getUint32(this._gsubTableOff + 10, false) !== 0;
    if (this.hasFeatureVariations) {
      const count = tables.fvar ? this._view.getUint16(tables.fvar[0] + 8, false) : 0;
      this.setVariationCoords(new Array(count).fill(0));
    }
  }

  /// Justification (JSTF) lookup changes for the lines laid out next, or null for none: { id, enable: LookupList indices to
  /// add, disable: Set of LookupList indices to drop }. A disabled lookup is left out of every feature; an enabled one runs
  /// in a stage of its own after the default features unless a feature already reaches it. See textLayout.js, justification.
  setJustification(mod) {
    if ((this._jstf?.id || 0) === (mod?.id || 0)) return;
    this._jstf = mod || null;
    this._cur = this._langSysCache(this._selTags, this._selLang);
  }

  _lookupIndexOf(lookupOff) {
    if (!this._lookupIndexByOffset) {
      this._lookupIndexByOffset = new Map();
      const v = this._view,
        base = this._lookupListOff;
      const n = base == null ? 0 : v.getUint16(base, false);
      for (let i = 0; i < n; i++)
        this._lookupIndexByOffset.set(base + v.getUint16(base + 2 + i * 2, false), i);
    }
    return this._lookupIndexByOffset.get(lookupOff);
  }

  _lookupOffsetOf(index) {
    const v = this._view,
      base = this._lookupListOff;
    return base == null || index >= v.getUint16(base, false)
      ? null
      : base + v.getUint16(base + 2 + index * 2, false);
  }

  /**
   * Select the script and language system later feature lookups resolve
   * under. `scriptTags` is the run's ordered OpenType script tags (see
   * otScriptTags.js), or null for Latin; `langTag` is a 4-byte OpenType
   * language system tag, or 0 for the script's default. Cheap per glyph:
   * re-selecting the current pair returns at once, and each selection
   * keeps its own resolved-lookup cache.
   */
  setShapingScript(scriptTags = null, langTag = 0) {
    const tags = scriptTags || null;
    const lang = langTag || 0;
    if (tags === this._selTags && lang === this._selLang) return;
    this._selTags = tags;
    this._selLang = lang;
    this._cur = this._langSysCache(tags, lang);
  }

  /** Select conditional feature tables; caches remain keyed by the selected substitution set. */
  setVariationCoords(coords) {
    if (!this.hasFeatureVariations) return;
    const previous = this._variationCoords;
    if (
      previous &&
      previous.length === coords.length &&
      previous.every((value, index) => value === coords[index])
    )
      return;
    this._variationCoords = Array.from(coords);
    const selected = findFeatureSubstitutions(this._view, this._gsubTableOff, coords);
    if ((selected?.offset || 0) === (this._featureSubstitutions?.offset || 0)) return;
    this._featureSubstitutions = selected;
    this._cur = this._langSysCache(this._selTags, this._selLang);
  }

  _langSysCache(scriptTags, langTag) {
    const key =
      (scriptTags ? scriptTags.join(',') : '') +
      '|' +
      langTag +
      '|' +
      (this._featureSubstitutions?.offset || 0) +
      '|j' +
      (this._jstf?.id || 0);
    let m = this._byLangSys.get(key);
    if (!m) {
      m = new Map();
      this._byLangSys.set(key, m);
    }
    return m;
  }

  /// Inject a GdefReader so lookupFlag class-based skipping (Ignore
  /// Bases/Ligatures/Marks + MarkAttachmentType + MarkFilteringSet)
  /// can fire during context matching. Called by fontAsset after
  /// construction since GDEF and GSUB are independent readers.
  setGdef(gdef) {
    this._gdef = gdef;
  }

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
  ///
  /// A per-glyph feature mask (see applyFeatureToSeqTracked) applies to
  /// the INPUT window and nothing else: an unmasked glyph inside it
  /// fails the match rather than being stepped over, while backtrack and
  /// lookahead are matched unmasked, because the mask says which glyphs
  /// the feature may rewrite, not which ones it may read.
  static _inputPositions(seq, start, inputLen, filter) {
    const pos = new Array(inputLen);
    pos[0] = start;
    for (let i = 1; i < inputLen; i++) {
      const p = GsubReader._nthInput(seq, start, i, filter);
      if (p < 0) return null;
      pos[i] = p;
    }
    if (filter && filter.maskAt) {
      for (let i = 0; i < inputLen; i++) if (!filter.maskAt(pos[i])) return null;
    }
    return pos;
  }

  get hasLigatures() {
    // Either generic or required ligatures count — both go through
    // the type-4 path. Callers don't need to distinguish.
    return this.hasFeature('liga') || this.hasFeature('rlig');
  }
  get hasTable() {
    return this._gsubTableOff != null;
  }

  get hasCcmp() {
    return this.hasFeature('ccmp');
  }
  get hasSmcp() {
    return this.hasFeature('smcp');
  }
  get hasC2sc() {
    return this.hasFeature('c2sc');
  }
  get hasSmallCaps() {
    return this.hasSmcp || this.hasC2sc;
  }
  get hasArabicForms() {
    return (
      this.hasFeature('init') ||
      this.hasFeature('medi') ||
      this.hasFeature('fina') ||
      this.hasFeature('isol')
    );
  }

  /// True when some positional form's lookup is more than a single substitution, so the per-glyph substituteArabicForm cannot
  /// carry it. Cached per script and language system.
  get arabicFormsNeedSequence() {
    let r = this._cur.get('formsSeq');
    if (r === undefined) {
      r = false;
      for (const tag of ['isol', 'init', 'medi', 'fina']) {
        for (const lookup of this._lookupsByTag(tag) || []) {
          if (this._eachSubtable(lookup, (type) => type !== 1)) r = true;
        }
      }
      this._cur.set('formsSeq', r);
    }
    return r;
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
      case 0:
        lookups = this._lookupsByTag('isol');
        break;
      case 1:
        lookups = this._lookupsByTag('init');
        break;
      case 2:
        lookups = this._lookupsByTag('medi');
        break;
      case 3:
        lookups = this._lookupsByTag('fina');
        break;
      default:
        return gid;
    }
    if (!lookups) return gid;
    return this._applyType1Lookups(lookups, gid);
  }

  get hasHangulJamoForms() {
    return this.hasFeature('ljmo') || this.hasFeature('vjmo') || this.hasFeature('tjmo');
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
      case 0:
        lookups = this._lookupsByTag('ljmo');
        break;
      case 1:
        lookups = this._lookupsByTag('vjmo');
        break;
      case 2:
        lookups = this._lookupsByTag('tjmo');
        break;
      default:
        return gid;
    }
    if (!lookups) return gid;
    return this._applyType1Lookups(lookups, gid);
  }

  // ---- Indic feature dispatch -----------------------------------
  //

  _indicLookupsByTag(tag) {
    return _INDIC_TAGS.has(tag) ? this._lookupsByTag(tag) : null;
  }

  /// True iff any of abvf/pstf/cfar is present. Gates USE feature
  /// application; the Indic dispatch applies abvf and pstf too, but gates on
  /// hasIndicFeatures, which deliberately ignores these three so a Khmer-only
  /// font carrying cfar is not mistaken for an Indic one.
  get hasUseFeatures() {
    return this.hasFeature('abvf') || this.hasFeature('pstf') || this.hasFeature('cfar');
  }

  /// True iff the font carries at least one Indic feature lookup under
  /// the selected script. Used to bail when the font isn't an Indic
  /// font (most Latin fonts return false here).
  get hasIndicFeatures() {
    for (const tag of _INDIC_TAGS) {
      if (tag === 'abvf' || tag === 'pstf' || tag === 'cfar') continue;
      if (this.hasFeature(tag)) return true;
    }
    return false;
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
   * @param {boolean} [optional] false skips `liga` and keeps only required ligatures (`rlig`)
   * @returns {{ replacement: number, consumed: number } | null}
   */
  tryMatchLigature(seq, start, optional = true) {
    if (start >= seq.length) return null;

    const rligLookups = this._lookupsByTag('rlig');
    if (rligLookups) {
      const hit = this._scanLigatureLookups(rligLookups, seq, start);
      if (hit) return hit;
    }
    const ligaLookups = optional ? this._lookupsByTag('liga') : null;
    if (ligaLookups) {
      const hit = this._scanLigatureLookups(ligaLookups, seq, start);
      if (hit) return hit;
    }
    return null;
  }

  /// Replace ligature components while preserving marks skipped by the lookup filter.
  /// compPos identifies component indices within the consumed span. keepFirst applies
  /// the same edit to a source-index array, retaining the first component's source.
  static _spliceLigature(seq, start, hit, keepFirst = false) {
    const kept = [];
    if (hit.compPos && hit.consumed > hit.compPos.length) {
      let seen = 0;
      for (let q = start; q < start + hit.consumed; q++) {
        if (seen < hit.compPos.length && hit.compPos[seen] === q) {
          seen++;
          continue;
        }
        kept.push(seq[q]);
      }
    }
    return seq
      .slice(0, start)
      .concat([keepFirst ? seq[start] : hit.replacement], kept, seq.slice(start + hit.consumed)); // keepFirst: a source-index array
  }

  static _trackMultiple(track, pos, count) {
    if (!track?.components) return;
    track.components.splice(pos, 1, ...new Array(count).fill(1));
    track.markComponents.splice(pos, 1, ...new Array(count).fill(track.markComponents[pos]));
  }

  static _trackLigature(track, pos, hit) {
    if (!track?.components) return;
    const positions = hit.compPos || Array.from({ length: hit.consumed }, (_, i) => pos + i);
    track.mergedSourceRanges.push([
      Math.min(...positions.map((i) => track.src[i])),
      Math.max(...positions.map((i) => track.src[i])),
    ]);
    const keptComponents = [],
      keptMarks = [];
    let cursor = 0,
      componentCount = 0;
    for (let q = pos; q < pos + hit.consumed; q++) {
      if (positions[cursor] === q) {
        componentCount += track.components[q];
        cursor++;
      } else {
        keptComponents.push(track.components[q]);
        keptMarks.push(Math.max(0, componentCount - 1));
      }
    }
    track.components.splice(pos, hit.consumed, componentCount, ...keptComponents);
    track.markComponents.splice(pos, hit.consumed, -1, ...keptMarks);
  }

  _scanLigatureLookups(lookups, seq, start) {
    const first = seq[start];
    for (const lookupOff of lookups) {
      const filter = this._filterForLookup(lookupOff);
      const hit = this._eachSubtable(lookupOff, (effType, subOff) =>
        effType === 4 ? this._tryLiga4(subOff, seq, start, first, filter) : null,
      );
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
    const lookups = this._lookupsByTag('ccmp');
    if (!lookups || start >= seq.length) return null;
    let current = [seq[start]],
      matched = false;
    for (const lookup of lookups) {
      const next = [],
        filter = this._filterForLookup(lookup);
      for (const glyph of current) {
        const hit = filter.skip(glyph)
          ? null
          : this._eachSubtable(lookup, (type, offset) => {
              if (type === 1) {
                const replacement = this._matchSingleSub1(offset, glyph);
                return replacement == null ? null : [replacement];
              }
              return type === 2 ? this._tryMultipleSub2(offset, glyph) : null;
            });
        if (hit) {
          next.push(...hit);
          matched = true;
        } else next.push(glyph);
      }
      current = next;
    }
    return matched ? { replacements: current, consumed: 1 } : null;
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
          if (p < 0) {
            ok = false;
            break;
          }
          pos[c] = p;
        }
        if (!ok) continue;
        for (let c = 1; c < compCount; c++) {
          const want = v.getUint16(ligOff + 4 + (c - 1) * 2, false);
          if (seq[pos[c]] !== want) {
            ok = false;
            break;
          }
        }
        // Every component has to carry the feature's mask, not just the
        // first: a ligature is one substitution over the whole window.
        if (ok && filter.maskAt) {
          for (let c = 0; c < compCount; c++)
            if (!filter.maskAt(pos[c])) {
              ok = false;
              break;
            }
        }
        // Consumed = span from start through the LAST matched component
        // (inclusive). `compPos` reports WHICH positions in that span were
        // components, so the caller can tell them from the marks the filter
        // skipped — those marks must survive the substitution (a diacritic
        // written between two ligating letters, e.g. Arabic lam-FATHA-alef),
        // and each needs to know which component it followed for MarkLigPos.
        if (ok) return { replacement: rep, consumed: pos[compCount - 1] - start + 1, compPos: pos };
        continue;
      }
      // Legacy contiguous component walk (no filter).
      if (start + compCount > seq.length) continue;
      let ok = true;
      for (let c = 1; c < compCount; c++) {
        const want = v.getUint16(ligOff + 4 + (c - 1) * 2, false);
        if (seq[start + c] !== want) {
          ok = false;
          break;
        }
      }
      if (ok && filter && filter.maskAt) {
        for (let c = 0; c < compCount; c++)
          if (!filter.maskAt(start + c)) {
            ok = false;
            break;
          }
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
    const smcpLookups = this._lookupsByTag('smcp');
    const c2scLookups = this._lookupsByTag('c2sc');
    if (smcpLookups) g = this._applyType1Lookups(smcpLookups, g);
    if (c2scLookups) g = this._applyType1Lookups(c2scLookups, g);
    return g;
  }

  /** Required variation alternates run before other GSUB features and accept only type 1. */
  substituteRequiredVariation(gid) {
    for (const lookup of this._lookupsByTag('rvrn', true) || []) {
      if (this._filterForLookup(lookup).skip(gid)) continue;
      const hit = this._eachSubtable(lookup, (type, offset) => {
        if (type !== 1) return null;
        const replacement = this._matchSingleSub1(offset, gid);
        return replacement == null ? null : { gid: replacement };
      });
      if (hit) gid = hit.gid;
    }
    return gid;
  }

  _applyType1Lookups(lookups, gid) {
    for (const lookupOff of lookups) {
      if (this._filterForLookup(lookupOff).skip(gid)) continue;
      const hit = this._eachSubtable(lookupOff, (effType, subOff) => {
        if (effType !== 1) return null;
        const out = this._matchSingleSub1(subOff, gid);
        return out == null ? null : { gid: out };
      });
      if (hit) gid = hit.gid;
    }
    return gid;
  }

  _matchSingleSub1(subOff, gid) {
    const v = this._view;
    const fmt = v.getUint16(subOff, false);
    const covAbs = subOff + v.getUint16(subOff + 2, false);
    const covIdx = coverageIndex(v, covAbs, gid);
    if (covIdx < 0) return null;
    if (fmt === 1) {
      const delta = v.getInt16(subOff + 4, false);
      return (gid + delta) & 0xffff;
    } else if (fmt === 2) {
      const glyphCount = v.getUint16(subOff + 4, false);
      if (covIdx >= glyphCount) return null;
      return v.getUint16(subOff + 6 + covIdx * 2, false);
    }
    return null;
  }

  // ---- GSUB lookup 2 (multiple substitution) ---------------------

  /**
   * Multiple-substitution under the 'liga' feature. Returns an array
   * of replacement gids, or null when no substitution applies.
   */
  tryMultipleSubstitute(gid) {
    const ligaLookups = this._lookupsByTag('liga');
    if (!ligaLookups) return null;
    for (const lookupOff of ligaLookups) {
      const hit = this._eachSubtable(lookupOff, (effType, subOff) =>
        effType === 2 ? this._tryMultipleSub2(subOff, gid) : null,
      );
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
  _tryAlternate3(subOff, gid, altIdx = 0) {
    return this._matchAlternate3(subOff, gid, altIdx) ?? gid;
  }

  _matchAlternate3(subOff, gid, altIdx = 0) {
    const v = this._view;
    const fmt = v.getUint16(subOff, false);
    if (fmt !== 1) return null;
    const covAbs = subOff + v.getUint16(subOff + 2, false);
    const covIdx = coverageIndex(v, covAbs, gid);
    if (covIdx < 0) return null;
    const altSetCount = v.getUint16(subOff + 4, false);
    if (covIdx >= altSetCount) return null;
    const altSetOff = subOff + v.getUint16(subOff + 6 + covIdx * 2, false);
    const glyphCount = v.getUint16(altSetOff, false);
    if (glyphCount === 0 || altIdx >= glyphCount) return null;
    return v.getUint16(altSetOff + 2 + altIdx * 2, false);
  }

  // ====================================================================
  // Lookup type 7 — extension. Auto-deref to inner lookup.
  // ====================================================================
  // ExtensionSubst format 1:
  //   substFormat(2) = 1
  //   extensionLookupType(2) — inner lookup type
  //   extensionOffset(uint32) — offset from this subtable

  _derefExt7(subOff) {
    const v = this._view;
    const fmt = v.getUint16(subOff, false);
    if (fmt !== 1) return null;
    const innerType = v.getUint16(subOff + 2, false);
    const innerOff = subOff + v.getUint32(subOff + 4, false);
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

  /**
   * Glyphs at which a lookup can act, as a bitmap indexed by glyph id, or
   * null when some subtable cannot be enumerated. Every GSUB rule is
   * anchored at a glyph its subtable's Coverage lists (the first input
   * coverage for formats that carry one per position), so a glyph outside
   * the bitmap starts no match.
   */
  _lookupAnchors(lookupOff) {
    let set = this._anchorSets.get(lookupOff);
    if (set !== undefined) return set;
    const v = this._view;
    const ranges = [];
    let known = true;
    this._eachSubtable(lookupOff, (type, sub) => {
      let covRel = -1;
      if ((type >= 1 && type <= 4) || type === 8) covRel = v.getUint16(sub + 2, false);
      else if (type === 5 || type === 6) {
        const fmt = v.getUint16(sub, false);
        if (fmt === 1 || fmt === 2) covRel = v.getUint16(sub + 2, false);
        else if (fmt === 3 && type === 5 && v.getUint16(sub + 2, false) > 0)
          covRel = v.getUint16(sub + 6, false);
        else if (fmt === 3 && type === 6) {
          const backtrack = v.getUint16(sub + 2, false);
          if (v.getUint16(sub + 4 + backtrack * 2, false) > 0)
            covRel = v.getUint16(sub + 6 + backtrack * 2, false);
        }
      }
      if (covRel < 0 || !coverageRanges(v, sub + covRel, ranges)) known = false;
      return null;
    });
    if (known) {
      let last = 0;
      for (let i = 1; i < ranges.length; i += 2) if (ranges[i] > last) last = ranges[i];
      set = new Uint8Array(last + 1);
      for (let i = 0; i < ranges.length; i += 2) set.fill(1, ranges[i], ranges[i + 1] + 1);
    } else set = null;
    this._anchorSets.set(lookupOff, set);
    return set;
  }

  /**
   * Whether applying the feature's lookups to gids[start, end) can change
   * anything. False only when no glyph is an anchor of any lookup.
   */
  featureMayChange(featureTag, gids, start, end, includeRequired = false) {
    const lookups = featureTag ? this._lookupsByTag(featureTag, includeRequired) : null;
    if (!lookups) return false;
    const sets = [];
    for (const lookup of lookups) {
      const set = this._lookupAnchors(lookup);
      if (!set) return true;
      sets.push(set);
    }
    for (let i = start; i < end; i++) {
      const g = gids[i];
      for (let k = 0; k < sets.length; k++) if (g < sets[k].length && sets[k][g] === 1) return true;
    }
    return false;
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
  // limited to four levels.
  _applyNestedLookup(seq, pos, lookupListIdx, depth = 0, track = null) {
    if (depth >= 4 || this._nestedBudget <= 0) return null;
    this._nestedBudget -= 1 + (seq.length >> 10); // each application copies the sequence
    const v = this._view;
    const lookupListOff = this._lookupListOff;
    if (lookupListOff == null) return null;
    const lookupCount = v.getUint16(lookupListOff, false);
    if (lookupListIdx >= lookupCount) return null;
    const lookupOff = lookupListOff + v.getUint16(lookupListOff + 2 + lookupListIdx * 2, false);
    let type = v.getUint16(lookupOff, false);
    const subCount = v.getUint16(lookupOff + 4, false);
    // Build filter from this nested lookup's flags. Each lookup may
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
        const out = this._matchSingleSub1(subOff, gid);
        if (out != null) {
          const ns = seq.slice();
          ns[pos] = out;
          return { newSeq: ns, advance: 1 };
        }
      } else if (effType === 2) {
        const out = this._tryMultipleSub2(subOff, gid);
        if (out && seq.length + out.length <= MAX_SHAPED_GLYPHS) {
          if (track)
            track.src = track.src
              .slice(0, pos)
              .concat(new Array(out.length).fill(track.src[pos]), track.src.slice(pos + 1));
          GsubReader._trackMultiple(track, pos, out.length);
          const ns = seq.slice(0, pos).concat(out, seq.slice(pos + 1));
          return { newSeq: ns, advance: out.length };
        }
      } else if (effType === 3) {
        const out = this._matchAlternate3(subOff, gid, 0);
        if (out != null) {
          const ns = seq.slice();
          ns[pos] = out;
          return { newSeq: ns, advance: 1 };
        }
      } else if (effType === 4) {
        // Pass the NESTED lookup's own filter — the top-level ligature
        // path threads it, and without it a nested liga under
        // IgnoreMarks failed to skip marks between components.
        const hit = this._tryLiga4(subOff, seq, pos, gid, filter);
        if (hit) {
          GsubReader._trackLigature(track, pos, hit);
          if (track) track.src = GsubReader._spliceLigature(track.src, pos, hit, true);
          const ns = GsubReader._spliceLigature(seq, pos, hit);
          return { newSeq: ns, advance: 1 };
        }
      } else if (effType === 5) {
        const hit = this._tryContext5(subOff, seq, pos, depth + 1, filter, track);
        if (hit) return hit;
      } else if (effType === 6) {
        const hit = this._tryChainContext6(subOff, seq, pos, depth + 1, filter, track);
        if (hit) return hit;
      } else if (effType === 8) {
        // Reverse chain in nested context is unusual; skip.
        continue;
      }
    }
    return null;
  }

  // -- Type 5 ContextSubst -------------------------------------------
  _tryContext5(subOff, seq, start, depth = 0, filter = null, track = null) {
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
        const hit = this._applyContextRule(
          ruleOff,
          seq,
          start,
          /*glyphMatch*/ true,
          null,
          depth,
          filter,
          track,
        );
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
        const hit = this._applyContextRule(
          ruleOff,
          seq,
          start,
          /*glyphMatch*/ false,
          classDefAbs,
          depth,
          filter,
          track,
        );
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
      return this._applyNestedLookups(seq, inputPos, recordsBase, lookupCount, depth, track);
    }
    return null;
  }

  _applyContextRule(ruleOff, seq, start, glyphMatch, classDefAbs, depth, filter, track = null) {
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
    return this._applyNestedLookups(seq, inputPos, recordsBase, lookupCount, depth, track);
  }

  /// Apply a rule's SequenceLookupRecords in order. Each "applies to the results of the actions indicated by the preceding record"
  /// (OpenType, Common Table Formats), so a sequence index counts positions in the sequence as it stands: the output glyphs of a
  /// multiple substitution each take a position and a ligature's components give theirs up, which is what HarfBuzz does
  /// (apply_lookup) and what fonts are tested against. Noto Nastaliq Urdu relies on it.
  _applyNestedLookups(seq, inputPos, recordsBase, lookupCount, depth, track = null) {
    const v = this._view;
    let cur = seq;
    const positions = inputPos.slice();
    let net = 0;
    for (let i = 0; i < lookupCount; i++) {
      const recOff = recordsBase + i * 4;
      const seqIdx = v.getUint16(recOff, false);
      const lookupListIdx = v.getUint16(recOff + 2, false);
      if (seqIdx >= positions.length) continue;
      const absPos = positions[seqIdx];
      if (absPos >= cur.length) continue;
      const beforeLen = cur.length;
      const out = this._applyNestedLookup(cur, absPos, lookupListIdx, depth, track);
      if (!out) continue;
      cur = out.newSeq;
      const delta = cur.length - beforeLen;
      if (delta === 0) continue;
      net += delta;
      if (delta > 0) {
        const added = [];
        for (let k = 1; k <= delta; k++) added.push(absPos + k);
        positions.splice(seqIdx + 1, 0, ...added);
        for (let k = seqIdx + 1 + delta; k < positions.length; k++) positions[k] += delta;
      } else {
        const removed = Math.min(-delta, positions.length - seqIdx - 1);
        positions.splice(seqIdx + 1, removed);
        for (let k = seqIdx + 1; k < positions.length; k++) positions[k] += delta;
      }
    }
    // Matching the context consumes this rule even when its nested lookup is a no-op.
    // Advance covers the whole input span (original extent + the net
    // length change the nested subs applied inside it) so the outer
    // loop lands just past the matched input in the NEW sequence.
    const advance = inputPos[inputPos.length - 1] - inputPos[0] + 1 + net;
    return { newSeq: cur, advance: Math.max(1, advance) };
  }

  // -- Type 6 ChainContextSubst -------------------------------------
  _tryChainContext6(subOff, seq, start, depth = 0, filter = null, track = null) {
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
        const hit = this._applyChainRuleFmt12(
          ruleOff,
          seq,
          start,
          /*glyphMatch*/ true,
          null,
          null,
          null,
          depth,
          filter,
          track,
        );
        if (hit) return hit;
      }
      return null;
    }
    if (fmt === 2) {
      const covAbs = subOff + v.getUint16(subOff + 2, false);
      const covIdx = coverageIndex(v, covAbs, seq[start]);
      if (covIdx < 0) return null;
      const backtrackClassDef = subOff + v.getUint16(subOff + 4, false);
      const inputClassDef = subOff + v.getUint16(subOff + 6, false);
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
        const hit = this._applyChainRuleFmt12(
          ruleOff,
          seq,
          start,
          /*glyphMatch*/ false,
          backtrackClassDef,
          inputClassDef,
          lookaheadClassDef,
          depth,
          filter,
          track,
        );
        if (hit) return hit;
      }
      return null;
    }
    if (fmt === 3) {
      let off = subOff + 2;
      const backtrackGlyphCount = v.getUint16(off, false);
      off += 2;
      const backtrackCovOffs = [];
      for (let i = 0; i < backtrackGlyphCount; i++) {
        backtrackCovOffs.push(subOff + v.getUint16(off, false));
        off += 2;
      }
      const inputGlyphCount = v.getUint16(off, false);
      off += 2;
      const inputCovOffs = [];
      for (let i = 0; i < inputGlyphCount; i++) {
        inputCovOffs.push(subOff + v.getUint16(off, false));
        off += 2;
      }
      const lookaheadGlyphCount = v.getUint16(off, false);
      off += 2;
      const lookaheadCovOffs = [];
      for (let i = 0; i < lookaheadGlyphCount; i++) {
        lookaheadCovOffs.push(subOff + v.getUint16(off, false));
        off += 2;
      }
      const lookupCount = v.getUint16(off, false);
      off += 2;
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
      return this._applyNestedLookups(seq, inputPos, off, lookupCount, depth, track);
    }
    return null;
  }

  _applyChainRuleFmt12(
    ruleOff,
    seq,
    start,
    glyphMatch,
    backtrackClassDef,
    inputClassDef,
    lookaheadClassDef,
    depth,
    filter,
    track = null,
  ) {
    const v = this._view;
    let off = ruleOff;
    const backtrackGlyphCount = v.getUint16(off, false);
    off += 2;
    for (let i = 0; i < backtrackGlyphCount; i++) {
      const want = v.getUint16(off, false);
      off += 2;
      const pos = GsubReader._nthBacktrack(seq, start, i + 1, filter);
      if (pos < 0) return null;
      const have = seq[pos];
      if (glyphMatch) {
        if (have !== want) return null;
      } else {
        if (classOf(v, backtrackClassDef, have) !== want) return null;
      }
    }
    const inputGlyphCount = v.getUint16(off, false);
    off += 2;
    const inputPos = GsubReader._inputPositions(seq, start, inputGlyphCount, filter);
    if (!inputPos) return null;
    for (let i = 1; i < inputGlyphCount; i++) {
      const want = v.getUint16(off, false);
      off += 2;
      const have = seq[inputPos[i]];
      if (glyphMatch) {
        if (have !== want) return null;
      } else {
        if (classOf(v, inputClassDef, have) !== want) return null;
      }
    }
    const lookaheadGlyphCount = v.getUint16(off, false);
    off += 2;
    const lastInput = inputPos[inputPos.length - 1];
    for (let i = 0; i < lookaheadGlyphCount; i++) {
      const want = v.getUint16(off, false);
      off += 2;
      const pos = GsubReader._nthInput(seq, lastInput, i + 1, filter);
      if (pos < 0) return null;
      const have = seq[pos];
      if (glyphMatch) {
        if (have !== want) return null;
      } else {
        if (classOf(v, lookaheadClassDef, have) !== want) return null;
      }
    }
    const lookupCount = v.getUint16(off, false);
    off += 2;
    return this._applyNestedLookups(seq, inputPos, off, lookupCount, depth, track);
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
    const backtrackGlyphCount = v.getUint16(off, false);
    off += 2;
    for (let i = 0; i < backtrackGlyphCount; i++) {
      const covRel = v.getUint16(off, false);
      off += 2;
      const pos = GsubReader._nthBacktrack(seq, start, i + 1, filter);
      if (pos < 0) return null;
      if (coverageIndex(v, subOff + covRel, seq[pos]) < 0) return null;
    }
    const lookaheadGlyphCount = v.getUint16(off, false);
    off += 2;
    for (let i = 0; i < lookaheadGlyphCount; i++) {
      const covRel = v.getUint16(off, false);
      off += 2;
      const pos = GsubReader._nthInput(seq, start, i + 1, filter);
      if (pos < 0) return null;
      if (coverageIndex(v, subOff + covRel, seq[pos]) < 0) return null;
    }
    const glyphCount = v.getUint16(off, false);
    off += 2;
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
  applyFeatureToSeq(featureTag, seq, includeRequired = true) {
    const lookups = this._lookupsByTag(featureTag, includeRequired);
    if (!lookups || lookups.length === 0) return seq;
    let cur = seq;
    for (const lookupOff of lookups) {
      cur = this._applyLookupToSeq(lookupOff, cur);
    }
    return cur;
  }

  /// Apply a feature and return each output glyph's original input index in src.
  /// An optional input-indexed mask permits substitutions only on marked inputs.
  /// Nested multiple and ligature substitutions update src as they edit the glyphs;
  /// unchanged glyphs and skipped marks retain their own source indices.
  applyFeatureToSeqTracked(featureTag, seq, mask = null, includeRequired = true) {
    const track = { src: Array.from({ length: seq.length }, (_, k) => k) };
    const lookups = this._lookupsByTag(featureTag, includeRequired);
    if (!lookups || lookups.length === 0) return { seq, src: track.src };
    let cur = seq;
    for (const lookupOff of lookups) cur = this._applyLookupToSeq(lookupOff, cur, track, mask);
    return { seq: cur, src: track.src };
  }

  // ====================================================================
  // would-substitute probe — ask the font a structural question without
  // substituting anything.

  // `zeroContext` follows HarfBuzz: a context or chaining-context lookup
  // only counts when it needs no backtrack and no lookahead, because a
  // probe is a bare glyph sequence with no surrounding text to offer.
  // ====================================================================

  /**
   * Would `featureTag`'s lookups fire on exactly `glyphs`, starting at
   * position 0 and consuming the whole sequence? Substitutes nothing and
   * returns only true/false. Resolves under the currently selected script
   * and language system, so call setShapingScript first.
   *
   * @param {string} featureTag
   * @param {number[]|Uint16Array} glyphs
   * @param {boolean} [zeroContext] require context lookups to need no
   *   backtrack and no lookahead (default true, matching HarfBuzz)
   */
  wouldSubstitute(featureTag, glyphs, zeroContext = true) {
    const lookups = this._lookupsByTag(featureTag);
    if (!lookups || lookups.length === 0) return false;
    if (!glyphs || glyphs.length === 0) return false;
    for (const lookupOff of lookups) {
      const hit = this._eachSubtable(lookupOff, (effType, subOff) =>
        this._wouldSubtable(effType, subOff, glyphs, zeroContext) ? true : null,
      );
      if (hit) return true;
    }
    return false;
  }

  /// One subtable's answer for wouldSubstitute.
  _wouldSubtable(effType, subOff, glyphs, zeroContext) {
    const v = this._view;
    const fmt = v.getUint16(subOff, false);
    // Types 1, 2 and 3 each replace ONE covered glyph and have no context
    // of their own, so coverage is the whole question. Type 1 has two
    // formats; the other two have one.
    if (effType === 1 || effType === 2 || effType === 3) {
      if (glyphs.length !== 1) return false;
      if (effType !== 1 && fmt !== 1) return false;
      if (effType === 1 && fmt !== 1 && fmt !== 2) return false;
      return coverageIndex(v, subOff + v.getUint16(subOff + 2, false), glyphs[0]) >= 0;
    }
    if (effType === 8) return this._wouldReverse8(subOff, glyphs, zeroContext);
    if (effType === 4) return this._wouldLiga4(subOff, glyphs);
    if (effType === 5) return this._wouldContext5(subOff, glyphs, zeroContext);
    if (effType === 6) return this._wouldChain6(subOff, glyphs, zeroContext);
    return false;
  }

  /// Type 8: a reverse chain replaces one covered glyph, but it is a chain,
  /// so under zeroContext it needs its backtrack and lookahead to be empty
  /// like any other — the same rule types 5 and 6 get, rather than a
  /// coverage-only answer that would quietly claim a form the font only
  /// produces next to particular neighbors.
  _wouldReverse8(subOff, glyphs, zeroContext) {
    const v = this._view;
    if (v.getUint16(subOff, false) !== 1) return false;
    if (glyphs.length !== 1) return false;
    if (coverageIndex(v, subOff + v.getUint16(subOff + 2, false), glyphs[0]) < 0) return false;
    if (!zeroContext) return true;
    let off = subOff + 4;
    const backtrackCount = v.getUint16(off, false);
    off += 2 + backtrackCount * 2;
    const lookaheadCount = v.getUint16(off, false);
    return backtrackCount === 0 && lookaheadCount === 0;
  }

  /// Type 4: the probe sequence has to BE the ligature's components, all
  /// of them — a probe carries no further glyphs to spend on a longer one.
  _wouldLiga4(subOff, glyphs) {
    const v = this._view;
    if (v.getUint16(subOff, false) !== 1) return false;
    const covIdx = coverageIndex(v, subOff + v.getUint16(subOff + 2, false), glyphs[0]);
    if (covIdx < 0) return false;
    const ligSetCount = v.getUint16(subOff + 4, false);
    if (covIdx >= ligSetCount) return false;
    const ligSetOff = subOff + v.getUint16(subOff + 6 + covIdx * 2, false);
    const ligCount = v.getUint16(ligSetOff, false);
    for (let i = 0; i < ligCount; i++) {
      const ligOff = ligSetOff + v.getUint16(ligSetOff + 2 + i * 2, false);
      if (v.getUint16(ligOff + 2, false) !== glyphs.length) continue;
      let ok = true;
      for (let k = 1; k < glyphs.length; k++) {
        if (v.getUint16(ligOff + 4 + (k - 1) * 2, false) !== glyphs[k]) {
          ok = false;
          break;
        }
      }
      if (ok) return true;
    }
    return false;
  }

  /// Does a rule's input sequence, laid out as (glyphCount, lookupCount,
  /// then glyphCount-1 values), cover the whole probe? `valueAt` maps a
  /// probe position to the value the rule stores there — the glyph id for
  /// a glyph-matched rule, the class for a class-matched one.
  _wouldRuleInput(ruleOff, glyphs, valueAt) {
    const v = this._view;
    if (v.getUint16(ruleOff, false) !== glyphs.length) return false;
    for (let i = 1; i < glyphs.length; i++) {
      if (v.getUint16(ruleOff + 4 + (i - 1) * 2, false) !== valueAt(i)) return false;
    }
    return true;
  }

  /// Type 5, all three formats.
  _wouldContext5(subOff, glyphs, zeroContext) {
    const v = this._view;
    const fmt = v.getUint16(subOff, false);
    if (fmt === 1 || fmt === 2) {
      const covIdx = coverageIndex(v, subOff + v.getUint16(subOff + 2, false), glyphs[0]);
      if (covIdx < 0) return false;
      let setOff, valueAt;
      if (fmt === 1) {
        const setCount = v.getUint16(subOff + 4, false);
        if (covIdx >= setCount) return false;
        setOff = subOff + v.getUint16(subOff + 6 + covIdx * 2, false);
        valueAt = (i) => glyphs[i];
      } else {
        const classDefAbs = subOff + v.getUint16(subOff + 4, false);
        const setCount = v.getUint16(subOff + 6, false);
        const startClass = classOf(v, classDefAbs, glyphs[0]);
        if (startClass >= setCount) return false;
        const rel = v.getUint16(subOff + 8 + startClass * 2, false);
        if (rel === 0) return false;
        setOff = subOff + rel;
        valueAt = (i) => classOf(v, classDefAbs, glyphs[i]);
      }
      const ruleCount = v.getUint16(setOff, false);
      for (let r = 0; r < ruleCount; r++) {
        const ruleOff = setOff + v.getUint16(setOff + 2 + r * 2, false);
        if (this._wouldRuleInput(ruleOff, glyphs, valueAt)) return true;
      }
      return false;
    }
    if (fmt === 3) {
      if (v.getUint16(subOff + 2, false) !== glyphs.length) return false;
      for (let i = 0; i < glyphs.length; i++) {
        const covAbs = subOff + v.getUint16(subOff + 6 + i * 2, false);
        if (coverageIndex(v, covAbs, glyphs[i]) < 0) return false;
      }
      return true;
    }
    return false;
  }

  /// Type 6, all three formats. Under zeroContext a rule that wants any
  /// backtrack or lookahead cannot answer a bare probe, so it does not
  /// count — the probe has no neighbors to show it.
  _wouldChain6(subOff, glyphs, zeroContext) {
    const v = this._view;
    const fmt = v.getUint16(subOff, false);
    if (fmt === 1 || fmt === 2) {
      const covIdx = coverageIndex(v, subOff + v.getUint16(subOff + 2, false), glyphs[0]);
      if (covIdx < 0) return false;
      let setOff, valueAt;
      if (fmt === 1) {
        const setCount = v.getUint16(subOff + 4, false);
        if (covIdx >= setCount) return false;
        setOff = subOff + v.getUint16(subOff + 6 + covIdx * 2, false);
        valueAt = (i) => glyphs[i];
      } else {
        const inputClassDef = subOff + v.getUint16(subOff + 6, false);
        const setCount = v.getUint16(subOff + 10, false);
        const inputClass = classOf(v, inputClassDef, glyphs[0]);
        if (inputClass >= setCount) return false;
        const rel = v.getUint16(subOff + 12 + inputClass * 2, false);
        if (rel === 0) return false;
        setOff = subOff + rel;
        valueAt = (i) => classOf(v, inputClassDef, glyphs[i]);
      }
      const ruleCount = v.getUint16(setOff, false);
      for (let r = 0; r < ruleCount; r++) {
        let off = setOff + v.getUint16(setOff + 2 + r * 2, false);
        const backtrackCount = v.getUint16(off, false);
        off += 2 + backtrackCount * 2;
        const inputCount = v.getUint16(off, false);
        off += 2;
        const inputBase = off;
        off += (inputCount - 1) * 2;
        const lookaheadCount = v.getUint16(off, false);
        if (zeroContext && (backtrackCount !== 0 || lookaheadCount !== 0)) continue;
        if (inputCount !== glyphs.length) continue;
        let ok = true;
        for (let i = 1; i < inputCount; i++) {
          if (v.getUint16(inputBase + (i - 1) * 2, false) !== valueAt(i)) {
            ok = false;
            break;
          }
        }
        if (ok) return true;
      }
      return false;
    }
    if (fmt === 3) {
      let off = subOff + 2;
      const backtrackCount = v.getUint16(off, false);
      off += 2 + backtrackCount * 2;
      const inputCount = v.getUint16(off, false);
      off += 2;
      const inputBase = off;
      off += inputCount * 2;
      const lookaheadCount = v.getUint16(off, false);
      if (zeroContext && (backtrackCount !== 0 || lookaheadCount !== 0)) return false;
      if (inputCount !== glyphs.length) return false;
      for (let i = 0; i < inputCount; i++) {
        const covAbs = subOff + v.getUint16(inputBase + i * 2, false);
        if (coverageIndex(v, covAbs, glyphs[i]) < 0) return false;
      }
      return true;
    }
    return false;
  }
  // A scalar multiple-substitution lookup visits each input once; emitted glyphs
  // are not revisited by that lookup. Rebuild glyph and ownership arrays once.
  _applyMultipleLookupLinear(lookupOff, seq, filter, track) {
    const subtables = [];
    let onlyMultiple = true;
    this._eachSubtable(lookupOff, (type, offset) => {
      if (type === 2) subtables.push(offset);
      else onlyMultiple = false;
      return null;
    });
    if (!onlyMultiple || !subtables.length) return null;
    let result = null,
      sources = null,
      components = null,
      marks = null;
    for (let i = 0; i < seq.length; i++) {
      let replacements = null;
      if (!filter.skip(seq[i]) && (!filter.maskAt || filter.maskAt(i))) {
        for (const offset of subtables) {
          replacements = this._tryMultipleSub2(offset, seq[i]);
          if (replacements !== null) break;
        }
        if (
          replacements !== null &&
          (result ? result.length : i) + replacements.length + seq.length - i - 1 >
            MAX_SHAPED_GLYPHS
        )
          replacements = null;
      }
      if (replacements !== null && result === null) {
        result = Array.from(seq.slice(0, i));
        if (track) sources = track.src.slice(0, i);
        if (track?.components) {
          components = track.components.slice(0, i);
          marks = track.markComponents.slice(0, i);
        }
      }
      if (result !== null) {
        const count = replacements === null ? 1 : replacements.length;
        for (let k = 0; k < count; k++) {
          result.push(replacements === null ? seq[i] : replacements[k]);
          if (sources) sources.push(track.src[i]);
          if (components) {
            components.push(replacements === null ? track.components[i] : 1);
            marks.push(track.markComponents[i]);
          }
        }
      }
    }
    if (sources) track.src = sources;
    if (components) {
      track.components = components;
      track.markComponents = marks;
    }
    return result === null ? seq : result;
  }

  _applyLookupToSeq(lookupOff, seq, track = null, mask = null) {
    const v = this._view;
    let type = v.getUint16(lookupOff, false);
    const subCount = v.getUint16(lookupOff + 4, false);
    // Build the lookup's GDEF-aware skip predicate once. Used by
    // context/chain/reverse-chain matchers below; non-context types
    // ignore the filter (their match window is the current slot only).
    const filter = this._filterForLookup(lookupOff);
    this._nestedBudget = Math.max(NESTED_LOOKUP_BUDGET, seq.length * NESTED_LOOKUPS_PER_GLYPH);
    // The feature mask is addressed in the ORIGINAL sequence's
    // coordinates, so it is read through the source map rather than
    // renumbered on every substitution — `track.src` is already kept in
    // step with the sequence and is the one place that stays right when
    // a ligature or a multiple substitution changes the length.
    if (mask && track) filter.maskAt = (pos) => !!mask[track.src[pos]];
    if (type === 2 || type === 7) {
      const multiple = this._applyMultipleLookupLinear(lookupOff, seq, filter, track);
      if (multiple !== null) return multiple;
    }
    let cur = seq;
    let i = 0;
    const anchors = this._lookupAnchors(lookupOff);
    while (i < cur.length) {
      let advance = 1;
      if (anchors !== null) {
        const anchor = cur[i];
        if (anchor >= anchors.length || anchors[anchor] !== 1) {
          i++;
          continue;
        }
      }
      // Per OTL, a lookup does not apply AT a position its lookupFlag
      // skips (IgnoreMarks etc.) — skipped glyphs may only be jumped
      // over inside context/ligature matches, never start one.
      if (filter && filter.skip(cur[i])) {
        i++;
        continue;
      }
      // Nor at a position the feature's mask withholds.
      if (filter.maskAt && !filter.maskAt(i)) {
        i++;
        continue;
      }
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
          const out = this._matchSingleSub1(subOff, gid);
          if (out != null) {
            if (cur === seq) cur = cur.slice();
            cur[i] = out;
            advance = 1;
            break;
          }
        } else if (effType === 2) {
          const out = this._tryMultipleSub2(subOff, gid);
          if (out && cur.length + out.length <= MAX_SHAPED_GLYPHS) {
            if (track)
              track.src = track.src
                .slice(0, i)
                .concat(new Array(out.length).fill(track.src[i]), track.src.slice(i + 1));
            GsubReader._trackMultiple(track, i, out.length);
            cur = cur.slice(0, i).concat(out, cur.slice(i + 1));
            advance = out.length;
            break;
          }
        } else if (effType === 3) {
          const out = this._matchAlternate3(subOff, gid, 0);
          if (out != null) {
            if (cur === seq) cur = cur.slice();
            cur[i] = out;
            advance = 1;
            break;
          }
        } else if (effType === 4) {
          const hit = this._tryLiga4(subOff, cur, i, gid, filter);
          if (hit) {
            GsubReader._trackLigature(track, i, hit);
            if (track) track.src = GsubReader._spliceLigature(track.src, i, hit, true);
            cur = GsubReader._spliceLigature(cur, i, hit);
            advance = 1;
            break;
          }
        } else if (effType === 5) {
          const hit = this._tryContext5(subOff, cur, i, 0, filter, track);
          if (hit) {
            cur = hit.newSeq;
            advance = hit.advance;
            break;
          }
        } else if (effType === 6) {
          const hit = this._tryChainContext6(subOff, cur, i, 0, filter, track);
          if (hit) {
            cur = hit.newSeq;
            advance = hit.advance;
            break;
          }
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
        if (filter.skip(cur[j]) || (filter.maskAt && !filter.maskAt(j))) continue;
        for (const subOff of revSubs) {
          const out = this._tryReverseChainSingle8(subOff, cur, j, filter);
          if (out !== null && out !== cur[j]) {
            cur[j] = out;
            break;
          }
        }
      }
    }
    return cur;
  }

  // ====================================================================
  // Lookups are cached by feature within the selected script and language system.
  _requiredTag() {
    if (!this._cur.has(null))
      this._cur.set(
        null,
        requiredFeatureTag(this._view, this._gsubTableOff, this._selTags, this._selLang),
      );
    return this._cur.get(null);
  }

  get requiredFeature() {
    return this._requiredTag();
  }

  get hasRequiredFeature() {
    const tag = this._requiredTag();
    return !!tag && tag !== 'rvrn';
  }

  applyRequiredFeatureToSeqTracked(seq) {
    const tag = this._requiredTag();
    return this.applyMappedFeatureToSeqTracked(tag === 'rvrn' ? null : tag, seq, true);
  }

  applyMappedFeatureToSeqTracked(tag, seq, includeRequired = false, ownership = null, mask = null) {
    const track = {
      src: Array.from({ length: seq.length }, (_, i) => i),
      components: ownership?.components?.slice() || new Array(seq.length).fill(1),
      markComponents: ownership?.markComponents?.slice() || new Array(seq.length).fill(-1),
      mergedSourceRanges: [],
    };
    let cur = seq;
    if (tag)
      for (const lookup of this._lookupsByTag(tag, includeRequired) || [])
        cur = this._applyLookupToSeq(lookup, cur, track, mask);
    return {
      seq: cur,
      src: track.src,
      components: track.components,
      markComponents: track.markComponents,
      mergedSourceRanges: track.mergedSourceRanges,
    };
  }

  /// The lookups a justification priority enables that no feature of the selected language system already reaches, in
  /// lookup-list order.
  _jstfEnabledLookups() {
    if (!this._jstf?.enable?.length || this._gsubTableOff == null) return null;
    const listed = new Set(
      findFeatureLookups(
        this._view,
        this._gsubTableOff,
        ANY_FEATURE,
        this._selTags,
        this._selLang,
        this._featureSubstitutions,
        true,
      ) || [],
    );
    const out = [];
    for (const index of [...new Set(this._jstf.enable)].sort((a, b) => a - b)) {
      const off = this._lookupOffsetOf(index);
      if (off != null && !listed.has(off)) out.push(off);
    }
    return out.length ? out : null;
  }

  _lookupsByTag(tag, includeRequired = false) {
    // An array of tags is one stage: its lookups merge in lookup-list order, and the required feature stays in its own stage.
    if (Array.isArray(tag) && !includeRequired) tag = tag.filter((t) => t !== this._requiredTag());
    const multi = Array.isArray(tag);
    if (multi && tag.length === 0) return null;
    const key = multi ? tag.join('+') : tag;
    if (!multi && !includeRequired && tag === this._requiredTag()) return null;
    let l = this._cur.get(key);
    if (l === undefined) {
      if (tag === 'jstf') l = this._jstfEnabledLookups();
      else {
        l =
          this._gsubTableOff == null
            ? null
            : findFeatureLookups(
                this._view,
                this._gsubTableOff,
                multi ? tag.map(featureTagU32) : featureTagU32(tag),
                this._selTags,
                this._selLang,
                this._featureSubstitutions,
              );
        if (l && this._jstf?.disable?.size)
          l = l.filter((off) => !this._jstf.disable.has(this._lookupIndexOf(off)));
        if (l && l.length === 0) l = null;
      }
      this._cur.set(key, l);
    }
    return l;
  }

  /// The default-on feature stages a run needs beyond the ligature pass, or null when the ligature pass is all the font has.
  /// HarfBuzz applies the features of one stage as a single pass over the lookup list: `rlig`, `calt`, `clig`, `liga` and `rclt`
  /// in one stage for most scripts; Arabic-style joining scripts split it in three (`rlig`, then `calt`, then the rest) and the
  /// Indic shaper has already run `calt` and `clig` with its presentation forms. The ligature pass only reads type-4 lookups, so
  /// a font with a contextual lookup (or `calt`/`clig`/`rclt`) under those tags needs the full stage.
  /// `optional` false leaves out the optional ones (`liga`, `clig`, `calt`): CSS Text 3 7.2 breaks them under letter-spacing.
  /// `off` is a Set of tags the caller disabled.
  defaultStages(optional, off = null) {
    const all = ['rlig', 'liga', 'clig', 'calt', 'rclt'];
    const present = all.filter((t) => this.hasFeature(t));
    const jstf = this._jstf?.enable?.length > 0 && this.hasFeature('jstf');
    if (!present.length && !jstf) return null;
    const need =
      jstf ||
      present.some((t) => t === 'clig' || t === 'calt' || t === 'rclt') ||
      (present.length > 0 && this._hasNonLigatureLookup(present));
    if (!need) return null;
    const keep = present.filter(
      (t) => (optional || (t !== 'liga' && t !== 'clig' && t !== 'calt')) && !(off && off.has(t)),
    );
    const kind = this._scriptKind();
    const groups =
      kind === 'arabic'
        ? [['rlig'], ['calt'], ['liga', 'clig', 'rclt']]
        : kind === 'indic'
          ? [['rlig', 'liga', 'rclt']]
          : [['rlig', 'calt', 'clig', 'liga', 'rclt']];
    const stages = groups.map((g) => g.filter((t) => keep.includes(t)));
    stages.push(jstf ? ['jstf'] : []); // lookups only a justification priority enables
    return stages.some((g) => g.length) ? stages : null;
  }

  /// True when the run's script resolved to a new-style Indic tag ('dev2', 'tel2', ...: OpenType Indic v2). Fonts that only carry
  /// the old tag ('deva') are shaped with the old-spec model, whose reordering differs.
  get usesNewIndicScript() {
    const t = selectedScriptTag(this._view, this._gsubTableOff, this._selTags);
    return t !== 0 && ((t & 255) === 0x32 || (t & 255) === 0x33 || t === 0x73696e68);
  }

  /// 'arabic' (joining scripts), 'indic', or 'other' for the selected script.
  _scriptKind() {
    for (const t of this._selTags || []) {
      const name = String.fromCharCode(t >>> 24, (t >>> 16) & 255, (t >>> 8) & 255, t & 255);
      if (ARABIC_JOINING_TAGS.has(name)) return 'arabic';
      if (INDIC_TAGS.has(name)) return 'indic';
    }
    return 'other';
  }

  _hasNonLigatureLookup(tags) {
    const key = 'nl:' + tags.join('+');
    let r = this._cur.get(key);
    if (r === undefined) {
      r = false;
      const v = this._view;
      for (const lookup of this._lookupsByTag(tags, true) || []) {
        let type = v.getUint16(lookup, false);
        if (type === 7 && v.getUint16(lookup + 4, false) > 0)
          type = v.getUint16(lookup + v.getUint16(lookup + 6, false) + 2, false);
        if (type !== 4) {
          r = true;
          break;
        }
      }
      this._cur.set(key, r);
    }
    return r;
  }

  /// Returns true iff `featureTag` has at least one lookup in the font.
  /// Useful for textRun to gate feature application without redundant
  /// findFeatureLookups scans on every call.
  hasFeature(featureTag) {
    const l = this._lookupsByTag(featureTag, true);
    return !!(l && l.length > 0);
  }

  /// Apply alternate substitution explicitly under `featureTag` (e.g.
  /// 'salt', 'aalt') with caller-chosen alternate index. Returns the
  /// new gid, or `gid` unchanged when no alternate applies.
  substituteAlternate(gid, featureTag, altIdx = 0) {
    for (const lookup of this._lookupsByTag(featureTag) || []) {
      if (this._filterForLookup(lookup).skip(gid)) continue;
      const hit = this._eachSubtable(lookup, (type, offset) => {
        const out =
          type === 3
            ? this._matchAlternate3(offset, gid, altIdx)
            : type === 1
              ? this._matchSingleSub1(offset, gid)
              : null;
        return out == null ? null : { gid: out };
      });
      if (hit) gid = hit.gid;
    }
    return gid;
  }
}
