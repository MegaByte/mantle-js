// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// colrPlacedHitSmoke -- COLRv1 hit testing and globalBBox follow the paint transforms, CPU only.
// A paint transform kept only in the paint graph would leave the PaintGlyph outline the hit test and globalBBox read
// where the font drew it, and let the glyph's own base outline (a box the paint graph never draws) answer hits.
// placeColrTransforms() pushes every transform to the leaves, the silhouettes are emitted already placed, and the
// bundle's colrHit table names the rows the pointer answers for.
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { MantleFontAsset, buildStyled } from '../../src/font/index.js';
import { defaultStyle } from '../../src/font/markupParser.js';
import { registerColorEmojiReaders } from '../../src/font/color/index.js';
import { placeColrTransforms } from '../../src/font/textColrEmit.js';
import { fillHitShape, fillHits, HitMode } from '../../src/hitTest/hitTest.js';
registerColorEmojiReaders();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const font = new MantleFontAsset(
  new Uint8Array(readFileSync(path.join(HERE, '../fixtures/fonts/colrSpecXf.ttf'))),
);

// ---- placeColrTransforms on hand-written graphs
{
  const g = {
    nodes: [
      { type: 'PaintSolid', inputs: [], params: { rgba: [1, 0, 0, 1] } },
      { type: 'PaintGlyph', inputs: [0], params: { glyphId: 7 } },
    ],
    rootOut: 1,
  };
  const p = placeColrTransforms(g);
  assert.strictEqual(p.graph, g, 'a graph with no transform comes back as is');
  assert.deepEqual(p.masks, [{ key: 7, glyphId: 7, affine: null }]);
}
{
  // Transform(M1, Merge(Glyph(7, Solid), Transform(M2, Glyph(7, Gradient)))): the second glyph sits under M1.M2
  const M1 = [2, 0, 0, 2, 10, 0],
    M2 = [1, 0, 0, 1, 5, 5];
  const g = {
    nodes: [
      { type: 'PaintSolid', inputs: [], params: { rgba: [1, 0, 0, 1] } },
      { type: 'PaintGlyph', inputs: [0], params: { glyphId: 7 } },
      { type: 'PaintLinearGradient', inputs: [], params: { p0: [0, 0], p1: [1, 0], p2: [0, 1] } },
      { type: 'PaintGlyph', inputs: [2], params: { glyphId: 7 } },
      { type: 'PaintTransform', inputs: [3], params: { affine: M2 } },
      { type: 'PaintMerge', inputs: [1, 4], params: {} },
      { type: 'PaintTransform', inputs: [5], params: { affine: M1 } },
    ],
    rootOut: 6,
  };
  const p = placeColrTransforms(g);
  const types = p.graph.nodes.map((n) => n.type);
  assert.equal(
    types.filter((t) => t === 'PaintTransform').length,
    2,
    'a transform above each of the two generators',
  );
  for (const n of p.graph.nodes)
    if (n.type === 'PaintTransform')
      assert.ok(
        ['PaintSolid', 'PaintLinearGradient'].includes(p.graph.nodes[n.inputs[0]].type),
        'transforms sit directly above generators',
      );
  assert.equal(p.masks.length, 2, 'the same glyph under two different maps is two silhouettes');
  assert.deepEqual(p.masks[0].affine, M1, 'first glyph under M1');
  assert.deepEqual(
    p.masks[1].affine,
    [2, 0, 0, 2, 20, 10],
    'second under M1 o M2 = scale 2, translate (10 + 2*5, 2*5)',
  );
  assert.notEqual(p.masks[0].key, p.masks[1].key);
  const keys = p.graph.nodes.filter((n) => n.type === 'PaintGlyph').map((n) => n.params.maskKey);
  assert.deepEqual(
    keys,
    p.masks.map((m) => m.key),
    'every PaintGlyph names its silhouette',
  );
}

// ---- the font: H = PaintTranslate(100, 50) of L, base outline = box (100..700 x 0..600) that nothing draws
const gidOf = (ch) => font.codepointToGlyphId(ch.codePointAt(0));
const build = (ch) => buildStyled([{ text: ch, style: defaultStyle() }], font, {});
{
  const b = await build('H');
  assert.ok(b.colrHit && b.colrHit.exclude.length === 1, 'the base outline is excluded from hits');
  assert.equal(b.colrHit.rows.length, 1, 'the placed silhouette answers for the glyph');
  // pen at the origin, baseline y: bundle em (x, baseline - y/1000); the rows are in em of the bundle.
  const base = b.firstBaselineY,
    at = (fx, fy) => [fx / 1000 + (b.originX || 0), base - fy / 1000];
  const hit = (fx, fy) => fillHitShape(b, ...at(fx, fy), { mode: HitMode.Auto });
  // L spans x 100..600, y 0..700; PaintTranslate(100, 50) puts it at x 200..700, y 50..750 -- but the glyph is shifted by
  // the (xMin - lsb) = 0 here (the font sets lsb = xMin).
  assert.ok(hit(250, 600) >= 0, 'inside the translated stem');
  assert.ok(hit(650, 100) >= 0, 'inside the translated foot (x 200..700, y 50..200)');
  assert.equal(
    hit(150, 400),
    -1,
    'left of the translated stem: the untranslated L WAS here, and so is the base box',
  );
  assert.equal(
    hit(400, 400),
    -1,
    'inside the base box (100..700 x 0..600) but not in the L: nothing is drawn, nothing is hit',
  );
  assert.equal(hit(650, 700), -1, 'above the foot, inside the box');
  assert.ok(
    fillHits(b, ...at(250, 600), { mode: HitMode.Auto }).length === 1,
    'one glyph, one answer',
  );
  // bbox: the placed L reaches y 750 above the baseline, x 700; the unplaced box stops at y 700
  const bb = b.globalBBox;
  assert.ok(
    bb[3] >= 0.75 - 1e-6 && bb[2] >= 0.6 - 1e-6,
    `globalBBox ${bb.map((v) => +v.toFixed(3))} covers the translated L (0.6 wide, 0.75 high)`,
  );
}
{
  // An unplaced PaintGlyph still hits exactly its own outline, and not the base box around it.
  const b = await build('O');
  const base = b.firstBaselineY,
    at = (fx, fy) => [fx / 1000, base - fy / 1000];
  assert.ok(fillHitShape(b, ...at(150, 400)) >= 0, 'inside the L stem');
  assert.equal(fillHitShape(b, ...at(400, 400)), -1, 'in the base box, outside the L');
}
{
  // Bundles with no COLRv1 glyph are unchanged: no table.
  const plain = new MantleFontAsset(
    new Uint8Array(readFileSync(path.join(HERE, '../fixtures/fonts/gposVarKern.ttf'))),
  );
  const b = await buildStyled([{ text: 'AV', style: defaultStyle() }], plain, {});
  assert.equal(b.colrHit, null);
}
console.log('ok colrPlacedHit');
