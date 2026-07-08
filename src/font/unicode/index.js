// Opt-in entry "@kontek/mantle/font/unicode": registers the platform-first +
// table-fallback Unicode layer into the font pipeline and re-exports the public
// surface. Pulls in the shipped UAX #15 (NFC) and UAX #29 (grapheme) engines as
// the fallback used when the platform API is behind/broken.
import { registerUnicode } from "../unicodeRegistry.js";
import { normalizeNFC, segmentGraphemes, setUnicodePolicy, unicodeStatus, nfcMode, graphemeMode } from "./capabilities.js";
import { toNFC, toNFCCodepoints } from "./nfc.js";
import { graphemeBoundaries, eachGrapheme } from "./graphemes.js";

let _registered = false;

/** Install the capability-backed Unicode layer. Idempotent. */
export function registerUnicodeFallback() {
  if (_registered) return;
  _registered = true;
  registerUnicode({ normalizeNFC, segmentGraphemes });
}

registerUnicodeFallback();

export {
  normalizeNFC,
  segmentGraphemes,
  setUnicodePolicy,
  unicodeStatus,
  nfcMode,
  graphemeMode,
  toNFC,
  toNFCCodepoints,
  graphemeBoundaries,
  eachGrapheme,
};
