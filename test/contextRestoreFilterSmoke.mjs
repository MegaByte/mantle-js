// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// contextRestoreFilterSmoke — after a context restore no draw reaches a render target of the LOST
// context.
//
// On webglcontextrestored the renderer forgets every GL handle it caches for offscreen work
// (_forgetTransientGpuState) so the next frame rebuilds them against the live context: shapeFbo,
// the ping FBO, the canvas copies, the RT pools, the mask bake, the clip state. The same holds for
// `_shapeRtCache` and `_pingRtCache` -- the rect-sized source targets of a filtered shape, their
// kernels' scratch, and every nested group's accumulator -- and for the filter result cache, whose
// textures and FBOs are just as dead and whose key has no term that a restore moves. Missing any of
// them, the first frames after a restore render filtered shapes and nested groups into objects of the
// lost context, and a cache hit composites one.
// (A real restored context rejects such an object with INVALID_OPERATION: the draw is dropped.)
//
// HOW: the real renderer, headless, against test/_fakeGl.mjs, whose canvas fires context
// events: loseContext / restoreContext fire them, and every object created before the restore is
// DEAD (isDead). Three frames populate the caches (the static ones hit), then the context is lost
// and restored, and three more frames are drawn. In those, asserted per frame on both routes:
//   no clear or draw targets a dead framebuffer, no blit reads or writes one, no copy writes a dead
//   texture, and no draw samples a dead RENDER TARGET (a texture that was a color attachment) on a
//   unit a program reads (not unit 11, the scratch unit nothing samples).
// The renderer does not survive a restore: after webglcontextrestored it stays lost, its draw entries throw
// "dispose and recreate", and (this smoke) nothing at all reaches the GL: no clear, draw, blit or copy, so nothing can
// reach a render target of the lost context either. The per-target assertions below hold as the weaker form of that
// "nothing at all" rule. The recreate path is test/lifecycleContractSmoke.mjs.
//
// Programs, vertex buffers and the bundle's own data textures are dead too, and the renderer does
// not rebuild those -- a genuinely lost context needs the consumer to recreate it (see
// _onContextRestored) -- so they are not what this checks.
import { createFakeGl, taggedShaderSources } from './_fakeGl.mjs';

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { importSvg, createBundle, createRenderer } = await import('../src/index.js');

const N = 120;
const REGION = 'x="-100%" y="-100%" width="300%" height="300%"';
const DEFS =
  `<filter id="b" ${REGION}><feGaussianBlur stdDeviation="1.5"/></filter>` +
  `<filter id="g" ${REGION}><feMorphology operator="dilate" radius="1"/><feGaussianBlur stdDeviation="1.5"/></filter>`;
const svg = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${N}" height="${N}" viewBox="0 0 ${N} ${N}">` +
  `<defs>${DEFS}</defs>${body}</svg>`;
const RED = '<rect x="10" y="10" width="60" height="100" fill="#f00"/>';
const LATE = '<rect x="88" y="88" width="24" height="24" fill="#0a0"/>';
const circle = (attr = '') => `<circle cx="80" cy="60" r="18" fill="#00f" ${attr}/>`;
const CASES = [
  // The rect-sized single-kind target and its ping (acquireShapeRT / acquirePingRT by rect), and a
  // cached result.
  { name: 'a blurred shape', body: RED + circle('filter="url(#b)"') },
  // A cached graph result.
  { name: 'a graph-filtered shape', body: RED + circle('filter="url(#g)"') },
  // A nested group's accumulator (the 'group1:' slot), and the in-group filter's canvas-sized
  // source target and ping.
  {
    name: 'a blurred child in nested groups',
    body: `<g opacity="0.5">${RED}<g opacity="0.5">${circle('filter="url(#b)"')}</g>${LATE}</g>`,
  },
];
const FRAMES = 3;

async function run(body, route) {
  const F = createFakeGl({ width: N, height: N });
  const R = createRenderer(F.gl, taggedShaderSources(), {});
  R.setFillEngine({ route, kernel: 'slug' });
  const b = createBundle(F.gl, await importSvg(svg(body), { preserveViewport: true }));
  if (R.prepareBundle) R.prepareBundle(b);
  if (R.awaitLbReady) {
    try {
      await R.awaitLbReady(b, 20000);
    } catch {
      /* reported below */
    }
  }
  R.prewarmBundle(b);
  R.precompileFills();
  R.setViewport(N, N);
  const frame = (i) => {
    F.setFrame(i);
    R.beginFrame([0, 0, 0, 0]);
    R.drawBundle(b);
    R.endFrame();
  };
  for (let i = 0; i < FRAMES; i++) frame(i);
  const pre = Object.assign({}, R.debugStats);
  const prevented = F.loseContext();
  frame('lost'); // drawn while lost: the renderer must skip it
  F.restoreContext();
  const thrown = [];
  for (let i = 0; i < FRAMES; i++) {
    try {
      frame(100 + i);
      thrown.push(null);
    } catch (e) {
      thrown.push(e.message);
    }
  }
  return { F, prevented, pre, post: R.debugStats, thrown };
}

for (const c of CASES) {
  console.log(`\n  ${c.name}:`);
  for (const route of ['none', 'lb']) {
    const { F, prevented, pre, post, thrown } = await run(c.body, route);
    ok(
      thrown.every((m) => m && /dispose/.test(m)),
      `route ${route}: every frame after the restore throws the dispose-and-recreate error (${thrown.map((m) => (m ? 'throw' : 'ok')).join()})`,
    );
    ok(
      prevented,
      `route ${route}: the renderer took the loss (preventDefault) so the context can be restored`,
    );
    const lostEv = F.log.filter((e) => e.frame === 'lost' && (e.op === 'draw' || e.op === 'clear'));
    ok(
      lostEv.length === 0,
      `route ${route}: nothing is drawn while the context is lost (${lostEv.length} clears/draws)`,
    );
    if (route === 'lb') {
      ok(
        (pre.unifiedFillDraws | 0) > 0,
        `route lb is the unified route (unified draws ${pre.unifiedFillDraws | 0}, gate ${pre.unifiedFillGate})`,
      );
    }
    const deadRT = (t) => F.isDead(t) && F.fboOf(t) !== null;
    const bad = [];
    for (let i = 0; i < FRAMES; i++) {
      const ev = F.log.filter((e) => e.frame === 100 + i);
      const n = { target: 0, blit: 0, copy: 0, sample: 0 };
      for (const e of ev) {
        if ((e.op === 'draw' || e.op === 'clear') && F.isDead(e.fbo)) n.target++;
        if (e.op === 'blit' && (F.isDead(e.src) || F.isDead(e.dst))) n.blit++;
        if (e.op === 'copy' && F.isDead(e.dst)) n.copy++;
        // Unit 11 is the SCRATCH unit (fillPass SCRATCH_UNIT): allocations and snapshots bind there
        // and no program samples it, so a stale binding on it is not a read.
        if (e.op === 'draw' && e.units.some((t, u) => u !== 11 && t && deadRT(t))) n.sample++;
      }
      const parts = Object.entries(n)
        .filter(([, v]) => v > 0)
        .map(([k, v]) => `${v} ${k}`);
      if (parts.length) bad.push(`frame ${i + 1} after restore: ${parts.join(', ')}`);
      if (ev.length)
        bad.push(
          `frame ${i + 1} after restore: ${ev.length} GL events (${ev.map((e) => e.op).join()}) from a renderer that cannot draw`,
        );
    }
    ok(
      !bad.length,
      `route ${route}: after the restore nothing reaches a render target of the lost context` +
        (bad.length ? ' -- ' + bad.join(' | ') : ''),
    );
  }
}

console.log(fail ? `\nFAIL (${fail})` : '\nPASS');
process.exit(fail ? 1 : 0);
