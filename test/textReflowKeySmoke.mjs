// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// textReflowKeySmoke -- a text bundle's warm image covers every string of its font.
//
// setText re-flows a text bundle in place. Its segment-type mask came from the current string (a "0" is all curves, a "147" all lines), so a re-flow changed the
// fill program to one the loading call never built: a puzzle HUD's score went "0" after loading and its first draws stood in, then blocked and built in
// play (debugStats.needMiss.playBuildWhy: mount:hud.score.number). The mask is the font's outline types, and the image holds both outcomes of the AAC gate
// (its data is the string's): what any string of the font asks for is in the image built at load.
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
const { readFileSync } = await import('fs');
const { requireAsset, fontFixture } = await import('./_assets.mjs');
const { taggedShaderSources } = await import('./_fakeGl.mjs');
const { createPendingGl } = await import('./_pendingGl.mjs');
const { createRenderer, createTextBundle, MantleFontAsset } = await import('../src/index.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const font = new MantleFontAsset(
  new Uint8Array(readFileSync(requireAsset(fontFixture('roboto-regular.ttf')))),
);

console.log(
  '(text re-flow) the key of a text bundle is the same for every string of its font, and a re-flow after loading builds nothing in play',
);
{
  const W = createPendingGl({ linkMs: 2, pipelineMs: 2 });
  const R = createRenderer(W.gl, taggedShaderSources(), {
    asyncShaderCompile: true,
    nonBlocking: true,
    strictPlay: true,
    glGuard: true,
    aacFill: 'auto',
    standIns: false,
    needMissPolicy: 'block',
  });
  R.ready.catch(() => {});
  setTimeout(() => W.release(), 40);
  await R.ready;
  R.setViewport(256, 256);
  const tb = await createTextBundle(W.gl, {
    font,
    text: '0',
    style: { fontSize: 1, fill: [0, 0, 0, 1] },
  });
  const k0 = R._policy.K(tb.bundle).join('\n');
  await R.precompileFillsAsync({});
  W.setTiming({ linkMs: 30, pipelineMs: 100 }); // (play at the durations a stray link or build shows against)
  const b0 = {
    blocked: R.debugStats.needMiss.blocked,
    reuse: R.debugStats.needMiss.reuseDraws,
    builds: R.debugStats.playBuilds | 0,
    out: R.debugStats.needMiss.kOutsideWarmSet,
    si: R.debugStats.needMiss.standInDraws,
  };
  const keys = [k0];
  for (const t of ['147', '0', 'Hello, 42', '-']) {
    await tb.setText(t);
    keys.push(R._policy.K(tb.bundle).join('\n'));
    for (let i = 0; i < 3; i++) {
      R.beginFrame([1, 1, 1, 1]);
      R.drawBundle(tb.bundle);
      R.endFrame();
      await sleep(4);
    }
  }
  const img = new Set(k0.split('\n'));
  const outside = keys.flatMap((k) => k.split('\n')).filter((k) => !img.has(k));
  ok(
    outside.length === 0,
    `every key "147", "0", "Hello, 42", "-" ask for is in the image built for "0" at load (${outside.length} outside)`,
  );
  ok(
    !/MANTLE_NO_LINE|MANTLE_NO_QUAD/.test(k0),
    'the key keeps the TrueType outline types (lines and quads)',
  );
  const nm = R.debugStats.needMiss;
  ok(
    nm.blocked === b0.blocked &&
      nm.reuseDraws === b0.reuse &&
      (R.debugStats.playBuilds | 0) === b0.builds &&
      nm.kOutsideWarmSet === b0.out &&
      nm.standInDraws === b0.si,
    `re-flowed and drawn in play: blocked ${nm.blocked - b0.blocked}, reuse ${nm.reuseDraws - b0.reuse}, builds ${(R.debugStats.playBuilds | 0) - b0.builds}, outside the image ${nm.kOutsideWarmSet - b0.out}, stand-ins ${nm.standInDraws - b0.si}`,
  );
  R.dispose();
}
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
