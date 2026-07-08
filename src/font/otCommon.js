// otCommon.js — OpenType layout-table primitives.

/**
 * @typedef {{ view: DataView }} HasView
 */

export function coverageIndex(view, covOff, glyph) {
  const fmt = view.getUint16(covOff, false);
  if (fmt === 1) {
    const count = view.getUint16(covOff + 2, false);
    let lo = 0, hi = count - 1;
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
    let lo = 0, hi = count - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = covOff + 4 + mid * 6;
      const start = view.getUint16(r, false);
      const end   = view.getUint16(r + 2, false);
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
    let lo = 0, hi = count - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = classDefOff + 4 + mid * 6;
      const start = view.getUint16(r, false);
      const end   = view.getUint16(r + 2, false);
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
  while (v !== 0) { n += v & 1; v >>>= 1; }
  return n * 2;
}

export function valueRecordXAdvance(view, recOff, valueFormat) {
  let off = recOff;
  if (valueFormat & 0x0001) off += 2;
  if (valueFormat & 0x0002) off += 2;
  if (valueFormat & 0x0004) return view.getInt16(off, false);
  return 0;
}

// Returns absolute offsets to each Lookup table the feature references,
// under the default-language Latin script. Falls back to DFLT, then to
// the first script's DFLT.
export function findFeatureLookups(view, tableBase, featureTag) {
  if (!tableBase) return null;
  const scriptListOff  = tableBase + view.getUint16(tableBase + 4, false);
  const featureListOff = tableBase + view.getUint16(tableBase + 6, false);
  const lookupListOff  = tableBase + view.getUint16(tableBase + 8, false);

  let langSysOff = _findLangSys(view, scriptListOff, 0x6C61746E /* 'latn' */);
  if (!langSysOff) langSysOff = _findLangSys(view, scriptListOff, 0x44464C54 /* 'DFLT' */);
  if (!langSysOff) {
    const scriptCount = view.getUint16(scriptListOff, false);
    if (scriptCount === 0) return null;
    const firstScriptOff = scriptListOff + view.getUint16(scriptListOff + 2 + 4, false);
    const defLangSysOff = view.getUint16(firstScriptOff, false);
    if (!defLangSysOff) return null;
    langSysOff = firstScriptOff + defLangSysOff;
  }

  const featCount = view.getUint16(langSysOff + 4, false);
  const idxBase   = langSysOff + 6;
  const featureListCount = view.getUint16(featureListOff, false);
  const lookups = [];
  for (let i = 0; i < featCount; i++) {
    const fi = view.getUint16(idxBase + i * 2, false);
    if (fi >= featureListCount) continue;
    const recOff = featureListOff + 2 + fi * 6;
    const tag = view.getUint32(recOff, false);
    if (tag !== featureTag) continue;
    const featOff = featureListOff + view.getUint16(recOff + 4, false);
    const lookupCount = view.getUint16(featOff + 2, false);
    const lookupIdxBase = featOff + 4;
    for (let j = 0; j < lookupCount; j++) {
      const li = view.getUint16(lookupIdxBase + j * 2, false);
      const lookupOff = lookupListOff + view.getUint16(lookupListOff + 2 + li * 2, false);
      lookups.push(lookupOff);
    }
  }
  return lookups.length === 0 ? null : lookups;
}

function _findLangSys(view, scriptListOff, scriptTag) {
  const scriptCount = view.getUint16(scriptListOff, false);
  for (let i = 0; i < scriptCount; i++) {
    const recOff = scriptListOff + 2 + i * 6;
    const tag = view.getUint32(recOff, false);
    if (tag !== scriptTag) continue;
    const scriptOff = scriptListOff + view.getUint16(recOff + 4, false);
    const defLangSysOff = view.getUint16(scriptOff, false);
    if (!defLangSysOff) return 0;
    return scriptOff + defLangSysOff;
  }
  return 0;
}
