// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Vertical writing-mode through the dynamic-text bundle bridge
// (buildTextSections / createTextBundle).
//
// Contract:
//   - writingMode/textOrientation forward through layoutFromStyle.
//   - vertical-rl/-lr stack glyphs DOWN the column (+Y dominant).
//   - origin normalization still pins the bundle globalBBox to (0,0)
//     in vertical mode (origin shift re-applied in the re-aimed space).
import { readFileSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { buildTextSections } from '../../src/textBundle.js';

let failures = 0;
const ok = (m) => console.log('ok', m);
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};

const arial = new MantleFontAsset(
  new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/Arial.ttf')),
);

function readBundle(sections) {
  const dv = new DataView(sections.meta);
  const numShapes = dv.getUint32(0, true);
  const gbb = [
    dv.getFloat32(4, true),
    dv.getFloat32(8, true),
    dv.getFloat32(12, true),
    dv.getFloat32(16, true),
  ];
  const stride = sections.metaFloatsPerShape;
  const f = new Float32Array(sections.meta, 32);
  const boxes = [];
  for (let i = 0; i < numShapes; i++) {
    boxes.push([f[i * stride + 0], f[i * stride + 1], f[i * stride + 2], f[i * stride + 3]]);
  }
  return { numShapes, gbb, boxes };
}
// Net stacking axis = displacement of last glyph box from the first.
function stackAxis(boxes) {
  const dx = Math.abs(boxes[boxes.length - 1][0] - boxes[0][0]);
  const dy = Math.abs(boxes[boxes.length - 1][1] - boxes[0][1]);
  return { dx, dy, axis: dx > dy ? 'x' : 'y' };
}

const base = { fill: [0, 0, 0, 1], fontSizePx: 1, family: 'Arial' };

const h = readBundle((await buildTextSections(arial, 'ABCD', { ...base }, false)).sections);
const vr = readBundle(
  (await buildTextSections(arial, 'ABCD', { ...base, writingMode: 'vertical-rl' }, false)).sections,
);
const vl = readBundle(
  (await buildTextSections(arial, 'ABCD', { ...base, writingMode: 'vertical-lr' }, false)).sections,
);

// ---- T1: all three emit one shape per glyph -----------------------
if (h.numShapes === 4 && vr.numShapes === 4 && vl.numShapes === 4)
  ok('T1 4 glyph-shapes emitted in each writing mode');
else fail(`T1 numShapes h=${h.numShapes} vr=${vr.numShapes} vl=${vl.numShapes} (expected 4)`);

// ---- T2: horizontal stacks along X --------------------------------
{
  const a = stackAxis(h.boxes);
  if (a.axis === 'x')
    ok(`T2 horizontal stacks along X (dx=${a.dx.toFixed(2)} dy=${a.dy.toFixed(2)})`);
  else fail(`T2 horizontal expected X-dominant, got dx=${a.dx.toFixed(2)} dy=${a.dy.toFixed(2)}`);
}

// ---- T3: vertical-rl stacks DOWN the column (Y) -------------------
{
  const a = stackAxis(vr.boxes);
  if (a.axis === 'y' && a.dy > 1)
    ok(`T3 vertical-rl stacks along Y (dy=${a.dy.toFixed(2)} dx=${a.dx.toFixed(2)})`);
  else
    fail(
      `T3 vertical-rl expected Y-dominant stack, got dx=${a.dx.toFixed(2)} dy=${a.dy.toFixed(2)}`,
    );
}

// ---- T4: writingMode is actually honored (not horizontal echo) ----
{
  // Vertical output must not be byte-identical to horizontal; compare
  // the per-glyph box positions.
  const identical = h.boxes.every(
    (b, i) => Math.abs(b[0] - vr.boxes[i][0]) < 1e-4 && Math.abs(b[1] - vr.boxes[i][1]) < 1e-4,
  );
  if (!identical)
    ok('T4 vertical layout differs from horizontal (writingMode honored, not dropped)');
  else fail('T4 vertical output identical to horizontal — writingMode dropped (regression)');
}

// ---- T5: vertical bundle globalBBox pinned to (0,0) ---------------
for (const [tag, b] of [
  ['vertical-rl', vr],
  ['vertical-lr', vl],
]) {
  const [x, y] = b.gbb;
  if (Math.abs(x) < 1e-3 && Math.abs(y) < 1e-3)
    ok(
      `T5 ${tag} globalBBox origin pinned to (0,0) [${b.gbb.map((n) => n.toFixed(3)).join(', ')}]`,
    );
  else fail(`T5 ${tag} globalBBox origin not pinned: xmin=${x.toFixed(3)} ymin=${y.toFixed(3)}`);
}

// ---- T6: vertical bundle is taller than wide ---------------------
{
  const [, , w, ht] = vr.gbb;
  if (ht > w) ok(`T6 vertical bundle is taller than wide (h=${ht.toFixed(2)} > w=${w.toFixed(2)})`);
  else fail(`T6 vertical bundle not column-shaped: w=${w.toFixed(2)} h=${ht.toFixed(2)}`);
}

// Resolved glyph metrics, styled sizes and later columns determine placement.
{
  const { applyVerticalLayout } = await import('../../src/font/textSlotEmit.js');
  const { measureGlyphs } = await import('../../src/font/textRun.js');
  const { defaultStyle } = await import('../../src/font/markupParser.js');
  const fallback = {
    getVerticalMetricsByGid: () => ({ advanceHeight: 1.5 }),
    getVerticalOriginY: () => 0.8,
  };
  const slots = [0, 1, 2].map((i) => ({
    codepoint: 0x6f22,
    glyphId: i,
    font: fallback,
    style: { sizeScale: 2 },
    penX: i === 1 ? 1 : 0,
    penY: 0,
    lineY: i === 2 ? 2.5 : 0,
    advance: 1,
  }));
  for (const mode of ['vertical-rl', 'vertical-lr']) {
    const out = applyVerticalLayout(slots, arial, 'upright', mode);
    const expectedX = (mode === 'vertical-lr' ? 2.5 : -2.5) - 0.5;
    if (
      out[0].advance !== 3 ||
      Math.abs(out[0].penY - 1.6) > 1e-12 ||
      Math.abs(out[1].penY - 4.6) > 1e-12 ||
      out[2].penX !== expectedX
    )
      fail(`resolved vertical metrics ${mode}`);
    const measured = measureGlyphs([{ text: 'AB\nCD', style: defaultStyle() }], arial, {
      writingMode: mode,
      textOrientation: 'upright',
    });
    if (
      measured.lineCount !== 2 ||
      measured.glyphs[2].penX === measured.glyphs[0].penX ||
      measured.glyphs[1].penY <= measured.glyphs[0].penY
    )
      fail(`vertical measurement ${mode}`);
  }
  ok('resolved vertical metrics, sizes, columns and measurement checked');
}
{
  const { registerVariableFontReaders } = await import('../../src/font/variations/index.js');
  registerVariableFontReaders();
  const { vvarConsumerFont, gvarVerticalConsumerFont } = await import('./_vvarConsumerFont.mjs');
  const { measureGlyphs, buildStyled } = await import('../../src/font/textRun.js');
  const { defaultStyle } = await import('../../src/font/markupParser.js');
  for (const bytes of [vvarConsumerFont(), gvarVerticalConsumerFont()]) {
    const variableFont = new MantleFontAsset(bytes);
    for (const axis of [-1, 0, 0.5, 1])
      for (const size of [0.5, 1, 2])
        for (const mode of ['vertical-rl', 'vertical-lr']) {
          const factor = Math.max(axis, 0),
            a = (1 + 0.2 * factor) * size,
            b = (1 - 0.1 * factor) * size;
          const spans = [{ text: 'ab', style: { ...defaultStyle(), sizeScale: size } }],
            layout = { varCoords: [axis], writingMode: mode, textOrientation: 'upright' };
          const measured = measureGlyphs(spans, variableFont, layout),
            built = await buildStyled(spans, variableFont, layout),
            stride = built.metaFloats.length / built.numShapes;
          const values = [
            [measured.glyphs[0].advance, a],
            [measured.glyphs[1].advance, b],
            [measured.glyphs[1].penY - measured.glyphs[0].penY, a - 0.3 * size],
            [built.metaFloats[stride + 1] - built.metaFloats[1], a],
          ];
          if (
            values.some(
              ([actual, expected]) =>
                !Number.isFinite(actual) || Math.abs(actual - expected) > 1e-6,
            )
          )
            fail(`variable vertical advances ${axis}/${size}/${mode}`);
        }
    if (Math.abs(variableFont.getGlyphVerticalAdvanceVar(1, { wght: 1 }) - 1.2) > 1e-6)
      fail('vertical advance tag coordinates');
  }
  ok('VVAR layout and gvar vertical phantom advances checked');
}
{
  const { verticalOriginFont } = await import('./_verticalOriginFont.mjs');
  const { measureGlyphs, buildStyled } = await import('../../src/font/textRun.js');
  const { defaultStyle } = await import('../../src/font/markupParser.js');
  const font = new MantleFontAsset(verticalOriginFont()),
    spans = [{ text: 'a', style: defaultStyle() }],
    layout = { writingMode: 'vertical-rl', textOrientation: 'upright' };
  const measured = measureGlyphs(spans, font, layout),
    built = await buildStyled(spans, font, layout);
  if (
    Math.abs(font.getVerticalOriginY(1) - 1.1) > 1e-6 ||
    Math.abs(measured.glyphs[0].penY - 1.1) > 1e-6 ||
    Math.abs(built.metaFloats[1] - 0.6) > 1e-6
  )
    fail('TrueType origin uses declared bounds and top bearing');
  ok('TrueType vertical origin and quadratic ink bounds checked');
}
{
  const { registerCffReader } = await import('../../src/font/formats/cff.js');
  registerCffReader();
  const { cffVerticalOriginFonts } = await import('./_verticalOriginFont.mjs');
  for (const bytes of cffVerticalOriginFonts()) {
    const font = new MantleFontAsset(bytes);
    for (const [i, expected] of [0.8, 0.5, 1.15, 0.9].entries()) {
      const actual = font.getVerticalOriginY(i + 1);
      if (!Number.isFinite(actual) || Math.abs(actual - expected) > 1e-6)
        fail(`CFF/CFF2 vertical origin ${i + 1}`);
    }
  }
  ok('CFF/CFF2 vertical origins use curve bounds and top bearing');
}
{
  const { registerVerticalReader } = await import('../../src/font/typography/vertical.js');
  registerVerticalReader();
  const { variableOriginFonts } = await import('./_vvarConsumerFont.mjs');
  const { measureGlyphs } = await import('../../src/font/textRun.js');
  const { defaultStyle } = await import('../../src/font/markupParser.js');
  for (const fixture of variableOriginFonts()) {
    const font = new MantleFontAsset(fixture.bytes),
      text = fixture.origins.length === 5 ? 'abcde' : 'abcd';
    const measured = measureGlyphs([{ text, style: defaultStyle() }], font, {
      varCoords: { wght: 1 },
      writingMode: 'vertical-rl',
      textOrientation: 'upright',
    });
    let advance = 0;
    for (let i = 0; i < fixture.origins.length; i++) {
      const expected = fixture.origins[i],
        actual = font.getVerticalOriginY(i + 1, [1]);
      if (
        !Number.isFinite(actual) ||
        Math.abs(actual - expected) > 1e-6 ||
        Math.abs(measured.glyphs[i].penY - advance - expected) > 1e-6 ||
        Math.abs(measured.glyphs[i].advance - fixture.advances[i]) > 1e-6
      )
        fail(`variable vertical origin ${fixture.kind}/${i}`);
      advance += fixture.advances[i];
    }
  }
  ok('variable TrueType and CFF2 origins, empty/composite advances and layout checked');
}
{
  const { compositeMetricOwnerFonts } = await import('./_vvarConsumerFont.mjs');
  for (const fixture of compositeMetricOwnerFonts()) {
    const font = new MantleFontAsset(fixture.bytes);
    for (const reference of fixture.references)
      for (const [index, gid] of [1, 4].entries()) {
        const origin = font.getVerticalOriginY(gid, [reference.axis]);
        const advance = font.getGlyphVerticalAdvanceVar(gid, [reference.axis]);
        if (
          Math.abs(origin - reference.origins[index]) > 1e-6 ||
          Math.abs(advance - reference.advances[index]) > 1e-6
        )
          fail(`component metric owner ${fixture.mode}/${reference.axis}/${gid}`);
      }
  }
}

{
  const { metricOwnerDefaultAdvanceFont } = await import('./_vvarConsumerFont.mjs');
  const font = new MantleFontAsset(metricOwnerDefaultAdvanceFont());
  for (const [coords, expected] of [
    [null, 0.95],
    [[0], 0.95],
    [{ wght: 0 }, 0.95],
    [[0.5], 0.6],
    [[1], 0.6],
  ]) {
    if (Math.abs(font.getGlyphAdvanceVar(4, coords) - expected) > 1e-6)
      fail('default hmtx priority versus nondefault component phantom advance');
  }
}

{
  const { metricOwnerDefaultAdvanceFont, staticMetricOwnerFont } =
    await import('./_vvarConsumerFont.mjs');
  for (const bytes of [metricOwnerDefaultAdvanceFont(), staticMetricOwnerFont()]) {
    const font = new MantleFontAsset(bytes);
    for (const coords of [null, [], [0]])
      if (Math.abs(font.getVerticalOriginY(4, coords) - 0.8) > 1e-6)
        fail('component vertical origin at default/static coordinates');
  }
}

{
  const { verticalDefaultPolicyFont } = await import('./_verticalOriginFont.mjs');
  for (const kind of ['owner', 'owner-no-vmtx', 'owner-vvar']) {
    const font = new MantleFontAsset(verticalDefaultPolicyFont(kind));
    for (const coords of [null, [], [0], [0.5]]) {
      const expected =
        kind === 'owner-no-vmtx'
          ? 1
          : coords?.[0] === 0.5
            ? kind === 'owner'
              ? 0.998
              : 1.48
            : 1.3;
      if (Math.abs(font.getGlyphVerticalAdvanceVar(4, coords) - expected) > 1e-6)
        fail(kind + ': default/absent/VVAR vertical advance');
    }
  }
}

console.log();
console.log(
  failures === 0 ? 'TEXT-BUNDLE-VERTICAL PASS' : `TEXT-BUNDLE-VERTICAL FAIL (${failures})`,
);

process.exit(failures === 0 ? 0 : 1);
