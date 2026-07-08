// OpenType Lookup.lookupFlag decoder + skip predicate.
//
// The 16-bit lookupFlag bitfield tells the context-matching engine which
// glyphs to SKIP during sequence walks. Bits:
//
//   0x0001  RIGHT_TO_LEFT          — cursive positioning only
//   0x0002  IgnoreBaseGlyphs       — skip GDEF class Base (1)
//   0x0004  IgnoreLigatures        — skip GDEF class Ligature (2)
//   0x0008  IgnoreMarks            — skip GDEF class Mark (3)
//   0x0010  UseMarkFilteringSet    — skip marks NOT in markGlyphSetsDef[markFilteringSet]
//   0x00E0  reserved
//   0xFF00  MarkAttachmentType     — skip marks whose mark-attach-class ≠ this
//
// When UseMarkFilteringSet is set, an additional u16 markFilteringSet
// is appended to the Lookup table (after subtableOffsets[]).
// Without GDEF, all these filters no-op (no glyph is classified).

/// Decode a lookup's filter from its lookupFlag + the optional
/// markFilteringSet that follows the subtableOffsets array. Returns a
/// record the matcher uses to decide which glyphs to skip. `gdef` is the
/// font's GdefReader (hasTable=false falls back to a no-op filter).
///
/// When UseMarkFilteringSet (0x10) is set, `markFilteringSet` must be
/// passed separately because it lives at a variable offset
/// (lookupOff + 6 + subTableCount * 2).
export function makeLookupFilter(lookupFlag, markFilteringSet, gdef) {
  const ignoreBases   = (lookupFlag & 0x0002) !== 0;
  const ignoreLigs    = (lookupFlag & 0x0004) !== 0;
  const ignoreMarks   = (lookupFlag & 0x0008) !== 0;
  const useMarkSet    = (lookupFlag & 0x0010) !== 0;
  const markAttachClass = (lookupFlag >> 8) & 0xFF;
  const hasGdef = gdef && gdef.hasTable;
  // Fast path: no filtering bits set → predicate always returns false.
  if (!ignoreBases && !ignoreLigs && !ignoreMarks && !useMarkSet && markAttachClass === 0) {
    return { skip: () => false, rtl: (lookupFlag & 0x0001) !== 0 };
  }
  // GDEF absent → can't classify; pretend nothing skips.
  if (!hasGdef) {
    return { skip: () => false, rtl: (lookupFlag & 0x0001) !== 0 };
  }
  return {
    skip: (gid) => {
      const cls = gdef.getGlyphClass(gid);
      if (ignoreBases && cls === 1) return true; // Base
      if (ignoreLigs  && cls === 2) return true; // Ligature
      if (ignoreMarks && cls === 3) return true; // Mark
      // UseMarkFilteringSet: skip MARKS NOT in the named set
      if (useMarkSet && cls === 3 && markFilteringSet >= 0) {
        if (!gdef.isInMarkGlyphSet(gid, markFilteringSet)) return true;
      }
      // MarkAttachmentType: skip marks whose attach class differs
      if (markAttachClass !== 0 && cls === 3) {
        if (gdef.getMarkAttachClass(gid) !== markAttachClass) return true;
      }
      return false;
    },
    rtl: (lookupFlag & 0x0001) !== 0,
  };
}

/// Walk seq forward from `start` finding the next position whose
/// glyph isn't skipped by `filter`. Returns -1 if no such position
/// exists in the sequence. When `filter.skip` is always-false (no
/// filtering), this is just `start + 1` (with bounds check).
export function nextNonSkippedForward(seq, start, filter) {
  for (let i = start; i < seq.length; i++) {
    if (!filter.skip(seq[i])) return i;
  }
  return -1;
}

/// Same, backward (used by chain-context backtrack walks).
export function nextNonSkippedBackward(seq, start, filter) {
  for (let i = start; i >= 0; i--) {
    if (!filter.skip(seq[i])) return i;
  }
  return -1;
}

/// Read the lookup header's flag fields + return both flag and the
/// optional markFilteringSet value (returns -1 when not present).
/// This is the canonical "open a lookup" helper for code that needs
/// to construct a filter.
export function readLookupFlags(view, lookupOff) {
  const lookupFlag = view.getUint16(lookupOff + 2, false);
  const subCount   = view.getUint16(lookupOff + 4, false);
  const markFilteringSet = (lookupFlag & 0x0010) !== 0
    ? view.getUint16(lookupOff + 6 + subCount * 2, false)
    : -1;
  return { lookupFlag, markFilteringSet, subCount };
}
