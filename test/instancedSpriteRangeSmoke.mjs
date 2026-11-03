// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// instancedSpriteRangeSmoke: drawSpriteInstanced on the instanced fast path draws only the sprite's rows, not the whole sheet
// (node, fake GL). Every instanced draw call is recorded as [first, count, instances] and compared with the sprite's vertex run.
import { M, wrap, imp, mkRenderer, check, finish } from './_exportHarness.mjs';

const { R, gl } = await mkRenderer(100, 100, { captureFrames: false });
R.setLoopBlinnFill('off');
const rect = (id, x, y, f) =>
  `<rect id="${id}" x="${x}" y="${y}" width="30" height="30" fill="${f}"/>`;
const bundle = M.createBundle(
  gl,
  await imp(
    wrap(
      rect('red', 0, 0, 'red') +
        '<g id="pair">' +
        rect('b1', 50, 0, 'blue') +
        rect('b2', 60, 10, 'navy') +
        '</g>' +
        rect('green', 0, 50, 'green'),
    ),
  ),
);
const calls = [];
const draw = gl.drawArraysInstanced.bind(gl);
gl.drawArraysInstanced = (mode, first, count, n) => {
  calls.push([first, count, n]);
  return draw(mode, first, count, n);
};
const place = [
  { worldMatrix: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]) },
  { worldMatrix: new Float32Array([1, 0, 0, 0, 1, 0, 0.1, 0, 1]) },
];
const run = (f) => {
  calls.length = 0;
  R.beginFrame([1, 1, 1, 1]);
  f();
  R.endFrame();
  return calls.map((c) => c.join(',')).join(';');
};
const sheet = run(() => R.drawBundleInstanced(bundle, place));
check('the whole sheet is one instanced draw of 4 quads x 6 vertices', sheet === '0,24,2', sheet);
const first = run(() => R.drawSpriteInstanced(bundle, 'red', place));
check('the first sprite draws its own 6 vertices', first === '0,6,2', first);
const pair = run(() => R.drawSpriteInstanced(bundle, 'pair', place));
check('a two-shape sprite draws its 12 vertices from the middle', pair === '6,12,2', pair);
const last = run(() => R.drawSpriteInstanced(bundle, 'green', place));
check('the last sprite draws its own 6 vertices', last === '18,6,2', last);
const again = run(() => R.drawBundleInstanced(bundle, place));
check('the range does not leak into the next whole-sheet draw', again === sheet, again);
finish('instancedSpriteRangeSmoke');
