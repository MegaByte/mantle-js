// Vendor the pinned UCD file set into .ucd-cache/ (gitignored). One command:
//   node scripts/unicode/fetchUcd.mjs
// Bump UCD_VERSION in lib/ucd.mjs to move versions, then re-run + regenerate.
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import { UCD_VERSION } from "./lib/ucd.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, ".ucd-cache");
mkdirSync(CACHE, { recursive: true });

const UCD = `https://www.unicode.org/Public/${UCD_VERSION}/ucd`;
const EMOJI = `https://www.unicode.org/Public/${UCD_VERSION}/ucd/emoji`;
// emoji-sequences / emoji-zwj-sequences live in the separate emoji tree, keyed
// by major.minor (e.g. 17.0), not the full ucd version.
const EMOJI_SEQ = `https://www.unicode.org/Public/emoji/${UCD_VERSION.split(".").slice(0, 2).join(".")}`;

// dest basename is what lib/ucd.mjs reads.
const FILES = [
  `${UCD}/UnicodeData.txt`,
  `${UCD}/DerivedNormalizationProps.txt`,
  `${UCD}/DerivedCoreProperties.txt`,
  `${UCD}/CompositionExclusions.txt`,
  `${UCD}/NormalizationTest.txt`,
  `${UCD}/Scripts.txt`,
  `${UCD}/ScriptExtensions.txt`,
  `${UCD}/PropertyValueAliases.txt`,
  `${UCD}/LineBreak.txt`,
  `${UCD}/EastAsianWidth.txt`,
  `${UCD}/VerticalOrientation.txt`,
  `${UCD}/ArabicShaping.txt`,
  `${UCD}/IndicSyllabicCategory.txt`,
  `${UCD}/IndicPositionalCategory.txt`,
  `${UCD}/BidiMirroring.txt`,
  `${UCD}/BidiBrackets.txt`,
  `${UCD}/SpecialCasing.txt`,
  `${UCD}/CaseFolding.txt`,
  `${UCD}/extracted/DerivedBidiClass.txt`,
  `${UCD}/auxiliary/GraphemeBreakProperty.txt`,
  `${UCD}/auxiliary/GraphemeBreakTest.txt`,
  `${UCD}/auxiliary/WordBreakProperty.txt`,
  `${UCD}/auxiliary/LineBreakTest.txt`,
  `${EMOJI}/emoji-data.txt`,
  `${EMOJI}/emoji-variation-sequences.txt`,
  // The standalone /Public/emoji tree stopped at 16.0; since Unicode 16 emoji
  // data folded into the main UCD.
];
void EMOJI_SEQ;

const res = await Promise.allSettled(
  FILES.map(async (url) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 1000 || buf.slice(0, 64).includes(Buffer.from("<html"))) {
      throw new Error(`suspicious payload (${buf.length}B) for ${url}`);
    }
    writeFileSync(join(CACHE, basename(url)), buf);
    return `${basename(url)} (${buf.length}B)`;
  }),
);

let ok = 0;
for (const r of res) {
  if (r.status === "fulfilled") ok++;
  else console.error("  FAIL:", r.reason.message);
}
console.log(`UCD ${UCD_VERSION}: fetched ${ok}/${FILES.length} files into .ucd-cache/`);
if (ok !== FILES.length) process.exitCode = 1;
