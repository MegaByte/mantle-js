// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// groupAlphaSmoke -- a draw's `alpha` is GROUP opacity.
//
// drawBundle({alpha}) (and a handle's draw, a sprite, an instance) has GROUP semantics: the draw renders into an accumulator and is
// faded once (renderer.js R._alphaGroupBegin, the same machinery as an `<g opacity>` row). A per-leaf multiply would let shapes that
// overlap show through each other: two opaque rects at alpha .5 would read (171,68,222,191) where `<g opacity=".5">` reads
// (255,0,203,128).
//
// HOW: the real renderer, headless, against test/_fakeGl.mjs, which records every clear and draw with its target, blend function and
// uniforms. Per route (classic / unified):
//   (A) alpha 1 and alpha absent have the same call log, and it has no group composite (zero added cost);
//   (B) alpha .5 on two overlapping leaves: exactly ONE group composite per draw -- a cacheBlit of an accumulator into the canvas
//       under ONE, ONE_MINUS_SRC_ALPHA with uTint = (.5 x4) -- and the leaves paint with uDrawAlpha 1 (the fade is not per leaf);
//   (C) one paint-only leaf (a fill, a stroke) at alpha .5 takes the direct draw: no accumulator, no composite, the alpha-1 call log;
//   (D) a fill+stroke row is two paints that overlap: it takes the group;
//   (E) the author's own group inside the bundle composites first (two composites, the inner one at its own opacity);
//   (F) a blend-mode leaf is isolated by the group (it is not the one-leaf path);
//   (G) the instanced entry: an instance below 1 of a multi-leaf bundle leaves the single instanced draw for one group per such
//       instance; a one-leaf bundle keeps the direct path at any alpha.
//   (H) a draw whose leaves PROVABLY share no pixel (their painted boxes, +2 px AA reach, are pairwise disjoint) needs
//       no accumulator -- per-leaf alpha is group alpha -- and keeps the direct path; leaves 1 px apart, a fill+stroke element,
//       a blend-mode leaf and a filtered leaf still take the group;
//   (I) instances that overlap are LAYERED (painter order kept): a chain A-B-C where A and C do not touch is two
//       passes, not three; a bundle whose own leaves cannot overlap keeps the single instanced draw at any placement;
//   (J) a faded draw of a CACHED mount is one blit of the alpha-1 raster (uTint = alpha); animating the alpha does
//       not re-bake.
// (test/groupAlphaExportSmoke.mjs pins the native/export side: the alpha is `opacity` on ONE <g>.)
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
const { importSvg, createBundle, createRenderer, CacheStrategy } = await import('../src/index.js');

const N = 120;
const svg = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${N}" height="${N}" viewBox="0 0 ${N} ${N}">${body}</svg>`;
const RED = '<rect x="10" y="10" width="60" height="80" fill="#f00"/>';
const BLUE = '<rect x="40" y="40" width="60" height="60" fill="#00f"/>';
const TWO = RED + BLUE;
const ONE_FILL = RED;
const ONE_STROKE =
  '<rect x="10" y="10" width="60" height="80" fill="none" stroke="#f00" stroke-width="6"/>';
const FILL_STROKE =
  '<rect x="10" y="10" width="60" height="80" fill="#0f0" stroke="#f00" stroke-width="6"/>';
const IN_GROUP = `<g opacity="0.5">${RED}${BLUE}</g>${RED}`;
const BLEND_LEAF =
  '<rect x="10" y="10" width="60" height="80" fill="#f00" style="mix-blend-mode:multiply"/>';
const FRAMES = 3;

async function make(body, route) {
  const F = createFakeGl({ width: N, height: N });
  const R = createRenderer(F.gl, taggedShaderSources(), {});
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

/// Run `draw(R, b)` for FRAMES frames; return the last frame's log, its group composites and leaf alphas.
async function frames(body, route, draw) {
  const { F, R, b } = await make(body, route);
  for (let i = 0; i < FRAMES; i++) {
    F.setFrame(i);
    R.beginFrame([0, 0, 0, 0]);
    draw(R, b);
    R.endFrame();
  }
  const ev = expandInstancedBlits(
    F,
    F.log.filter((e) => e.frame === FRAMES - 1),
  );
  const accFbos = new Set(
    ev.filter((e) => e.op === 'clear' && e.mask & 0x0100 && e.fbo).map((e) => e.fbo),
  );
  const has = (e, k) => F.progKeys(e.prog).has(k);
  const comps = ev.filter(
    (e) => e.op === 'draw' && has(e, 'cacheBlitFrag') && accFbos.has(F.fboOf(e.units[0])),
  );
  const rows = ev.map(
    (e) =>
      e.op +
      (e.op === 'draw'
        ? ':' + [...F.progKeys(e.prog)].join('+') + ':' + e.count + ':' + (e.fbo ? 'rt' : 'canvas')
        : ''),
  );
  const leafAlpha = ev
    .filter(
      (e) => e.op === 'draw' && !has(e, 'cacheBlitFrag') && e.uni && e.uni.uDrawAlpha !== undefined,
    )
    .map((e) => e.uni.uDrawAlpha);
  return { F, R, ev, comps, rows, leafAlpha };
}

const near = (a, b) => Math.abs(a - b) < 1e-6;
const tintOf = (e) => e.uni.uTint || [];

for (const route of ['none', 'lb']) {
  console.log(`\n  route ${route}:`);
  {
    const a = await frames(TWO, route, (R, b) => R.drawBundle(b));
    const o = await frames(TWO, route, (R, b) => R.drawBundle(b, { alpha: 1 }));
    ok(
      a.comps.length === 0 && o.comps.length === 0,
      `(A) alpha absent / 1: no group composite (${a.comps.length} / ${o.comps.length})`,
    );
    ok(
      a.rows.join('|') === o.rows.join('|'),
      `(A) alpha 1 and alpha absent have the same call log (${a.rows.length} calls)`,
    );
  }
  {
    const g = await frames(TWO, route, (R, b) => R.drawBundle(b, { alpha: 0.5 }));
    ok(g.comps.length === 1, `(B) alpha .5 on two leaves: one group composite (${g.comps.length})`);
    if (g.comps.length === 1) {
      const e = g.comps[0];
      ok(
        e.fbo === null &&
          e.blend &&
          e.blend.join() === 'ONE,ONE_MINUS_SRC_ALPHA' &&
          tintOf(e).length === 4 &&
          tintOf(e).every((v) => near(v, 0.5)),
        `(B) it fades the accumulator into the canvas under src-over with uTint .5 (fbo ${e.fbo === null ? 'canvas' : 'rt'}, blend ${e.blend}, tint ${JSON.stringify(tintOf(e))})`,
      );
    }
    ok(
      g.leafAlpha.length > 0 && g.leafAlpha.every((v) => near(v, 1)),
      `(B) the leaves paint at uDrawAlpha 1 (${JSON.stringify([...new Set(g.leafAlpha)])})`,
    );
  }
  for (const [name, body] of [
    ['one fill', ONE_FILL],
    ['one stroke', ONE_STROKE],
  ]) {
    const g = await frames(body, route, (R, b) => R.drawBundle(b, { alpha: 0.5 }));
    const one = await frames(body, route, (R, b) => R.drawBundle(b, { alpha: 1 }));
    ok(g.comps.length === 0, `(C) ${name} at .5: no group composite (${g.comps.length})`);
    // (the unified route claims depth for a translucent draw, one extra clear: compare the draws, which is the pass structure)
    const draws = (x) => x.rows.filter((r) => r.startsWith('draw')).join('|');
    ok(
      draws(g) === draws(one) && draws(g).length > 0,
      `(C) ${name} at .5 has the alpha-1 draws: the direct path, no added pass`,
    );
    ok(
      g.leafAlpha.length > 0 && g.leafAlpha.every((v) => near(v, 0.5)),
      `(C) ${name}: the leaf still carries uDrawAlpha .5 (${JSON.stringify([...new Set(g.leafAlpha)])})`,
    );
  }
  {
    const g = await frames(FILL_STROKE, route, (R, b) => R.drawBundle(b, { alpha: 0.5 }));
    ok(
      g.comps.length === 1,
      `(D) a fill+stroke row at .5 takes the group (${g.comps.length} composite)`,
    );
  }
  {
    const g = await frames(IN_GROUP, route, (R, b) => R.drawBundle(b, { alpha: 0.5 }));
    const tints = g.comps.map((e) => tintOf(e)[0]);
    ok(
      g.comps.length === 2 && near(tints[0], 0.5) && near(tints[1], 0.5),
      `(E) the author's <g opacity=.5> composites first, then the draw's fade (tints ${JSON.stringify(tints)})`,
    );
  }
  {
    const g = await frames(BLEND_LEAF, route, (R, b) => R.drawBundle(b, { alpha: 0.5 }));
    ok(
      g.comps.length >= 1,
      `(F) a blend-mode leaf at .5 is not the one-leaf path (${g.comps.length} composite)`,
    );
  }
  {
    const inst = (alphas) =>
      alphas.map((a, i) => ({
        worldMatrix: new Float32Array([0.4, 0, 0, 0, 0.4, 0, -0.5 + 0.5 * i, 0, 1]),
        alpha: a,
      }));
    const all1 = await frames(TWO, route, (R, b) => R.drawBundleInstanced(b, inst([1, 1, 1])));
    const mixed = await frames(TWO, route, (R, b) =>
      R.drawBundleInstanced(b, inst([1, 0.5, 0.25])),
    );
    const oneLeaf = await frames(ONE_FILL, route, (R, b) =>
      R.drawBundleInstanced(b, inst([1, 0.5, 0.25])),
    );
    // Disjoint instances (small, spread out) share an accumulator per distinct alpha: [.5 .5 .25 .5] -> two passes, not four.
    const small = (alphas) =>
      alphas.map((a, i) => ({
        worldMatrix: new Float32Array([0.15, 0, 0, 0, 0.15, 0, -0.75 + 0.5 * i, 0, 1]),
        alpha: a,
      }));
    const batched = await frames(TWO, route, (R, b) =>
      R.drawBundleInstanced(b, small([0.5, 0.5, 0.25, 0.5])),
    );
    // (route 'lb': the analytic route serves each instance itself, but the instances of a batch still share ONE group around them)
    const wantBatched = 2;
    ok(
      batched.comps.length === wantBatched,
      `(G) four DISJOINT instances at alphas [.5 .5 .25 .5], route ${route}: share accumulators, one group per distinct alpha (${batched.comps.length} composites, want ${wantBatched})`,
    );
    if (batched.comps.length === 2) {
      const t = batched.comps.map((e) => tintOf(e)[0]).sort();
      ok(
        near(t[0], 0.25) && near(t[1], 0.5),
        `(G) ...faded at .25 and .5 (tints ${JSON.stringify(t)})`,
      );
    }
    ok(
      all1.comps.length === 0,
      `(G) three alpha-1 instances: no group composite (${all1.comps.length})`,
    );
    ok(
      mixed.comps.length === 2,
      `(G) alphas [1,.5,.25] on a two-leaf bundle: one group per faded instance (${mixed.comps.length})`,
    );
    if (mixed.comps.length === 2) {
      const t = mixed.comps.map((e) => tintOf(e)[0]);
      ok(
        near(t[0], 0.5) && near(t[1], 0.25),
        `(G) each instance fades at its own alpha (tints ${JSON.stringify(t)})`,
      );
    }
    ok(
      oneLeaf.comps.length === 0,
      `(G) a one-leaf bundle keeps the direct path at any alpha (${oneLeaf.comps.length} composites)`,
    );
  }
}

// (H) leaves that cannot overlap. 1 px per unit: the AA pad is 2 px a side, so leaves need > 4 px between them.
const FAR =
  '<rect x="10" y="10" width="40" height="40" fill="#f00"/><rect x="60" y="10" width="40" height="40" fill="#00f"/>'; // 10 px apart
const NEAR =
  '<rect x="10" y="10" width="40" height="40" fill="#f00"/><rect x="53" y="10" width="40" height="40" fill="#00f"/>'; // 3 px apart: inside the pads
const TOUCH =
  '<rect x="10" y="10" width="40" height="40" fill="#f00"/><rect x="49" y="10" width="40" height="40" fill="#00f"/>'; // 1 px overlap
const FAR_STROKES =
  '<rect x="14" y="14" width="30" height="30" fill="none" stroke="#f00" stroke-width="6"/><rect x="66" y="14" width="30" height="30" fill="none" stroke="#00f" stroke-width="6"/>';
const NEAR_STROKES =
  '<rect x="14" y="14" width="30" height="30" fill="none" stroke="#f00" stroke-width="6"/><rect x="49" y="14" width="30" height="30" fill="none" stroke="#00f" stroke-width="6"/>';
const TWO_FS =
  '<rect x="10" y="20" width="30" height="30" fill="#0f0" stroke="#f00" stroke-width="6"/><rect x="70" y="20" width="30" height="30" fill="#0f0" stroke="#f00" stroke-width="6"/>';
const FAR_BLEND =
  '<rect x="10" y="10" width="40" height="40" fill="#f00"/><rect x="60" y="10" width="40" height="40" fill="#00f" style="mix-blend-mode:multiply"/>';
const FAR_FILTER =
  '<filter id="b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2"/></filter><rect x="10" y="10" width="40" height="40" fill="#f00" filter="url(#b)"/><rect x="60" y="10" width="40" height="40" fill="#00f"/>';
for (const route of ['none', 'lb']) {
  console.log(`\n  route ${route}:`);
  const comps = async (body, draw) => (await frames(body, route, draw)).comps.length;
  const half = (R, b) => R.drawBundle(b, { alpha: 0.5 });
  const g = await frames(FAR, route, half);
  ok(
    g.comps.length === 0,
    `(H) two leaves 10 px apart at .5: no accumulator, no composite (${g.comps.length})`,
  );
  ok(
    g.leafAlpha.length > 0 && g.leafAlpha.every((v) => near(v, 0.5)),
    `(H) ...each leaf carries the draw alpha (${JSON.stringify([...new Set(g.leafAlpha)])})`,
  );
  ok((await comps(FAR_STROKES, half)) === 0, `(H) two stroke-only leaves 22 px apart: direct`);
  ok(
    (await comps(NEAR, half)) === 1,
    `(H) leaves 3 px apart (inside the 2 px AA pads) keep the group`,
  );
  ok((await comps(TOUCH, half)) === 1, `(H) leaves overlapping by 1 px keep the group`);
  ok(
    (await comps(NEAR_STROKES, half)) === 1,
    `(H) stroke leaves whose ink boxes (+AA pad) touch keep the group`,
  );
  ok(
    (await comps(TWO_FS, half)) === 1,
    `(H) two fill+stroke elements far apart: each stroke's inner half is on its own fill, the group stays`,
  );
  ok(
    (await comps(FAR_BLEND, half)) >= 1,
    `(H) a blend-mode leaf is isolated by the group even when nothing overlaps`,
  );
  ok(
    (await comps(FAR_FILTER, half)) >= 1,
    `(H) a filtered leaf reaches past its box: the group stays`,
  );
  // many leaves: 60 disjoint rects go direct (a sorted sweep, not a pairwise test); one pair overlapping by 1 px sends the bundle to the group
  const grid60 = (extra) =>
    '<rect width="1" height="1" fill="none"/>' +
    Array.from(
      { length: 60 },
      (_, i) =>
        `<rect x="${(i % 10) * 12 + 1}" y="${((i / 10) | 0) * 12 + 1}" width="7" height="7" fill="#${((i * 37) % 256).toString(16).padStart(2, '0')}80f0"/>`,
    ).join('') +
    (extra || '');
  ok((await comps(grid60(), half)) === 0, `(H) 60 disjoint leaves at .5: direct`);
  ok(
    (await comps(grid60('<rect x="7.5" y="1" width="3" height="3" fill="#0f0"/>'), half)) === 1,
    `(H) 61 leaves, one overlapping its neighbor by 1 px: the group`,
  );
  // the verdict follows the placement: the same bundle scaled up until the gap closes takes the group; scaled back, it is direct again
  const sc = (k) => (R, b) =>
    R.drawBundle(b, { alpha: 0.5, worldMatrix: new Float32Array([k, 0, 0, 0, k, 0, 0, 0, 1]) });
  {
    const d1 = await comps(FAR, sc(1)),
      d2 = await comps(FAR, sc(0.2));
    ok(
      d1 === 0 && d2 === 1,
      `(H) the same bundle at 1x is direct, at .2x its 10 px gap is 2 px, inside the AA pads: the group (${d1}, ${d2} composites)`,
    );
  }
  // the cached verdict is keyed on the placement: one renderer, the placement changes between frames
  {
    const { F, R, b } = await make(FAR, route);
    const seen = [];
    for (const k of [1, 0.2, 1, 0.2]) {
      F.setFrame(seen.length);
      R.beginFrame([0, 0, 0, 0]);
      R.drawBundle(b, { alpha: 0.5, worldMatrix: new Float32Array([k, 0, 0, 0, k, 0, 0, 0, 1]) });
      R.endFrame();
      const ev = expandInstancedBlits(
        F,
        F.log.filter((e) => e.frame === seen.length),
      );
      const acc = new Set(
        ev.filter((e) => e.op === 'clear' && e.mask & 0x0100 && e.fbo).map((e) => e.fbo),
      );
      seen.push(
        ev.filter(
          (e) =>
            e.op === 'draw' &&
            F.progKeys(e.prog).has('cacheBlitFrag') &&
            acc.has(F.fboOf(e.units[0])),
        ).length,
      );
    }
    ok(
      seen.join() === '0,1,0,1',
      `(H) the verdict is re-derived when the placement changes between frames (composites per frame ${seen})`,
    );
  }
}

console.log('\n  instances:');
// (I) layered instances. FAR-style two-leaf bundle ("TWO") at scale .4: instance width 48 px, centers 30 px apart overlap.
for (const route of ['none', 'lb']) {
  const chain = (alphas, dx) =>
    alphas.map((a, i) => ({
      worldMatrix: new Float32Array([0.4, 0, 0, 0, 0.4, 0, -0.5 + dx * i, 0, 1]),
      alpha: a,
    }));
  // A, B, C at x = -.5, 0, .5 (30 px apart, 48 px wide): A-B and B-C overlap, A-C do not (60 px apart, 48 + 4 wide)
  const c3 = await frames(TWO, route, (R, b) =>
    R.drawBundleInstanced(b, chain([0.5, 0.5, 0.5], 0.5)),
  );
  ok(
    c3.comps.length === 3,
    `(I) a three-instance chain at .5 is three passes when each layer holds one (${c3.comps.length}) -- a chain has no two non-touching ends in order`,
  );
  // four instances at scale .3 (36 px wide, 40 with the pads): i0-i1 touch, i2-i3 touch, i1-i2 do not. Levels 0,1,0,1: two passes.
  const four = (xs, alphas) =>
    xs.map((x, i) => ({
      worldMatrix: new Float32Array([0.3, 0, 0, 0, 0.3, 0, x, 0, 1]),
      alpha: alphas[i],
    }));
  const g4 = await frames(TWO, route, (R, b) =>
    R.drawBundleInstanced(b, four([-0.75, -0.3, 0.45, 0.85], [0.5, 0.5, 0.5, 0.5])),
  );
  // (route 'none' = the instanced fast path: every instance takes a slot of the atlas, drawn together and composited together, so a
  // composite per instance and no layering; route 'lb' = the per-instance loop, which still layers: two passes)
  const wantG4 = route === 'none' ? 4 : 2;
  ok(
    g4.comps.length === wantG4,
    `(I) four instances, two touching pairs, route ${route}: ${route === 'none' ? 'one slot each' : 'layers {i0,i2}{i1,i3}, two passes not four'} (${g4.comps.length} composites, want ${wantG4})`,
  );
  const m4 = await frames(TWO, route, (R, b) =>
    R.drawBundleInstanced(b, four([-0.75, -0.3, 0.45, 0.85], [0.5, 0.25, 0.5, 0.25])),
  );
  const m4t = m4.comps.map((e) => tintOf(e)[0]);
  ok(
    route === 'none'
      ? m4t.length === 4 && m4t.join() === '0.5,0.25,0.5,0.25'
      : m4t.length === 2 && m4t.slice().sort().join() === '0.25,0.5',
    `(I) ...with the alphas [.5 .25 .5 .25] each composite fades at its own alpha, in instance order for slots (${m4.comps.length} composites, tints ${m4t})`,
  );
  const a1 = await frames(TWO, route, (R, b) =>
    R.drawBundleInstanced(b, four([-0.75, -0.3, 0.45, 0.85], [1, 0.5, 1, 0.5])),
  );
  ok(
    a1.comps.length === 1,
    `(I) ...alpha-1 instances are drawn in their layers with no accumulator, and the two faded ones share a layer (${a1.comps.length} composite)`,
  );
  // leaves that cannot overlap: the single instanced draw with a per-instance alpha, however the instances overlap each other
  const dir = await frames(FAR, route, (R, b) =>
    R.drawBundleInstanced(b, chain([0.5, 0.25, 0.75], 0.2)),
  );
  ok(
    dir.comps.length === 0,
    `(I) a bundle whose leaves cannot overlap, three overlapping instances at three alphas: no accumulator (${dir.comps.length})`,
  );
}

console.log('\n  cached mount:');
// (J) a faded draw of a cached mount: one blit of the alpha-1 raster, tinted, no re-bake as the alpha animates
for (const route of ['none']) {
  const { F, R, b } = await make(TWO, route);
  const h = R.createBundleHandle(b, { staticCache: { strategy: CacheStrategy.ForceWholeAsset } });
  const alphas = [0.5, 0.5, 0.5, 0.4, 0.3, 0.2, 1];
  const per = [];
  for (let i = 0; i < alphas.length; i++) {
    F.setFrame(i);
    R.beginFrame([0, 0, 0, 0]);
    h.draw({ alpha: alphas[i] });
    R.endFrame();
    const ev = expandInstancedBlits(
      F,
      F.log.filter((e) => e.frame === i),
    );
    per.push({
      a: alphas[i],
      draws: ev.filter((e) => e.op === 'draw'),
      clears: ev.filter((e) => e.op === 'clear').length,
    });
  }
  for (let i = 3; i < alphas.length - 1; i++) {
    const d = per[i].draws,
      e = d[0];
    ok(
      d.length === 1 &&
        F.progKeys(e.prog).has('cacheBlitFrag') &&
        e.fbo === null &&
        tintOf(e).length === 4 &&
        tintOf(e).every((v) => near(v, per[i].a)),
      `(J) cached mount at alpha ${per[i].a}: ONE draw, the cache blit into the canvas with uTint = alpha (${d.length} draws, tint ${JSON.stringify(e && tintOf(e))})`,
    );
  }
  // every faded frame ENDS in a blit or group composite at that frame's alpha -- including the frame that bakes (a bake must not reset the fade)
  for (let i = 0; i < alphas.length - 1; i++) {
    const e = per[i].draws[per[i].draws.length - 1];
    ok(
      !!e &&
        F.progKeys(e.prog).has('cacheBlitFrag') &&
        e.fbo === null &&
        tintOf(e).length === 4 &&
        tintOf(e).every((v) => near(v, per[i].a)),
      `(J) frame ${i} (alpha ${per[i].a}) ends in a composite at its own alpha, baking or not (tint ${JSON.stringify(e && tintOf(e))})`,
    );
  }
  const last = per[per.length - 1];
  ok(
    last.draws.length === 1 && tintOf(last.draws[0]).every((v) => near(v, 1)),
    `(J) the same mount at alpha 1 is the same single blit at tint 1 (${last.draws.length} draw)`,
  );
  h.dispose && h.dispose();
}

console.log(fail ? `\nFAIL (${fail})` : '\nPASS');
process.exit(fail ? 1 : 0);
