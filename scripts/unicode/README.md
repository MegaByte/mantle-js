# Unicode table codegen

Generates the Unicode property tables + algorithm data used by the text engine,
for **both runtimes from one pinned UCD source**, so JS and C# decode
byte-identical data (JS↔C# render parity is the core invariant).

Pinned to **Unicode 17.0.0** — `UCD_VERSION` in [`lib/ucd.mjs`](lib/ucd.mjs).

## Regenerating

```sh
node scripts/unicode/fetchUcd.mjs        # vendor the pinned UCD .txt files into .ucd-cache/ (gitignored)
node scripts/unicode/genUnicodeTables.mjs # emit tables for both runtimes
```

To move versions: bump `UCD_VERSION`, re-run both. The generated table files are
committed; `.ucd-cache/` is not.

## Outputs

- **JS:** `src/font/unicode/tables/<name>.js` (tree-shakeable ESM; decoded by
  `src/font/unicode/trie.js`).
- **C#:** `net.kontek.mantle/Runtime/Font/Unicode/Generated/Mantle<Name>Table.cs`
  (decoded by `Runtime/Font/Unicode/MantleUnicodeTrie.cs`).

Both decode the **same base64 blob**, so a lookup returns the same value on
either runtime by construction.

## Compression

Each codepoint→value table is a **three-stage block-deduplicated trie** (MUT2):
256-cp blocks with identical blocks collapsed; the stage-1 block-index array is
itself deduplicated in 32-block chunks (`top` → `chunkPool`); and block indices
are a single byte when there are ≤256 unique blocks. The whole thing is then
byte-**RLE**'d and base64-embedded. This mirrors the `lighterjson` `lighter.nfc`
approach. The 3-stage + uint8 indices typically cut an enum table by 50–90% vs a
flat two-stage trie (the stage-1 array dominates and doesn't RLE).

Variable-length data (NFC decomposition/composition, bidi mirror/bracket maps)
ships as base64 **LEB128 varints** — delta-coded automatically when the array is
monotonic (sorted keys / offsets), plain otherwise — beating raw `uint32` by
~50–75%. Two tables use specialized codecs on top:
- **case mappings** store each single-codepoint mapping as a zigzag-varint
  *delta from its key* (most are `+32`/`+1`/`0`), with the few multi-codepoint
  expansions (ß→SS) split out — ~45% smaller raw, ~72% gzipped.
- **RGI emoji sequences** store a ~130-entry code-point dictionary once and
  encode each sequence as 1-byte indices — ~57% smaller raw.

NOTE: for the **browser** bundle (shipped gzipped) the trie RLE is largely
redundant with gzip; these packings pay off most for the **C# DLL / Unity
package** (base64 strings aren't gzipped at rest) and the committed source size.

## Tables

`ccc`, `graphemeBreak`, `extPict`, `incb`, `lineBreak` (LB1-pre-resolved),
`script`, `eastAsianWidth`, `bidiClass`, `joiningType`, `indicSyllabic`,
`indicPositional`, `shaperIsc`/`shaperIpc` (Indic shaper-coarse), `verticalOrientation`,
`emojiProps`; plus `nfcData`, `caseData`, `bidiMaps` (mirror+bracket),
`emojiSequences` (RGI), and `sentinels` (capability probes).

## Validation

The algorithm engines are validated against the official UCD test files
(vendored): `NormalizationTest.txt`, `auxiliary/GraphemeBreakTest.txt`,
`auxiliary/LineBreakTest.txt`, `BidiCharacterTest.txt` — **100% on both
runtimes**. Cross-runtime equality is verified with a full-table FNV-1a hash
(JS == C#).

## `lib/`

- `ucd.mjs` — UCD parsers + `UCD_VERSION`.
- `trie.mjs` — three-stage block-dedup trie builder + RLE serializer + varint codec + reference decoder.
- `nfc.mjs` — NFC decomposition/composition builder (uses Full_Composition_Exclusion).
- `case.mjs` — upper/lower/title + case-folding builder.

## Capability layer (platform-first)

`src/font/unicode/capabilities.js` / `MantleUnicode.cs` prefer the platform API
(`Intl.Segmenter`/`String.normalize`, `StringInfo`/`string.Normalize`) and fall
back to these tables when the platform is behind the pinned version or diverges
— probed against baked `sentinels`. This also makes the C# path correct under
Unity IL2CPP invariant globalization (where the BCL calls are unreliable).
