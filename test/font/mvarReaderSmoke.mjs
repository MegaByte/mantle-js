// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { MantleFontAsset, measureText, measureGlyphs, buildStyled } from '../../src/font/index.js';
import { defaultStyle } from '../../src/font/markupParser.js';
import { mvarConsumerFont } from './_mvarConsumerFont.mjs';

const font = new MantleFontAsset(mvarConsumerFont());
const near = (actual, expected, label) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, `${label}: ${actual} != ${expected}`);
const references = [
  [-1, 0.8, -0.2, 0, 0.7, 0.45, -0.1, 0.05],
  [0, 0.8, -0.2, 0, 0.7, 0.45, -0.1, 0.05],
  [0.5, 0.95, -0.25, 0.025, 0.76, 0.48, -0.14, 0.06],
  [1, 1.1, -0.3, 0.05, 0.82, 0.51, -0.18, 0.07],
];
for (const [
  coord,
  ascent,
  descent,
  gap,
  capHeight,
  xHeight,
  underlinePosition,
  underlineThickness,
] of references) {
  const layout = { varCoords: [coord] },
    metrics = font.getMetricsVar(layout.varCoords);
  for (const key of [
    'ascent',
    'descent',
    'capHeight',
    'xHeight',
    'underlinePosition',
    'underlineThickness',
  ])
    near(
      metrics[key],
      { ascent, descent, capHeight, xHeight, underlinePosition, underlineThickness }[key],
      key,
    );
  near(metrics.lineGap, gap, 'line gap');
  const spans = [{ text: 'a\na', style: defaultStyle() }],
    glyphs = measureGlyphs(spans, font, layout),
    text = measureText(spans, font, layout),
    step = ascent - descent + gap;
  near(glyphs.glyphs[1].penY, step, 'second baseline');
  for (const packet of [glyphs, text]) {
    near(packet.ascent, ascent, 'ascent');
    near(packet.descent, -descent, 'descent');
    near(packet.lineHeight, step, 'line height');
  }
  near(text.height, ascent - descent + step, 'text height');
  near(
    measureGlyphs(spans, font, { ...layout, lineHeightEm: 2.5 }).glyphs[1].penY,
    2.5,
    'explicit line height',
  );
  const empty = measureText([], font, layout);
  near(empty.ascent, ascent, 'empty metrics');
  assert.equal(empty.height, 0);
  const underline = await buildStyled(
      [{ text: 'aa', style: { ...defaultStyle(), underline: true } }],
      font,
      layout,
    ),
    u = (underline.numShapes - 1) * 48;
  near(underline.metaFloats[u + 1], -underlinePosition, 'underline top');
  near(
    underline.metaFloats[u + 3] - underline.metaFloats[u + 1],
    underlineThickness,
    'underline thickness',
  );
  const mark = await buildStyled(
    [{ text: 'aa', style: { ...defaultStyle(), mark: true, markColor: [1, 0, 0, 1] } }],
    font,
    layout,
  );
  near(mark.metaFloats[1], -ascent, 'mark top');
  near(mark.metaFloats[3] - mark.metaFloats[1], ascent - descent, 'mark height');
}
near(font.ascent, 0.8, 'static metrics stay unchanged');
near(font.getMetricsVar(null).underlinePosition, -0.1, 'default underline position');
// Compatible minor-version records may append fields after the tag/indices.
{
  const { MvarTable } = await import('../../src/font/variations/mvarReader.js');
  const [start, length] = font._tables.mvar,
    raw = font._tables.bytes.subarray(start, start + length),
    header = new DataView(raw.buffer, raw.byteOffset, raw.byteLength),
    count = header.getUint16(8, false),
    expanded = new Uint8Array(raw.length + 4 * count);
  expanded.set(raw.subarray(0, 12));
  const view = new DataView(expanded.buffer);
  view.setUint16(2, 1, false);
  view.setUint16(6, 12, false);
  view.setUint16(10, header.getUint16(10, false) + 4 * count, false);
  for (let i = 0; i < count; i++) expanded.set(raw.subarray(12 + 8 * i, 20 + 8 * i), 12 + 12 * i);
  expanded.set(raw.subarray(12 + 8 * count), 12 + 12 * count);
  const reader = new MvarTable({ view, mvar: [0, expanded.length] });
  assert.equal(reader.hasMvar, true);
  near(reader.delta('hasc', [1]), 300, 'extended ascent record');
  near(reader.delta('undo', [1]), -80, 'extended underline offset record');
  near(reader.delta('unds', [1]), 20, 'extended underline size record');
}
// Distinct table defaults verify the selected metric source at every instance.
for (const useTypo of [false, true]) {
  const data = mvarConsumerFont(),
    view = new DataView(data.buffer);
  const tables = font._tables,
    hh = tables.hhea[0],
    os = tables.os2[0];
  view.setInt16(hh + 4, 900, false);
  view.setInt16(hh + 6, -250, false);
  view.setInt16(hh + 8, 25, false);
  view.setUint16(os + 62, (view.getUint16(os + 62, false) & ~128) | (useTypo ? 128 : 0), false);
  const sourceFont = new MantleFontAsset(data);
  for (const coord of [-1, 0, 0.5, 1]) {
    const factor = Math.max(coord, 0),
      a = (useTypo ? 0.8 : 0.9) + 0.3 * factor,
      d = (useTypo ? -0.2 : -0.25) - 0.1 * factor,
      g = (useTypo ? 0 : 0.025) + 0.05 * factor;
    const m = sourceFont.getMetricsVar([coord]);
    near(m.ascent, a, 'selected metric ascent');
    near(m.descent, d, 'selected metric descent');
    near(m.lineGap, g, 'selected metric gap');
    near(
      measureGlyphs([{ text: 'a\na', style: defaultStyle() }], sourceFont, { varCoords: [coord] })
        .glyphs[1].penY,
      a - d + g,
      'selected metric baseline',
    );
  }
  near(
    sourceFont.getMetricsVar(null).ascent,
    useTypo ? 0.8 : 0.9,
    'selected default metric source',
  );
}
// Axis-tag maps share vector normalization and invalidate on in-place edits.
{
  const coordinates = { wght: 1 };
  const first = font._normCoords(coordinates);
  assert.strictEqual(font._normCoords(coordinates), first);
  near(font.getMetricsVar(coordinates).ascent, 1.1, 'tag-map metric instance');
  const vector = measureGlyphs([{ text: 'a\na', style: defaultStyle() }], font, { varCoords: [1] });
  const tagged = measureGlyphs([{ text: 'a\na', style: defaultStyle() }], font, {
    varCoords: coordinates,
  });
  near(tagged.glyphs[1].penY, vector.glyphs[1].penY, 'tag-map layout instance');
  coordinates.wght = 0;
  near(font.getMetricsVar(coordinates).ascent, 0.8, 'mutated tag-map instance');
  assert.notStrictEqual(font._normCoords(coordinates), first);
  delete coordinates.wght;
  near(font.getMetricsVar(coordinates).ascent, 0.8, 'missing tag defaults');
  assert.deepEqual(font.fvar.normalizeCoords({ wght: 1 }), font.fvar.normalizeCoords([1]));
}
console.log('MVAR-READER PASS');
