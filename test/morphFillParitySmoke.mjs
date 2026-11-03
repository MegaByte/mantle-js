// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// morphFillParitySmoke -- a morph bundle carries its poses' segment-type mask and segment count, so the engine inputs auto reads (the px^2 floor
// per type set, segments per shape) are those of the poses, not createBundle's defaults (all types, no segments). With the defaults a line/quadratic card
// morph would report mask 15 and 0 segments/shape while each static pose reports mask 3 and 35, and auto would draw the morph with a different kernel.
import { createFakeGl } from './_fakeGl.mjs';
import { createBundle } from '../src/renderer/bundle.js';
import { createShapeMorph } from '../src/animation/shapeMorph.js';
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
const { default: importSvg } = await import('../src/svg/importer.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const { gl } = createFakeGl();
const card = (r) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#fff" fill-opacity="0.2" d="M${r} 10 L${100 - r} 10 Q90 10 90 ${r} L90 ${90 - r} Q90 90 ${100 - r} 90 L${r} 90 Q10 90 10 ${90 - r} L10 ${r} Q10 10 ${r} 10 Z"/></svg>`;
const a = createBundle(gl, await importSvg(card(10))),
  b = createBundle(gl, await importSvg(card(24)));
const m = createShapeMorph(gl, a, b);
m.setT(0);
ok(
  a.segTypeMask === 3 && b.segTypeMask === 3,
  `each static pose is line+quadratic only (mask ${a.segTypeMask}/${b.segTypeMask})`,
);
ok(
  m.bundle.segTypeMask === 3,
  `the morph bundle holds the same mask (${m.bundle.segTypeMask}; createBundle's default is 15)`,
);
ok(
  m.bundle.meanSegsPerShape > 0 &&
    Math.abs(m.bundle.meanSegsPerShape - a.meanSegsPerShape) <= a.meanSegsPerShape * 0.5,
  `and a segment count of the poses' order (${m.bundle.meanSegsPerShape} against ${a.meanSegsPerShape})`,
);
const c = createBundle(
  gl,
  await importSvg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#000" d="M10 90 C20 10 80 10 90 90 Z"/></svg>',
  ),
);
const m2 = createShapeMorph(gl, a, c);
ok(
  (m2.bundle.segTypeMask & 4) !== 0 && (m2.bundle.segTypeMask & 3) === 3,
  `a morph from a quadratic pose to a cubic one holds the union (${m2.bundle.segTypeMask})`,
);
const empty = createBundle(gl, await importSvg('<svg xmlns="http://www.w3.org/2000/svg"/>'));
const invisible = createBundle(
  gl,
  await importSvg(
    '<svg xmlns="http://www.w3.org/2000/svg"><path fill-opacity="0" d="M0 0H10V10H0Z"/></svg>',
    { keepInvisibleShapes: false },
  ),
);
const line = createBundle(
  gl,
  await importSvg('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0H10V10H0Z"/></svg>'),
);
const arc = createBundle(
  gl,
  await importSvg(
    '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 10A10 10 0 0 1 20 10L0 10Z"/></svg>',
  ),
);
ok(
  empty.numShapes === 0 && invisible.numShapes === 0,
  'empty and transparent inputs contain no rendered rows',
);
ok((arc.segTypeMask & 8) !== 0, 'arc control retains its native curve type');
for (const absent of [empty, invisible])
  for (const pose of [line, a, c, arc]) {
    for (const [src, dst] of [
      [absent, pose],
      [pose, absent],
    ]) {
      const fade = createShapeMorph(gl, src, dst);
      ok(
        fade.bundle.segTypeMask === pose.segTypeMask,
        `an empty endpoint contributes no curve types (${fade.bundle.segTypeMask} vs ${pose.segTypeMask})`,
      );
      fade.setT(0.5);
      fade.dispose();
    }
  }
const emptyPair = createShapeMorph(gl, empty, invisible);
ok(
  emptyPair.bundle.numShapes === 0 && emptyPair.bundle.segTypeMask === 15,
  'both-empty pair retains the conservative default',
);
const unknown = createBundle(gl, {
  ...(await importSvg('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0H10V10H0Z"/></svg>')),
  segTypeMask: undefined,
});
const unknownFade = createShapeMorph(gl, empty, unknown);
ok(
  unknown.numShapes > 0 && unknownFade.bundle.segTypeMask === 15,
  'a nonempty endpoint with unknown types remains conservative',
);
for (const resource of [
  unknownFade,
  emptyPair,
  m2,
  m,
  unknown,
  arc,
  line,
  invisible,
  empty,
  a,
  b,
  c,
])
  resource.dispose();
if (fail) {
  console.error(`FAIL morphFillParitySmoke: ${fail}`);
  process.exit(1);
}
console.log('morphFillParitySmoke PASS');
