// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// gposReader.js — GPOS pair-adjustment kerning.

import {
  coverageIndex,
  classOf,
  valueRecordSize,
  valueRecordXAdvance,
  valueRecordXAdvDeviceOffset,
  findFeatureLookups,
  findFeatureSubstitutions,
  featureTagU32,
  ANY_FEATURE,
} from './otCommon.js';
import {
  makeLookupFilter,
  readLookupFlags,
  nextNonSkippedForward,
  nextNonSkippedBackward,
} from './lookupFlag.js';

const LISTED_KERN = Symbol('listed kern');
// 'dist' fine-tunes glyph distances the way 'kern' does (the Indic and USE shapers ask for it, and the registry has it on by default);
// it is not the user's to turn off with kerning.
const KERN_TAGS = ['kern', 'dist'];
const KERN_ALL = Symbol('kern and dist'),
  KERN_REQ = Symbol('required and dist');

/// Mark-to-base and mark-to-ligature lookups sit under `mark`, and the Indic shapers also put them under `abvm` and `blwm`.
const MARK_TAGS = ['mark', 'abvm', 'blwm'];

export class GposReader {
  /** @param {object} tables result of parseTtfTables */
  constructor(tables) {
    this._view = tables.view;
    this._gposTableOff = tables.gpos ? tables.gpos[0] : null;
    this._upemV = tables.unitsPerEm > 0 ? tables.unitsPerEm : 1000;
    this._devPpem = 0;
    this._lookupListOff =
      this._gposTableOff == null
        ? null
        : this._gposTableOff + this._view.getUint16(this._gposTableOff + 8, false);
    // Which lookups a feature reaches depends on the run's script and
    // language system, so they resolve on demand and cache per selection
    // (see setShapingScript). The features this reader positions with:
    //   'kern' = pair adjustment (type 2) + SinglePos advance deltas
    //   'curs' = cursive attachment — Arabic baseline joining (type 3)
    //   'mark' = mark-to-base (type 4) and mark-to-ligature (type 5);
    //            both sit under this one tag
    //   'mkmk' = mark-to-mark, stacking shadda+fatha (type 6)
    this._byLangSys = new Map();
    this._selTags = null;
    this._selLang = 0;
    this._cur = this._langSysCache(null, 0);
    this.hasFeatureVariations =
      this._gposTableOff != null &&
      tables.gpos[1] >= 14 &&
      this._view.getUint16(this._gposTableOff + 2, false) >= 1 &&
      this._view.getUint32(this._gposTableOff + 10, false) !== 0;
    if (this.hasFeatureVariations) {
      const count = tables.fvar ? this._view.getUint16(tables.fvar[0] + 8, false) : 0;
      this.setVariationCoords(new Array(count).fill(0));
    }
    // GDEF reader injected lazily by fontAsset so lookupFlag-driven
    // glyph-class skipping in contextual pos can fire.
    this._gdef = null;
  }

  setGdef(gdef) {
    this._gdef = gdef;
    this._devStore = undefined;
  }

  /// True when value records can carry VariationIndex deltas for this font: GDEF 1.3 supplies the ItemVariationStore
  /// they index. The layout feeds the active normalized coordinates (setVariationCoords) only to readers that say so.
  get hasDeviceVariations() {
    return this._deviceStore() !== null;
  }

  _deviceStore() {
    if (this._devStore === undefined)
      this._devStore = (this._gdef && this._gdef.itemVarStore) || null;
    return this._devStore;
  }

  /// Pixel size the ppem-keyed Device tables (formats 1-3) are resolved at. 0 (the default: text here is scalable and has
  /// no pixel size) makes them contribute nothing, which is what HarfBuzz does for a font with no ppem set
  /// (hb_font_set_ppem is never called): HintingDevice::get_delta returns 0 when ppem is 0.
  setDevicePpem(ppem) {
    this._devPpem = ppem > 0 ? ppem : 0;
  }

  /// Delta (font units) of the Device table at `base + rel`: a VariationIndex (deltaFormat 0x8000) resolved at the
  /// active coordinates, or a ppem-keyed Device table (formats 1-3: startSize, endSize, packed signed deltas in pixels)
  /// resolved at the set ppem and scaled to font units (pixels * unitsPerEm / ppem, HarfBuzz's HintingDevice). 0 for no
  /// table, no coordinates/store (variation form), or no ppem (size form).
  _deviceDelta(base, rel) {
    if (!rel) return 0;
    const v = this._view,
      d = base + rel;
    if (d + 6 > v.byteLength) return 0;
    const fmt = v.getUint16(d + 4, false);
    if (fmt === 0x8000) {
      if (!this._devCoords) return 0;
      const store = this._deviceStore();
      if (!store) return 0;
      return store.getDelta(v.getUint16(d, false), v.getUint16(d + 2, false), this._devCoords);
    }
    if (fmt < 1 || fmt > 3 || !this._devPpem) return 0;
    const ppem = this._devPpem,
      start = v.getUint16(d, false),
      end = v.getUint16(d + 2, false);
    if (ppem < start || ppem > end) return 0;
    const sIdx = ppem - start;
    const word = d + 6 + (sIdx >> (4 - fmt)) * 2;
    if (word + 2 > v.byteLength) return 0;
    const bits = v.getUint16(word, false) >> (16 - (((sIdx & ((1 << (4 - fmt)) - 1)) + 1) << fmt));
    const mask = 0xffff >> (16 - (1 << fmt));
    let px = bits & mask;
    if (px >= (mask + 1) >> 1) px -= mask + 1;
    return (px * this._upem()) / ppem;
  }

  _upem() {
    return this._upemV;
  }

  /// x advance of the ValueRecord at `recOff` (owned by the subtable at `subOff`), base value plus its
  /// VariationIndex delta at the active coordinates.
  _xAdvance(subOff, recOff, vf) {
    const adv = valueRecordXAdvance(this._view, recOff, vf);
    const total =
      vf & 0x0040
        ? adv + this._deviceDelta(subOff, valueRecordXAdvDeviceOffset(this._view, recOff, vf))
        : adv;
    return total * this._jstfScale(subOff);
  }

  /// A JstfMax lookup gives the most a glyph may move; the layout asks for a share of it (0..1). Every other lookup counts in full.
  _jstfScale(subOff) {
    const j = this._jstf;
    return j && j.maxLookups?.length && subOff >= j.range[0] && subOff < j.range[1]
      ? j.maxScale
      : 1;
  }

  /// All four adjustments of the ValueRecord at `recOff` (owned by the subtable at `subOff`, which anchors its Device
  /// offsets), each the base value plus its Device/VariationIndex delta, in font units, written to out[o .. o+3] as
  /// [xPlacement, yPlacement, xAdvance, yAdvance] (added, so callers can sum records). Record layout, in this order and
  /// only for the bits set: xPla 0x1, yPla 0x2, xAdv 0x4, yAdv 0x8, then the Device offsets xPla 0x10, yPla 0x20, xAdv 0x40,
  /// yAdv 0x80.
  _addValueRecord(subOff, recOff, vf, out, o) {
    const v = this._view;
    let p = recOff;
    let xPla = 0,
      yPla = 0,
      xAdv = 0,
      yAdv = 0;
    if (vf & 0x0001) {
      xPla = v.getInt16(p, false);
      p += 2;
    }
    if (vf & 0x0002) {
      yPla = v.getInt16(p, false);
      p += 2;
    }
    if (vf & 0x0004) {
      xAdv = v.getInt16(p, false);
      p += 2;
    }
    if (vf & 0x0008) {
      yAdv = v.getInt16(p, false);
      p += 2;
    }
    if (vf & 0x00f0) {
      if (vf & 0x0010) {
        xPla += this._deviceDelta(subOff, v.getUint16(p, false));
        p += 2;
      }
      if (vf & 0x0020) {
        yPla += this._deviceDelta(subOff, v.getUint16(p, false));
        p += 2;
      }
      if (vf & 0x0040) {
        xAdv += this._deviceDelta(subOff, v.getUint16(p, false));
        p += 2;
      }
      if (vf & 0x0080) {
        yAdv += this._deviceDelta(subOff, v.getUint16(p, false));
        p += 2;
      }
    }
    const k = this._jstfScale(subOff);
    out[o] += xPla * k;
    out[o + 1] += yPla * k;
    out[o + 2] += xAdv * k;
    out[o + 3] += yAdv * k;
  }

  /// True when a 'kern' (or required) PairPos/SinglePos value record carries anything beyond the x advance the layout has
  /// always applied: a placement, a y advance, their Device tables, or a second-glyph record. Fonts that say no skip the
  /// value-record path entirely (the common case: plain kerning), so text without these fields costs and lays out as before.
  hasPositionValues(requiredOnly = false) {
    const key = requiredOnly ? 'posValuesReq' : 'posValues';
    if (this._cur.has(key)) return this._cur.get(key);
    const lookups = this._kernLookups(requiredOnly);
    const v = this._view;
    let found = false;
    if (lookups) {
      outer: for (const lookupOff of lookups) {
        for (const subOff of this._effSubtables(lookupOff, 1)) {
          if (v.getUint16(subOff + 4, false) & ~0x0044) {
            found = true;
            break outer;
          }
        }
        for (const subOff of this._effSubtables(lookupOff, 2)) {
          if (v.getUint16(subOff + 4, false) & ~0x0044 || v.getUint16(subOff + 6, false)) {
            found = true;
            break outer;
          }
        }
      }
    }
    this._cur.set(key, found);
    return found;
  }

  /// Justification (JSTF) changes for the lines laid out next, or null: { id, disable: Set of LookupList indices to drop,
  /// enable: indices to add, maxLookups: absolute offsets of the JstfMax lookups, maxScale: the share of them (0..1) to apply,
  /// range: [lo, hi) of the JSTF table }. A disabled lookup leaves every feature; an enabled one joins the kerning, mark or
  /// cursive lookups its type belongs to; JstfMax lookups join kerning, scaled.
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

  _lookupTypeAt(off) {
    const v = this._view;
    let type = v.getUint16(off, false);
    if (type === 9 && v.getUint16(off + 4, false) > 0)
      type = v.getUint16(off + v.getUint16(off + 6, false) + 2, false);
    return type;
  }

  /// `l` (lookup offsets of feature `tag`) with the justification changes applied.
  _applyJustification(tag, l) {
    const j = this._jstf,
      v = this._view;
    const tags = Array.isArray(tag) ? tag : [tag];
    let out = l ? l.filter((off) => !j.disable?.has(this._lookupIndexOf(off))) : [];
    if (j.enable?.length && this._gposTableOff != null) {
      const types = tags.includes('kern')
        ? [1, 2]
        : tags.includes('mark')
          ? [4, 5]
          : tags.includes('mkmk')
            ? [6]
            : tags.includes('curs')
              ? [3]
              : [];
      if (types.length) {
        const listed = new Set(
          findFeatureLookups(
            v,
            this._gposTableOff,
            ANY_FEATURE,
            this._selTags,
            this._selLang,
            this._featureSubstitutions,
            true,
          ) || [],
        );
        const base = this._lookupListOff;
        for (const index of [...new Set(j.enable)]) {
          if (index >= v.getUint16(base, false)) continue;
          const off = base + v.getUint16(base + 2 + index * 2, false);
          if (!listed.has(off) && !out.includes(off) && types.includes(this._lookupTypeAt(off)))
            out.push(off);
        }
        out.sort((a, b) => this._lookupIndexOf(a) - this._lookupIndexOf(b));
      }
    }
    if (tags.includes('kern') && j.maxLookups?.length)
      for (const off of j.maxLookups) out.push(off);
    return out.length ? out : null;
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
    if (this._devSrc !== coords) {
      this._devSrc = coords;
      this._devCoords = Array.from(coords);
    }
    if (!this.hasFeatureVariations) return;
    const previous = this._variationCoords;
    if (
      previous &&
      previous.length === coords.length &&
      previous.every((value, index) => value === coords[index])
    )
      return;
    this._variationCoords = Array.from(coords);
    const selected = findFeatureSubstitutions(this._view, this._gposTableOff, coords);
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

  /// Build the GDEF-aware skip filter for a lookup at lookupOff.
  /// Returns a { skip(gid)→bool, rtl } record. No-op when GDEF absent.
  _filterForLookup(lookupOff) {
    const { lookupFlag, markFilteringSet } = readLookupFlags(this._view, lookupOff);
    return makeLookupFilter(lookupFlag, markFilteringSet, this._gdef);
  }

  /// Walk seq[start..]: return the n-th non-skipped position (n=0 → start).
  static _nthInput(seq, start, n, filter) {
    let pos = start,
      cnt = 0;
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
    let pos = start - 1,
      cnt = 0;
    while (pos >= 0) {
      if (!filter.skip(seq[pos])) {
        if (cnt === n) return pos;
        cnt++;
      }
      pos--;
    }
    return -1;
  }

  // Only the ordinary LangSys feature list can replace legacy kern.
  get hasListedKerning() {
    if (!this._cur.has(LISTED_KERN)) {
      this._cur.set(
        LISTED_KERN,
        this._gposTableOff == null
          ? null
          : findFeatureLookups(
              this._view,
              this._gposTableOff,
              featureTagU32('kern'),
              this._selTags,
              this._selLang,
              this._featureSubstitutions,
              false,
              true,
            ),
      );
    }
    return !!this._cur.get(LISTED_KERN)?.length;
  }

  get hasTable() {
    return this._gposTableOff != null;
  }

  get hasKerning() {
    return !!this._kernLookups(false)?.length;
  }
  get hasCursive() {
    return !!this._lookupsByTag('curs')?.length;
  }
  get hasMarkBase() {
    return !!this._lookupsByTag(MARK_TAGS)?.length;
  }
  get hasMarkMark() {
    return !!this._lookupsByTag('mkmk')?.length;
  }

  /**
   * Get the cursive entry and exit anchor positions for `gid` (font
   * units). Returns null when the gid has neither entry nor exit
   * anchor. When only one of the two is present, the corresponding
   * field is null. Only AnchorTable format 1 (plain x/y) is decoded;
   * formats 2/3 (with hint indices / device tables) return their
   * x/y but skip the hint/device adjustments.
   */
  getCursiveAnchors(gid) {
    const cursLookups = this._lookupsByTag('curs');
    if (!cursLookups) return null;
    const v = this._view;
    for (const lookupOff of cursLookups) {
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
        const entryOff = v.getUint16(recOff, false);
        const exitOff = v.getUint16(recOff + 2, false);
        const entry = entryOff !== 0 ? this._readAnchor(subOff + entryOff) : null;
        const exit = exitOff !== 0 ? this._readAnchor(subOff + exitOff) : null;
        if (entry || exit) return { entry, exit, rtl };
      }
    }
    return null;
  }

  /// AnchorTable at `off` (x, y in font units). Format 1 is plain; format 2 adds a contour point that HarfBuzz only uses
  /// when a ppem is set (so the plain x, y stand here); format 3 adds x/y Device tables whose VariationIndex deltas (and,
  /// with a ppem set, size deltas) are added to the coordinates.
  _readAnchor(off) {
    const v = this._view;
    const fmt = v.getUint16(off, false);

    if (fmt < 1 || fmt > 3) return null;
    let x = v.getInt16(off + 2, false);
    let y = v.getInt16(off + 4, false);
    if (fmt === 3) {
      x += this._deviceDelta(off, v.getUint16(off + 6, false));
      y += this._deviceDelta(off, v.getUint16(off + 8, false));
    }
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
    return this._scanMarkLookups(this._lookupsByTag(MARK_TAGS), baseGid, markGid, /*type*/ 4);
  }

  getMarkMarkAttachment(prevMarkGid, markGid) {
    return this._scanMarkLookups(this._lookupsByTag('mkmk'), prevMarkGid, markGid, /*type*/ 6);
  }

  /**
   * Mark-to-ligature (GPOS type 5). Lives under 'mark' alongside
   * type 4. The ligature glyph carries N component anchor sets, one
   * per ligature component; the mark binds to the component
   * specified by `componentIdx` (0-based).
   */
  getMarkLigAttachment(ligGid, markGid, componentIdx) {
    const markLookups = this._lookupsByTag(MARK_TAGS);
    if (!markLookups) return null;
    const v = this._view;
    for (const lookupOff of markLookups) {
      for (const subOff of this._effSubtables(lookupOff, 5)) {
        const fmt = v.getUint16(subOff, false);
        if (fmt !== 1) continue;
        const markCovAbs = subOff + v.getUint16(subOff + 2, false);
        const ligCovAbs = subOff + v.getUint16(subOff + 4, false);
        const markCovIdx = coverageIndex(v, markCovAbs, markGid);
        if (markCovIdx < 0) continue;
        const ligCovIdx = coverageIndex(v, ligCovAbs, ligGid);
        if (ligCovIdx < 0) continue;
        const markClassCount = v.getUint16(subOff + 6, false);
        const markArrayOff = subOff + v.getUint16(subOff + 8, false);
        const ligArrayOff = subOff + v.getUint16(subOff + 10, false);

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
        const markArrayOff = subOff + v.getUint16(subOff + 8, false);
        const baseArrayOff = subOff + v.getUint16(subOff + 10, false);

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
  getPairKerning(a, b, requiredOnly = false, adjacent = -1) {
    const kernLookups = this._kernLookups(requiredOnly);
    if (!kernLookups) return 0;
    let total = 0;
    for (const lookupOff of kernLookups) {
      if (adjacent >= 0 && !this._pairSeen(lookupOff, a, b, adjacent)) continue;
      // Within a lookup, subtables are ALTERNATIVES: the first one that
      // actually matches the pair ends the search (a matched value of 0
      // included) — summing every subtable double-kerns pairs present in
      // two subtables. Values still accumulate ACROSS lookups.
      for (const subOff of this._effSubtables(lookupOff, 2)) {
        const adj = this._readPairAdjustment(subOff, a, b);
        if (adj !== null) {
          total += adj;
          break;
        }
      }
    }
    return total;
  }

  /// Whether this lookup pairs `first` with `b`, where `adjacent` is the glyph right before b: a lookup's flags say which glyphs it does
  /// not see. One that ignores marks pairs b with the base behind a mark, one that does not pairs it with the mark, and neither sees
  /// a b it ignores. Only asked when a mark is involved, so other pairs pay nothing.
  _pairSeen(lookupOff, first, b, adjacent) {
    const filter = this._filterForLookup(lookupOff);
    if (filter.skip(b)) return false;
    return first === adjacent ? !filter.skip(adjacent) : filter.skip(adjacent);
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
      let lo = 0,
        hi = recCount - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const rOff = recBase + mid * recStride;
        const second = v.getUint16(rOff, false);
        if (second < b) lo = mid + 1;
        else if (second > b) hi = mid - 1;
        else return this._xAdvance(pairSetOff, rOff + 2, vf1); // Device offsets in a PairValueRecord count from its PairSet
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
      return this._xAdvance(subOff, cellOff, vf1);
    }
    return null;
  }

  /// Summed adjustments of every 'kern' PairPos lookup (first covering subtable per lookup, as getPairKerning) for the pair
  /// (a, b), in font units, as [aXPla, aYPla, aXAdv, aYAdv, bXPla, bYPla, bXAdv, bYAdv], or null when no subtable covers it.
  /// aXAdv is the value getPairKerning returns. Format 1 and 2, Device and VariationIndex deltas included. The ninth element is 1
  /// when a matching subtable declares a second value record (valueFormat2 non-zero): HarfBuzz then consumes the second glyph, so the
  /// lookup does not pair it with the glyph after it.
  getPairValues(a, b, requiredOnly = false, adjacent = -1) {
    const kernLookups = this._kernLookups(requiredOnly);
    if (!kernLookups) return null;
    let out = null;
    for (const lookupOff of kernLookups) {
      if (adjacent >= 0 && !this._pairSeen(lookupOff, a, b, adjacent)) continue;
      for (const subOff of this._effSubtables(lookupOff, 2)) {
        if (!this._matchPair(subOff, a, b)) continue;
        if (!out) out = new Float64Array(9);
        const m = this._pairMatch;
        this._addValueRecord(m[0], m[1], m[3], out, 0);
        if (m[4]) {
          this._addValueRecord(m[0], m[2], m[4], out, 4);
          out[8] = 1;
        }
        break;
      }
    }
    return out;
  }

  /// Locate the value records of (a, b) in one PairPos subtable: fills this._pairMatch = [owner, rec1, rec2, vf1, vf2]
  /// (owner = the table the Device offsets count from: the PairSet in format 1, the subtable in format 2) and returns
  /// whether the pair is covered.
  _matchPair(subOff, a, b) {
    const v = this._view;
    const format = v.getUint16(subOff, false);
    const aCovIdx = coverageIndex(v, subOff + v.getUint16(subOff + 2, false), a);
    if (aCovIdx < 0) return false;
    const vf1 = v.getUint16(subOff + 4, false),
      vf2 = v.getUint16(subOff + 6, false);
    const s1 = valueRecordSize(vf1),
      s2 = valueRecordSize(vf2);
    const m = this._pairMatch || (this._pairMatch = [0, 0, 0, 0, 0]);
    if (format === 1) {
      if (aCovIdx >= v.getUint16(subOff + 8, false)) return false;
      const pairSetOff = subOff + v.getUint16(subOff + 10 + aCovIdx * 2, false);
      const stride = 2 + s1 + s2;
      let lo = 0,
        hi = v.getUint16(pairSetOff, false) - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1,
          rOff = pairSetOff + 2 + mid * stride,
          second = v.getUint16(rOff, false);
        if (second < b) lo = mid + 1;
        else if (second > b) hi = mid - 1;
        else {
          m[0] = pairSetOff;
          m[1] = rOff + 2;
          m[2] = rOff + 2 + s1;
          m[3] = vf1;
          m[4] = vf2;
          return true;
        }
      }
      return false;
    }
    if (format === 2) {
      const aClass = classOf(v, subOff + v.getUint16(subOff + 8, false), a);
      const bClass = classOf(v, subOff + v.getUint16(subOff + 10, false), b);
      if (aClass >= v.getUint16(subOff + 12, false) || bClass >= v.getUint16(subOff + 14, false))
        return false;
      const cell =
        subOff + 16 + aClass * v.getUint16(subOff + 14, false) * (s1 + s2) + bClass * (s1 + s2);
      m[0] = subOff;
      m[1] = cell;
      m[2] = cell + s1;
      m[3] = vf1;
      m[4] = vf2;
      return true;
    }
    return false;
  }

  /// Summed SinglePos adjustments of the 'kern' lookups for gid, as [xPla, yPla, xAdv, yAdv] in font units, or null.
  getSingleValues(gid, requiredOnly = false) {
    const kernLookups = this._kernLookups(requiredOnly);
    if (!kernLookups) return null;
    const v = this._view;
    let out = null;
    for (const lookupOff of kernLookups) {
      for (const subOff of this._effSubtables(lookupOff, 1)) {
        const fmt = v.getUint16(subOff, false);
        const covIdx = coverageIndex(v, subOff + v.getUint16(subOff + 2, false), gid);
        if (covIdx < 0) continue;
        const vf = v.getUint16(subOff + 4, false);
        let rec;
        if (fmt === 1) rec = subOff + 6;
        else if (fmt === 2) {
          if (covIdx >= v.getUint16(subOff + 6, false)) continue;
          rec = subOff + 8 + covIdx * valueRecordSize(vf);
        } else continue;
        if (!out) out = new Float64Array(4);
        this._addValueRecord(subOff, rec, vf, out, 0);
        break;
      }
    }
    return out;
  }

  // ---- GPOS lookup 1 (SinglePos) -------------------------------

  /**
   * X-advance delta from any SinglePos lookup under the 'kern' feature.
   * Composes additively with pair kerning. Returns 0 when no SinglePos
   * lookup covers this glyph.
   */
  getSingleXAdvanceDelta(gid, requiredOnly = false) {
    const kernLookups = this._kernLookups(requiredOnly);
    if (!kernLookups) return 0;
    let total = 0;
    for (const lookupOff of kernLookups) {
      // First covering subtable wins within a lookup (see getPairKerning).
      for (const subOff of this._effSubtables(lookupOff, 1)) {
        const adj = this._readSinglePos(subOff, gid);
        if (adj !== null) {
          total += adj;
          break;
        }
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
      return this._xAdvance(subOff, subOff + 6, vf);
    } else if (fmt === 2) {
      const valueCount = v.getUint16(subOff + 6, false);
      if (covIdx >= valueCount) return null;
      const recOff = subOff + 8 + covIdx * vSize;
      return this._xAdvance(subOff, recOff, vf);
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
    const innerOff = subOff + v.getUint32(subOff + 4, false);
    return { innerType, innerOff };
  }

  /// Effective subtable offsets of `lookupOff` whose (Extension-deref'd)
  /// type is `wantType`. Large fonts wrap lookups in Extension (type 9)
  /// when the table outgrows 16-bit offsets — a scanner that gates on the
  /// OUTER lookup type silently no-ops on them (kerning, cursive and mark
  /// attachment all vanish).
  _effSubtables(lookupOff, wantType) {
    // Asked per glyph, and the font's bytes do not change: a lookup claiming 65535 subtables cost that much on every glyph.
    const cache = this._effCache || (this._effCache = new Map());
    const key = lookupOff * 16 + wantType;
    const hit = cache.get(key);
    if (hit) return hit;
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
    cache.set(key, out);
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
        const hit = this._matchContextRule(
          ruleOff,
          seq,
          start,
          /*glyphMatch*/ false,
          classDefAbs,
          filter,
        );
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
      return {
        inputLen: glyphCount,
        inputPos: pos,
        nested: this._readPosLookupRecords(recordsBase, lookupCount),
      };
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
    return {
      inputLen: glyphCount,
      inputPos: pos,
      nested: this._readPosLookupRecords(recordsBase, lookupCount),
    };
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
        const hit = this._matchChainRuleFmt12(
          ruleOff,
          seq,
          start,
          /*glyphMatch*/ true,
          null,
          null,
          null,
          filter,
        );
        if (hit) return hit;
      }
      return null;
    }
    if (fmt === 2) {
      const covAbs = subOff + v.getUint16(subOff + 2, false);
      if (coverageIndex(v, covAbs, seq[start]) < 0) return null;
      const backtrackCD = subOff + v.getUint16(subOff + 4, false);
      const inputCD = subOff + v.getUint16(subOff + 6, false);
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
        const hit = this._matchChainRuleFmt12(
          ruleOff,
          seq,
          start,
          false,
          backtrackCD,
          inputCD,
          lookaheadCD,
          filter,
        );
        if (hit) return hit;
      }
      return null;
    }
    if (fmt === 3) {
      let off = subOff + 2;
      const backtrackGlyphCount = v.getUint16(off, false);
      off += 2;
      const backCov = [];
      for (let i = 0; i < backtrackGlyphCount; i++) {
        backCov.push(subOff + v.getUint16(off, false));
        off += 2;
      }
      const inputGlyphCount = v.getUint16(off, false);
      off += 2;
      const inCov = [];
      for (let i = 0; i < inputGlyphCount; i++) {
        inCov.push(subOff + v.getUint16(off, false));
        off += 2;
      }
      const lookaheadGlyphCount = v.getUint16(off, false);
      off += 2;
      const lookCov = [];
      for (let i = 0; i < lookaheadGlyphCount; i++) {
        lookCov.push(subOff + v.getUint16(off, false));
        off += 2;
      }
      const lookupCount = v.getUint16(off, false);
      off += 2;
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
      return {
        inputLen: inputGlyphCount,
        inputPos: inPos,
        nested: this._readPosLookupRecords(off, lookupCount),
      };
    }
    return null;
  }

  _matchChainRuleFmt12(
    ruleOff,
    seq,
    start,
    glyphMatch,
    backtrackCD,
    inputCD,
    lookaheadCD,
    filter = null,
  ) {
    const v = this._view;
    let off = ruleOff;
    const backtrackCount = v.getUint16(off, false);
    off += 2;
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
      const want = v.getUint16(off, false);
      off += 2;
      const have = seq[backPos[i]];
      if (glyphMatch) {
        if (have !== want) return null;
      } else {
        if (classOf(v, backtrackCD, have) !== want) return null;
      }
    }
    const inputCount = v.getUint16(off, false);
    off += 2;
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
      const want = v.getUint16(off, false);
      off += 2;
      const have = seq[inPos[i]];
      if (glyphMatch) {
        if (have !== want) return null;
      } else {
        if (classOf(v, inputCD, have) !== want) return null;
      }
    }
    const lookaheadCount = v.getUint16(off, false);
    off += 2;
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
      const want = v.getUint16(off, false);
      off += 2;
      const have = seq[lookPos[i]];
      if (glyphMatch) {
        if (have !== want) return null;
      } else {
        if (classOf(v, lookaheadCD, have) !== want) return null;
      }
    }
    const lookupCount = v.getUint16(off, false);
    off += 2;
    return {
      inputLen: inputCount,
      inputPos: inPos,
      nested: this._readPosLookupRecords(off, lookupCount),
    };
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
  /// The lookups `tag` reaches under the current script and language
  /// selection, or null. Cached per selection.
  _requiredLookups() {
    if (!this._cur.has(null))
      this._cur.set(
        null,
        this._gposTableOff == null
          ? null
          : findFeatureLookups(
              this._view,
              this._gposTableOff,
              null,
              this._selTags,
              this._selLang,
              this._featureSubstitutions,
              true,
            ),
      );
    return this._cur.get(null);
  }

  get hasRequiredFeature() {
    return !!this._requiredLookups()?.length;
  }

  /// True when something of this family runs with kerning turned off: the required feature or 'dist'.
  get hasAlwaysOnPositioning() {
    return !!this._kernLookups(true)?.length;
  }

  /// The lookups kerning runs: 'kern' and 'dist', or with kerning turned off the required feature's and 'dist'.
  _kernLookups(requiredOnly) {
    const key = requiredOnly ? KERN_REQ : KERN_ALL;
    let l = this._cur.get(key);
    if (l !== undefined) return l;
    if (requiredOnly) {
      const dist = this._lookupsByTag('dist'),
        required = this._requiredLookups();
      l =
        dist && required
          ? [...new Set([...required, ...dist])].sort(
              (a, b) => this._lookupIndexOf(a) - this._lookupIndexOf(b),
            )
          : dist || required;
    } else l = this._lookupsByTag(KERN_TAGS);
    this._cur.set(key, l);
    return l;
  }

  _lookupsByTag(tag) {
    // An array of tags is one HarfBuzz stage: the lookups of all of them, in lookup-list order.
    const multi = Array.isArray(tag),
      key = multi ? tag.join('+') : tag;
    let l = this._cur.get(key);
    if (l === undefined) {
      l =
        this._gposTableOff == null
          ? null
          : findFeatureLookups(
              this._view,
              this._gposTableOff,
              multi ? tag.map(featureTagU32) : featureTagU32(tag),
              this._selTags,
              this._selLang,
              this._featureSubstitutions,
              true,
            );
      if (this._jstf) l = this._applyJustification(tag, l);
      this._cur.set(key, l);
    }
    return l;
  }

  /// True iff `featureTag` has at least one lookup in the GPOS table.
  hasFeature(featureTag) {
    const l =
      this._gposTableOff == null
        ? null
        : findFeatureLookups(
            this._view,
            this._gposTableOff,
            featureTagU32(featureTag),
            this._selTags,
            this._selLang,
            this._featureSubstitutions,
          );
    return !!(l && l.length > 0);
  }

  /// Get the global lookupList offset (for callers that want to
  /// resolve nested-lookup indices).
  get lookupListOff() {
    return this._lookupListOff;
  }

  /// Get the RAW (lookupType, lookupOff) for a global lookupListIdx —
  /// the type is the outer lookup type (an Extension wrapper reports 9;
  /// deref happens per SUBTABLE via _effSubtables/_derefExt9). Returns
  /// null when out of range.
  getLookupAt(lookupListIdx) {
    if (this._lookupListOff == null) return null;
    const v = this._view;
    const lookupCount = v.getUint16(this._lookupListOff, false);
    if (lookupListIdx >= lookupCount) return null;
    const lookupOff =
      this._lookupListOff + v.getUint16(this._lookupListOff + 2 + lookupListIdx * 2, false);
    const type = v.getUint16(lookupOff, false);
    return { type, lookupOff };
  }
}
