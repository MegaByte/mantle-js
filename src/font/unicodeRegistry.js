// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Indirection for NFC normalization + grapheme segmentation, mirroring the
// bidi/shaper registry pattern. The default is platform-direct (no tables
// shipped). Importing "@kontek/mantle/font/unicode" registers the capability
// layer (platform-first, table fallback) — see unicode/index.js.

function platformNFC(s) {
  return s.normalize('NFC');
}
let _graphemeSeg = null;
function platformGraphemes(s) {
  // Singleton: Segmenter construction is expensive and this runs per
  // layout call.
  const seg =
    _graphemeSeg || (_graphemeSeg = new Intl.Segmenter(undefined, { granularity: 'grapheme' }));
  const out = [];
  for (const { segment } of seg.segment(s)) out.push(segment);
  return out;
}

// Dictionary word starts provide optional wrap opportunities. The default uses
// Intl.Segmenter when available, otherwise no dictionary hints. A host can
// register `wordStarts(text) => Iterable<number>` of UTF-16 offsets.
let _wordSeg = null;
function platformWordStarts(s) {
  if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') return null;
  try {
    const seg = _wordSeg || (_wordSeg = new Intl.Segmenter(undefined, { granularity: 'word' }));
    const out = [];
    for (const w of seg.segment(s)) if (w.isWordLike) out.push(w.index);
    return out;
  } catch (e) {
    return null;
  }
}

/**
 * @typedef {{
 *   normalizeNFC?: (text: string) => string,
 *   segmentGraphemes?: (text: string) => Iterable<string>,
 *   wordStarts?: (text: string) => Iterable<number> | null,
 * }} UnicodeProvider
 */
/** @type {(text: string) => string} */
let _normalizeNFC = platformNFC;
/** @type {(text: string) => Iterable<string>} */
let _segmentGraphemes = platformGraphemes;
/** @type {(text: string) => Iterable<number> | null} */
let _wordStarts = platformWordStarts;

/** Install the supplied Unicode hooks; omitted hooks remain unchanged. @param {UnicodeProvider} impl */
export function registerUnicode(impl) {
  if (impl.normalizeNFC) _normalizeNFC = impl.normalizeNFC;
  if (impl.segmentGraphemes) _segmentGraphemes = impl.segmentGraphemes;
  if (impl.wordStarts) _wordStarts = impl.wordStarts;
}

export function normalizeNFC(s) {
  return _normalizeNFC(s);
}
export function segmentGraphemes(s) {
  return _segmentGraphemes(s);
}

/// UTF-16 offsets at which a word starts, or null when no segmenter is available.
export function segmentWordStarts(s) {
  return _wordStarts(s);
}
