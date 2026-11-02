// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// drawCostCensus — what one frame of `renderer.render()` asks of GL, and of the CPU, for a bundle: the per-draw
// fixed cost that dominates on SIMPLE art.
//
// Runs a renderer tree (this one, or another checkout to compare against) headless in node against the
// recording fake GL (test/_fakeGl.mjs, this tree's), set up as svgRenderBench sets up its page: an 800x800 canvas,
// importSvg with default options, createBundle, renderer.setBundle, WARM frames of renderer.render() and then
// FRAMES measured ones. Every GL call is counted by name, and the bytes of every buffer / texture upload and the
// number of uniform uploads are summed; the report is per measured frame. The fake reports the two extensions a
// Chrome/ANGLE-Metal context has (EXT_color_buffer_float, KHR_parallel_shader_compile) so the renderer takes the
// paths it takes in the bench; there are no workers in node, so off-thread builds run synchronously (a bench's
// steady state).
//
//   node probes/drawCost/drawCostCensus.mjs <tree js.kontek.mantle dir> <svg path> [FRAMES=500] [WARM=10]
//   CALLS=1 prints the whole per-frame call list in order for one frame (the last).
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OWN = path.resolve(HERE, '../..');
const [treeArg, svgArg] = process.argv.slice(2);
const TREE = path.resolve(treeArg || OWN),
  FRAMES = +(process.argv[4] || 500),
  WARM = +(process.argv[5] || 10);
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
const { createFakeGl, taggedShaderSources } = await import(
  pathToFileURL(path.join(OWN, 'test/_fakeGl.mjs')).href
);
const api = await import(pathToFileURL(path.join(TREE, 'src/index.js')).href);

const F = createFakeGl({ width: 800, height: 800 });
const EXT = {
  EXT_color_buffer_float: {},
  KHR_parallel_shader_compile: {
    COMPLETION_STATUS_KHR: 0x91b1,
    MAX_SHADER_COMPILER_THREADS_KHR: 0x91b0,
  },
};
const counts = new Map(),
  bytes = new Map(),
  order = [];
// PROOF=1: the state every draw ran under -- enabled caps, blend / depth / stencil / viewport / scissor / color-mask
// calls, the bound VAO, array and element buffers, framebuffer, textures per unit and every uniform the program was
// last given -- so two frames (or two builds) can be compared draw for draw. The program itself is left out and
// reported separately, by its #define set.
const PROOF = !!process.env.PROOF;
const ST = {
  caps: new Map(),
  calls: new Map(),
  vao: null,
  buf: new Map(),
  prog: null,
  uni: new Map(),
};
const idOf = (o) => (o && typeof o === 'object' && 'id' in o ? `#${o.id}` : o);
const argKey = (a) =>
  JSON.stringify(
    a.map((x) =>
      x && typeof x === 'object' && !ArrayBuffer.isView(x) && !Array.isArray(x)
        ? x.uniform || idOf(x)
        : ArrayBuffer.isView(x)
          ? Array.from(x)
          : x,
    ),
  );
const STATE_CALLS = new Set([
  'blendFunc',
  'blendFuncSeparate',
  'blendEquation',
  'blendEquationSeparate',
  'blendColor',
  'depthFunc',
  'depthMask',
  'depthRange',
  'colorMask',
  'viewport',
  'scissor',
  'stencilFunc',
  'stencilFuncSeparate',
  'stencilOp',
  'stencilOpSeparate',
  'stencilMask',
  'stencilMaskSeparate',
  'polygonOffset',
  'cullFace',
  'frontFace',
  'sampleCoverage',
  'pixelStorei',
]);
const drawStates = []; // { frame, prog, key }
function track(k, a) {
  if (k === 'enable') ST.caps.set(a[0], true);
  else if (k === 'disable') ST.caps.set(a[0], false);
  else if (STATE_CALLS.has(k)) ST.calls.set(k, argKey(a));
  else if (k === 'bindVertexArray') ST.vao = idOf(a[0]);
  else if (k === 'bindBuffer') ST.buf.set(a[0], idOf(a[0 + 1]));
  else if (k === 'useProgram') ST.prog = a[0];
  else if (k.startsWith('uniform') && a[0] && a[0].uniform) {
    if (!ST.uni.has(ST.prog)) ST.uni.set(ST.prog, new Map());
    ST.uni.get(ST.prog).set(a[0].uniform, k + argKey(a.slice(1)));
  } else if (/^draw/.test(k)) {
    const u = ST.uni.get(ST.prog);
    // Normalized to what the draw can observe: a cap never enabled and one disabled are the same state (GL's default
    // is off for every cap this renderer toggles), and the scissor box matters only while SCISSOR_TEST is on.
    const scissorOn = ST.caps.get(F.gl.SCISSOR_TEST) === true;
    const key = JSON.stringify([
      k,
      argKey(a),
      [...ST.caps]
        .filter((c) => c[1])
        .map((c) => c[0])
        .sort((p, q) => p - q),
      [...ST.calls].filter((c) => c[0] !== 'scissor' || scissorOn).sort(),
      ST.vao,
      [...ST.buf].sort(),
      u ? [...u].sort() : [],
    ]);
    drawStates.push({ frame: -1, prog: ST.prog, key });
  }
}
let recording = false,
  tracing = false;
const BYTEY = {
  bufferData: 1,
  bufferSubData: 2,
  texImage2D: -1,
  texSubImage2D: -1,
  texImage3D: -1,
  texSubImage3D: -1,
};
const sizeOf = (v) => (v && typeof v.byteLength === 'number' ? v.byteLength : 0);
const gl = new Proxy(
  {},
  {
    get(_t, k) {
      if (k === 'getExtension') return (n) => EXT[n] || null;
      if (k === 'getSupportedExtensions') return () => Object.keys(EXT);
      const v = F.gl[k];
      if (typeof v !== 'function') return v;
      return (...a) => {
        if (PROOF) track(k, a);
        if (recording) {
          counts.set(k, (counts.get(k) || 0) + 1);
          if (k in BYTEY) {
            let b = 0;
            if (BYTEY[k] > 0) b = sizeOf(a[BYTEY[k]]);
            else for (const x of a) b += sizeOf(x);
            bytes.set(k, (bytes.get(k) || 0) + b);
          }
          if (tracing)
            order.push(
              k + (k.startsWith('uniform') && a[0] && a[0].uniform ? ' ' + a[0].uniform : ''),
            );
        }
        return v(...a);
      };
    },
  },
);
const svg = readFileSync(path.resolve(svgArg), 'utf8');
// CLOCK=<ms>: a frame clock. performance.now() advances by <ms> per frame (and by a microsecond per call within one),
// as a loop whose frames take <ms> would see it -- the bench's GPU-bound frame time, or 16.7 for an app at 60 fps -- so
// the renderer's frame-slack work (fill-variant promotion, pipeline warms) runs on the schedule it has there rather
// than on node's, where a fake-GL frame is a few microseconds. The JS time reported is on the real clock.
const CLOCK = +(process.env.CLOCK || 0);
// GAP=<ms>/<n>: and a further <ms> after every <n>th frame -- a harness that draws a burst of n frames, waits for the
// GPU and then idles (twoTreeAB's throttled samples), or an app that stalls periodically.
const [GAP_MS, GAP_N] = (process.env.GAP || '0/0').split('/').map(Number);
let frameNo = 0;
const tick = () => {
  fakeT += CLOCK;
  if (GAP_N > 0 && ++frameNo % GAP_N === 0) fakeT += GAP_MS;
};
const realNow = performance.now.bind(performance);
let fakeT = 1000;
if (CLOCK > 0) performance.now = () => (fakeT += 0.001);
// REAL=1: the tree's own generated shader sources instead of empty tagged ones, and SHADERS=<dir> writes the source of
// every program the last frame drew with (vertex and fragment, as linked: defines prepended) for offline inspection.
let sources = taggedShaderSources();
if (process.env.REAL) {
  const sh = await import(pathToFileURL(path.join(TREE, 'src/shaders/index.js')).href);
  const names = sh.SHADER_NAMES || sh.SHADER_FILENAMES;
  sources = {};
  for (const [key, file] of names) {
    try {
      sources[key] = readFileSync(path.join(TREE, 'src/shaders/generated', file), 'utf8');
    } catch {
      /* optional shader absent */
    }
  }
}
const shaderSrc = new Map(),
  progShaders = new Map();
// ONE context object for the renderer and createBundle: a bundle announces its fill-variant prewarm to the renderers
// of ITS context (enqueueFillPrewarm keys by the gl object), so a bundle built on a different wrapper is never
// prewarmed -- neither at creation nor by precompileFills -- and the probe would time a path no page takes.
const glR = new Proxy(
  {},
  {
    get(_t, k) {
      const v = gl[k];
      if (k === 'shaderSource')
        return (sh, src) => {
          shaderSrc.set(sh, src);
          return v(sh, src);
        };
      if (k === 'attachShader')
        return (p, sh) => {
          if (!progShaders.has(p)) progShaders.set(p, []);
          progShaders.get(p).push(sh);
          return v(p, sh);
        };
      return v;
    },
  },
);
const renderer = api.createRenderer(glR, sources);
const sections = await api.importSvg(svg);
const bundle = api.createBundle(glR, sections);
renderer.setBundle(bundle);
// PRECOMPILE=1: renderer.precompileFills() after setBundle, the documented load-time warm (a no-op where absent).
if (process.env.PRECOMPILE && renderer.precompileFills) renderer.precompileFills();
// ENTRY=draw: the app entry (beginFrame + drawBundle + endFrame) instead of the bench's renderer.render().
const frame =
  process.env.ENTRY === 'draw'
    ? () => {
        renderer.beginFrame();
        renderer.drawBundle(bundle);
        renderer.endFrame();
      }
    : () => renderer.render();
// Per measured frame: the fill program each draw used, by its #define set (REAL=1 only; the tagged sources carry none).
const progDefs = new Map();
const definesOf = (p) => {
  if (!progDefs.has(p)) {
    const src = (progShaders.get(p) || []).map((sh) => shaderSrc.get(sh) || '').join('\n');
    progDefs.set(
      p,
      [...src.matchAll(/^#define (MANTLE_\w+)/gm)]
        .map((m) => m[1])
        .sort()
        .join('|') || '(base: no defines)',
    );
  }
  return progDefs.get(p);
};
// YIELD=1: yield to the event loop after every warm frame, as an app between rAF callbacks does -- the off-thread
// builds (Loop-Blinn meshes, the occupancy grid, the occlusion cull) land then (in node they run as deferred tasks),
// which a synchronous benchmark loop never lets happen.
for (let i = 0; i < WARM; i++) {
  F.setFrame(i);
  tick();
  frame();
  if (process.env.YIELD) await new Promise((r) => setTimeout(r, 0));
}
recording = true;
const t0 = realNow();
for (let i = 0; i < FRAMES; i++) {
  F.setFrame(WARM + i);
  if (i === FRAMES - 1 && process.env.CALLS) tracing = true;
  tick();
  frame();
}
const ms = (realNow() - t0) / FRAMES;
if (PROOF) {
  // Join each tracked draw with the fake's own draw record (framebuffer, textures per unit, scissor), in order.
  const fakeDraws = F.log.filter((e) => e.op === 'draw');
  if (fakeDraws.length !== drawStates.length)
    console.log(`  PROOF: draw records disagree (${fakeDraws.length} vs ${drawStates.length})`);
  const perFrame = new Map();
  fakeDraws.forEach((e, i) => {
    if (e.frame < WARM) return;
    const d = drawStates[i];
    const full = d.key + JSON.stringify([idOf(e.fbo), e.units.map(idOf), e.sc, e.count]);
    if (!perFrame.has(e.frame)) perFrame.set(e.frame, { progs: [], keys: [] });
    perFrame.get(e.frame).progs.push(e.prog);
    perFrame.get(e.frame).keys.push(full);
  });
  // Frames grouped by the draw-state sequence, program set aside.
  const groups = new Map();
  for (const [f, v] of perFrame) {
    const k = v.keys.join('\n');
    if (!groups.has(k)) groups.set(k, { frames: [], progs: new Set() });
    const g = groups.get(k);
    g.frames.push(f);
    for (const p of v.progs) g.progs.add(process.env.REAL ? definesOf(p) : idOf(p));
  }
  console.log(
    `  PROOF: ${perFrame.size} measured frames fall into ${groups.size} distinct draw-state sequence(s)`,
  );
  // More than one sequence: what the first frame of each did, in order (clears, blits, draws with their scissor), and
  // whether a minority frame's draws are the majority's, state for state, once its leading 1-pixel pipeline-warm
  // draws (scissor 0,0,1,1, issued before the frame's clear) are set aside.
  const major = [...groups.entries()].sort((p, q) => q[1].frames.length - p[1].frames.length)[0];
  if (groups.size > 1)
    for (const [k, g] of groups) {
      const f = Math.min(...g.frames);
      const ev = F.log.filter((e) => e.frame === f);
      let note = '';
      if (k !== major[0]) {
        const keys = perFrame.get(f).keys;
        let warm = 0;
        for (const e of ev) {
          if (e.op !== 'draw' || !e.sc || e.sc.join() !== '0,0,1,1') break;
          warm++;
        }
        note = `  -- after ${warm} warm draw(s), the majority's draws state for state: ${keys.slice(warm).join('\n') === major[0] ? 'YES' : 'NO'}`;
      }
      console.log(
        `    frame ${f - WARM}, in order: ` +
          ev
            .map(
              (e) =>
                `${e.op}${e.op === 'draw' ? '(' + e.count + (e.sc ? ' sc ' + e.sc.join(',') : '') + (e.fbo ? ' fbo' : '') + ')' : ''}`,
            )
            .join(' ') +
          note,
      );
    }
  for (const g of groups.values())
    console.log(
      `    frames ${Math.min(...g.frames) - WARM}..${Math.max(...g.frames) - WARM} (${g.frames.length}): programs ${[...g.progs].join(' ; ').slice(0, 300)}`,
    );
  if (process.env.PROOF_OUT) {
    const fs = await import('fs');
    fs.writeFileSync(process.env.PROOF_OUT, JSON.stringify([...groups.keys()]));
  }
}
if (process.env.REAL) {
  const byProg = new Map();
  let firstLean = -1;
  for (const e of F.log) {
    if (e.op !== 'draw' || e.frame < WARM) continue;
    const k = definesOf(e.prog);
    if (!byProg.has(k)) byProg.set(k, new Set());
    byProg.get(k).add(e.frame);
  }
  for (const [k, fr] of byProg)
    console.log(
      `  program ${k}: drew in ${fr.size} of ${FRAMES} measured frames (first ${Math.min(...fr) - WARM}, last ${Math.max(...fr) - WARM})`,
    );
}
recording = false;
const per = (m) =>
  Object.fromEntries(
    [...m].sort((p, q) => q[1] - p[1]).map(([k, v]) => [k, +(v / FRAMES).toFixed(2)]),
  );
const groups = {
  program: ['useProgram'],
  uniform: [],
  texBind: ['bindTexture', 'activeTexture'],
  bufBind: ['bindBuffer', 'bindVertexArray', 'bindBufferBase', 'bindBufferRange'],
  upload: [
    'bufferData',
    'bufferSubData',
    'texImage2D',
    'texSubImage2D',
    'texImage3D',
    'texSubImage3D',
  ],
  draw: ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced'],
  fbo: [
    'bindFramebuffer',
    'bindRenderbuffer',
    'framebufferTexture2D',
    'framebufferRenderbuffer',
    'blitFramebuffer',
    'readPixels',
  ],
  clear: ['clear', 'clearColor', 'clearDepth', 'clearStencil', 'clearBufferfv'],
  query: ['beginQuery', 'endQuery', 'getQueryParameter', 'createQuery', 'deleteQuery'],
};
const g = {};
let total = 0;
for (const [k, v] of counts) {
  total += v;
  let grp = 'state';
  if (k.startsWith('uniform')) grp = 'uniform';
  else
    for (const [name, list] of Object.entries(groups))
      if (list.includes(k)) {
        grp = name;
        break;
      }
  g[grp] = (g[grp] || 0) + v;
}
const lastDraws = F.log.filter((e) => e.op === 'draw' && e.frame === WARM + FRAMES - 1);
const drawsPerFrame = lastDraws.length;
console.log(
  `${path.basename(svgArg)} @ ${path.relative(path.resolve(OWN, '../..'), TREE) || TREE}: ${ms.toFixed(4)} ms/frame JS (node, fake GL), ${(total / FRAMES).toFixed(1)} GL calls/frame, ${drawsPerFrame} draws in the last frame`,
);
console.log(
  '  by group:',
  JSON.stringify(
    Object.fromEntries(
      Object.entries(g)
        .sort((p, q) => q[1] - p[1])
        .map(([k, v]) => [k, +(v / FRAMES).toFixed(2)]),
    ),
  ),
);
console.log('  by call :', JSON.stringify(per(counts)));
// TOTALS=1: whole-run counts, for the one-off calls (links, compiles, status polls) a per-frame average rounds away.
if (process.env.TOTALS)
  console.log(
    '  totals  :',
    JSON.stringify(Object.fromEntries([...counts].sort((p, q) => q[1] - p[1]))),
  );
if (bytes.size) console.log('  bytes   :', JSON.stringify(per(bytes)));
if (process.env.CALLS) console.log('  last frame, in order:\n    ' + order.join('\n    '));
if (process.env.SHADERS) {
  const fs = await import('fs');
  fs.mkdirSync(process.env.SHADERS, { recursive: true });
  const seen = new Map();
  lastDraws.forEach((d, i) => {
    if (seen.has(d.prog)) return;
    seen.set(d.prog, i);
    (progShaders.get(d.prog) || []).forEach((sh, j) => {
      const src = shaderSrc.get(sh) || '';
      fs.writeFileSync(
        path.join(
          process.env.SHADERS,
          `draw${i}_${/gl_FragColor|out\s+(highp\s+|mediump\s+|lowp\s+)?vec4\s+\w+\s*;/.test(src) && !/gl_Position/.test(src) ? 'frag' : 'vert'}.glsl`,
        ),
        src,
      );
    });
  });
  console.log(`  wrote ${seen.size} program(s) to ${process.env.SHADERS}`);
}
if (process.env.DRAWS)
  console.log(
    '  last frame draws (vertex count, program keys):',
    lastDraws.map((d) => `${d.count} ${[...F.progKeys(d.prog)].join('+')}`).join(' | '),
  );
if (process.env.STATS && renderer.debugStats)
  console.log('  debugStats:', JSON.stringify(renderer.debugStats).slice(0, 1500));
process.exit(0);
