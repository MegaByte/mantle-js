// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// instancedScaleNeutralSmoke -- the instanced fast path's engine pick is neutral to the instances' world matrices, so warming both engines only for a bar inside the viewport range is exact.
//
// R._instBothEngines (fillPass.js _deriveSizeRegions, warmCover) asks for the other engine's instanced program only when the classic AAC bar lies inside the viewport-derived scale range. That is
// not the scale assumption drawBundle cannot make (test/groupTargetPickWarmSmoke.mjs): the fast path binds ONE program for all its instances, selected before any of them is looked at, with the draw's world matrix
// cleared by setBundle, so the pick reads the viewport fit alone (shapeScale.unitPx2 with no world matrix); each instance's matrix is only an attribute. A world matrix cannot move it. Pinned: bundles
// whose bar lies below, inside and above the range take the fast path at every scale, axis-aligned and rotated, tinted and not, faded, and link nothing, build nothing, wait for nothing, defer
// nothing; the per-instance loop (a real color matrix) draws through K, which the image holds. The gate adds no program. CPU, driver-model stand-in (test/_pendingGl.mjs).
import { load, inPlay, clean, say, sleep, doc, at, SCALES, TINT } from './_scaleWarm.mjs';
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

const blob = (i, d) =>
  `<path d="M${5 + i * 4} 10 c${d} -${d} ${2 * d} -${d} ${2 * d} 0 c0 ${d} -${d} ${2 * d} -${2 * d} ${2 * d} z" fill="#a0${i % 10}"/>`;
const SETS = {
  'tiny shapes': doc(
    Array.from({ length: 20 }, (_, i) => blob(i, 0.05)).join(''),
    '',
    '0 0 100 30',
  ),
  'small shapes': doc(Array.from({ length: 20 }, (_, i) => blob(i, 1)).join(''), '', '0 0 100 30'),
  'large shapes': doc(
    '<path d="M10 10 C 60 0 90 40 80 90 L 20 70 Z" fill="#303"/><path d="M20 20 C 40 10 70 40 60 80 L 30 60 Z" fill="#c33"/>',
  ),
  lines: doc(
    '<path d="M10 10 L45 10 L45 45 L10 45Z" fill="#f00"/><path d="M55 55 L90 55 L90 90 L55 90Z" fill="#00f"/>',
  ),
};
for (const [name, svg] of Object.entries(SETS)) {
  console.log(`(${name})`);
  const {
    W,
    R,
    bundles: [b],
  } = await load([svg]);
  const done = inPlay(W, R),
    fast0 = R.debugStats.instancedFastCount | 0;
  let asked = 0;
  for (const k of SCALES) {
    for (const list of [
      [{ worldMatrix: at(k) }, { worldMatrix: at(k * 1.5) }],
      [{ worldMatrix: at(k, k, 0.5) }, { worldMatrix: at(k, k, 0.7) }],
      [{ worldMatrix: at(k * 8, k / 8) }, { worldMatrix: at(k / 8, k * 8) }],
      [
        { worldMatrix: at(k), tint: [1, 0, 0, 1] },
        { worldMatrix: at(k), tint: [0, 1, 0, 1] },
      ],
      [
        { worldMatrix: at(k), alpha: 0.5 },
        { worldMatrix: at(k, k), alpha: 0.5 },
      ],
      [
        { worldMatrix: at(k), ...TINT },
        { worldMatrix: at(k * 1.5), ...TINT },
      ],
    ]) {
      // (three frames, a little apart: a program a draw started would be linked and take the fast path by the third, building its pipeline)
      for (
        let rep = 0;
        rep < (k === SCALES[0] || k === SCALES[28] || k === SCALES[56] ? 3 : 1);
        rep++
      ) {
        R.beginFrame([1, 1, 1, 1]);
        R.drawBundleInstanced(b, list);
        R.endFrame();
        asked++;
        if (rep) await sleep(4);
      }
    }
  }
  const r = done(),
    fast = (R.debugStats.instancedFastCount | 0) - fast0;
  ok(fast > 0, `the fast path drew (${fast} of ${asked} calls)`);
  ok(clean(r) && r.links === 0, `scales 2^-14 .. 2^14: ${say(r)}`);
  R.dispose();
}
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
