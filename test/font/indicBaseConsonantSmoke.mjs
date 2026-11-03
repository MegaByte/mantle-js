// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// indicBaseConsonantSmoke — the Indic base consonant, and the features that
// are masked against it.
//
// Taking the LAST consonant of the syllable as the base, with no base index
// in the per-syllable dispatch, runs every basic substitution over the whole
// syllable, the first one that matches winning. The rule is to walk BACKWARD from the syllable end to the first
// consonant that has neither a below-base nor a post-base form, and the
// answer decides which glyph may take a half form and which may take a
// below-base, above-base or post-base one.
//
// Part A asks analyzeIndicSyllable for the base INDEX, which is the thing
// the rule decides — a row of glyph ids can agree for the wrong reason,
// an index cannot. It includes the case that proves the rule is
// FONT-DEPENDENT: Bengali `da + halant + X + aa` shapes three structurally
// different ways over the same codepoints of structure, because Kohinoor
// Bangla gives the ya a post-base form, the ba a below-base one and the ma
// neither. With ya or ba the base is the da; with ma it is the ma, and the
// da takes the half form the other two withhold.
//
// Part B is recorded HarfBuzz glyph ids for strings whose shaping turns on
// that index. hb-shape 14.4.0 and uharfbuzz 0.55.0 were run over every row
// and agreed on all of them; each font is recorded with its byte size, so a
// machine with a different build skips it rather than failing, because glyph
// ids belong to one build of one font.
//
// The rows were shaped with --preserve-default-ignorables. HarfBuzz hides a
// ZWJ or ZWNJ behind the font's invisible glyph by default and Mantle keeps
// the font's own glyph for it; that difference is about default-ignorable
// policy, not about shaping, and preserving them on both sides keeps it out
// of the comparison.
import { readFileSync, statSync, existsSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { layoutSlots } from '../../src/font/textLayout.js';
import { defaultStyle } from '../../src/font/markupParser.js';
import { otScriptTagsPerCodepoint } from '../../src/font/otScriptTags.js';
import {
  registerIndicShaping,
  analyzeIndicSyllable,
  consonantPositionFromFont,
  findIndicSyllables,
  viramaForScript,
  indicScriptOf,
  ConsPos,
} from '../../src/font/scripts/indic.js';
registerIndicShaping();

const SKIP_EXIT = 77;
let failures = 0;
const fail = (msg) => {
  console.error('FAIL:', msg);
  failures++;
};
const ok = (msg) => console.log('ok ' + msg);

const FONTS = {
  deva: { file: '/System/Library/Fonts/Supplemental/Devanagari Sangam MN.ttc', size: 1021020 },
  beng: { file: '/System/Library/Fonts/KohinoorBangla.ttc', size: 686728 },
  bengSangam: { file: '/System/Library/Fonts/Supplemental/Bangla Sangam MN.ttc', size: 435872 },
  sinh: { file: '/System/Library/Fonts/Supplemental/Sinhala Sangam MN.ttc', size: 752820 },
};
const _cache = new Map();
/// The recorded build or nothing: a different build of the same font has
/// different glyph ids, and a row written against one cannot judge the other.
function load(key) {
  if (!_cache.has(key)) {
    const { file, size } = FONTS[key];
    _cache.set(
      key,
      existsSync(file) && statSync(file).size === size
        ? new MantleFontAsset(new Uint8Array(readFileSync(file)))
        : null,
    );
  }
  return _cache.get(key);
}

/// Resolve one syllable the way the dispatch does: select the run's script,
/// then hand the base search the font's answers.
function analyzeFirstSyllable(font, text) {
  const cps = [...text].map((c) => c.codePointAt(0));
  const { start, end } = findIndicSyllables(cps)[0];
  const gsub = font.gsub;
  gsub.setShapingScript(otScriptTagsPerCodepoint(cps)[0], 0);
  const gids = cps.map((c) => font.codepointToGlyphId(c));
  const viramaGid = font.codepointToGlyphId(viramaForScript(indicScriptOf(cps[start])));
  const probe = (tag, glyphs) => gsub.wouldSubstitute(tag, glyphs);
  const syl = analyzeIndicSyllable(cps, start, end, {
    positionAt: (i) => consonantPositionFromFont(probe, gids[i], viramaGid),
    gidAt: (i) => gids[i],
    rphfProbe: (glyphs) => probe('rphf', glyphs),
    hasRphf: gsub.hasFeature('rphf'),
  });
  return { ...syl, cps, start, end, gids, viramaGid, probe };
}

// =====================================================================
// Part A — the base index itself.
// =====================================================================

const BASE_CASES = [
  // [fontKey, text, wantBase, wantReph, why]
  //
  // Devanagari Sangam MN gives NO consonant a 'blwf', 'pstf' or 'pref'
  // form — its rakar and its conjuncts come through 'rkrf', 'vatu' and
  // 'cjct', which are global — so every consonant in it is a base
  // candidate and the walk always stops at the last one. That is why the
  // font-dependence below is shown in Bengali, and why these rows are
  // here: they are the answer the rule gives when the font offers it
  // nothing, and it has to stay the LAST consonant rather than the first.
  [
    'deva',
    '\u0915\u094d\u0924',
    2,
    false,
    'ka halant ta: neither has a below-base or post-base form, so the walk stops at the last',
  ],
  [
    'deva',
    '\u0915\u094d\u0930',
    2,
    false,
    'ka halant ra: this font gives the ra no below-base FORM, so the ra is still the base',
  ],
  [
    'deva',
    '\u0915\u094d\u0930\u094d\u0924',
    4,
    false,
    'ka halant ra halant ta: the ta ends the walk at once',
  ],
  [
    'deva',
    '\u0930\u094d\u0915',
    2,
    true,
    'ra halant ka: a reph, so the Ra is out of the running and the ka is the base',
  ],
  [
    'deva',
    '\u0930\u094d\u0915\u093f',
    2,
    true,
    'ra halant ka i-matra: the matra is not a consonant and does not end the walk',
  ],
  // The font-dependent case. Kohinoor Bangla answers three ways for the
  // same three codepoints of structure: the ya has a post-base form, the
  // ba a below-base one, the ma neither.
  [
    'beng',
    '\u09a6\u09cd\u09af\u09be',
    0,
    false,
    'da halant ya aa: the ya has a POST-base form, so the walk passes it and takes the da',
  ],
  [
    'beng',
    '\u09a6\u09cd\u09ac\u09be',
    0,
    false,
    'da halant ba aa: the ba has a BELOW-base form, so the walk passes it too',
  ],
  [
    'beng',
    '\u09a6\u09cd\u09ae\u09be',
    2,
    false,
    'da halant ma aa: the ma has neither, so the ma is the base and the da takes a half form',
  ],
  // ...which is what makes the ZWJ rule visible: it only bites when the
  // last consonant is one the walk would otherwise pass.
  [
    'beng',
    '\u0995\u09cd\u200d\u09b0',
    3,
    false,
    'ka halant ZWJ ra: a ZWJ AFTER a halant stops the walk, so the ra stays the base',
  ],
  [
    'beng',
    '\u0995\u200d\u09cd\u09b0',
    0,
    false,
    'ka ZWJ halant ra: a ZWJ BEFORE a halant does not, so the walk reaches the ka',
  ],
  [
    'beng',
    '\u09b0\u09cd\u09af',
    2,
    true,
    'ra halant ya: a reph, and the walk cannot pass the ya because the reph limit stops it',
  ],
  // Sinhala: its own algorithm, a forward walk that asks the font nothing
  // and has its own ZWJ rule.
  [
    'sinh',
    '\u0d9a\u0dca\u0d9a',
    2,
    false,
    'ka halant ka: the forward walk takes the last consonant',
  ],
  [
    'sinh',
    '\u0d9a\u0dca\u200d\u0dbb',
    0,
    false,
    'ka halant ZWJ ra: the walk stops AT a consonant a ZWJ precedes, so the ka stays the base',
  ],
  [
    'sinh',
    '\u0dbb\u0dca\u200d\u0d9a',
    3,
    true,
    'ra halant ZWJ ka: an EXPLICIT reph, spelled with the ZWJ, and the ka is the base',
  ],
  [
    'sinh',
    '\u0dbb\u0dca\u0d9a',
    2,
    false,
    'ra halant ka: no ZWJ, so no reph in a script that spells one explicitly',
  ],
];

{
  let ran = 0;
  for (const [key, text, wantBase, wantReph, why] of BASE_CASES) {
    const font = load(key);
    if (!font) continue;
    ran++;
    const a = analyzeFirstSyllable(font, text);
    const gotBase = a.base - a.start;
    if (gotBase !== wantBase || a.hasReph !== wantReph) {
      fail(
        `A ${key} ${[...text].map((c) => 'U+' + c.codePointAt(0).toString(16)).join(' ')}: ` +
          `base ${gotBase} reph ${a.hasReph}, want base ${wantBase} reph ${wantReph} — ${why}`,
      );
    }
  }
  if (ran && !failures) ok(`A ${ran} syllables resolve to the base index the font implies`);
  if (!ran) console.log('skip A: no recorded font build present');
}

// The three-way case stated as the property rather than as three numbers:
// what separates the answers is what the font says about the one consonant
// that changes, and nothing else about the syllable does.
{
  const font = load('beng');
  if (font) {
    const post = analyzeFirstSyllable(font, '\u09a6\u09cd\u09af\u09be'); // ya
    const below = analyzeFirstSyllable(font, '\u09a6\u09cd\u09ac\u09be'); // ba
    const none = analyzeFirstSyllable(font, '\u09a6\u09cd\u09ae\u09be'); // ma
    const posOf = (a) => consonantPositionFromFont(a.probe, a.gids[2], a.viramaGid);
    const got = [posOf(post), posOf(below), posOf(none)];
    const want = [ConsPos.Post, ConsPos.Below, ConsPos.Base];
    if (got.join() !== want.join()) {
      fail(`A bengali ya/ba/ma positions [${got}], want [${want}]`);
    } else if (post.base !== 0 || below.base !== 0 || none.base !== 2) {
      fail(`A bengali bases [${post.base}, ${below.base}, ${none.base}], want [0, 0, 2]`);
    } else {
      ok('A ya/ba/ma: three font answers for one structure, and the base moves with them');
    }
  }
}

// =====================================================================
// Part B — recorded HarfBuzz glyph ids, per row.
// =====================================================================

const ROWS = [
  {
    key: 'deva',
    rows: [
      [
        '\u0915\u094d\u0930\u094d\u0924',
        [613, 151],
        'ka halant ra halant ta -- the interior ra is not a reph, and blwf reaches a pre-base consonant',
      ],
      [
        '\u0938\u094d\u0930\u094d\u0924',
        [645, 151],
        'sa halant ra halant ta -- the same, on another consonant',
      ],
      [
        '\u0915\u094d\u0930',
        [234],
        'ka halant ra -- the rakar comes through global rkrf, not through a masked blwf',
      ],
      [
        '\u0915\u094d\u200c\u0915',
        [136, 1354, 110, 136],
        'ka halant ZWNJ ka -- the ZWNJ withholds half from the ka behind it',
      ],
      [
        '\u0915\u094d\u200d\u0915',
        [238, 111, 136],
        'ka halant ZWJ ka -- a ZWJ after a halant asks for an explicit half form',
      ],
      [
        '\u0915\u200d\u094d\u0915',
        [136, 111, 190, 136],
        'ka ZWJ halant ka -- a ZWJ before a halant does not stop the search',
      ],
      [
        '\u0915\u094d\u200d\u0930',
        [238, 111, 163],
        'ka halant ZWJ ra -- the ZWJ asks for a half form and the rakar does not run',
      ],
      [
        '\u0930\u094d\u0915\u093f',
        [1292, 136, 1321],
        'ra halant ka i-matra -- reph plus a pre-base matra around the base',
      ],
    ],
  },
  {
    key: 'beng',
    rows: [
      [
        '\u09a6\u09cd\u09af\u09be',
        [49, 108, 18],
        'da halant ya aa -- the ya HAS a pstf form, so the da is the base',
      ],
      [
        '\u09a6\u09cd\u09ac\u09be',
        [372, 18],
        'da halant ba aa -- the ba has none, so the ba is the base',
      ],
      ['\u09a6\u09cd\u09ae\u09be', [259, 18], 'da halant ma aa -- the ma has none either'],
      ['\u09ac\u09bf\u09a6\u09cd\u09af\u09be', [19, 54, 49, 108, 18], 'vidya -- the named row'],
      [
        '\u0995\u200d\u09cd\u09b0',
        [32, 103, 107],
        'ka ZWJ halant ra -- the search runs on and the ra subjoins',
      ],
      [
        '\u0995\u09cd\u200d\u09b0',
        [110, 103, 58],
        'ka halant ZWJ ra -- the search stops and the ka takes a half form',
      ],
      [
        '\u0995\u09cd\u200c\u0995',
        [32, 75, 102, 32],
        'ka halant ZWNJ ka -- the ZWNJ withholds half',
      ],
      ['\u09b0\u09cd\u0995', [32, 106], 'ra halant ka -- reph'],
    ],
  },
  {
    key: 'bengSangam',
    rows: [
      [
        '\u09ac\u09bf\u09a6\u09cd\u09af\u09be',
        [168, 155, 150, 218, 167],
        'vidya on another Bengali build',
      ],
    ],
  },
  {
    key: 'sinh',
    rows: [
      [
        '\u0d9a\u0dca\u200d\u0dbb',
        [181],
        'ka halant ZWJ ra -- rakaransaya; Sinhala joins where Devanagari blocks',
      ],
      ['\u0d9a\u0dca\u200d\u0dba', [109, 290], 'ka halant ZWJ ya -- yansaya'],
      [
        '\u0dbb\u0dca\u200d\u0d9a',
        [222],
        'ra halant ZWJ ka -- repaya; the reph ligates with its base under abvs',
      ],
      ['\u0d9a\u0dca\u0d9a', [247, 109], 'ka halant ka -- no joiner, so no conjunct'],
      ['\u0dc1\u0dca\u200d\u0dbb\u0dd3', [499], 'shri'],
    ],
  },
];

let checked = 0,
  skippedRows = 0;
console.log('\nrow                                     mantle                 HarfBuzz');
for (const group of ROWS) {
  const font = load(group.key);
  if (!font) {
    skippedRows += group.rows.length;
    console.log(`skip ${group.key}: missing, or not the recorded build`);
    continue;
  }
  for (const [text, want, note] of group.rows) {
    checked++;
    const got = layoutSlots([{ text, style: defaultStyle() }], font, {}).map((s) => s.glyphId);
    const same = got.join() === want.join();
    // Per row, always: a pass rate hides the one row that went the other way.
    console.log(
      `${same ? 'same' : 'DIFF'} ${(group.key + ' ' + note).slice(0, 34).padEnd(34)} ` +
        `[${got.join('|')}]`.padEnd(22) +
        ` [${want.join('|')}]`,
    );
    if (!same)
      fail(`B ${group.key} ${note}: shaped [${got.join('|')}], HarfBuzz [${want.join('|')}]`);
  }
}

console.log();
if (!checked) {
  console.log('SKIP indicBaseConsonant: none of the recorded font builds is present');
  process.exit(SKIP_EXIT);
}
console.log(
  failures
    ? `INDIC-BASE-CONSONANT FAIL (${failures})`
    : `INDIC-BASE-CONSONANT PASS (${checked} HarfBuzz rows, ${skippedRows} skipped)`,
);
process.exit(failures ? 1 : 0);
