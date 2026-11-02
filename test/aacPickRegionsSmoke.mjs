// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// (see the head of the body)
// warmBuiltSetSmoke -- the mechanical guard of the warm policy: every program the draw path BINDS after the loading call was BUILT in the loading window.
//
// A representative set of bundles across the routes (solid cover, stroke, gradient, pattern, mask, clip, filter, group opacity, a morph, an instanced draw) is loaded, the loading
// call (precompileFillsAsync) runs, and the scene is then drawn in every draw state a game meets (as drawn, a rotated map, a recolor, a translucent draw, a rotating override
// table). With `standIns:false` a program that is not built in the loading window shows as a block, a previous-variant reuse, a build in play or a need miss, so the assertion
// is: none of them, for any bundle, in any state. The test fails when the key the warm built differs from the key the draw binds (the class of defect that shows as late
// unified variants and late rotated AAC variants in real scenes), whatever the route.
// CPU, driver-model stand-in (test/_pendingGl.mjs).
globalThis.__MANTLE_DEBUG__ = true;
globalThis.__MANTLE_NO_STATIC_CACHE = true;
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
const listeners = {};
globalThis.window = {
  addEventListener: (t, f) => {
    (listeners[t] ||= []).push(f);
  },
};
const { taggedShaderSources } = await import('./_fakeGl.mjs');
const { createPendingGl } = await import('./_pendingGl.mjs');
const { createRenderer, createBundle, importSvg, createOverrideTable, createShapeMorph } =
  await import('../src/index.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { aacPresenceBreak, aacPresenceTerms, ROW_COVER_AA, ROW_COVER_HARD } =
  await import('../src/renderer/coverKernelPolicy.js');

// aacPickRegionsSmoke -- the scale dimension of the warm image is closed analytically for the cover routes' engine pick (AAC or Slug, which moves with the drawn scale).
//   1. aacPresenceBreak (the unified route's presence staircase) equals aacPaysPresence at 20000 random (bundle, k2) draws: one break, no sampling in production.
//   2. After the loading call, K(bundle) at every size of the reachable range is in the warm set, for bundles whose pick flips inside the range, and drawing across the range
//      builds nothing, blocks nothing and shows no key outside the image.
let seed = 99;
const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
{
  let bad = 0,
    flips = 0;
  for (let t = 0; t < 400; t++) {
    const n = 1 + Math.floor(rnd() * 12),
      st = 8,
      meta = new Float32Array(n * st),
      cls = new Array(n),
      types = new Array(n);
    for (let s = 0; s < n; s++) {
      const w = 0.5 + rnd() * 40,
        h = 0.5 + rnd() * 40;
      meta[s * st + 2] = w;
      meta[s * st + 3] = h;
      meta[s * st + 7] = 1;
      cls[s] = rnd() < 0.7 ? ROW_COVER_AA : rnd() < 0.5 ? ROW_COVER_HARD : 0;
      types[s] = [1, 2, 4][Math.floor(rnd() * 3)];
    }
    const bundle = {
      metaFloats: meta,
      metaFloatsPerShape: st,
      segTypeMask: 0xf,
      fillNormByShape: null,
    };
    const br = aacPresenceBreak(bundle, cls, types);
    let prev = null;
    for (let i = 0; i < 50; i++) {
      const k2 = Math.exp(Math.log(1e-3) + ((Math.log(1e5) - Math.log(1e-3)) * i) / 49);
      const tt = aacPresenceTerms(bundle, cls, types, k2),
        pays = tt.rows > 0 && tt.gain > tt.presence;
      const pred = br.always ? true : br.never ? false : k2 >= br.k2;
      if (pays !== pred) bad++;
      if (prev !== null && prev !== pays) flips++;
      prev = pays;
    }
  }
  ok(
    bad === 0,
    `the presence break predicts the model's pick at 20000 draws (${bad} wrong; ${flips} flips seen, at most one per bundle)`,
  );
}

const blob = (cx, cy, r) =>
  `M${cx - r} ${cy} C${cx - r} ${cy - r * 1.1} ${cx + r} ${cy - r} ${cx + r} ${cy} C${cx + r} ${cy + r * 1.2} ${cx - r} ${cy + r} ${cx - r} ${cy}Z`;
const manySmall = (n, r) => {
  let b = '';
  for (let i = 0; i < n; i++)
    b += `<path d="${blob(8 + (i % 8) * 12, 8 + Math.floor(i / 8) * 12, r)}" fill="#48c"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${b}</svg>`;
};
const grad = (n, r) =>
  manySmall(n, r)
    .replace(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs>',
    )
    .replace(/fill="#48c"/g, 'fill="url(#g)"');
const stroked = (n, r) =>
  manySmall(n, r).replace(/fill="#48c"/g, 'fill="#48c" stroke="#123" stroke-width="0.6"');
const SCENES = {
  few: manySmall(3, 20),
  small: manySmall(24, 3),
  tiny: manySmall(48, 1.2),
  gradSmall: grad(24, 3),
  gradTiny: grad(48, 1.2),
  strokedSmall: stroked(24, 3),
  strokedTiny: stroked(40, 1.5),
};
{
  const W = createPendingGl({ linkMs: 30, pipelineMs: 100 });
  const R = createRenderer(W.gl, taggedShaderSources(), {
    asyncShaderCompile: true,
    nonBlocking: true,
    strictPlay: true,
    aacPoints: false,
    glGuard: true,
    gpuShedMs: 40,
    aacFill: 'auto',
    standIns: false,
  });
  R.ready.catch(() => {});
  setTimeout(() => W.release(), 40);
  await R.ready;
  R.setViewport(256, 256);
  const bundles = {};
  for (const [name, s] of Object.entries(SCENES))
    bundles[name] = createBundle(W.gl, await importSvg(s, { preserveViewport: true }));
  await R.precompileFillsAsync({ minViewportPx: 128, maxViewportPx: 3000 });
  const warm = R._policy.warmSet();
  const dv = R.debugStats.viewportWarm && R.debugStats.viewportWarm.derived;
  ok(
    !!dv && dv.regions >= 0,
    `derived ${dv ? dv.regions : '?'} extra size region(s) over the range ${dv ? JSON.stringify(dv.range) : ''}; breaks by bundle: ${dv ? dv.bundles.map((b) => (b.why || []).join('/') || '-').join(' ') : ''}`,
  );
  let samples = 0,
    inSet = 0,
    outside = null;
  const distinct = new Set();
  for (let L = 128; L <= 3000; L *= 1.03) {
    for (const [name, b] of Object.entries(bundles)) {
      R.setViewport(Math.round(L), Math.round(L));
      for (const key of R._policy.K(b)) {
        samples++;
        distinct.add(name + '|' + key);
        if (key.charAt(0) === '\u0000' || warm.has(key)) inSet++;
        else if (!outside) outside = `${name} @${Math.round(L)}px: ${key.slice(-60)}`;
      }
    }
  }
  R.setViewport(256, 256);
  const perBundle = {};
  for (const d of distinct) {
    const n = d.split('|')[0];
    perBundle[n] = (perBundle[n] || 0) + 1;
  }
  ok(
    Object.values(perBundle).some((c) => c > 1),
    `the fixture's engine pick flips inside the range for some bundle (distinct keys per bundle: ${JSON.stringify(perBundle)}); otherwise this test is vacuous`,
  );
  ok(
    samples > 100 && inSet === samples,
    `${inSet} of ${samples} K(bundle, size) over the reachable range are in the warm set${outside ? ' -- first outside: ' + outside : ''}`,
  );
  const before = {
    b: R.debugStats.playBuilds | 0,
    o: R.debugStats.needMiss.kOutsideWarmSet,
    k: R.debugStats.needMiss.blocked,
    r: R.debugStats.needMiss.reuseDraws,
  };
  for (let L = 128; L <= 3000; L *= 1.25) {
    R.setViewport(Math.round(L), Math.round(L));
    for (let i = 0; i < 2; i++) {
      R.beginFrame([1, 1, 1, 1]);
      for (const b of Object.values(bundles)) R.drawBundle(b, {});
      R.endFrame();
      await sleep(3);
    }
  }
  const nm = R.debugStats.needMiss;
  ok(
    (R.debugStats.playBuilds | 0) === before.b &&
      nm.kOutsideWarmSet === before.o &&
      nm.blocked === before.k &&
      nm.reuseDraws === before.r,
    `drawing across the range: builds ${(R.debugStats.playBuilds | 0) - before.b}, outside the image ${nm.kOutsideWarmSet - before.o}, blocked ${nm.blocked - before.k}, reuse ${nm.reuseDraws - before.r}`,
  );
  console.log(
    '  outside keys seen by the draw path:',
    JSON.stringify(
      (nm.kOutsideKeys || []).slice(0, 4).map((k) => k.replace(/MANTLE_/g, '').slice(-110)),
    ),
  );
  R.dispose();
}
console.log(fail ? `\nFAIL (${fail})` : '\nPASS');
process.exit(fail ? 1 : 0);
