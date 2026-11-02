// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// noAaGateWarmSmoke -- the no-AA gates' two outcomes are both in the warm image: their bar is a stroke's width in device pixels, which a draw's world matrix moves to any value.
//
// A fill under an opaque stroke draws no-AA (MANTLE_HARD; per row, MANTLE_HARD_MIXED) while the stroke is at least 2 device px wide, in its smallest direction (fillPass.js preferNoAa,
// preferNoAaMixed: minStrokeEmW x minLinearScalePx). The image asked the gate at the viewport-derived sizes only, where the stroke is wide, so the first draw below the bar built the AA
// key in play. Pinned: the image holds both sides; through every scale and state, uniform and stretched, nothing builds, waits or defers; a bundle no gate applies to gains no key.
// CPU, driver-model stand-in (test/_pendingGl.mjs).
import { load, inPlay, clean, say, sweep, doc, fillKeys } from './_scaleWarm.mjs';
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const hard = (k) => k.split('|').includes('MANTLE_HARD');
const mixed = (k) => k.split('|').includes('MANTLE_HARD_MIXED');

const COVERED_LINE = doc(
  '<path d="M10 10 L90 10 L90 90 L10 90 Z" fill="#fa0" stroke="#123" stroke-width="3"/>',
);
const COVERED_CUBIC = doc(
  '<path d="M10 50 C 30 0 70 100 90 50 L 90 90 L 10 90 Z" fill="#fa0" stroke="#123" stroke-width="3"/>',
);
const SOME_COVERED = doc(
  '<path d="M10 10 L50 10 L50 50 L10 50 Z" fill="#fa0" stroke="#123" stroke-width="3"/><path d="M60 60 C 70 50 90 50 90 90 Z" fill="#0af"/>',
);
const UNCOVERED = doc('<path d="M10 10 C 60 0 90 40 80 90 L 20 70 Z" fill="#303"/>');

console.log('(whole bundle) every fill under its stroke, lines and cubics');
for (const [name, svg] of [
  ['line', COVERED_LINE],
  ['cubic', COVERED_CUBIC],
]) {
  const {
    W,
    R,
    bundles: [b],
  } = await load([svg]);
  ok(b.noAaFill === true, `${name}: the importer proves the fill covered`);
  const img = fillKeys(R, b);
  ok(
    img.some(hard) && img.some((k) => !hard(k)),
    `${name}: the image has both sides of the bar (${img.filter(hard).length} no-AA + ${img.filter((k) => !hard(k)).length} AA keys)`,
  );
  const done = inPlay(W, R);
  await sweep(R, b);
  const r = done();
  ok(clean(r), `${name}, scales 2^-14 .. 2^14: ${say(r)}`);
  R.dispose();
}
console.log('(per row) some fills under their strokes');
{
  const {
    W,
    R,
    bundles: [b],
  } = await load([SOME_COVERED]);
  ok(b.noAaMixed === true && !b.noAaFill, 'the importer stamps the covered row only');
  const img = fillKeys(R, b);
  ok(
    img.some(mixed) && img.some((k) => !mixed(k)),
    `the image has both sides of the bar (${img.filter(mixed).length} mixed + ${img.filter((k) => !mixed(k)).length} plain keys)`,
  );
  const done = inPlay(W, R);
  await sweep(R, b);
  const r = done();
  ok(clean(r), `scales 2^-14 .. 2^14: ${say(r)}`);
  R.dispose();
}
console.log('(no gate) a bundle with no covered fill gains no key');
{
  const {
    R,
    bundles: [b],
  } = await load([UNCOVERED]);
  const img = fillKeys(R, b);
  ok(!img.some(hard) && !img.some(mixed), `no no-AA key in its image (${img.length} keys)`);
  R.dispose();
}
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
