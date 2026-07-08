// Build full Unicode upper/lower/title case mappings: simple (single code point)
// from UnicodeData.txt fields 12/13/14, overridden by the UNCONDITIONAL full
// mappings in SpecialCasing.txt (e.g. ß -> SS, ﬀ -> FF). Locale/context-
// conditional entries (Turkish i, Lithuanian, Greek final sigma) are skipped so
// the result is deterministic and locale-independent (matches toUpperInvariant-
// style behavior but with full coverage + multi-char expansions).
import { ucd } from "./ucd.mjs";

export function buildCaseData() {
  const upper = new Map();
  const lower = new Map();
  const title = new Map();

  for (const line of ucd("UnicodeData.txt").split("\n")) {
    if (!line) continue;
    const f = line.split(";");
    const cp = parseInt(f[0], 16);
    if (f[1].endsWith("First>") || f[1].endsWith("Last>")) continue;
    if (f[12]) upper.set(cp, [parseInt(f[12], 16)]);
    if (f[13]) lower.set(cp, [parseInt(f[13], 16)]);
    if (f[14]) title.set(cp, [parseInt(f[14], 16)]);
  }

  for (let line of ucd("SpecialCasing.txt").split("\n")) {
    const h = line.indexOf("#");
    if (h >= 0) line = line.slice(0, h);
    line = line.trim();
    if (!line) continue;
    const f = line.split(";").map((s) => s.trim());
    if (f.length < 4) continue;
    if (f[4]) continue; // conditional (locale/context) — skip for default mapping
    const cp = parseInt(f[0], 16);
    const seq = (s) => (s ? s.split(/\s+/).map((x) => parseInt(x, 16)) : []);
    lower.set(cp, seq(f[1]));
    title.set(cp, seq(f[2]));
    upper.set(cp, seq(f[3]));
  }

  // Case folding (CaseFolding.txt): use C (common) + F (full) for caseless
  // matching; skip S (simple alt of F) and T (Turkic locale).
  const fold = new Map();
  for (let line of ucd("CaseFolding.txt").split("\n")) {
    const h = line.indexOf("#");
    if (h >= 0) line = line.slice(0, h);
    line = line.trim();
    if (!line) continue;
    const f = line.split(";").map((s) => s.trim());
    if (f[1] !== "C" && f[1] !== "F") continue;
    fold.set(parseInt(f[0], 16), f[2].split(/\s+/).map((x) => parseInt(x, 16)));
  }

  return { upper: pack(upper), lower: pack(lower), title: pack(title), fold: pack(fold) };
}

// Pack a cp->cp[] map into sorted keys + offsets + flat data (NFC-style layout).
function pack(map) {
  const keys = [...map.keys()].sort((a, b) => a - b);
  const off = [0];
  const data = [];
  for (const k of keys) {
    for (const c of map.get(k)) data.push(c);
    off.push(data.length);
  }
  return {
    keys: Uint32Array.from(keys),
    off: Uint32Array.from(off),
    data: Uint32Array.from(data),
  };
}
