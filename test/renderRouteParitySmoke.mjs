// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// renderRouteParitySmoke — render() makes drawBundle's engine choice.
//
// If the public render() went straight to the Slug fill pass -- the fallback drawBundle takes when the analytic route
// declines -- a setBundle + render() app would never draw Loop-Blinn, CPatch, the SDF primitives or the AAC points route,
// whatever setFillEngine says, and the draw tally would show only Slug and stroke draws.
//
// Headless, against the recording fake GL, 60 fps fake clock. For each route (setFillEngine 'lb', 'auto', 'none') the
// same bundle is drawn by a renderer through setBundle + render() and by another through beginFrame / drawBundle /
// endFrame, the Loop-Blinn build awaited, then warm frames and counted frames. Asserted, per route:
//   * the engine ledger (debugStats.engines.draws) counts the same draws per engine over the counted frames;
//   * every counted frame issues the same draws -- vertex count, fill program (#defines), framebuffer, textures per
//     unit (by role: object ids numbered in order of first use, as the two contexts allocate differently), scissor --
//     in the same order, through both entries;
//   * one color clear a frame through both (render() still clears the canvas itself; beginFrame does for the other);
//   * with 'lb' pinned the LB engine drew.
//
// A render() that skips the route counts Slug where drawBundle counts LB on the 'lb' and 'auto' routes, and draws 3
// passes a frame where drawBundle draws 1.
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
const { createFakeGl, taggedShaderSources } = await import('./_fakeGl.mjs');
const { importSvg, createBundle, createRenderer } = await import('../src/index.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <path d="M 10 50 Q 10 10 50 10 Q 90 10 90 50 Q 90 90 50 90 Q 10 90 10 50 Z" fill="#3a6ea5"/>
  <path d="M 30 50 C 30 20 70 20 70 50 C 70 80 30 80 30 50 Z" fill="#f5b433" fill-opacity="0.6"/>
  <path d="M 20 20 L 80 30 L 60 80 Z" fill="none" stroke="#222" stroke-width="3"/>
</svg>`;
const sections = await importSvg(svg);
const WARM = 90,
  FRAMES = 12;
const realNow = performance.now.bind(performance);

async function run(route, entry) {
  const F = createFakeGl({ width: 400, height: 400 });
  const EXT = {
    KHR_parallel_shader_compile: { COMPLETION_STATUS_KHR: 0x91b1 },
    EXT_color_buffer_float: {},
  };
  const src = new Map(),
    shaders = new Map();
  const gl = new Proxy(
    {},
    {
      get: (_t, k) => {
        if (k === 'getExtension') return (n) => EXT[n] || null;
        if (k === 'shaderSource')
          return (sh, s) => {
            src.set(sh, s);
            return F.gl.shaderSource(sh, s);
          };
        if (k === 'attachShader')
          return (p, sh) => {
            if (!shaders.has(p)) shaders.set(p, []);
            shaders.get(p).push(sh);
            return F.gl.attachShader(p, sh);
          };
        return F.gl[k];
      },
    },
  );
  const r = createRenderer(gl, taggedShaderSources(), { staticUnified: true }); // staticUnified: the smoke is about the unified/Loop-Blinn meshes of a static bundle (fillRouteClass.js)
  r.setFillEngine({ route });
  const b = createBundle(gl, sections);
  r.setBundle(b);
  const frame =
    entry === 'render'
      ? () => r.render()
      : () => {
          r.beginFrame();
          r.drawBundle(b);
          r.endFrame();
        };
  let clock = 1000,
    f = 0;
  performance.now = () => (clock += 0.001);
  const step = () => {
    F.setFrame(f++);
    clock += 16.7;
    frame();
  };
  step();
  performance.now = realNow;
  if (route !== 'none') await r.awaitLbReady(b, 30000);
  performance.now = () => (clock += 0.001);
  for (let i = 0; i < WARM; i++) {
    step();
    if (i % 8 === 0) await new Promise((res) => setTimeout(res, 0));
  }
  const before = Object.assign({}, (r.debugStats.engines || {}).draws || {});
  const f0 = f;
  for (let i = 0; i < FRAMES; i++) step();
  performance.now = realNow;
  const after = (r.debugStats.engines || {}).draws || {};
  const delta = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const d = (after[k] | 0) - (before[k] | 0);
    if (d) delta[k] = d;
  }
  const defs = (p) =>
    (shaders.get(p) || [])
      .map((sh) =>
        [...(src.get(sh) || '').matchAll(/^#define (MANTLE_\w+)/gm)]
          .map((m) => m[1])
          .sort()
          .join('|'),
      )
      .join(' / ');
  const frames = [];
  let clears = 0;
  const role = new Map();
  const roleOf = (o) => {
    if (!o) return null;
    if (!role.has(o)) role.set(o, role.size);
    return role.get(o);
  };
  for (let fr = f0; fr < f; fr++) {
    const ev = F.log.filter((e) => e.frame === fr);
    clears += ev.filter((e) => e.op === 'clear' && e.mask & 0x4000).length;
    frames.push(
      JSON.stringify(
        ev
          .filter((e) => e.op === 'draw')
          .map((e) => [
            e.count,
            [...F.progKeys(e.prog)].sort().join('+'),
            defs(e.prog),
            roleOf(e.fbo),
            (e.units || []).map(roleOf),
            e.sc,
          ]),
      ),
    );
  }
  return { delta, frames, clears };
}

for (const route of ['lb', 'auto', 'none']) {
  const a = await run(route, 'render'),
    b = await run(route, 'frame');
  const same = a.frames.length === b.frames.length && a.frames.every((x, i) => x === b.frames[i]);
  ok(
    JSON.stringify(a.delta) === JSON.stringify(b.delta),
    `route ${route}: render() counts ${JSON.stringify(a.delta)}, beginFrame/drawBundle/endFrame ${JSON.stringify(b.delta)}`,
  );
  ok(
    same,
    `route ${route}: every counted frame issues the same draws, program and state included, through both` +
      (same
        ? ''
        : `\n     render ${a.frames[0].slice(0, 600)}\n     frame  ${b.frames[0].slice(0, 600)}`),
  );
  ok(
    a.clears === FRAMES && b.clears === FRAMES,
    `route ${route}: one color clear a frame through both (${a.clears}, ${b.clears} over ${FRAMES})`,
  );
  if (route === 'lb')
    ok(
      (a.delta.lb | 0) > 0,
      `route lb: render() draws with the LB engine (${a.delta.lb | 0} draws)`,
    );
}

if (fail) {
  console.log(`FAIL renderRouteParitySmoke: ${fail} check(s)`);
  process.exit(1);
}
console.log('PASS renderRouteParitySmoke');
process.exit(0);
