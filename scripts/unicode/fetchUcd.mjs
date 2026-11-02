// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Vendor the pinned UCD file set into .ucd-cache/ (gitignored). One command:
//   node scripts/unicode/fetchUcd.mjs
// Bump UCD_VERSION in lib/ucd.mjs to move versions, then re-run + regenerate.
//
// Every URL below is version-pinned and this script REFUSES to follow redirects.
// That matters because a version under beta review has no final tree yet:
// /Public/<version>/ucd 302s to /Public/draft/ucd, whose draft .txt files are
// real UCD text of the usual size, so they sail past any payload sniffing.
// Vendoring those would generate tables from unreleased data that changes under
// us, so a redirect is a hard error naming the pin and where it was sent.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { UCD_VERSION } from './lib/ucd.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, '.ucd-cache');
mkdirSync(CACHE, { recursive: true });

const UCD = `https://www.unicode.org/Public/${UCD_VERSION}/ucd`;
const EMOJI = `${UCD}/emoji`;
// Since Unicode 17.0 the emoji data files ship per version, alongside the ucd
// tree, rather than in the standalone /Public/emoji tree (which holds 1.0-16.0
// and whose "latest" pointer moves). emoji-zwj-sequences is the RGI source for
// the emojiSequences table, so it must come from the pinned version too.
const EMOJI_SEQ = `https://www.unicode.org/Public/${UCD_VERSION}/emoji`;

// dest basename is what lib/ucd.mjs reads.
const FILES = [
  `${UCD}/UnicodeData.txt`,
  `${UCD}/DerivedNormalizationProps.txt`,
  `${UCD}/DerivedCoreProperties.txt`,
  `${UCD}/CompositionExclusions.txt`,
  `${UCD}/NormalizationTest.txt`,
  `${UCD}/BidiCharacterTest.txt`,
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
  `${EMOJI_SEQ}/emoji-zwj-sequences.txt`,
];

// One fetch with the redirect guard. minBytes is the "this is a real data file"
// floor; ReadMe.txt is legitimately small, so it passes its own.
async function get(url, minBytes = 1000) {
  const r = await fetch(url, { redirect: 'manual' });
  if (r.status >= 300 && r.status < 400) {
    const to = r.headers.get('location') || '(no Location header)';
    throw new Error(
      `${url}\n    redirected to ${to}\n    The pin names a version whose final ` +
        `tree does not exist yet: Unicode serves an unreleased version from ` +
        `/Public/draft, whose files are DRAFT and change without notice. ` +
        `UCD_VERSION is "${UCD_VERSION}" — wait for the final release (the ` +
        `version's own ucd/ReadMe.txt must say "final data files") or pin a ` +
        `released version.`,
    );
  }
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < minBytes || buf.slice(0, 64).includes(Buffer.from('<html'))) {
    throw new Error(`suspicious payload (${buf.length}B) for ${url}`);
  }
  return buf;
}

// Gate the whole run on the pin being RELEASED. The version's own ReadMe names
// it and says "final data files"; the draft tree says "draft data files" for
// the version it is staging. Checked once, before anything is written, so a
// premature bump fails before it can touch .ucd-cache/.
async function assertPinIsFinal() {
  const text = (await get(`${UCD}/ReadMe.txt`, 64)).toString('utf8').replace(/\s+/g, ' ');
  if (/draft data files/i.test(text)) {
    throw new Error(
      `${UCD}/ReadMe.txt describes DRAFT data files. The pin names a version ` +
        `whose final tree does not exist yet — do not generate tables from it.`,
    );
  }
  if (!/final data files/i.test(text) || !text.includes(UCD_VERSION)) {
    throw new Error(
      `${UCD}/ReadMe.txt does not name "${UCD_VERSION}" as final data files. ` +
        `Either the pin names a version whose final tree does not exist yet, or ` +
        `the ReadMe wording changed — verify by hand before vendoring.`,
    );
  }
}

try {
  await assertPinIsFinal();
} catch (e) {
  console.error(`REFUSING to vendor UCD ${UCD_VERSION}:\n  ${e.message}`);
  process.exit(1);
}

const res = await Promise.allSettled(
  FILES.map(async (url) => {
    const buf = await get(url);
    writeFileSync(join(CACHE, basename(url)), buf);
    return `${basename(url)} (${buf.length}B)`;
  }),
);

let ok = 0;
for (const r of res) {
  if (r.status === 'fulfilled') ok++;
  else console.error('  FAIL:', r.reason.message);
}
console.log(`UCD ${UCD_VERSION}: fetched ${ok}/${FILES.length} files into .ucd-cache/`);
if (ok !== FILES.length) process.exitCode = 1;
