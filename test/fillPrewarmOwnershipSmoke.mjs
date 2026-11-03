// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// fillPrewarmOwnershipSmoke — creation-time fill prewarm belongs to a RENDERER, not to a context.
//
// createBundle enqueues each new bundle for fill-program warm-up, and every renderer drains that
// queue from its own fillWarmTick. But a fill VARIANT is renderer-owned state — each renderer
// compiles and caches its own lean programs. With one queue per WebGL CONTEXT whose draining
// POPS, two renderers on one canvas go wrong three ways:
//
//   whichever warm tick runs first takes every bundle, and the other renderer draws all of them on
//   the universal all-feature program for the life of the page. Nothing else queues a static
//   cover-quad bundle, so there is no second chance;
//
//   a renderer created SECOND, with a peer already draining the queue each frame, never warms a
//   single bundle in its life;
//
//   and precompileFills() drains the same queue to empty, so one renderer's load-screen precompile
//   silently empties the other's.
//
// Two renderers on one context is not exotic: it is the demo's engine switcher, it is the
// four-engine comparison harness, it is several tests per file, and it is any app with two canvases
// sharing a context. So each renderer takes its own consumer queue and an enqueue is a broadcast;
// the per-context backlog is what a renderer created after its content starts from.
//
// Driven from Node against a stub GL — attachFillPass and fillWarmTick both run headless, so this
// pins the real wiring rather than the registry alone.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const B = await import('../src/renderer/bundle.js');
const { attachFillPass } = await import('../src/renderer/fillPass.js');

const SVG =
  '<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">' +
  '<path fill="#000" d="M150 40 C70 20 30 70 30 100 C30 130 70 180 150 160 Z"/></svg>';
const sections = await importSvg(SVG, { preserveViewport: true });

const makeGl = () =>
  new Proxy(
    {},
    { get: (_t, k) => (typeof k === 'string' && /^[A-Z_0-9]+$/.test(k) ? 0 : () => null) },
  );

// A renderer just complete enough for attachFillPass + fillWarmTick. R.program is the observable:
// prewarmFillVariant compiles each bundle's lean variant through it, tagged 'fill:prewarm:<key>',
// so the tag list says which renderer was actually handed which bundle.
function makeRenderer(gl) {
  const warmed = [];
  const R = {
    gl,
    opts: {},
    draw: {},
    _lbFillMode: 'auto',
    _warmed: warmed,
    viewportSize: [0, 0],
    arScale: 1,
    dummyDashTex: null,
    dummyGradientTex: null,
    dummyGradientStops: null,
    IDENTITY_COLOR_MATRIX: new Float32Array(16),
    ZERO_OFFSET: new Float32Array(4),
    fillProg: {},
    shaderSources: { fillVert: '', fillFrag: '' },
    withDefines: (s) => s,
    program: (_v, _f, tag) => {
      warmed.push(tag);
      return {};
    },
    glEnable: () => {},
    glDisable: () => {},
    bindFb: () => {},
    glBindVertexArray: () => {},
    glViewport: () => {},
    glBlendFunc: () => {},
    mantleError: () => {},
    mantleWarn: () => {},
  };
  attachFillPass(R);
  warmed.length = 0; // ignore whatever attach itself compiled
  return R;
}
const prewarms = (R) => R._warmed.filter((t) => t && t.startsWith('fill:prewarm:')).length;

// ─── 1. two renderers on one canvas ─────────────────────────────────────────
console.log('\n  one canvas, two renderers:');
{
  const gl = makeGl();
  const R1 = makeRenderer(gl),
    R2 = makeRenderer(gl);
  B.createBundle(gl, sections);
  R1.fillWarmTick();
  R2.fillWarmTick();
  ok(prewarms(R1) > 0, 'the first renderer warms the new bundle');
  ok(prewarms(R2) > 0, '...and so does the second, which is the one that may be drawing it');
}
{
  // The same, with the first renderer draining to empty before the second ever ticks — the
  // steady-state case, since a renderer created first starts its frame loop first.
  const gl = makeGl();
  const R1 = makeRenderer(gl);
  B.createBundle(gl, sections);
  for (let i = 0; i < 4; i++) R1.fillWarmTick();
  const R2 = makeRenderer(gl);
  R2.fillWarmTick();
  ok(prewarms(R2) > 0, 'a renderer created after the bundles still warms them');
}
{
  const glA = makeGl(),
    glB = makeGl();
  const RA = makeRenderer(glA),
    RB = makeRenderer(glB);
  B.createBundle(glA, sections);
  RA.fillWarmTick();
  RB.fillWarmTick();
  ok(
    prewarms(RA) > 0 && prewarms(RB) === 0,
    "a renderer on another canvas is not handed canvas A's bundles",
  );
}
{
  const gl = makeGl();
  const R1 = makeRenderer(gl),
    R2 = makeRenderer(gl);
  R2._disposeFillVariants(); // what renderer.dispose() calls
  B.createBundle(gl, sections);
  R1.fillWarmTick();
  R2.fillWarmTick();
  ok(prewarms(R1) > 0 && prewarms(R2) === 0, 'a disposed renderer stops being handed new bundles');
}

// ─── 2. the queue itself, where the single-renderer contract lives ──────────
// Each renderer's queue must behave exactly as the one shared queue did: newest first (the newest
// bundle is the one about to be drawn), disposed bundles skipped, empty answers null.
console.log('\n  queue contract:');
{
  const gl = makeGl();
  const c = B.addFillPrewarmConsumer(gl);
  const b1 = { tag: 'b1' },
    b2 = { tag: 'b2' },
    b3 = { tag: 'b3' };
  B.enqueueFillPrewarm(gl, b1);
  B.enqueueFillPrewarm(gl, b2);
  B.enqueueFillPrewarm(gl, b3);
  const order = [B.takeFillPrewarm(c), B.takeFillPrewarm(c), B.takeFillPrewarm(c)].map(
    (b) => b && b.tag,
  );
  ok(order.join(',') === 'b3,b2,b1', `drains newest first (${order.join(',')})`);
  ok(B.takeFillPrewarm(c) === null, 'an empty queue answers null');
  B.removeFillPrewarmConsumer(c);
}
{
  const gl = makeGl();
  const c = B.addFillPrewarmConsumer(gl);
  const dead = { tag: 'dead', _disposed: true },
    live = { tag: 'live' };
  B.enqueueFillPrewarm(gl, live);
  B.enqueueFillPrewarm(gl, dead);
  const got = B.takeFillPrewarm(c);
  ok(got === live && B.takeFillPrewarm(c) === null, 'a disposed bundle is skipped, not returned');
  B.removeFillPrewarmConsumer(c);
}
{
  // Draining one renderer's queue must not drain another's, and a consumer seeded from the backlog
  // must not be seeded with bundles that have since been disposed.
  const gl = makeGl();
  const c1 = B.addFillPrewarmConsumer(gl);
  const b = { tag: 'shared' };
  B.enqueueFillPrewarm(gl, b);
  const c2 = B.addFillPrewarmConsumer(gl);
  ok(
    B.takeFillPrewarm(c1) === b && B.takeFillPrewarm(c2) === b,
    'both renderers receive the same bundle',
  );
  b._disposed = true;
  const c3 = B.addFillPrewarmConsumer(gl);
  ok(
    B.takeFillPrewarm(c3) === null,
    'a renderer created later is not seeded with disposed bundles',
  );
  B.removeFillPrewarmConsumer(c1);
  B.removeFillPrewarmConsumer(c2);
  B.removeFillPrewarmConsumer(c3);
}
{
  // The backlog is the one list that outlives a drain, so it is the one that could grow without
  // bound. It is pruned of disposed bundles and capped; a fresh consumer proves both.
  const gl = makeGl();
  const c0 = B.addFillPrewarmConsumer(gl);
  // LIVE bundles: pruning cannot help, so this is the cap itself doing the work.
  for (let i = 0; i < 20000; i++) B.enqueueFillPrewarm(gl, { tag: 'b' + i });
  const last = { tag: 'newest' };
  B.enqueueFillPrewarm(gl, last);
  const c = B.addFillPrewarmConsumer(gl);
  ok(c.q.length <= 4096, `the backlog stays bounded (${c.q.length} seeded from 20001 enqueues)`);
  ok(B.takeFillPrewarm(c) === last, 'and overflow drops the oldest, never the newest');
  B.removeFillPrewarmConsumer(c0);
  B.removeFillPrewarmConsumer(c);
}

// ─── 3. the signature is the guard ──────────────────────────────────────────
// takeFillPrewarm(gl) answers null rather than throwing, so a call site that kept passing the
// context would look like "nothing to warm" forever — the quietest possible form of this defect.
console.log('');
{
  const code = readFileSync(path.join(ROOT, 'src/renderer/fillPass.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
  ok(
    !/\btakeFillPrewarm\(\s*gl\s*\)/.test(code),
    'fillPass drains its own consumer, never the raw context',
  );
  ok(
    /\baddFillPrewarmConsumer\(\s*gl\s*\)/.test(code) && /\bremoveFillPrewarmConsumer\(/.test(code),
    'fillPass takes a consumer at attach and hands it back on dispose',
  );
}

console.log(fail ? `\nFILL-PREWARM-OWNERSHIP FAIL (${fail})` : '\nFILL-PREWARM-OWNERSHIP PASS');
process.exit(fail ? 1 : 0);
