// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// jstfPrioritiesSmoke.mjs -- OpenType JSTF justification beyond the extender glyphs: priorities, extension and shrinkage,
// language systems, JstfMax shares, cursive joins and upright vertical lines.
//
// Two fixture fonts written by test/fixtures/fonts/genJstfFonts.py (fontTools, an independent writer; see its header for every
// glyph width and lookup). Every expected position below is plain arithmetic on those widths.
//
// jstfPriorities.ttf, text "fi ab xa" laid out at 1 em, natural width 3100 units:
//   fi 500 (ligature) | space 300 | a 500, b 500 with kern -100 | space 300 | x 600 | a 500
//   priority 0  extension: disable liga (fi becomes f+i, +200)           shrinkage: enable x -> x.narrow (-100)
//   priority 1  extension: disable the a-b kern (+100), enable a -> a.wide (+200 per a, two a)
//               shrinkage: enable -50 advance on a, b and x
//   priority 2  extension: JstfMax space +400 (up to; two spaces)        shrinkage: JstfMax space -200
//   language TRK: one priority, extension JstfMax space +100
import { readFileSync } from 'node:fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import '../../src/font/index.js';
import { registerJustificationReader } from '../../src/font/typography/justification.js';
import { defaultStyle } from '../../src/font/markupParser.js';
import { layoutSlots } from '../../src/font/textLayout.js';

registerJustificationReader();
let failures = 0;
const fail = (m) => {
  console.error('FAIL', m);
  failures++;
};
const ok = (m) => console.log('ok', m);
const load = (name) =>
  new MantleFontAsset(
    new Uint8Array(readFileSync(new URL('../fixtures/fonts/' + name, import.meta.url))),
  );
const font = load('jstfPriorities.ttf');
const cursive = load('jstfCursive.ttf');

const lay = (f, text, widthEm, extra = {}) =>
  layoutSlots([{ text, style: defaultStyle() }], f, {
    maxWidthEm: widthEm,
    align: 'justify',
    lastLineAlign: 'justify',
    ...extra,
  });
const units = (slots) => slots.map((s) => `${s.glyphId}@${Math.round(s.penX * 1000)}`).join(' ');
const end = (slots) => {
  const l = slots[slots.length - 1];
  return Math.round((l.penX + l.advance) * 1000);
};
const expectLine = (label, slots, want, width) => {
  if (units(slots) !== want || end(slots) !== width)
    fail(`${label}: got ${units(slots)} end ${end(slots)}, want ${want} end ${width}`);
  else ok(label);
};

// glyph ids: space 1, a 2, b 3, d 4, e 5, f 6, i 7, fi 8, x 9, x.narrow 10, a.wide 11, ext 12
// ---- reader
{
  const pr = font.jstf.getPriorities('latn', '');
  const trk = font.jstf.getPriorities('latn', 'TRK ');
  if (!pr || pr.length !== 3 || !trk || trk.length !== 1) fail('priority lists: default 3, TRK 1');
  else if (
    JSON.stringify(pr[0].extend.gsubDisable) !== '[0]' ||
    JSON.stringify(pr[1].extend.gposDisable) !== '[0]' ||
    JSON.stringify(pr[0].shrink.gsubEnable) !== '[1]' ||
    JSON.stringify(pr[1].extend.gsubEnable) !== '[2]' ||
    pr[2].extend.max.length !== 1 ||
    pr[2].shrink.max.length !== 1
  )
    fail('priority contents');
  else ok('reader: priorities, language system, modification lists, JstfMax');
  if (font.jstf.getPriorities('arab', '')) fail('a script without data has no priorities');
}

// ---- extension
expectLine(
  'natural width, nothing to do',
  lay(font, 'fi ab xa', 3.1),
  '8@0 1@500 2@800 3@1200 1@1700 9@2000 2@2600',
  3100,
);
expectLine(
  'priority 0: the ligature is undone',
  lay(font, 'fi ab xa', 3.3),
  '6@0 7@400 1@700 2@1000 3@1400 1@1900 9@2200 2@2800',
  3300,
);
expectLine(
  'priority 1 (priority 0 is too little): a.wide twice, kern off',
  lay(font, 'fi ab xa', 3.6),
  '8@0 1@500 11@800 3@1500 1@2000 9@2300 11@2900',
  3600,
);
// target 3450: priority 0 reaches 3300, priority 1 overshoots (3600); priority 2 gets a share 175/400 of space +400 on both spaces
expectLine(
  'priority 2: a share of JstfMax',
  lay(font, 'fi ab xa', 3.45),
  '8@0 1@500 2@975 3@1375 1@1875 9@2350 2@2950',
  3450,
);
expectLine(
  'language system TRK uses its own priority',
  lay(font, 'fi ab xa', 3.3, { language: 'TRK ' }),
  '8@0 1@500 2@900 3@1300 1@1800 9@2200 2@2800',
  3300,
);
{
  // beyond every priority: the strongest that does not overshoot, then the spaces take the rest
  const slots = lay(font, 'fi ab xa', 3.95);
  if (end(slots) !== 3950) fail('leftover slack goes to the spaces: ' + end(slots));
  else ok('slack beyond the priorities falls to word spaces');
}
// useJstf (default true): false skips the font's priorities, so the slack goes to the word spaces alone.
{
  const off = lay(font, 'fi ab xa', 3.3, { useJstf: false });
  const on = lay(font, 'fi ab xa', 3.3, { useJstf: true });
  if (end(off) !== 3300 || units(off) === units(on))
    fail('useJstf:false differs from the priorities and still fills the line: ' + units(off));
  else if (units(on) !== units(lay(font, 'fi ab xa', 3.3))) fail('useJstf:true is the default');
  else ok('useJstf: false leaves the priorities out, true is the default');
}
// ---- shrinkage (an unbreakable word, so the line cannot wrap)
expectLine(
  'shrink priority 0: x.narrow',
  lay(font, 'fiabxa', 2.4),
  '8@0 2@500 3@900 10@1400 2@1900',
  2400,
);
expectLine(
  'shrink priority 1: tightened advances',
  lay(font, 'fiabxa', 2.3),
  '8@0 2@500 3@850 9@1300 2@1850',
  2300,
);
// ---- no justify, no change
{
  const a = layoutSlots([{ text: 'fi ab xa', style: defaultStyle() }], font, {
    maxWidthEm: 3.3,
    align: 'left',
  });
  if (units(a) !== '8@0 1@500 2@800 3@1200 1@1700 9@2000 2@2600')
    fail('left alignment leaves the shaping alone');
  else ok('left alignment is untouched');
}

// ---- cursive: extenders at joins of any pair of joining types, in logical order
{
  const text = (s) => String.fromCodePoint(...s);
  const connectors = (slots) => slots.filter((s) => s.codepoint === 0x640).length;
  // beh (dual) then alef (right): the alef joins back, so a connector fits between them
  if (connectors(lay(cursive, text([0x628, 0x627]), 1.6)) !== 2)
    fail('beh then alef takes connectors');
  else ok('dual then right-joining takes connectors');
  // alef then beh: the alef does not join forward
  if (connectors(lay(cursive, text([0x627, 0x628]), 1.6)) !== 0) fail('alef then beh takes none');
  else ok('right-joining then dual takes none');
  if (connectors(lay(cursive, text([0x628, 0x628]), 1.9)) !== 2) fail('beh beh takes connectors');
  else ok('dual then dual takes connectors');
  // upright vertical line: each glyph is 1000 along the line, the connector 400 (vmtx), not its 300 horizontal advance
  const v = lay(cursive, text([0x628, 0x628]), 3, {
    writingMode: 'vertical-rl',
    textOrientation: 'upright',
    inlineVertical: 'upright',
  });
  const adv = v.filter((s) => s.codepoint === 0x640).map((s) => Math.round(s.advance * 1000));
  if (adv.length !== 2 || adv.some((a) => a !== 400))
    fail('vertical connectors use the vertical advance: ' + adv);
  else ok('vertical line: connectors take their vertical advance');
}

// Source ranges survive ligature substitutions and retain absolute UTF-16 offsets.
{
  const traced = (text, width) =>
    layoutSlots(
      [{ text, style: defaultStyle() }],
      font,
      { maxWidthEm: width, align: 'justify', lastLineAlign: 'justify' },
      true,
    );
  const terminal = traced('fi', 0.7),
    trailing = traced('ab fi', 1.9);
  const rich = layoutSlots(
    [
      { text: 'ab ', style: defaultStyle() },
      { text: 'fi', style: defaultStyle() },
    ],
    font,
    { maxWidthEm: 1.9, align: 'justify', lastLineAlign: 'justify' },
    true,
  );
  const later = (text) => {
    const slots = traced(text, 3.3);
    return slots.filter((s) => s.penY !== slots[0].penY);
  };
  const checks = {
    terminalLigatureExpanded: JSON.stringify(terminal.map((s) => s.glyphId)) === '[6,7]',
    trailingLigaturePreserved: JSON.stringify(trailing.map((s) => s.glyphId)) === '[2,3,1,6,7]',
    richSpanTerminalPreserved: JSON.stringify(rich.map((s) => s.glyphId)) === '[2,3,1,6,7]',
    multilineSourceClustersPreserved: later('ab\nfi ab xa').every((s) => s.sourceCluster >= 3),
    crlfSourceClustersPreserved: later('ab\r\nfi ab xa').every((s) => s.sourceCluster >= 4),
    markedSourceClustersPreserved: later('ab\nfi\u0301 ab xa').every((s) => s.sourceCluster >= 3),
    targetAdvance: Math.abs(trailing.at(-1).penX + trailing.at(-1).advance - 1.9) < 1e-10,
  };
  for (const [name, pass] of Object.entries(checks)) (pass ? ok : fail)(name);
}

// A later paragraph cannot determine the bidi base direction of a JSTF trial.
// Unknown numeral/Hebrew glyphs still carry their original bidi codepoints.
{
  const shape = (text) =>
    layoutSlots(
      [{ text, style: defaultStyle() }],
      font,
      { maxWidthEm: 3.3, align: 'justify', lastLineAlign: 'justify' },
      true,
    );
  const positions = (slots) =>
    slots.map((s) => [s.glyphId, s.codepoint, s.penX, s.penY, s.advance, s.sourceCluster]);
  for (const text of ['12 fi ab xa', 'fi אב']) {
    const alone = shape(text);
    const followed = shape(text + '\nאב').filter((s) => s.sourceCluster < text.length);
    const label = 'later RTL paragraph preserves prior line: ' + text;
    if (JSON.stringify(positions(alone)) !== JSON.stringify(positions(followed))) fail(label);
    else ok(label);
  }
}

console.log(failures ? `\nJSTF-PRIORITIES FAIL (${failures})` : '\nJSTF-PRIORITIES PASS');
process.exit(failures ? 1 : 0);
