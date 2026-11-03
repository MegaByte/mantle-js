// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _scaleWarm.mjs -- the shared rig of the size-gate warm smokes: a stand-in-free renderer on the driver-model stand-in (test/_pendingGl.mjs), a load, and a play window that says what a
// run of draws cost. A draw's world matrix reaches every scale in (0, inf), so the sweep runs far past anything the viewport-derived regions cover.
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

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const doc = (body, defs = '', vb = '0 0 100 100') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}">${defs ? '<defs>' + defs + '</defs>' : ''}${body}</svg>`;
/// Scale `sx`, `sy` then rotate by `rot`, column-major.
export const at = (sx, sy = sx, rot = 0) => {
  const c = Math.cos(rot),
    s = Math.sin(rot);
  return new Float32Array([sx * c, sx * s, 0, -sy * s, sy * c, 0, 0, 0, 1]);
};
export const SCALES = Array.from({ length: 57 }, (_, i) => 2 ** (-14 + i / 2)); // 2^-14 .. 2^14, half octaves
export const TINT = {
  colorMatrix: new Float32Array([0.9, 0.1, 0, 0, 0, 0.9, 0.1, 0, 0.1, 0, 0.9, 0, 0, 0, 0, 1]),
  colorMatrixOffset: new Float32Array([0.05, 0, 0, 0]),
};
/// The warm image's draw states: as drawn, a rotated map, a recolor, both.
export const STATES = [{ rot: 0 }, { rot: 0.6 }, { rot: 0, ...TINT }, { rot: 0.6, ...TINT }];

/// A stand-in-free renderer (strictPlay's default policy) with `svgs` loaded; `prepare(bundles, R, W)` runs before the loading call.
export async function load(svgs, rOpts = {}, prepare = null) {
  const W = createPendingGl({ linkMs: 2, pipelineMs: 2 });
  const R = createRenderer(W.gl, taggedShaderSources(), {
    asyncShaderCompile: true,
    nonBlocking: true,
    strictPlay: true,
    aacFill: 'auto',
    needMissPolicy: 'block',
    ...rOpts,
  });
  R.ready.catch(() => {});
  setTimeout(() => W.release(), 10);
  await R.ready;
  R.setViewport(1024, 640);
  const bundles = [];
  for (const s of svgs)
    bundles.push(createBundle(W.gl, await importSvg(s, { preserveViewport: true })));
  if (prepare) await prepare(bundles, R, W);
  await R.precompileFillsAsync({});
  return { W, R, bundles };
}
/// What the draws since this call cost in play: pipelines built, main-thread waits, links started, builds the renderer counted, draws deferred, draws that blocked.
export function inPlay(W, R) {
  const p0 = W.model.pipelines,
    w0 = W.model.waits.length,
    l0 = W.model.links,
    ds0 = { ...R.debugStats },
    b0 = (R.debugStats.needMiss && R.debugStats.needMiss.blocked) | 0;
  return () => {
    const d = (k) => (R.debugStats[k] | 0) - (ds0[k] | 0),
      nm = R.debugStats.needMiss || {};
    return {
      pipelines: W.model.pipelines - p0,
      waits: W.model.waits.length - w0,
      links: W.model.links - l0,
      playBuilds: d('playBuilds'),
      deferred: d('deferredFillDraws'),
      blocked: (nm.blocked | 0) - b0,
      keys: nm.keys || [],
    };
  };
}
export const clean = (r) =>
  r.pipelines === 0 && r.waits === 0 && r.playBuilds === 0 && r.deferred === 0 && r.blocked === 0;
export const say = (r) =>
  `${r.pipelines} pipelines built, ${r.waits} waits, ${r.links} links, ${r.playBuilds} play builds, ${r.deferred} deferred, ${r.blocked} blocked${r.keys.length ? ' ' + JSON.stringify(r.keys.slice(0, 2)) : ''}`;
/// One bundle drawn at every scale under every warm state: uniform, and stretched so the smallest direction falls far below the area scale (`aniso` true).
export async function sweep(R, bundle, { states = STATES, aniso = true, extra = null } = {}) {
  for (const k of SCALES) {
    R.beginFrame([1, 1, 1, 1]);
    for (const { rot, ...rest } of states) {
      R.drawBundle(bundle, { worldMatrix: at(k, k, rot), ...rest });
      if (aniso) R.drawBundle(bundle, { worldMatrix: at(k * 8, k / 8, rot), ...rest });
    }
    if (extra) extra(k);
    R.endFrame();
    await sleep(1);
  }
}
/// The image's fill keys (not the point program's).
export const fillKeys = (R, b) =>
  R._policy
    .image(b)
    .map((e) => e.key)
    .filter((k) => k.charAt(0) !== '\u0000');
