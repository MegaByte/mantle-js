// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// entryEngineTally — which engine draws a bundle through each public frame entry, with the route pinned.
// Every entry must ask the same route: with setFillEngine({ route: 'lb' }), the LB build awaited and the variant warm,
// render() and beginFrame / drawBundle / endFrame must both draw LB, not Slug.
//
// Headless against the recording fake GL, on a 60 fps fake clock: createRenderer, setFillEngine(ROUTE), importSvg,
// createBundle, setBundle, one frame through the entry to start the draw-time build, awaitLbReady, then WARM frames
// (the variant's slack window) and FRAMES counted frames. Prints debugStats.engines (the draw tally) accumulated over
// the counted frames, the fill program each counted draw used, and GL draws per frame.
//
//   node probes/drawCost/entryEngineTally.mjs [svg=examples/tiger.svg] [ROUTE=lb] [WARM=120] [FRAMES=20]
//   ENTRIES=render,frame,handle picks the entries (render: setBundle + render(); frame: beginFrame / drawBundle /
//   endFrame; draw: bare drawBundle; handle: handle.draw() outside a frame).
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OWN = path.resolve(HERE, '../..');
const TREE = path.resolve(process.env.TREE || OWN);
const { createFakeGl, taggedShaderSources } = await import(
  pathToFileURL(path.join(OWN, 'test/_fakeGl.mjs')).href
);
const api = await import(pathToFileURL(path.join(TREE, 'src/index.js')).href);

const svgPath = path.resolve(process.argv[2] || path.join(OWN, 'examples/tiger.svg'));
const ROUTE = process.env.ROUTE || 'lb';
const WARM = +(process.env.WARM || 120),
  FRAMES = +(process.env.FRAMES || 20);
const ENTRIES = (process.env.ENTRIES || 'render,frame,draw,handle').split(',');
const sections0 = await api.importSvg(readFileSync(svgPath, 'utf8'));

let clock = 1000;
const realNow = performance.now.bind(performance);
performance.now = () => (clock += 0.001);

for (const entry of ENTRIES) {
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
  const r = api.createRenderer(gl, taggedShaderSources());
  if (r.ready) await r.ready;
  r.setFillEngine({ route: ROUTE });
  const b = api.createBundle(gl, sections0);
  r.setBundle(b);
  const h = entry === 'handle' ? r.createBundleHandle(b) : null;
  const frame = {
    render: () => r.render(),
    frame: () => {
      r.beginFrame();
      r.drawBundle(b);
      r.endFrame();
    },
    draw: () => r.drawBundle(b),
    handle: () => h.draw(),
  }[entry];
  let f = 0;
  const step = () => {
    F.setFrame(f++);
    clock += 16.7;
    frame();
  };
  step();
  // Real time for the off-thread (here: deferred) build; the fake clock only paces the frames.
  performance.now = realNow;
  let ready = null;
  try {
    ready = await r.awaitLbReady(b, 30000);
  } catch (e) {
    ready = 'threw ' + e.message;
  }
  performance.now = () => (clock += 0.001);
  for (let i = 0; i < WARM; i++) {
    step();
    if (i % 8 === 0) await new Promise((res) => setTimeout(res, 0));
  }
  const e0 = JSON.stringify((r.debugStats.engines || {}).draws || {});
  const f0 = f;
  for (let i = 0; i < FRAMES; i++) step();
  const eng = r.debugStats.engines || {};
  const defsOf = (p) => {
    const s = (shaders.get(p) || [])
      .map((sh) => src.get(sh) || '')
      .find((x) => x.includes('@@fillFrag'));
    return s ? [...s.matchAll(/^#define (MANTLE_\w+)/gm)].map((m) => m[1]) : null;
  };
  const progs = new Map();
  let draws = 0,
    clears = 0;
  for (const e of F.log) if (e.frame >= f0 && e.op === 'clear') clears++;
  for (const e of F.log)
    if (e.frame >= f0 && e.op === 'draw') {
      draws++;
      const d = defsOf(e.prog);
      const k =
        d === null
          ? [...F.progKeys(e.prog)].join('+')
          : 'fill' +
            (d.includes('MANTLE_LB_FILL') ? '+LB_FILL' : '') +
            (d.some((x) => x.startsWith('MANTLE_NO_')) ? ' (variant)' : ' (universal)');
      progs.set(k, (progs.get(k) || 0) + 1);
    }
  console.log(
    `== ${entry}  route=${ROUTE}  awaitLbReady=${ready}  getFillEngine=${JSON.stringify(r.getFillEngine())}`,
  );
  console.log(`   engines.draws (cumulative): before ${e0}`);
  console.log(`                               after  ${JSON.stringify(eng.draws || {})}`);
  if (eng.declined) console.log(`   engines.declined: ${JSON.stringify(eng.declined)}`);
  console.log(
    `   GL clears/frame ${(clears / FRAMES).toFixed(1)}, draws/frame ${(draws / FRAMES).toFixed(1)}; programs over ${FRAMES} frames: ${JSON.stringify(Object.fromEntries(progs))}`,
  );
  console.log(
    `   drawnFillVariantKey: ${(r.debugStats.drawnFillVariantKey || '(universal)').slice(0, 160)}`,
  );
}
process.exit(0);
