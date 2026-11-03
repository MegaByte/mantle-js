// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// poseDirectWarmSmoke -- a morph's source pose drawn directly is in the warm image of a stand-in-free renderer.
//
// createShapeMorph marks its two poses, and the automatic prewarm can skip them (fillPass.js _skipMorphSource, a memory opt-in: warmMorphSources), so the loading call would not see a pose. An app that draws
// a pose beside its timeline (a held frame, a thumbnail) would then build its program's pipeline in play, which the stand-in-free policy exists to rule out. Pinned: under strictPlay's default, a pose drawn
// directly, beside its timeline, under every warm state and through every scale, links nothing, builds nothing, waits for nothing and defers nothing, and the same holds for a morph's own poses; the
// timeline's own pairs stay warm. `warmMorphSources: false` skips the poses, and a renderer without strictPlay still skips them. CPU, driver-model stand-in (test/_pendingGl.mjs).
import { load, inPlay, clean, say, sweep, doc, at, SCALES, STATES, sleep } from './_scaleWarm.mjs';
const { createShapeTimeline, createShapeMorph } = await import('../src/index.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const POSE = (d) =>
  doc(
    `<path d="M${20 - d} 50 C${20 - d} ${20 - d} ${80 + d} ${20 - d} ${80 + d} 50 C80 80 20 80 ${20 - d} 50Z" fill="#f00"/><path d="M40 40 L60 40 L50 70Z" fill="#00f"/>`,
  );
const STROKED = (d) =>
  doc(
    `<path d="M${20 - d} 50 C${20 - d} ${20 - d} ${80 + d} ${20 - d} ${80 + d} 50 C80 80 20 80 ${20 - d} 50Z" fill="#f00" stroke="#123" stroke-width="3"/>`,
  );
const timeline = (bs, R, W) => {
  const tl = createShapeTimeline(W.gl, bs, [
    { time: 0, bundleIndex: 0 },
    { time: 1, bundleIndex: 1 },
  ]);
  tl.setTime(0.3);
  return tl;
};

console.log('(a pose beside its timeline) the first draw of each pose');
{
  let tl;
  const {
    W,
    R,
    bundles: [A, B],
  } = await load([POSE(0), POSE(5)], {}, (bs, r, w) => {
    tl = timeline(bs, r, w);
  });
  const done = inPlay(W, R);
  R.beginFrame([1, 1, 1, 1]);
  R.drawBundle(A, {});
  R.drawBundle(B, {});
  R.drawBundle(tl.bundle, { morphT: tl.t });
  R.endFrame();
  const r = done();
  ok(clean(r) && r.links === 0, `in play: ${say(r)}`);
  tl.dispose();
  R.dispose();
}
console.log("(with a declared reach) a pose declared with the game's tags");
{
  let tl;
  const {
    W,
    R,
    bundles: [A, B],
  } = await load([POSE(0), POSE(5)], {}, (bs, r, w) => {
    for (const b of bs) r.declareReach(b, ['recolor', 'rotate', 'channelLerp']);
    tl = timeline(bs, r, w);
  });
  const done = inPlay(W, R);
  R.beginFrame([1, 1, 1, 1]);
  for (const st of STATES) {
    const { rot, ...rest } = st;
    R.drawBundle(A, { worldMatrix: at(1, 1, rot), ...rest });
    R.drawBundle(B, { worldMatrix: at(1, 1, rot), ...rest });
  }
  R.drawBundle(tl.bundle, { morphT: tl.t });
  R.endFrame();
  const r = done();
  ok(clean(r) && r.links === 0, `every warm state: ${say(r)}`);
  tl.dispose();
  R.dispose();
}
console.log("(through every scale) a pose, its stroke under the no-AA gate, a plain morph's poses");
{
  let tl, m;
  const {
    W,
    R,
    bundles: [A, B, C, D],
  } = await load([POSE(0), POSE(5), STROKED(0), STROKED(5)], {}, (bs, r, w) => {
    tl = timeline(bs.slice(0, 2), r, w);
    m = createShapeMorph(w.gl, bs[2], bs[3]);
  });
  const done = inPlay(W, R);
  for (const b of [A, B, C, D]) await sweep(R, b);
  const r = done();
  ok(clean(r), `scales 2^-14 .. 2^14: ${say(r)}`);
  R.beginFrame([1, 1, 1, 1]);
  R.drawBundle(tl.bundle, { morphT: tl.t });
  R.drawBundle(m.bundle, { morphT: 0.5 });
  R.endFrame();
  await sleep(2);
  const r2 = done();
  ok(clean(r2), `the morphs afterwards: ${say(r2)}`);
  tl.dispose();
  R.dispose();
}
console.log('(opted out) warmMorphSources: false keeps the poses out, the explicit memory choice');
{
  let tl;
  const {
    W,
    R,
    bundles: [A],
  } = await load([POSE(0), POSE(5)], { warmMorphSources: false }, (bs, r, w) => {
    tl = timeline(bs, r, w);
  });
  const done = inPlay(W, R);
  R.beginFrame([1, 1, 1, 1]);
  R.drawBundle(A, {});
  R.endFrame();
  const r = done();
  ok(r.pipelines === 1, `the pose builds at its first draw, as documented: ${say(r)}`);
  tl.dispose();
  R.dispose();
}
console.log('(no strict play) the skip is unchanged: nothing warms a pose');
{
  let tl;
  const {
    W,
    R,
    bundles: [A, B],
  } = await load([POSE(0), POSE(5)], { strictPlay: false, standIns: undefined }, (bs, r, w) => {
    tl = timeline(bs, r, w);
  });
  ok(A._morphSourcePose === true && B._morphSourcePose === true, 'the poses are marked');
  const seen = (R.debugStats.needMiss && R.debugStats.needMiss.bindSetImage) | 0;
  ok(seen === 0, `no bind-set pass ran over them (image ${seen})`);
  tl.dispose();
  R.dispose();
  void W;
}
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
