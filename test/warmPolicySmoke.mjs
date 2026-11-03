// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// warmPolicySmoke -- the warm policy of the background warm queue (renderer.warm), on the driver-model stand-in (test/_pendingGl.mjs).
//
//   order     links run across ALL queued scenes in LIKELIHOOD order: the key most scenes need before a key one scene needs, whatever the insertion order; the census
//             table orders what a single scene holds; a scene's priority still outranks it; the remainder (keys only a runtime API reaches) ranks last
//   start     gameStart(): everything the game needs at the current viewport class keeps linking and builds; the items it does not need are PAUSED (untouched);
//             needed keys added in play keep LINKING with no window (no pipeline is built, no frame is touched)
//   resize    onResize(): the needed set is recomputed for the new class and warmed; the stall (block:true) happens only there
//   end       gameEnd(): the paused remainder resumes and finishes
//   base      no session in this file ever builds the base fill program
//   reach     every row of API_REACH, drawn through the real renderer: its key is warmed, declared, or served through a non-stalling path (a built superset, or a
//             deferred draw that completes once the link does), with no wait on the driver and no blocking link; the override fields cannot add a
//             gradient / pattern / image / mask / clip / filter bit
//   needs     a declared need is warmed and never counted as a miss; an undeclared runtime need is a counted miss and still draws; a recorded manifest turns into
//             a needs manifest and back (round trip); malformed needs never throw
globalThis.__MANTLE_DEBUG__ = true;
globalThis.__MANTLE_NO_STATIC_CACHE = true;
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const warnings = [];
console.warn = (...a) => {
  warnings.push(a.join(' '));
};
const listeners = {};
globalThis.window = {
  addEventListener: (t, f) => {
    (listeners[t] ||= []).push(f);
  },
};
const { taggedShaderSources } = await import('./_fakeGl.mjs');
const { createPendingGl } = await import('./_pendingGl.mjs');
const {
  createRenderer,
  createBundle,
  importSvg,
  createOverrideTable,
  createPalette,
  channelLerpParams,
} = await import('../src/index.js');
const {
  API_REACH,
  REACH_TAGS,
  keyLikelihood,
  censusFraction,
  estimateFraction,
  parseNeeds,
  needsFromWarmManifest,
  NEEDS_FORMAT,
} = await import('../src/renderer/warmPolicy.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 8000) => {
  const t = Date.now();
  while (!f() && Date.now() - t < ms) await sleep(5);
  return f();
};
const doc = (body, defs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${defs ? '<defs>' + defs + '</defs>' : ''}${body}</svg>`;
const SRC = {
  bg: doc('<rect x="0" y="0" width="100" height="100" fill="#234"/>'),
  fill: doc('<path d="M10 10 C 60 0 90 40 80 90 L 20 70 Z" fill="#303"/>'),
  gradient: doc(
    '<path d="M10 10 C 60 0 90 40 80 90 L 20 70 Z" fill="url(#g)"/>',
    '<linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient>',
  ),
  mask: doc(
    '<g mask="url(#m)"><rect x="0" y="0" width="100" height="100" fill="#0a3"/></g>',
    '<mask id="m"><circle cx="40" cy="50" r="25" fill="#fff"/><circle cx="62" cy="50" r="22" fill="#888"/></mask>',
  ),
  stroke: doc(
    '<path d="M10 50 C 30 0 70 100 90 50" fill="none" stroke="#123" stroke-width="6" stroke-linecap="round"/>',
  ),
  quad: doc('<path d="M10 80 Q 50 0 90 80 Z" fill="#a40"/>'),
  pattern: doc(
    '<path d="M10 10 C 60 0 90 40 80 90 L 20 70 Z" fill="url(#p)"/>',
    '<pattern id="p" width="10" height="10" patternUnits="userSpaceOnUse"><rect width="5" height="5" fill="#333"/></pattern>',
  ),
  clip: doc(
    '<path d="M10 10 C 60 0 90 40 80 90 L 20 70 Z" fill="#a48" clip-path="url(#c)"/>',
    '<clipPath id="c"><rect x="20" y="20" width="60" height="60"/></clipPath>',
  ),
};
const sections = {};
for (const [k, s] of Object.entries(SRC))
  sections[k] = await importSvg(s, { preserveViewport: true });
const SET_A = ['bg', 'fill', 'gradient'],
  SET_B = ['mask', 'stroke', 'quad'],
  SET_AB = [...SET_A, ...SET_B];

// (the stand-in policy, which the queue-order, reach and needs sections measure; the reuse and bindset sections pass standIns: false, the default)
const strictOpts = {
  asyncShaderCompile: true,
  nonBlocking: true,
  strictPlay: true,
  aacPoints: false,
  glGuard: true,
  gpuShedMs: 40,
  standIns: true,
  needMissPolicy: 'defer',
};
async function mk(extra = {}, link = 30, pipe = 120) {
  const W = createPendingGl({ linkMs: link, pipelineMs: pipe });
  const R = createRenderer(W.gl, taggedShaderSources(), { ...strictOpts, ...extra });
  R.ready.catch(() => {});
  setTimeout(() => W.release(), 40);
  await R.ready;
  R.setViewport(128, 128);
  return { W, R };
}
const bundlesOf = (W, keys) => keys.map((k) => createBundle(W.gl, sections[k]));
const frame = (R, bs, st) => {
  R.beginFrame([1, 1, 1, 1]);
  for (const b of bs) R.drawBundle(b, st);
  R.endFrame();
};
// What a recording session records is what it bound, whatever its builds cost, so it runs at short model durations.
async function record(keys, size = 128) {
  const { W, R } = await mk({ recordWarmManifest: true }, 2, 2);
  R.setViewport(size, size);
  const bs = bundlesOf(W, keys);
  await R.precompileFillsAsync({});
  for (const st of [{}, { worldMatrix: new Float32Array([0.8, 0.6, 0, -0.6, 0.8, 0, 0, 0, 1]) }]) {
    frame(R, bs, st);
    await sleep(3);
  }
  const m = R.exportWarmManifest();
  R.dispose();
  return m;
}
const clsOf = (w, h) => Math.round(4 * Math.log2(Math.max(1, Math.sqrt(w * h))));

console.log(
  '(record) manifests: A, B, and A+B (shared keys); the manifest carries the viewport classes of each variant (minor 2)',
);
const mA = await record(SET_A),
  mB = await record(SET_B),
  mAB = await record(SET_AB),
  mC = await record(['pattern', 'clip']);
{
  ok(
    mA.minor === 2 &&
      mA.variants.length > 0 &&
      mA.variants.every((v) => v.vcs.length === 1 && v.vcs[0] === clsOf(128, 128)),
    `variants carry vcs [${clsOf(128, 128)}] (${mA.variants.length} variants)`,
  );
  ok(
    mA.pipelines.some((p) => p.vcs && p.vcs[0] === clsOf(128, 128)) &&
      mA.pipelines.every(
        (p) => p.vcs == null || (p.vcs.length === 1 && p.vcs[0] === clsOf(128, 128)),
      ),
    'pipelines bound in play carry vcs (warm-only pipelines have none: needed at any size)',
  );
}

console.log('(order) likelihood across scenes; the census table; priority; the remainder last');
{
  // the census table
  const common =
    'MANTLE_AAC|MANTLE_NO_ARC|MANTLE_NO_CLIP|MANTLE_NO_CUBIC|MANTLE_NO_FILTER|MANTLE_NO_GRADIENT|MANTLE_NO_IMAGE|MANTLE_NO_MASK|MANTLE_NO_PATTERN|MANTLE_NO_RECOLOR|MANTLE_NO_STROKE';
  ok(
    censusFraction(common) === 1,
    `a key every census entry draws scores 1 (${censusFraction(common)})`,
  );
  const unseen = 'MANTLE_NO_GRADIENT|MANTLE_GWN|MANTLE_LB_MORPH|MANTLE_NO_STROKE';
  ok(
    censusFraction(unseen) === 0 && estimateFraction(unseen) > 0 && estimateFraction(unseen) < 1,
    `an unseen key is estimated from its parts (${estimateFraction(unseen).toFixed(3)}), below any exact common key`,
  );
  ok(keyLikelihood(common) > keyLikelihood(unseen), 'common > unseen');
  ok(
    keyLikelihood('k1', { scenes: 4, sceneCount: 4 }) >
      keyLikelihood('k2', { scenes: 4, sceneCount: 1 }),
    'with 2+ queued scenes the share of scenes needing a key decides',
  );

  const { W, R } = await mk();
  // insertion order B first: the keys shared with A and AB must still link before B's own
  R.warm.add('B', { manifest: mB });
  R.warm.add('A', { manifest: mA });
  R.warm.add('AB', { manifest: mAB });
  const ord = R.warm._order();
  const sc = ord.map((o) => o.s);
  ok(
    ord.length > 0 && sc.every((v, i) => i === 0 || v <= sc[i - 1] + 1e-12),
    `the order is non-increasing in likelihood (${ord.length} items, first ${sc[0].toFixed(3)}, last ${sc[sc.length - 1].toFixed(3)})`,
  );
  const inScenes = (k) =>
    [mA, mB, mAB].filter(
      (m) => m.pipelines.some((p) => p.k === k) || m.variants.some((v) => v.k === k),
    ).length;
  const links = ord.filter((o) => o.kind === 'link' && o.s > 0.05).map((o) => inScenes(o.k));
  ok(
    links.length > 4 &&
      links.every((n, i) => i === 0 || n <= links[i - 1]) &&
      links[0] > links[links.length - 1],
    `keys needed by more scenes link first, whatever the insertion order (scene counts ${links.join('')})`,
  );
  // priority outranks likelihood
  R.warm.add('P', { manifest: mB, priority: 9 });
  const ord2 = R.warm._order();
  ok(ord2[0].sc === 'P', `a scene with priority 9 leads the order (${ord2[0].sc})`);
  R.dispose();

  // the remainder: a bundles-scene queues the keys a runtime API reaches, below its asset-derived keys
  const w2 = await mk();
  const bs = bundlesOf(w2.W, ['fill']);
  w2.R.warm.add('bundles', { bundles: bs });
  const o2 = w2.R.warm._order();
  const reach = o2.filter((o) => o.reach);
  const nonReach = o2.filter((o) => !o.reach);
  ok(
    reach.length > 0 &&
      nonReach.length > 0 &&
      o2.indexOf(reach[0]) > o2.indexOf(nonReach[nonReach.length - 1]),
    `the remainder (${reach.length} reach links) ranks after the asset-derived items (${nonReach.length})`,
  );
  w2.R.dispose();
}

console.log(
  '(start) gameStart: needed items keep linking and build, the rest is paused; needed keys added in play link with no window',
);
let startFinished = null;
{
  const { W, R } = await mk();
  // a manifest with two viewport classes: half the items recorded at 128 (class c128), half at 512 (class c512)
  const c128 = clsOf(128, 128),
    c512 = clsOf(512, 512);
  const split = JSON.parse(JSON.stringify(mAB));
  split.variants.forEach((v, i) => {
    v.vcs = [i % 2 ? c512 : c128];
  });
  split.pipelines.forEach((p) => {
    const v = split.variants.find((x) => x.k === p.k);
    p.vcs = v ? v.vcs : [c128];
  });
  R.warm.setInference(false);
  R.warm.add('other', { manifest: mC });
  R.warm.add('game', { manifest: split });
  const items0 = R.warm
    ._items('other')
    .map((i) => i.st)
    .join();
  const at128 = new Set(split.pipelines.filter((p) => p.vcs[0] === c128).map((p) => p.k)),
    at512 = split.pipelines
      .filter((p) => p.vcs[0] === c512)
      .map((p) => p.k)
      .filter((k) => !at128.has(k));
  ok(
    at512.length > 0 && at128.size > 0,
    `the game manifest has items at two classes (${at128.size} at ${c128}, ${at512.length} only at ${c512})`,
  );
  const p0 = W.model.pipelines;
  const r = await R.warm.gameStart('game', { viewport: [128, 128] });
  ok(!r.timeout && R.warm._ctx().active, `gameStart resolved (needed ${r.needed}, ${r.ms} ms)`);
  const gi = R.warm._items('game');
  const doneKeys = (kind) => gi.filter((i) => i.kind === kind && i.st === 'done').length;
  ok(W.model.pipelines > p0, `the game's pipelines were built (${W.model.pipelines - p0})`);
  const oi = R.warm._items('other');
  const sharedWithGame = (k) =>
    mAB.variants.some((v) => v.k === k) || mAB.pipelines.some((v) => v.k === k);
  const otherOnly = oi.filter((i) => i.kind === 'link' && !sharedWithGame(i.kfull));
  ok(
    otherOnly.length > 0 && otherOnly.every((i) => i.st === 'new'),
    `the other scene's own items were not started (${otherOnly.length} items, all 'new')`,
  );
  const idle512 = gi.filter((i) => i.kind === 'link' && at512.includes(i.kfull));
  ok(
    idle512.length > 0 && idle512.every((i) => i.st === 'new'),
    `the game's items recorded at another class are paused (${idle512.length} untouched)`,
  );
  const wp = R.debugStats.warmPolicy;
  ok(
    wp && wp.game === 'game' && wp.cls === c128 && wp.neededPending === 0,
    `debugStats.warmPolicy: game ${wp && wp.game}, class ${wp && wp.cls}, needed ${wp && wp.needed}, pending ${wp && wp.neededPending}`,
  );
  ok(
    W.model.waits.length === 0 && (R.debugStats.blockingLinkWaits | 0) === 0,
    'no wait on the driver during the start',
  );

  // IN PLAY: a needed key added now keeps linking without a window (no pipeline), frames stay complete
  var oneKey = mC.variants.find((v) => !mAB.variants.some((x) => x.k === v.k));
  if (oneKey) {
    const bs = bundlesOf(W, SET_A);
    W.setTiming({ linkMs: 2, pipelineMs: 2 }); // (the scene's loading call, before the play window below)
    await R.precompileFillsAsync({});
    W.setTiming({ linkMs: 30, pipelineMs: 120 }); // (play at the durations a stray link or build shows against)
    for (let i = 0; i < 6; i++) {
      frame(R, bs, {});
      await sleep(5);
    }
    W.resetWaits();
    const pl0 = R.warm._ctx().needed.size,
      links0 = R.debugStats.warmPolicy.totals.playLinks,
      pipes0 = W.model.pipelines;
    R.setWarmContext({ needed: [oneKey.k] });
    ok(
      R.warm._ctx().needed.has(oneKey.k) && R.warm._ctx().needed.size > pl0 - 1,
      'the host-listed needed key joins the needed set',
    );
    let empty = 0;
    for (let i = 0; i < 40; i++) {
      const d0 = W.model.draws;
      frame(R, bs, {});
      if (W.model.draws - d0 < bs.length) empty++;
      await sleep(8);
    }
    ok(empty === 0, 'every gameplay frame drew its bundles while the queue ran');
    // only the key the scene 'other' also holds can start: the item belongs to scene 'other', which is not the game, but the KEY is needed
    const started = R.warm
      ._items('other')
      .filter((i) => i.kind === 'link' && oneKey.k === i.kfull)
      .some((i) => i.st !== 'new');
    ok(
      started || R.debugStats.warmPolicy.totals.playLinks > links0,
      `a needed key added in play linked with no window (play links ${R.debugStats.warmPolicy.totals.playLinks - links0})`,
    );
    ok(
      W.model.pipelines === pipes0,
      `no pipeline was built in play by the queue (${W.model.pipelines - pipes0})`,
    );
  }
  ok(
    W.model.waits.length === 0,
    `play did not wait on the driver ${JSON.stringify(W.model.waits.map((w) => [w.kind, w.name, Math.round(w.ms), w.stack.slice(0, 260)]))}`,
  );

  console.log(
    '(resize) onResize recomputes the needed set for the new class and warms it; block:true is the only stall',
  );
  const waitsBefore = W.model.waits.length;
  const pw = W.model.pipelines;
  const rr = await R.warm.onResize(512, 512);
  const gi2 = R.warm._items('game');
  ok(
    gi2.filter((i) => i.kind === 'link' && at512.includes(i.kfull)).every((i) => i.st === 'done'),
    'the items of the new class are warm after the resize',
  );
  ok(
    W.model.pipelines > pw,
    `the resize built the new class's pipelines (${W.model.pipelines - pw})`,
  );
  ok(
    W.model.waits.length === waitsBefore,
    `a non-blocking resize waited on nothing (${W.model.waits.length - waitsBefore} waits)`,
  );
  const c = R.warm._ctx();
  ok(
    c.cls === c512 && R.debugStats.warmPolicy.totals.resizes >= 1,
    `the context moved to class ${c512}`,
  );
  // a second resize back and a blocking one: allowed to stall, bounded, and the other scene is still paused
  const waitsPreBlock = W.model.waits.length;
  const rb = await R.warm.onResize(128, 128, { block: true });
  const waitsInBlock = W.model.waits.length - waitsPreBlock;
  ok(
    typeof rb.blockMs === 'number' && rb.blockMs < 3500,
    `a blocking resize returned in ${rb.blockMs} ms (the allowed stall)`,
  );
  const oi2 = R.warm
    ._items('other')
    .filter(
      (i) => i.kind === 'link' && !sharedWithGame(i.kfull) && !(oneKey && oneKey.k === i.kfull),
    );
  ok(
    oi2.every((i) => i.st === 'new'),
    `the other scene stayed paused through the resizes ${JSON.stringify(oi2.map((i) => [i.k, i.st]))}`,
  );

  console.log('(end) gameEnd resumes the remainder in order and finishes it');
  R.warm.gameEnd();
  R.warm.window(true);
  const done = await R.warm.idle();
  ok(!R.warm._ctx().active, 'the game context ended');
  await until(
    () => R.warm.status().scenes.other.pending === 0 && R.warm.status().scenes.game.pending === 0,
  );
  const st = R.warm.status();
  ok(
    st.scenes.other.pending === 0 && st.scenes.game.pending === 0,
    `both scenes finished after the game ended (other ${st.scenes.other.state}, game ${st.scenes.game.state})`,
  );
  ok(
    R.debugStats.baseFillBuilt === false,
    'the base fill program was never built in the whole session',
  );
  ok(
    W.model.waits.length - waitsInBlock === 0 && (R.debugStats.blockingLinkWaits | 0) === 0,
    `and the whole run waited on nothing outside the blocking resize (${waitsInBlock} waits inside it)`,
  );
  startFinished = R.debugStats.warmPolicy;
  R.dispose();
}

console.log('(reach) every API_REACH row, drawn through the real renderer');
{
  const { W, R } = await mk({}, 2, 2);
  const names = ['fill', 'stroke', 'gradient', 'pattern', 'clip', 'mask', 'quad'];
  const bs = Object.fromEntries(names.map((n) => [n, createBundle(W.gl, sections[n])]));
  await R.precompileFillsAsync({});
  const all = Object.values(bs);
  for (const b of all) R.prewarmBundle(b);
  await R.precompileFillsAsync({});
  W.setTiming({ linkMs: 30, pipelineMs: 120 }); // (play at the durations a stray link or build shows against)
  for (let i = 0; i < 4; i++) {
    frame(R, all, {});
    await sleep(5);
  }
  const tagsInTable = new Set(API_REACH.flatMap((r) => r.tags));
  ok(
    [...tagsInTable].every((t) => REACH_TAGS[t]) &&
      Object.keys(REACH_TAGS).every((t) => tagsInTable.has(t)),
    `every REACH tag is used by a row and every row tag is defined (${Object.keys(REACH_TAGS).join(', ')})`,
  );
  ok(
    API_REACH.every((r) => typeof r.api === 'string' && /\.js:\d+/.test(r.at)),
    `all ${API_REACH.length} rows cite file:line`,
  );

  const draw = {
    // the real API call each tag corresponds to
    rotate: (b) => ({ worldMatrix: new Float32Array([0.8, 0.6, 0, -0.6, 0.8, 0, 0, 0, 1]) }),
    recolor: () => ({
      colorMatrix: new Float32Array([
        0.9, 0.1, 0, 0, 0.05, 0.9, 0.05, 0, 0, 0.1, 0.9, 0, 0, 0, 0, 1,
      ]),
    }),
    palette: () => ({
      palette: createPalette(W.gl, [
        [1, 0, 0, 1],
        [0, 1, 0, 1],
      ]),
      paletteChannel: 'r',
    }),
    channelLerp: () => ({
      channelLerp: channelLerpParams([0.2, 0.2, 0.2, 1], [0, 0, 0, 1], [1, 1, 1, 1]),
    }),
    strokeWidth: (b) => {
      const t = createOverrideTable(W.gl, b);
      t.set(0, { strokeWidth: 4 });
      return { overrides: t };
    },
    overrides: (b) => {
      const t = createOverrideTable(W.gl, b);
      t.set(0, {
        localPosition: [2, 2],
        fill: [1, 0, 0, 1],
        tint: [1, 0.5, 1, 1],
        visibility: 0.9,
      });
      return { overrides: t };
    },
    alpha: () => ({ alpha: 0.5 }),
  };
  let checked = 0,
    byKind = { warmed: 0, superset: 0, deferred: 0 };
  for (const [tag, make] of Object.entries(draw)) {
    for (const name of names) {
      const b = bs[name];
      let st;
      try {
        st = make(b);
      } catch (e) {
        ok(false, `${tag}/${name}: cannot build the draw state (${e.message})`);
        continue;
      }
      const keys = R._policy.reachKeys(b, [tag]);
      const cover = keys.map((k) => R._policy.coverage(k));
      const defer0 = R.debugStats.deferredFillDraws | 0,
        d0 = W.model.draws;
      frame(R, [b], st);
      const cov = cover.every((c) => c === 'warmed')
        ? 'warmed'
        : cover.some((c) => c === 'superset' || c === 'warmed')
          ? 'superset'
          : 'deferred';
      byKind[cov] = (byKind[cov] || 0) + 1;
      // a deferred first frame completes once the link does: a few frames later the draw lands
      let drew = W.model.draws > d0;
      for (let i = 0; i < 80 && !drew; i++) {
        await sleep(6);
        const d1 = W.model.draws;
        frame(R, [b], st);
        drew = W.model.draws > d1;
      }
      checked++;
      if (!drew) ok(false, `${tag}/${name}: the draw never landed (${cover.join(',')})`);
    }
  }
  ok(
    checked >= 40,
    `${checked} (tag x bundle) draws checked: ${byKind.warmed} warmed, ${byKind.superset} on a built superset, ${byKind.deferred} deferred until their link`,
  );
  ok(
    W.model.waits.length === 0 && (R.debugStats.blockingLinkWaits | 0) === 0,
    `none of them waited on the driver (waits ${W.model.waits.length}, blockingLinkWaits ${R.debugStats.blockingLinkWaits | 0})`,
  );

  // the override fields cannot add a bit the bundle lacks
  const solid = bs.fill;
  const keysOf = (ov) => R._policy.keyWith(solid, { overrides: ov });
  const t1 = createOverrideTable(W.gl, solid);
  t1.set(0, { fill: [1, 0, 0, 1] });
  const t2 = createOverrideTable(W.gl, solid);
  t2.set(0, { stroke: [0, 0, 1, 1], tint: [1, 1, 1, 0.5], visibility: 0.3, reveal: true });
  const k1 = keysOf(t1),
    k2 = keysOf(t2);
  ok(
    k1 === k2,
    "fill / stroke / tint / visibility / reveal overrides produce the same key (the table's presence is the only bit)",
  );
  ok(
    ['GRADIENT', 'PATTERN', 'IMAGE', 'MASK', 'CLIP', 'FILTER'].every((f) =>
      k1.includes('MANTLE_NO_' + f),
    ),
    'no override field adds a gradient / pattern / image / mask / clip / filter back to a solid bundle',
  );
  const t3 = createOverrideTable(W.gl, solid);
  t3.set(0, { strokeWidth: 3 });
  ok(
    keysOf(t3) !== k1 ||
      !keysOf(null).includes('MANTLE_NO_STROKE') ||
      !keysOf(t3).includes('MANTLE_NO_STROKE'),
    'an absolute stroke width removes MANTLE_NO_STROKE (the one override field that reaches a baked omission)',
  );
  // setNodeClip / hit tests: no key change
  const kBefore = R._policy.keyOfBundle(solid);
  try {
    R.setNodeClip(solid, {});
  } catch {
    /* needs a clip texture in this stand-in */
  }
  ok(R._policy.keyOfBundle(solid) === kBefore, 'setNodeClip does not move the key');
  R.dispose();
}

console.log(
  '(needs) declared needs are warmed and never missed; undeclared runtime needs are counted misses and still draw; recorded manifests round-trip',
);
{
  // control: no declaration, a recolor draw meets a variant nobody warmed: a counted miss
  const c = await mk();
  const cb = bundlesOf(c.W, ['fill']);
  await c.R.precompileFillsAsync({});
  frame(c.R, cb, {});
  const m0 = c.R.debugStats.needMiss;
  ok(m0 && m0.fillMisses === 0, `control: warmed draws are not misses (${m0 && m0.fillMisses})`);
  const pal = {
    palette: createPalette(c.W.gl, [
      [1, 0, 0, 1],
      [0, 1, 0, 1],
    ]),
    paletteChannel: 'r',
  };
  const d0 = c.W.model.draws;
  for (let i = 0; i < 80 && c.W.model.draws === d0; i++) {
    frame(c.R, cb, pal);
    await sleep(6);
  }
  const m1 = c.R.debugStats.needMiss;
  ok(
    m1.fillMisses >= 1 && m1.keys.some((k) => k.startsWith('fill:')),
    `an undeclared palette draw is a counted miss (${m1.fillMisses}: ${m1.keys[0] && m1.keys[0].slice(0, 70)})`,
  );
  ok(
    warnings.some((w) => /need miss/.test(w)),
    'the dev build warned once with the key',
  );
  ok(
    c.W.model.draws > d0 &&
      (c.R.debugStats.blockingLinkWaits | 0) === 0 &&
      c.W.model.waits.length === 0,
    'and the miss drew through the non-blocking path (no wait, no blocking link)',
  );
  c.R.dispose();

  // declared: the same palette reach, declared for the bundle: warmed with it, drawn without a miss
  const rec = await record(['fill']);
  const needs = needsFromWarmManifest(rec, { game: 'unit' });
  const key = await (async () => {
    const t = await mk();
    const b = bundlesOf(t.W, ['fill'])[0];
    const k = t.R._policy.wmKeyOf(b);
    t.R.dispose();
    return k;
  })();
  needs.reach.push({ bundle: key, tags: ['palette'] });
  needs.future = { ignored: true };
  const wasWarnings = warnings.length;
  const d = await mk({ declaredNeeds: needs }, 2, 2);
  const db = bundlesOf(d.W, ['fill']);
  d.R.prewarmBundle(db[0]);
  await d.R.precompileFillsAsync({});
  d.W.setTiming({ linkMs: 30, pipelineMs: 120 });
  const reachKeys = d.R._policy.reachKeys(db[0], ['palette']);
  ok(
    reachKeys.length > 0 && reachKeys.every((k) => d.R._policy.has(k)),
    `the declared palette reach was linked with its bundle (${reachKeys.length} key)`,
  );
  await sleep(120);
  const pal2 = {
    palette: createPalette(d.W.gl, [
      [1, 0, 0, 1],
      [0, 1, 0, 1],
    ]),
    paletteChannel: 'r',
  };
  const dd0 = d.W.model.draws;
  for (let i = 0; i < 60 && d.W.model.draws === dd0; i++) {
    frame(d.R, db, pal2);
    await sleep(6);
  }
  const dm = d.R.debugStats.needMiss;
  ok(
    d.W.model.draws > dd0 && dm.fillMisses === 0,
    `the declared palette draw is not a miss and drew (misses ${dm.fillMisses}, declared ${JSON.stringify(dm.declared)})`,
  );
  ok(
    warnings.slice(wasWarnings).every((w) => !/need miss/.test(w)),
    'no need-miss warning for a declared need',
  );
  d.R.dispose();

  // formats
  const p = parseNeeds(JSON.stringify({ ...needs, version: 7, extra: { a: 1 } }));
  ok(
    p &&
      p.version === 7 &&
      p.variants.size === needs.variants.length &&
      p.reach.length === needs.reach.length,
    'a higher version and unknown fields parse (forward compatible)',
  );
  ok(
    parseNeeds(null) === null &&
      parseNeeds('{bad') === null &&
      parseNeeds({ format: 'other', version: 1 }) === null &&
      parseNeeds({ format: NEEDS_FORMAT, version: 0 }) === null,
    'a missing, garbled or foreign manifest is null (asset-derived needs only)',
  );
  const q = parseNeeds({
    format: NEEDS_FORMAT,
    version: 1,
    variants: [1, null, 'A|B'],
    programs: [{ t: 'inst', a: [] }, 5],
    reach: [
      { bundle: '*', tags: ['palette', 'bogus'] },
      { bundle: 3, tags: ['rotate'] },
      { bundle: 'x', tags: ['bogus'] },
    ],
    scales: [{ c: 'x' }, { c: 3, w: 1, h: 2 }],
  });
  ok(
    q.variants.size === 1 &&
      q.programs.length === 1 &&
      q.reach.length === 1 &&
      q.reach[0].tags.length === 1 &&
      q.scales.length === 1,
    'wrong-typed entries and unknown tags are skipped',
  );
  const back = needsFromWarmManifest(rec, { game: 'unit' });
  ok(
    JSON.stringify(parseNeeds(JSON.stringify(back)).variants.size) ===
      String(new Set(back.variants).size) && back.format === NEEDS_FORMAT,
    `a recorded manifest round-trips through JSON (${back.variants.length} variants)`,
  );
  // the queue accepts it as a scene's needs and never throws on garbage
  const e = await mk();
  let threw = false;
  try {
    for (const bad of [
      undefined,
      null,
      5,
      '{x',
      [],
      { format: 'x' },
      { format: NEEDS_FORMAT, version: 1, variants: 'no' },
    ]) {
      e.R.setWarmContext({ declaredNeeds: bad });
      e.R.warm.add('g' + String(bad).length, { manifest: rec, declaredNeeds: bad });
    }
    e.R.setWarmContext({ declaredNeeds: needs, game: 'unit', active: true, viewport: [128, 128] });
  } catch (err) {
    threw = true;
    console.log(err);
  }
  ok(!threw, 'malformed needs never throw');
  e.R.dispose();
}

console.log(
  '(reuse) standIns:false: a bundle keeps its own previous variant while the needed program links; with nothing available the draw blocks on the exact variant',
);
{
  const { W, R } = await mk({ standIns: false, strictPlay: false });
  const b = bundlesOf(W, ['gradient'])[0];
  await R.precompileFillsAsync({});
  for (let i = 0; i < 6; i++) {
    frame(R, [b], {});
    await sleep(5);
  }
  const st0 = R.debugStats;
  ok(st0.needMiss.standIns === 'off', 'the policy reports standIns off');
  const ds = () => ({
    def: R.debugStats.deferredFillDraws | 0,
    st: R.debugStats.needMiss.standInDraws | 0,
    blk: R.debugStats.needMiss.blocked,
    reuse: R.debugStats.needMiss.reuseDraws,
    bl: R.debugStats.blockingLinkWaits | 0,
  });
  const a0 = ds();
  // an engine flip (a pin): the same feature key, another kernel -> the previous variant keeps drawing while the needed one links
  R.setFillEngine({ kernel: 'aac' });
  W.resetWaits();
  const d0 = W.model.draws;
  frame(R, [b], {});
  const a1 = ds();
  ok(W.model.draws > d0, 'the engine-flip frame drew (no hole)');
  ok(
    a1.reuse > a0.reuse && a1.blk === a0.blk && a1.def === a0.def && a1.st === a0.st,
    `previous-variant reuse: ${a1.reuse - a0.reuse} draws, nothing blocked, deferred or stood in for`,
  );
  ok(W.model.waits.length === 0, 'and no wait on the driver');
  // the needed program links, then its pipeline is built by the renderer's own warm (the demand deadline: a second of frames); the switch happens then
  let last = -1,
    stable = 0,
    frames = 0;
  for (; frames < 500 && stable < 12; frames++) {
    frame(R, [b], {});
    await sleep(8);
    const r = ds().reuse;
    if (r === last) stable++;
    else {
      stable = 0;
      last = r;
    }
  }
  const a2 = ds();
  ok(
    stable >= 12,
    `the switch happened: reuse draws stopped after ${a2.reuse - a0.reuse} (${frames} frames)`,
  );
  ok(
    a2.reuse - a0.reuse >= 1 && a2.reuse - a0.reuse < 200,
    'and the reused frames are bounded by the link plus the pipeline warm',
  );
  ok(
    a2.def === a0.def && a2.st === a0.st && a2.bl === a0.bl,
    'zero deferred fill draws, zero stand-in draws, zero blocking link waits through the flip',
  );
  R.dispose();
  // nothing available: a bundle with no previous variant of its own whose needed program is still linking has nothing to reuse -> block on the exact variant, in the
  // frame it is drawn (a fresh renderer: nothing warmed, so the outcome does not depend on how far the background warm got)
  const f = await mk({ standIns: false, strictPlay: false });
  await f.R.precompileFillsAsync({}); // play starts when the loading call has finished
  const nb2 = bundlesOf(f.W, ['gradient'])[0];
  f.W.resetWaits();
  const fd0 = f.W.model.draws;
  frame(f.R, [nb2], {});
  const fm = f.R.debugStats.needMiss;
  ok(
    f.W.model.draws > fd0 &&
      fm.blocked >= 1 &&
      (f.R.debugStats.deferredFillDraws | 0) === 0 &&
      fm.standInDraws === 0 &&
      fm.reuseDraws === 0,
    `with nothing available the draw blocked on the exact variant (blocked ${fm.blocked}, deferred ${f.R.debugStats.deferredFillDraws | 0}, stand-ins ${fm.standInDraws}) and landed in the same frame`,
  );
  ok(
    f.W.model.waits.length >= 1,
    `the block is a visible wait (${f.W.model.waits.length}), counted`,
  );
  f.R.dispose();
}

console.log(
  '(bindset) standIns:false warms the program every draw state will BIND (selectFillVariant itself, on the final route) in the loading window: no reuse, no block, no build in play',
);
{
  const states = [
    {},
    { worldMatrix: new Float32Array([0.8, 0.6, 0, -0.6, 0.8, 0, 0, 0, 1]) },
    {
      colorMatrix: new Float32Array([
        0.9, 0.1, 0, 0, 0.05, 0.9, 0.05, 0, 0, 0.1, 0.9, 0, 0, 0, 0, 1,
      ]),
    },
  ];
  const run = async (extra) => {
    const { W, R } = await mk(
      {
        standIns: false,
        strictPlay: false,
        aacFill: 'auto',
        warmFutureStates: false,
        ...extra,
      },
      2,
      2,
    ); // (the ordinary warm skips the rotated/recolor states: only the bind-set pass can cover them)
    const bs = bundlesOf(W, ['gradient', 'fill', 'stroke']);
    await R.precompileFillsAsync({});
    W.setTiming({ linkMs: 30, pipelineMs: 120 }); // (play at the durations a stray link or build shows against)
    const nm0 = R.debugStats.needMiss,
      load = { builds: nm0.bindSetBuilds, unbuilt: nm0.bindSetUnbuilt, ms: nm0.bindSetMs };
    const base = { reuse: nm0.reuseDraws, blocked: nm0.blocked };
    W.resetWaits();
    let drew = 0;
    for (const st of states)
      for (let i = 0; i < 3; i++) {
        const d0 = W.model.draws;
        frame(R, bs, st);
        if (W.model.draws - d0 >= bs.length) drew++;
        await sleep(5);
      }
    const nm = R.debugStats.needMiss;
    const out = {
      drew,
      frames: states.length * 3,
      reuse: nm.reuseDraws - base.reuse,
      blocked: nm.blocked - base.blocked,
      waits: W.model.waits.length,
      ...load,
    };
    R.dispose();
    return out;
  };
  const on = await run({}),
    off = await run({ warmBindSet: false });
  ok(
    off.reuse + off.blocked >= 1,
    `without the pass the states the ordinary warm skipped reuse or block (reuse ${off.reuse}, blocked ${off.blocked})`,
  );
  ok(
    on.unbuilt === 0 && on.builds >= 1,
    `the bind-set pass built ${on.builds} programs in the loading window and left none unbuilt (${on.ms} ms)`,
  );
  ok(
    on.drew === on.frames && on.reuse === 0 && on.blocked === 0 && on.waits === 0,
    `every draw state then drew complete frames on a built program: reuse ${on.reuse}, blocked ${on.blocked}, waits ${on.waits} over ${on.frames} frames`,
  );
}

console.log(fail ? `\n${fail} FAILED` : '\nPASS');
process.exit(fail ? 1 : 0);
