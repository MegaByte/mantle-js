// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// renderEntryWarmSmoke — a consumer that drives the renderer through setBundle + render() gets its
// specialised fill program, and nothing else about the frame changes.
//
// drawBundle and drawBundleInstanced run the frame-slack tick (drawDispatch warmTick) that promotes a
// linked fill variant and warms its pipeline; the public render() must run it too, or a render()-driven
// consumer -- svgRenderBench, the demo, the documented single-bundle path -- draws every frame with the
// universal fill program, never the variant compiled for its bundle. On simple art, where one draw
// shades most of the canvas, that costs several times the GPU time.
//
// Headless, against the recording fake GL, with a 60 fps frame clock (performance.now advances
// 16.7 ms a frame, a microsecond a call): after the renderer's slack window the draw uses a variant
// (debugStats.drawnFillVariantKey), and every frame -- universal or specialised -- issues the same
// clears and draws under the same framebuffer, textures and scissor, except the frames that warm the
// pipeline, whose one extra draw is scissored to one pixel and erased by that frame's own clear.
//
// Without the tick in render(), drawnFillVariantKey stays null for the whole run.
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

const F = createFakeGl({ width: 800, height: 800 });
const EXT = {
  KHR_parallel_shader_compile: { COMPLETION_STATUS_KHR: 0x91b1 },
  EXT_color_buffer_float: {},
};
const gl = new Proxy(
  {},
  { get: (_t, k) => (k === 'getExtension' ? (n) => EXT[n] || null : F.gl[k]) },
);

let clock = 1000;
performance.now = () => (clock += 0.001);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 81 66">
  <path d="M 81 0 L 0 0 L 0 61 Q 0 66 5 66 L 76 66 Q 81 66 81 61 Z" fill="#332F2D"/>
  <path d="M 25 14 Q 21 10 16 14 Q 12 18 16 23 Q 21 27 25 23 Q 29 18 25 14 Z" fill="#F5B433" fill-opacity="0.3"/>
</svg>`;
const renderer = createRenderer(gl, taggedShaderSources(), { variantFirst: false });
const bundle = createBundle(gl, await importSvg(svg));
renderer.setBundle(bundle);

const FRAMES = 150;
const keys = [];
for (let f = 0; f < FRAMES; f++) {
  F.setFrame(f);
  clock += 16.7;
  renderer.render();
  keys.push(renderer.debugStats.drawnFillVariantKey || null);
}
const firstVariant = keys.findIndex((k) => k);
ok(
  firstVariant > 0,
  `render() starts on the universal program and moves to its variant (frame ${firstVariant}: ${keys[FRAMES - 1]})`,
);
ok(
  firstVariant > 0 &&
    keys.slice(firstVariant).every((k) => k === keys[FRAMES - 1]) &&
    /MANTLE_NO_/.test(keys[FRAMES - 1] || ''),
  'and stays on it, a variant that compiles features out',
);

// The frames draw the same thing: per frame, the sequence of clears and draws with their vertex count,
// framebuffer, textures per unit and scissor. Every frame matches frame 0 except the pipeline-warm frames
// (one per queued warm of the bundle -- its creation-time prewarm and the variant's own request), each of
// which adds one draw scissored to one pixel BEFORE its clear and then draws exactly frame 0's sequence.
const events = (f) =>
  F.log
    .filter((e) => e.frame === f && (e.op === 'draw' || e.op === 'clear'))
    .map((e) => [
      e.op,
      e.count,
      e.fbo ? e.fbo.id : null,
      (e.units || []).map((t) => (t ? t.id : null)),
      e.sc,
      e.mask,
    ]);
const base = JSON.stringify(events(0));
let warmFrames = 0,
  other = [];
for (let f = 1; f < FRAMES; f++) {
  const ev = events(f);
  if (JSON.stringify(ev) === base) continue;
  if (
    ev.length &&
    ev[0][0] === 'draw' &&
    JSON.stringify(ev[0][4]) === '[0,0,1,1]' &&
    JSON.stringify(ev.slice(1)) === base
  )
    warmFrames++;
  else other.push(f);
}
ok(
  other.length === 0 && warmFrames >= 1 && warmFrames <= 2,
  `every frame issues frame 0's clears and draws, but for ${warmFrames} warm frame(s) that add one 1-pixel draw before the clear (other frames: ${other.join(', ') || 'none'})`,
);

// Inside beginFrame / endFrame the frame entry is beginFrame's own tick: render() adds none.
{
  const warmBefore = F.log.filter(
    (e) => e.op === 'draw' && e.sc && e.sc[2] === 1 && e.sc[3] === 1,
  ).length;
  for (let f = FRAMES; f < FRAMES + 20; f++) {
    F.setFrame(f);
    clock += 16.7;
    renderer.beginFrame();
    renderer.render();
    renderer.endFrame();
  }
  const warmAfter = F.log.filter(
    (e) => e.op === 'draw' && e.sc && e.sc[2] === 1 && e.sc[3] === 1,
  ).length;
  ok(
    warmAfter === warmBefore,
    `render() inside a beginFrame frame starts no warm of its own (${warmAfter - warmBefore} new)`,
  );
}

if (fail) {
  console.log(`FAIL renderEntryWarmSmoke: ${fail} check(s)`);
  process.exit(1);
}
console.log('PASS renderEntryWarmSmoke');
process.exit(0);
