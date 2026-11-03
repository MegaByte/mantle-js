// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// otCommon.js — OpenType layout-table primitives.

/**
 * @typedef {{ view: DataView }} HasView
 */

/**
 * Append a Coverage table's glyph ranges to `out` as [first, last] pairs.
 * Returns false for an unknown format, leaving `out` unusable.
 */
export function coverageRanges(view, covOff, out) {
  const fmt = view.getUint16(covOff, false);
  const count = view.getUint16(covOff + 2, false);
  if (fmt === 1) {
    for (let i = 0; i < count; i++) {
      const g = view.getUint16(covOff + 4 + i * 2, false);
      out.push(g, g);
    }
    return true;
  }
  if (fmt === 2) {
    for (let i = 0; i < count; i++) {
      const r = covOff + 4 + i * 6;
      out.push(view.getUint16(r, false), view.getUint16(r + 2, false));
    }
    return true;
  }
  return false;
}

export function coverageIndex(view, covOff, glyph) {
  const fmt = view.getUint16(covOff, false);
  if (fmt === 1) {
    const count = view.getUint16(covOff + 2, false);
    let lo = 0,
      hi = count - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const g = view.getUint16(covOff + 4 + mid * 2, false);
      if (g < glyph) lo = mid + 1;
      else if (g > glyph) hi = mid - 1;
      else return mid;
    }
    return -1;
  }
  if (fmt === 2) {
    const count = view.getUint16(covOff + 2, false);
    let lo = 0,
      hi = count - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = covOff + 4 + mid * 6;
      const start = view.getUint16(r, false);
      const end = view.getUint16(r + 2, false);
      if (glyph < start) hi = mid - 1;
      else if (glyph > end) lo = mid + 1;
      else {
        const startIdx = view.getUint16(r + 4, false);
        return startIdx + (glyph - start);
      }
    }
    return -1;
  }
  return -1;
}

export function classOf(view, classDefOff, glyph) {
  const fmt = view.getUint16(classDefOff, false);
  if (fmt === 1) {
    const startGlyph = view.getUint16(classDefOff + 2, false);
    const count = view.getUint16(classDefOff + 4, false);
    if (glyph < startGlyph || glyph >= startGlyph + count) return 0;
    return view.getUint16(classDefOff + 6 + (glyph - startGlyph) * 2, false);
  }
  if (fmt === 2) {
    const count = view.getUint16(classDefOff + 2, false);
    let lo = 0,
      hi = count - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = classDefOff + 4 + mid * 6;
      const start = view.getUint16(r, false);
      const end = view.getUint16(r + 2, false);
      if (glyph < start) hi = mid - 1;
      else if (glyph > end) lo = mid + 1;
      else return view.getUint16(r + 4, false);
    }
    return 0;
  }
  return 0;
}

export function valueRecordSize(valueFormat) {
  let n = 0;
  let v = valueFormat;
  while (v !== 0) {
    n += v & 1;
    v >>>= 1;
  }
  return n * 2;
}

/// The Device / VariationIndex table that adjusts a ValueRecord's x advance: its offset (relative to the table that
/// OWNS the record: the PairPos or SinglePos subtable, not the PairSet), or 0 when the format has none.
export function valueRecordXAdvDeviceOffset(view, recOff, valueFormat) {
  if (!(valueFormat & 0x0040)) return 0;
  let n = valueFormat & 0x3f;
  let fields = 0;
  while (n !== 0) {
    fields += n & 1;
    n >>>= 1;
  }
  return view.getUint16(recOff + fields * 2, false);
}

export function valueRecordXAdvance(view, recOff, valueFormat) {
  let off = recOff;
  if (valueFormat & 0x0001) off += 2;
  if (valueFormat & 0x0002) off += 2;
  if (valueFormat & 0x0004) return view.getInt16(off, false);
  return 0;
}

/// A 4-character OpenType tag as a u32. Memoized: the shaping code
/// passes string literals and this runs per feature resolution.
const _tagU32Cache = new Map();
export function featureTagU32(tag) {
  let t = _tagU32Cache.get(tag);
  if (t === undefined) {
    t =
      ((tag.charCodeAt(0) << 24) |
        (tag.charCodeAt(1) << 16) |
        (tag.charCodeAt(2) << 8) |
        tag.charCodeAt(3)) >>>
      0;
    _tagU32Cache.set(tag, t);
  }
  return t;
}

const TAG_DFLT = 0x44464c54; // 'DFLT' — the default SCRIPT tag
const TAG_dflt = 0x64666c74; // 'dflt' — the default LANGUAGE tag, which
//          some fonts write as a script
const TAG_latn = 0x6c61746e; // 'latn'

/**
 * Returns absolute offsets to each Lookup table `featureTag` references
 * under the script and language system the run selects, or null when the
 * feature isn't reachable there.
 *
 * `scriptTags` is the run's ordered OpenType script tags (see
 * otScriptTags.js — new-style first, e.g. dev2 then deva); null means
 * Latin text. The first tag the table carries wins. When none does, the
 * search falls back to DFLT, then dflt, then latn, and a table carrying
 * none of those contributes no features at all — which is what
 * HarfBuzz's hb_ot_layout_table_select_script does, and the reason a
 * Latin run through a font whose only script is 'arab' gets no features
 * instead of Arabic's.
 *
 * `langTag` picks a LangSysRecord inside that script; 0, or a tag the
 * script doesn't carry, takes its default language system. The
 * LangSys's required feature (if any) counts as one of its features.
 */
/** First matching FeatureVariations substitution set for normalized axis coordinates. */
export function findFeatureSubstitutions(view, tableBase, coords) {
  const fits = (offset, size) => offset >= 0 && offset <= view.byteLength - size;
  if (tableBase == null || !fits(tableBase, 14) || view.getUint16(tableBase + 2, false) < 1)
    return null;
  const relative = view.getUint32(tableBase + 10, false);
  if (!relative) return null;
  const base = tableBase + relative;
  if (!fits(base, 8) || view.getUint32(base, false) !== 0x00010000) return null;
  const count = view.getUint32(base + 4, false);
  if (!fits(base + 8, count * 8)) return null;
  for (let i = 0; i < count; i++) {
    const record = base + 8 + i * 8;
    const conditionOffset = view.getUint32(record, false);
    const conditionBase = base + conditionOffset;
    let matches = true;
    if (conditionOffset) {
      if (!fits(conditionBase, 2)) continue;
      const conditions = view.getUint16(conditionBase, false);
      if (!fits(conditionBase + 2, conditions * 4)) continue;
      for (let j = 0; j < conditions; j++) {
        const condition = conditionBase + view.getUint32(conditionBase + 2 + j * 4, false);
        if (!fits(condition, 8) || view.getUint16(condition, false) !== 1) {
          matches = false;
          break;
        }
        const axis = view.getUint16(condition + 2, false);
        const low = view.getInt16(condition + 4, false) / 16384;
        const high = view.getInt16(condition + 6, false) / 16384;
        if (!coords || axis >= coords.length || !(coords[axis] >= low && coords[axis] <= high)) {
          matches = false;
          break;
        }
      }
    }
    if (!matches) continue;
    const offset = base + view.getUint32(record + 4, false);
    if (!fits(offset, 6) || view.getUint32(offset, false) !== 0x00010000) continue;
    const substitutions = view.getUint16(offset + 4, false);
    if (!fits(offset + 6, substitutions * 6)) continue;
    const features = new Map();
    for (let j = 0; j < substitutions; j++) {
      const entry = offset + 6 + j * 6;
      const index = view.getUint16(entry, false);
      const alternate = offset + view.getUint32(entry + 2, false);
      if (!fits(alternate, 4)) continue;
      const lookups = view.getUint16(alternate + 2, false);
      if (fits(alternate + 4, lookups * 2) && !features.has(index)) features.set(index, alternate);
    }
    return { offset, features };
  }
  return null;
}

/** Required feature tag in the selected language system, or null. */
export function requiredFeatureTag(view, tableBase, scriptTags = null, langTag = 0) {
  if (!tableBase) return null;
  const scriptOff = _selectScript(
    view,
    tableBase + view.getUint16(tableBase + 4, false),
    scriptTags,
  );
  if (!scriptOff) return null;
  const langSysOff = _selectLangSys(view, scriptOff, langTag);
  if (!langSysOff) return null;
  const index = view.getUint16(langSysOff + 2, false);
  const featureList = tableBase + view.getUint16(tableBase + 6, false);
  if (index === 0xffff || index >= view.getUint16(featureList, false)) return null;
  const record = featureList + 2 + index * 6;
  return String.fromCharCode(...Array.from({ length: 4 }, (_, i) => view.getUint8(record + i)));
}

/// Pass as the feature tag to take the lookups of every feature the language system lists.
export const ANY_FEATURE = -1;

export function findFeatureLookups(
  view,
  tableBase,
  featureTag,
  scriptTags = null,
  langTag = 0,
  substitutions = null,
  includeRequired = false,
  listedOnly = false,
) {
  if (!tableBase) return null;
  const scriptListOff = tableBase + view.getUint16(tableBase + 4, false);
  const featureListOff = tableBase + view.getUint16(tableBase + 6, false);
  const lookupListOff = tableBase + view.getUint16(tableBase + 8, false);

  const scriptOff = _selectScript(view, scriptListOff, scriptTags);
  if (scriptOff === 0) return null;
  const langSysOff = _selectLangSys(view, scriptOff, langTag);
  if (langSysOff === 0) return null;

  const reqIdx = view.getUint16(langSysOff + 2, false);
  const featCount = view.getUint16(langSysOff + 4, false);
  const idxBase = langSysOff + 6;
  const featureListCount = view.getUint16(featureListOff, false);
  const lookupIndices = new Set();
  // An array of tags merges the lookups of several features, in lookup-list order (one HarfBuzz stage).
  const multi = Array.isArray(featureTag);
  const takeFeature = (fi) => {
    if (fi >= featureListCount) return;
    const recOff = featureListOff + 2 + fi * 6;
    const tagAt = view.getUint32(recOff, false);
    if (
      featureTag !== ANY_FEATURE &&
      !(multi ? featureTag.includes(tagAt) : tagAt === featureTag) &&
      !(includeRequired && fi === reqIdx)
    )
      return;
    const featOff =
      substitutions?.features.get(fi) ?? featureListOff + view.getUint16(recOff + 4, false);
    const lookupCount = view.getUint16(featOff + 2, false);
    const lookupIdxBase = featOff + 4;
    for (let j = 0; j < lookupCount; j++) {
      const li = view.getUint16(lookupIdxBase + j * 2, false);
      lookupIndices.add(li);
    }
  };
  // 0xFFFF = no required feature.
  if (!listedOnly && reqIdx !== 0xffff) takeFeature(reqIdx);
  for (let i = 0; i < featCount; i++) takeFeature(view.getUint16(idxBase + i * 2, false));
  if (!lookupIndices.size) return null;
  return Array.from(lookupIndices)
    .sort((a, b) => a - b)
    .map((index) => lookupListOff + view.getUint16(lookupListOff + 2 + index * 2, false));
}

/// The OpenType script tag (u32) of the GSUB/GPOS Script table the run resolves to, or 0 for none or a fallback script.
export function selectedScriptTag(view, tableBase, scriptTags) {
  if (!tableBase || !scriptTags) return 0;
  const scriptListOff = tableBase + view.getUint16(tableBase + 4, false);
  for (const t of scriptTags) if (_findScript(view, scriptListOff, t)) return t;
  return 0;
}

/// Absolute offset of the Script table the run resolves to, or 0.
function _selectScript(view, scriptListOff, scriptTags) {
  if (scriptTags) {
    for (let i = 0; i < scriptTags.length; i++) {
      const off = _findScript(view, scriptListOff, scriptTags[i]);
      if (off) return off;
    }
  } else {
    const off = _findScript(view, scriptListOff, TAG_latn);
    if (off) return off;
  }
  return (
    _findScript(view, scriptListOff, TAG_DFLT) ||
    _findScript(view, scriptListOff, TAG_dflt) ||
    _findScript(view, scriptListOff, TAG_latn)
  );
}

function _findScript(view, scriptListOff, scriptTag) {
  const scriptCount = view.getUint16(scriptListOff, false);
  for (let i = 0; i < scriptCount; i++) {
    const recOff = scriptListOff + 2 + i * 6;
    if (view.getUint32(recOff, false) !== scriptTag) continue;
    return scriptListOff + view.getUint16(recOff + 4, false);
  }
  return 0;
}

/// Absolute offset of the LangSys table for `langTag` under `scriptOff`,
/// falling back to the script's default language system. 0 when neither
/// exists (a Script table may carry only non-default languages).
function _selectLangSys(view, scriptOff, langTag) {
  if (langTag) {
    const count = view.getUint16(scriptOff + 2, false);
    for (let i = 0; i < count; i++) {
      const recOff = scriptOff + 4 + i * 6;
      if (view.getUint32(recOff, false) !== langTag) continue;
      return scriptOff + view.getUint16(recOff + 4, false);
    }
  }
  const defOff = view.getUint16(scriptOff, false);
  return defOff ? scriptOff + defOff : 0;
}
