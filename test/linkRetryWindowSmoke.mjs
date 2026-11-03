// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// linkRetryWindowSmoke -- a fill key that failed to link is tried again at the next loading call or warm window, once, and never in play.
//
// A failure can be transient: a driver out of memory, a context under pressure. Left failed for the life of the renderer, a bundle stays undrawn after the pressure has gone. Linking it again from a
// draw is a link in play for a picture that may never come, so the frames do not, and a loading call that warms many sizes takes it up once, not per size.
// CPU, driver-model stand-in (test/_pendingGl.mjs). A real link failure on the GPU: linkRetryRenderSmoke.
globalThis.__MANTLE_DEBUG__ = true;
globalThis.__MANTLE_NO_STATIC_CACHE = true;
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
console.error = () => {};
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
const sec = await importSvg(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M10 10 C 60 0 90 40 80 90 L 20 70 Z" fill="#303"/></svg>',
  { preserveViewport: true },
);

/// A stand-in GL whose programs with the AAC kernel fail to link while `down`. `links` counts each such program source's links.
function flakyAac(W) {
  const srcOf = new Map(),
    byProg = new Map(),
    links = new Map();
  const S = {
    down: true,
    links,
    total: () => [...links.values()].reduce((a, c) => a + c, 0),
    worst: () => Math.max(0, ...links.values()),
  };
  const ss = W.gl.shaderSource;
  W.gl.shaderSource = (s, t) => {
    srcOf.set(s, t);
    return ss(s, t);
  };
  const at = W.gl.attachShader;
  W.gl.attachShader = (p, s) => {
    const t = srcOf.get(s) || '';
    if (/#define MANTLE_AAC\b/.test(t)) byProg.set(p, (byProg.get(p) || '') + t);
    return at(p, s);
  };
  const lp = W.gl.linkProgram;
  W.gl.linkProgram = (p) => {
    const t = byProg.get(p);
    if (t != null) {
      links.set(t, (links.get(t) || 0) + 1);
      if (S.down) S.bad.add(p);
    }
    return lp(p);
  };
  S.bad = new Set();
  const gp = W.gl.getProgramParameter;
  W.gl.getProgramParameter = (p, n) => (n === W.gl.LINK_STATUS && S.bad.has(p) ? false : gp(p, n));
  return S;
}
const POLICIES = [
  ['blocking', {}],
  ['non-blocking', { nonBlocking: true }],
  ['strict play', { nonBlocking: true, strictPlay: true }],
  ['stand-in-free', { nonBlocking: true, strictPlay: true, standIns: false }],
];
async function setup(O) {
  const W = createPendingGl({ linkMs: 1, pipelineMs: 1 });
  const F = flakyAac(W);
  const R = createRenderer(W.gl, taggedShaderSources(), {
    asyncShaderCompile: true,
    aacPoints: false,
    ...O,
  });
  R.ready.catch(() => {});
  await R.ready;
  R.setViewport(128, 128);
  const b = createBundle(W.gl, sec);
  R.setFillEngine({ route: 'none', kernel: 'aac' });
  const draw = (bb = b) => {
    try {
      R.beginFrame([1, 1, 1, 1]);
      R.drawBundle(bb);
      R.endFrame();
      return null;
    } catch (e) {
      return e.message;
    }
  };
  let n = 0;
  while (!R.debugStats.linkFailedKeys && n++ < 400) {
    draw();
    await sleep(2);
  }
  return { W, F, R, b, draw };
}
const frames = async (draw, k = 20) => {
  let thrown = null;
  for (let i = 0; i < k; i++) {
    thrown = draw() || thrown;
    await sleep(1);
  }
  return thrown;
};

console.log(
  '(the window) a failed key: not in play, once per loading call, and it works when the link does',
);
for (const [name, O] of POLICIES) {
  const { W, F, R, draw } = await setup(O);
  ok(
    R.debugStats.linkFailedKeys > 0,
    `${name}: the premise: a key failed to link (${R.debugStats.linkFailedKeys})`,
  );
  let l0 = F.total();
  await frames(draw);
  ok(F.total() === l0, `${name}: still failing, 20 frames link nothing (${F.total() - l0})`);

  // the loading call, still failing: each key once, at every size it warms
  F.links.clear();
  await R.precompileFillsAsync({
    viewports: [
      [128, 128],
      [256, 256],
      [1024, 1024],
    ],
  });
  ok(F.total() > 0, `${name}: the loading call tries the key again (${F.total()} links)`);
  ok(
    F.worst() === 1,
    `${name}: each key once in a call that warms three sizes (at most ${F.worst()})`,
  );
  ok(
    !R.debugStats.coopLoad || !R.debugStats.coopLoad.incomplete,
    `${name}: and the call ends by itself, not at its deadline (${R.debugStats.coopLoad ? Math.round(R.debugStats.coopLoad.ms) : '?'} ms)`,
  );
  ok(
    R.debugStats.linkFailedKeys > 0,
    `${name}: still failing, it stays failed (${R.debugStats.linkFailedKeys} keys)`,
  );
  await sleep(4);
  l0 = F.total();
  await frames(draw);
  ok(F.total() === l0, `${name}: after that call, 20 frames link nothing (${F.total() - l0})`);

  // the failure has passed, in play: a draw does not find out
  F.down = false;
  l0 = F.total();
  await frames(draw);
  ok(
    F.total() === l0,
    `${name}: the driver has recovered, and 20 frames still link nothing (${F.total() - l0})`,
  );

  // the next loading call takes it up, and the key draws
  await R.precompileFillsAsync({});
  ok(F.total() > l0, `${name}: the next loading call links it (${F.total() - l0})`);
  ok(
    R.debugStats.linkFailedKeys === 0,
    `${name}: nothing is left failed (${R.debugStats.linkFailedKeys})`,
  );
  const k0 = W.model.links,
    p0 = W.model.pipelines,
    d0 = R.debugStats.deferredFillDraws | 0;
  const thrown = await frames(draw);
  ok(!thrown, `${name}: the frames draw (${thrown || 'nothing thrown'})`);
  ok(
    /MANTLE_AAC/.test(R.debugStats.drawnFillVariantKey || ''),
    `${name}: on the key that failed (${(R.debugStats.drawnFillVariantKey || '').includes('MANTLE_AAC') ? 'MANTLE_AAC' : R.debugStats.drawnFillVariantKey})`,
  );
  ok(
    (R.debugStats.deferredFillDraws | 0) === d0,
    `${name}: no draw deferred (${(R.debugStats.deferredFillDraws | 0) - d0})`,
  );
  ok(
    W.model.links === k0 && W.model.pipelines === p0,
    `${name}: and it built in the window, not in play (${W.model.links - k0} links, ${W.model.pipelines - p0} pipelines)`,
  );
  R.dispose();
}

console.log('(the other windows)');
for (const [name, open] of [
  ['beginWarmWindow', (R) => R.beginWarmWindow({})],
  [
    'the blocking precompileFills',
    async (R) => {
      R.precompileFills({});
    },
  ],
  [
    'warmScene',
    (R, draw) =>
      R.warmScene([
        {
          name: 'play',
          draw: () => {
            draw();
          },
        },
      ]),
  ],
]) {
  const { F, R, draw } = await setup({ nonBlocking: true });
  await R.precompileFillsAsync({});
  await frames(draw, 4);
  F.down = false;
  const l0 = F.total();
  await open(R, draw);
  ok(F.total() > l0, `${name} links it (${F.total() - l0})`);
  await sleep(4);
  const thrown = await frames(draw, 8);
  ok(
    R.debugStats.linkFailedKeys === 0 && !thrown,
    `${name}: nothing is failed and the frames draw (${R.debugStats.linkFailedKeys} keys, ${thrown || 'nothing thrown'})`,
  );
  R.dispose();
}

// A game asks this per trial and per text re-flow, in play. A failed key alone is not a reason to open a window there, or a key the driver keeps refusing would link at each ask.
console.log(
  '(awaitBundleReady) opens no window for a failed key alone; a window it opens for another key takes the failed key up',
);
{
  const { F, R, W, b, draw } = await setup({ nonBlocking: true });
  await R.precompileFillsAsync({});
  await frames(draw, 4);
  F.down = false;
  const l0 = F.total(),
    n0 = R.debugStats.linkFailedKeys;
  ok(
    (await R.awaitBundleReady(b)) === 0 && F.total() === l0,
    `nothing else missing: it resolves at once and links nothing (${F.total() - l0})`,
  );
  ok(
    R.debugStats.linkFailedKeys === n0,
    `the key stays failed for the next window (${R.debugStats.linkFailedKeys})`,
  );
  const other = createBundle(
    W.gl,
    await importSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><radialGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></radialGradient></defs><path d="M10 10 C 60 0 90 40 80 90 L 20 70 Z" fill="url(#g)" stroke="#000"/></svg>',
      { preserveViewport: true },
    ),
  );
  await R.awaitBundleReady(other);
  ok(
    F.total() > l0 && R.debugStats.linkFailedKeys === 0,
    `a new bundle's window takes it up (${F.total() - l0} links, ${R.debugStats.linkFailedKeys} failed)`,
  );
  R.dispose();
}

console.log('(nobody asks) a key whose bundle is gone stays down');
{
  const { F, R, b, draw } = await setup({ nonBlocking: true });
  await frames(draw, 4);
  b.dispose();
  F.links.clear();
  await R.precompileFillsAsync({});
  ok(F.total() === 0, `the loading call links nothing for it (${F.total()})`);
  R.dispose();
}

console.log('(a lost context) nothing is retried on it');
{
  const { W, F, R, draw } = await setup({ nonBlocking: true });
  await frames(draw, 4);
  W.gl.isContextLost = () => true;
  F.links.clear();
  try {
    R.precompileFills({});
  } catch {
    /* a lost context refuses */
  }
  ok(F.total() === 0, `no link on it (${F.total()})`);
  W.gl.isContextLost = () => false;
  R.dispose();
}
if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log('\nall ok');
process.exit(0);
