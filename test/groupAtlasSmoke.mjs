// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Group atlas pass counts, slot isolation, painter order and morph cache invalidation.
import { createFakeGl, taggedShaderSources, expandInstancedBlits } from './_fakeGl.mjs';

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
const { importSvg, createBundle, createRenderer, createShapeMorph } =
  await import('../src/index.js');

const N = 120;
const svg = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${N}" height="${N}" viewBox="0 0 ${N} ${N}">${body}</svg>`;
const leaf = (x, y, w, h, op, extra = '') =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#0f0" stroke="#f00" stroke-width="4" opacity="${op}" ${extra}/>`;
const ROW = (n, op = 0.5) =>
  Array.from({ length: n }, (_, i) => leaf(3 + i * 19, 20, 14, 60, op)).join('');
const CLUSTER = (n) =>
  Array.from({ length: n }, (_, i) =>
    leaf(6 + (i % 4) * 12, 6 + Math.floor(i / 4) * 14, 36, 30, 0.5),
  ).join('');
const FRAMES = 3;

async function make(body, route, opts = {}) {
  const F = createFakeGl({ width: N, height: N });
  const R = createRenderer(F.gl, taggedShaderSources(), opts);
  R.setFillEngine({ route, kernel: 'slug' });
  const b = createBundle(F.gl, await importSvg(svg(body), { preserveViewport: true }));
  if (R.prepareBundle) R.prepareBundle(b);
  if (R.awaitLbReady) {
    try {
      await R.awaitLbReady(b, 20000);
    } catch {
      /* the route check reports it */
    }
  }
  R.prewarmBundle(b);
  R.precompileFills();
  R.setViewport(N, N);
  return { F, R, b };
}
async function frames(body, route, draw, opts) {
  const { F, R, b } = await make(body, route, opts);
  for (let i = 0; i < FRAMES; i++) {
    F.setFrame(i);
    R.beginFrame([0, 0, 0, 0]);
    draw(R, b);
    R.endFrame();
  }
  const raw = F.log.filter((e) => e.frame === FRAMES - 1 && (e.op === 'clear' || e.op === 'draw'));
  const ev = expandInstancedBlits(F, raw);
  const has = (e, k) => F.progKeys(e.prog).has(k);
  let passes = 0,
    prev;
  for (const e of ev) {
    const k = e.fbo ? e.fbo.id : 0;
    if (prev === undefined || k !== prev) passes++;
    prev = k;
  }
  const blits = ev.filter((e) => e.op === 'draw' && has(e, 'cacheBlitFrag'));
  return { F, R, ev, raw, passes, blits, has, stats: R.debugStats };
}
const near = (a, b) => Math.abs(a - b) < 1e-6;
const tint = (e) => (e.uni.uTint || [])[0];
const sizes = [4, 9];

for (const route of ['none', 'lb']) {
  console.log(`\n  route ${route}:`);
  for (const n of sizes) {
    const on = await frames(ROW(n), route, (R, b) => R.drawBundle(b));
    const off = await frames(ROW(n), route, (R, b) => R.drawBundle(b), { groupAtlas: false });
    ok(
      on.stats.groupAtlasSlots > 0 && on.passes <= 3,
      `(A) ${n} faded fill+stroke leaves: ${on.passes} passes with the atlas (want <= 3), slots ${on.stats.groupAtlasSlots}`,
    );
    ok(
      off.passes >= 2 * n + 1 && off.stats.groupAtlasSlots === 0,
      `(G) groupAtlas:false: ${off.passes} passes (a pair per group, want >= ${2 * n + 1}), no slot`,
    );
    ok(
      on.blits.length === n && off.blits.length === n,
      `(A) ${n} composites either way (${on.blits.length} / ${off.blits.length})`,
    );
  }
  {
    const n = 6;
    const on = await frames(ROW(n), route, (R, b) => R.drawBundle(b));
    const slotDraws = on.ev.filter(
      (e) => e.fbo && !(e.op === 'draw' && on.has(e, 'cacheBlitFrag')),
    );
    const scs = [];
    for (const e of slotDraws)
      if (e.sc && !scs.some((s) => s.join() === e.sc.join())) scs.push(e.sc);
    const disjoint = scs.every((p, i) =>
      scs.every(
        (q, j) =>
          i === j ||
          p[0] + p[2] <= q[0] ||
          q[0] + q[2] <= p[0] ||
          p[1] + p[3] <= q[1] ||
          q[1] + q[3] <= p[1],
      ),
    );
    ok(
      scs.length === n && disjoint,
      `(B) ${scs.length} distinct slot scissors (want ${n}), pairwise disjoint`,
    );
    const evenShift = slotDraws
      .filter((e) => e.op === 'draw')
      .every((e) => ((e.vp[0] % 2) + 2) % 2 === 0 && ((e.vp[1] % 2) + 2) % 2 === 0);
    ok(
      evenShift,
      '(B) every slot draw is shifted by an even offset (the derivative quads stay aligned)',
    );
    // the composite of slot k reads the atlas at the slot and writes the canvas at the group's rect; the shift of its draws maps one to the other
    const c = on.blits;
    const xs = c.map((e) => e.vp[0]);
    ok(
      xs.length === n && xs.every((x, i) => i === 0 || x > xs[i - 1]),
      `(C) composites go out in painter order (canvas x ${xs})`,
    );
    ok(
      c.every(
        (e) =>
          e.fbo === null &&
          e.blend &&
          e.blend.join() === 'ONE,ONE_MINUS_SRC_ALPHA' &&
          near(tint(e), 0.5),
      ),
      '(C) each is a cache blit into the canvas under src-over at the leaf opacity .5',
    );
    const atlasTex = c.map((e) => on.F.fboOf(e.units[0]));
    ok(
      atlasTex.every((t) => t && t === atlasTex[0]) &&
        slotDraws.every((e) => e.fbo === slotDraws[0].fbo),
      '(C) all composites sample the one atlas target the slots were drawn in',
    );
    // slot k's scissor + the map are consistent: viewport (vx, vy) of a slot draw = slot origin - canvas rect origin, which the composite's uInMap inverts
    const map = c.map((e) => e.uni.uInMap);
    ok(
      map.every((m) => m && m[2] >= 0 && m[3] >= 0 && m[0] > 0 && m[1] > 0),
      '(C) each composite reads its own atlas rect (uInMap scale/offset)',
    );
    const per = [0.2, 0.5, 0.8];
    const mix = await frames(
      per.map((o, i) => leaf(5 + i * 36, 20, 28, 60, o)).join(''),
      route,
      (R, b) => R.drawBundle(b),
    );
    ok(
      mix.blits.map(tint).every((t, i) => near(t, per[i])),
      `(C) per-leaf opacities .2 .5 .8 reach the composites in order (${mix.blits.map(tint)})`,
    );
  }
  {
    const mk = async (body) => await frames(body, route, (R, b) => R.drawBundle(b));
    const one = await mk(ROW(1));
    ok(
      one.stats.groupAtlasSlots === 0,
      `(D) a run of one group takes the ordinary accumulator (${one.stats.groupAtlasSlots} slots)`,
    );
    const split = await mk(
      leaf(4, 20, 20, 60, 0.5) +
        '<rect x="30" y="30" width="20" height="20" fill="#00f"/>' +
        leaf(60, 20, 20, 60, 0.5),
    );
    ok(
      split.stats.groupAtlasSlots === 0 && split.blits.length === 2,
      `(D) a plain leaf between two faded leaves ends the run (${split.stats.groupAtlasSlots} slots, ${split.blits.length} composites)`,
    );
    const M = '<mask id="m"><rect width="120" height="120" fill="#808080"/></mask>';
    const masked = await mk(
      M +
        leaf(4, 20, 20, 60, 0.5) +
        leaf(30, 20, 20, 60, 0.5, 'mask="url(#m)"') +
        leaf(60, 20, 20, 60, 0.5),
    );
    ok(
      masked.stats.groupAtlasSlots === 0,
      `(D) a masked group breaks the run: its neighbors are runs of one (${masked.stats.groupAtlasSlots} slots)`,
    );
    const nested = await mk('<g opacity=".7">' + ROW(3) + '</g>');
    ok(
      nested.stats.groupAtlasSlots === 0,
      `(D) faded leaves inside a group stay on the ordinary accumulator (${nested.stats.groupAtlasSlots} slots)`,
    );
    const blend = await mk(
      leaf(4, 20, 20, 60, 0.5) + leaf(30, 20, 20, 60, 0.5, 'style="mix-blend-mode:multiply"'),
    );
    ok(
      blend.stats.groupAtlasSlots === 0,
      `(D) a blend-mode leaf is not a slot (${blend.stats.groupAtlasSlots})`,
    );
  }
  {
    // (E) forty overlapping 100x100 groups: slots of 100x100 with a 2048 atlas hold 19 x 19; 400 would not -> settle mid-run
    const many = Array.from({ length: 400 }, (_, i) =>
      leaf(8 + (i % 5), 8 + (i % 7), 100, 100, 0.3),
    ).join('');
    const e = await frames(many, route, (R, b) => R.drawBundle(b));
    const slots = e.stats.groupAtlasSlots / FRAMES;
    ok(
      e.blits.length === 400 && e.stats.groupAtlasPasses >= FRAMES * 2 && e.passes < 400,
      `(E) 400 big faded leaves: ${e.blits.length} composites, ${e.passes} passes (the atlas settled mid-run, still far under a pair per group)`,
    );
    ok(
      slots === 400 || e.stats.groupAtlasSlots > 0,
      `(E) the groups that fit took slots (${e.stats.groupAtlasSlots} over ${FRAMES} frames)`,
    );
  }
  {
    const TWO =
      '<rect x="10" y="10" width="60" height="80" fill="#f00"/><rect x="40" y="40" width="60" height="60" fill="#00f"/>';
    const inst = (n) =>
      Array.from({ length: n }, (_, i) => ({
        worldMatrix: new Float32Array([
          0.7,
          0,
          0,
          0,
          0.7,
          0,
          -0.6 + 0.2 * (i % 7),
          0.5 - 0.2 * ((i / 7) | 0),
          1,
        ]),
        alpha: 0.5,
      }));
    const on = await frames(TWO, route, (R, b) => R.drawBundleInstanced(b, inst(12)));
    const off = await frames(TWO, route, (R, b) => R.drawBundleInstanced(b, inst(12)), {
      groupAtlas: false,
    });
    ok(
      on.passes < off.passes && on.stats.groupAtlasSlots > 0,
      `(F) twelve overlapping faded instances: ${on.passes} passes with the atlas vs ${off.passes} without (slots ${on.stats.groupAtlasSlots})`,
    );
    ok(
      on.blits.length >= off.blits.length && on.blits.every((e) => near(tint(e), 0.5)),
      `(F) a composite per layer (the per-instance route) or per instance (instanced slots), each at the instance alpha (${on.blits.length} / ${off.blits.length} without the atlas)`,
    );
  }
}

for (const route of ['none', 'lb']) {
  console.log(`\n  route ${route}, merged runs:`);
  // leaves 14 px apart with 8 px between their strokes' ink: pairwise disjoint even with the 2 px antialiasing reach
  const FAR = (n, op = 0.5) =>
    Array.from({ length: n }, (_, i) =>
      leaf(3 + (i % 8) * 14, 6 + Math.floor(i / 8) * 56, 2, 30, op),
    ).join('');
  const per = (e) =>
    e.ev.filter((x) => x.op === 'draw' && !e.has(x, 'cacheBlitFrag') && x.fbo).length;
  for (const n of [4, 16]) {
    const on = await frames(FAR(n), route, (R, b) => R.drawBundle(b));
    const at = await frames(FAR(n), route, (R, b) => R.drawBundle(b), { groupAtlas: false });
    const draws = per(on),
      drawsOff = per(at);
    ok(
      on.stats.groupMergedRuns > 0 &&
        on.stats.groupMergedComposites / FRAMES === n &&
        on.stats.groupAtlasSlots === 0,
      `(I) ${n} disjoint faded leaves: one merged run of ${on.stats.groupMergedComposites / FRAMES} composites, no atlas slot (runs ${on.stats.groupMergedRuns})`,
    );
    ok(
      on.passes <= 3 &&
        on.blits.length === n &&
        on.blits.every((e) => e.fbo === null && near(tint(e), 0.5)),
      `(I) ${on.passes} passes (want <= 3), ${on.blits.length} composites at .5 into the canvas`,
    );
    ok(
      draws < drawsOff / 2 && draws <= 4,
      `(I) the leaves of every group reach ${draws} accumulator draws (a pair of draws per group without the atlas: ${drawsOff})`,
    );
    const xs = on.blits.map((e) => e.vp[0] - 1000 * e.vp[1]); // (GL y runs up: a later row has a smaller y)
    const rects = on.blits.map((e) => e.vp);
    const disj = rects.every((p, i) =>
      rects.every(
        (q, j) =>
          i === j ||
          p[0] + p[2] <= q[0] ||
          q[0] + q[2] <= p[0] ||
          p[1] + p[3] <= q[1] ||
          q[1] + q[3] <= p[1],
      ),
    );
    ok(
      disj && xs.every((x, i) => i === 0 || x > xs[i - 1]),
      '(I) the composites are over disjoint canvas rects, in painter order',
    );
    ok(
      on.blits.every((e) => on.F.fboOf(e.units[0]) === on.F.fboOf(on.blits[0].units[0])),
      '(I) all composites read the one accumulator',
    );
  }
  {
    // a run that overlaps once is not merged: it takes the atlas slots
    const ovl = FAR(4) + leaf(2 + 6, 6, 20, 30, 0.5);
    const e = await frames(ovl, route, (R, b) => R.drawBundle(b));
    ok(
      e.stats.groupMergedRuns === 0 && e.stats.groupAtlasSlots > 0,
      `(I) one overlapping group sends the run to the atlas (merged runs ${e.stats.groupMergedRuns}, slots ${e.stats.groupAtlasSlots})`,
    );
    const nm = await frames(FAR(6), route, (R, b) => R.drawBundle(b), { groupAtlas: false });
    ok(
      nm.stats.groupMergedRuns === 0 && nm.stats.groupAtlasSlots === 0,
      '(G) groupAtlas:false also turns merging off',
    );
  }
}

for (const route of ['none', 'lb']) {
  // (J) mixed alphas through the per-instance paths: [.5 .25 1 .75] on a two-leaf bundle. The walk of each instance's render() ends with a flush of
  // its own; it must not land the run's deferred composites into the atlas or reset the packer under the open slot.
  const TWO =
    '<rect x="4" y="4" width="40" height="40" fill="#f00"/><rect x="20" y="20" width="40" height="40" fill="#00f"/>';
  const T = (tx, ty, sc) => new Float32Array([sc, 0, 0, 0, sc, 0, tx, ty, 1]);
  const pl = [
    [-0.5, 0.5, 0.5],
    [0.5, 0.5, 0.25],
    [-0.5, -0.5, 1],
    [0.5, -0.5, 0.75],
  ].map(([x, y, a]) => ({ worldMatrix: T(x, y, 0.5), alpha: a }));
  const e = await frames(TWO, route, (R, b) => R.drawBundleInstanced(b, pl));
  const toAtlas = e.ev.filter((x) => x.op === 'draw' && x.fbo && e.has(x, 'cacheBlitFrag'));
  ok(
    toAtlas.length === 0,
    `(J) route ${route}: no composite is drawn into the atlas itself (${toAtlas.length})`,
  );
  const scs = [];
  for (const x of e.ev)
    if (x.fbo && x.sc && !scs.some((q) => q.join() === x.sc.join())) scs.push(x.sc);
  const apart = (p, q) =>
    p[0] + p[2] <= q[0] || q[0] + q[2] <= p[0] || p[1] + p[3] <= q[1] || q[1] + q[3] <= p[1];
  // (the first two faded instances are one run; the third follows the alpha-1 instance, so it is a run of its own and starts the packer over)
  ok(
    scs.length === 3 && apart(scs[0], scs[1]),
    `(J) the first two faded instances have their own disjoint slot scissors, the third a run of its own (${JSON.stringify(scs)})`,
  );
  ok(
    e.blits.length === 3 && e.blits.map(tint).sort().join() === [0.25, 0.5, 0.75].join(),
    `(J) three composites at .5 .25 .75 (${e.blits.map(tint)})`,
  );
}

{
  // (H) a draw that throws between a slot's begin and end leaves the shifted viewport and the scissor behind; the next frame starts clean
  const { F, R, b } = await make(ROW(5), 'none');
  // the 8th op of the draw list (inside the third slot) throws once when the walk reads it
  F.setFrame(0);
  R.beginFrame([0, 0, 0, 0]);
  R.drawBundle(b);
  R.endFrame(); // (the marks are cached by now)
  const op = b.drawList.filter((o) => o.kind === 'fillShape')[2];
  let thrown = 0;
  const kind = op.kind;
  Object.defineProperty(op, 'kind', {
    configurable: true,
    get() {
      if (!thrown) {
        thrown++;
        throw new Error('boom');
      }
      return kind;
    },
  });
  F.setFrame(1);
  R.beginFrame([0, 0, 0, 0]);
  try {
    R.drawBundle(b);
  } catch {
    /* the draw died mid-slot */
  }
  try {
    R.endFrame();
  } catch {
    /* ditto */
  }
  F.setFrame(2);
  R.beginFrame([0, 0, 0, 0]);
  R.drawBundle(b);
  R.endFrame();
  const ev = expandInstancedBlits(
    F,
    F.log.filter((e) => e.frame === 2 && e.op === 'draw'),
  );
  const canvasDraws = ev.filter((e) => e.fbo === null);
  ok(
    thrown === 1 &&
      canvasDraws.length === 5 &&
      canvasDraws.every((e) => e.vp[0] >= 0 && e.vp[2] <= N && e.sc === null),
    `(H) after a draw died inside a slot the next frame composites ${canvasDraws.length} groups on the canvas, unshifted and unscissored`,
  );
}

for (const route of ['none', 'lb']) {
  // (K) composite draws. The raw events are counted (not expanded): an instanced composite is one draw event of N instances.
  const FAR = (n, op = 0.5) =>
    Array.from({ length: n }, (_, i) =>
      leaf(3 + (i % 8) * 14, 6 + Math.floor(i / 8) * 56, 2, 30, op),
    ).join('');
  const blitDraws = (e) => e.raw.filter((x) => x.op === 'draw' && e.has(x, 'cacheBlitFrag'));
  for (const [what, body, n] of [
    ['atlas run', ROW(9), 9],
    ['merged run', FAR(16), 16],
  ]) {
    const on = await frames(body, route, (R, b) => R.drawBundle(b));
    const d = blitDraws(on);
    ok(
      d.length === 1 && d[0].instances === n && on.stats.groupCompositeDraws / FRAMES === 1,
      `(K) ${route} ${what}: ${n} composites are ${d.length} draw of ${d[0] && d[0].instances} instances (${on.stats.groupCompositeDraws / FRAMES} composite draw per frame)`,
    );
    globalThis.__MANTLE_DEBUG__ = true;
    globalThis.__MANTLE_NO_INSTANCED_COMPOSITE = true;
    const off = await frames(body, route, (R, b) => R.drawBundle(b));
    globalThis.__MANTLE_NO_INSTANCED_COMPOSITE = false;
    ok(
      blitDraws(off).length === n && off.stats.groupCompositeDraws / FRAMES === n,
      `(K) ${route} ${what}: the flag draws one quad per group (${blitDraws(off).length})`,
    );
    const a = on.blits.map((e) =>
      [e.vp.join(','), (e.uni.uInMap || []).map((v) => +v.toFixed(5)).join(','), tint(e)].join('|'),
    );
    const c = off.blits.map((e) =>
      [e.vp.join(','), (e.uni.uInMap || []).map((v) => +v.toFixed(5)).join(','), tint(e)].join('|'),
    );
    ok(
      a.length === n && a.every((v, i) => v === c[i]),
      `(K) ${route} ${what}: the instances are the one-quad draws' rects, source maps and tints, in the same order`,
    );
  }
  {
    const one = await frames(leaf(10, 10, 30, 30, 0.5), route, (R, b) => R.drawBundle(b));
    ok(
      one.stats.groupCompositeDraws === 0 || blitDraws(one).every((x) => !(x.instances > 1)),
      `(K) ${route}: a lone group keeps the one-quad draw`,
    );
  }
}

{
  // (M) slots for faded instances. 64 instances on an 8 x 8 grid, 1.8 cells wide: neighbors overlap, 22 layers.
  const TWO =
    '<rect x="4" y="4" width="40" height="40" fill="#f00"/><rect x="20" y="20" width="40" height="40" fill="#00f"/>';
  const grid = (alpha, k = 0.9) =>
    Array.from({ length: 64 }, (_, i) => ({
      worldMatrix: new Float32Array([
        k / 4,
        0,
        0,
        0,
        k / 4,
        0,
        -1 + 0.25 * ((i % 8) + 0.5),
        1 - 0.25 * (((i / 8) | 0) + 0.5),
        1,
      ]),
      alpha: typeof alpha === 'function' ? alpha(i) : alpha,
    }));
  const rawDraws = (e) => e.raw.filter((x) => x.op === 'draw');
  const slot = await frames(TWO, 'none', (R, b) =>
    R.drawBundleInstanced(
      b,
      grid((i) => 0.25 + 0.5 * (i % 2)),
    ),
  );
  globalThis.__MANTLE_DEBUG__ = true;
  globalThis.__MANTLE_NO_ALPHA_SLOTS = true;
  const layered = await frames(TWO, 'none', (R, b) =>
    R.drawBundleInstanced(
      b,
      grid((i) => 0.25 + 0.5 * (i % 2)),
    ),
  );
  globalThis.__MANTLE_NO_ALPHA_SLOTS = false;
  ok(
    (slot.stats.alphaSlotBatches | 0) > 0 && (layered.stats.alphaSlotBatches | 0) === 0,
    `(M) the slot path took the grid (${slot.stats.alphaSlotBatches} batches, ${layered.stats.alphaSlotBatches | 0} with the flag)`,
  );
  ok(
    rawDraws(slot).length <= 8 && rawDraws(layered).length >= 20,
    `(M) ${rawDraws(slot).length} draws with slots vs ${rawDraws(layered).length} layered (22 layers)`,
  );
  ok(
    slot.blits.length === 64 && slot.blits.every((e, i) => near(tint(e), 0.25 + 0.5 * (i % 2))),
    `(M) one composite per instance, in instance order, at its own alpha (${slot.blits.length})`,
  );
  const rects = slot.blits.map((e) => e.vp);
  ok(
    rects.every(
      (r, i) =>
        r[2] > 0 && r[3] > 0 && r[0] >= 0 && r[1] >= 0 && r[0] + r[2] <= N && r[1] + r[3] <= N,
    ),
    '(M) every composite lands inside the canvas',
  );
  // slots are disjoint texel rects of the atlas, at even offsets from the canvas rect
  const src = slot.blits.map((e) => {
    const m = e.uni.uInMap || [];
    return m.length === 4 ? m : null;
  });
  ok(src.every(Boolean), '(M) every composite carries its atlas map');
  const draws = rawDraws(slot).filter((x) => !slot.has(x, 'cacheBlitFrag'));
  ok(
    draws.length >= 1 && draws.every((x) => x.sc && x.sc[2] === N && x.sc[3] === N),
    `(M) each block draw is scissored to its canvas-sized block (${JSON.stringify(draws.map((x) => x.sc))})`,
  );
  ok(
    draws.every((x) => x.sc[0] % N === 0 && x.sc[1] % N === 0),
    '(M) blocks sit at multiples of the canvas size',
  );
  // an alpha-1 instance in the batch, or an external clip, keeps the layered path
  const mixed = await frames(TWO, 'none', (R, b) =>
    R.drawBundleInstanced(
      b,
      grid((i) => (i === 3 ? 1 : 0.5)),
    ),
  );
  ok(
    (mixed.stats.alphaSlotBatches | 0) === 0,
    `(M) an alpha-1 instance keeps the layers (${mixed.stats.alphaSlotBatches | 0} slot batches)`,
  );
  const fit = await frames(TWO, 'none', (R, b) =>
    R.drawBundleInstanced(b, grid(0.5, 0.9).slice(0, 2)),
  );
  ok(
    (fit.stats.alphaSlotBatches | 0) === 0,
    `(M) two instances that do not touch need no slots (${fit.stats.alphaSlotBatches | 0})`,
  );
}

// Record GL commands only; coverage and translucent pixel checks run on actual GPUs.
async function morphCommands(route, named, disjoint, atlas, changingClip = false) {
  const F = createFakeGl({ width: N, height: N });
  const R = createRenderer(F.gl, taggedShaderSources(), { groupAtlas: atlas });
  R.setFillEngine({ route, kernel: 'slug' });
  R.setViewport(N, N);
  const count = disjoint ? 3 : 6;
  const pose = (dx, opacity) =>
    svg(
      (changingClip
        ? '<defs><clipPath id="mc"><rect x="0" y="0" width="70" height="120"/></clipPath></defs>'
        : '') +
        Array.from(
          { length: count },
          (_, i) =>
            `<rect ${named ? `id="m${i}"` : ''}${changingClip && dx > 0 && i === 0 ? ' clip-path="url(#mc)"' : ''} x="${14 + i * (disjoint ? 36 : 12) + dx}" y="20" width="12" height="24" fill="#0f0" stroke="#f00" stroke-width="2" opacity="${opacity}"/>`,
        ).join(''),
    );
  const A = createBundle(F.gl, await importSvg(pose(0, 0.5), { preserveViewport: true }));
  const B = createBundle(F.gl, await importSvg(pose(8, 1), { preserveViewport: true }));
  const m = createShapeMorph(F.gl, A, B, { cpuLerp: true });
  const records = [];
  try {
    for (const [frame, t] of [0, 0.25, 0.5, 0.75, 1, 0.25, 0].entries()) {
      F.setFrame(frame);
      m.setT(t);
      R.beginFrame([0, 0, 0, 0]);
      R.drawBundle(m);
      R.endFrame();
      const ev = expandInstancedBlits(
        F,
        F.log.filter((e) => e.frame === frame && (e.op === 'clear' || e.op === 'draw')),
      );
      const blits = ev.filter((e) => e.op === 'draw' && F.progKeys(e.prog).has('cacheBlitFrag'));
      let passes = 0,
        prev;
      for (const e of ev) {
        const k = e.fbo ? e.fbo.id : 0;
        if (prev === undefined || k !== prev) passes++;
        prev = k;
      }
      records.push({ t, passes, blits, ev });
    }
    return {
      records,
      count,
      stats: R.debugStats,
      bindingSteps: m.bundle._morphSrc.bindingSteps.length,
    };
  } finally {
    m.dispose();
    A.dispose();
    B.dispose();
    R.dispose();
  }
}
for (const route of ['none', 'lb'])
  for (const named of [false, true])
    for (const disjoint of [false, true]) {
      const on = await morphCommands(route, named, disjoint, true),
        off = await morphCommands(route, named, disjoint, false);
      const tag = `morph ${route} named=${named} disjoint=${disjoint}`;
      ok(
        on.records.every((r) => r.passes <= 3 && r.blits.length === on.count),
        `${tag}: at most three passes and one composite per leaf`,
      );
      ok(
        off.records.every((r) => r.passes >= 2 * off.count + 1),
        `${tag}: opt-out retains isolated passes`,
      );
      ok(
        on.records.every((r) => r.blits.every((e) => near(tint(e), 0.5 + 0.5 * r.t))),
        `${tag}: current-pose composite opacity`,
      );
      ok(
        on.stats[disjoint ? 'groupMergedRuns' : 'groupAtlasSlots'] > 0,
        `${tag}: expected batching path executes`,
      );
      const positions = on.records.map((r) => r.blits.map((e) => e.vp[0]));
      ok(
        positions[4].every((x, i) => x - positions[0][i] >= 6 && x - positions[0][i] <= 10) &&
          positions[5].every((x, i) => x === positions[1][i]) &&
          positions[6].every((x, i) => x === positions[0][i]),
        `${tag}: cached composite rectangles follow forward and reverse poses (${JSON.stringify(positions)})`,
      );
    }

const changingBindings = await morphCommands('none', true, false, true, true);
ok(
  changingBindings.bindingSteps > 0 &&
    changingBindings.stats.groupAtlasSlots === 0 &&
    changingBindings.stats.groupMergedRuns === 0,
  'morphs with changing clip bindings retain ordinary group isolation',
);

console.log(fail ? `\nFAIL (${fail})` : '\nPASS');
process.exit(fail ? 1 : 0);
