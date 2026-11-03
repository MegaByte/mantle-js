// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// frameEntryWarmSmoke — every public frame entry reaches the bundle's specialized fill program.
//
// A bundle's fill draws use the general fill program until the program compiled for the bundle (its unused
// features compiled out, MANTLE_NO_*) has its pipeline built, and the build runs on the renderer's frame-slack tick.
// A public entry that never ran the tick -- render(), say -- would leave a setBundle + render() app on the general
// program forever. This drives each public way of drawing a bundle on its own, as the only thing the app calls per
// frame, at 60 fps and again at 30 ms a frame (fake GL, fake clock: performance.now advances a frame's time per frame
// and a microsecond a call), and asserts that by frame 60 every fill draw of the frame uses a program with the
// bundle's omissions compiled in, and that every frame issues frame 0's clears and draws (framebuffer, textures per
// unit, scissor, vertex count) but for one-pixel pipeline-warm draws:
//
//   render()                         setBundle, then render() each frame
//   drawBundle()                     bare, the caller owning nothing else
//   beginFrame/drawBundle/endFrame
//   drawInstance()                   bare, the caller owning the clear
//   drawSprite()                     bare, a shape range of the bundle
//   drawBundleInstanced()            bare, two instances (the instanced fast path)
//   drawSpriteInstanced()            bare, two instances
//   submitBundle()                   outside a frame (it draws at once) and inside one (it draws at endFrame)
//   handle.draw()                    outside a frame, and inside one
//
// It FAILS if handle.draw() outside a frame never ticks (the general program forever), or if the instanced fast
// path's program is the general fragment shader plus MANTLE_INSTANCED for every bundle.
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

let clock = 1000;
performance.now = () => (clock += 0.001);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 81 66">
  <path d="M 81 0 L 0 0 L 0 61 Q 0 66 5 66 L 76 66 Q 81 66 81 61 Z" fill="#332F2D"/>
  <path d="M 25 14 Q 21 10 16 14 Q 12 18 16 23 Q 21 27 25 23 Q 29 18 25 14 Z" fill="#F5B433" fill-opacity="0.3"/>
</svg>`;
const sections = await importSvg(svg);
const FRAMES = 150;
const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const TWO = [
  { worldMatrix: [0.5, 0, 0, 0, 0.5, 0, -0.5, 0, 1] },
  { worldMatrix: [0.5, 0, 0, 0, 0.5, 0, 0.5, 0, 1] },
];

const ENTRIES = {
  'render()': (r, b) => r.render(),
  'drawBundle() bare': (r, b) => r.drawBundle(b),
  'beginFrame / drawBundle / endFrame': (r, b) => {
    r.beginFrame();
    r.drawBundle(b);
    r.endFrame();
  },
  'drawInstance() bare': (r, b) => r.drawInstance(b, { worldMatrix: I }),
  'drawSprite() bare': (r, b) => r.drawSprite(b, [0, 1]),
  'drawBundleInstanced() bare': (r, b) => r.drawBundleInstanced(b, TWO),
  'drawSpriteInstanced() bare': (r, b) => r.drawSpriteInstanced(b, [0, 1], TWO),
  'submitBundle() outside a frame': (r, b) => r.submitBundle(b),
  'beginFrame / submitBundle / endFrame': (r, b) => {
    r.beginFrame();
    r.submitBundle(b);
    r.endFrame();
  },
  'handle.draw() outside a frame': (r, b, h) => h.draw(),
  'beginFrame / handle.draw() / endFrame': (r, b, h) => {
    r.beginFrame();
    h.draw();
    r.endFrame();
  },
};

for (const frameMs of [16.7, 30])
  for (const [name, frame] of Object.entries(ENTRIES)) {
    const F = createFakeGl({ width: 800, height: 800 });
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
    const renderer = createRenderer(gl, taggedShaderSources(), { variantFirst: false });
    const bundle = createBundle(gl, sections);
    renderer.setBundle(bundle);
    const handle = renderer.createBundleHandle(bundle);
    // A fill draw: its program's fragment shader is the fill shader. Specialized: that shader has the bundle's
    // omissions (MANTLE_NO_*) compiled in.
    const fragOf = (p) =>
      (shaders.get(p) || []).map((sh) => src.get(sh) || '').find((s) => s.includes('@@fillFrag')) ||
      null;
    const fillDraws = (f) =>
      F.log.filter(
        (e) =>
          e.frame === f &&
          e.op === 'draw' &&
          fragOf(e.prog) !== null &&
          !(e.sc && e.sc[2] === 1 && e.sc[3] === 1),
      ); // not a 1-pixel pipeline warm
    let first = -1,
      drew = 0;
    for (let f = 0; f < FRAMES; f++) {
      F.setFrame(f);
      clock += frameMs;
      frame(renderer, bundle, handle);
      const d = fillDraws(f);
      if (d.length) drew++;
      const lean = d.length > 0 && d.every((e) => /#define MANTLE_NO_/.test(fragOf(e.prog)));
      if (lean && first < 0) first = f;
      if (!lean && first >= 0) first = -2; // fell back after reaching it
    }
    const last = fillDraws(FRAMES - 1);
    const inst = last.some((e) => /#define MANTLE_INSTANCED/.test(fragOf(e.prog)));
    // The frames' draws, program aside: frame 0's, but for one-pixel warm draws.
    const isWarm = (e) => e.op === 'draw' && e.sc && e.sc[2] === 1 && e.sc[3] === 1;
    const seq = (f) =>
      JSON.stringify(
        F.log
          .filter((e) => e.frame === f && (e.op === 'draw' || e.op === 'clear') && !isWarm(e))
          .map((e) => [
            e.op,
            e.count,
            e.fbo ? e.fbo.id : null,
            (e.units || []).map((t) => (t ? t.id : null)),
            e.sc,
            e.mask,
          ]),
      );
    const base = seq(0),
      other = [];
    for (let f = 1; f < FRAMES; f++) if (seq(f) !== base) other.push(f);
    ok(
      drew === FRAMES && first > 0 && first <= 60 && other.length === 0,
      `${frameMs} ms, ${name}: specialized from frame ${first} on${inst ? ' (instanced program)' : ''}; ` +
        `every frame is frame 0's draws but warm ones (others: ${other.slice(0, 5).join(', ') || 'none'})`,
    );
  }

if (fail) {
  console.log(`FAIL frameEntryWarmSmoke: ${fail} check(s)`);
  process.exit(1);
}
console.log('PASS frameEntryWarmSmoke');
process.exit(0);
