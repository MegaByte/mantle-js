// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// groupTargetPickWarmSmoke -- the engine pick's two outcomes are both in the warm image whenever a draw's world matrix can reach the pick's bar.
//
// A tiled scene under the stand-in-free policy (one tile shape, 4 shapes, a hue-rotation colorMatrix per tile, drawn into the alpha group's
// accumulator at alpha 1 inside it) can want the Slug side of the AAC pick in play, a blocking program build, when the warm image holds only the
// MANTLE_AAC side. The group is not the cause: the accumulator is canvas-sized and drawn with the canvas viewport, so the pick sees the canvas's
// drawn scale. The cause is the SCALE: the pick reads unit px2 = viewport fit x |det| of the draw's world matrix (shapeScale.unitPx2); tiles that
// pop in from scale 0 and are faded only while they pop in put the one frame that lands below the bar in a group draw; and a warm image that asks
// K at the viewport sizes of the reachable range only, with the world matrix as drawn at load, misses it.
// Pinned (fillPass.js wantKeysOf): a bundle whose pick has a bar in (0, inf) has both outcomes in its image; after the loading call, the faded, recolored
// pop-in (instanced, per instance colorMatrix, and drawBundle), and the same small scale at alpha 1 on the canvas, build no pipeline, wait for nothing and
// play no build; a bundle whose pick cannot flip (an arc row: the bar is infinite) gains no key. CPU, driver-model stand-in (test/_pendingGl.mjs).
globalThis.__MANTLE_DEBUG__ = true;
globalThis.__MANTLE_NO_STATIC_CACHE = true;
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
globalThis.window = { addEventListener: () => {} };
const { taggedShaderSources } = await import('./_fakeGl.mjs');
const { createPendingGl } = await import('./_pendingGl.mjs');
const { createRenderer, createBundle, importSvg } = await import('../src/index.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// four overlapping line-only fills (the variant key: MANTLE_NO_QUAD|MANTLE_NO_CUBIC|MANTLE_NO_ARC), so a faded draw needs the group
const TILE =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M10 10 L45 10 L45 45 L10 45Z" fill="#f00"/><path d="M30 30 L70 30 L70 70 L30 70Z" fill="#0f0"/>' +
  '<path d="M55 55 L90 55 L90 90 L55 90Z" fill="#00f"/><path d="M10 60 L40 60 L25 90Z" fill="#ff0"/></svg>';
const ARCS =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M20 50 A30 30 0 1 1 80 50 A30 30 0 1 1 20 50Z" fill="#f00"/><path d="M40 50 A10 10 0 1 1 60 50 A10 10 0 1 1 40 50Z" fill="#00f"/></svg>';
// a hue rotation (column-major), as a tiled scene recolors its tiles: not diagonal, so the instanced call takes the per-instance loop
const hue = (t) => {
  const c = Math.cos(t),
    s = Math.sin(t);
  return new Float32Array([
    0.213 + c * 0.787 - s * 0.213,
    0.213 - c * 0.213 + s * 0.143,
    0.213 - c * 0.213 - s * 0.787,
    0,
    0.715 - c * 0.715 - s * 0.715,
    0.715 + c * 0.285 + s * 0.14,
    0.715 - c * 0.715 + s * 0.715,
    0,
    0.072 - c * 0.072 + s * 0.928,
    0.072 - c * 0.072 - s * 0.283,
    0.072 + c * 0.928 + s * 0.072,
    0,
    0,
    0,
    0,
    1,
  ]);
};
const HUE = hue(2);
const at = (k, x = 0, y = 0) => new Float32Array([k, 0, 0, 0, k, 0, x, y, 1]);
const hasAac = (k) => k.split('|').includes('MANTLE_AAC');

async function load(svgs) {
  const W = createPendingGl({ linkMs: 30, pipelineMs: 100 });
  const R = createRenderer(W.gl, taggedShaderSources(), {
    asyncShaderCompile: true,
    nonBlocking: true,
    strictPlay: true,
    aacFill: 'auto',
    standIns: false,
    needMissPolicy: 'block',
  });
  R.ready.catch(() => {});
  setTimeout(() => W.release(), 40);
  await R.ready;
  R.setViewport(1024, 640);
  const bundles = [];
  for (const s of svgs)
    bundles.push(createBundle(W.gl, await importSvg(s, { preserveViewport: true })));
  // the tiles mount collapsed (scale 0): the loading round sees them at rest or not at all
  R.beginFrame([1, 1, 1, 1]);
  for (const b of bundles) R.drawBundle(b, { colorMatrix: HUE, worldMatrix: at(0.3) });
  R.endFrame();
  await R.precompileFillsAsync({});
  return { W, R, bundles };
}
function inPlay(W, R) {
  const p0 = W.model.pipelines,
    w0 = W.model.waits.length,
    ds0 = { ...R.debugStats };
  return () => {
    const d = (k) => (R.debugStats[k] | 0) - (ds0[k] | 0);
    return {
      pipelines: W.model.pipelines - p0,
      waits: W.model.waits.length - w0,
      playBuilds: d('playBuilds'),
      deferred: d('deferredFillDraws'),
      keys: (R.debugStats.needMiss && R.debugStats.needMiss.keys) || [],
    };
  };
}
const clean = (r) => r.pipelines === 0 && r.waits === 0 && r.playBuilds === 0 && r.deferred === 0;
const say = (r) =>
  `${r.pipelines} pipelines built, ${r.waits} waits, ${r.playBuilds} play builds, ${r.deferred} deferred${r.keys.length ? ' ' + JSON.stringify(r.keys) : ''}`;
// the enter pop: scale from tiny to an overshoot, alpha rising to 1 (alpha = min(1, 1.6 t), scale = baseScale * easeOutBack(t))
const POP = [0.02, 0.05, 0.08, 0.12, 0.2, 0.3, 0.33];

console.log(
  '(image) a bundle whose engine pick has a bar holds both outcomes; an arc bundle (no bar) gains none',
);
{
  const {
    R,
    bundles: [tile, arcs],
  } = await load([TILE, ARCS]);
  const img = R._policy.image(tile).map((e) => e.key),
    imgArc = R._policy.image(arcs).map((e) => e.key);
  ok(
    img.some(hasAac) && img.some((k) => !hasAac(k)),
    `the tile's image has the AAC and the Slug side (${img.filter(hasAac).length} + ${img.filter((k) => !hasAac(k)).length} keys)`,
  );
  ok(
    arcs.segTypeMask & 8 ? !imgArc.some(hasAac) : true,
    `the arc bundle's image has no AAC key (${imgArc.length} keys, segTypeMask ${arcs.segTypeMask})`,
  );
  R.dispose();
}
console.log(
  '(pop-in, instanced) faded tiles with a per-instance hue rotation, scale from 0.02 to 0.33: each faded tile is a group',
);
{
  const {
    W,
    R,
    bundles: [tile],
  } = await load([TILE]);
  const done = inPlay(W, R);
  for (const k of POP) {
    R.beginFrame([1, 1, 1, 1]);
    R.drawBundleInstanced(tile, [
      { worldMatrix: at(k, -0.5), alpha: Math.min(1, 0.2 + k * 2), colorMatrix: HUE },
      { worldMatrix: at(0.3, 0.5), colorMatrix: hue(4) },
    ]);
    R.endFrame();
    await sleep(4);
  }
  const r = done();
  ok(clean(r), `in play: ${say(r)}`);
  R.dispose();
}
console.log(
  '(pop-in, drawBundle) the same tile faded at alpha 0.5 through the scales, and at alpha 1 on the canvas',
);
{
  const {
    W,
    R,
    bundles: [tile],
  } = await load([TILE]);
  const done = inPlay(W, R);
  for (const k of POP)
    for (const alpha of [0.5, 1]) {
      R.beginFrame([1, 1, 1, 1]);
      R.drawBundle(tile, { colorMatrix: HUE, worldMatrix: at(k), alpha });
      R.endFrame();
      await sleep(4);
    }
  const r = done();
  ok(clean(r), `in play: ${say(r)}`);
  R.dispose();
}
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
