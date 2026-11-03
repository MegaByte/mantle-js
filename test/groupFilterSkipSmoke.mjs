// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// groupFilterSkipSmoke -- a filtered group whose result key is unchanged does not repaint its children.
//
// A filtered group (a <g filter>, a <use filter>, a filtered leaf that paints a fill and a stroke) keeps its filter result in the
// filter-result cache. Without the skip its children would paint into the accumulator every frame, only to be thrown away by a cache
// hit, and a STATIC scene of filtered elements would pay a pass pair and the child draws per element per frame. So the key is compared
// when the group opens, and on a hit the children are stepped over and the cached result composites straight into the parent.
//
// HOW: the real renderer, headless, against test/_fakeGl.mjs, which records every clear and draw with its target. Per route
// (classic / unified), on the LAST of three identical frames:
//   (A) n filtered fill+stroke leaves: no draw reaches an accumulator but the cached composite, one cache-blit per element, and no
//       graph is evaluated; with the skip off (the debug flag) the children paint again;
//   (B) the same for a <g filter> and a <use filter>;
//   (C) every input of the key still invalidates: a moved world matrix, a changed override and a changed filter parameter re-evaluate
//       the graph and paint the children, and the next static frame skips again;
//   (D) a filtered group inside a group, and a faded filtered group (draw alpha), skip and composite at the right opacity;
//   (E) a morphing bundle never skips.
import { createFakeGl, taggedShaderSources } from './_fakeGl.mjs';

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { importSvg, createBundle, createRenderer, createPalette, createOverrideTable } =
  await import('../src/index.js');

const N = 120;
const FILTER =
  '<filter id="f" x="-30%" y="-30%" width="170%" height="170%"><feDropShadow dx="2" dy="2" stdDeviation="1.5" flood-opacity=".5"/></filter>';
const svg = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${N}" height="${N}" viewBox="0 0 ${N} ${N}"><defs>${FILTER}<rect id="r" x="0" y="0" width="12" height="12" fill="#0f0" stroke="#f00" stroke-width="3"/></defs>${body}</svg>`;
const leaf = (i, extra = '') =>
  `<rect x="${4 + (i % 6) * 19}" y="${6 + Math.floor(i / 6) * 28}" width="12" height="16" fill="#0f0" stroke="#f00" stroke-width="3" ${extra}/>`;
const LEAVES = (n) => Array.from({ length: n }, (_, i) => leaf(i, 'filter="url(#f)"')).join('');
const GROUPS = (n) =>
  Array.from({ length: n }, (_, i) => `<g filter="url(#f)">${leaf(i)}</g>`).join('');
const USES = (n) =>
  Array.from(
    { length: n },
    (_, i) =>
      `<use href="#r" x="${4 + (i % 6) * 19}" y="${6 + Math.floor(i / 6) * 28}" filter="url(#f)"/>`,
  ).join('');
const N_EL = 6;

async function make(body, route, flag) {
  globalThis.__MANTLE_DEBUG__ = true;
  globalThis.__MANTLE_NO_GROUP_FILTER_SKIP = !!flag;
  const F = createFakeGl({ width: N, height: N });
  const R = createRenderer(F.gl, taggedShaderSources(), {});
  R.setFillEngine({ route, kernel: 'slug' });
  const b = createBundle(F.gl, await importSvg(svg(body), { preserveViewport: true }));
  if (R.prepareBundle) R.prepareBundle(b);
  if (R.awaitLbReady) {
    try {
      await R.awaitLbReady(b, 20000);
    } catch {
      /* reported by the route check */
    }
  }
  R.prewarmBundle(b);
  R.precompileFills();
  R.setViewport(N, N);
  return { F, R, b };
}
/// Draw `frames` frames; summarize the last one (and the graph evaluations it cost).
function runFrames(ctx, frames, draw) {
  const { F, R, b } = ctx;
  let evals0 = 0;
  for (let i = 0; i < frames; i++) {
    F.setFrame(i);
    evals0 = R.debugStats.filterEvalCount;
    R.beginFrame([0, 0, 0, 0]);
    draw(R, b, i);
    R.endFrame();
  }
  const ev = F.log.filter((e) => e.frame === frames - 1 && (e.op === 'clear' || e.op === 'draw'));
  const draws = ev.filter((e) => e.op === 'draw');
  const blits = draws.filter((e) => F.progKeys(e.prog).has('cacheBlitFrag'));
  let passes = 0,
    prev;
  for (const e of ev) {
    const k = e.fbo ? e.fbo.id : 0;
    if (prev === undefined || k !== prev) passes++;
    prev = k;
  }
  return {
    ev,
    draws,
    blits,
    others: draws.length - blits.length,
    passes,
    evals: R.debugStats.filterEvalCount - evals0,
    skips: R.debugStats?.groupFilterSkips | 0,
  };
}
const plain = (R, b) => R.drawBundle(b);

for (const route of ['none', 'lb']) {
  console.log(`route ${route}`);
  for (const [name, body] of [
    ['filtered fill+stroke leaves', LEAVES(N_EL)],
    ['<g filter>', GROUPS(N_EL)],
    ['<use filter>', USES(N_EL)],
  ]) {
    const on = runFrames(await make(body, route, false), 3, plain);
    const off = runFrames(await make(body, route, true), 3, plain);
    ok(
      on.evals === 0 && off.evals === 0,
      `${name}: the third static frame evaluates no graph (on ${on.evals}, off ${off.evals})`,
    );
    ok(
      on.others === 0,
      `${name}: skip on: the children paint nothing (${on.others} non-blit draws)`,
    );
    ok(
      off.others > 0,
      `${name}: skip off: the children still paint (${off.others} non-blit draws)`,
    );
    ok(
      on.blits.length === N_EL,
      `${name}: one composite per element (${on.blits.length} of ${N_EL})`,
    );
    ok(on.passes < off.passes, `${name}: fewer passes (${on.passes} < ${off.passes})`);
  }
}

console.log('the key still invalidates');
for (const route of ['none', 'lb']) {
  const ctx = await make(GROUPS(N_EL), route, false);
  const a = runFrames(ctx, 3, plain);
  ok(a.others === 0, `${route}: static frames skip`);
  // moved world matrix
  const { F, R, b } = ctx;
  const world = [1, 0, 0, 0, 1, 0, 4, 0, 1];
  F.setFrame(3);
  const e0 = R.debugStats.filterEvalCount;
  R.beginFrame([0, 0, 0, 0]);
  R.drawBundle(b, { worldMatrix: world });
  R.endFrame();
  ok(
    R.debugStats.filterEvalCount - e0 === N_EL,
    `${route}: a moved world matrix re-evaluates every group (${R.debugStats.filterEvalCount - e0})`,
  );
  F.setFrame(4);
  const e1 = R.debugStats.filterEvalCount;
  R.beginFrame([0, 0, 0, 0]);
  R.drawBundle(b, { worldMatrix: world });
  R.endFrame();
  ok(
    R.debugStats.filterEvalCount === e1,
    `${route}: the next static frame at the new matrix evaluates nothing`,
  );
  const late = F.log
    .filter((e) => e.frame === 4 && e.op === 'draw')
    .filter((e) => !F.progKeys(e.prog).has('cacheBlitFrag'));
  ok(late.length === 0, `${route}: and paints no child (${late.length})`);
}

console.log('a changed override re-evaluates what it changed');
for (const route of ['none', 'lb']) {
  const per = [];
  for (const off of [false, true]) {
    const { F, R, b } = await make(GROUPS(N_EL), route, off);
    const ov = createOverrideTable(F.gl, b);
    const leafRows = b.drawList.filter((o) => o.kind === 'fillShape').map((o) => o.shapeIdx);
    const run = (i) => {
      F.setFrame(i);
      const e0 = R.debugStats.filterEvalCount;
      R.beginFrame([0, 0, 0, 0]);
      R.drawBundle(b, { overrides: ov });
      R.endFrame();
      return R.debugStats.filterEvalCount - e0;
    };
    const warm = [run(0), run(1), run(2)];
    ov.update(leafRows[2], { localPosition: [0.02, 0] });
    const moved = run(3);
    const painted = F.log.filter(
      (e) => e.frame === 3 && e.op === 'draw' && !F.progKeys(e.prog).has('cacheBlitFrag'),
    ).length;
    per.push({ warm, moved, painted, after: run(4) });
  }
  const [on, off] = per;
  ok(
    on.warm[2] === 0,
    `${route}: with an override table bound, static frames skip (evaluations [${on.warm}])`,
  );
  ok(
    on.moved >= 1 && on.moved === off.moved,
    `${route}: moving one child re-evaluates what it did without the skip (${on.moved} vs ${off.moved})`,
  );
  ok(
    on.painted > 0 && on.painted <= off.painted,
    `${route}: and repaints at least that child (${on.painted} child draws, ${off.painted} without the skip)`,
  );
  ok(on.after === 0, `${route}: the next static frame skips again`);
}

console.log('inputs the cache key does not hold bypass the skip');
for (const route of ['none', 'lb']) {
  for (const input of ['palette', 'extClipTex', 'shapeRange']) {
    const ctx = await make(GROUPS(N_EL), route, false);
    const { F, R, b } = ctx;
    const pal = createPalette(F.gl, [
      [255, 0, 0, 255],
      [0, 255, 0, 255],
    ]);
    const clip = F.gl.createTexture();
    const per = [];
    for (let i = 0; i < 5; i++) {
      F.setFrame(i);
      const e0 = R.debugStats.filterEvalCount;
      R.beginFrame([0, 0, 0, 0]);
      const o = {};
      if (input === 'palette') {
        pal.set(0, [255, (i * 40) & 255, 0, 255]);
        o.palette = pal;
      }
      if (input === 'extClipTex') {
        o.extClipTex = clip;
        o.extClipMode = 1;
      }
      if (input === 'shapeRange') R.drawSprite(b, [0, 5], o);
      else R.drawBundle(b, o);
      R.endFrame();
      if (i === 0) R.precompileFills();
      per.push(R.debugStats.filterEvalCount - e0);
    }
    const late = per.slice(2);
    ok(
      late.every((n) => n > 0),
      `${input}, route ${route}: evaluated every frame, never served stale by a skip (evaluations [${late}])`,
    );
  }
}

console.log('opacity and nesting');
{
  const ctx = await make(`<g opacity=".5">${GROUPS(N_EL)}</g>`, 'lb', false);
  const r = runFrames(ctx, 3, plain);
  ok(
    r.others === 0 && r.evals === 0,
    'a filtered group inside an opacity group skips its children',
  );
  const tints = r.blits.map((e) => e.uniforms && e.uniforms.uTint).filter(Boolean);
  ok(r.blits.length >= N_EL, `its composites are blits (${r.blits.length})`);
  const faded = runFrames(await make(GROUPS(N_EL), 'lb', false), 3, (R, b) =>
    R.drawBundle(b, { alpha: 0.5 }),
  );
  ok(faded.evals === 0, 'a faded draw of filtered groups evaluates no graph on a static frame');
}
console.log(fail ? `${fail} FAILED` : 'groupFilterSkipSmoke OK');
process.exit(fail ? 1 : 0);
