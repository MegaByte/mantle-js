// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// compositeInstancedWarmSmoke -- the group composite's instanced helper is built by the loading call of any scene that can reach it.
//
// A run of two or more group composites (the group atlas, a merged run, a faded instance batch) lands in one instanced draw of its own program (renderer.js _compositeInstanced). Left to the first
// such run, that program would be linked by it and built by the first draw after the link finished, in play, under the stand-in-free default. Pinned: every route to it (authored groups in a plain draw, faded
// instances of a many-leaf bundle, faded instances of one leaf under a matrix that touches alpha) draws its instanced composite in play with no link and no pipeline; the loading call draws it on the
// canvas and on an RGBA8 + depth/stencil target, the two attachment sets a composite lands on, at zero tint; a scene that cannot reach it (nothing to draw, or every bundle one leaf with no recolor
// in its declared reach) does not link it; a renderer without strictPlay does not either. CPU, driver-model stand-in (test/_pendingGl.mjs).
import { load, inPlay, clean, say, sleep, doc, at } from './_scaleWarm.mjs';
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

const ONE = doc('<path d="M10 10 L50 10 L50 50 Z" fill="#f00"/>');
const TWO = doc(
  '<path d="M10 10 L60 10 L60 60 L10 60Z" fill="#f00"/><path d="M30 30 L90 30 L90 90 L30 90Z" fill="#00f"/>',
);
const GROUPS = doc(
  '<g opacity="0.5"><rect x="10" y="10" width="30" height="30" fill="#c00"/><rect x="20" y="20" width="30" height="30" fill="#00c"/></g><g opacity="0.5"><rect x="50" y="50" width="30" height="30" fill="#c00"/><rect x="60" y="60" width="30" height="30" fill="#00c"/></g>',
);
const ALPHA_M = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.5]);
const LABEL = 'compositeInstanced';

/// Count the helper's own draws (the only instanced strip of four vertices) and the targets it was drawn on.
function spy(W) {
  const s = { draws: 0, targets: new Set(), fbo: null };
  const bind = W.gl.bindFramebuffer,
    draw = W.gl.drawArraysInstanced;
  W.gl.bindFramebuffer = (t, f) => {
    if (t === W.gl.FRAMEBUFFER || t === W.gl.DRAW_FRAMEBUFFER) s.fbo = f;
    return bind(t, f);
  };
  W.gl.drawArraysInstanced = (mode, first, count, n) => {
    if (mode === W.gl.TRIANGLE_STRIP && count === 4) {
      s.draws++;
      s.targets.add(s.fbo);
    }
    return draw(mode, first, count, n);
  };
  return s;
}
const warmed = (R) => (R.debugStats.auxWarmed || []).includes(LABEL);

for (const [name, svg, draw] of [
  ['authored groups, a plain draw', GROUPS, (R, b) => R.drawBundle(b, {})],
  [
    'a many-leaf bundle, faded instances',
    TWO,
    (R, b) =>
      R.drawBundleInstanced(b, [
        { worldMatrix: at(0.3), alpha: 0.5 },
        { worldMatrix: at(0.3), alpha: 0.5 },
      ]),
  ],
  [
    'one leaf, faded instances under a matrix that touches alpha',
    ONE,
    (R, b) =>
      R.drawBundleInstanced(
        b,
        [
          { worldMatrix: at(0.3), alpha: 0.5 },
          { worldMatrix: at(0.3), alpha: 0.4 },
        ],
        { colorMatrix: ALPHA_M },
      ),
  ],
]) {
  console.log(`(${name})`);
  let s;
  const {
    W,
    R,
    bundles: [b],
  } = await load([svg], {}, (bs, r, w) => {
    s = spy(w);
  });
  ok(warmed(R), 'the loading call built the helper');
  ok(
    s.targets.has(null) && s.targets.size === 2,
    `on the canvas and on a target (${s.targets.size} targets, ${s.draws} draws)`,
  );
  const d0 = s.draws,
    done = inPlay(W, R);
  for (let i = 0; i < 3; i++) {
    R.beginFrame([1, 1, 1, 1]);
    draw(R, b);
    R.endFrame();
    await sleep(4);
  }
  const r = done();
  ok(s.draws > d0, `play reached the instanced composite (${s.draws - d0} draws)`);
  ok(clean(r) && r.links === 0, `in play: ${say(r)}`);
  R.dispose();
}
console.log(
  '(a many-leaf scene with a reach that names no recolor) leaves that can overlap are enough',
);
{
  const { R } = await load([TWO], {}, (bs, r) => r.declareReach(bs[0], ['rotate']));
  ok(warmed(R), 'the helper is built');
  R.dispose();
}
console.log('(no route to it) no program');
{
  const { R, W } = await load([ONE, ONE], {}, (bs, r) => {
    for (const b of bs) r.declareReach(b, ['rotate']);
  });
  const { R: R2, W: W2 } = await load([ONE, ONE]);
  ok(!warmed(R), `every bundle one leaf, no recolor declared: not built (${W.model.links} links)`);
  ok(
    warmed(R2) && W2.model.links >= W.model.links,
    `the same scene undeclared can recolor, so it is built (${W2.model.links} links)`,
  );
  R.dispose();
  R2.dispose();
  const { R: R3 } = await load([]);
  ok(!warmed(R3), 'an empty scene: not built');
  R3.dispose();
}
console.log('(no strict play) the loading call is unchanged');
{
  const { R } = await load([GROUPS], { strictPlay: false, standIns: undefined });
  ok(!warmed(R), 'not built by a renderer without strictPlay');
  R.dispose();
}
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
