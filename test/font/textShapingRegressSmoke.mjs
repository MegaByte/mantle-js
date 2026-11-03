// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// textShapingRegressSmoke -- shaping and layout cases read against hb-shape. The fonts are built by
// test/fixtures/fonts/genShapingRegressFonts.py; each expectation below is what hb-shape prints for that file and text,
// in visual order (font glyph ids, since the fonts name their glyphs in a fixed order).
import { readFileSync } from 'node:fs';
import { MantleFontAsset, measureGlyphsFromText } from '../../src/font/index.js';
import { defaultStyle } from '../../src/font/markupParser.js';
import { _layoutSlotsForTest } from '../../src/font/textRun.js';

const load = (name) =>
  new MantleFontAsset(
    new Uint8Array(readFileSync(new URL(`../fixtures/fonts/${name}`, import.meta.url))),
  );
const layout = (font, text, opts = {}, style = {}) =>
  _layoutSlotsForTest([{ text, style: { ...defaultStyle(), ...style } }], font, opts);
const near = (a, b) => Math.abs(a - b) < 1e-6;
let failures = 0;
const check = (ok, label, detail = '') => {
  if (ok) console.log('ok', label);
  else {
    failures++;
    console.error('FAIL', label, detail);
  }
};
const ids = (slots) => slots.map((s) => s.glyphId).join(' ');

// A span with a font that takes the default-feature stage and a fallback shaped by AAT.
{
  const primary = load('shapeDefaultStage.ttf'),
    aat = load('aatPrefer.ttf');
  let threw = null,
    slots = null;
  try {
    slots = layout(primary, 'cda', { fallbacks: [aat] });
  } catch (e) {
    threw = e;
  }
  check(
    !threw,
    'an AAT-shaped font in a run does not break the default-feature stage of another',
    String(threw),
  );
  // (the third glyph is whatever the fallback's morx makes of 'a')
  check(
    slots && slots.length === 3 && ids(slots.slice(0, 2)) === '1 3' && slots[2].font === aat,
    'the span still lays out, with the calt substitution in the primary run',
    slots && ids(slots),
  );
}

// Pair kerning in right-to-left text: hb-shape [yeh=2+500|beh=1+420|beh=0+500], so the rightmost glyph stands at 920.
{
  const slots = layout(load('shapeRtlKern.ttf'), '\u0628\u0628\u064A', { compat: 'harfbuzz' });
  check(
    near(slots[0].penX, 0) && near(slots[1].penX, 0.5) && near(slots[2].penX, 0.92),
    'RTL pair kerning survives the visual reorder',
    slots.map((s) => s.penX).join(' '),
  );
  const mixed = layout(load('shapeRtlKern.ttf'), '\u0628\u064A \u0628\u064A', { maxWidthEm: 1.2 });
  check(
    near(mixed.at(-1).penX - mixed.at(-2).penX, 0.5),
    'a value against a glyph that wrapped away does not move the line',
    mixed.map((s) => s.penX).join(' '),
  );
}

// Positional forms carried by multiple and alternate substitutions, not only single ones. Glyph order: 1 beh, 2 beh.init, 3 beh.medi,
// 4 beh.fina, 5 yeh, 6 yeh.init, 7 yeh.medi, 8 yeh.fina, 9 hamza, 10 yehhamza, 11 space.
{
  const f = load('shapeArabMulti.ttf');
  const three = ids(layout(f, '\u0628\u0628\u0628'));
  check(
    three === '4 9 3 11 2',
    'init/medi/fina as multiple and alternate substitutions: hb [beh.fina|hamza|beh.medi|space|beh.init]',
    three,
  );
  const five = ids(layout(f, '\u0628\u064A\u0628\u0628\u0628'));
  check(
    five === '4 9 3 9 3 7 11 2',
    'the mask follows each input through the substitutions before it',
    five,
  );
  const clusters = _layoutSlotsForTest(
    [{ text: '\u0628\u0628\u0628', style: defaultStyle() }],
    f,
    {},
    true,
  );
  check(
    clusters.length === 5 && clusters.filter((s) => s.clusterStart).length === 3,
    'a split glyph starts no cluster of its own',
    String(clusters.length),
  );
}

// ccmp splits a dual-joining letter; the mark it leaves is not a break in the joining. hb [beh.fina|hamza|yeh.medi|beh.init].
{
  const got = ids(layout(load('shapeArabCcmp.ttf'), '\u0628\u0626\u0628'));
  check(got === '4 9 7 2', 'a decomposed letter keeps joining on both sides', got);
}

// Cursive chains (y up, per mille of an em): a exit y 100, b entry 0 exit 150, c entry 20. The RightToLeft bit makes the first glyph of a
// pair the child, so c is the root: hb [a=0@0,-230|b=1@0,-130|c=2]. Without it a is the root: hb [a=0|b=1@0,100|c=2@0,230].
{
  const ys = (name) =>
    layout(load(name), 'abc')
      .map((s) => Math.round(-s.penY * 1000))
      .join(' ');
  check(
    ys('shapeCursRtl.ttf') === '-230 -130 0',
    'cursive chain, RightToLeft: offsets add up back from the last glyph',
    ys('shapeCursRtl.ttf'),
  );
  check(
    ys('shapeCursLtr.ttf') === '0 100 230',
    'cursive chain, no RightToLeft: offsets add up from the first glyph',
    ys('shapeCursLtr.ttf'),
  );
}

// A requested feature whose lookup changes the glyph count (dlig). Glyph order: 1 a, 2 b, 3 c, 4 dl. hb --features=+dlig [dl=0|c=2].
{
  const slots = layout(load('shapeDlig.ttf'), 'abc', { features: { dlig: 1 } });
  check(ids(slots) === '4 3', 'a requested ligature feature applies', ids(slots));
  const measured = measureGlyphsFromText('abc', load('shapeDlig.ttf'), { features: { dlig: 1 } })
    .glyphs.map((g) => g.cluster)
    .join();
  check(measured === '0,2', 'its clusters follow the source', measured);
  check(ids(layout(load('shapeDlig.ttf'), 'abc')) === '1 2 3', 'off by default');
}

// A reverse chain does not apply at a glyph its lookup flag skips. Glyph order: 1 a, 2 b, 3 m, 4 m.alt, 5 a.alt. hb [m|b].
{
  const got = ids(layout(load('shapeRsubMark.ttf'), 'mb'));
  check(got === '3 2', 'reverse chain: IgnoreMarks withholds the mark', got);
  check(
    ids(layout(load('shapeRsubMark.ttf'), 'ab')) === '5 2',
    'and the rule still applies at a base',
  );
}

// CSS Text 3: a line before a forced break is a last line. Only the final wrap line of a paragraph stays unjustified with it.
{
  const f = load('jstfTwoScripts.ttf');
  const slots = layout(f, 'b d\nb d b d', { maxWidthEm: 20, align: 'justify' });
  check(
    near(slots[2].penX - slots[1].penX, slots[1].advance),
    'justify: the line before a forced break keeps its spaces',
    slots.map((s) => s.penX.toFixed(2)).join(' '),
  );
  const end = layout(f, 'b d\nb d b d', {
    maxWidthEm: 20,
    align: 'justify',
    lastLineAlign: 'right',
  });
  check(end[0].penX > 10, 'lastLineAlign governs it', String(end[0].penX));
  const wrapped = layout(f, 'b d b d b d b d', { maxWidthEm: 4, align: 'justify' });
  const line0 = wrapped.filter((s) => s.lineY === wrapped[0].lineY);
  check(
    near(line0.at(-1).penX + line0.at(-1).advance, 4),
    'a line that wrapped still justifies',
    String(line0.at(-1).penX),
  );
}

// JSTF: a directive span with no text does not trip the source map of the justification pass.
{
  const spans = [
    { directive: { hasAlign: true, align: 'justify' } },
    { text: 'a b fi x a b fi x', style: { ...defaultStyle() } },
  ];
  let threw = null;
  try {
    _layoutSlotsForTest(spans, load('jstfPriorities.ttf'), { maxWidthEm: 6, align: 'justify' });
  } catch (e) {
    threw = e;
  }
  check(!threw, 'JSTF with a directive span', String(threw));
}

// JSTF: readers cache lookups per justification trial. Priority 0 of 'latn' disables the ligature; priority 0 of 'cyrl' does not, so a
// line led by Cyrillic keeps its Latin ligature whatever line was justified before it, on this font object or a fresh one.
{
  // (wrapped, so the first line of each text is justified)
  const text = '\u0436 fi d b a fi d b a fi d b a fi',
    opts = { maxWidthEm: 6, align: 'justify' };
  const fresh = ids(layout(load('jstfTwoScripts.ttf'), text, opts));
  const used = load('jstfTwoScripts.ttf');
  layout(used, 'fi d b a fi d b a fi d b a fi d b', opts);
  const after = ids(layout(used, text, opts));
  check(
    after === fresh,
    'a JSTF trial under one script does not answer for another',
    fresh + ' / ' + after,
  );
}

// The pre-base matra stands in front of a half form (no standalone halant), behind nothing but a reph that moves on.
// Glyph order: 1 ka, 2 ta, 3 virama, 4 imatra, 5 ka.half, 6 ra, 7 ra.reph.
{
  const f = () => load('shapeDevaMatra.ttf');
  check(
    ids(layout(f(), '\u0915\u094D\u0924\u093F')) === '4 5 2',
    'i-matra ahead of the half form: hb [imatra|ka.half|ta]',
    ids(layout(f(), '\u0915\u094D\u0924\u093F')),
  );
  check(
    ids(layout(f(), '\u0930\u094D\u0915\u094D\u0924\u093F')) === '4 5 2 7',
    'and with a reph: hb [imatra|ka.half|ta|ra.reph]',
    ids(layout(f(), '\u0930\u094D\u0915\u094D\u0924\u093F')),
  );
  check(
    ids(layout(f(), '\u0924\u094D\u0915\u093F')) === '2 3 4 1',
    'after a standalone halant: hb [ta|virama|imatra|ka]',
    ids(layout(f(), '\u0924\u094D\u0915\u093F')),
  );
}

// A Kannada vowel sign that GDEF calls a mark keeps its advance (hb [ka+500|ksign+500|ka+500]), or the next letter draws over it.
{
  const slots = layout(load('shapeKnda.ttf'), '\u0C95\u0CC3\u0C95');
  check(
    slots.map((s) => s.penX).join() === '0,0.5,1',
    'an Indic mark keeps its advance',
    slots.map((s) => s.penX).join(),
  );
}

// Sara am splits once, whoever else offers to. Glyph order: 1 ko, 2 am, 3 nik, 4 aa. hb [ko|nik|aa].
{
  const got = ids(layout(load('shapeThaiAm.ttf'), '\u0E01\u0E33'));
  check(got === '1 3 4', 'a font whose ccmp splits sara am does not get a second aa', got);
}

// Shadda before its vowel, whichever way they were typed. Glyph order: 1 beh, 2 fatha, 3 shadda, 4 shaddafatha. hb [shaddafatha|beh].
{
  for (const text of ['\u0628\u064E\u0651', '\u0628\u0651\u064E']) {
    const got = ids(layout(load('shapeShadda.ttf'), text));
    check(got === '4 1', 'shadda reads first in a cluster', got);
  }
  const sources = measureGlyphsFromText('\u0628\u064E\u0651\u0628', load('shapeShadda.ttf'))
    .glyphs.map((g) => g.cluster)
    .sort()
    .join();
  check(sources === '0,0,3' || sources === '0,3', 'the clusters stay', sources);
}

// A transparent character takes no positional form, whatever the letter before it takes. Glyph order: 1 beh, 2 beh.init, 3 beh.medi,
// 4 beh.fina, 5 fatha, 6 fatha.medi. hb [4|5|3|2].
{
  const got = ids(layout(load('shapeArabMarkForm.ttf'), 'ببَب'));
  check(got === '4 5 3 2', 'medi does not reach the fatha on a medial letter', got);
}

// Right to left, a mark stacked on a mark over a base with a pair placement. Glyph order: 1 beh, 2 yeh, 3 fatha, 4 shadda.
// hb [2+500|3@120,800+0|4@120,500+0|1@-30,0+470]: both marks ride the placement of the base, whichever is visually first.
{
  const slots = layout(load('shapeRtlStack.ttf'), 'بَّي', { compat: 'harfbuzz' });
  const at = (i) => [slots[i].penX, -slots[i].penY].map((v) => Math.round(v * 1000)).join();
  check(
    ids(slots) === '2 3 4 1' && at(1) === '620,800' && at(2) === '620,500' && at(3) === '470,0',
    'an RTL mark and a mark stacked on it ride their base',
    [0, 1, 2, 3].map(at).join(' '),
  );
}

// A kern lookup that ignores marks pairs the letters on either side of one. Glyph order: 1 a, 2 b, 3 m. hb [1+400|3@-150,500+0|2+500].
{
  const slots = layout(load('shapeKernMark.ttf'), 'áb');
  check(
    ids(slots) === '1 3 2' && near(slots[2].penX, 0.4) && near(slots[1].penX, 0.25),
    'IgnoreMarks kerning reaches across the mark, and the mark stays on its base',
    slots.map((s) => s.penX).join(' '),
  );
  const off = layout(load('shapeKernMark.ttf'), 'áb', { disabledFeatures: ['kern'] });
  check(
    near(off[2].penX, 0.5),
    'and turning kerning off turns it off',
    off.map((s) => s.penX).join(' '),
  );
}

// 'dist' adjusts like 'kern', and is not kerning's to turn off. Glyph order: 1 ka, 2 pa. hb [1+423|2+500].
{
  const slots = layout(load('shapeDist.ttf'), 'ಕಪ');
  check(near(slots[1].penX, 0.423), 'dist applies', slots.map((s) => s.penX).join(' '));
  const off = layout(load('shapeDist.ttf'), 'ಕಪ', { disabledFeatures: ['kern'] });
  check(near(off[1].penX, 0.423), 'dist stays with kerning off', off.map((s) => s.penX).join(' '));
}

// SCALED_COMPONENT_OFFSET: the box starts at y 0; at half scale with an offset of (200, 100). HarfBuzz's extents and fontTools'
// getCoordinates agree: y 50 with the flag, y 100 without.
{
  const f = load('glyfScaledOffset.ttf');
  const bottom = (gid) => Math.min(...f.getGlyphSegsByGid(gid).map((q) => q.p1[1]));
  check(
    bottom(2) === 50 && bottom(3) === 100,
    'a scaled component offset goes through the matrix',
    `${bottom(2)} ${bottom(3)}`,
  );
}

// A style that leaves out sizeScale or voffsetEm: the defaults, never NaN pens; a value that is not finite: the RangeError.
{
  const font = load('shapeDefaultStage.ttf');
  const pens = (style) =>
    _layoutSlotsForTest([{ text: 'cd', style }], font, {})
      .map((s) => `${s.penX},${s.penY},${s.advance}`)
      .join(' ');
  const full = pens({ sizeScale: 1, voffsetEm: 0 });
  check(!full.includes('NaN'), 'the reference pens are numbers', full);
  check(pens({}) === full, 'an empty style reads as size 1, offset 0', pens({}));
  check(
    pens({ sizeScale: 1 }) === full && pens({ voffsetEm: 0 }) === full,
    'one field left out reads the same',
  );
  const empty = {};
  pens(empty);
  check(!('sizeScale' in empty), "the caller's style is not written to");
  for (const field of ['sizeScale', 'voffsetEm'])
    for (const bad of [NaN, Infinity, -Infinity, null, '1']) {
      let thrown = null;
      try {
        pens({ [field]: bad });
      } catch (e) {
        thrown = e;
      }
      check(thrown instanceof RangeError, `${field} ${bad} throws`, String(thrown));
    }
}

if (failures) {
  console.error(`\nTEXT-SHAPING-REGRESS FAIL (${failures})`);
  process.exit(1);
}
console.log('\nTEXT-SHAPING-REGRESS PASS');
