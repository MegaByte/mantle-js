// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// psoWarmDeadlineSmoke — a bundle reaches its specialized fill program whatever the frame time.
//
// A draw uses its fill variant only once the variant's pipeline is warm, and the slack warm waits for 45 consecutive
// frames under 20 ms. Content that is never that fast -- a heavy scene, a slow machine, a GPU-bound render() loop --
// would never get one and would draw the universal program for the life of the renderer. The deadline: a draw that falls back because its variant's pipeline is cold waits at
// most psoWarmMaxWaitFrames frames (default 60) and one second, then the pipeline is built whatever the frame time.
//
// Headless, against the recording fake GL, on a fake clock (performance.now advances a frame's time per frame and a
// microsecond per call):
//   * every frame 30 ms: the variant is bound at frame 60, by one deadline warm, through render() and through
//     beginFrame + drawBundle; with psoWarmMaxWaitFrames: 0 (slack only) it never is -- so the deadline
//     is what binds it;
//   * bursts of 12 frames at 12 ms with 300 ms between them (a throttled benchmark), 2 ms frames with a 40 ms stall
//     every 10th (fast, never slack), and bursts of 64 frames 0.1 ms apart every 300 ms (a loop that submits ahead of
//     the GPU, so the 8 ms warm-tick throttle sees one tick a burst): bound within 60 frames and a second, the same;
//   * 60 fps and back-to-back 1.44 ms frames: the variant is bound on exactly the frame it is without the deadline,
//     and no deadline warm runs -- slack comes first;
//   * the first frame never warms (no pipeline build at a bundle's first draw), and every frame issues frame 0's
//     clears and draws except the warm frame, whose one extra draw is scissored to one pixel before its clear;
//   * a host psoWarmIdle callback stays authoritative: one that never says idle gets no deadline warm;
//   * render() is a frame entry like drawBundle: a consumer that drives the renderer through setBundle + render()
//     (svgRenderBench, the demo, the documented single-bundle path) runs the frame-slack tick, so at 60 fps it
//     starts on the universal program, moves to a variant that compiles features out and stays on it, and its warm
//     frames put the one-pixel draw before the frame's clear. Inside beginFrame / endFrame the frame entry is
//     beginFrame's own tick, so render() there starts no warm of its own.
//
// Without the deadline, the 30 ms and burst loops never bind the variant. Without the tick in render(), the 60 fps
// render() loop never binds it either.
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
const DEADLINE = 60;

// One run: a fresh context, renderer and bundle; `frameMs(f)` is frame f's duration; `entry` 'render' or 'draw'.
// `nested` more frames then call render() inside beginFrame / endFrame at 60 fps.
function run(frameMs, { entry = 'render', opts = {}, FRAMES = 150, mounts = 1, nested = 0 } = {}) {
  const F = createFakeGl({ width: 800, height: 800 });
  const EXT = {
    KHR_parallel_shader_compile: { COMPLETION_STATUS_KHR: 0x91b1 },
    EXT_color_buffer_float: {},
  };
  const gl = new Proxy(
    {},
    { get: (_t, k) => (k === 'getExtension' ? (n) => EXT[n] || null : F.gl[k]) },
  );
  const renderer = createRenderer(gl, taggedShaderSources(), { variantFirst: false, ...opts });
  const bundle = createBundle(gl, sections);
  renderer.setBundle(bundle);
  const keys = [];
  for (let f = 0; f < FRAMES; f++) {
    F.setFrame(f);
    clock += frameMs(f);
    if (entry === 'draw') {
      renderer.beginFrame();
      for (let m = 0; m < mounts; m++) renderer.drawBundle(bundle);
      renderer.endFrame();
    } else renderer.render();
    keys.push(renderer.debugStats.drawnFillVariantKey || null);
  }
  const first = keys.findIndex((k) => k);
  const events = (f) =>
    JSON.stringify(
      F.log
        .filter((e) => e.frame === f && (e.op === 'draw' || e.op === 'clear'))
        .map((e) => [
          e.op,
          e.count,
          e.fbo ? e.fbo.id : null,
          (e.units || []).map((t) => (t ? t.id : null)),
          e.sc,
          e.mask,
        ]),
    );
  // Frames that differ from frame 0: each must be a warm frame -- frame 0's sequence exactly, plus one draw scissored
  // to one pixel: before the frame's clear under render() (the tick is the frame's entry), right after it under
  // beginFrame (which clears, then ticks).
  const base = events(0),
    isWarm = (e) => e && e[0] === 'draw' && JSON.stringify(e[4]) === '[0,0,1,1]';
  let warmFrames = 0;
  const other = [],
    warmAt = [];
  for (let f = 1; f < FRAMES; f++) {
    const ev = events(f);
    if (ev === base) continue;
    const arr = JSON.parse(ev);
    const at = arr.findIndex(isWarm);
    if (at >= 0 && at <= 1 && JSON.stringify(arr.slice(0, at).concat(arr.slice(at + 1))) === base) {
      warmFrames++;
      warmAt.push(at);
    } else other.push(f);
  }
  const frame0Warm = F.log.some(
    (e) => e.frame === 0 && e.op === 'draw' && e.sc && e.sc[2] === 1 && e.sc[3] === 1,
  );
  const onePixelDraws = () =>
    F.log.filter((e) => e.op === 'draw' && e.sc && e.sc[2] === 1 && e.sc[3] === 1).length;
  const nestedBefore = onePixelDraws();
  for (let f = FRAMES; f < FRAMES + nested; f++) {
    F.setFrame(f);
    clock += 16.7;
    renderer.beginFrame();
    renderer.render();
    renderer.endFrame();
  }
  return {
    warmAt,
    nestedWarms: onePixelDraws() - nestedBefore,
    keys,
    first,
    last: keys[FRAMES - 1],
    warmFrames,
    other,
    frame0Warm,
    deadlineWarms: renderer.debugStats.psoDeadlineWarms | 0,
  };
}

const slow = () => 30;
const burst = (f) => (f % 12 === 11 ? 12 + 300 : 12);
const stutter = (f) => (f % 10 === 9 ? 2 + 40 : 2);
const ahead = (f) => (f % 64 === 63 ? 0.1 + 300 : 0.1);
const fps60 = () => 16.7;
const fast = () => 1.44;

// [name, frame time, frames to run, latest frame the variant may first be bound on, entries]. The bound is the
// deadline: 60 fallen-back frames and one second since the first, then the next warm tick (for `ahead`, the next
// burst's first frame). `ahead` is render() only: beginFrame ticks every frame, unthrottled, so under beginFrame those
// 0.1 ms frames ARE slack and warm at 45 ticks, as they did before.
for (const [name, frameMs, FRAMES, bound, entries] of [
  ['every frame 30 ms', slow, 150, DEADLINE + 1, ['render', 'draw']],
  ['bursts of 12 x 12 ms, 300 ms apart', burst, 150, DEADLINE + 1, ['render', 'draw']],
  ['2 ms frames, a 40 ms stall every 10th', stutter, 320, 180, ['render', 'draw']],
  ['bursts of 64 x 0.1 ms, 300 ms apart', ahead, 400, 257, ['render']],
]) {
  for (const entry of entries) {
    const r = run(frameMs, { entry, FRAMES });
    const off = run(frameMs, { entry, FRAMES, opts: { psoWarmMaxWaitFrames: 0 } });
    ok(
      r.first > 0 &&
        r.first <= bound &&
        /MANTLE_NO_/.test(r.last || '') &&
        r.keys.slice(r.first).every((k) => k === r.last),
      `${name}, ${entry}: the variant is bound from frame ${r.first} (at most ${bound}) and stays`,
    );
    ok(r.deadlineWarms === 1, `  by one deadline warm (${r.deadlineWarms})`);
    ok(
      !r.frame0Warm && r.other.length === 0 && r.warmFrames >= 1 && r.warmFrames <= 2,
      `  frame 0 builds no pipeline, and every frame is frame 0's but ${r.warmFrames} warm frame(s) (others: ${r.other.join(', ') || 'none'})`,
    );
    ok(
      off.first < 0,
      `  with psoWarmMaxWaitFrames: 0 (slack only) it is never bound (${off.first < 0 ? 'never' : 'frame ' + off.first})`,
    );
  }
}

{
  const one = run(slow, { entry: 'draw', FRAMES: 64 });
  const many = run(slow, { entry: 'draw', FRAMES: 64, mounts: 65 });
  ok(
    one.first === DEADLINE && many.first === one.first && many.deadlineWarms === 1,
    `65 mounts share one frame of deadline age: one mount warms at ${one.first}, many at ${many.first}`,
  );
}

for (const [name, frameMs] of [
  ['60 fps', fps60],
  ['back-to-back 1.44 ms', fast],
]) {
  for (const entry of ['render', 'draw']) {
    const rendered = name === '60 fps' && entry === 'render';
    const r = run(frameMs, { entry, FRAMES: 320, nested: rendered ? 20 : 0 });
    const off = run(frameMs, { entry, FRAMES: 320, opts: { psoWarmMaxWaitFrames: 0 } });
    ok(
      r.first > 0 && r.first === off.first && r.deadlineWarms === 0,
      `${name}, ${entry}: bound on frame ${r.first}, the frame slack alone binds it (${off.first}), no deadline warm (${r.deadlineWarms})`,
    );
    if (!rendered) continue;
    // The setBundle + render() consumer: one warm per queued warm of the bundle (its creation-time prewarm and the
    // variant's own request), each a 1-pixel draw before the clear, since render()'s tick is the frame's entry.
    ok(
      r.first > 0 &&
        r.keys.slice(r.first).every((k) => k === r.last) &&
        /MANTLE_NO_/.test(r.last || ''),
      `  render() stays on the variant it moved to, one that compiles features out (${r.last})`,
    );
    ok(
      r.other.length === 0 &&
        r.warmFrames >= 1 &&
        r.warmFrames <= 2 &&
        r.warmAt.every((at) => at === 0),
      `  every frame issues frame 0's clears and draws, but for ${r.warmFrames} warm frame(s) that add one 1-pixel draw before the clear (other frames: ${r.other.join(', ') || 'none'})`,
    );
    ok(
      r.nestedWarms === 0,
      `  render() inside a beginFrame frame starts no warm of its own (${r.nestedWarms} new)`,
    );
  }
}

{
  const r = run(slow, { opts: { psoWarmIdle: () => false } });
  ok(
    r.first < 0 && r.deadlineWarms === 0,
    `a host psoWarmIdle that never says idle stays authoritative: no deadline warm (${r.deadlineWarms})`,
  );
}

if (fail) {
  console.log(`FAIL psoWarmDeadlineSmoke: ${fail} check(s)`);
  process.exit(1);
}
console.log('PASS psoWarmDeadlineSmoke');
process.exit(0);
