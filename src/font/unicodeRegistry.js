// Indirection for NFC normalization + grapheme segmentation, mirroring the
// bidi/shaper registry pattern. The default is platform-direct (no tables
// shipped). Importing "@kontek/mantle/font/unicode" registers the capability
// layer (platform-first, table fallback) — see unicode/index.js.

function platformNFC(s) {
  return s.normalize("NFC");
}
let _graphemeSeg = null;
function platformGraphemes(s) {
  // Singleton: Segmenter construction is expensive and this runs per
  // layout call.
  const seg = _graphemeSeg
    || (_graphemeSeg = new Intl.Segmenter(undefined, { granularity: "grapheme" }));
  const out = [];
  for (const { segment } of seg.segment(s)) out.push(segment);
  return out;
}

let _normalizeNFC = platformNFC;
let _segmentGraphemes = platformGraphemes;

export function registerUnicode(impl) {
  if (impl.normalizeNFC) _normalizeNFC = impl.normalizeNFC;
  if (impl.segmentGraphemes) _segmentGraphemes = impl.segmentGraphemes;
}

export function normalizeNFC(s) {
  return _normalizeNFC(s);
}
export function segmentGraphemes(s) {
  return _segmentGraphemes(s);
}
