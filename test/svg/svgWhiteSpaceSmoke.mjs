// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// svgWhiteSpaceSmoke -- CSS `white-space` on SVG text and the tab stops a preserved tab takes.
//
// Browsers draw SVG text on ONE line: white-space picks only whether white space is preserved (pre, pre-wrap, break-spaces) or
// collapsed (normal, nowrap, pre-line), and a preserved newline is drawn as one space. Probed against Chrome with Roboto (character
// positions of getStartPositionOfChar): `pre` / `pre-wrap` / `break-spaces` keep every space; a newline between letters is a space;
// `pre-line`, `nowrap` and `normal` collapse runs of spaces, tabs and newlines to one and strip the ends; the property inherits and a
// tspan's own value wins; an element's own value beats its xml:space.
// A preserved tab advances to the next tab stop (CSS `tab-size`, 8 spaces by default) in the default mode; compat 'chrome' draws one
// space, as Chrome does; xml:space="preserve" turns a tab into one space everywhere.
import fs from 'node:fs';
import { imp, wrap, painted, makeChecker } from './_importSemantics.mjs';
import { MantleFontAsset, buildSvgTextGlyphs } from '../../src/font/index.js';

const { ok, done } = makeChecker('SVG-WHITESPACE');
const roboto = new MantleFontAsset(
  new Uint8Array(fs.readFileSync(new URL('../font/fixtures/roboto-regular.ttf', import.meta.url))),
);
roboto.getMetrics(0x41);
const T = (attrs, inner) =>
  `<text x="20" y="100" font-family="Roboto" font-size="40" ${attrs}>${inner}</text>`;
const VB = 'viewBox="-300 -100 900 400"';
async function xs(body, extra = {}) {
  const b = await imp(wrap(body, VB), {
    fonts: { Roboto: roboto },
    svgTextLayout: buildSvgTextGlyphs,
    ...extra,
  });
  return painted(b).map((r) => +r.bbox[0].toFixed(3));
}
const same = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-3);
const eq = async (name, a, b, extra) => {
  const [A, B] = [await xs(a, extra), await xs(b, extra)];
  ok(A.length > 0 && same(A, B), name + ` (${A} vs ${B})`);
};
const ne = async (name, a, b) => {
  const [A, B] = [await xs(a), await xs(b)];
  ok(A.length > 0 && !same(A, B), name);
};
const space = buildSvgTextGlyphs(' ', roboto, 0, 0, 40).advance;

// the values: preserve vs collapse
const TXT = 'a  b\n  c';
const PRESERVE = await xs(T('xml:space="preserve"', TXT));
const COLLAPSE = await xs(T('', TXT));
ok(!same(PRESERVE, COLLAPSE), 'precondition: preserving and collapsing differ');
for (const v of ['pre', 'pre-wrap', 'break-spaces']) {
  ok(
    same(await xs(T(`style="white-space:${v}"`, TXT)), PRESERVE),
    `white-space:${v} keeps every space and turns the newline into one`,
  );
}
for (const v of ['normal', 'nowrap', 'pre-line']) {
  ok(same(await xs(T(`style="white-space:${v}"`, TXT)), COLLAPSE), `white-space:${v} collapses`);
}
await eq(
  'the newline of a preserved text is ONE space (no forced break)',
  T('style="white-space:pre"', 'a\nb'),
  T('style="white-space:pre"', 'a b'),
);
await eq(
  'white-space-collapse: preserve',
  T('style="white-space-collapse:preserve"', TXT),
  T('xml:space="preserve"', TXT),
);
await eq(
  'white-space-collapse: collapse',
  T('style="white-space-collapse:collapse"', TXT),
  T('', TXT),
);
await eq(
  'a stylesheet rule',
  `<style>.p{white-space:pre}</style>` + T('class="p"', TXT),
  T('xml:space="preserve"', TXT),
);
await eq(
  'leading and trailing spaces are kept by pre',
  T('style="white-space:pre"', '  ab  '),
  T('xml:space="preserve"', '  ab  '),
);
ok(
  (await xs(T('style="white-space:pre"', '  ab')))[0] > (await xs(T('', '  ab')))[0] + 1.5 * space,
  "pre keeps a text's leading spaces",
);

// inheritance and nesting
await eq(
  'white-space inherits from a <g>',
  `<g style="white-space:pre">${T('', TXT)}</g>`,
  T('xml:space="preserve"', TXT),
);
await eq(
  'a tspan inherits it',
  T('style="white-space:pre"', 'a<tspan>  b</tspan>'),
  T('xml:space="preserve"', 'a<tspan>  b</tspan>'),
);
await eq(
  "a tspan's own value wins (normal inside pre)",
  T('style="white-space:pre"', 'a  <tspan style="white-space:normal">b   c</tspan>  d'),
  T('xml:space="preserve"', 'a  <tspan xml:space="default">b   c</tspan>  d'),
);
await eq(
  'a preserved tspan inside collapsing text',
  T('', 'a  <tspan style="white-space:pre">b   c</tspan>  d'),
  T('', 'a  <tspan xml:space="preserve">b   c</tspan>  d'),
);
await eq(
  "an element's own white-space beats its xml:space",
  T('xml:space="preserve" style="white-space:normal"', TXT),
  T('', TXT),
);
await eq(
  '...and white-space:pre beats xml:space="default"',
  T('xml:space="default" style="white-space:pre"', TXT),
  T('xml:space="preserve"', TXT),
);
await eq('an invalid value is ignored', T('style="white-space:bogus"', TXT), T('', TXT));
await ne('pre is not the default', T('style="white-space:pre"', TXT), T('', TXT));

// tab stops
const stop = 8 * space;
const ctl = (n) => T('', `a<tspan x="${20 + n}">b</tspan>`);
await eq(
  'a preserved tab advances to the 8-space stop',
  T('style="white-space:pre"', 'a\tb'),
  ctl(stop),
);
await eq(
  'the stop is counted from the chunk start',
  T('style="white-space:pre"', 'aaaaaaa\tb'),
  T(
    '',
    `aaaaaaa<tspan x="${20 + stop * Math.ceil(buildSvgTextGlyphs('aaaaaaa', roboto, 0, 0, 40).advance / stop)}">b</tspan>`,
  ),
);
await eq('two tabs are two stops', T('style="white-space:pre"', 'a\t\tb'), ctl(2 * stop));
await eq('tab-size: 4', T('style="white-space:pre;tab-size:4"', 'a\tb'), ctl(4 * space));
await eq('tab-size as a length', T('style="white-space:pre;tab-size:60px"', 'a\tb'), ctl(60));
await eq(
  'tab-size inherits',
  `<g style="tab-size:3">${T('style="white-space:pre"', 'a\tb')}</g>`,
  ctl(3 * space * Math.ceil(buildSvgTextGlyphs('a', roboto, 0, 0, 40).advance / (3 * space))),
);
await eq(
  'a tab stop continues across a tspan',
  T('style="white-space:pre"', 'a<tspan>\t</tspan>b'),
  ctl(stop),
);
await eq(
  'xml:space="preserve" turns a tab into one space',
  T('xml:space="preserve"', 'a\tb'),
  T('xml:space="preserve"', 'a b'),
);
await eq('a tab in collapsing text is a space', T('', 'a\tb'), T('', 'a b'));
await eq(
  'compat chrome: a tab under white-space:pre is one space',
  T('style="white-space:pre"', 'a\tb'),
  T('style="white-space:pre"', 'a b'),
  { compat: 'chrome' },
);
await ne(
  '...and the default is not',
  T('style="white-space:pre"', 'a\tb'),
  T('style="white-space:pre"', 'a b'),
);

// Chrome's own positions (the `pre` cells under compat 'chrome', which draws a tab as one space; getStartPositionOfChar of the letters, Roboto at 20 px, text x = 10, read in Chrome at 8x), frozen:
// the pen of each letter, which is the painted box's left edge less the letter's left bearing.
{
  const lsb = {};
  for (const ch of 'abcdef')
    lsb[ch] = (await xs(`<text x="0" y="100" font-family="Roboto" font-size="20">${ch}</text>`))[0];
  const T20 = (attrs, inner) =>
    `<text x="10" y="100" font-family="Roboto" font-size="20" ${attrs}>${inner}</text>`;
  const pens = async (body, letters, o = {}) =>
    (await xs(body, o)).map((x, i) => x - lsb[letters[i]]);
  const CASES = [
    [
      'pre',
      T20('style="white-space:pre"', 'a  b\n  c\td'),
      'abcd',
      [10, 30.78, 56.84, 72.27],
      { compat: 'chrome' },
    ],
    [
      'pre-wrap',
      T20('style="white-space:pre-wrap"', 'a  b\n  c\td'),
      'abcd',
      [10, 30.78, 56.84, 72.27],
      { compat: 'chrome' },
    ],
    [
      'break-spaces',
      T20('style="white-space:break-spaces"', 'a  b\n  c\td'),
      'abcd',
      [10, 30.78, 56.84, 72.27],
      { compat: 'chrome' },
    ],
    [
      'xml:space=preserve',
      T20('xml:space="preserve"', 'a  b\n  c\td'),
      'abcd',
      [10, 30.78, 56.84, 72.27],
    ],
    [
      'pre-line',
      T20('style="white-space:pre-line"', 'a  b\n  c\td'),
      'abcd',
      [10, 25.83, 42, 57.42],
    ],
    ['nowrap', T20('style="white-space:nowrap"', 'a  b\n  c\td'), 'abcd', [10, 25.83, 42, 57.42]],
    ['normal', T20('style="white-space:normal"', 'a  b\n  c\td'), 'abcd', [10, 25.83, 42, 57.42]],
    ['pre with leading spaces', T20('style="white-space:pre"', '  ab  '), 'ab', [19.89, 30.78]],
    [
      'pre-line collapses the ends and the newline',
      T20('style="white-space:pre-line"', '  ab   cd  \n  ef  '),
      'abcdef',
      [10, 20.88, 37.05, 47.52, 63.75, 74.34],
    ],
    [
      'normal tspan inside pre',
      T20('style="white-space:pre"', 'a <tspan style="white-space:normal">b   c</tspan>  d'),
      'abcd',
      [10, 25.84, 42.02, 62.38],
    ],
  ];
  for (const [name, body, letters, want, o] of CASES) {
    const got = await pens(body, letters, o);
    ok(
      got.length === want.length && got.every((v, i) => Math.abs(v - want[i]) < 0.08),
      `Chrome positions: ${name} (${got.map((v) => +v.toFixed(2))} vs ${want})`,
    );
  }
}

// Small caps on a font with no smcp: Chrome synthesizes the capitals at 0.7 of the size; its pens (Roboto, 20 px, x = 10), frozen.
{
  const pens = (t, o) =>
    buildSvgTextGlyphs(t, roboto, 10, 50, 20, null, 0, o)
      .glyphs.filter((g) => g.codepoint !== 0x20)
      .map((g) => 10 + g.penX);
  const close = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 0.06);
  ok(
    close(pens('aBcd eF', { fontVariant: 'small-caps' }), [10, 19.13, 31.58, 40.69, 54.83, 62.78]),
    'Chrome positions: small caps a B c d e F',
  );
  ok(
    close(pens('ABCD EF', { fontVariant: 'small-caps' }), [10, 23.05, 35.48, 48.52, 66.58, 77.94]),
    'Chrome positions: capitals stay full size under small-caps',
  );
  ok(
    close(pens('fi ss', { fontVariant: 'small-caps' }), [10, 17.73, 26.48, 34.8]),
    'Chrome positions: small caps f i s s',
  );
  ok(
    close(pens('ab', { fontVariant: 'small-caps', letterSpacingEm: 3 / 20 }), [10, 22.13]),
    'Chrome positions: letter-spacing is not scaled with the small letters',
  );
}

done();
