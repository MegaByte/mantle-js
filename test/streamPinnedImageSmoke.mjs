// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// (stream variant of the warm guard)
// warmBuiltSetSmoke -- the mechanical guard of the warm policy: every program the draw path BINDS after the loading call was BUILT in the loading window.
//
// A representative set of bundles across the routes (solid cover, stroke, gradient, pattern, mask, clip, filter, group opacity, a morph, an instanced draw) is loaded, the loading
// call (precompileFillsAsync) runs, and the scene is then drawn in every draw state an app meets (as drawn, a rotated map, a recolor, a translucent draw, a rotating override
// table). With `standIns:false` a program that was not built in the loading window shows as a block, a previous-variant reuse, a build in play or a need miss, so the assertion
// is: none of them, for any bundle, in any state. The test fails when the key the warm built differs from the key the draw binds (the class of defect behind late unified
// variants and late rotated AAC variants in real scenes), whatever the route.
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
const { createRenderer, createBundle, buildStreamableSections, updateBundleGeometry } =
  await import('../src/index.js');
const { mkLine, mkCubic } = await import('../src/primitives/seg.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// streamPinnedImageSmoke -- a STREAMED bundle's content is unknown at warm time: a segment type that first appears mid-stream removes a MANTLE_NO_* from its program. Under the
// stand-in-free policy the warm image therefore pins the content omissions of a streamable bundle (one content-agnostic key for its whole life), so streaming a new segment type
// in after the loading call builds nothing, blocks nothing and asks for no key outside the image. (A streamed road: 80 shapes at load, 128 with new kinds at frame 9972.)
const K = 0.5522847498;
const blob = (cx, cy, rx, ry) => {
  const kx = K * rx,
    ky = K * ry;
  const E = [cx + rx, cy],
    N = [cx, cy - ry],
    W = [cx - rx, cy],
    S = [cx, cy + ry];
  return [
    mkCubic(E, [cx + rx, cy - ky], [cx + kx, cy - ry], N),
    mkCubic(N, [cx - kx, cy - ry], [cx - rx, cy - ky], W),
    mkCubic(W, [cx - rx, cy + ky], [cx - kx, cy + ry], S),
    mkCubic(S, [cx + kx, cy + ry], [cx + rx, cy + ky], E),
  ];
};
const withLine = (cx, cy, rx, ry) => {
  const s = blob(cx, cy, rx, ry);
  s[3] = mkLine([cx, cy + ry], [cx + rx, cy]);
  return s;
};
const FILLS = [
  [0.78, 0.2, 0.2, 1],
  [0.2, 0.55, 0.78, 1],
];
const shapesOf = (l) => l.map((segs, i) => ({ segs, fill: FILLS[i] }));
for (const pinned of [true, false]) {
  const W = createPendingGl({ linkMs: 30, pipelineMs: 100 });
  const R = createRenderer(W.gl, taggedShaderSources(), {
    asyncShaderCompile: true,
    nonBlocking: true,
    strictPlay: true,
    aacPoints: false,
    glGuard: true,
    gpuShedMs: 40,
    aacFill: 'auto',
    standIns: pinned ? false : undefined,
  });
  R.ready.catch(() => {});
  setTimeout(() => W.release(), 40);
  await R.ready;
  R.setViewport(256, 256);
  const st = createBundle(
    W.gl,
    buildStreamableSections(shapesOf([blob(70, 70, 30, 30), blob(160, 160, 22, 22)]), null, {
      lightweight: true,
    }),
  );
  updateBundleGeometry(W.gl, st, [blob(72, 68, 31, 29), blob(158, 162, 23, 21)], {
    lightweight: true,
  }); // (the app's first stream frame, before its loading call)
  await R.precompileFillsAsync({});
  const draw = async (n) => {
    for (let i = 0; i < n; i++) {
      R.beginFrame([1, 1, 1, 1]);
      R.drawBundle(st, {});
      R.endFrame();
      await sleep(3);
    }
  };
  await draw(3);
  const maskBefore = st.segTypeMask;
  const keyBefore = R._policy.K(st).join('\n');
  const up = updateBundleGeometry(W.gl, st, [withLine(85, 60, 42, 38), blob(150, 175, 18, 26)], {
    lightweight: true,
  });
  const keyAfter = R._policy.K(st).join('\n');
  const b0 = {
    b: R.debugStats.playBuilds | 0,
    k: R.debugStats.needMiss.blocked,
    o: R.debugStats.needMiss.kOutsideWarmSet,
    r: R.debugStats.needMiss.reuseDraws,
    f: R.debugStats.needMiss.fillMisses,
  };
  await draw(4);
  const nm = R.debugStats.needMiss;
  const d = {
    b: (R.debugStats.playBuilds | 0) - b0.b,
    k: nm.blocked - b0.k,
    o: nm.kOutsideWarmSet - b0.o,
    r: nm.reuseDraws - b0.r,
    f: nm.fillMisses - b0.f,
  };
  console.log(
    `  [${pinned ? 'stand-in-free' : 'default policy: the key follows the content, stand-ins cover the change'}] the stream took a line after the loading call: update ok ${up.ok}, mask 0x${(maskBefore | 0).toString(16)} -> 0x${(st.segTypeMask | 0).toString(16)}; K before == after ${keyBefore === keyAfter}; builds ${d.b}, blocked ${d.k}, outside the image ${d.o}, reuse ${d.r}, fill misses ${d.f}`,
  );
  if (pinned)
    ok(
      up.ok &&
        st.segTypeMask & 1 &&
        keyBefore === keyAfter &&
        d.b === 0 &&
        d.k === 0 &&
        d.o === 0 &&
        d.r === 0 &&
        d.f === 0,
      'the stand-in-free stream has ONE key across the new segment type, covered by its image (no build, no block, no key outside it)',
    );
  if (pinned && process.env.WHY)
    console.log(
      JSON.stringify(
        R.debugStats.needMiss.playBuildWhy.map((w) => ({
          f: w.frame,
          uni: w.uni,
          key: w.key.replace(/MANTLE_/g, ''),
          built: w.built,
          psoReady: w.psoReady,
          gate: w.gateDrawn,
        })),
      ),
      JSON.stringify([...R._policy.warmSet()].map((k) => k.replace(/MANTLE_/g, '').slice(0, 140))),
    );
  R.dispose();
}
console.log(fail ? `\nFAIL (${fail})` : '\nPASS');
process.exit(fail ? 1 : 0);
