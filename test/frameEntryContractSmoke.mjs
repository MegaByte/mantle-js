// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// frameEntryContractSmoke — one contract for clears, warm ticks and fades across every public frame entry.
//
// THE CONTRACT (renderer.js renderEntry):
//   * the COLOR CLEAR belongs to a frame, never to a draw: beginFrame(clearColor) clears (null keeps the canvas) and a
//     standalone render() clears once; drawBundle, drawBundleInstanced, drawInstance, drawSprite and handle.draw never
//     clear color, on any route;
//   * the WARM TICK runs once per frame at the frame's entry, BEFORE its clear, so its one-pixel pipeline warm never
//     survives a frame that clears; a draw entry inside a frame only counts the frame; and a warm is DRAWN only at an
//     entry that clears the canvas: a bare draw outside any frame and beginFrame(null) draw none;
//   * the OVERRIDE TABLE is resolved the same way everywhere: the caller's, else the target's own (a morph's fade).
//
// THE TRAPS: (a) a bare drawBundle outside a frame that clears the canvas when it falls back to the Slug body and not on
// the Loop-Blinn route -- or an instanced loop that clears before every instance; (b) render(morph) drawing the morph with
// no override table where drawBundle(morph) applies its fade; (c) beginFrame ticking after its clear, and a drawBundle
// inside the frame ticking again, so a pipeline warm draws its pixel into the frame.
//
// Headless, against the recording fake GL (test/_fakeGl.mjs), 60 fps fake clock, 150 frames per entry, the Slug route
// ('none') and the Loop-Blinn route ('lb', its build awaited). A warm draw is a canvas draw scissored to one pixel.
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
const { createFakeGl, taggedShaderSources } = await import('./_fakeGl.mjs');
const { importSvg, createBundle, createRenderer, createOverrideTable } =
  await import('../src/index.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <path d="M 10 50 Q 10 10 50 10 Q 90 10 90 50 Q 90 90 50 90 Q 10 90 10 50 Z" fill="#3a6ea5"/>
  <path d="M 30 50 C 30 20 70 20 70 50 C 70 80 30 80 30 50 Z" fill="#f5b433" fill-opacity="0.6"/>
</svg>`;
const sections = await importSvg(svg);
const FRAMES = 150;
const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const TWO = [
  { worldMatrix: [0.5, 0, 0, 0, 0.5, 0, -0.5, 0, 1] },
  { worldMatrix: [0.5, 0, 0, 0, 0.5, 0, 0.5, 0, 1] },
];
// a general color matrix cannot ride the instanced attributes: the per-instance loop
const SWAP = [0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const THREE_CM = [0, 1, 2].map((k) => ({
  worldMatrix: [0.3, 0, 0, 0, 0.3, 0, -0.6 + 0.6 * k, 0, 1],
  colorMatrix: SWAP,
}));
const realNow = performance.now.bind(performance);

async function rig(route) {
  const F = createFakeGl({ width: 400, height: 400 });
  // Events before the first driven frame (awaitLbReady's load-time warm, the builds) are nobody's frame: the fake GL
  // starts at frame 0, which drive() then counted as the first frame's.
  F.setFrame(-1);
  const EXT = {
    KHR_parallel_shader_compile: { COMPLETION_STATUS_KHR: 0x91b1 },
    EXT_color_buffer_float: {},
  };
  const gl = new Proxy(
    {},
    { get: (_t, k) => (k === 'getExtension' ? (n) => EXT[n] || null : F.gl[k]) },
  );
  const r = createRenderer(gl, taggedShaderSources());
  r.setFillEngine({ route });
  const b = createBundle(gl, sections);
  r.setBundle(b);
  const h = r.createBundleHandle(b);
  if (route !== 'none') await r.awaitLbReady(b, 30000);
  return { F, gl, r, b, h };
}
const COLOR = (F) => F.gl.COLOR_BUFFER_BIT;
const isWarm = (e) => e.op === 'draw' && e.fbo === null && e.sc && e.sc[2] === 1 && e.sc[3] === 1;
// Drive `frame` for FRAMES frames at 60 fps; per frame, the canvas color clears and whether a warm draw followed one.
function drive(F, frame) {
  let clock = 1000;
  performance.now = () => (clock += 0.001);
  const perFrame = [];
  try {
    for (let f = 0; f < FRAMES; f++) {
      F.setFrame(f);
      clock += 16.7;
      frame();
      const ev = F.log.filter((e) => e.frame === f);
      const clearAt = ev.findIndex((e) => e.op === 'clear' && e.fbo === null && e.mask & COLOR(F));
      perFrame.push({
        clears: ev.filter((e) => e.op === 'clear' && e.fbo === null && e.mask & COLOR(F)).length,
        warms: ev.filter(isWarm).length,
        warmAfterClear: clearAt >= 0 && ev.slice(clearAt).some(isWarm),
        draws: ev.filter((e) => e.op === 'draw' && !isWarm(e)).length,
      });
    }
  } finally {
    performance.now = realNow;
  }
  return perFrame;
}

const ENTRIES = [
  // [name, frame(r, b, h), color clears a frame]
  ['render()', (r) => r.render(), 1],
  [
    'beginFrame / drawBundle x2 / endFrame',
    (r, b) => {
      r.beginFrame();
      r.drawBundle(b);
      r.drawBundle(b);
      r.endFrame();
    },
    1,
  ],
  [
    'beginFrame(null) / drawBundle / endFrame',
    (r, b) => {
      r.beginFrame(null);
      r.drawBundle(b);
      r.endFrame();
    },
    0,
  ],
  ['drawBundle() bare', (r, b) => r.drawBundle(b), 0],
  ['drawBundleInstanced() bare, instanced', (r, b) => r.drawBundleInstanced(b, TWO), 0],
  [
    'drawBundleInstanced() bare, per-instance loop',
    (r, b) => r.drawBundleInstanced(b, THREE_CM),
    0,
  ],
  ['drawInstance() bare', (r, b) => r.drawInstance(b, { worldMatrix: I }), 0],
  ['drawSprite() bare', (r, b) => r.drawSprite(b, [0, 1]), 0],
  ['handle.draw() outside a frame', (r, b, h) => h.draw(), 0],
];

console.log(
  "(a) color clears, (c) the warm tick before the frame's clear, (d) no warm drawn where nothing clears",
);
const engines = {},
  warmsAtClearing = {};
for (const route of ['none', 'lb']) {
  for (const [name, frame, want] of ENTRIES) {
    const { F, r, b, h } = await rig(route);
    const e0 = JSON.stringify((r.debugStats.engines || {}).draws || {});
    const pf = drive(F, () => frame(r, b, h));
    if (name === 'drawBundle() bare')
      engines[route] = JSON.stringify((r.debugStats.engines || {}).draws || {}) + ' from ' + e0;
    const wrong = pf.map((p, f) => (p.clears !== want ? f : -1)).filter((f) => f >= 0);
    const drawn = pf.filter((p) => p.draws > 0).length;
    ok(
      drawn === FRAMES && wrong.length === 0,
      `route ${route}, ${name}: ${want} color clear(s) every frame (wrong on ${wrong.length} frames${wrong.length ? `, first ${wrong[0]}: ${pf[wrong[0]].clears}` : ''})`,
    );
    const warms = pf.reduce((a, p) => a + p.warms, 0);
    if (want === 1) {
      const after = pf.filter((p) => p.warmAfterClear).length;
      ok(
        after === 0,
        `route ${route}, ${name}: no pipeline warm after the frame's clear (${warms} warm draws, ${after} frames with one after it)`,
      );
      warmsAtClearing[route] = (warmsAtClearing[route] | 0) + warms;
    } else {
      // (d) AN ENTRY THAT DOES NOT CLEAR DRAWS NO WARM: nothing would take its pixel back.
      ok(
        warms === 0,
        `route ${route}, ${name}: no pipeline warm drawn at an entry that keeps the canvas (${warms})`,
      );
    }
    try {
      r.dispose();
    } catch {
      /* headless */
    }
  }
}
ok(
  engines.none !== engines.lb && /lb/i.test(engines.lb),
  `the two routes drew different engines (none: ${engines.none}; lb: ${engines.lb})`,
);
// ...and the clearing entries still warm: (d) is not a warm that never runs.
ok(
  Object.values(warmsAtClearing).some((n) => n > 0),
  `the entries that clear still draw their warms (${JSON.stringify(warmsAtClearing)})`,
);

console.log("(b) render(target) applies the target's own override table, as drawBundle does");
for (const route of ['none', 'lb']) {
  const { F, gl, r, b } = await rig(route);
  const table = createOverrideTable(gl, b);
  b._morphOverrides = table; // what createShapeMorph hangs on its bundle: the fade
  const hasOv = (f) => {
    const d = F.log.filter(
      (e) => e.frame === f && e.op === 'draw' && !isWarm(e) && e.uni && 'uHasOverrides' in e.uni,
    );
    return d.length ? d.every((e) => e.uni.uHasOverrides === 1) : null;
  };
  F.setFrame(1000);
  r.render(b);
  F.setFrame(1001);
  r.beginFrame();
  r.drawBundle(b);
  r.endFrame();
  F.setFrame(1002);
  r.render(b);
  b._morphOverrides = null;
  F.setFrame(1003);
  r.render(b); // the table is the bundle's, not left behind in the draw state
  ok(
    hasOv(1000) === true && hasOv(1001) === true && hasOv(1002) === true && hasOv(1003) === false,
    `route ${route}: render(bundle) binds its table (${hasOv(1000)}), as drawBundle does (${hasOv(1001)}); without one, none (${hasOv(1003)})`,
  );
  try {
    r.dispose();
  } catch {
    /* headless */
  }
}

if (fail) {
  console.log(`FAIL frameEntryContractSmoke: ${fail} check(s)`);
  process.exit(1);
}
console.log('PASS frameEntryContractSmoke');
process.exit(0);
