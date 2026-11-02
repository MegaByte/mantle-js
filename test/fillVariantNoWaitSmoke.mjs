// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// fillVariantNoWaitSmoke -- a fill draw in play never waits on a shader link, and never falls back to a program whose pipeline is cold.
//
// On a cold GPU cache two things would stall mid-play:
//   * a draw that needs a kernel or footprint its warm base lacks (AAC, a rotated map) finishing that variant's link on the spot
//     (LINK_STATUS on a program still compiling: 0.3-10 s of frozen main thread);
//   * a linked lean variant whose pipeline is unbuilt drawing with the all-feature AAC base, which has never been drawn: ~10 s of
//     GPU pipeline build and no presented frame, to avoid a lean build of a fraction of a second.
// Node only. (a) is the define algebra of the warm superset; (b)-(e) run the renderer on the recording WebGL stand-in with a driver whose
// links stay unfinished until released.
globalThis.__MANTLE_DEBUG__ = true;
globalThis.__MANTLE_NO_STATIC_CACHE = true;
import { isWarmSuperset, pickWarmSuperset } from '../src/renderer/sceneUnion.js';
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const K = (...d) =>
  d
    .map((x) => 'MANTLE_' + x)
    .sort()
    .join('|');

console.log('(a) the warm superset algebra');
const lean = K(
  'AAC',
  'AAC_PAIR_BANDS',
  'NO_ARC',
  'NO_CUBIC',
  'NO_FILTER',
  'NO_STROKE',
  'NO_PATTERN',
);
ok(
  isWarmSuperset(K('AAC', 'AAC_PAIR_BANDS', 'NO_ARC', 'NO_CUBIC', 'NO_FILTER'), lean),
  "an entry that omits only some of the want's omissions is a superset",
);
ok(
  isWarmSuperset(K('AAC'), lean),
  'the AAC base (nothing omitted) is a superset of any AAC lean key',
);
ok(
  !isWarmSuperset(
    K(
      'AAC',
      'AAC_PAIR_BANDS',
      'NO_ARC',
      'NO_CUBIC',
      'NO_FILTER',
      'NO_STROKE',
      'NO_PATTERN',
      'NO_CLIP',
    ),
    lean,
  ),
  'an entry that omits what the want keeps (NO_CLIP) is not',
);
ok(
  !isWarmSuperset(K('NO_ARC', 'NO_CUBIC'), lean),
  'the Slug kernel is not a superset of an AAC key (the kernel is part of the answer)',
);
ok(
  !isWarmSuperset(K('AAC', 'AAC_PAIR_BANDS', 'ROTATED_MAP'), lean),
  'a rotated-map program is a different footprint class, not an omission superset of an axis-aligned key',
);
ok(
  isWarmSuperset(K('AAC', 'ROTATED_MAP'), K('AAC', 'AAC_PAIR_BANDS', 'ROTATED_MAP', 'NO_ARC')),
  "a program with the want's own footprint and fewer omissions is a superset",
);
ok(
  isWarmSuperset(K('AAC', 'NO_ARC'), lean),
  'a stripe-band program reads a pair-band bundle exactly: it may stand in',
);
ok(
  !isWarmSuperset(K('AAC', 'AAC_PAIR_BANDS', 'NO_ARC'), K('AAC', 'NO_ARC', 'NO_CUBIC')),
  'a pair-band program cannot read a stripe-band bundle',
);
ok(
  !isWarmSuperset(K('LB_FILL', 'LB_CURVE_TEX', 'AAC'), lean),
  'the unified-stream wire is a different class',
);
ok(
  !isWarmSuperset(
    K('LB_FILL', 'LB_CURVE_TEX', 'AAC', 'NO_COVER_FILL'),
    K('LB_FILL', 'LB_CURVE_TEX', 'AAC'),
  ),
  'NO_COVER_FILL is the class, not an omission to relax',
);
ok(
  !isWarmSuperset(K('CPATCH', 'NO_STROKE'), K('CPATCH', 'NO_STROKE', 'NO_FILTER')),
  'a CPatch key is a pass selector and never stands in',
);
ok(!isWarmSuperset(lean, lean), 'a key is not its own stand-in');
ok(
  pickWarmSuperset(lean, [
    K('AAC'),
    K('AAC', 'AAC_PAIR_BANDS', 'NO_ARC', 'NO_CUBIC'),
    K('AAC', 'AAC_PAIR_BANDS', 'NO_CUBIC'),
  ]) === K('AAC', 'AAC_PAIR_BANDS', 'NO_ARC', 'NO_CUBIC'),
  'the leanest superset wins (the most omissions: the least code a stand-in drags in)',
);
ok(
  pickWarmSuperset(lean, [
    K('AAC', 'NO_ARC', 'NO_CUBIC'),
    K('AAC', 'AAC_PAIR_BANDS', 'NO_ARC', 'NO_CUBIC'),
  ]) === K('AAC', 'AAC_PAIR_BANDS', 'NO_ARC', 'NO_CUBIC'),
  "a tie goes to the want's own band layout",
);
ok(pickWarmSuperset(lean, [K('NO_ARC')]) === null, 'no superset: null');

// ---- the renderer on the recording stand-in ----
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
const { createFakeGl, taggedShaderSources } = await import('./_fakeGl.mjs');
const { createRenderer, createBundle, importSvg } = await import('../src/index.js');
const DOC =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M10 10 C 60 0 90 40 80 90 L 20 70 Z" fill="#303"/></svg>';
const sec = await importSvg(DOC, { preserveViewport: true });
const COMPLETION = 0x91b1;
/// A recording stand-in whose links, once armed, stay unfinished until released, and which knows each program's defines.
function rig(opts) {
  const F = createFakeGl({ width: 128, height: 128 });
  const gl = F.gl;
  const unfinished = new Set(),
    shaderDefs = new Map(),
    progDefs = new Map();
  const st = { armed: false, blocking: [] };
  const shaderSource = gl.shaderSource;
  gl.shaderSource = (sh, src) => {
    shaderDefs.set(
      sh,
      [...String(src).matchAll(/^#define (MANTLE_\w+)/gm)].map((m) => m[1]),
    );
    return shaderSource(sh, src);
  };
  const attachShader = gl.attachShader;
  gl.attachShader = (p, sh) => {
    progDefs.set(p, [...new Set([...(progDefs.get(p) || []), ...(shaderDefs.get(sh) || [])])]);
    return attachShader(p, sh);
  };
  gl.getExtension = (n) =>
    n === 'KHR_parallel_shader_compile' ? { COMPLETION_STATUS_KHR: COMPLETION } : null;
  gl.linkProgram = (p) => {
    if (st.armed) unfinished.add(p);
  };
  const note = (what, p) => {
    if (unfinished.has(p)) st.blocking.push(what);
  };
  gl.getProgramParameter = (p, pname) => {
    if (pname === COMPLETION) return !unfinished.has(p);
    note('getProgramParameter', p);
    return true;
  };
  gl.getUniformLocation = (p, name) => {
    note('getUniformLocation', p);
    return { uniform: name };
  };
  gl.getProgramInfoLog = (p) => {
    note('getProgramInfoLog', p);
    return '';
  };
  const R = createRenderer(gl, taggedShaderSources(), { aacPoints: false, ...opts });
  R.setLoopBlinnFill('off');
  const b = createBundle(gl, sec);
  R.setViewport(128, 128);
  return {
    F,
    R,
    b,
    st,
    unfinished,
    progDefs,
    drawn(from) {
      return F.log
        .slice(from)
        .filter((e) => e.op === 'draw')
        .map((e) => ({ prog: e.prog, defs: progDefs.get(e.prog) || [] }));
    },
  };
}
const ROT45 = new Float32Array([
  Math.SQRT1_2,
  Math.SQRT1_2,
  0,
  -Math.SQRT1_2,
  Math.SQRT1_2,
  0,
  0,
  0,
  1,
]);

console.log(
  "(b) the first sight of a rotated map starts the twins of the scene's live variants: the next bundle to turn waits on no link",
);
{
  const GSVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs><path d="M10 10 C 60 0 90 40 80 90 L 20 70 Z" fill="url(#g)"/></svg>';
  const W = rig({ aacFill: true });
  W.R.setFillEngine({ route: 'none', kernel: 'aac', primitives: 'off' });
  const b2 = createBundle(W.F.gl, await importSvg(GSVG, { preserveViewport: true }));
  W.R.prewarmBundle(W.b);
  W.R.prewarmBundle(b2);
  W.R.precompileFills();
  for (let i = 0; i < 2; i++) {
    W.R.beginFrame([1, 1, 1, 1]);
    W.R.drawBundle(W.b);
    W.R.drawBundle(b2);
    W.R.endFrame();
  } // both live, axis-aligned
  W.st.armed = true;
  W.R.beginFrame([1, 1, 1, 1]);
  W.R.drawBundle(W.b, { worldMatrix: ROT45 });
  W.R.endFrame(); // the first sight
  W.unfinished.clear(); // the driver finishes the links it was given
  W.st.blocking.length = 0;
  const mark = W.F.log.length;
  W.R.beginFrame([1, 1, 1, 1]);
  W.R.drawBundle(b2, { worldMatrix: ROT45 });
  W.R.endFrame();
  const draws = W.drawn(mark).filter((d) => d.defs.length);
  ok(draws.length > 0, `the second bundle drew (${draws.length} draws)`);
  ok(
    W.st.blocking.length === 0,
    `and read no unfinished program (${W.st.blocking.join(',') || 'none'})`,
  );
  ok(
    draws.some((d) => d.defs.includes('MANTLE_ROTATED_MAP') && d.defs.includes('MANTLE_AAC')),
    'with an AAC program that has the rotated footprint',
  );
}

console.log(
  '(c) a linked variant with an unbuilt pipeline draws itself, not an all-feature program nothing has drawn',
);
{
  const GSVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs><path d="M10 10 C 60 0 90 40 80 90 L 20 70 Z" fill="url(#g)"/></svg>';
  const W = rig({});
  W.R.setFillEngine({ route: 'none', kernel: 'aac', primitives: 'off' });
  W.R.prewarmBundle(W.b);
  W.R.precompileFills(); // loading warms the plain bundle: its variant, the AAC universal linked behind it, the Slug base drawn
  const gb = createBundle(W.F.gl, await importSvg(GSVG, { preserveViewport: true })); // content that appears after loading: linked by the idle tick, pipeline unbuilt
  W.R.prewarmBundle(gb);
  const mark = W.F.log.length;
  W.R.beginFrame([1, 1, 1, 1]);
  W.R.drawBundle(gb);
  W.R.endFrame();
  const draws = W.drawn(mark).filter((d) => d.defs.includes('MANTLE_AAC'));
  ok(draws.length > 0, 'an AAC draw happened');
  ok(
    draws.every((d) => d.defs.some((x) => x.startsWith('MANTLE_NO_'))),
    `it bound a lean AAC variant (${draws.map((d) => d.defs.length + ' defines').join(' | ')}), not the bare AAC universal`,
  );
}

console.log(
  '(d) the first sight of a recolor starts the twins: the next tinted bundle waits on no link and does not take the AAC universal',
);
{
  const GSVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs><path d="M10 10 C 60 0 90 40 80 90 L 20 70 Z" fill="url(#g)"/></svg>';
  const W = rig({});
  W.R.setFillEngine({ route: 'none', kernel: 'aac', primitives: 'off' });
  const b2 = createBundle(W.F.gl, await importSvg(GSVG, { preserveViewport: true }));
  W.R.prewarmBundle(W.b);
  W.R.prewarmBundle(b2);
  W.R.precompileFills();
  for (let i = 0; i < 2; i++) {
    W.R.beginFrame([1, 1, 1, 1]);
    W.R.drawBundle(W.b);
    W.R.drawBundle(b2);
    W.R.endFrame();
  }
  W.st.armed = true;
  const TINT = {
    colorMatrix: new Float32Array([0.9, 0.1, 0, 0, 0, 0.9, 0.1, 0, 0.1, 0, 0.9, 0, 0, 0, 0, 1]),
    colorMatrixOffset: new Float32Array([0.05, 0, 0, 0]),
  };
  W.R.beginFrame([1, 1, 1, 1]);
  W.R.drawBundle(W.b, TINT);
  W.R.endFrame(); // the first sight
  W.unfinished.clear();
  W.st.blocking.length = 0;
  const mark = W.F.log.length;
  W.R.beginFrame([1, 1, 1, 1]);
  W.R.drawBundle(b2, TINT);
  W.R.endFrame();
  const draws = W.drawn(mark).filter((d) => d.defs.includes('MANTLE_AAC'));
  ok(draws.length > 0, `the second bundle drew with an AAC program (${draws.length} draws)`);
  ok(
    W.st.blocking.length === 0,
    `and read no unfinished program (${W.st.blocking.join(',') || 'none'})`,
  );
  ok(
    draws.every((d) => !d.defs.includes('MANTLE_NO_RECOLOR')),
    'the program has the recolor code in',
  );
  ok(
    draws.every((d) => d.defs.length > 1),
    `a lean twin, not the bare AAC universal (${draws.map((d) => d.defs.length + ' defines').join(' | ')})`,
  );
}

console.log(
  '(e) precompileFillsAsync builds the future states: the FIRST rotated and the first recolored draw of every bundle wait on no link',
);
{
  const W = rig({ aacFill: true });
  W.R.setFillEngine({ route: 'none', kernel: 'aac', primitives: 'off' });
  const n = await W.R.precompileFillsAsync({ timeoutMs: 300 });
  ok(typeof n === 'number', `it resolved (${n})`);
  W.st.armed = true;
  const mark = W.F.log.length;
  W.R.beginFrame([1, 1, 1, 1]);
  W.R.drawBundle(W.b, { worldMatrix: ROT45 });
  W.R.endFrame();
  W.R.beginFrame([1, 1, 1, 1]);
  W.R.drawBundle(W.b, {
    colorMatrix: new Float32Array([0.9, 0.1, 0, 0, 0, 0.9, 0.1, 0, 0.1, 0, 0.9, 0, 0, 0, 0, 1]),
    colorMatrixOffset: new Float32Array([0.05, 0, 0, 0]),
  });
  W.R.endFrame();
  const draws = W.drawn(mark);
  ok(draws.length >= 2, `both frames drew (${draws.length} draws)`);
  ok(
    W.st.blocking.length === 0,
    `and read no unfinished program (${W.st.blocking.join(',') || 'none'})`,
  );
  ok(
    draws.every((d) => !W.unfinished.has(d.prog)),
    'no draw bound an unfinished program',
  );
  ok(
    W.R.debugStats && !(W.R._blockingLinkWaits | 0),
    `no last-resort wait was taken (${W.R._blockingLinkWaits | 0})`,
  );
}

console.log(
  '(f) a recorded manifest warms the recorded states only, and a manifest that does not know the bundle degrades to the exhaustive warm',
);
{
  const programsAfterLoad = async (opts, manifest, drawSomething) => {
    const W = rig({ aacFill: true, ...opts });
    W.R.setFillEngine({ route: 'none', kernel: 'aac', primitives: 'off' });
    if (drawSomething) {
      W.R.beginFrame([1, 1, 1, 1]);
      W.R.drawBundle(W.b, { worldMatrix: ROT45 });
      W.R.endFrame();
    }
    const exported = drawSomething ? W.R.exportWarmManifest() : null;
    if (!drawSomething) await W.R.precompileFillsAsync({ timeoutMs: 300, manifest });
    return { W, exported, links: W.progDefs.size };
  };
  const rec = await programsAfterLoad({ recordWarmManifest: true }, null, true);
  const keys = Object.keys(rec.exported.entries);
  ok(
    rec.exported.version === 3 && keys.length === 1 && rec.exported.entries[keys[0]].length === 1,
    `the session recorded one bundle with one state (${keys.length} bundles, ${JSON.stringify(rec.exported.version)})`,
  );
  ok(
    rec.exported.entries[keys[0]][0].w[1] !== 0,
    'and the state is the rotated map the session drew',
  );
  const exhaustive = await programsAfterLoad({}, null, false);
  const withManifest = await programsAfterLoad({}, rec.exported, false);
  ok(
    withManifest.links < exhaustive.links,
    `the manifest warm builds fewer programs than the exhaustive one (${withManifest.links} against ${exhaustive.links})`,
  );
  const stale = { version: 2, entries: { 'deadbeef:1': rec.exported.entries[keys[0]] } };
  const staleRun = await programsAfterLoad({}, stale, false);
  ok(
    staleRun.links === exhaustive.links,
    `a manifest that does not name the bundle gives the exhaustive warm (${staleRun.links} programs)`,
  );
  withManifest.W.st.armed = true;
  const mark = withManifest.W.F.log.length;
  withManifest.W.R.beginFrame([1, 1, 1, 1]);
  withManifest.W.R.drawBundle(withManifest.W.b, { worldMatrix: ROT45 });
  withManifest.W.R.endFrame();
  ok(
    withManifest.W.st.blocking.length === 0,
    `the recorded rotated draw waits on no link (${withManifest.W.st.blocking.length} reads)`,
  );
  ok(
    withManifest.W.drawn(mark).every((d) => !withManifest.W.unfinished.has(d.prog)),
    'and binds no unfinished program',
  );
}

console.log(
  '(g) coverSet: the loading call compiles the maximal programs only, and a bundle whose own variant was never compiled draws with a built superset',
);
{
  const GSVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs><path d="M10 10 C 60 0 90 40 80 90 L 20 70 Z" fill="url(#g)"/></svg>';
  const run = async (coverSet) => {
    const W = rig({ aacFill: true, coverSet, kernelSeeds: false }); // (seeds add programs on purpose: the count test is about the plan)
    W.R.setFillEngine({ route: 'none', kernel: 'aac', primitives: 'off' });
    const b2 = createBundle(W.F.gl, await importSvg(GSVG, { preserveViewport: true }));
    await W.R.precompileFillsAsync({ timeoutMs: 300 });
    return { W, b2, programs: W.progDefs.size };
  };
  const full = await run(false),
    cover = await run(true);
  ok(
    cover.programs < full.programs,
    `fewer programs are built with the cover set (${cover.programs} against ${full.programs})`,
  );
  cover.W.st.armed = true;
  const mark = cover.W.F.log.length,
    before = cover.W.progDefs.size;
  cover.W.R.beginFrame([1, 1, 1, 1]);
  cover.W.R.drawBundle(cover.W.b);
  cover.W.R.drawBundle(cover.b2, { worldMatrix: ROT45 });
  cover.W.R.drawBundle(cover.b2, {
    colorMatrix: new Float32Array([0.9, 0.1, 0, 0, 0, 0.9, 0.1, 0, 0.1, 0, 0.9, 0, 0, 0, 0, 1]),
    colorMatrixOffset: new Float32Array([0.05, 0, 0, 0]),
  });
  cover.W.R.endFrame();
  ok(cover.W.drawn(mark).length >= 3, 'both bundles drew, plain, rotated and recolored');
  ok(
    cover.W.st.blocking.length === 0 && cover.W.progDefs.size === before,
    `with no link read and no program compiled in play (${cover.W.st.blocking.length} reads, ${cover.W.progDefs.size - before} new programs)`,
  );
}

if (fail) {
  console.error(`FAIL fillVariantNoWaitSmoke: ${fail}`);
  process.exit(1);
}
console.log('fillVariantNoWaitSmoke PASS');
