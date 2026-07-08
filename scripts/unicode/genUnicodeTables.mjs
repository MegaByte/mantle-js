// Generate Unicode property tables for BOTH runtimes from one pinned UCD source.
//   node scripts/unicode/fetchUcd.mjs   # once, vendors .ucd-cache/
//   node scripts/unicode/genUnicodeTables.mjs
//
// Each spec builds a codepoint->byte trie (lib/trie.mjs: 3-stage block-dedup + RLE),
// base64-encodes the blob, and emits:
//   - JS  : src/font/unicode/tables/<name>.js           (tree-shakeable ESM)
//   - C#  : Runtime/Font/Unicode/Generated/Mantle<Name>Table.cs
// Both decode the identical blob, so JS and C# lookups are equal by construction.
// enumOrder pins value->id so a future Unicode version appends (never reorders).
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseUnicodeData, parseEnumProp, parseCatalog, parseBinaryProp, enumerate, ucd, UCD_VERSION } from "./lib/ucd.mjs";
import { buildTrie, serializeTrie, encodeVarintArray } from "./lib/trie.mjs";
import { buildNfcData } from "./lib/nfc.mjs";
import { buildCaseData } from "./lib/case.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const JS_OUT = join(HERE, "..", "..", "src", "font", "unicode", "tables");
const CS_OUT = join(HERE, "..", "..", "..", "net.kontek.mantle", "Runtime", "Font", "Unicode", "Generated");
mkdirSync(JS_OUT, { recursive: true });
mkdirSync(CS_OUT, { recursive: true });

const { ccc, gc } = parseUnicodeData();

// Pre-resolve UAX #14 LB1 at generation time so the runtime never sees the
// context/ambiguous classes: AI/SG/XX -> AL, CJ -> NS, SA -> CM (if Mn/Mc) else AL.
function resolveLineBreak() {
  const raw = parseEnumProp(ucd("LineBreak.txt"));
  const out = new Array(0x110000);
  for (let cp = 0; cp < 0x110000; cp++) {
    let c = raw[cp] ?? "XX";
    if (c === "AI" || c === "SG" || c === "XX") c = "AL";
    else if (c === "CJ") c = "NS";
    else if (c === "SA") c = gc[cp] === "Mn" || gc[cp] === "Mc" ? "CM" : "AL";
    else if (c === "QU") c = gc[cp] === "Pi" ? "QU_PI" : gc[cp] === "Pf" ? "QU_PF" : "QU";
    out[cp] = c;
  }
  return out;
}

// Pinned value orders (UAX property values). Appending only — never reorder.
const GCB_ORDER = ["Other", "CR", "LF", "Control", "Extend", "ZWJ", "Regional_Indicator",
  "Prepend", "SpacingMark", "L", "V", "T", "LV", "LVT"];
const INCB_ORDER = ["None", "Consonant", "Extend", "Linker"];
// Bidi class order MUST match src/font/bidi.js BidiClass enum.
const BIDI_ORDER = ["L", "R", "AL", "EN", "ES", "ET", "AN", "CS", "NSM", "BN",
  "B", "S", "WS", "ON", "LRE", "RLE", "LRO", "RLO", "PDF", "LRI", "RLI", "FSI", "PDI"];
const BIDI_LONG = {
  Left_To_Right: "L", Right_To_Left: "R", Arabic_Letter: "AL", European_Number: "EN",
  European_Separator: "ES", European_Terminator: "ET", Arabic_Number: "AN",
  Common_Separator: "CS", Nonspacing_Mark: "NSM", Boundary_Neutral: "BN",
  Paragraph_Separator: "B", Segment_Separator: "S", White_Space: "WS", Other_Neutral: "ON",
  Left_To_Right_Embedding: "LRE", Right_To_Left_Embedding: "RLE", Left_To_Right_Override: "LRO",
  Right_To_Left_Override: "RLO", Pop_Directional_Format: "PDF", Left_To_Right_Isolate: "LRI",
  Right_To_Left_Isolate: "RLI", First_Strong_Isolate: "FSI", Pop_Directional_Isolate: "PDI",
};
// Joining_Type (ArabicShaping.txt) — covers Arabic, Syriac, Mongolian, N'Ko,
// Adlam, Mandaic, Manichaean, etc. Order matches arabicJoining.js ArabicJoiningType.
const JT_ORDER = ["U", "R", "L", "D", "C", "T"];
const joiningTypeVals = (() => {
  const out = new Array(0x110000);
  for (let cp = 0; cp < 0x110000; cp++) {
    const g = gc[cp];
    out[cp] = g === "Mn" || g === "Me" || g === "Cf" ? "T" : "U"; // default
  }
  for (let line of ucd("ArabicShaping.txt").split("\n")) {
    line = line.trim();
    if (!line || line[0] === "#") continue;
    const f = line.split(";").map((s) => s.trim());
    out[parseInt(f[0], 16)] = f[2];
  }
  return out;
})();

// Indic shaper adapter: UCD Indic_Syllabic/Positional_Category -> the coarse
// categories the Indic shaper uses (indicShaper.js Isc/Ipc) + the RA pseudo-
// category (reph-forming consonant). Non-syllabic chars (danda/OM etc.) land in
// Other, which the shaper ignores.
const ISC_MAP = {
  Consonant: "Consonant", Consonant_Initial_Postfixed: "Consonant", Consonant_Prefixed: "Consonant",
  Consonant_Subjoined: "Consonant", Consonant_Medial: "Consonant", Consonant_Final: "Consonant",
  Consonant_Head_Letter: "Consonant", Consonant_With_Stacker: "Consonant",
  Consonant_Preceding_Repha: "Consonant", Consonant_Succeeding_Repha: "Consonant",
  Consonant_Dead: "ConsonantDead", Consonant_Killer: "Modifier",
  Consonant_Placeholder: "ConsonantPlaceholder",
  Nukta: "Nukta", Virama: "Halant", Pure_Killer: "Halant", Invisible_Stacker: "Halant",
  Joiner: "ZWJ", Non_Joiner: "ZWNJ",
  Vowel_Independent: "VowelIndependent", Vowel: "VowelIndependent", Vowel_Dependent: "VowelDependent",
  Bindu: "Bindu", Visarga: "Bindu",
  Avagraha: "Modifier", Modifying_Letter: "Modifier", Syllable_Modifier: "Modifier",
  Gemination_Mark: "Modifier", Tone_Mark: "Modifier", Tone_Letter: "Modifier", Cantillation_Mark: "Modifier",
  Register_Shifter: "RegisteredShifter",
  Number: "Number", Brahmi_Joining_Number: "Number", Number_Joiner: "Number",
};
const IPC_MAP = {
  NA: "Right", Right: "Right", Left: "Left", Top: "Top", Bottom: "Bottom",
  Left_And_Right: "LeftRight", Top_And_Right: "TopRight", Bottom_And_Right: "BottomRight",
  Top_And_Bottom_And_Right: "TopBottomRight", Top_And_Bottom: "Bottom",
  Top_And_Left: "Top", Top_And_Left_And_Right: "Top", Bottom_And_Left: "Bottom",
  Bottom_And_Right_And_Top: "TopBottomRight", Overstruck: "Right", Visual_Order_Left: "Left",
};
// RA (reph-forming) consonants per Indic/Brahmic script.
const RA_SET = new Set([0x930, 0x9b0, 0x9f0, 0xa30, 0xab0, 0xb30, 0xbb0, 0xc30, 0xcb0, 0xd30, 0xdbb]);
const shaperIscVals = (() => {
  const raw = parseEnumProp(ucd("IndicSyllabicCategory.txt"));
  const out = new Array(0x110000);
  for (let cp = 0; cp < 0x110000; cp++) out[cp] = RA_SET.has(cp) ? "Ra" : ISC_MAP[raw[cp]] || "Other";
  return out;
})();
const shaperIpcVals = (() => {
  const raw = parseEnumProp(ucd("IndicPositionalCategory.txt"));
  const out = new Array(0x110000);
  for (let cp = 0; cp < 0x110000; cp++) out[cp] = IPC_MAP[raw[cp]] || "Right";
  return out;
})();

const bidiClassVals = (() => {
  // Data lines carry SHORT names (L/R/AL); @missing lines carry LONG names and
  // supply block-level defaults for unassigned code points (e.g. unassigned in
  // Arabic blocks -> AL). Apply @missing defaults first, then override with data.
  const out = new Array(0x110000).fill("L");
  const text = ucd("DerivedBidiClass.txt");
  for (const line of text.split("\n")) {
    const m = line.match(/^#\s*@missing:\s*([0-9A-Fa-f]+)\.\.([0-9A-Fa-f]+)\s*;\s*(\w+)/);
    if (!m) continue;
    const lo = parseInt(m[1], 16), hi = parseInt(m[2], 16), v = BIDI_LONG[m[3]] ?? "L";
    for (let c = lo; c <= hi; c++) out[c] = v;
  }
  const data = parseEnumProp(text); // short names on non-comment lines
  for (let cp = 0; cp < 0x110000; cp++) if (data[cp] !== undefined) out[cp] = data[cp];
  return out;
})();

// Extended_Pictographic per codepoint: 0 = no, 1 = yes, 2 = yes & unassigned
// (Cn) — the latter is needed for line-break rule LB30b.
const extPictSet = parseBinaryProp(ucd("emoji-data.txt"), "Extended_Pictographic");
const extPictVals = new Uint8Array(0x110000);
for (const cp of extPictSet) extPictVals[cp] = gc[cp] === undefined || gc[cp] === "Cn" ? 2 : 1;

// Emoji properties packed as bit flags (UTS #51): one byte per codepoint.
const EMOJI_BIT = { Emoji: 1, Emoji_Presentation: 2, Emoji_Modifier: 4, Emoji_Modifier_Base: 8, Emoji_Component: 16 };
const emojiPropsVals = (() => {
  const out = new Uint8Array(0x110000);
  const txt = ucd("emoji-data.txt");
  for (const [prop, bit] of Object.entries(EMOJI_BIT)) {
    for (const cp of parseBinaryProp(txt, prop)) out[cp] |= bit;
  }
  return out;
})();

const TABLES = [
  {
    name: "ccc",
    pascal: "Ccc",
    desc: "Canonical_Combining_Class (UAX #15) — raw CCC value per codepoint.",
    values: ccc,
    def: 0,
    enumOrder: null, // numeric value, no enum
  },
  {
    name: "graphemeBreak",
    pascal: "GraphemeBreak",
    desc: "Grapheme_Cluster_Break (UAX #29).",
    values: parseEnumProp(ucd("GraphemeBreakProperty.txt")),
    def: "Other",
    enumOrder: GCB_ORDER,
    enumName: "Gcb",
  },
  {
    name: "extPict",
    pascal: "ExtPict",
    desc: "Extended_Pictographic (UTS #51) — boolean, for grapheme rule GB11.",
    values: extPictVals,
    def: 0,
    enumOrder: null,
  },
  {
    name: "incb",
    pascal: "Incb",
    desc: "Indic_Conjunct_Break (UAX #29) — for grapheme rule GB9c.",
    values: parseCatalog(ucd("DerivedCoreProperties.txt"), "InCB"),
    def: "None",
    enumOrder: INCB_ORDER,
    enumName: "Incb",
  },
  {
    name: "lineBreak",
    pascal: "LineBreak",
    desc: "Line_Break (UAX #14), pre-resolved per LB1.",
    values: resolveLineBreak(),
    def: "AL",
    enumOrder: null, // dynamic: discover class names from the data
    enumName: "Lb",
  },
  {
    name: "script",
    pascal: "Script",
    desc: "Script (UAX #24).",
    values: parseEnumProp(ucd("Scripts.txt")),
    def: "Unknown",
    enumOrder: null, // dynamic
    enumName: "Script",
  },
  {
    name: "eastAsianWidth",
    pascal: "EastAsianWidth",
    desc: "East_Asian_Width (UAX #11) — for line-break LB30 and width layout.",
    values: parseEnumProp(ucd("EastAsianWidth.txt")),
    def: "N",
    enumOrder: null, // dynamic
    enumName: "Eaw",
  },
  {
    name: "bidiClass",
    pascal: "BidiClass",
    desc: "Bidi_Class (UAX #9), full coverage. Enum order matches bidi.js BidiClass.",
    values: bidiClassVals,
    def: "L",
    enumOrder: BIDI_ORDER,
    enumName: "Bc",
  },
  {
    name: "joiningType",
    pascal: "JoiningType",
    desc: "Joining_Type (ArabicShaping.txt). Order matches arabicJoining.js ArabicJoiningType.",
    values: joiningTypeVals,
    def: "U",
    enumOrder: JT_ORDER,
    enumName: "Jt",
  },
  {
    name: "indicSyllabic",
    pascal: "IndicSyllabic",
    desc: "Indic_Syllabic_Category (UAX #?) — full coverage for Indic/USE shaping.",
    values: parseEnumProp(ucd("IndicSyllabicCategory.txt")),
    def: "Other",
    enumOrder: null,
    enumName: "Isc",
  },
  {
    name: "indicPositional",
    pascal: "IndicPositional",
    desc: "Indic_Positional_Category — full coverage for Indic/USE shaping.",
    values: parseEnumProp(ucd("IndicPositionalCategory.txt")),
    def: "NA",
    enumOrder: null,
    enumName: "Ipc",
  },
  {
    name: "shaperIsc",
    pascal: "ShaperIsc",
    desc: "Indic_Syllabic_Category -> shaper coarse categories + RA (indicShaper.js Isc).",
    values: shaperIscVals,
    def: "Other",
    enumOrder: ["Other", "Consonant", "ConsonantDead", "ConsonantPlaceholder", "Nukta", "Halant",
      "ZWJ", "ZWNJ", "VowelIndependent", "VowelDependent", "Anudatta", "Bindu", "Modifier", "Ra",
      "RegisteredShifter", "Number"],
    enumName: "ShaperIsc",
  },
  {
    name: "shaperIpc",
    pascal: "ShaperIpc",
    desc: "Indic_Positional_Category -> shaper positional categories (indicShaper.js Ipc).",
    values: shaperIpcVals,
    def: "Right",
    enumOrder: ["Right", "Left", "Top", "Bottom", "LeftRight", "TopRight", "BottomRight", "TopBottomRight"],
    enumName: "ShaperIpc",
  },
  {
    name: "verticalOrientation",
    pascal: "VerticalOrientation",
    desc: "Vertical_Orientation (UAX #50) — glyph orientation in vertical text.",
    values: parseEnumProp(ucd("VerticalOrientation.txt")),
    def: "R",
    enumOrder: ["R", "U", "Tu", "Tr"],
    enumName: "Vo",
  },
  {
    name: "emojiProps",
    pascal: "EmojiProps",
    desc: "Emoji property bit flags (UTS #51): 1=Emoji 2=Presentation 4=Modifier 8=ModifierBase 16=Component.",
    values: emojiPropsVals,
    def: 0,
    enumOrder: null,
  },
];

const banner = `// AUTO-GENERATED by scripts/unicode/genUnicodeTables.mjs from Unicode ${UCD_VERSION}.
// Do not edit by hand. Regenerate: node scripts/unicode/genUnicodeTables.mjs`;

const summary = [];
for (const t of TABLES) {
  let values = t.values;
  let names = null;
  let def = t.def;
  if (t.enumName) {
    const e = enumerate(t.values, t.def, t.enumOrder || undefined);
    values = e.ids;
    names = e.names;
    def = e.names.indexOf(t.def);
  }
  const blob = serializeTrie(buildTrie(values, def));
  const b64 = Buffer.from(blob).toString("base64");
  emitJs(t, b64, names);
  emitCs(t, b64, names);
  summary.push(`  ${t.name}: ${(blob.length / 1024).toFixed(1)}KB${names ? ` (${names.length} vals)` : ""}`);
}
emitNfc();
emitBidiMaps();
emitCase();
emitRgi();
await emitSentinels();

// RGI emoji ZWJ sequences (UTS #51). Flat u32 blob [len, cp...] per sequence;
// the runtime decodes into a Set for membership tests. Source is the latest
// standalone emoji release (the per-Unicode-version ucd tree ships no RGI file).
function emitRgi() {
  const seqs = [];
  for (let line of ucd("emoji-zwj-sequences.txt").split("\n")) {
    const h = line.indexOf("#");
    if (h >= 0) line = line.slice(0, h);
    line = line.trim();
    if (!line) continue;
    const f = line.split(";").map((s) => s.trim());
    if (!/Sequence/.test(f[1] || "")) continue;
    seqs.push(f[0].split(/\s+/).map((x) => parseInt(x, 16)));
  }
  // Only ~130 distinct code points span all the sequences, so store a code-point
  // dictionary (sorted, delta-varint) once and encode each sequence as 1-byte
  // indices. Blob: [dictCount:u32 LE][delta-varint dict][varint (len, idx...)*].
  const uniq = [...new Set(seqs.flat())].sort((a, b) => a - b);
  const idxOf = new Map(uniq.map((c, i) => [c, i]));
  const seqFlat = [];
  for (const s of seqs) { seqFlat.push(s.length); for (const c of s) seqFlat.push(idxOf.get(c)); }
  const head = new Uint8Array(4);
  new DataView(head.buffer).setUint32(0, uniq.length, true);
  const blob = Buffer.from(Buffer.concat([
    Buffer.from(head), Buffer.from(encodeVarintArray(uniq, true)), Buffer.from(encodeVarintArray(seqFlat, false)),
  ])).toString("base64");
  writeFileSync(
    join(JS_OUT, "emojiSequences.js"),
    `${banner}
// RGI emoji ZWJ sequences (UTS #51). Code-point dictionary + index sequences,
// decoded into a Set of "cp,cp,.." keys.
import { blobFromBase64 } from "../trie.js";

const SEQ =
  "${blob}";

const _b = blobFromBase64(SEQ);
let _i = 4;
const _rd = () => { let v = 0, s = 0, b; do { b = _b[_i++]; v |= (b & 0x7f) << s; s += 7; } while (b & 0x80); return v >>> 0; };
const _dictCount = _b[0] | (_b[1] << 8) | (_b[2] << 16) | (_b[3] << 24);
const _dict = new Uint32Array(_dictCount);
for (let j = 0, p = 0; j < _dictCount; j++) { p += _rd(); _dict[j] = p; }
const _set = new Set();
while (_i < _b.length) {
  const n = _rd();
  const parts = [];
  for (let k = 0; k < n; k++) parts.push(_dict[_rd()]);
  _set.add(parts.join(","));
}

/** True iff the code points form a Recommended-for-General-Interchange ZWJ emoji. */
export function isRgiZwjSequence(cps) {
  return _set.has(Array.from(cps).join(","));
}
export const rgiZwjSequenceCount = _set.size;
`,
  );
  writeFileSync(
    join(CS_OUT, "MantleEmojiSequences.cs"),
    `${banner}
// RGI emoji ZWJ sequences (UTS #51). Code-point dictionary + index sequences,
// decoded into a HashSet of comma-joined keys.
using System;
using System.Collections.Generic;
using System.Text;

namespace Mantle.Font.Unicode
{
    public static class MantleEmojiSequences
    {
        const string SEQ =
            "${blob}";

        static readonly HashSet<string> Set = Build();
        static HashSet<string> Build()
        {
            byte[] b = Convert.FromBase64String(SEQ);
            int i = 4;
            uint Rd() { uint v = 0; int s = 0; byte x; do { x = b[i++]; v |= (uint)(x & 0x7f) << s; s += 7; } while ((x & 0x80) != 0); return v; }
            int dictCount = b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24);
            var dict = new uint[dictCount];
            for (uint j = 0, p = 0; j < dictCount; j++) { p += Rd(); dict[j] = p; }
            var set = new HashSet<string>();
            while (i < b.Length)
            {
                int n = (int)Rd();
                var sb = new StringBuilder();
                for (int k = 0; k < n; k++) { if (k > 0) sb.Append(','); sb.Append(dict[Rd()]); }
                set.Add(sb.ToString());
            }
            return set;
        }

        public static bool IsRgiZwjSequence(IList<int> cps)
        {
            var sb = new StringBuilder();
            for (int i = 0; i < cps.Count; i++) { if (i > 0) sb.Append(','); sb.Append((uint)cps[i]); }
            return Set.Contains(sb.ToString());
        }
    }
}
`,
  );
  summary.push(`  rgi: ${seqs.length} emoji ZWJ sequences`);
}

// Upper/lower/title case mappings (full coverage, locale-independent).
function emitCase() {
  const c = buildCaseData();
  const maps = { upper: c.upper, lower: c.lower, title: c.title, fold: c.fold };
  // title is ~91% identical to upper and fold ~87% to lower, so store those two
  // as a bitmask-over-base delta; the base maps (upper, lower) are stored whole.
  const base = { title: "upper", fold: "lower" };
  const order = ["upper", "lower", "title", "fold"];
  const b64 = {
    upper: b64caseMap(c.upper),
    lower: b64caseMap(c.lower),
    title: b64caseMapDelta(c.title, c.upper),
    fold: b64caseMapDelta(c.fold, c.lower),
  };
  const jsConsts = order.map((k) => `const ${k.toUpperCase()} =\n  "${b64[k]}";`).join("\n");
  const jsLocals = order.map((k) =>
    base[k]
      ? `const _${k} = caseMapDelta(${k.toUpperCase()}, _${base[k]});`
      : `const _${k} = caseMap(${k.toUpperCase()});`).join("\n");
  const jsObj = order.map((k) =>
    `  ${k}Keys: _${k}.keys, ${k}Off: _${k}.off, ${k}Data: _${k}.data,`).join("\n");
  writeFileSync(
    join(JS_OUT, "caseData.js"),
    `${banner}
// Unicode case mappings (UnicodeData simple + SpecialCasing unconditional).
// title/fold are stored as a delta over upper/lower and rebuilt at load.
import { caseMap, caseMapDelta } from "../trie.js";

${jsConsts}

${jsLocals}

export const caseData = Object.freeze({
${jsObj}
});
`,
  );
  const csConsts = order.map((k) => `        const string ${k.toUpperCase()} =\n            "${b64[k]}";`).join("\n");
  const csLocals = order.map((k) =>
    base[k]
      ? `        static readonly (uint[] keys, uint[] off, uint[] data) _${k} = MantleUnicodeTrie.CaseMapDeltaFromBase64(${k.toUpperCase()}, _${base[k]}.keys, _${base[k]}.off, _${base[k]}.data);`
      : `        static readonly (uint[] keys, uint[] off, uint[] data) _${k} = MantleUnicodeTrie.CaseMapFromBase64(${k.toUpperCase()});`).join("\n");
  const csFields = order.map((k) =>
    `        public static readonly uint[] ${cap(k)}Keys = _${k}.keys;\n        public static readonly uint[] ${cap(k)}Off = _${k}.off;\n        public static readonly uint[] ${cap(k)}Data = _${k}.data;`).join("\n");
  writeFileSync(
    join(CS_OUT, "MantleCaseData.cs"),
    `${banner}
// Unicode case mappings (UnicodeData simple + SpecialCasing unconditional).
// title/fold are stored as a delta over upper/lower and rebuilt at load.
namespace Mantle.Font.Unicode
{
    public static class MantleCaseData
    {
${csConsts}

${csLocals}

${csFields}
    }
}
`,
  );
  summary.push(`  case: ${c.upper.keys.length} upper, ${c.lower.keys.length} lower, ${c.title.keys.length} title (title/fold delta-coded)`);
}

// Bidi mirroring (cp -> mirror cp) + brackets (cp -> paired cp, type 0=open/1=close).
function emitBidiMaps() {
  const mir = [];
  for (let line of ucd("BidiMirroring.txt").split("\n")) {
    const h = line.indexOf("#");
    if (h >= 0) line = line.slice(0, h);
    line = line.trim();
    if (!line) continue;
    const f = line.split(";").map((s) => s.trim());
    mir.push([parseInt(f[0], 16), parseInt(f[1], 16)]);
  }
  mir.sort((a, b) => a[0] - b[0]);
  const brk = [];
  for (let line of ucd("BidiBrackets.txt").split("\n")) {
    const h = line.indexOf("#");
    if (h >= 0) line = line.slice(0, h);
    line = line.trim();
    if (!line) continue;
    const f = line.split(";").map((s) => s.trim());
    brk.push([parseInt(f[0], 16), parseInt(f[1], 16), f[2] === "o" ? 0 : 1]);
  }
  brk.sort((a, b) => a[0] - b[0]);

  const fields = {
    mirrorKeys: Uint32Array.from(mir, (x) => x[0]),
    mirrorVals: Uint32Array.from(mir, (x) => x[1]),
    bracketKeys: Uint32Array.from(brk, (x) => x[0]),
    bracketPair: Uint32Array.from(brk, (x) => x[1]),
    bracketType: Uint32Array.from(brk, (x) => x[2]),
  };
  const jsConsts = Object.entries(fields).map(([k, v]) => `const ${k.toUpperCase()} =\n  "${b64varint(v)}";`).join("\n");
  const jsObj = Object.keys(fields).map((k) => `  ${k}: varint(${k.toUpperCase()}),`).join("\n");
  writeFileSync(
    join(JS_OUT, "bidiMaps.js"),
    `${banner}
// Bidi mirroring + bracket pairs (UAX #9).
import { varint } from "../trie.js";

${jsConsts}

export const bidiMaps = Object.freeze({
${jsObj}
});
`,
  );
  const csConsts = Object.entries(fields).map(([k, v]) => `        const string ${k.toUpperCase()} =\n            "${b64varint(v)}";`).join("\n");
  const csFields = Object.keys(fields).map((k) => `        public static readonly uint[] ${cap(k)} = MantleUnicodeTrie.VarintFromBase64(${k.toUpperCase()});`).join("\n");
  writeFileSync(
    join(CS_OUT, "MantleBidiMaps.cs"),
    `${banner}
// Bidi mirroring + bracket pairs (UAX #9).
namespace Mantle.Font.Unicode
{
    public static class MantleBidiMaps
    {
${csConsts}

${csFields}
    }
}
`,
  );
  summary.push(`  bidiMaps: ${mir.length} mirror, ${brk.length} brackets`);
}
console.log(`Generated ${TABLES.length} tables + NFC + sentinels (Unicode ${UCD_VERSION}):`);
console.log(summary.join("\n"));

// Capability probes: version-sensitive inputs whose EXPECTED outputs are computed
// by our pinned-17.0 engines. The runtime runs the platform API on these; any
// mismatch/throw means the platform is behind/broken -> fall back to tables.
async function emitSentinels() {
  const { toNFCCodepoints } = await import("../../src/font/unicode/nfc.js");
  const { graphemeBoundaries } = await import("../../src/font/unicode/graphemes.js");
  // Inputs chosen to exercise features that changed in recent Unicode versions
  // (Hangul compose, canonical mark ordering, GB9c Indic conjunct, emoji ZWJ, RI).
  const NFC_IN = [
    [0x65, 0x301], [0x1100, 0x1161, 0x11a8], [0x61, 0x301, 0x323], [0x41, 0x30a], [0xac00, 0x11a8],
  ];
  const GR_IN = [
    [0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467], [0x1f1fa, 0x1f1f8], [0x915, 0x94d, 0x915],
    [0x65, 0x301], [0x1f1fa, 0x1f1f8, 0x1f1fa],
  ];
  const nfcOut = NFC_IN.map((cps) => toNFCCodepoints(cps));
  const grBounds = GR_IN.map((cps) => graphemeBoundaries(cps));

  writeFileSync(
    join(JS_OUT, "sentinels.js"),
    `${banner}
// Capability probes (see capabilities.js). Expected outputs from Unicode ${UCD_VERSION}.
export const nfcSentinels = [
${NFC_IN.map((inp, i) => `  { in: [${inp.join(",")}], out: [${nfcOut[i].join(",")}] },`).join("\n")}
];
export const graphemeSentinels = [
${GR_IN.map((inp, i) => `  { in: [${inp.join(",")}], bounds: [${grBounds[i].join(",")}] },`).join("\n")}
];
`,
  );

  const csArr = (rows) => rows.map((r) => `            new int[] {${r.join(",")}},`).join("\n");
  writeFileSync(
    join(CS_OUT, "MantleUnicodeSentinels.cs"),
    `${banner}
// Capability probes (see MantleUnicode.cs). Expected outputs from Unicode ${UCD_VERSION}.
namespace Mantle.Font.Unicode
{
    public static class MantleUnicodeSentinels
    {
        public static readonly int[][] NfcIn = {
${csArr(NFC_IN)}
        };
        public static readonly int[][] NfcOut = {
${csArr(nfcOut)}
        };
        public static readonly int[][] GraphemeIn = {
${csArr(GR_IN)}
        };
        public static readonly int[][] GraphemeBounds = {
${csArr(grBounds)}
        };
    }
}
`,
  );
}

// Encode a uint32 array as base64 [count:u32 LE][delta:u8][LEB128 varints].
// Auto-uses delta coding when the array is monotonic non-decreasing (sorted
// keys / monotonic offsets), which is both smaller and self-describing.
function b64varint(arr) {
  let mono = true;
  for (let i = 1; i < arr.length; i++) if (arr[i] < arr[i - 1]) { mono = false; break; }
  const v = encodeVarintArray(arr, mono);
  const head = new Uint8Array(5);
  new DataView(head.buffer).setUint32(0, arr.length, true);
  head[4] = mono ? 1 : 0;
  return Buffer.from(Buffer.concat([Buffer.from(head), Buffer.from(v)])).toString("base64");
}

// Serialize a case map {keys, off, data} to bytes: single-codepoint mappings as
// a zigzag delta from their key, multi-codepoint expansions separately. Decoded
// by caseMap() / CaseMapFromBase64(). See those for the layout.
function caseMapBytes({ keys, off, data }) {
  const sKeys = [], sZig = [], mKeys = [], mLens = [], mData = [];
  for (let i = 0; i < keys.length; i++) {
    const len = off[i + 1] - off[i];
    if (len === 1) {
      sKeys.push(keys[i]);
      const d = data[off[i]] - keys[i];
      sZig.push(d < 0 ? -d * 2 - 1 : d * 2);
    } else {
      mKeys.push(keys[i]);
      mLens.push(len);
      for (let j = off[i]; j < off[i + 1]; j++) mData.push(data[j]);
    }
  }
  const head = new Uint8Array(8);
  const dv = new DataView(head.buffer);
  dv.setUint32(0, sKeys.length, true);
  dv.setUint32(4, mKeys.length, true);
  const parts = [
    head,
    encodeVarintArray(sKeys, true),
    encodeVarintArray(sZig, false),
    encodeVarintArray(mKeys, true),
    encodeVarintArray(mLens, false),
    encodeVarintArray(mData, false),
  ];
  return Buffer.concat(parts.map(Buffer.from));
}
function b64caseMap(map) {
  return caseMapBytes(map).toString("base64");
}

function mapEntries({ keys, off, data }) {
  const e = [];
  for (let i = 0; i < keys.length; i++) e.push([keys[i], Array.from(data.slice(off[i], off[i + 1]))]);
  return e;
}

// Encode a case map as a delta over a base map (title over upper, fold over
// lower): most entries equal the base mapping and are stored as one bit in a
// bitmask over the base keys; the rest go into an exceptions case map. Layout:
// [baseKeyCount:u32][bitmask ceil(baseKeyCount/8)][caseMap(exceptions)].
function b64caseMapDelta(map, base) {
  const baseKeys = Array.from(base.keys);
  const baseIdx = new Map(baseKeys.map((k, i) => [k, i]));
  const baseVal = new Map(mapEntries(base));
  const bits = new Uint8Array(Math.ceil(baseKeys.length / 8));
  const excKeys = [], excOff = [0], excData = [];
  for (const [k, v] of mapEntries(map)) {
    const bv = baseVal.get(k);
    if (bv && bv.length === v.length && bv.every((x, i) => x === v[i])) {
      const bi = baseIdx.get(k);
      bits[bi >> 3] |= 1 << (bi & 7);
    } else {
      excKeys.push(k);
      for (const x of v) excData.push(x);
      excOff.push(excData.length);
    }
  }
  const head = new Uint8Array(4);
  new DataView(head.buffer).setUint32(0, baseKeys.length, true);
  const exc = caseMapBytes({ keys: Uint32Array.from(excKeys), off: Uint32Array.from(excOff), data: Uint32Array.from(excData) });
  return Buffer.concat([Buffer.from(head), Buffer.from(bits), Buffer.from(exc)]).toString("base64");
}

function emitNfc() {
  const d = buildNfcData();
  const fields = {
    decompKeys: d.decompKeys,
    decompFirst: d.decompFirst,
    decompSecondDict: d.decompSecondDict,
    decompSecondIdx: d.decompSecondIdx,
    compExcl: d.compExcl,
  };
  const bytes = Object.values(fields).reduce((n, v) => n + b64varint(v).length * 0.75, 0);
  // JS
  const jsConsts = Object.entries(fields)
    .map(([k, v]) => `const ${k.toUpperCase()} =\n  "${b64varint(v)}";`)
    .join("\n");
  const jsObj = Object.keys(fields)
    .map((k) => `  ${k}: varint(${k.toUpperCase()}),`)
    .join("\n");
  writeFileSync(
    join(JS_OUT, "nfcData.js"),
    `${banner}
// NFC canonical decomposition + composition data (UAX #15). Hangul is algorithmic.
import { varint } from "../trie.js";

${jsConsts}

export const nfcData = Object.freeze({
${jsObj}
});
`,
  );
  // C#
  const csConsts = Object.entries(fields)
    .map(([k, v]) => `        const string ${k.toUpperCase()} =\n            "${b64varint(v)}";`)
    .join("\n");
  const csFields = Object.keys(fields)
    .map((k) => `        public static readonly uint[] ${cap(k)} = MantleUnicodeTrie.VarintFromBase64(${k.toUpperCase()});`)
    .join("\n");
  writeFileSync(
    join(CS_OUT, "MantleNfcData.cs"),
    `${banner}
// NFC canonical decomposition + composition data (UAX #15). Hangul is algorithmic.
namespace Mantle.Font.Unicode
{
    public static class MantleNfcData
    {
${csConsts}

${csFields}
    }
}
`,
  );
  summary.push(`  nfc: ${(bytes / 1024).toFixed(1)}KB (${d.decompKeys.length} decomp, comp derived, ${d.compExcl.length} excl)`);
}

function cap(s) {
  return s[0].toUpperCase() + s.slice(1);
}

function emitJs(t, b64, names) {
  const enumBlock = names
    ? `\nexport const ${t.enumName} = Object.freeze({\n${names.map((n, i) => `  ${n}: ${i},`).join("\n")}\n});\n`
    : "";
  const body = `${banner}
// ${t.desc}
import { loadTrie } from "../trie.js";

const B64 =
  "${b64}";

/** Codepoint -> ${t.enumName || "value"} trie. */
export const ${t.name} = loadTrie(B64);
${enumBlock}`;
  writeFileSync(join(JS_OUT, `${t.name}.js`), body);
}

function emitCs(t, b64, names) {
  const enumBlock = names
    ? `\n        public enum ${t.enumName} : byte\n        {\n${names.map((n, i) => `            ${n} = ${i},`).join("\n")}\n        }\n`
    : "";
  const body = `${banner}
// ${t.desc}
namespace Mantle.Font.Unicode
{
    public static class Mantle${t.pascal}Table
    {
        const string B64 =
            "${b64}";

        public static readonly MantleUnicodeTrie Trie = MantleUnicodeTrie.FromBase64(B64);
${enumBlock}    }
}
`;
  writeFileSync(join(CS_OUT, `Mantle${t.pascal}Table.cs`), body);
}
