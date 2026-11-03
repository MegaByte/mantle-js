// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// patternTileGateWarmSmoke -- the pattern minification gate's two outcomes are both in the warm image: its bar is a tile's size in device pixels, which a draw's world matrix moves to any value.
//
// A draw whose inline vector pattern may have a tile finer than two device pixels keeps the tile-mean code; every other leaves it out (fillPass.js MANTLE_NO_PATTERN_MEAN, shapeScale.js
// patternHasFineTile). The image asked the gate at the viewport-derived sizes only. Pinned: the image holds both sides; through every scale and state, uniform and stretched, nothing builds,
// waits or defers; a bundle with no pattern gains no key. CPU, driver-model stand-in (test/_pendingGl.mjs).
import { load, inPlay, clean, say, sweep, doc, fillKeys } from './_scaleWarm.mjs';
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const lean = (k) => k.split('|').includes('MANTLE_NO_PATTERN_MEAN');

const PAT = (tile) =>
  doc(
    '<rect x="0" y="0" width="100" height="100" fill="url(#p)"/>',
    `<pattern id="p" width="${tile}" height="${tile}" patternUnits="userSpaceOnUse"><rect width="${tile / 2}" height="${tile / 2}" fill="#a00"/><circle cx="${tile * 0.75}" cy="${tile * 0.75}" r="${tile / 4}" fill="#00a"/></pattern>`,
  );

for (const tile of [4, 0.5, 0.01]) {
  console.log(`(tile ${tile} em)`);
  const {
    W,
    R,
    bundles: [b],
  } = await load([PAT(tile)]);
  const img = fillKeys(R, b);
  ok(
    img.some(lean) && img.some((k) => !lean(k)),
    `the image has both sides of the bar (${img.filter(lean).length} lean + ${img.filter((k) => !lean(k)).length} tile-mean keys)`,
  );
  const done = inPlay(W, R);
  await sweep(R, b);
  const r = done();
  ok(clean(r), `scales 2^-14 .. 2^14: ${say(r)}`);
  R.dispose();
}
console.log('(no pattern) a bundle without one gains no key');
{
  const {
    R,
    bundles: [b],
  } = await load([doc('<path d="M10 10 C 60 0 90 40 80 90 L 20 70 Z" fill="#303"/>')]);
  const img = fillKeys(R, b);
  ok(
    img.every((k) => k.split('|').includes('MANTLE_NO_PATTERN')),
    `its keys all omit the pattern block (${img.length} keys)`,
  );
  R.dispose();
}
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
