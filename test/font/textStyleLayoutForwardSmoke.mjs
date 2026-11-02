// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// textStyleLayoutForwardSmoke -- style.varCoords / style.fallbacks / style.language reach the layout.
// layoutFromStyle() forwards them along with bitmapPpem, widths, align, features, writing mode and the variant faces, so
// createTextBundle / setText / setStyle / buildTextSections can leave a variable font's default instance and ask for a
// fallback face, as buildStyled / buildFromMarkup do.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerJustificationReader } from '../../src/font/typography/justification.js';
import { MantleFontAsset } from '../../src/font/index.js';
import { buildTextSections, layoutFromStyle } from '../../src/font/textSections.js';
import { mvarConsumerFont } from './_mvarConsumerFont.mjs';
import { buildColrTestFont } from './_colrFontFixture.mjs';

const near = (a, b, m) => assert.ok(Math.abs(a - b) < 1e-6, `${m}: ${a} != ${b}`);

// 1. plain forwarding of the three fields, by identity
{
  const fb = [{}],
    vc = { wght: 1 };
  const l = layoutFromStyle({ fontSizePx: 16, varCoords: vc, fallbacks: fb, language: 'TRK ' });
  assert.strictEqual(l.varCoords, vc);
  assert.strictEqual(l.fallbacks, fb);
  assert.equal(l.language, 'TRK ');
  const none = layoutFromStyle({ fontSizePx: 16 });
  assert.ok(
    !('varCoords' in none) && !('fallbacks' in none) && !('language' in none),
    'unset fields stay unset (default path unchanged)',
  );
}

// 2. varCoords end to end: the MVAR consumer font's ascent is 0.8 at the default and 1.1 at wght=1
{
  const font = new MantleFontAsset(mvarConsumerFont());
  const def = await buildTextSections(font, 'a\na', { fontSizePx: 32 });
  const bold = await buildTextSections(font, 'a\na', { fontSizePx: 32, varCoords: { wght: 1 } });
  const arr = await buildTextSections(font, 'a\na', { fontSizePx: 32, varCoords: [1] });
  near(def.sections.fontMetrics.ascent, 0.8, 'default ascent');
  near(bold.sections.fontMetrics.ascent, 1.1, 'wght=1 ascent through style.varCoords');
  near(arr.sections.fontMetrics.ascent, 1.1, 'array varCoords');
  assert.notEqual(
    def.bundleSrc.lastBaselineY,
    bold.bundleSrc.lastBaselineY,
    'line pitch follows the instance',
  );
}

// 3. fallbacks end to end: the primary maps only 'A'; the fallback maps 'z' to a layered glyph
{
  const primary = new MantleFontAsset(buildColrTestFont({ codepoint: 0x41 }));
  const other = new MantleFontAsset(buildColrTestFont({ codepoint: 0x7a }));
  const sig = (s) => {
    const c = new Uint8Array(s.sections.curves);
    let h = 0;
    for (const v of c) h = (h * 31 + v) >>> 0;
    return h + ':' + s.bundleSrc.numShapes;
  };
  const without = await buildTextSections(primary, 'z', { fontSizePx: 32 });
  const withFb = await buildTextSections(primary, 'z', { fontSizePx: 32, fallbacks: [other] });
  assert.notEqual(sig(without), sig(withFb), 'a requested fallback changes the glyphs');
}
// Final-line justification reaches the shared WebGL/native preparation path.
{
  registerJustificationReader();
  const font = new MantleFontAsset(
    new Uint8Array(readFileSync(new URL('../fixtures/fonts/jstfPriorities.ttf', import.meta.url))),
  );
  const style = { maxWidthEm: 0.7, layoutWidthEm: 0.7, align: 'justify', lastLineAlign: 'justify' };
  assert.equal(layoutFromStyle(style).lastLineAlign, 'justify');
  assert.ok(!('lastLineAlign' in layoutFromStyle({})), 'unset final-line policy stays unset');
  const expanded = await buildTextSections(font, 'fi', style);
  const natural = await buildTextSections(font, 'fi', { ...style, lastLineAlign: 'auto' });
  assert.equal(expanded.bundleSrc.numShapes, 2, 'final-line JSTF expands the ligature');
  assert.equal(natural.bundleSrc.numShapes, 1, 'auto keeps the natural final line');
  near(expanded.bundleSrc.lastLineAdvance, 0.7, 'final-line JSTF reaches the target advance');
}
console.log('ok textStyleLayoutForward');
