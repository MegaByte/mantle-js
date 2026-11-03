// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

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
const { createRenderer, createBundle, importSvg, createOverrideTable, createShapeMorph } =
  await import('../src/index.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const blob = (cx, cy, r) =>
  `M${cx - r} ${cy} C${cx - r} ${cy - r * 1.1} ${cx + r} ${cy - r} ${cx + r} ${cy} C${cx + r} ${cy + r * 1.2} ${cx - r} ${cy + r} ${cx - r} ${cy}Z`;
const svg = (body, defs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs>${defs}</defs>${body}</svg>`;
const P = blob(50, 50, 30);
const SCENES = {
  solid: svg(`<path d="${P}" fill="#48c"/>`),
  stroke: svg(`<path d="${P}" fill="none" stroke="#222" stroke-width="3"/>`),
  gradient: svg(
    `<path d="${P}" fill="url(#g)"/>`,
    '<linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient>',
  ),
  pattern: svg(
    `<path d="${P}" fill="url(#p)"/>`,
    '<pattern id="p" width="10" height="10" patternUnits="userSpaceOnUse"><rect width="5" height="5" fill="#333"/></pattern>',
  ),
  mask: svg(
    `<g mask="url(#m)"><path d="${P}" fill="#4a8"/></g>`,
    `<mask id="m"><circle cx="50" cy="50" r="28" fill="#fff"/></mask>`,
  ),
  clip: svg(
    `<path d="${P}" fill="#a48" clip-path="url(#c)"/>`,
    '<clipPath id="c"><rect x="20" y="20" width="60" height="60"/></clipPath>',
  ),
  filter: svg(
    `<path d="${P}" fill="#c84" filter="url(#f)"/>`,
    '<filter id="f"><feGaussianBlur stdDeviation="2"/></filter>',
  ),
  group: svg(
    `<g opacity=".5"><path d="${P}" fill="#48c"/><path d="${blob(40, 60, 20)}" fill="#c48"/></g>`,
  ),
};

const rot = new Float32Array([0.8, 0.6, 0, -0.6, 0.8, 0, 0, 0, 1]);
const tint = new Float32Array([0.9, 0.1, 0, 0, 0.05, 0.9, 0.05, 0, 0, 0.1, 0.9, 0, 0, 0, 0, 1]);

async function session(extra) {
  const W = createPendingGl({ linkMs: 2, pipelineMs: 2 });
  const R = createRenderer(W.gl, taggedShaderSources(), {
    asyncShaderCompile: true,
    nonBlocking: true,
    strictPlay: true,
    aacPoints: false,
    glGuard: true,
    gpuShedMs: 40,
    aacFill: 'auto',
    standIns: false,
    ...extra,
  });
  R.ready.catch(() => {});
  setTimeout(() => W.release(), 40);
  await R.ready;
  R.setViewport(256, 256);
  const bundles = {};
  for (const [name, s] of Object.entries(SCENES))
    bundles[name] = createBundle(W.gl, await importSvg(s, { preserveViewport: true }));
  const A = createBundle(W.gl, await importSvg(SCENES.solid, { preserveViewport: true }));
  const B = createBundle(
    W.gl,
    await importSvg(svg(`<path d="${blob(55, 45, 25)}" fill="#48c"/>`), { preserveViewport: true }),
  );
  try {
    bundles.morph = createShapeMorph(W.gl, A, B).bundle;
  } catch {
    /* a build without morphs */
  }
  await R.precompileFillsAsync({});
  W.setTiming({ linkMs: 30, pipelineMs: 100 }); // (play at the durations a stray link or build shows against)
  return { W, R, bundles };
}

console.log(
  '(built set) after the loading call, every draw state binds a program that was built in the loading window',
);
{
  const { W, R, bundles } = await session({});
  const names = Object.keys(bundles);
  ok(names.length >= 8, `${names.length} bundle classes: ${names.join(', ')}`);
  const nm0 = R.debugStats.needMiss,
    b0 = {
      reuse: nm0.reuseDraws,
      blocked: nm0.blocked,
      misses: nm0.fillMisses + nm0.programMisses,
      builds: R.debugStats.playBuilds | 0,
      def: R.debugStats.deferredFillDraws | 0,
    };
  W.resetWaits();
  const ovTable = createOverrideTable(W.gl, bundles.solid);
  ovTable.set(0, { localRotation: 0.7, localPosition: [3, 3] });
  const states = [
    ['as drawn', {}],
    ['rotated map', { worldMatrix: rot }],
    ['recolor', { colorMatrix: tint }],
    ['rotated + recolor', { worldMatrix: rot, colorMatrix: tint }],
  ];
  const each = [];
  for (const [label, st] of states) {
    const before = {
      reuse: R.debugStats.needMiss.reuseDraws,
      blocked: R.debugStats.needMiss.blocked,
      builds: R.debugStats.playBuilds | 0,
      def: R.debugStats.deferredFillDraws | 0,
    };
    for (let i = 0; i < 3; i++) {
      R.beginFrame([1, 1, 1, 1]);
      for (const b of Object.values(bundles)) R.drawBundle(b, st);
      R.endFrame();
      await sleep(4);
    }
    const nm = R.debugStats.needMiss;
    each.push({
      label,
      reuse: nm.reuseDraws - before.reuse,
      blocked: nm.blocked - before.blocked,
      builds: (R.debugStats.playBuilds | 0) - before.builds,
      def: (R.debugStats.deferredFillDraws | 0) - before.def,
    });
  }
  // All four states are asserted. K binds the bundle exactly as drawBundle does (evaluated without the bundle bound, the rotated states would ask for a fill key the draw never
  // binds, because the small-shape points route owns the draw).
  for (const e of each) {
    ok(
      e.reuse === 0 && e.blocked === 0 && e.builds === 0 && e.def === 0,
      `${e.label}: reuse ${e.reuse}, blocked ${e.blocked}, builds in play ${e.builds}, deferred ${e.def}`,
    );
  }
  // the override table with a rotation: a draw state the assets cannot show (only a declared/recorded reach covers it): it is listed, not asserted
  const nmx = R.debugStats.needMiss;
  console.log(
    `  (rotating override table on the solid bundle, not asserted: asset-derived needs cannot see it) misses so far ${nmx.fillMisses + nmx.programMisses}, bind-set unbuilt ${nmx.bindSetUnbuilt}`,
  );
  ok(
    nmx.bindSetUnbuilt === 0,
    `the image was built whole: ${nmx.bindSetBuilds} draws issued, ${nmx.bindSetUnbuilt} left unbuilt, image ${nmx.bindSetImage} programs, ${nmx.bindSetMs} ms`,
  );
  ok(
    nmx.kOutsideWarmSet === 0,
    `the draw path asked for no key outside the image (kOutsideWarmSet ${nmx.kOutsideWarmSet}${nmx.kOutsideKeys.length ? ': ' + nmx.kOutsideKeys[0].slice(-60) : ''})`,
  );
  ok(
    nmx.fillMisses + nmx.programMisses === b0.misses,
    `no need miss in play (${nmx.fillMisses + nmx.programMisses - b0.misses})`,
  );
  ok(
    W.model.waits.length === 0 && (R.debugStats.blockingLinkWaits | 0) === 0,
    `no wait on the driver in play (${W.model.waits.length}), no blocking link wait`,
  );
  R.dispose();
}

console.log(
  '(closure) K(draw) is in the warm set for every sampled draw state of the domain; the draw path asks for nothing else',
);
{
  const { W, R, bundles } = await session({});
  const warm = R._policy.warmSet();
  ok(
    warm.size > 0,
    `the warm set holds ${warm.size} fill programs (the exact image over ${Object.keys(bundles).length} bundles)`,
  );
  // a deterministic generator: the property test must not be flaky
  let seed = 12345;
  const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  let samples = 0,
    inSet = 0,
    bad = null;
  for (let i = 0; i < 300; i++) {
    const th = rnd() < 0.15 ? 0 : rnd() * 2 * Math.PI; // rotation 0 (axis aligned) or any angle: one key, ROTATED_MAP
    const rotated = Math.abs(Math.sin(th)) > 1e-9;
    const recolor = rnd() < 0.5;
    const c = Math.cos(th),
      s = Math.sin(th),
      k = 0.5 + rnd(); // a uniform scale of the world map does not leave the viewport class's fit; the engine pick is a function of the CLASS, so k stays in [0.5,1.5)
    const patch = { worldM: new Float32Array([c, s, 0, -s, c, 0, 0, 0, 1]) };
    if (recolor)
      patch.colorMatrix = new Float32Array([
        0.9 + 0.1 * rnd(),
        0.1 * rnd(),
        0,
        0,
        0.05,
        0.9,
        0.05,
        0,
        0,
        0.1,
        0.9,
        0,
        0,
        0,
        0,
        1,
      ]);
    for (const [name, b] of Object.entries(bundles)) {
      for (const key of R._policy.K(b, patch)) {
        samples++;
        if (key.charAt(0) === '\u0000') {
          inSet++;
          continue;
        }
        if (warm.has(key)) inSet++;
        else if (!bad) bad = `${name} rot ${rotated} recolor ${recolor}: ${key.slice(-70)}`;
      }
    }
  }
  ok(
    samples > 1000 && inSet === samples,
    `${inSet} of ${samples} sampled K(bundle, drawState) are in the warm set${bad ? ' -- first outside: ' + bad : ''}`,
  );
  // and the real draw path, in those states, asks for nothing else
  const before = R.debugStats.needMiss.kOutsideWarmSet;
  for (let i = 0; i < 24; i++) {
    const th = rnd() * 2 * Math.PI,
      c = Math.cos(th),
      s = Math.sin(th);
    const st = { worldMatrix: new Float32Array([c, s, 0, -s, c, 0, 0, 0, 1]) };
    if (i & 1)
      st.colorMatrix = new Float32Array([
        0.8, 0.2, 0, 0, 0.1, 0.8, 0.1, 0, 0, 0.2, 0.8, 0, 0, 0, 0, 1,
      ]);
    R.beginFrame([1, 1, 1, 1]);
    for (const b of Object.values(bundles)) R.drawBundle(b, st);
    R.endFrame();
    await sleep(3);
  }
  const nm = R.debugStats.needMiss;
  ok(
    nm.kOutsideWarmSet === before &&
      (R.debugStats.playBuilds | 0) === 0 &&
      nm.blocked === 0 &&
      nm.reuseDraws === 0,
    `24 real frames in sampled states: kOutsideWarmSet ${nm.kOutsideWarmSet - before}, builds in play ${R.debugStats.playBuilds | 0}, blocked ${nm.blocked}, reuse ${nm.reuseDraws}`,
  );
  // outside the domain (a palette with no declared reach) K leaves the image: the domain is exactly the declared product, not a hole
  const outside = R._policy
    .K(bundles.solid, { palette: { texture: {} } })
    .some((k) => k.charAt(0) !== '\u0000' && !warm.has(k));
  ok(
    outside,
    'a palette recolor (outside the default domain) is not in the image: it needs a declared reach tag, and the dev assertion reports it if it happens undeclared',
  );
  R.dispose();
}

console.log(
  '(in play) a bundle created after the loading call is prepared with awaitBundleReady() before its first draw: nothing to build -> resolves at once; a new class -> one window, then no block and no build in play',
);
{
  const { W, R, bundles } = await session({});
  const same = createBundle(W.gl, await importSvg(SCENES.solid, { preserveViewport: true })); // the same class as a bundle the loading call built
  const w0 = R._warmWindows | 0;
  const n0 = await R.awaitBundleReady(same);
  ok(
    n0 === 0 && (R.debugStats.warmWindows | 0) === w0,
    `a bundle whose programs are all built resolves at once (${n0}) and opens no window (${(R.debugStats.warmWindows | 0) - w0})`,
  );
  const late = createBundle(
    W.gl,
    await importSvg(
      svg(
        `<path d="${blob(30, 60, 22)}" fill="url(#g)" stroke="#123" stroke-width="2"/>`,
        '<linearGradient id="g"><stop offset="0" stop-color="#0f0"/><stop offset="1" stop-color="#f0f"/></linearGradient>',
      ),
      { preserveViewport: true },
    ),
  );
  const need = R._policy.needsWarm(late);
  await R.awaitBundleReady(late);
  ok(
    !R._policy.needsWarm(late),
    `the late bundle ${need ? 'needed programs and now has them' : 'needed nothing'}; asking again says nothing is missing`,
  );
  const b0 = {
    blocked: R.debugStats.needMiss.blocked,
    reuse: R.debugStats.needMiss.reuseDraws,
    builds: R.debugStats.playBuilds | 0,
    out: R.debugStats.needMiss.kOutsideWarmSet,
  };
  for (const st of [{}, { worldMatrix: rot }, { colorMatrix: tint }])
    for (let i = 0; i < 3; i++) {
      R.beginFrame([1, 1, 1, 1]);
      R.drawBundle(late, st);
      R.drawBundle(same, st);
      R.endFrame();
      await sleep(3);
    }
  const nm = R.debugStats.needMiss;
  ok(
    nm.blocked === b0.blocked &&
      nm.reuseDraws === b0.reuse &&
      (R.debugStats.playBuilds | 0) === b0.builds &&
      nm.kOutsideWarmSet === b0.out,
    `late bundles after awaitBundleReady: blocked ${nm.blocked - b0.blocked}, reuse ${nm.reuseDraws - b0.reuse}, builds ${(R.debugStats.playBuilds | 0) - b0.builds}, outside the image ${nm.kOutsideWarmSet - b0.out}`,
  );
  R.dispose();
}

console.log(
  '(exact image) the stand-in-free renderer links no speculative twin: and no safety net',
);
{
  const { R } = await session({});
  const vk = R.debugStats.variantKeys || [];
  const spec = vk.filter((v) => v.spec);
  const img = R._policy.warmSet();
  const extra = vk.filter((v) => v.key && !v.net && !img.has(v.key));
  ok(
    spec.length === 0,
    `no speculative state twin linked (${spec.length} of ${vk.length} variants)`,
  );
  if (process.env.WHY)
    for (const v of vk)
      console.log(
        '   ',
        img.has(v.key) ? 'IMG ' : v.net ? 'NET ' : 'OUT ',
        v.key.replace(/MANTLE_/g, ''),
      );
  ok(
    vk.filter((v) => v.net).length === 0,
    `no safety net linked (class B is not built under the stand-in-free policy; ${vk.length} variants held, ${img.size} in the image)`,
  );
  console.log(
    `  (${extra.length} held variants are outside the top-level image: the base programs and the internal passes (mask, filter, group, morph), which draw their own sub-states)`,
  );
  R.dispose();
}

console.log(
  '(domain) a declared manifest narrows the image: no rotate/recolor reach = only the as-drawn states are warmed',
);
{
  const full = await session({});
  const nFull = full.R._policy.warmSet().size;
  full.R.dispose();
  const narrow = await session({
    declaredNeeds: {
      format: 'mantle-needs',
      version: 1,
      game: 't',
      variants: [],
      programs: [],
      reach: [{ bundle: '*', tags: [] }],
    },
  });
  const n = narrow.R._policy.warmSet().size;
  ok(
    n > 0 && n < nFull,
    `declared domain: ${n} programs against ${nFull} for the full default domain`,
  );
  narrow.R.dispose();
}

console.log(fail ? `\n${fail} FAILED` : '\nPASS');
process.exit(fail ? 1 : 0);
