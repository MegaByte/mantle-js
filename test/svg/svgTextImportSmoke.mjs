// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// svgTextImportSmoke -- SVG <text> import: font-family lists and font-size resolution, letter/word-spacing,
// direction, font-variant and font-feature-settings, decoration positions, white space, position
// lists / rotate / textLength / baseline shifts, textPath and vertical text-anchor.
//
// GL-free. Geometry is compared RELATIVE to a control import of the same text where the control is the plain case, and
// to the font's own tables where the claim is a table value.
import fs from 'node:fs';
import { imp, wrap, painted, makeChecker, rows } from './_importSemantics.mjs';
import { MantleFontAsset, buildSvgTextGlyphs, buildStyled } from '../../src/font/index.js';
import { defaultStyle } from '../../src/font/markupParser.js';

const { ok, done } = makeChecker('SVG-TEXT-IMPORT');
const ROBOTO = new URL('../font/fixtures/roboto-regular.ttf', import.meta.url);
const roboto = new MantleFontAsset(new Uint8Array(fs.readFileSync(ROBOTO)));
roboto.getMetrics(0x41);
const STIX = '/System/Library/Fonts/Supplemental/STIXTwoText.ttf';
const ARIAL = '/System/Library/Fonts/Supplemental/Arial.ttf';

const T = (attrs, inner, body = '') =>
  `<text x="20" y="100" font-family="Roboto" font-size="40" ${attrs}>${inner}</text>${body}`;
const VB = 'viewBox="-300 -100 900 400"';
async function shapes(body, fonts = { Roboto: roboto }, extra = {}) {
  const b = await imp(wrap(body, VB), { fonts, svgTextLayout: buildSvgTextGlyphs, ...extra });
  return painted(b);
}
const bb = (r) => r.bbox;
const near = (a, b, e = 0.02) => Math.abs(a - b) <= e;
const nearAll = (xs, ys, e = 0.02) =>
  xs.length === ys.length && xs.every((v, i) => near(v, ys[i], e));
const col = (rs, i) => rs.map((r) => bb(r)[i]);
const em = (v, fs = 40) => v * fs;

// ---- font-family and font-size -------------------------------------------------------------------------
{
  const ctl = await shapes(T('', 'Hi'));
  ok(ctl.length === 2, 'T14 control draws two glyphs');
  for (const ff of [
    'Roboto, sans-serif',
    "'Roboto', serif",
    '"roboto"',
    'ROBOTO',
    'sans-serif, Roboto',
    "'Missing Font', Roboto",
    '  Roboto  ,serif',
  ]) {
    const rs = await shapes(
      T(`font-family="${ff.replace(/"/g, '&quot;')}"`, 'Hi').replace('font-family="Roboto" ', ''),
    );
    ok(
      rs.length === 2 && nearAll(col(rs, 0), col(ctl, 0), 1e-4),
      `T14 font-family list ${JSON.stringify(ff)} resolves to Roboto`,
    );
  }
  const st = await shapes(
    `<text x="20" y="100" style="font-family:Roboto,serif;font-size:40px">Hi</text>`,
  );
  ok(st.length === 2, 'T14 style font-family list resolves');
  ok(
    (await shapes(T('font-family="Nope, sans-serif"', 'Hi').replace('font-family="Roboto" ', '')))
      .length === 0,
    'T14 a list with no held family still draws nothing',
  );
  const seen = [];
  const spy = (...a) => {
    seen.push(a[5]);
    return buildSvgTextGlyphs(...a);
  };
  const other = new MantleFontAsset(new Uint8Array(fs.readFileSync(ROBOTO)));
  await imp(
    wrap(T('font-family="Main, other, Missing"', 'Hi').replace('font-family="Roboto" ', ''), VB),
    { fonts: { Main: roboto, other }, svgTextLayout: spy },
  );
  ok(
    seen.length === 1 && Array.isArray(seen[0]) && seen[0].length === 1 && seen[0][0] === other,
    'T14 later held families are passed as fallbacks',
  );
}
{
  const capH = async (inner, g = '') => {
    const rs = await shapes(`<g ${g}>${inner}</g>`);
    return rs.length ? bb(rs[0])[3] - bb(rs[0])[1] : null;
  };
  const H = (a) => `<text x="10" y="150" font-family="Roboto" ${a}>H</text>`;
  const h20 = await capH(H('font-size="20"'));
  const rel = async (label, inner, g, k) => {
    const h = await capH(inner, g);
    ok(
      h != null && near(h / h20, k, 0.01),
      `T14 ${label}: ${h && (h / h20).toFixed(3)}x (want ${k}x)`,
    );
  };
  await rel('font-size 200% of the parent', H('font-size="200%"'), 'font-size="20"', 2);
  await rel('font-size 2em of the parent', H('font-size="2em"'), 'font-size="20"', 2);
  await rel(
    'tspan font-size 150%',
    `<text x="10" y="150" font-family="Roboto" font-size="20"><tspan font-size="150%">H</tspan></text>`,
    '',
    1.5,
  );
  await rel(
    'tspan font-size 2em',
    `<text x="10" y="150" font-family="Roboto" font-size="20"><tspan font-size="2em">H</tspan></text>`,
    '',
    2,
  );
  await rel('keyword large (18) vs 20', H('font-size="large"'), '', 18 / 20);
  await rel('1.5rem', H('font-size="1.5rem"'), '', 24 / 20);
  await rel(
    'a negative size is invalid: the inherited size stands',
    H('font-size="-20"'),
    'font-size="20"',
    1,
  );
  await rel('font shorthand', `<text x="10" y="150" style="font:bold 20px Roboto">H</text>`, '', 1);
  await rel(
    'font shorthand with line-height and a list',
    `<text x="10" y="150" style="font: italic 700 20px/1.5 'Roboto', serif">H</text>`,
    '',
    1,
  );
  const n = await capH(H('font-size="0"'));
  ok(n == null, 'T14 font-size 0 draws nothing');
}

// ---- letter-spacing, word-spacing, direction, features -------------------------------------------------
{
  const base = await shapes(T('', 'HHH'));
  const dxs = (rs) => col(rs, 0).map((x, i) => +(x - col(base, 0)[i]).toFixed(3));
  ok(
    nearAll(dxs(await shapes(T('letter-spacing="10"', 'HHH'))), [0, 10, 20]),
    'T10 letter-spacing=10 adds 10 per glyph',
  );
  ok(
    nearAll(dxs(await shapes(T('letter-spacing="0.25em"', 'HHH'))), [0, 10, 20]),
    'T10 letter-spacing=0.25em of 40',
  );
  ok(
    nearAll(dxs(await shapes(T('style="letter-spacing:10px"', 'HHH'))), [0, 10, 20]),
    'T10 style letter-spacing',
  );
  ok(
    nearAll(
      dxs(await shapes(T('letter-spacing="10"', 'H<tspan font-size="20">HH</tspan>'))).slice(0, 1),
      [0],
    ),
    'T10 first glyph unmoved',
  );
  // a computed length inherits as the length: 0.25em at 40 stays 10 px inside a 20 px tspan
  const inh = await shapes(T('letter-spacing="0.25em"', '<tspan font-size="20">HH</tspan>'));
  const plain20 = await shapes(T('', '<tspan font-size="20">HH</tspan>'));
  ok(
    near(col(inh, 0)[1] - col(plain20, 0)[1], 10),
    'T10 letter-spacing inherits as the computed length',
  );
  const sp = await shapes(T('', 'H H')),
    spw = await shapes(T('word-spacing="30"', 'H H'));
  ok(near(col(spw, 0)[1] - col(sp, 0)[1], 30), 'T10 word-spacing=30 widens the gap by 30');
  const ltr = await shapes(T('', 'AB 12')),
    rtl = await shapes(T('direction="rtl"', 'AB 12'));
  ok(
    rtl.length === 4 && col(rtl, 0)[0] < col(rtl, 0)[2],
    'T10 direction=rtl reorders the runs (digits first, visually)',
  );
  ok(
    Math.max(...col(rtl, 2)) <= 20.5 && Math.max(...col(rtl, 2)) > 5,
    'T10 direction=rtl: text-anchor start is the right edge',
  );
  ok(Math.min(...col(ltr, 0)) >= 19, 'T10 ltr control starts at x');
  const ns = await shapes(T('', '111')),
    pn = await shapes(T('style="font-feature-settings:\'pnum\' 1"', '111'));
  const wNs = col(ns, 2)[2] - col(ns, 0)[0],
    wPn = col(pn, 2)[2] - col(pn, 0)[0];
  ok(
    Math.abs(wNs - wPn) > 0.5,
    `T10 font-feature-settings reaches the layout (tabular ${wNs.toFixed(2)} vs pnum ${wPn.toFixed(2)})`,
  );
  if (fs.existsSync(STIX)) {
    const stix = new MantleFontAsset(new Uint8Array(fs.readFileSync(STIX)));
    const f = { Roboto: stix };
    const a = await shapes(T('', 'hello'), f),
      b = await shapes(T('font-variant="small-caps"', 'hello'), f),
      c = await shapes(T('style="font-feature-settings:\'smcp\' 1"', 'hello'), f);
    const h = (rs) => Math.max(...rs.map((r) => bb(r)[3])) - Math.min(...rs.map((r) => bb(r)[1]));
    ok(
      h(b) < h(a) - 1 && h(c) < h(a) - 1,
      `T10 font-variant small-caps and smcp substitute (${h(a).toFixed(1)} -> ${h(b).toFixed(1)}, ${h(c).toFixed(1)})`,
    );
  }
}

// ---- decoration positions ------------------------------------------------------------------------------
{
  const fsz = 100,
    base = 150;
  const deco = async (d) => {
    const rs = await shapes(
      `<text x="10" y="${base}" font-family="Roboto" font-size="${fsz}" text-decoration="${d}">H</text>`,
    );
    return bb(rs[rs.length - 1]);
  };
  roboto.getMetrics(0x20);
  const u = await deco('underline'),
    o = await deco('overline'),
    s = await deco('line-through');
  ok(
    near(u[1], base - roboto.underlinePosition * fsz, 0.05) &&
      near(u[3] - u[1], roboto.underlineThickness * fsz, 0.05),
    `T12 underline top at the post position, below the baseline (${((u[1] - base) / fsz).toFixed(3)} em)`,
  );
  ok(
    near(o[1], base - roboto.ascent * fsz, 0.05),
    `T12 overline top at the ascent (${((base - o[1]) / fsz).toFixed(3)} em)`,
  );
  ok(
    roboto.strikeoutSize > 0 &&
      near(s[1], base - roboto.strikeoutPosition * fsz, 0.05) &&
      near(s[3] - s[1], roboto.strikeoutSize * fsz, 0.05),
    `T12 line-through from OS/2 (${roboto.strikeoutPosition} em, ${roboto.strikeoutSize} em)`,
  );
  // the bundle path
  const D = defaultStyle();
  const bs = await buildStyled([{ text: 'H', style: { ...D, strikethrough: true } }], roboto, {});
  const mf = bs.metaFloats,
    st = bs.metaFloatsPerShape,
    o2 = (bs.numShapes - 1) * st;
  ok(
    near(mf[o2 + 1], -roboto.strikeoutPosition, 1e-3) &&
      near(mf[o2 + 3] - mf[o2 + 1], roboto.strikeoutSize, 1e-3),
    'T12 bundle strikethrough uses the OS/2 position and size',
  );
  // a font object with no strikeout fields keeps the default placement
  ok(
    roboto.superscriptOffset > 0 && roboto.subscriptOffset > 0,
    'T12 the font reads OS/2 sub/superscript offsets',
  );
}

// ---- white space ---------------------------------------------------------------------------------------
{
  const eq = async (label, a, b, attrs = '') => {
    const x = await shapes(T(attrs, a)),
      y = await shapes(T(attrs, b));
    ok(
      x.length === y.length &&
        nearAll(col(x, 0), col(y, 0), 1e-4) &&
        nearAll(col(x, 1), col(y, 1), 1e-4),
      label,
    );
  };
  await eq('T13 leading and trailing spaces are stripped', '   hi   ', 'hi');
  await eq('T13 trailing space does not move text-anchor=end', 'hi ', 'hi', 'text-anchor="end"');
  await eq(
    'T13 a space across a tspan boundary collapses',
    'a <tspan> b</tspan>',
    'a <tspan>b</tspan>',
  );
  await eq('T13 a newline is a space', 'a\nb', 'a b');
  await eq('T13 tabs and runs collapse', 'a \t\n  b', 'a b');
  await eq(
    'T13 preserve: a newline is one space on the same line',
    'a\nb',
    'a b',
    'xml:space="preserve"',
  );
  const pres = await shapes(T('xml:space="preserve"', ' a  b ')),
    dflt = await shapes(T('', 'a b'));
  ok(
    pres.length === 2 &&
      col(pres, 0)[0] > col(dflt, 0)[0] + 5 &&
      col(pres, 0)[1] - col(pres, 0)[0] > col(dflt, 0)[1] - col(dflt, 0)[0] + 5,
    'T13 preserve keeps leading, trailing and doubled spaces',
  );
  const nb = await shapes(T('', 'a  b')),
    one = await shapes(T('', 'a b'));
  ok(
    col(nb, 2)[1] > col(one, 2)[1] + 5,
    'T13 no-break spaces are characters, not collapsible white space',
  );
  await eq(
    'T13 xml:space on a tspan applies to its content',
    'a<tspan xml:space="preserve">   </tspan>b',
    'a   b',
    'xml:space="preserve"',
  );
}

// ---- position lists, rotate, textLength, baseline shifts ------------------------------------------------
{
  const base = await shapes(T('', 'Hello'));
  const d = (rs, i) => rs.map((r, k) => +(bb(r)[i] - bb(base[k])[i]).toFixed(3));
  ok(
    nearAll(d(await shapes(T('dx="0 50 0 0 0"', 'Hello')), 0), [0, 50, 50, 50, 50]),
    'T11 a dx list shifts the 2nd glyph and what follows',
  );
  ok(
    nearAll(d(await shapes(T('dy="0 -30 0"', 'Hello')), 1), [0, -30, -30, -30, -30]),
    'T11 a dy list shifts the 2nd glyph and what follows',
  );
  ok(
    nearAll(d(await shapes(T('dx="30"', 'Hello')), 0), [30, 30, 30, 30, 30]) &&
      nearAll(d(await shapes(T('dy="20"', 'Hello')), 1), [20, 20, 20, 20, 20]),
    'T11 <text dx> and <text dy> move the whole text',
  );
  const xl = await shapes(
    `<text x="20 100 200" y="100" font-family="Roboto" font-size="40">Hello</text>`,
  );
  // absolute x: the 2nd glyph starts a chunk at x=100 (its origin, so its bbox follows its left bearing)
  const lsb2 = bb(base[1])[0] - (20 + (await advanceOf('H')));
  ok(near(bb(xl[1])[0], 100 + lsb2, 0.05), 'T11 an x list places the 2nd character absolutely');
  ok(
    near(bb(xl[2])[0], 200 + (bb(base[2])[0] - (20 + (await advanceOf('He')))), 0.05),
    'T11 the 3rd character too',
  );
  ok(
    near(bb(xl[3])[0] - bb(xl[2])[0], bb(base[3])[0] - bb(base[2])[0], 0.05),
    'T11 characters after the last x entry follow the pen',
  );
  const ro = await shapes(T('rotate="90"', 'HH'));
  const w0 = bb(base[0])[2] - bb(base[0])[0],
    h0 = bb(base[0])[3] - bb(base[0])[1];
  ok(
    near(bb(ro[0])[3] - bb(ro[0])[1], w0, 0.1) && near(bb(ro[0])[2] - bb(ro[0])[0], h0, 0.1),
    'T11 rotate=90 turns every glyph',
  );
  const ro1 = await shapes(T('rotate="0 90"', 'HH'));
  ok(
    near(bb(ro1[0])[2] - bb(ro1[0])[0], w0, 0.1) && near(bb(ro1[1])[2] - bb(ro1[1])[0], h0, 0.1),
    'T11 a rotate list applies per character',
  );
  // textLength
  const adv = await advanceOf('Hello');
  const tl = await shapes(T(`textLength="${adv + 60}"`, 'Hello'));
  ok(
    near(bb(tl[0])[0], bb(base[0])[0], 0.02) && near(bb(tl[4])[0] - bb(base[4])[0], 60, 0.05),
    'T11 textLength (spacing) stretches the gaps to the length',
  );
  const tg = await shapes(T(`textLength="${adv + 60}" lengthAdjust="spacingAndGlyphs"`, 'Hello'));
  const k = (adv + 60) / adv;
  ok(
    near((bb(tg[0])[2] - bb(tg[0])[0]) / w0, k, 0.01) &&
      near(bb(tg[4])[0] - 20, (bb(base[4])[0] - 20) * k, 0.1),
    'T11 textLength with spacingAndGlyphs scales glyphs and gaps',
  );
  ok(near(bb(tg[0])[3] - bb(tg[0])[1], h0, 0.02), 'T11 spacingAndGlyphs leaves the glyph height');
  // baseline shifts
  ok(
    nearAll(d(await shapes(T('baseline-shift="20"', 'Hello')), 1), [-20, -20, -20, -20, -20]),
    'T11 baseline-shift=20 raises by 20',
  );
  ok(
    nearAll(d(await shapes(T('baseline-shift="50%"', 'Hello')), 1), [-20, -20, -20, -20, -20]),
    'T11 baseline-shift=50% is of the font size',
  );
  ok(
    near(
      d(await shapes(T('baseline-shift="super"', 'Hello')), 1)[0],
      -roboto.superscriptOffset * 40,
      0.05,
    ),
    'T11 baseline-shift=super uses the OS/2 offset',
  );
  ok(
    near(
      d(await shapes(T('', 'H<tspan baseline-shift="sub">e</tspan>llo')), 1)[1],
      roboto.subscriptOffset * 40,
      0.05,
    ) && near(d(await shapes(T('', 'H<tspan baseline-shift="sub">e</tspan>llo')), 1)[2], 0, 0.05),
    'T11 a tspan baseline-shift moves only its content',
  );
  const asc = roboto.ascent,
    desc = -roboto.descent,
    xh = roboto.xHeight;
  for (const [kw, h] of [
    ['middle', xh / 2],
    ['central', (asc - desc) / 2],
    ['hanging', asc * 0.8],
    ['text-before-edge', asc],
    ['text-after-edge', -desc],
    ['mathematical', asc / 2],
  ])
    ok(
      near(d(await shapes(T(`dominant-baseline="${kw}"`, 'Hello')), 1)[0], h * 40, 0.05),
      `T11 dominant-baseline=${kw}`,
    );
}

// ---- textPath ------------------------------------------------------------------------------------------
{
  const path = `<defs><path id="p" d="M 0 100 L 400 100"/></defs>`;
  const tp = (tpAttrs, inner, textAttrs = '') =>
    `${path}<text font-family="Roboto" font-size="30" ${textAttrs}><textPath href="#p" ${tpAttrs}>${inner}</textPath></text>`;
  const ctl = await shapes(tp('', 'ABC'));
  const dx = (rs) => rs.map((r, k) => +(bb(r)[0] - bb(ctl[k])[0]).toFixed(3));
  ok(
    nearAll(dx(await shapes(tp('startOffset="50"', 'ABC'))), [50, 50, 50]),
    'T15 startOffset in user units',
  );
  ok(
    nearAll(dx(await shapes(tp('startOffset="2em"', 'ABC'))), [60, 60, 60]),
    'T15 startOffset=2em is of the font size (30)',
  );
  ok(
    nearAll(dx(await shapes(tp('startOffset="10%"', 'ABC'))), [40, 40, 40]),
    'T15 startOffset in percent of the path length',
  );
  const adv = await advanceOf('ABC', 30);
  ok(
    nearAll(dx(await shapes(tp('startOffset="200"', 'ABC', 'text-anchor="middle"'))), [
      200 - adv / 2,
      200 - adv / 2,
      200 - adv / 2,
    ]),
    'T15 text-anchor=middle centers the text on startOffset',
  );
  ok(
    nearAll(dx(await shapes(tp('startOffset="300"', 'ABC', 'text-anchor="end"'))), [
      300 - adv,
      300 - adv,
      300 - adv,
    ]),
    'T15 text-anchor=end ends the text at startOffset',
  );
  const dy = await shapes(tp('', 'A<tspan dy="-10">BC</tspan>'));
  ok(
    near(bb(dy[1])[1] - bb(ctl[1])[1], -10) && near(bb(dy[0])[1], bb(ctl[0])[1]),
    'T15 a tspan dy shifts across the path',
  );
  const fl = await shapes(tp('', 'A<tspan fill="red" font-size="60">B</tspan>C'));
  ok(
    fl[1].fill[0] === 1 && fl[1].fill[1] === 0 && fl[0].fill[0] === 0,
    'T15 a tspan fill is kept inside a textPath',
  );
  ok(
    bb(fl[1])[3] - bb(fl[1])[1] > 1.9 * (bb(ctl[1])[3] - bb(ctl[1])[1]),
    'T15 a tspan font-size is kept inside a textPath',
  );
  const tr = await shapes(
    `<defs><path id="p" d="M 0 100 L 400 100" transform="translate(0 50)"/></defs><text font-family="Roboto" font-size="30"><textPath href="#p">ABC</textPath></text>`,
  );
  ok(near(bb(tr[0])[1] - bb(ctl[0])[1], 50), "T15 the path's own transform applies");
  const rt = await shapes(tp('side="right"', 'ABC'));
  ok(
    rt.length === 3 && bb(rt[0])[0] > bb(ctl[0])[0] + 300 && bb(rt[1])[0] < bb(rt[0])[0],
    'T15 side=right runs the text along the reversed path',
  );
  ok(
    (await shapes(tp('method="stretch" spacing="exact"', 'ABC'))).length === 3,
    'T15 method and spacing are accepted (and, as in browsers, do not warp)',
  );
}

// ---- vertical text-anchor -------------------------------------------------------------------------------
{
  const V = (a) =>
    `<text x="200" y="100" font-family="Roboto" font-size="40" writing-mode="vertical-rl" ${a}>ABCDE</text>`;
  const ext = (rs) => [
    Math.min(...col(rs, 0)),
    Math.min(...col(rs, 1)),
    Math.max(...col(rs, 2)),
    Math.max(...col(rs, 3)),
  ];
  const s = ext(await shapes(V(''))),
    m = ext(await shapes(V('text-anchor="middle"'))),
    e = ext(await shapes(V('text-anchor="end"')));
  const len = s[3] - s[1];
  ok(near(m[0], s[0], 0.01) && near(e[0], s[0], 0.01), 'T9 the column keeps its x');
  ok(
    near(s[1] - m[1], (len + 0) / 2, len * 0.15) &&
      e[1] < m[1] &&
      near(s[1] - e[1], 2 * (s[1] - m[1]), 2),
    'T9 middle shifts half the column up, end the whole column',
  );
}

// advance of `text` in user units at `fs` (Roboto), from the layout adapter
async function advanceOf(text, fs = 40) {
  return buildSvgTextGlyphs(text, roboto, 0, 0, fs).advance;
}

done();
