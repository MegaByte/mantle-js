// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// declareReachSmoke -- renderer.declareReach(bundle, tags): the app names a bundle's draw states, and the warm builds those and no others.
//
// Without a declaration every bundle's warm image covers every state an API could reach (as drawn, rotated, recolored, both): a scene can link
// 217 programs and draw 23 in play. A source scan of an app knows its assets and the APIs its code calls on them, not their content keys, so the
// declaration is per bundle. A state outside a declaration, drawn anyway, is reported (debugStats.needMiss.kOutsideWarmSet).
// CPU, driver-model stand-in (test/_pendingGl.mjs).
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
const { createRenderer, createBundle, importSvg, createShapeTimeline } =
  await import('../src/index.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M20 50 C20 20 80 20 80 50 C80 80 20 80 20 50Z" fill="#48c"/><path d="M40 40 L60 40 L50 70Z" fill="url(#g)"/><defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs></svg>';
const rot = new Float32Array([0.8, 0.6, 0, -0.6, 0.8, 0, 0, 0, 1]);
const tint = new Float32Array([0.9, 0.1, 0, 0, 0.05, 0.9, 0.05, 0, 0, 0.1, 0.9, 0, 0, 0, 0, 1]);
const isRot = (k) => k.includes('MANTLE_ROTATED_MAP');
const isRecolor = (k) => !k.includes('MANTLE_NO_RECOLOR') && k.includes('MANTLE_NO_');

console.log(
  '(declared reach) as drawn only, rotate only, and undeclared: the image holds exactly the declared states; an undeclared state is reported',
);
{
  const W = createPendingGl({ linkMs: 2, pipelineMs: 2 });
  const R = createRenderer(W.gl, taggedShaderSources(), {
    asyncShaderCompile: true,
    nonBlocking: true,
    strictPlay: true,
    glGuard: true,
    aacFill: 'auto',
    aacPoints: false,
    standIns: false,
    needMissPolicy: 'block',
  });
  R.ready.catch(() => {});
  setTimeout(() => W.release(), 40);
  await R.ready;
  R.setViewport(256, 256);
  const still = createBundle(W.gl, await importSvg(SVG, { preserveViewport: true }));
  const turns = createBundle(W.gl, await importSvg(SVG, { preserveViewport: true }));
  const any = createBundle(W.gl, await importSvg(SVG, { preserveViewport: true }));
  R.declareReach(still, []);
  R.declareReach(turns, ['rotate']);
  await R.precompileFillsAsync({});
  W.setTiming({ linkMs: 30, pipelineMs: 100 }); // (play at the durations a stray link or build shows against)
  const img = (b) =>
    R._policy
      .image(b)
      .map((e) => e.key)
      .filter((k) => k.charAt(0) !== '\u0000');
  const iS = img(still),
    iT = img(turns),
    iA = img(any);
  ok(
    iS.length > 0 && !iS.some(isRot) && !iS.some(isRecolor),
    `as drawn only: ${iS.length} keys, none rotated or recolored`,
  );
  ok(
    iT.some(isRot) && !iT.some(isRecolor),
    `rotate only: ${iT.length} keys, rotated ones included, none recolored`,
  );
  ok(
    iA.some(isRot) && iA.some(isRecolor) && iA.length > iT.length && iT.length > iS.length,
    `undeclared: the full default domain (${iA.length} keys > ${iT.length} > ${iS.length})`,
  );
  const nm0 = R.debugStats.needMiss,
    b0 = { blocked: nm0.blocked, builds: R.debugStats.playBuilds | 0, out: nm0.kOutsideWarmSet };
  for (let i = 0; i < 3; i++) {
    R.beginFrame([1, 1, 1, 1]);
    R.drawBundle(still);
    R.drawBundle(turns, { worldMatrix: rot });
    R.drawBundle(any, { worldMatrix: rot, colorMatrix: tint });
    R.endFrame();
    await sleep(4);
  }
  const nm1 = R.debugStats.needMiss;
  ok(
    nm1.blocked === b0.blocked &&
      (R.debugStats.playBuilds | 0) === b0.builds &&
      nm1.kOutsideWarmSet === b0.out,
    `declared states in play: blocked ${nm1.blocked - b0.blocked}, builds ${(R.debugStats.playBuilds | 0) - b0.builds}, outside ${nm1.kOutsideWarmSet - b0.out}`,
  );
  R.declareReach(still, null);
  ok(
    img(still).length === iA.length,
    `declareReach(bundle, null) returns it to the default domain (${img(still).length} keys)`,
  );
  R.dispose();
}
console.log(
  '(declared reach) a timeline over declared poses: its shared pair morph reaches what its poses reach',
);
{
  const W = createPendingGl({ linkMs: 2, pipelineMs: 2 });
  const R = createRenderer(W.gl, taggedShaderSources(), {
    asyncShaderCompile: true,
    nonBlocking: true,
    strictPlay: true,
    glGuard: true,
    aacFill: 'auto',
    aacPoints: false,
    standIns: false,
    needMissPolicy: 'block',
  });
  R.ready.catch(() => {});
  setTimeout(() => W.release(), 40);
  await R.ready;
  R.setViewport(256, 256);
  const A = createBundle(W.gl, await importSvg(SVG, { preserveViewport: true }));
  const B = createBundle(
    W.gl,
    await importSvg(SVG.replace('M20 50 C20 20 80 20', 'M15 50 C15 15 85 15'), {
      preserveViewport: true,
    }),
  );
  R.declareReach(A, []);
  R.declareReach(B, []);
  const tl = createShapeTimeline(
    W.gl,
    [A, B],
    [
      { time: 0, bundleIndex: 0 },
      { time: 1, bundleIndex: 1 },
    ],
  );
  tl.setTime(0.5);
  await R.precompileFillsAsync({});
  W.setTiming({ linkMs: 30, pipelineMs: 100 }); // (play at the durations a stray link or build shows against)
  const mk = R._policy
    .image(tl.bundle)
    .map((e) => e.key)
    .filter((k) => k.charAt(0) !== '\u0000');
  ok(
    mk.length > 0 && !mk.some(isRot) && !mk.some(isRecolor),
    `the morph's image is its poses' reach (${mk.length} keys, none rotated or recolored)`,
  );
  tl.dispose();
  R.dispose();
}
console.log(
  '(declared reach) a state outside a declaration, drawn anyway, is reported (no other bundle builds its key here)',
);
{
  const W = createPendingGl({ linkMs: 2, pipelineMs: 2 });
  const R = createRenderer(W.gl, taggedShaderSources(), {
    asyncShaderCompile: true,
    nonBlocking: true,
    strictPlay: true,
    glGuard: true,
    aacFill: 'auto',
    aacPoints: false,
    standIns: false,
    needMissPolicy: 'block',
  });
  R.ready.catch(() => {});
  setTimeout(() => W.release(), 40);
  await R.ready;
  R.setViewport(256, 256);
  const still = createBundle(W.gl, await importSvg(SVG, { preserveViewport: true }));
  R.declareReach(still, []);
  await R.precompileFillsAsync({});
  W.setTiming({ linkMs: 30, pipelineMs: 100 }); // (play at the durations a stray link or build shows against)
  const o0 = R.debugStats.needMiss.kOutsideWarmSet;
  for (let i = 0; i < 2; i++) {
    R.beginFrame([1, 1, 1, 1]);
    R.drawBundle(still, { colorMatrix: tint });
    R.endFrame();
    await sleep(4);
  }
  ok(
    R.debugStats.needMiss.kOutsideWarmSet > o0,
    `the recolored draw is reported outside the image (kOutsideWarmSet +${R.debugStats.needMiss.kOutsideWarmSet - o0})`,
  );
  R.dispose();
}
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
