// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// measureTextSmoke.mjs — verifies MeasureText returns the same
// width as buildStyled's per-line max advance, without paying the
// curve/band/mesh cost.

import { readFileSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import {
  measureGlyphs,
  measureGlyphsFromText,
  measureText,
  measureFromMarkup,
  buildFromMarkup,
  buildStyled,
} from '../../src/font/textRun.js';

const arial = new MantleFontAsset(
  new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/Arial.ttf')),
);
arial.getMetrics(0x41);

let failures = 0;
const fail = (msg) => {
  console.error('FAIL:', msg);
  failures++;
};
const ok = (msg) => console.log('ok ' + msg);

// T1: empty input → all zeros, lineWidths == [].
{
  const m = measureText([], arial);
  if (m.lineCount !== 0) fail(`T1 empty lineCount=${m.lineCount}`);
  else if (m.width !== 0 || m.height !== 0) fail(`T1 empty size: ${m.width}x${m.height}`);
  else if (m.lineWidths.length !== 0) fail(`T1 empty lineWidths.length=${m.lineWidths.length}`);
  else ok('T1 empty input: width=0 height=0 lineCount=0');
}

// T2: single-line plain ASCII — width agrees with bundle's globalBBox xmax.
{
  const text = 'Hello, World!';
  const m = measureFromMarkup(text, arial);
  const b = await buildFromMarkup(text, arial);
  // Bundle's globalBBox is INK extent; measure is ADVANCE extent.
  // The two agree to within a few percent for body Latin (advance
  // is slightly wider — accounts for right side-bearing). Assert
  // measure.width >= bundle.bbox.width and within 10%.
  const bbWidth = b.globalBBox[2];
  if (m.width < bbWidth) fail(`T2 measure ${m.width} < ink-bbox ${bbWidth}`);
  else if (m.width > bbWidth * 1.1) fail(`T2 measure ${m.width} > 110% of ink ${bbWidth}`);
  else if (m.lineCount !== 1) fail(`T2 lineCount=${m.lineCount}`);
  else ok(`T2 single line: measure.width=${m.width.toFixed(3)} vs ink-bbox=${bbWidth.toFixed(3)}`);
}

// T3: multi-line wrap — lineCount matches.
{
  const text = 'The quick brown fox jumps over the lazy dog';
  const layout = { maxWidthEm: 8 };
  const m = measureFromMarkup(text, arial, layout);
  if (m.lineCount < 2) fail(`T3 expected wrap to multiple lines, got ${m.lineCount}`);
  // height = ascent + descent + (lineCount-1) * lineHeight.
  const expectedH = m.ascent + m.descent + (m.lineCount - 1) * m.lineHeight;
  if (Math.abs(m.height - expectedH) > 0.001) fail(`T3 height=${m.height} expected ${expectedH}`);
  else if (m.lineWidths.length !== m.lineCount)
    fail(`T3 lineWidths.length=${m.lineWidths.length} vs lineCount=${m.lineCount}`);
  else
    ok(
      `T3 wrap: ${m.lineCount} lines, height=${m.height.toFixed(3)}, lineWidths=[${m.lineWidths.map((x) => x.toFixed(2)).join(', ')}]`,
    );
}

// T4: explicit lineHeight override honored.
{
  const text = 'A\nB\nC'; // Note: \n likely doesn't break in plain text — use wrap.
  const layout = { lineHeightEm: 2.5, maxWidthEm: 0.5 };
  const m = measureFromMarkup('AAA AAA', arial, layout);
  if (m.lineHeight !== 2.5) fail(`T4 lineHeight=${m.lineHeight} expected 2.5`);
  else ok(`T4 lineHeight override: ${m.lineHeight} (lineCount=${m.lineCount})`);
}

// T5: ascent/descent come from font, not zero.
{
  const m = measureFromMarkup('X', arial);
  if (m.ascent <= 0) fail(`T5 ascent=${m.ascent} (expected positive)`);
  else if (m.descent <= 0) fail(`T5 descent=${m.descent} (expected positive)`);
  else ok(`T5 font metrics: ascent=${m.ascent.toFixed(3)} descent=${m.descent.toFixed(3)}`);
}

// T6: measure is cheaper than build. Wall-clock check, paragraph
// of ~500 chars. Threshold is loose to avoid CI flakiness.
{
  let text = '';
  for (let i = 0; i < 50; i++) text += 'The quick brown fox jumps. ';
  const layout = { maxWidthEm: 30 };

  // Warm up.
  measureFromMarkup(text, arial, layout);
  await buildFromMarkup(text, arial, [0, 0, 0, 1], layout);

  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 5; i++) measureFromMarkup(text, arial, layout);
  const tMeas = Number(process.hrtime.bigint() - t0) / 5;

  const t1 = process.hrtime.bigint();
  for (let i = 0; i < 5; i++) await buildFromMarkup(text, arial, [0, 0, 0, 1], layout);
  const tBuild = Number(process.hrtime.bigint() - t1) / 5;

  const ratio = tBuild / tMeas;
  if (ratio < 2)
    fail(
      `T6 measure not meaningfully cheaper: measure=${(tMeas / 1e6).toFixed(2)}ms build=${(tBuild / 1e6).toFixed(2)}ms ratio=${ratio.toFixed(2)}x`,
    );
  else
    ok(
      `T6 cheaper than build: measure=${(tMeas / 1e6).toFixed(2)}ms build=${(tBuild / 1e6).toFixed(2)}ms (${ratio.toFixed(1)}x speedup)`,
    );
}

// Lazy font tables must be initialized before returning line metrics.
{
  const fresh = new MantleFontAsset(
    new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/Arial.ttf')),
  );
  const first = measureGlyphsFromText('A', fresh);
  const second = measureGlyphsFromText('A', fresh);
  if (!(first.ascent > 0) || JSON.stringify(first) !== JSON.stringify(second))
    fail('first glyph measurement differs from subsequent call');
  else ok('first glyph measurement initializes font metrics');
}
// Logical UTF-16 offsets survive normalization and visual reordering.
{
  const { registerAllScriptShapers } = await import('../../src/font/scripts/index.js');
  const { registerBidi } = await import('../../src/font/typography/bidi.js');
  await import('../../src/font/unicode/index.js');
  registerAllScriptShapers();
  registerBidi();
  for (const [text, expected] of [
    ['بج', [1, 0]],
    ['אבבא', [3, 2, 1, 0]],
    ['😀بج', [3, 2, 0]],
    ['e\u0301e\u0301', [0, 2]],
    ['א(ב)', [3, 2, 1, 0]],
    ['A😀B', [0, 1, 3]],
    ['a\u0338b', [0, 0, 2]],
    ['कि', [0, 0]],
    ['กำ', [0, 0, 0]],
    ['각', [0]],
    ['👩‍💻', [0, 0, 0]],
  ]) {
    const actual = measureGlyphsFromText(text, arial).glyphs.map((g) => g.cluster);
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      fail(`source clusters ${text}: ${actual}`);
  }
  ok('source cluster controls checked');
}

// A mark with zero laid-out advance must not shift the next glyph.
{
  const { layoutSlots } = await import('../../src/font/textLayout.js');
  const { defaultStyle } = await import('../../src/font/markupParser.js');
  for (const [name, text] of [
    ['Bangla', 'দ্যা'],
    ['Kannada', 'ಕ್ರ್ತ'],
    ['Malayalam', 'കൃത'],
  ]) {
    const font = new MantleFontAsset(
      new Uint8Array(readFileSync(`/System/Library/Fonts/Supplemental/${name} Sangam MN.ttc`)),
    );
    const slots = layoutSlots([{ text, style: defaultStyle() }], font, {
      disabledFeatures: ['kern'],
    });
    // The pen moves by exactly the advance a slot reports. Whether a below-base form is a mark with no advance is the font's
    // GDEF to say (HarfBuzz keeps the 624 units of Bangla's ya-phala, which GDEF does not class as a mark).
    if (slots.length < 3 || Math.abs(slots[2].penX - (slots[1].penX + slots[1].advance)) > 1e-12)
      fail(`zero mark advance ${name}`);
  }
  ok('zero mark advance checked');
}

// Styled contextual AAT kerning uses the glyph's em scale on each axis.
{
  const { registerAatReaders } = await import('../../src/font/typography/aat.js');
  registerAatReaders();
  const { layoutSlots } = await import('../../src/font/textLayout.js');
  const { defaultStyle } = await import('../../src/font/markupParser.js');
  const raw = Buffer.from(
      '0002000000000001000000b2000000010000000000000008000000140000002200000072000000a20008000a00040004000500060007000000000000000000050000000000000001000100010001000100060001000100020002000200020002000200070002000300030003000300030003000300030004000400040004000400040004000400000000ffff00010000ffff00020000ffff00030000ffff00040000ffff00018000ffff00028000ffff0003800000000065ffff',
      'hex',
    ),
    original = Buffer.from(readFileSync('/System/Library/Fonts/Supplemental/Arial.ttf'));
  const at = (original.length + 3) & ~3,
    data = Buffer.alloc(at + raw.length);
  original.copy(data);
  data.set(raw, at);
  for (let i = 0; i < data.readUInt16BE(4); i++) {
    const pos = 12 + i * 16;
    if (data.toString('ascii', pos, pos + 4) === 'GSUB') {
      data.write('kerx', pos, 4, 'ascii');
      data.writeUInt32BE(at, pos + 8);
      data.writeUInt32BE(raw.length, pos + 12);
      break;
    }
  }
  const native = [
    { g: 10, cl: 0, dx: 0, dy: 0, ax: 391, ay: 0 },
    { g: 11, cl: 1, dx: 0, dy: 0, ax: 783, ay: 0 },
    { g: 12, cl: 2, dx: 0, dy: 0, ax: 682, ay: 0 },
  ];
  for (const [sizeScale, widthScale] of [
    [0.5, 0.5],
    [1, 1],
    [2, 1.5],
  ]) {
    const font = new MantleFontAsset(data),
      slots = layoutSlots(
        [{ text: "'()", style: { ...defaultStyle(), sizeScale, widthScale } }],
        font,
        {},
      );
    let pen = 0;
    for (let i = 0; i < native.length; i++) {
      const expected = ((pen + native[i].dx) / font.unitsPerEm) * sizeScale * widthScale;
      if (Math.abs(slots[i].penX - expected) > 1e-10)
        fail(`styled AAT kern origin ${sizeScale}/${widthScale}/${i}`);
      pen += native[i].ax;
    }
    if (
      Math.abs(
        slots.reduce((n, s) => n + s.advance, 0) - (pen / font.unitsPerEm) * sizeScale * widthScale,
      ) > 1e-10
    )
      fail('styled AAT total advance');
  }
  ok('styled contextual AAT kerning checked');
}

console.log();

// Anchored upright marks keep zero inline advance in both column directions.
{
  const fs = await import('node:fs');
  const { MantleFontAsset, measureGlyphsFromText } = await import('../../src/font/index.js');
  const font = new MantleFontAsset(
    fs.readFileSync(new URL('./fixtures/roboto-regular.ttf', import.meta.url)),
  );
  for (const writingMode of ['vertical-rl', 'vertical-lr']) {
    const result = measureGlyphsFromText('q\u0323', font, {
      writingMode,
      textOrientation: 'upright',
    });
    if (result.glyphs.length !== 2 || result.glyphs[1].advance !== 0)
      throw new Error('anchored vertical mark advance');
  }
}

// Empty aggregate queries expose the same font metrics before and after initialization.
for (const spans of [null, []]) {
  const font = new MantleFontAsset(
    new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/Arial.ttf')),
  );
  const first = measureText(spans, font);
  font.getMetrics(32);
  const later = measureText(spans, font);
  if (!(first.ascent > 0) || JSON.stringify(first) !== JSON.stringify(later))
    throw new Error('cold empty aggregate font metrics');
}

// Explicit empty lines affect block metrics without adding glyphs or clusters.
for (const text of [
  'a',
  'a\na',
  'a\n\na',
  '\na',
  'a\n',
  'a\n\n',
  '\n',
  '\n\n',
  '\na\n',
  'a\n\n\na',
  'a\n \na',
  'a\r\n\rb',
]) {
  const breaks = [...text.matchAll(/\r\n|[\n\r\v\f\u0085\u2028\u2029]/g)],
    count = breaks.length + 1;
  const layout = { lineHeightEm: 1.4 },
    m = measureFromMarkup(text, arial, layout),
    g = measureGlyphsFromText(text, arial, layout),
    built = await buildFromMarkup(text, arial, [0, 0, 0, 1], layout);
  const label = JSON.stringify(text);
  if (m.lineCount !== count || g.lineCount !== count || built.lineCount !== count)
    fail(
      'blank-line counts ' +
        label +
        ' ' +
        JSON.stringify([m.lineCount, g.lineCount, built.lineCount]) +
        ' expected ' +
        count,
    );
  if (m.lineWidths.length !== count) fail('blank-line width count ' + label);
  if (Math.abs(m.height - (m.ascent + m.descent + 1.4 * (count - 1))) > 1e-6)
    fail('blank-line height ' + label);
  if (
    Math.abs(built.firstBaselineY) > 1e-6 ||
    Math.abs(built.lastBaselineY - 1.4 * (count - 1)) > 1e-6
  )
    fail(
      'blank-line baselines ' +
        label +
        ' ' +
        JSON.stringify([built.firstBaselineY, built.lastBaselineY]),
    );
  const wantGlyphs = [...text.replace(/\r\n|[\n\r\v\f\u0085\u2028\u2029]/g, '')].length;
  if (g.glyphs.length !== wantGlyphs) fail('synthetic blank-line glyph ' + label);
  if (/[\n\r]$/.test(text) && (m.lineWidths.at(-1) !== 0 || built.lastLineAdvance !== 0))
    fail('empty last-line advance ' + label);
}
if (
  measureGlyphsFromText('', arial).lineCount !== 0 ||
  measureFromMarkup('', arial).lineCount !== 0
)
  fail('empty text metrics policy changed');

console.log(failures === 0 ? 'MEASURE-TEXT PASS' : `MEASURE-TEXT FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
