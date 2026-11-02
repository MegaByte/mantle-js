// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeStripGateNeutralSmoke -- the stroke strip policy is key-neutral: its bars move which cover vertices a row draws and the depth claim, never a program, a vertex layout or a target.
//
// In 'auto' a stroke row takes its strip where the device pixels it saves per vertex reach a threshold (unifiedFillDraw.js stripTake), and a draw's world matrix takes that anywhere in (0, inf), far
// past the viewport-derived range _deriveSizeRegions lists the bars for. The gate writes c._stripOn, bundle._stripModeNow and bundle._stripKey. selectFillVariant reads none of them; the strip's
// vertices live in the same buffer and layout as the quads; the claim sets depth state, which is not part of the program or of the pipeline's attachments. Pinned, so that an edit that lets the
// gate reach a key fails here: the sweep crosses the bar (a row on its strip and a row on its quad both occur, the overlapping strip's claim too), the program set drawn is one per draw state and
// the image is the same size as with strips off, and nothing builds, waits or defers. CPU, driver-model stand-in (test/_pendingGl.mjs).
import { load, inPlay, clean, say, sweep, doc, fillKeys, at, SCALES } from './_scaleWarm.mjs';
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

const PLAIN = doc(
  '<path d="M10 50 C 30 0 70 100 90 50" fill="none" stroke="#123" stroke-width="6" stroke-linecap="round"/>',
);
const LOOP = doc(
  '<path d="M10 50 C 90 0 90 100 10 50 C 40 20 60 20 90 50" fill="none" stroke="#a00" stroke-width="9"/>',
);
const HAIR = doc(
  '<path d="M10 20 L 90 80 M10 80 L90 20" fill="none" stroke="#123" stroke-width="0.4"/>',
);
const DASHED = doc(
  '<path d="M10 50 C 30 0 70 100 90 50" fill="none" stroke="#a00" stroke-width="3" stroke-dasharray="6 4"/>',
);

for (const [name, svg] of [
  ['a stroke', PLAIN],
  ['a self-crossing stroke', LOOP],
  ['a hairline', HAIR],
  ['a dashed stroke', DASHED],
]) {
  console.log(`(${name})`);
  const {
    W,
    R,
    bundles: [b],
  } = await load([svg]);
  const {
    R: R0,
    bundles: [b0],
  } = await load([svg], { strokeStrip: false });
  ok(b._stripChunks && b._stripChunks.length > 0, 'the bundle has strips');
  const keys = fillKeys(R, b).slice().sort().join('\n'),
    keys0 = fillKeys(R0, b0).slice().sort().join('\n');
  ok(keys === keys0, `the image is the image with strips off (${fillKeys(R, b).length} keys)`);
  R0.dispose();
  const seen = new Set(),
    modes = new Set();
  const useProgram = W.gl.useProgram,
    drawn = new Set();
  W.gl.useProgram = (p) => {
    if (p) drawn.add(p);
    return useProgram(p);
  };
  const done = inPlay(W, R);
  for (const k of SCALES) {
    R.beginFrame([1, 1, 1, 1]);
    R.drawBundle(b, { worldMatrix: at(k) });
    R.endFrame();
    seen.add(b._stripKey);
    modes.add(b._stripModeNow);
  }
  ok(
    seen.size >= 2,
    `the gate moved with the scale (${seen.size} strip states, modes ${[...modes].sort().join(',')})`,
  );
  await sweep(R, b);
  const r = done();
  ok(clean(r), `scales 2^-14 .. 2^14: ${say(r)}`);
  R.dispose();
}
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
