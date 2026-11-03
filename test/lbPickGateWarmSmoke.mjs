// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbPickGateWarmSmoke -- every row set the Loop-Blinn pick's bars admit in (0, inf) is in the warm image, not just those inside the viewport-derived scale range.
//
// A static bundle on the unified route under 'auto' picks its mesh or its cover quad per row, on the draw's unit px2 (lbShapePolicy.js rows of bars). Which rows ride as cover quads is part of
// the program key (MANTLE_NO_COVER_FILL, the AAC pick's presence model), and a draw's world matrix takes the unit px2 anywhere, so a draw past the reachable viewport range would ask for a key an
// image limited to that range never evaluates. Pinned: under the opt-in that reaches the policy (staticUnified), bundles whose bars lie below, inside and above the range build nothing, wait for nothing and defer nothing
// through every scale and state. The image's probes leave the pick cache as they found it (a probe that bumps _lbPickKey rebuilds the stream at the next draw). CPU, driver-model stand-in.
import { load, inPlay, clean, say, sweep, doc, fillKeys } from './_scaleWarm.mjs';
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const noCover = (k) => k.split('|').includes('MANTLE_NO_COVER_FILL');
const uni = (k) => k.split('|').includes('MANTLE_LB_FILL');

const CURVES = doc(
  '<path d="M10 10 C 60 0 90 40 80 90 L 20 70 Z" fill="#303"/><path d="M20 20 C 40 10 70 40 60 80 L 30 60 Z" fill="#c33"/>',
);
const BIG_SMALL = doc(
  '<path d="M1 1 C 40 0 80 30 78 79 L 2 70 Z" fill="#303"/><path d="M40 40 c 0.5 -0.5 1 -0.5 1 0 c 0 0.5 -0.5 1 -1 1 z" fill="#c33"/>',
);
const GRADIENT = doc(
  '<path d="M10 10 C 60 0 90 40 80 90 L 20 70 Z" fill="url(#g)"/>',
  '<linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient>',
);
const MANY = doc(
  Array.from(
    { length: 12 },
    (_, k) =>
      `<path d="M${5 + k * 7} 10 C ${8 + k * 7} 5 ${12 + k * 7} 15 ${11 + k * 7} 30 C ${9 + k * 7} 40 ${6 + k * 7} 35 ${5 + k * 7} 10 Z" fill="#a0${k % 10}"/>`,
  ).join(''),
);
const COVERED = doc(
  '<path d="M10 50 C 30 0 70 100 90 50 L 90 90 L 10 90 Z" fill="#fa0" stroke="#123" stroke-width="3"/>',
);

for (const [name, svg] of [
  ['curves', CURVES],
  ['a big and a tiny row', BIG_SMALL],
  ['gradient', GRADIENT],
  ['many rows', MANY],
  ['covered fill', COVERED],
]) {
  console.log(`(${name})`);
  const {
    W,
    R,
    bundles: [b],
  } = await load([svg], { staticUnified: true }, (bs, r) => {
    r.beginFrame([1, 1, 1, 1]);
    for (const x of bs) r.drawBundle(x, {});
    r.endFrame();
  });
  ok(Array.isArray(b._lbMeshes), 'the bundle has its meshes, so the pick decides');
  const img = fillKeys(R, b);
  ok(
    img.some(uni),
    `the image holds unified keys (${img.filter(uni).length} of ${img.length}; ${img.filter(noCover).length} with no cover kernel)`,
  );
  const done = inPlay(W, R);
  await sweep(R, b);
  const r = done();
  ok(clean(r), `scales 2^-14 .. 2^14: ${say(r)}`);
  R.dispose();
}
console.log('(the probes) asking for the image leaves the pick where the draw left it');
{
  const {
    R,
    bundles: [b],
  } = await load([CURVES], { staticUnified: true }, (bs, r) => {
    r.beginFrame([1, 1, 1, 1]);
    r.drawBundle(bs[0], {});
    r.endFrame();
  });
  R.beginFrame([1, 1, 1, 1]);
  R.drawBundle(b, {});
  R.endFrame();
  const key = b._lbPickKey,
    cache = b._lbPickCache,
    cls = b._uniRowClasses;
  R._policy.image(b);
  ok(
    b._lbPickKey === key && b._lbPickCache === cache && b._uniRowClasses === cls,
    `_lbPickKey ${key} -> ${b._lbPickKey}, the pick and class caches are the same objects`,
  );
  R.dispose();
}
console.log('(the pick moves) the sweep really crosses the bars');
{
  const {
    R,
    bundles: [b],
  } = await load([CURVES], { staticUnified: true }, (bs, r) => {
    r.beginFrame([1, 1, 1, 1]);
    r.drawBundle(bs[0], {});
    r.endFrame();
  });
  const seen = new Set();
  for (const k of [2 ** -14, 1, 2 ** 14]) {
    R.beginFrame([1, 1, 1, 1]);
    R.drawBundle(b, { worldMatrix: new Float32Array([k, 0, 0, 0, k, 0, 0, 0, 1]) });
    R.endFrame();
    seen.add(b._lbPickKey | 0);
  }
  ok(seen.size > 1, `the pick answered differently across the scales (${seen.size} answers)`);
  R.dispose();
}
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
