// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Verifies <b>/<i>/<em>/<strong> coverage.
// Two layers exercised:
//   • Markup parser pushes Bold/Italic flags on the right spans.
//   • Layout uses layout.boldFont / italicFont / boldItalicFont
//     to swap the span's primary font.
//
// Uses two real font files (Arial + Arial Italic from /System/Library/Fonts/Supplemental).

import { readFileSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { parseMarkup } from '../../src/font/markupParser.js';
import { buildFromMarkup, buildStyled } from '../../src/font/textRun.js';

let failures = 0;
const fail = (msg) => {
  console.error('FAIL:', msg);
  failures++;
};
const ok = (msg) => console.log('ok ' + msg);

const arial = new MantleFontAsset(
  new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/Arial.ttf')),
);
const arialItalic = new MantleFontAsset(
  new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/Arial Italic.ttf')),
);
const arialBold = new MantleFontAsset(
  new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/Arial Bold.ttf')),
);
const arialBoldItalic = new MantleFontAsset(
  new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/Arial Bold Italic.ttf')),
);
arial.getMetrics(0x41);
arialItalic.getMetrics(0x41);
arialBold.getMetrics(0x41);
arialBoldItalic.getMetrics(0x41);

// ---- Markup parser tests -----------------------------------------

// T1: <b> sets bold on span 1, span 0 + 2 stay plain.
{
  const spans = parseMarkup('plain <b>bold</b> back');
  if (spans.length < 3) fail(`T1 span count ${spans.length} (expected ≥3)`);
  else if (spans[0].style.bold !== false) fail(`T1 span0.bold=${spans[0].style.bold}`);
  else if (!spans.find((s) => s.text === 'bold' && s.style.bold))
    fail(`T1 'bold' span missing bold flag`);
  else if (spans[spans.length - 1].style.bold !== false) fail(`T1 last span carries bold`);
  else ok(`T1 <b> sets bold flag on its span only`);
}

// T2: <strong> behaves identically to <b>.
{
  const spans = parseMarkup('<strong>x</strong>');
  if (!spans.find((s) => s.text === 'x' && s.style.bold)) fail('T2 <strong> failed to set bold');
  else ok('T2 <strong> is equivalent to <b>');
}

// T3: <i> + <em> set italic.
{
  const i = parseMarkup('<i>a</i>').find((s) => s.text === 'a');
  const e = parseMarkup('<em>a</em>').find((s) => s.text === 'a');
  if (!i?.style.italic) fail(`T3 <i> failed to set italic`);
  else if (!e?.style.italic) fail(`T3 <em> failed to set italic`);
  else ok('T3 <i> and <em> both set italic');
}

// T4: nested <b><i>x</i></b> sets both bold + italic.
{
  const spans = parseMarkup('<b><i>x</i></b>');
  const x = spans.find((s) => s.text === 'x');
  if (!x) fail('T4 missing x span');
  else if (!x.style.bold) fail('T4 missing bold');
  else if (!x.style.italic) fail('T4 missing italic');
  else ok('T4 nested <b><i> sets both flags');
}

// T5: matching close-tag pops the stack. After </b> outer text isn't bold.
{
  const spans = parseMarkup('<b>x</b>y');
  const x = spans.find((s) => s.text === 'x');
  const y = spans.find((s) => s.text === 'y');
  if (!x?.style.bold) fail('T5 x missing bold');
  else if (y?.style.bold) fail('T5 y inherited bold');
  else ok('T5 </b> pops bold flag');
}

// T6: unmatched close-tag is passed through as literal text (TMP behavior).
{
  const spans = parseMarkup('a</b>b');
  // No <b> ever opened, so </b> should appear as literal characters
  // in some span text. Concat all span text and check.
  const all = spans.map((s) => s.text).join('');
  if (!all.includes('</b>')) fail(`T6 unmatched </b> not preserved (got "${all}")`);
  else ok('T6 unmatched </b> passes through as text');
}

// ---- Layout font-swap tests --------------------------------------

// T7: when layout.boldFont is set, <b> uses it. Verify by checking
// which font ended up resolving the glyph for that codepoint.
// (We can't introspect slots directly here, but the resulting bundle's
// curve texels will come from arialBold for the bold span and arial
// for the plain — so the glyph data differs.)
{
  const b1 = await buildStyled(
    [{ text: 'A', style: { color: [0, 0, 0, 1], sizeScale: 1 } }],
    arial,
  );
  const b2 = await buildStyled(
    [{ text: 'A', style: { color: [0, 0, 0, 1], sizeScale: 1, bold: true } }],
    arial,
    { boldFont: arialBold },
  );
  // Same letter, same size, but bold has thicker strokes ⇒ more
  // non-zero curve texels (the cubic outline includes more segs).
  // A reliable proxy: curve texel count differs.
  if (b1.curveTexels.length === b2.curveTexels.length) {
    fail(`T7 <b> with boldFont produced same curve count as plain (${b1.curveTexels.length})`);
  } else {
    ok(
      `T7 layout.boldFont swap visible: plain ${b1.curveTexels.length} curve texels, bold ${b2.curveTexels.length}`,
    );
  }
}

// T8: full <b><i> markup uses boldItalicFont when wired. Compare
// glyph extent — Arial Bold Italic is wider than Arial Italic.
{
  const plainBundle = await buildFromMarkup('A', arial, [0, 0, 0, 1]);
  const boldItalicBundle = await buildFromMarkup('<b><i>A</i></b>', arial, [0, 0, 0, 1], {
    boldFont: arialBold,
    italicFont: arialItalic,
    boldItalicFont: arialBoldItalic,
  });
  // Bbox widths should differ.
  const wPlain = plainBundle.globalBBox[2];
  const wBI = boldItalicBundle.globalBBox[2];
  if (Math.abs(wPlain - wBI) < 0.01) {
    fail(`T8 bold-italic same width as plain (${wPlain.toFixed(3)} vs ${wBI.toFixed(3)})`);
  } else {
    ok(
      `T8 <b><i> bold-italic font swap: plain w=${wPlain.toFixed(3)}, bold-italic w=${wBI.toFixed(3)}`,
    );
  }
}

// T9: without variants wired, <b> silently falls back to primary.
// No error, no synthesis — bundle matches plain exactly.
{
  const plain = await buildFromMarkup('A', arial, [0, 0, 0, 1]);
  const fakebold = await buildFromMarkup('<b>A</b>', arial, [0, 0, 0, 1]); // no boldFont!
  const wp = plain.globalBBox[2];
  const wb = fakebold.globalBBox[2];
  if (Math.abs(wp - wb) > 0.01) {
    fail(`T9 <b> without boldFont changed width: plain ${wp}, bold ${wb}`);
  } else {
    ok(`T9 <b> without boldFont silently falls back to primary (w=${wp.toFixed(3)})`);
  }
}
// Native records supplied by a font reader retain geometry and path ownership.
{
  const { transformAndFlip } = await import('../../src/font/textColrEmit.js');
  const { parsePathD } = await import('../../src/svg/path.js');
  const { segStart, segEnd } = await import('../../src/svg/segment.js');
  const assert = (await import('node:assert/strict')).default;
  for (const path of ['M1 2L5 4', 'M1 2Q3 6 5 4', 'M1 2C2 6 4 0 5 4', 'M1 2A4 3 20 0 1 5 4']) {
    for (const [sx, sy, rotation, shear] of [
      [1, 1, 0, 0],
      [1.2, 0.8, 30, 0.2],
      [2 ** -20, 2 ** -20, -45, 0],
    ]) {
      const src = parsePathD(path);
      src[0].subStart = true;
      src.at(-1).openEnd = true;
      if (src[0].type === 0) src[0].is_fill_only = true;
      const before = JSON.stringify(src),
        out = transformAndFlip(src, 4, 5, sx, sy, rotation, shear);
      assert.equal(out.length, 1);
      assert.equal(out[0].type, src[0].type);
      assert(out[0].subStart && out[0].openEnd);
      if (src[0].is_fill_only) assert(out[0].is_fill_only);
      const a = (rotation * Math.PI) / 180,
        c = Math.cos(a),
        s = Math.sin(a);
      const point = (p) => {
        const x = p[0] * sx + p[1] * sy * shear,
          y = p[1] * sy;
        return [4 + c * x - s * y, 5 - s * x - c * y];
      };
      for (const [actual, expected] of [
        [segStart(out[0]), point(segStart(src[0]))],
        [segEnd(out[0]), point(segEnd(src[0]))],
      ])
        assert(
          Math.hypot(actual[0] - expected[0], actual[1] - expected[1]) <
            2e-12 * Math.max(1, ...expected.map(Math.abs)),
        );
      assert.equal(JSON.stringify(src), before);
    }
  }
  console.log(
    'Native glyph records retain provenance, endpoints and source ownership (12 controls)',
  );
}

console.log();
console.log(failures === 0 ? 'BOLD-ITALIC PASS' : `BOLD-ITALIC FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
