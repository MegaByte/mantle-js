// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// colrClipHitSmoke -- a hit on a part of a COLRv1 PaintGlyph silhouette that the glyph's ClipList box cuts away does not answer.
// The clip box is a mask row that draws nothing and answers no hit by itself, but it limits the paint under it, so a pointer
// there sees nothing drawn. Fixture: test/fixtures/fonts/colrSpecClip.ttf (genColrClipFonts.py): A is a 100..700 x 0..600 box
// silhouette painted under the ClipList box 200..500 x 100..400; C is the same paint with no box; D nests two boxes
// (200..500 x 100..400 and 250..650 x 150..500, the glyph's and the referenced glyph's).
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { MantleFontAsset, buildStyled } from '../../src/font/index.js';
import { defaultStyle } from '../../src/font/markupParser.js';
import { registerColorEmojiReaders } from '../../src/font/color/index.js';
import { fillHitShape, fillHits, HitMode } from '../../src/hitTest/hitTest.js';
globalThis.DOMParser ??= DOMParser;
globalThis.XMLSerializer ??= XMLSerializer;
registerColorEmojiReaders();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const font = new MantleFontAsset(
  new Uint8Array(readFileSync(path.join(HERE, '../fixtures/fonts/colrSpecClip.ttf'))),
);
const build = (ch) =>
  buildStyled([{ text: ch, style: { ...defaultStyle(), color: [0, 0, 0, 1] } }], font, {});
const probe = (b) => {
  const base = b.firstBaselineY,
    at = (fx, fy) => [fx / 1000 + (b.originX || 0), base - fy / 1000];
  return (fx, fy) => fillHitShape(b, ...at(fx, fy), { mode: HitMode.Auto });
};
{
  const hit = probe(await build('A'));
  assert.ok(hit(300, 200) >= 0, 'A: inside the silhouette and the box answers');
  assert.equal(hit(150, 300), -1, 'A: inside the silhouette, left of the box, cut away');
  assert.equal(hit(600, 500), -1, 'A: inside the silhouette, past the box, cut away');
  assert.equal(hit(300, 50), -1, 'A: below the box, cut away');
  assert.ok(hit(210, 110) >= 0, 'A: near the box corner, inside');
}
{
  const hit = probe(await build('C'));
  assert.ok(hit(150, 300) >= 0 && hit(600, 500) >= 0, 'C: no box, the whole silhouette answers');
}
{
  const b = await build('D'),
    hit = probe(b);
  assert.ok(hit(300, 200) >= 0, 'D: inside both boxes answers');
  assert.equal(
    hit(230, 120),
    -1,
    'D: inside the first box, outside the second (nested boxes both apply)',
  );
  assert.equal(hit(600, 450), -1, 'D: inside the second box, outside the first');
  assert.equal(
    fillHits(b, ...[0.3, b.firstBaselineY - 0.2], { mode: HitMode.Auto }).length,
    1,
    'D: one glyph, one answer',
  );
}
console.log('ok colrClipHit');
