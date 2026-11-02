// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// warmSceneSmoke -- renderer.warmScene(states): draw the future states behind the loading screen until a pass builds nothing, and
// report it. Pinned with the fake GL:
//   * the report names every state with passes, stable, programs created and variants added, and `complete` is true only when every
//     state was ready and stable;
//   * the first pass of a cold state builds something and the pass count is not fixed: a state is stable once a whole pass built nothing,
//     so a second call on the same state is one pass;
//   * a state with no draw, or a draw that throws, is reported with its error and `complete` false;
//   * no states is complete.
import { createFakeGl, taggedShaderSources } from './_fakeGl.mjs';
import { createRenderer } from '../src/renderer/renderer.js';
import { createBundle } from '../src/renderer/bundle.js';
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
const { default: importSvg } = await import('../src/svg/importer.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const { gl: baseGl } = createFakeGl();
// Override through an outer proxy: the fake GL's get trap ignores assigned methods.
let fenceStatus;
const gl = new Proxy(baseGl, {
  get(target, key) {
    if (key === 'fenceSync') return () => ({});
    if (key === 'clientWaitSync') return () => fenceStatus;
    if (key === 'deleteSync') return () => {};
    return Reflect.get(target, key);
  },
});
fenceStatus = gl.CONDITION_SATISFIED;
const R = createRenderer(gl, taggedShaderSources(), { cpatchFill: false, psoWarmIdle: () => true });
ok(typeof R.warmScene === 'function', 'renderer.warmScene is public');
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#c00" d="M10 10 L90 10 L90 90 L10 90 Z"/><path fill="#00c" fill-opacity="0.5" d="M20 20 L60 20 L40 70 Z"/></svg>';
const bundle = createBundle(gl, await importSvg(svg));
const draw = () => {
  R.beginFrame([0, 0, 0, 0]);
  R.drawBundle(bundle, {});
  R.endFrame();
};
const empty = await R.warmScene([]);
ok(empty.complete === true && empty.states.length === 0, 'no states is complete');
const rep = await R.warmScene([{ name: 'plain', bundle, engine: 'slug', draw }], { maxPasses: 6 });
const s = rep.states[0];
ok(
  rep.states.length === 1 && s.name === 'plain' && s.ready === true && s.error === null,
  'one state reported, ready, no error',
);
ok(
  s.stable === true && s.passes >= 1 && s.passes <= 6,
  `the state reaches stable (${s.passes} pass(es), ${s.programsCreated} program(s) created, ${s.variantsAdded} variant(s) added)`,
);
ok(rep.complete === true, 'the scene is complete');
const again = await R.warmScene([{ name: 'plain', bundle, engine: 'slug', draw }]);
ok(
  again.states[0].stable === true &&
    again.states[0].passes === 1 &&
    again.states[0].programsCreated === 0,
  'a second call on the warmed state is one pass and builds nothing',
);
const bad = await R.warmScene([
  { name: 'nodraw' },
  {
    name: 'throws',
    draw: () => {
      throw new Error('boom');
    },
  },
  { name: 'fine', draw },
]);
ok(
  bad.states[0].error && /no draw/.test(bad.states[0].error),
  'a state with no draw() reports its error',
);
ok(
  bad.states[1].error === 'boom' && bad.states[1].stable === false,
  'a throwing draw is reported, not thrown',
);
ok(
  bad.states[2].error === null && bad.states[2].stable === true,
  'the states after a failed one are still warmed',
);
ok(bad.complete === false, 'complete is false while any state failed');
// A stable shader signature does not imply submitted GPU work completed.
// Exercise both explicit driver failure and a fence that never signals.
for (const [name, status] of [
  ['failed', gl.WAIT_FAILED],
  ['timeout', gl.TIMEOUT_EXPIRED],
]) {
  fenceStatus = status;
  const result = await R.warmScene([{ name, draw }], { fenceTimeoutMs: 0 });
  ok(
    result.states[0].stable === true && result.states[0].fenced === false,
    `${name}: stable programs retain failed fence report`,
  );
  ok(result.complete === false, `${name}: unfinished GPU work cannot complete the scene`);
}
fenceStatus = gl.CONDITION_SATISFIED;
// A deliberately blocked loading budget cannot report a queued pipeline as warm.
{
  const F = createFakeGl({ width: 64, height: 64 });
  const immediateFenceGl = new Proxy(F.gl, {
    get(target, key) {
      if (key === 'fenceSync') return () => ({});
      if (key === 'clientWaitSync') return () => target.CONDITION_SATISFIED;
      if (key === 'deleteSync') return () => {};
      return Reflect.get(target, key);
    },
  });
  const r = createRenderer(immediateFenceGl, taggedShaderSources(), {
    aacPoints: false,
    psoWarmIdle: () => false,
    precompileFillsBudgetMs: 0,
    psoWarmMaxWaitFrames: 0,
  });
  r.setFillEngine({ route: 'none', kernel: 'slug' });
  r.setViewport(64, 64);
  const b = createBundle(F.gl, await importSvg(svg));
  const result = await r.warmScene(
    [
      {
        draw: () => {
          r.beginFrame([0, 0, 0, 0]);
          r.drawBundle(b);
          r.endFrame();
        },
      },
    ],
    { maxPasses: 2 },
  );
  ok(
    !result.complete && !result.states[0].stable,
    'a queued pipeline prevents completion when its warm budget is blocked',
  );
  b.dispose();
  r.dispose();
}
// Three-vertex covers must warm their real layout without requesting six vertices.
{
  const b = createBundle(
    gl,
    await importSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M10 10L90 10L50 90Z"/></svg>',
    ),
  );
  const r = createRenderer(gl, taggedShaderSources(), {
    aacPoints: false,
    psoWarmIdle: () => false,
  });
  r.setViewport(128, 128);
  r.setFillEngine({ route: 'none', kernel: 'slug' });
  const result = await r.warmScene(
    [
      {
        draw: () => {
          r.beginFrame([0, 0, 0, 0]);
          r.drawBundle(b);
          r.endFrame();
        },
      },
    ],
    { maxPasses: 6 },
  );
  ok(b.coverQuadVboFloats.length === 36, 'the control has exactly one three-vertex cover');
  ok(result.complete, 'a triangle cover completes explicit loading warmup');
  b.dispose();
  r.dispose();
}
// An internal warm failure restores caller state and does not block the next state.
for (const callerRect of [null, [8, 9, 20, 21]]) {
  const F = createFakeGl({ width: 64, height: 64 });
  let rejectWarmDraw = false,
    rejected = 0;
  const faultGl = new Proxy(F.gl, {
    get(target, key) {
      if (key === 'fenceSync') return () => ({});
      if (key === 'clientWaitSync') return () => target.CONDITION_SATISFIED;
      if (key === 'deleteSync') return () => {};
      if (key === 'drawArrays')
        return (...args) => {
          if (rejectWarmDraw) {
            rejectWarmDraw = false;
            rejected++;
            throw new Error('pipeline draw rejected');
          }
          return target.drawArrays(...args);
        };
      return Reflect.get(target, key);
    },
  });
  const r = createRenderer(faultGl, taggedShaderSources(), {
    aacPoints: false,
    psoWarmIdle: () => false,
  });
  r.setViewport(64, 64);
  r.setFillEngine({ route: 'none', kernel: 'slug' });
  const b = createBundle(faultGl, await importSvg(svg));
  if (callerRect) r.setScissorRect(...callerRect);
  else r.clearScissorRect();
  const nextScissors = [];
  rejectWarmDraw = true;
  const result = await r.warmScene(
    [
      { name: 'failed-internal-pipeline', draw() {} },
      {
        name: 'next-state',
        draw() {
          nextScissors.push(F.scissorNow());
          F.setFrame('after-warm-failure');
          faultGl.drawArrays(faultGl.TRIANGLES, 0, 3);
        },
      },
    ],
    { maxPasses: 4 },
  );
  const label = callerRect ? 'caller rect' : 'no caller rect';
  ok(
    rejected === 1 && result.states[0].error === 'pipeline draw rejected',
    `${label}: one real internal warm fails`,
  );
  ok(
    nextScissors.length > 0 &&
      nextScissors.every((sc) => JSON.stringify(sc) === JSON.stringify(callerRect)),
    `${label}: every following draw sees the restored caller scissor (${JSON.stringify(nextScissors)})`,
  );
  ok(
    F.log.some(
      (e) =>
        e.frame === 'after-warm-failure' &&
        e.op === 'draw' &&
        JSON.stringify(e.sc) === JSON.stringify(callerRect),
    ),
    `${label}: the following native draw uses the caller scissor`,
  );
  ok(
    result.states[1].stable && result.states[1].fenced && !result.states[1].error,
    `${label}: the next state drains the failed warm and completes`,
  );
  ok(!result.complete, `${label}: the original failed state remains reported`);
  b.dispose();
  r.dispose();
}
// Program accounting follows all library factories in a context generation.
// These are production allocation/control-flow checks, without shader execution.
{
  const { createTrackedProgram, contextProgramsCreated, resourceGeneration, deleteGlResource } =
    await import('../src/renderer/contextResources.js');
  const F = createFakeGl({ width: 512, height: 512 });
  let created = 0,
    pointDraws = 0;
  const g = new Proxy(F.gl, {
    get(target, key) {
      if (key === 'createProgram')
        return () => {
          created++;
          return target.createProgram();
        };
      if (key === 'drawArraysInstanced')
        return (...args) => {
          if (args[0] === target.POINTS) pointDraws++;
          return target.drawArraysInstanced(...args);
        };
      if (key === 'fenceSync') return () => ({});
      if (key === 'clientWaitSync') return () => target.CONDITION_SATISFIED;
      if (key === 'deleteSync') return () => {};
      return Reflect.get(target, key);
    },
  });
  const r = createRenderer(g, taggedShaderSources(), {
    aacFill: true,
    aacPoints: true,
    aacPointsMaxPx: 4,
    psoWarmIdle: () => false,
  });
  r.setFillEngine({ route: 'none', kernel: 'aac' });
  const body = Array.from(
    { length: 12 },
    (_, i) =>
      `<path fill="#2469ae" fill-opacity=".65" d="M${120 + i * 40} 320q8 -12 16 0q-8 12-16 0Z"/>`,
  ).join('');
  const b = createBundle(
    g,
    await importSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">' + body + '</svg>',
      { preserveViewport: true },
    ),
  );
  const paint = (n) => {
    r.setViewport(n, n);
    r.beginFrame([0, 0, 0, 0]);
    r.drawBundle(b);
    r.endFrame();
  };
  const cover = await r.warmScene([{ name: 'cover first', draw: () => paint(512) }], {
    maxPasses: 16,
  });
  ok(
    cover.complete && pointDraws === 0,
    'large-viewport warm creates cover programs without the point helper',
  );
  const before = created,
    result = await r.warmScene([{ name: 'cold point helper', draw: () => paint(128) }], {
      maxPasses: 16,
    }),
    delta = created - before;
  ok(
    delta > 0 && result.states[0].programsCreated === delta,
    'point-helper creations match the actual allocation recorder',
  );
  ok(
    result.complete && result.states[0].passes >= 2 && pointDraws >= 2,
    'a pass creating a point helper is followed by a pass creating nothing',
  );
  const repeated = await r.warmScene([{ draw: () => paint(128) }]);
  ok(
    repeated.complete &&
      repeated.states[0].passes === 1 &&
      repeated.states[0].programsCreated === 0,
    'repeated point warming creates no program and completes in one pass',
  );
  // Record an allocation made by an asynchronous readiness dependency after
  // the real engine readiness check, before the first draw/warm pass.
  const awaitReady = r.awaitEngine;
  let readinessProgram = null;
  r.awaitEngine = async (...args) => {
    const ready = await awaitReady.apply(r, args);
    readinessProgram = createTrackedProgram(g);
    return ready;
  };
  const readyBefore = created,
    readyReport = await r.warmScene([{ bundle: b, engine: 'aac', draw: () => paint(128) }]);
  r.awaitEngine = awaitReady;
  ok(
    readyReport.complete &&
      readyReport.states[0].programsCreated === created - readyBefore &&
      created - readyBefore === 1,
    'state program counts include creations during asynchronous engine readiness',
  );
  deleteGlResource(g, 'Program', readinessProgram);
  const legacy = r.getMemoryStats().programs.created,
    contextBefore = contextProgramsCreated(g),
    nativeBefore = created;
  const other = createRenderer(g, taggedShaderSources(), { cpatchFill: false });
  ok(
    contextProgramsCreated(g) - contextBefore === created - nativeBefore && created > nativeBefore,
    'another renderer contributes to the same context count',
  );
  ok(
    r.getMemoryStats().programs.created === legacy,
    'another renderer does not change the existing renderer-local memory-stat counter',
  );
  other.dispose();
  const countBeforeLoss = contextProgramsCreated(g),
    generation = resourceGeneration(g);
  const lost = await r.warmScene([{ draw: () => F.loseContext() }]);
  ok(
    !lost.complete && /context changed/.test(lost.states[0].error || ''),
    'a context-generation change fails warming instead of subtracting counters across generations',
  );
  ok(
    resourceGeneration(g) === generation + 1 &&
      contextProgramsCreated(g) === 0 &&
      countBeforeLoss > 0,
    'context loss starts a new program-count generation',
  );
  b.dispose();
  r.dispose();
  const independent = createFakeGl(),
    p = createTrackedProgram(independent.gl);
  ok(
    contextProgramsCreated(independent.gl) === 1 && contextProgramsCreated(g) === 0,
    'program counts are independent between contexts',
  );
  deleteGlResource(independent.gl, 'Program', p);
  ok(
    contextProgramsCreated(independent.gl) === 1,
    'deletion does not reduce the generation creation count',
  );
  const nullGl = new Proxy(createFakeGl().gl, {
    get(target, key) {
      return key === 'createProgram' ? () => null : Reflect.get(target, key);
    },
  });
  ok(
    createTrackedProgram(nullGl) === null && contextProgramsCreated(nullGl) === 0,
    'failed native creation does not increment the context count',
  );
}
// Loading builds the universal cover once; a failed draw must remain retryable.
{
  const F = createFakeGl({ width: 512, height: 512 }),
    KHR = { COMPLETION_STATUS_KHR: 0x91b1 };
  const sources = new WeakMap();
  let base = null,
    current = null,
    baseDraws = 0,
    failBase = false,
    hold = false,
    forcedLinks = 0;
  const G = new Proxy(F.gl, {
    get(t, k) {
      if (k === 'getExtension')
        return (n) => (n === 'KHR_parallel_shader_compile' ? KHR : t.getExtension(n));
      if (k === 'shaderSource')
        return (s, text) => {
          sources.set(s, text);
          return t.shaderSource(s, text);
        };
      if (k === 'attachShader')
        return (p, s) => {
          const text = sources.get(s) || '';
          if (text.includes('@@fillVert') && !/\bMANTLE_(?:NO_|INSTANCED|AAC|LB_FILL)/.test(text))
            base = p;
          return t.attachShader(p, s);
        };
      if (k === 'useProgram')
        return (p) => {
          current = p;
          return t.useProgram(p);
        };
      if (k === 'getProgramParameter')
        return (p, e) => {
          if (e === KHR.COMPLETION_STATUS_KHR) return !hold;
          if (hold && e === t.LINK_STATUS && new Error().stack.includes('_promote')) forcedLinks++;
          return t.getProgramParameter(p, e);
        };
      if (k === 'drawArrays')
        return (...args) => {
          if (current === base) {
            if (failBase) throw Error('base warm held');
            baseDraws++;
          }
          return t.drawArrays(...args);
        };
      return t[k];
    },
  });
  const r = createRenderer(G, taggedShaderSources(), {
    aacPoints: false,
    psoWarmIdle: () => false,
    loadingBaseWarm: true,
  });
  r.setViewport(512, 512);
  r.setFillEngine({ route: 'none', kernel: 'slug' });
  const b = createBundle(G, await importSvg(svg));
  r.precompileFills({ draw: false });
  ok(base !== null && baseDraws === 0, 'link-only loading does not issue a universal-cover draw');
  const paint = (target) => {
    r.beginFrame([0, 0, 0, 0]);
    r.drawBundle(target);
    r.endFrame();
  };
  paint(b);
  failBase = true;
  let error = null;
  try {
    r.precompileFills();
  } catch (ex) {
    error = ex;
  }
  ok(
    error?.message === 'base warm held' && baseDraws === 0,
    'a failed base warm receives no successful draw credit',
  );
  failBase = false;
  r.precompileFills();
  r.precompileFills();
  ok(baseDraws === 1, 'loading retries the failed base once and does not repeat a successful warm');
  const other = createBundle(
    G,
    await importSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M10 10C25 5 75 15 90 90L10 90Z"/></svg>',
    ),
  );
  hold = true;
  paint(other);
  ok(forcedLinks === 0, 'an ordinary pending specialization uses the successfully warmed base');
  hold = false;
  other.dispose();
  b.dispose();
  r.dispose();
}

if (fail) {
  console.error(`FAIL warmSceneSmoke: ${fail}`);
  process.exit(1);
}
console.log('warmSceneSmoke PASS');
