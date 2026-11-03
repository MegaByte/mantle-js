// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// wordStartsRegistrySmoke.mjs — the word-start wrap hint is a registry seam like NFC/grapheme:
// platform Intl.Segmenter by default (the same contract as the C# platform adapters), a registered
// provider overrides it, and a host with no segmenter degrades to no hint instead of throwing.

import { readFileSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { buildStyled } from '../../src/font/textRun.js';
import { defaultStyle } from '../../src/font/markupParser.js';
import { registerUnicode, segmentWordStarts } from '../../src/font/unicode/index.js';

let failures = 0;
const fail = (m) => {
  console.error('FAIL:', m);
  failures++;
};
const ok = (m) => console.log('ok ' + m);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// 1: default = Intl.Segmenter isWordLike indices (same fixtures as csharp_tests/font-f2/WordBoundaryFixture.cs).
const cases = { 'Hello, world 123': [0, 7, 13], 'foo-bar baz_qux': [0, 4, 8], '': [], ' ,;': [] };
for (const [t, want] of Object.entries(cases)) {
  const got = segmentWordStarts(t);
  if (!eq(got, want))
    fail(
      `default starts for ${JSON.stringify(t)}: ${JSON.stringify(got)} != ${JSON.stringify(want)}`,
    );
}
ok('default word starts follow Intl.Segmenter');

// 2: no Intl.Segmenter -> null (no hint), never a throw.
{
  const saved = Intl.Segmenter;
  Intl.Segmenter = undefined;
  try {
    if (segmentWordStarts('abc def') !== null) fail('absent Intl.Segmenter must give null');
    else ok('absent Intl.Segmenter degrades to no hint');
  } finally {
    Intl.Segmenter = saved;
  }
}

// 3: a registered provider is consulted by layout, and the wrap follows its starts.
const gothic = new MantleFontAsset(
  new Uint8Array(readFileSync(new URL('../fixtures/fonts/wordBoundary.ttf', import.meta.url))),
);
gothic.getMetrics(0x41);
const build = (text, opts) => buildStyled([{ text, style: defaultStyle() }], gothic, opts || {});
const xminOf = (b, id) => {
  const stride = b.metaFloatsPerShape;
  for (let i = 0; i < b.numShapes; i++)
    if (b.shapeIds[i].includes(id)) return b.metaFloats[i * stride];
  return NaN;
};
const text = '今日は良い天気';
const hira = 'u306F';
const base = xminOf(await build(text, { maxWidthEm: 3 }), hira);
let calls = 0;
registerUnicode({
  wordStarts: (s) => {
    calls++;
    return s === text ? [0, 2, 4, 5] : [];
  },
});
const custom = xminOf(await build(text, { maxWidthEm: 3 }), hira);
// Default words 今日|は|良い|天気 keep は on line 1 (x ~2.2); starts 0,2,4,5 move the break before は (x ~0.2).
if (calls === 0) fail('registered provider never called');
else if (!(base > 2)) fail(`default は xmin ${base} should sit on line 1`);
else if (!(custom < 0.5)) fail(`provider starts [0,2,4,5] should wrap before は: xmin ${custom}`);
else ok(`registered provider drives wrapping (は xmin ${base.toFixed(2)} -> ${custom.toFixed(2)})`);

process.exit(failures ? 1 : 0);
