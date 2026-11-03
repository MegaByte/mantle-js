# Unicode table codegen

Generates the Unicode property tables + algorithm data used by the text engine, for **both runtimes
from one pinned UCD source**, so JS and C# decode byte-identical data (JS↔C# render parity is the
core invariant).

Pinned to **Unicode 18.0.0** — `UCD_VERSION` in [`lib/ucd.mjs`](lib/ucd.mjs).

## Regenerating

```sh
node scripts/unicode/fetchUcd.mjs        # vendor the pinned UCD .txt files into .ucd-cache/ (gitignored)
node scripts/unicode/genUnicodeTables.mjs # emit tables for both runtimes
```

To move versions: bump `UCD_VERSION`, re-run both — see the full procedure below. The generated
table files are committed; `.ucd-cache/` is not.

## Moving to a new Unicode version

Every source URL is derived from `UCD_VERSION`, so the whole vendored set moves with the pin. Two
things make that safe, and both are enforced by `fetchUcd`:

- **Redirects are refused.** A version under beta review has no final tree — `/Public/<version>/ucd`
  302s to `/Public/draft/ucd`. Those draft files are real UCD text of the usual size, so a
  length/HTML sniff passes them happily. Any redirect is a hard error naming the pin and the
  redirect target.
- **The pin must be final.** Before anything is written, `fetchUcd` reads
  `/Public/<version>/ucd/ReadMe.txt` and requires it to name the version and say _"final data
  files"_. The draft tree says _"draft data files"_ instead, and is rejected explicitly.

### Pre-flight

Do these by hand before bumping; `fetchUcd` re-checks them, but a failed run after a half-edited pin
is more confusing than a two-minute check:

1. `https://www.unicode.org/Public/<version>/ucd/` returns **200**, not a 302 to `/Public/draft/`.
2. `https://www.unicode.org/Public/<version>/ucd/ReadMe.txt` says **"final data files"** and names
   the version.
3. `https://www.unicode.org/Public/<version>/emoji/emoji-zwj-sequences.txt` returns 200 (the RGI
   source; published per version since Unicode 17.0).
4. The version is listed on
   [Enumerated Versions](https://www.unicode.org/versions/enumeratedversions.html).

A version page titled _"(DRAFT)"_, or a release date written `YYYY Month NN`, means it is **not**
released no matter what the `/Public/` index shows — the `<version>/` directory there can be a
redirect stub while the version is in beta.

### The bump

```sh
# 1. edit UCD_VERSION in lib/ucd.mjs (and the version named in its comment)
node scripts/unicode/fetchUcd.mjs         # refuses to run unless the pin is final
node scripts/unicode/genUnicodeTables.mjs # rewrites BOTH runtimes — see the warning
```

Hand-edited version strings — only two:

- `UCD_VERSION` in [`lib/ucd.mjs`](lib/ucd.mjs), plus the version named in the comment above it.
- "Pinned to **Unicode x.y.z**" at the top of this README.

Everything else is emitted by the codegen and must **not** be hand-edited: the
`// AUTO-GENERATED ... from Unicode <version>.` banner on all 20 JS tables, the same banner on the
C# tables, and the `sentinels` "Expected outputs from Unicode <version>" comment.

### ⚠ The codegen writes both runtimes

`genUnicodeTables.mjs` emits each table's **single base64 blob** to the JS file _and_ the C# file in
one pass. JS and C# decoding the same bytes is what makes lookups identical by construction — it is
the core parity invariant, not an implementation detail.

So a **JS-only bump breaks bit-identity**: regenerating JS while leaving the C# tables on an earlier
Unicode version silently diverges the two runtimes for every code point whose property changed. If
the JS tables must move without the C# ones, that divergence has to be tracked and closed
deliberately — the tables are not independently versionable.

C# files regenerated in the same pass, all under
`net.kontek.mantle/Runtime/Font/Unicode/Generated/`:

`MantleCccTable.cs`, `MantleGraphemeBreakTable.cs`, `MantleExtPictTable.cs`, `MantleIncbTable.cs`,
`MantleLineBreakTable.cs`, `MantleScriptTable.cs`, `MantleEastAsianWidthTable.cs`,
`MantleBidiClassTable.cs`, `MantleBidiMaps.cs`, `MantleJoiningTypeTable.cs`,
`MantleIndicSyllabicTable.cs`, `MantleIndicPositionalTable.cs`, `MantleShaperIscTable.cs`,
`MantleShaperIpcTable.cs`, `MantleVerticalOrientationTable.cs`, `MantleEmojiPropsTable.cs`,
`MantleNfcData.cs`, `MantleCaseData.cs`, `MantleEmojiSequences.cs`, `MantleUnicodeSentinels.cs`.

### Re-baselining after a bump

- **FNV-1a parity hashes.** The full-table hash over all `0x110000` lookups must match JS == C#.
  Every baked constant changes with the Unicode version, so re-baseline them **together on both
  runtimes** — a hash that moves on one side only is the bug this check exists to catch.
- **Parity harnesses** (standalone C# projects, net10.0): `utrieparity` compiles
  `MantleUnicodeTrie.cs` + the table under test and runs the vendored conformance files;
  `bidiparity` compiles `MantleUnicodeTrie` + `MantleBidiClassTable` + `MantleBidi` and runs
  `BidiCharacterTest.txt`.
- **`sentinels`.** These drive the platform-vs-table capability probe. When the pin moves ahead of
  the platform's own ICU, the probe starts routing to the tables — correct, but it changes which
  path runs in production, so confirm it rather than assuming it.
- **Conformance.** Three smokes run the official suites straight out of `.ucd-cache/`, and all three
  SKIP when it is absent: `test/font/bidiConformanceSmoke.mjs` (BidiCharacterTest, 91,707 cases),
  `test/font/nfcConformanceSmoke.mjs` (NormalizationTest, 100,855 assertions plus the
  unnamed-code-point sweep) and `test/font/breakConformanceSmoke.mjs` (GraphemeBreakTest 853 +
  LineBreakTest 19,346). A version bump is not done until all four suites read 100%. A version can
  change rules — 18.0.0 dropped GB9c's leading Consonant and changed LB12a's exception list from
  [^SP BA HY] to [^SP HY HH] — and only these suites see such a change.

## Outputs

- **JS:** `src/font/unicode/tables/<name>.js` (tree-shakeable ESM; decoded by
  `src/font/unicode/trie.js`).
- **C#:** `net.kontek.mantle/Runtime/Font/Unicode/Generated/Mantle<Name>Table.cs` (decoded by
  `Runtime/Font/Unicode/MantleUnicodeTrie.cs`).

Both decode the **same base64 blob**, so a lookup returns the same value on either runtime by
construction.

## Compression

Each codepoint→value table is a **three-stage block-deduplicated trie** (MUT2): 256-cp blocks with
identical blocks collapsed; the stage-1 block-index array is itself deduplicated in 32-block chunks
(`top` → `chunkPool`); and block indices are a single byte when there are ≤256 unique blocks. The
whole thing is then byte-**RLE**'d and base64-embedded. This mirrors the `lighterjson` `lighter.nfc`
approach. The 3-stage + uint8 indices typically cut an enum table by 50–90% vs a flat two-stage trie
(the stage-1 array dominates and doesn't RLE).

Variable-length data (NFC decomposition/composition, bidi mirror/bracket maps) ships as base64
**LEB128 varints** — delta-coded automatically when the array is monotonic (sorted keys / offsets),
plain otherwise — beating raw `uint32` by ~50–75%. Two tables use specialized codecs on top:

- **case mappings** store each single-codepoint mapping as a zigzag-varint _delta from its key_
  (most are `+32`/`+1`/`0`), with the few multi-codepoint expansions (ß→SS) split out — ~45% smaller
  raw, ~72% gzipped.
- **RGI emoji sequences** store a ~130-entry code-point dictionary once and encode each sequence as
  1-byte indices — ~57% smaller raw.

NOTE: for the **browser** bundle (shipped gzipped) the trie RLE is largely redundant with gzip;
these packings pay off most for the **C# DLL / Unity package** (base64 strings aren't gzipped at
rest) and the committed source size.

## Tables

`ccc`, `graphemeBreak`, `extPict`, `incb`, `lineBreak` (LB1-pre-resolved), `script`,
`eastAsianWidth`, `bidiClass`, `joiningType`, `indicSyllabic`, `indicPositional`,
`shaperIsc`/`shaperIpc` (Indic shaper-coarse), `verticalOrientation`, `emojiProps`; plus `nfcData`,
`caseData`, `bidiMaps` (mirror+bracket), `emojiSequences` (RGI), and `sentinels` (capability
probes).

## Validation

The algorithm engines are validated against the official UCD test files (vendored):
`NormalizationTest.txt`, `auxiliary/GraphemeBreakTest.txt`, `auxiliary/LineBreakTest.txt`,
`BidiCharacterTest.txt` — **100% on both runtimes**. Cross-runtime equality is verified with a
full-table FNV-1a hash (JS == C#).

## `lib/`

- `ucd.mjs` — UCD parsers + `UCD_VERSION`.
- `trie.mjs` — three-stage block-dedup trie builder + RLE serializer + varint codec + reference
  decoder.
- `nfc.mjs` — NFC decomposition/composition builder (uses Full_Composition_Exclusion).
- `case.mjs` — upper/lower/title + case-folding builder.

## Capability layer (platform-first)

`src/font/unicode/capabilities.js` / `MantleUnicode.cs` prefer the platform API
(`Intl.Segmenter`/`String.normalize`, `StringInfo`/`string.Normalize`) and fall back to these tables
when the platform is behind the pinned version or diverges — probed against baked `sentinels`. This
also makes the C# path correct under Unity IL2CPP invariant globalization (where the BCL calls are
unreliable).
