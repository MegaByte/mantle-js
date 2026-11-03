// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// aacPointsScaleNeutralSmoke -- the small-shape points route is neutral to a world matrix under the stand-in-free policy: a scale the image never saw takes the cover key, linking and building nothing.
//
// The route takes a bundle whose drawn shapes are small (aacPointsDraw.js), and a world matrix makes any bundle small. Its program is not in the image of a bundle that is large at every warmed size,
// and warming one per bundle for scales that may never come would add programs with no draw to justify them. So the route declines to the cover key, which paints the same AAC coverage and is
// in the image, and it starts no link in play: a link is compile work in the GPU process, ahead of every frame, for a program the draw is not going to use. Pinned: through every scale and state nothing
// links, builds, waits or defers; a bundle whose program IS in the image still takes the route. CPU, driver-model stand-in (test/_pendingGl.mjs).
import { load, inPlay, clean, say, sweep, doc, at, SCALES } from './_scaleWarm.mjs';
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const POINTS = '\u0000points-route';

const LARGE = doc('<path d="M20 50 A30 30 0 1 1 80 50 A30 30 0 1 1 20 50Z" fill="#f00"/>');
const STROKE = doc(
  '<path d="M10 50 C 30 0 70 100 90 50" fill="none" stroke="#123" stroke-width="6"/>',
);
const HAIR = doc(
  '<path d="M10 20 L 90 80 M10 80 L90 20" fill="none" stroke="#123" stroke-width="0.4"/>',
);
// (its stroked, patterned, every-curve-type point program is a superset of the others': the load starts the widest of a class, and a draw of a narrower one asks for its own)
const WIDE = doc(
  '<path d="M10 50 L20 20 Q40 5 50 20 C60 30 70 10 80 20 A10 10 0 1 1 80 50 Z" fill="url(#p)" stroke="#123" stroke-width="2"/>',
  '<pattern id="p" width="4" height="4" patternUnits="userSpaceOnUse"><rect width="2" height="2" fill="#a00"/></pattern>',
);
const TINY = doc(
  Array.from(
    { length: 20 },
    (_, i) => `<path d="M${5 + i * 4} 10 c1 -1 2 -1 2 0 c0 1 -1 2 -2 2 z" fill="#a0${i % 10}"/>`,
  ).join(''),
  '',
  '0 0 100 30',
);

console.log(
  '(a scene) a large arc, a stroke and a hairline, beside a bundle that holds a wider point program',
);
{
  const { W, R, bundles } = await load([LARGE, STROKE, HAIR, WIDE, TINY]);
  const done = inPlay(W, R);
  for (const b of bundles) await sweep(R, b);
  for (let i = 0; i < 20; i++) {
    R.beginFrame([1, 1, 1, 1]);
    R.endFrame();
    await new Promise((r) => setTimeout(r, 2));
  }
  const r = done();
  ok(clean(r) && r.links === 0, `scales 2^-14 .. 2^14, then idle frames: ${say(r)}`);
  R.dispose();
}
console.log('(tiny shapes) the route still takes a bundle whose point program is in the image');
{
  const {
    W,
    R,
    bundles: [b],
  } = await load([TINY]);
  ok(
    R._policy.image(b).some((e) => e.key.startsWith(POINTS)),
    'its image holds the point program',
  );
  const before = (R.debugStats.pointsStats && R.debugStats.pointsStats.asks) | 0;
  const done = inPlay(W, R);
  for (const k of SCALES) {
    R.beginFrame([1, 1, 1, 1]);
    R.drawBundle(b, { worldMatrix: at(k) });
    R.endFrame();
  }
  const r = done();
  ok(clean(r) && r.links === 0, `scales 2^-14 .. 2^14: ${say(r)}`);
  ok(
    R.debugStats.pointsStats && R.debugStats.pointsStats.asks > before,
    `the route was asked (${R.debugStats.pointsStats && R.debugStats.pointsStats.asks} asks)`,
  );
  R.dispose();
}
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
