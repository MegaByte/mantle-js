// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strictDerivedRegionsSmoke -- strict play warms the programs of every DECISION REGION of the display's reachable size range, derived from the production
// decision functions (fillPass.js _deriveSizeRegions: candidateDefinesFor / _instWantDefsFor / _pointsWantArgs under each warm state), not sampled sizes.
// Decisions follow each bundle's FIT SCALE (min(w / vw, h / vh) of its own box), so each bundle is derived in its own scale domain.
//   1. EXHAUSTIVE: after the loading call a sweep of every 0.5% of linear viewport size over the whole reachable rectangle at aspects 1:10 .. 10:1, plus each
//      bundle at exactly, just below and just above every breakpoint of its own scale domain, draws every bundle under every warm state -- fills, strokes
//      with strips on, filters, a mask, group opacity, a morph -- with ZERO pipeline builds, no new pipeline combination (program x format x layout), no
//      deferral, no shed frame, no mask bake deferral and no wait; and no key is WANTED at any scale that is not wanted at a derived representative.
//   2. ASPECT: the production answer for a bundle at (w, h) equals its answer at the same fit scale in the bundle's own aspect, for random (w, h) at
//      aspects 1:10 .. 10:1 (so the window's aspect is irrelevant beyond the fit scale).
//   3. DRIFT GUARD: the production derivation is SYMBOLIC (lbShapePolicy.js rows of bars; no sampling). Here, and only here, the production decision answer is swept
//      at 0.05% of fit scale across each bundle's range: every flip it finds must sit within 0.01% of an analytic breakpoint (so a gate edited without its bars, or
//      a gate with no bars, fails), and every analytic breakpoint must be a real flip of the answer or be listed as neutral.
//   4. INVENTORY (data): per draw-state category, how many distinct programs the sweep drew and how many of them were drawn at only some scales.
// Two arms: the renderer's defaults (no bundle here has a bar: each warms at the current size only), and aacFill 'auto' on the Loop-Blinn route, where the
// classic AAC gate and the Loop-Blinn pick put bars inside the range, so the loading call derives and warms their regions and the drift guard has real
// breakpoints to hold the production answer to. (A loading call that derives no region is no control here: the warm image asks every gate that moves a key
// over every scale, so it warms the same programs.)
// Runs the real renderer on the driver-model stand-in (test/_pendingGl.mjs).
globalThis.__MANTLE_DEBUG__ = true;
globalThis.__MANTLE_NO_STATIC_CACHE = true;
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
const { taggedShaderSources } = await import('./_fakeGl.mjs');
const { createPendingGl } = await import('./_pendingGl.mjs');
const { createRenderer, createBundle, importSvg, createShapeMorph } =
  await import('../src/index.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const doc = (body, defs = '', vb = '0 0 100 100') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}">${defs ? '<defs>' + defs + '</defs>' : ''}${body}</svg>`;
const CAT = {
  fill: {
    bg: doc('<rect x="0" y="0" width="100" height="100" fill="#234"/>'),
    fill: doc('<path d="M10 10 C 60 0 90 40 80 90 L 20 70 Z" fill="#303"/>'),
    gradient: doc(
      '<path d="M10 10 C 60 0 90 40 80 90 L 20 70 Z" fill="url(#g)"/>',
      '<linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient>',
    ),
    tiny: doc('<path d="M45 45 C 50 40 55 48 52 55 L 46 53 Z" fill="#c60"/>'),
    wide: doc('<path d="M10 10 C 100 0 160 50 190 50 L 20 40 Z" fill="#363"/>', '', '0 0 200 60'),
  },
  stroke: {
    stroke: doc(
      '<path d="M10 50 C 30 0 70 100 90 50" fill="none" stroke="#123" stroke-width="6" stroke-linecap="round"/>',
    ),
    hair: doc(
      '<path d="M10 20 L 90 80 M10 80 L90 20" fill="none" stroke="#123" stroke-width="0.4"/>',
    ),
    dashed: doc(
      '<path d="M10 50 C 30 0 70 100 90 50" fill="none" stroke="#a00" stroke-width="3" stroke-dasharray="6 4"/>',
    ),
  },
  filter: {
    blur: doc(
      '<g filter="url(#f)"><circle cx="50" cy="50" r="25" fill="#06c"/></g>',
      '<filter id="f"><feGaussianBlur stdDeviation="3"/></filter>',
    ),
    shadow: doc(
      '<g filter="url(#f)"><rect x="25" y="25" width="40" height="40" fill="#c60"/></g>',
      '<filter id="f"><feDropShadow dx="4" dy="4" stdDeviation="2"/></filter>',
    ),
  },
  mask: {
    mask: doc(
      '<g mask="url(#m)"><rect x="0" y="0" width="100" height="100" fill="#0a3"/></g>',
      '<mask id="m"><circle cx="40" cy="50" r="25" fill="#fff"/><circle cx="62" cy="50" r="22" fill="#888"/></mask>',
    ),
  },
  group: {
    group: doc(
      '<g opacity="0.5"><rect x="10" y="10" width="50" height="50" fill="#c00"/><rect x="40" y="40" width="50" height="50" fill="#00c"/></g>',
    ),
  },
};
const sections = {};
for (const [c, set] of Object.entries(CAT))
  for (const [k, s] of Object.entries(set))
    sections[c + '.' + k] = await importSvg(s, { preserveViewport: true });
const shape = (id, k, dx) =>
  `<path id="${id}" d="M${10 + dx} ${10 + (k % 5)} ` +
  Array.from({ length: 40 }, (_, i) => `L${10 + dx + i * 1.5} ${20 + ((i * 7 + k) % 13)}`).join(
    ' ',
  ) +
  ' Z" fill="#a00"/>';
const big = (dx) => doc(Array.from({ length: 30 }, (_, k) => shape('s' + k, k, dx)).join(''));
const mA = await importSvg(big(0), { preserveViewport: true }),
  mB = await importSvg(big(3), { preserveViewport: true });
const ROT = new Float32Array([0.8, 0.6, 0, -0.6, 0.8, 0, 0, 0, 1]);
const TINT = {
  colorMatrix: new Float32Array([0.9, 0.1, 0, 0, 0, 0.9, 0.1, 0, 0.1, 0, 0.9, 0, 0, 0, 0, 1]),
  colorMatrixOffset: new Float32Array([0.05, 0, 0, 0]),
};
const STATES = [{}, { worldMatrix: ROT }, TINT, { worldMatrix: ROT, ...TINT }];

async function arm(loadOpts, rOpts = {}, engine = null) {
  const W = createPendingGl({ linkMs: 2, pipelineMs: 2 });
  const progs = new Map(),
    frameSet = { cur: new Set() };
  for (const name of [
    'drawArrays',
    'drawElements',
    'drawArraysInstanced',
    'drawElementsInstanced',
  ]) {
    const orig = W.gl[name];
    if (!orig) continue;
    W.gl[name] = (...a) => {
      const p = W.model.cur;
      if (p) {
        if (!progs.has(p)) progs.set(p, progs.size);
        frameSet.cur.add(progs.get(p));
      }
      return orig(...a);
    };
  }
  const R = createRenderer(W.gl, taggedShaderSources(), {
    asyncShaderCompile: true,
    nonBlocking: true,
    strictPlay: true,
    aacPoints: false,
    glGuard: true,
    gpuShedMs: 40,
    ...rOpts,
  });
  R.ready.catch(() => {});
  setTimeout(() => W.release(), 40);
  await R.ready;
  if (engine) R.setFillEngine(engine);
  R.setViewport(1024, 640);
  const groups = {};
  for (const k of Object.keys(sections))
    (groups[k.split('.')[0]] ||= []).push(createBundle(W.gl, sections[k]));
  const ma = createBundle(W.gl, mA),
    mb = createBundle(W.gl, mB),
    morph = createShapeMorph(W.gl, ma, mb);
  groups.morph = [morph.bundle];
  const all = Object.values(groups).flat();
  await R.precompileFillsAsync(loadOpts);
  W.setTiming({ linkMs: 30, pipelineMs: 120 }); // (play at the durations a stray link or build shows against)
  return { W, R, groups, all, morph, frameSet, dv: R.debugStats.viewportWarm.derived || null };
}
const inRectOf = (rect) => (w, h) =>
  w >= rect.minW && h >= rect.minH && w <= rect.maxW && h <= rect.maxH;
/// Linear viewport sizes, every 0.5%, at extreme and ordinary aspects, inside the reachable rectangle.
function linearViewports(rect) {
  const inRect = inRectOf(rect),
    viewports = [];
  for (const asp of [0.1, 0.25, 0.5, 1, 1.6, 4, 10])
    for (
      let L = Math.sqrt(rect.minW * rect.minH);
      L <= Math.sqrt(rect.maxW * rect.maxH) * 1.001;
      L *= 1.005
    ) {
      const w = Math.round(L * Math.sqrt(asp)),
        h = Math.round(L / Math.sqrt(asp));
      if (inRect(w, h)) viewports.push([w, h]);
    }
  return viewports;
}
/// Every bundle at exactly, just below and just above every breakpoint of its own scale domain.
function breakpointViewports(dv) {
  const viewports = [];
  dv.bundles.forEach((r) => {
    if (!r.bbox) return;
    const vw = Math.abs(r.bbox[2] - r.bbox[0]),
      vh = Math.abs(r.bbox[3] - r.bbox[1]);
    for (const bp of r.breakpoints)
      for (const f of [0.9999, 0.99995, 1, 1.00005, 1.0001])
        viewports.push([Math.round(bp * f * vw), Math.round(bp * f * vh)]);
  });
  return viewports;
}
function sweep(X, groupNames, vps) {
  const p0 = X.W.model.pipelines,
    w0 = X.W.model.waits.length,
    ds0 = { ...X.R.debugStats },
    pr0 = ((X.R.debugStats.gpuGate && X.R.debugStats.gpuGate.postReady) || []).length;
  const drawn = new Map(); // program id -> number of viewports it was drawn at
  let frames = 0;
  const list = groupNames.flatMap((g) => X.groups[g]);
  for (const [w, h] of vps) {
    X.R.setViewport(w, h);
    X.frameSet.cur = new Set();
    for (const st of STATES) {
      X.R.beginFrame([1, 1, 1, 1]);
      for (const b of list) X.R.drawBundle(b, st);
      X.R.endFrame();
      frames++;
    }
    for (const id of X.frameSet.cur) drawn.set(id, (drawn.get(id) || 0) + 1);
  }
  const d = (k) => (X.R.debugStats[k] | 0) - (ds0[k] | 0);
  const pr1 = ((X.R.debugStats.gpuGate && X.R.debugStats.gpuGate.postReady) || []).length;
  return {
    frames,
    builds: X.W.model.pipelines - p0,
    newCombos: pr1 - pr0,
    waits: X.W.model.waits.length - w0,
    deferred: d('deferredFillDraws') + d('deferredFilterDraws'),
    shed: d('shedFrames'),
    maskDeferred: d('maskBakeDeferred'),
    playBuilds: d('playBuilds'),
    drawn,
    nViews: vps.length,
  };
}

/// One arm: the loading call, then sections 1 to 4 against its derivation. `bars`: the premise that some bundle has a bar inside the range. `swept`: the groups
/// the exhaustive sweep draws (the inventory draws every group).
async function derivedArm(rOpts, engine, bars, swept = null) {
  const A = await arm({ maxViewportPx: 4096 }, rOpts, engine);
  const dv = A.dv;
  const rect = dv.range;
  console.log(
    `  reachable viewport ${rect.minW}x${rect.minH} .. ${rect.maxW}x${rect.maxH}; ${dv.regions} warm viewport(s) for ${dv.bundles.length} bundles; ${dv.evals} decision evaluations in ${dv.ms} ms`,
  );
  dv.bundles.forEach((r, i) =>
    console.log(
      `    bundle ${i} box ${r.bbox && r.bbox.slice(0, 4).map((v) => +(+v).toFixed(1))} scale ${r.scaleRange && r.scaleRange.join('..')}: breakpoints [${r.breakpoints.join(', ')}] -> ${r.regions} region(s)`,
    ),
  );
  const broken = dv.bundles.filter((r) => r.breakpoints.length),
    regionsOfBroken = broken.reduce((n, r) => n + r.regions, 0);
  ok(
    dv.sizes.length <= regionsOfBroken && dv.sizes.length > 0 === broken.length > 0,
    `the derivation produced ${dv.sizes.length} warm viewport(s) beyond the current size for the ${regionsOfBroken} region(s) of the ${broken.length} bundle(s) with a break (a bundle with no break warms at the current size only)`,
  );
  if (bars)
    ok(
      broken.length > 0 && dv.sizes.length > 0,
      `the premise: ${broken.length} bundle(s) with a bar inside the range (${broken.map((r) => (r.why || []).join('/')).join(' ')}), so the loading call warms ${dv.sizes.length} derived viewport(s)`,
    );

  // 1. exhaustive sweep: linear viewport sizes at extreme and ordinary aspects (inside the reachable rectangle), plus every bundle at its own breakpoints
  const inRect = inRectOf(rect);
  const linear = linearViewports(rect),
    atBreaks = breakpointViewports(dv),
    viewports = [...linear, ...atBreaks];
  const S = sweep(A, swept || Object.keys(A.groups), viewports),
    nSwept = (swept || Object.keys(A.groups)).reduce((n, g) => n + A.groups[g].length, 0);
  if (S.newCombos)
    for (const e of (A.R.debugStats.gpuGate.postReady || []).slice(-S.newCombos))
      console.log(
        '   new combination in play:',
        String(e.program).slice(0, 160),
        '|',
        e.target,
        '|',
        JSON.stringify(e.ctx).slice(0, 200),
      );
  ok(
    S.builds === 0 && S.newCombos === 0,
    `${S.frames} frames over ${S.nViews} viewports x ${STATES.length} states x ${nSwept} bundles built no pipeline (${S.builds}) and no new program x format x layout (${S.newCombos})`,
  );
  ok(
    S.waits === 0 && S.deferred === 0 && S.shed === 0 && S.maskDeferred === 0 && S.playBuilds === 0,
    `no wait (${S.waits}), deferral (${S.deferred}), shed frame (${S.shed}), mask bake deferral (${S.maskDeferred}) or play build (${S.playBuilds})`,
  );

  // every key the draw path WANTS at any scale is one it wants at a warmed (representative) viewport
  {
    const wants = (X) => new Set((X.R.debugStats.playStandIns || []).map((e) => e.want));
    const wantsAll = wants(A);
    const Rp = await arm({ maxViewportPx: 4096 }, rOpts, engine);
    sweep(Rp, Object.keys(Rp.groups), [[1024, 640], ...Rp.dv.sizes]);
    const wantsRep = wants(Rp);
    const extra = [...wantsAll].filter((k) => !wantsRep.has(k));
    ok(
      extra.length === 0,
      `the sweep wanted ${wantsAll.size} distinct keys; ${extra.length} were not wanted at a derived warm viewport`,
    );
    for (const k of extra.slice(0, 5)) console.log('   unwarmed want:', k.slice(0, 200));
    Rp.R.dispose();
  }

  // 4. inventory per category: distinct programs drawn, and how many of them at only some scales. A bundle's programs change only at its breakpoints (the drift
  // guard, section 3, holds the production answer to them), so every tenth viewport of the linear sweep and every breakpoint's neighborhood draw each group on
  // both sides of every break.
  console.log(
    '  inventory (programs drawn over every tenth viewport and the breakpoints; "varying" = drawn at only some viewports):',
  );
  const sampled = [...linear.filter((_, i) => i % 10 === 0), ...atBreaks];
  for (const g of Object.keys(A.groups)) {
    const Gv = sweep(A, [g], sampled);
    const varying = [...Gv.drawn.values()].filter((n) => n < Gv.nViews).length;
    console.log(
      `    ${g.padEnd(7)} ${Gv.drawn.size} program(s), ${varying} varying with scale; builds ${Gv.builds}, new combos ${Gv.newCombos}, deferrals ${Gv.deferred}`,
    );
    ok(
      Gv.builds === 0 && Gv.newCombos === 0 && Gv.deferred === 0,
      `${g}: no build, new combination or deferral across the sweep`,
    );
  }

  // 2. aspect: the answer depends on the fit scale only
  {
    let checked = 0,
      bad = 0,
      seed = 12345;
    const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;
    dv.live.forEach((b, i) => {
      const r = dv.bundles[i];
      if (!r.bbox) return;
      const vw = Math.abs(r.bbox[2] - r.bbox[0]),
        vh = Math.abs(r.bbox[3] - r.bbox[1]);
      for (let n = 0; n < 120; n++) {
        const asp = Math.pow(10, rnd() * 2 - 1),
          L =
            Math.sqrt(rect.minW * rect.minH) *
            Math.pow(Math.sqrt(rect.maxW * rect.maxH) / Math.sqrt(rect.minW * rect.minH), rnd());
        const w = Math.round(L * Math.sqrt(asp)),
          h = Math.round(L / Math.sqrt(asp));
        if (!inRect(w, h)) continue;
        const s = Math.min(w / vw, h / vh);
        checked++;
        if (
          dv.sigAt(b, w, h) !==
          dv.sigAt(b, Math.max(1, Math.round(s * vw)), Math.max(1, Math.round(s * vh)))
        )
          bad++;
      }
    });
    ok(
      checked > 100 && bad === 0,
      `${checked} random viewports (aspects 1:10..10:1): the answer equals the one at the same fit scale in the bundle's own aspect (${bad} differ)`,
    );
  }
  // 3. drift guard: sweep the production answer (test only) and compare with the analytic breakpoints
  {
    let flipsFound = 0,
      unexplained = 0,
      breaksReal = 0,
      breaksNeutral = 0;
    dv.live.forEach((b, i) => {
      const r = dv.bundles[i];
      if (!r.bbox) return;
      const vw = Math.abs(r.bbox[2] - r.bbox[0]),
        vh = Math.abs(r.bbox[3] - r.bbox[1]);
      // the answer swept: the program keys and (stroke strips are a draw state, not a key) the strip policy's own state
      const at = (sc) => {
        const w = Math.max(1, Math.round(sc * vw)),
          h = Math.max(1, Math.round(sc * vh));
        return (
          dv.sigAt(b, w, h) +
          '/' +
          (b._stripChunks && b._stripChunks.length ? dv.stripKeyAt(b, w, h) : '')
        );
      };
      const [sLo, sHi] = r.scaleRange;
      let prevS = sLo,
        prev = at(sLo);
      const flipsAt = [];
      for (let sc = sLo * 1.0005; ; sc *= 1.0005) {
        if (sc > sHi) sc = sHi;
        const cu = at(sc);
        if (cu !== prev) {
          let a0 = prevS,
            z0 = sc;
          while (z0 / a0 > 1.00001) {
            const m = Math.sqrt(a0 * z0);
            if (at(m) === prev) a0 = m;
            else z0 = m;
          }
          flipsAt.push(z0);
        }
        prevS = sc;
        prev = cu;
        if (sc >= sHi) break;
      }
      // (the swept viewport is whole pixels: its fit scale is off the ideal by up to half a pixel of the smaller side)
      const tol = (x) => 1e-4 + 1.5 / (x * Math.min(vw, vh));
      for (const f of flipsAt) {
        flipsFound++;
        if (!r.breakpoints.some((bp) => Math.abs(f / bp - 1) < tol(bp))) {
          unexplained++;
          console.log(
            `   UNEXPLAINED flip of bundle ${i} at scale ${f.toFixed(4)} (breaks: [${r.breakpoints.join(', ')}])`,
          );
        }
      }
      for (const bp of r.breakpoints) {
        if (flipsAt.some((f) => Math.abs(f / bp - 1) < tol(bp))) breaksReal++;
        else breaksNeutral++;
      }
    });
    ok(
      unexplained === 0,
      `the 0.05% sweep of the production answer found ${flipsFound} flip(s); ${unexplained} not explained by an analytic breakpoint`,
    );
    if (bars)
      ok(
        breaksReal > 0,
        `the premise: ${breaksReal} analytic breakpoint(s) are real flips of the production answer`,
      );
    console.log(
      `  (${breaksReal} analytic breakpoints are real flips; ${breaksNeutral} change a census without changing a program key or strip state)`,
    );
    const whys = {};
    for (const r of dv.bundles) for (const w of r.why || []) whys[w] = (whys[w] || 0) + 1;
    console.log(
      '  breakpoints by gate:',
      JSON.stringify(whys),
      '| key-neutral gates:',
      dv.keyNeutral.join(', '),
    );
    ok(
      dv.method === 'analytic' && dv.evals === undefined,
      'the production derivation reports method "analytic" and takes no evaluation count (nothing is sampled)',
    );
  }
  A.R.dispose();
}

console.log("(defaults) the renderer's defaults: no bundle has a bar in the range");
await derivedArm({}, null, false);
console.log(
  "(aacFill 'auto', Loop-Blinn route) the engine and route picks put bars in the range: their regions are derived and warmed",
);
// (the bars are the fill bundles': the exhaustive sweep draws them, the other groups are drawn by the inventory, as they are under the defaults above)
await derivedArm({ aacFill: 'auto' }, { route: 'lb' }, true, ['fill']);
// the bar arithmetic: the smallest unit px2 whose quantized scale reaches T flips exactly there
{
  const { k2AtLeast, k2Above, pickBucket, bucketScale } =
    await import('../src/renderer/lbShapePolicy.js');
  let bad = 0;
  for (let i = 0; i < 400; i++) {
    const T = Math.pow(2, -2 + i * 0.043);
    const k = k2AtLeast(T),
      j = k2Above(T);
    if (!(bucketScale(pickBucket(k * 1.0000001)) >= T * (1 - 1e-9))) bad++;
    if (!(bucketScale(pickBucket(k * 0.9999999)) < T * (1 + 1e-9))) bad++;
    if (!(bucketScale(pickBucket(j * 1.0000001)) > T * (1 - 1e-9))) bad++;
    if (!(bucketScale(pickBucket(j * 0.9999999)) <= T * (1 + 1e-9))) bad++;
  }
  ok(
    bad === 0,
    `the quarter-octave rounding rule's exact crossing (k2AtLeast / k2Above) matches the production bucket at 400 thresholds (${bad} wrong)`,
  );
}
console.log(fail ? `strictDerivedRegionsSmoke FAIL (${fail})` : 'strictDerivedRegionsSmoke PASS');
process.exit(fail ? 1 : 0);
