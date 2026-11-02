// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// textLayoutAuditSmoke.mjs \u2014 text layout contracts: NFC, wrapping, breaks, alignment, setText ordering, emoji fonts,
// vertical wrap, line height, spacing, fallback widths, corrupt outlines, input validation, tabs and small caps.
//
// CPU only. Roboto (test/font/fixtures) carries most rows; the emoji rows use Arial and Apple
// Color Emoji from /System/Library/Fonts and are noted as skipped where those are absent.
// HarfBuzz values come from test/fixtures/text-layout-hb.json, frozen by
// scripts/genTextLayoutFixture.mjs (the lane never shells out to hb-shape).

import { readFileSync, existsSync } from 'node:fs';
import { optionalAsset, fontFixture } from '../_assets.mjs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import '../../src/font/index.js'; // registers every shaper, bidi and the Unicode tables
import { defaultStyle, parseMarkup } from '../../src/font/markupParser.js';
import { measureGlyphs, buildStyled, _layoutSlotsForTest } from '../../src/font/textRun.js';
import { lineBreakActions, PROHIBITED } from '../../src/font/unicode/lineBreak.js';
import { parseTtfTables } from '../../src/font/ttfTables.js';
import { readGlyph } from '../../src/font/glyphReader.js';
import { createTextBundle } from '../../src/textBundle.js';
import { createFakeGl } from '../_fakeGl.mjs';

let failures = 0;
const fail = (msg) => {
  console.error('FAIL:', msg);
  failures++;
};
const ok = (msg) => console.log('ok ' + msg);
const check = (cond, okMsg, failMsg) => (cond ? ok(okMsg) : fail(failMsg || okMsg));
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/text-layout-hb.json', import.meta.url), 'utf8'),
);
const robotoBytes = new Uint8Array(readFileSync(fontFixture('roboto-regular.ttf')));
const roboto = new MantleFontAsset(robotoBytes);
const D = defaultStyle();

/// Slots of a plain run, grouped into lines by lineY.
function slotLines(text, font, layout = {}, style = {}) {
  const slots = _layoutSlotsForTest([{ text, style: { ...D, ...style } }], font, layout);
  const lines = [];
  let key = null;
  for (const s of slots) {
    if (s.lineY !== key) {
      lines.push([]);
      key = s.lineY;
    }
    lines[lines.length - 1].push(s);
  }
  return lines;
}
const lineText = (lines) =>
  lines.map((l) => l.map((s) => String.fromCodePoint(s.codepoint)).join(''));
const wrapped = (text, width, font = roboto, style = {}) =>
  lineText(slotLines(text, font, { maxWidthEm: width }, style));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- T1: NFC per cluster, only when the font has the composed glyph ----
{
  let bad = [];
  for (const [cpsHex, gids] of fixture.nfc) {
    const text = String.fromCodePoint(...cpsHex.split(',').map((x) => parseInt(x, 16)));
    const ours = _layoutSlotsForTest([{ text, style: D }], roboto, {}).map((s) => s.glyphId);
    if (!same(ours, gids)) bad.push(`${cpsHex} hb=${gids} ours=${ours}`);
  }
  check(
    bad.length === 0,
    `T1 ${fixture.nfc.length} NFD pairs shape to the HarfBuzz glyph ids`,
    `T1 ${bad.length} NFD pairs differ from hb-shape: ${bad.slice(0, 4).join(' ; ')}`,
  );
  // the composed glyph still wins where the font has it, and the span-level text is unchanged
  const e = _layoutSlotsForTest([{ text: 'e\u0301', style: D }], roboto, {});
  check(
    e.length === 1 && e[0].glyphId === roboto.codepointToGlyphId(0xe9),
    'T1 e + acute still composes to U+00E9',
  );
}

// ---- T2: wrapping follows UAX #14 ----
{
  check(
    same(wrapped('aaa-bbb', 2.2), ['aaa-', 'bbb']),
    'T2 breaks after a hyphen',
    'T2 hyphen: ' + JSON.stringify(wrapped('aaa-bbb', 2.2)),
  );
  check(
    same(wrapped('aaa/bbb', 2.2), ['aaa/', 'bbb']),
    'T2 breaks after a slash',
    'T2 slash: ' + JSON.stringify(wrapped('aaa/bbb', 2.2)),
  );
  check(
    same(wrapped('aaa\u200Bbbb', 1.8), ['aaa\u200B', 'bbb']),
    'T2 breaks after ZWSP',
    'T2 ZWSP: ' + JSON.stringify(wrapped('aaa\u200Bbbb', 1.8)),
  );
  check(
    same(wrapped('aaa\u00ADbbb', 1.8), ['aaa\u00AD', 'bbb']),
    'T2 breaks after a soft hyphen',
    'T2 SHY: ' + JSON.stringify(wrapped('aaa\u00ADbbb', 1.8)),
  );
  check(
    same(wrapped('aaa\u00A0bbb', 1.8), ['aaa\u00A0bbb']),
    'T2 never breaks at a no-break space',
    'T2 NBSP: ' + JSON.stringify(wrapped('aaa\u00A0bbb', 1.8)),
  );
  check(same(wrapped('aaa bbb', 1.8), ['aaa', 'bbb']), 'T2 a plain space still wraps and drops');
  // Every pair of a character pool breaks exactly where lineBreakActions allows it.
  const pool = [
    'a',
    '1',
    '-',
    '/',
    ',',
    '.',
    '!',
    '(',
    ')',
    '\u201C',
    '\u201D',
    '\u2014',
    '\u2026',
    '\u6F22',
    '\u3042',
    '\u30A1',
    '\u3095',
    '\u3005',
    '\u30FC',
    '\u3001',
    '\u3002',
    '\u300C',
    '\u300D',
    '\uFF1A',
    '\uFF08',
    '\uFF09',
    '\uFF01',
    '\u30FB',
    '\u301C',
    '\uD55C',
    '\u0E01',
    '%',
    '$',
    '\u00A0',
    '\u200B',
    '\u00AD',
    '\u2060',
    '\u2002',
    '\u05D0',
    '\u0627',
    '\u0301',
  ];
  const bad = [];
  let pairs = 0;
  for (const a of pool)
    for (const b of pool) {
      const cps = [...(a + b)].map((c) => c.codePointAt(0));
      const wants = lineBreakActions(cps)[[...a].length] !== PROHIBITED;
      const lines = slotLines(a + b, roboto, { maxWidthEm: 0.01 });
      if (lines.some((l) => l.length === 0)) continue;
      const advancesB = lines.flat().slice(-1)[0].advance;
      if (!(advancesB > 0)) continue; // a zero-width second character cannot overflow
      pairs++;
      if (lines.length > 1 !== wants)
        bad.push(
          `${a.codePointAt(0).toString(16)}|${b.codePointAt(0).toString(16)}:${wants ? 'missed' : 'spurious'}`,
        );
    }
  check(
    bad.length === 0,
    `T2 ${pairs} character pairs wrap exactly at the UAX #14 opportunities`,
    `T2 ${bad.length} of ${pairs} pairs disagree with UAX #14: ${bad.slice(0, 12).join(' ')}`,
  );
  // Linear time: 4x the text costs about 4x (a quadratic wrap would cost 16x).
  const para = (n) =>
    'lorem-ipsum dolor/sit amet, consectetur '.repeat(Math.ceil(n / 40)).slice(0, n);
  const time = (n) => {
    const t0 = performance.now();
    slotLines(para(n), roboto, { maxWidthEm: 12 });
    return performance.now() - t0;
  };
  time(2000);
  let ratio = Infinity;
  for (let i = 0; i < 3; i++) ratio = Math.min(ratio, time(80000) / Math.max(time(20000), 0.5));
  check(
    ratio < 9,
    `T2 wrapping is linear (4x text costs ${ratio.toFixed(1)}x)`,
    `T2 wrapping is superlinear: 4x text costs ${ratio.toFixed(1)}x`,
  );
}

// ---- T3: trailing breakable spaces hang or drop ----
{
  let allOk = true;
  for (let n = 1; n <= 12; n++) {
    const got = wrapped('aaaa' + ' '.repeat(n) + 'bbbb', 2.5);
    if (!same(got, ['aaaa', 'bbbb'])) {
      allOk = false;
      fail(`T3 ${n} spaces: ${JSON.stringify(got)}`);
    }
  }
  if (allOk) ok('T3 a run of 1-12 spaces at a wrap point leaves no space-only or space-led line');
  check(
    same(wrapped('aaaa   ', 2.5), ['aaaa']),
    'T3 trailing spaces past the width are dropped',
    'T3 trailing: ' + JSON.stringify(wrapped('aaaa   ', 2.5)),
  );
  check(same(wrapped('aa  bb', 9), ['aa  bb']), 'T3 interior spaces keep when nothing wraps');
  check(
    same(wrapped('(  aaaa  )', 1.0).join('').replace(/ /g, ''), '(aaaa)'),
    'T3 no glyph is lost around a space run',
  );
}

// ---- T4: CR, CRLF, LS, PS, NEL, VT and FF are zero-width hard breaks ----
{
  for (const [name, sep] of [
    ['LF', '\n'],
    ['CR', '\r'],
    ['CRLF', '\r\n'],
    ['LS', '\u2028'],
    ['PS', '\u2029'],
    ['NEL', '\u0085'],
    ['VT', '\u000B'],
    ['FF', '\u000C'],
  ]) {
    const m = measureGlyphs([{ text: 'a' + sep + 'b', style: D }], roboto, {});
    const ys = [...new Set(m.glyphs.map((g) => g.penY))];
    check(
      m.glyphs.length === 2 && m.lineCount === 2 && ys.length === 2,
      `T4 ${name} is one hard break and takes no glyph`,
      `T4 ${name}: glyphs ${m.glyphs.length}, lines ${m.lineCount}`,
    );
  }
  const b = await buildStyled([{ text: 'a\r\nb\u2028c', style: D }], roboto, {});
  check(b.numShapes === 3, 'T4 no .notdef shapes for the breaks', `T4 numShapes ${b.numShapes}`);
  const lh = measureGlyphs([{ text: 'a', style: D }], roboto, {}).lineHeight;
  const blank = measureGlyphs([{ text: 'a\r\n\r\nb', style: D }], roboto, {}).glyphs;
  check(
    near(blank[1].penY, 2 * lh, 1e-9),
    'T4 CRLF CRLF makes one blank line (CRLF is one break)',
    `T4 b at ${blank[1].penY} want ${2 * lh}`,
  );
  const split = _layoutSlotsForTest(
    [
      { text: 'a\r', style: D },
      { text: '\nb', style: D },
    ],
    roboto,
    {},
  );
  check(
    split.length === 2 && near(split[1].penY, lh, 1e-9),
    'T4 a CR and an LF in adjacent spans are one break',
  );
  // LS starts a line inside the same bidi paragraph; PS ends the paragraph.
  const ls = measureGlyphs([{ text: '\u05D0\u2028a', style: D }], roboto, {
    layoutWidthEm: 10,
  }).glyphs;
  const ps = measureGlyphs([{ text: '\u05D0\u2029a', style: D }], roboto, {
    layoutWidthEm: 10,
  }).glyphs;
  check(
    ls[1].penX > 5 && ps[1].penX < 1,
    'T4 LS keeps the paragraph direction, PS ends it',
    `T4 LS x ${ls[1].penX}, PS x ${ps[1].penX}`,
  );
}

// ---- T5: alignment direction per paragraph ----
{
  const g = measureGlyphs([{ text: '\u05D0\u05D1\u05D2\nabc\n\u05D0\u05D1', style: D }], roboto, {
    layoutWidthEm: 10,
  }).glyphs;
  const firstOf = (y) => g.filter((x) => x.penY === y)[0];
  const ys = [...new Set(g.map((x) => x.penY))];
  const hebrewRight = Math.min(...g.filter((x) => x.penY === ys[0]).map((x) => x.penX)) > 5;
  const latinLeft = near(firstOf(ys[1]).penX, 0, 1e-9);
  const hebrew2Right = Math.min(...g.filter((x) => x.penY === ys[2]).map((x) => x.penX)) > 5;
  check(
    hebrewRight && latinLeft && hebrew2Right,
    'T5 Hebrew paragraphs right-align and the Latin one stays left',
    `T5 hebrew1 right ${hebrewRight}, latin left ${latinLeft}, hebrew2 right ${hebrew2Right}`,
  );
  // wrapped lines of one RTL paragraph share its direction
  const w = measureGlyphs(
    [{ text: '\u05D0\u05D1 \u05D2\u05D3 \u05D0\u05D1 \u05D2\u05D3', style: D }],
    roboto,
    { maxWidthEm: 1.6 },
  ).glyphs;
  const right = [...new Set(w.map((x) => x.penY))].every(
    (y) => Math.max(...w.filter((x) => x.penY === y).map((x) => x.penX + x.advance)) > 1.5 - 1e-6,
  );
  check(right, 'T5 every wrapped line of an RTL paragraph is right-aligned');
}

// ---- T6: the last setText request wins ----
{
  const { gl: raw } = createFakeGl();
  const live = new Set();
  const gl = new Proxy(raw, {
    get(t, p) {
      const v = t[p];
      if (typeof v !== 'function') return v;
      if (/^create(Texture|Buffer|VertexArray|Framebuffer)$/.test(p))
        return (...a) => {
          const o = v.apply(t, a);
          live.add(o);
          return o;
        };
      if (/^delete(Texture|Buffer|VertexArray|Framebuffer)$/.test(p))
        return (o) => {
          live.delete(o);
          return v.call(t, o);
        };
      return v.bind(t);
    },
  });
  const tb = await createTextBundle(gl, { font: roboto, text: 'x' });
  const slow = tb.setText('long text '.repeat(300));
  const fast = tb.setText('ab');
  const [a, b] = await Promise.all([slow, fast]);
  check(
    tb.text === 'ab' && tb.bundle.numShapes === 2,
    'T6 setText(long) then setText("ab") leaves 2 shapes',
    `T6 text ${JSON.stringify(tb.text.slice(0, 8))} shapes ${tb.bundle.numShapes}`,
  );
  check(a === tb.bundle && b === tb.bundle, 'T6 both promises resolve to the live bundle');
  const s1 = tb.setStyle({ fill: [1, 0, 0, 1] });
  const t2 = tb.setText('abc');
  await Promise.all([s1, t2]);
  check(
    tb.bundle.numShapes === 3 && tb.text === 'abc',
    'T6 setStyle then setText: the later request wins',
  );
  const before = live.size;
  await tb.setText('abcd');
  check(
    live.size === before,
    'T6 no GL object leaks across rebuilds',
    `T6 live GL objects ${before} -> ${live.size}`,
  );
  tb.dispose();
  check(live.size === 0, 'T6 dispose frees every GL object');
}

// ---- T7: emoji sequences choose the font by cluster coverage ----
{
  const arialPath = '/System/Library/Fonts/Supplemental/Arial.ttf';
  const emojiPath = '/System/Library/Fonts/Apple Color Emoji.ttc';
  if (!optionalAsset(arialPath) || !optionalAsset(emojiPath)) {
    /* noted */
  } else {
    const arial = new MantleFontAsset(new Uint8Array(readFileSync(arialPath)));
    const emoji = new MantleFontAsset(new Uint8Array(readFileSync(emojiPath)), 0);
    for (const { cps, gids } of fixture.emoji) {
      const text = String.fromCodePoint(...cps.split(',').map((x) => parseInt(x, 16)));
      const slots = _layoutSlotsForTest([{ text, style: D }], arial, { fallbacks: [emoji] }).filter(
        (s) => !s.ignorable,
      );
      const fromEmoji = slots.length > 0 && slots.every((s) => s.font === emoji);
      check(
        fromEmoji &&
          same(
            slots.map((s) => s.glyphId),
            gids,
          ),
        `T7 ${cps} takes the emoji font and its glyph ${gids}`,
        `T7 ${cps}: fonts ${slots.map((s) => (s.font === emoji ? 'emoji' : 'arial'))} gids ${slots.map((s) => s.glyphId)} want ${gids}`,
      );
    }
    const plain = _layoutSlotsForTest([{ text: '\u00A9x\u00A9\uFE0E', style: D }], arial, {
      fallbacks: [emoji],
    }).filter((s) => !s.ignorable);
    check(
      plain.every((s) => s.font === arial),
      'T7 (c) without VS16, and with VS15, stays in the text font',
    );
  }
}

// ---- T8: vertical wrap measures vertical advances ----
{
  for (const orientation of ['upright', 'mixed', 'sideways']) {
    const m = measureGlyphs([{ text: 'ab cd ef gh ij kl mn op qr', style: D }], roboto, {
      writingMode: 'vertical-rl',
      textOrientation: orientation,
      maxWidthEm: 4,
    });
    const cols = [];
    let last = -Infinity;
    for (const g of m.glyphs) {
      if (g.penY < last - 1e-6 || cols.length === 0) cols.push([]);
      cols[cols.length - 1].push(g);
      last = g.penY;
    }
    const longest = Math.max(
      ...cols.map((c) => c[c.length - 1].penY + c[c.length - 1].advance - c[0].penY),
    );
    check(
      cols.length > 1 && longest <= 4 + 1e-6,
      `T8 ${orientation}: ${cols.length} columns, longest ${longest.toFixed(2)} em <= 4`,
      `T8 ${orientation}: longest column ${longest.toFixed(2)} em`,
    );
  }
  const noWrap = measureGlyphs([{ text: 'abc', style: D }], roboto, {
    writingMode: 'vertical-rl',
    textOrientation: 'upright',
  });
  check(
    near(noWrap.glyphs[1].penY - noWrap.glyphs[0].penY, 1, 1e-6),
    'T8 unwrapped upright text still steps by the vertical advance',
  );
}

// ---- T16: a line grows with its largest sizeScale ----
{
  const plain = measureGlyphs(parseMarkup('a\nb\nc', D), roboto, {});
  const natural = plain.lineHeight;
  const ys = (m) => [...new Set(m.glyphs.map((g) => +g.penY.toFixed(9)))];
  check(
    near(ys(plain)[1], natural, 1e-9) && near(ys(plain)[2], 2 * natural, 1e-9),
    'T16 uniform lines keep the natural step',
  );
  roboto.getMetrics(0x20);
  const aShare = (roboto.ascent + roboto.lineGap / 2) / natural,
    dShare = 1 - aShare;
  const big = ys(measureGlyphs(parseMarkup('a\n<size=200%>B</size>\nc', D), roboto, {}));
  check(
    near(big[1] - big[0], natural * (dShare + 2 * aShare), 1e-9) &&
      near(big[2] - big[1], natural * (2 * dShare + aShare), 1e-9),
    'T16 a 200% span grows the step above its line by its ascent share and below by its descent share',
    `T16 steps ${big[1] - big[0]} ${big[2] - big[1]} natural ${natural}`,
  );
  // no overlap: the big line's glyph top clears the line above's descent
  const topOfBig = big[1] - 2 * roboto.ascent;
  check(
    topOfBig >= big[0] + roboto.descent - 1e-9,
    'T16 the larger line does not overlap the one above',
  );
  const small = ys(measureGlyphs(parseMarkup('a\n<size=50%>b</size>\nc', D), roboto, {}));
  check(
    near(small[1] - small[0], natural, 1e-9),
    'T16 a smaller span does not shrink the line (the base style is the strut)',
  );
}

// ---- T17: letter-spacing and ligatures / cursive joins ----
{
  const fi = (cspaceEm) =>
    _layoutSlotsForTest([{ text: 'fi', style: { ...D, cspaceEm } }], roboto, {});
  check(fi(0).length === 1, 'T17 fi is a ligature without letter-spacing');
  const spaced = fi(0.2);
  check(
    spaced.length === 2 &&
      near(spaced[0].advance, roboto.getMetricsByGid(spaced[0].glyphId).advance + 0.2, 1e-9),
    'T17 letter-spacing breaks the fi ligature and spaces both letters',
    `T17 fi spaced: ${spaced.length} slots`,
  );
  const ar = (cspaceEm) =>
    _layoutSlotsForTest([{ text: '\u0628\u0633\u0645', style: { ...D, cspaceEm } }], roboto, {});
  const base = ar(0).map((s) => s.advance),
    withSpace = ar(0.2).map((s) => s.advance);
  const sorted = (a) => [...a].sort((x, y) => x - y);
  check(
    base.length === 3 &&
      near(
        withSpace.reduce((a, b) => a + b, 0),
        base.reduce((a, b) => a + b, 0) + 0.2,
        1e-9,
      ),
    'T17 a joined Arabic word takes letter-spacing only after its last letter',
    `T17 arabic advances ${base} -> ${withSpace}`,
  );
  const latin = _layoutSlotsForTest([{ text: 'ab', style: { ...D, cspaceEm: 0.2 } }], roboto, {});
  check(
    near(latin[0].advance, roboto.getMetricsByGid(latin[0].glyphId).advance + 0.2, 1e-9),
    'T17 Latin letters each take the spacing',
  );
}

// ---- T18: HarfBuzz fallback widths for unmapped spaces ----
{
  let allOk = true;
  for (const { cp, gid, advanceEm } of fixture.spaces) {
    const s = _layoutSlotsForTest(
      [{ text: String.fromCodePoint(parseInt(cp, 16)), style: D }],
      roboto,
      {},
    )[0];
    if (!(s.glyphId === gid && near(s.advance, advanceEm, 1e-9))) {
      allOk = false;
      fail(
        `T18 U+${cp.toUpperCase()}: glyph ${s.glyphId} advance ${s.advance} want ${gid} / ${advanceEm}`,
      );
    }
  }
  if (allOk) ok(`T18 ${fixture.spaces.length} space characters match hb-shape glyph and advance`);
}

// ---- T19: corrupt glyf / loca fail with a named error inside a bounded budget ----
{
  const tables = parseTtfTables(robotoBytes);
  // (a) a mutation: 8 bytes of loca overwritten (descending contour end points)
  {
    const bytes = robotoBytes.slice();
    const loca = tables.loca[0];
    const edits = [
      [1105, 67],
      [1302, 55],
      [1014, 131],
      [184, 203],
      [1961, 233],
      [922, 114],
      [593, 120],
      [759, 135],
    ];
    for (const [o, v] of edits) bytes[loca + o] = v;
    const font = new MantleFontAsset(bytes);
    let err = null;
    const t0 = performance.now();
    let run = null;
    try {
      run = await buildStyled(
        [{ text: 'Hag \u00C0\u00C9', style: { ...D, underline: true } }],
        font,
        {},
      );
    } catch (e) {
      err = e;
    }
    check(
      run && !err && font.malformedTables.includes('glyf') && performance.now() - t0 < 5000,
      'T19 corrupt loca draws blank glyphs quickly and reports glyf',
      `T19 corrupt loca: ${err ? err.name + ': ' + err.message : 'no error'}, malformed ${font.malformedTables}, in ${Math.round(performance.now() - t0)} ms`,
    );
  }
  // (b) a composite that lists itself 40 times: depth 16 alone would allow 40^16 reads
  {
    let best = 0,
      bestGid = 0;
    for (let cp = 0x20; cp < 0x250; cp++) {
      const gid = roboto.codepointToGlyphId(cp);
      const [, len] = tables.glyphRange(gid);
      if (len > best) {
        best = len;
        bestGid = gid;
      }
    }
    const comps = Math.min(40, Math.floor((best - 10) / 8));
    const bytes = robotoBytes.slice();
    const [off] = tables.glyphRange(bestGid);
    const dv = new DataView(bytes.buffer);
    dv.setInt16(off, -1);
    let p = off + 10;
    for (let k = 0; k < comps; k++) {
      dv.setUint16(p, k + 1 < comps ? 0x0023 : 0x0003);
      dv.setUint16(p + 2, bestGid);
      dv.setInt16(p + 4, 0);
      dv.setInt16(p + 6, 0);
      p += 8;
    }
    const font = new MantleFontAsset(bytes);
    let err = null;
    const t0 = performance.now();
    try {
      (font.codepointToGlyphId(0x41), readGlyph(font._tables, bestGid));
    } catch (e) {
      err = e;
    }
    check(
      comps >= 20 &&
        err &&
        err.name === 'GlyphOutlineError' &&
        performance.now() - t0 < 5000 &&
        font.getGlyphSegsByGid(bestGid) === null,
      `T19 a self-referencing ${comps}-component composite throws GlyphOutlineError from the reader, and draws blank through the font`,
      `T19 fan-out: comps ${comps}, ${err ? err.name + ': ' + err.message : 'no error'}, ${Math.round(performance.now() - t0)} ms`,
    );
  }
  // valid fonts are untouched: Roboto's composites (accents) read
  check(
    roboto.getGlyphSegsByGid(roboto.codepointToGlyphId(0xc9)).length > 0,
    'T19 a real composite (U+00C9) still reads',
  );
}

// ---- T20: input validation ----
{
  const run = (spans) => {
    try {
      measureGlyphs(spans, roboto, {});
      return null;
    } catch (e) {
      return e;
    }
  };
  const e1 = run([{ text: 'ab', style: { ...D, sizeScale: NaN } }]);
  const e2 = run([{ text: 'ab', style: { ...D, sizeScale: Infinity } }]);
  const e3 = run([{ text: 'ab', style: { ...D, voffsetEm: NaN } }]);
  check(
    e1 instanceof RangeError && e2 instanceof RangeError && e3 instanceof RangeError,
    'T20 non-finite sizeScale / voffsetEm throw a RangeError',
    `T20 ${e1 && e1.name} ${e2 && e2.name} ${e3 && e3.name}`,
  );
  const e4 = run([{ text: 5, style: D }]);
  const e5 = run([{ text: 'ab' }]);
  const e6 = run([null]);
  check(
    e4 instanceof TypeError &&
      /text/.test(e4.message) &&
      e5 instanceof TypeError &&
      /style/.test(e5.message) &&
      e6 instanceof TypeError,
    'T20 a numeric text, a missing style and a null span throw a TypeError that names the field',
    `T20 ${e4 && e4.message} | ${e5 && e5.message} | ${e6 && e6.message}`,
  );
  check(
    run([{ text: '', style: D }, { text: null }]) === null,
    'T20 empty and null texts stay a no-op',
  );
  const bundleErr = await buildStyled(
    [{ text: 'ab', style: { ...D, sizeScale: NaN } }],
    roboto,
    {},
  ).then(
    () => null,
    (e) => e,
  );
  check(
    bundleErr instanceof RangeError,
    'T20 buildStyled rejects instead of baking NaN into the bundle',
  );
  // a font with no hmtx: half an em per glyph, the HarfBuzz default
  const bytes = robotoBytes.slice();
  const nT = (bytes[4] << 8) | bytes[5];
  for (let i = 0; i < nT; i++) {
    const o = 12 + 16 * i;
    if (String.fromCharCode(...bytes.subarray(o, o + 4)) === 'hmtx') {
      bytes[o] = 0x5a;
      bytes[o + 1] = 0x5a;
    }
  }
  const noHmtx = new MantleFontAsset(bytes);
  const adv = measureGlyphs([{ text: 'Hi', style: D }], noHmtx, {}).glyphs.map((g) => g.advance);
  check(
    adv.length === 2 && adv.every((a) => near(a, 0.5, 1e-9)),
    'T20 a font without hmtx advances half an em per glyph (hb default)',
    'T20 no-hmtx advances ' + adv,
  );
}

// ---- T22: tab stops and synthesized small caps ----
{
  // A tab is the font's space glyph (never .notdef) advancing to the next multiple of tab-size (CSS Text 3, initial 8) spaces.
  const spaceAdv = _layoutSlotsForTest([{ text: ' ', style: D }], roboto, {})[0].advance;
  const tab = _layoutSlotsForTest([{ text: 'a\tb\t\tc', style: D }], roboto, {});
  const spaceGid = roboto.codepointToGlyphId(0x20);
  check(
    tab.length === 6 && tab[1].glyphId === spaceGid,
    'T22 a tab draws the font space, not .notdef',
  );
  const stop = 8 * spaceAdv;
  check(
    near(tab[2].penX, stop, 1e-9),
    'T22 the first tab ends at the 8-space stop',
    'got ' + tab[2].penX + ' want ' + stop,
  );
  check(
    near(tab[5].penX, 3 * stop, 1e-9) || near(tab[4].penX + tab[4].advance, 3 * stop, 1e-9),
    'T22 a second tab advances a whole stop',
    'got ' + tab.map((t) => t.penX),
  );
  const t2 = _layoutSlotsForTest([{ text: 'a\tb', style: D }], roboto, { tabSize: 4 });
  check(near(t2[2].penX, 4 * spaceAdv, 1e-9), 'T22 tabSize is a number of spaces');
  const te = _layoutSlotsForTest([{ text: 'a\tb', style: D }], roboto, { tabSizeEm: 3 });
  check(near(te[2].penX, 3, 1e-9), 'T22 tabSizeEm is a length');
  const ls = _layoutSlotsForTest([{ text: 'a\tb', style: { ...D, cspaceEm: 0.1 } }], roboto, {});
  const spaceLs = _layoutSlotsForTest(
    [{ text: ' ', style: { ...D, cspaceEm: 0.1 } }],
    roboto,
    {},
  )[0].advance;
  check(
    near(ls[2].penX, 8 * spaceLs, 1e-9),
    'T22 the stop is measured with the letter-spacing the space carries',
  );
  // Small caps: a font without smcp / c2sc gets the capital at 0.7 of the size (every browser's synthesis); a font with the feature uses it.
  check(roboto.gsub && !roboto.gsub.hasSmallCaps, 'T22 (precondition) Roboto has no smcp / c2sc');
  const lower = _layoutSlotsForTest(
    [{ text: 'abc', style: { ...D, smallCaps: true } }],
    roboto,
    {},
  );
  const upperFull = _layoutSlotsForTest([{ text: 'ABC', style: D }], roboto, {});
  check(
    lower.map((s) => s.glyphId).join() === upperFull.map((s) => s.glyphId).join(),
    'T22 synthesized small caps use the capital glyphs',
  );
  check(
    near(lower[0].advance, 0.7 * upperFull[0].advance, 1e-9) &&
      near(lower[1].penX, 0.7 * upperFull[1].penX, 1e-9),
    'T22 ...at 0.7 of the size',
  );
  const mixed = _layoutSlotsForTest([{ text: 'aB', style: { ...D, smallCaps: true } }], roboto, {});
  const bFull = _layoutSlotsForTest([{ text: 'B', style: D }], roboto, {})[0];
  check(
    mixed.length === 2 && near(mixed[1].advance, bFull.advance, 1e-9),
    'T22 a capital stays at full size',
  );
  const lsSc = _layoutSlotsForTest(
    [{ text: 'ab', style: { ...D, smallCaps: true, cspaceEm: 0.15 } }],
    roboto,
    {},
  );
  const capA = _layoutSlotsForTest([{ text: 'A', style: D }], roboto, {})[0].advance;
  check(
    near(lsSc[1].penX, 0.7 * capA + 0.15, 1e-9),
    'T22 letter-spacing stays a length of the whole text (not scaled with the small letters)',
    'got ' + lsSc[1].penX,
  );
  const off = _layoutSlotsForTest([{ text: 'abc', style: D }], roboto, {});
  check(
    off.map((s) => s.glyphId).join() !== lower.map((s) => s.glyphId).join(),
    'T22 the default is unchanged',
  );
}

if (failures) {
  console.error(`\nTEXT-LAYOUT-AUDIT FAIL (${failures})`);
  process.exit(1);
}
console.log('\nTEXT-LAYOUT-AUDIT PASS');
