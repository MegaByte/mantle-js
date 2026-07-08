// Capability detection: platform-first, table-fallback. Runs the platform
// Unicode API (String.normalize / Intl.Segmenter) against sentinels baked from
// the pinned UCD version; any throw or divergence means the platform is
// behind/broken, so route to the shipped table engines instead.
//
// Importing this module pulls in the table engines as the fallback; consumers
// targeting a known-modern platform can call String.normalize/Intl.Segmenter
// directly and never import this.
import { toNFC } from "./nfc.js";
import { eachGrapheme } from "./graphemes.js";
import { nfcSentinels, graphemeSentinels } from "./tables/sentinels.js";

let policy = "auto"; // 'auto' | 'platform' | 'tables'
let _nfc = null;
let _gr = null;

/** Force a policy. 'auto' (default) probes; 'platform'/'tables' override. */
export function setUnicodePolicy(p) {
  policy = p;
  _nfc = _gr = null;
}

function cpArray(str) {
  const out = [];
  for (const ch of str) out.push(ch.codePointAt(0));
  return out;
}

function probeNFC() {
  if (policy !== "auto") return policy;
  try {
    if (typeof "".normalize !== "function") return "tables";
    for (const s of nfcSentinels) {
      const got = cpArray(String.fromCodePoint(...s.in).normalize("NFC"));
      if (got.length !== s.out.length || got.some((v, i) => v !== s.out[i])) return "tables";
    }
    return "platform";
  } catch {
    return "tables";
  }
}

// Cluster sizes (in code points) from boundary indices [0,...,n].
function sizesFromBounds(bounds) {
  const out = [];
  for (let i = 1; i < bounds.length; i++) out.push(bounds[i] - bounds[i - 1]);
  return out;
}

function probeGrapheme() {
  if (policy !== "auto") return policy;
  try {
    if (typeof Intl === "undefined" || typeof Intl.Segmenter !== "function") return "tables";
    const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    for (const s of graphemeSentinels) {
      const want = sizesFromBounds(s.bounds);
      const got = [];
      for (const { segment } of seg.segment(String.fromCodePoint(...s.in))) got.push(cpArray(segment).length);
      if (got.length !== want.length || got.some((v, i) => v !== want[i])) return "tables";
    }
    return "platform";
  } catch {
    return "tables";
  }
}

export function nfcMode() {
  return (_nfc ??= probeNFC());
}
export function graphemeMode() {
  return (_gr ??= probeGrapheme());
}

/** NFC-normalize a string via the platform when current, else the table engine. */
export function normalizeNFC(str) {
  return nfcMode() === "platform" ? str.normalize("NFC") : toNFC(str);
}

/** Return grapheme clusters as strings, platform or table-driven. */
export function segmentGraphemes(str) {
  if (graphemeMode() === "platform") {
    const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    const out = [];
    for (const { segment } of seg.segment(str)) out.push(segment);
    return out;
  }
  const out = [];
  eachGrapheme(str, (s) => out.push(s));
  return out;
}

/** For diagnostics / tests. */
export function unicodeStatus() {
  return { policy, nfc: nfcMode(), grapheme: graphemeMode() };
}
