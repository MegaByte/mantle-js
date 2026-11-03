// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _cpatchMorphPaired — compare CPatch morph configurations WITHIN one process, paired and rotated.
//
// A subtraction between separate runs is not a measurement on this machine: identical configs
// can read 40% apart minutes apart, and one arm can range nearly 2x in a session. Differences
// worth a decision are smaller than that, so
// they drowned — and a decomposition got published that its own evidence did not support.
//
// Two things fix it, and both are needed:
//
//   PAIRING — every configuration is built once, in one page, on one context, and measured in the
//   same round. Drift between rounds is then COMMON MODE: it moves every arm together and cancels
//   in the within-round difference. The reported statistic is the median of per-round differences,
//   not the difference of per-arm medians.
//
//   ROTATION — order matters. The first arm in a round pays for caches the others then find warm,
//   and a GPU that is ramping favors whoever runs last. So round r starts at arm r % n and each
//   arm occupies every position an equal number of times. Without this, pairing just converts a
//   drift artifact into a stable, repeatable, wrong answer.
//
// The order effect is reported, not assumed away: `by position` shows each arm's median for each
// slot it ran in. If those differ by more than the effect being measured, nothing here is safe to
// read and the run should be thrown out rather than interpreted.
// FOUR CLOCKS, AND WHAT each ONE IS WORTH. Measured at 512 and 1024 so none of this is a
// one-run story:
//
//   cpu    submit only, sampled before any sync.
//   wall   includes gl.finish(), and comes out IDENTICAL to cpu for every arm. gl.finish() does
//          not sync on this setup. Kept only as standing evidence of that.
//   sync   includes gl.readPixels, which cannot be deferred. This is elapsed time.
//   gpu    EXT_disjoint_timer_query.
//
// On arms with NO render-target passes the two real clocks AGREE: sync minus gpu is a constant
// +0.024..0.028ms at both resolutions — the readPixels round trip amortised over the batch,
// independent of how much shading happened.
//
// WHY gpu EXCEEDS sync WHEN PASSES EXIST (ARMS=passes measures this directly; slug's setT runs
// two and dupCurveLerp adds more of the same one):
//
//   passes   gpu     sync    error
//     0      0.199   0.240   -0.041
//     2      0.927   0.367   +0.561
//     3      1.059   0.370   +0.689
//     4      1.100   0.377   +0.723
//     6      1.221   0.443   +0.777
//
// The error is NOT proportional to the count. It STEPS by ~0.6ms the moment any pass exists and
// then rises only ~0.054ms per additional one; a line fitted through 2..6 extrapolates to +0.45
// at zero passes, where the real figure is -0.04. So this is not per-pass accounting.
//
// A duration can only exceed the elapsed time it happened in if it is a SUM OF OVERLAPPING
// intervals. A frame with no pass is one command encoder and the timestamp pair brackets
// contiguous work — accurate. Add a pass and the frame becomes several encoders; the query is
// then composed across them, and summing spans that overlap in time gives a total larger than
// the wall interval that contained them. The step is entering that regime; the slope is each
// further encoder.
//
// The practical consequence, and the reason this matters beyond curiosity: the timer charges
// ~0.5ms per frame to any engine that uses a pre-pass and nothing to one that does not. That is
// a large thumb on the scale of exactly the comparison probes/_balanceBench.mjs makes.
//
// AND THE ONE THAT BREAKS held-versus-micro. The heavier arm finishes FASTER in elapsed time:
//
//   N=1024 slug   held 0.725 -> micro 0.565    22% faster with MORE work
//   N=1024 cp     held 0.270 -> micro 0.250     7% faster
//   N=512  slug   held 0.213 -> micro 0.203     5% faster
//
// The GPU clocks up under load, so comparing arms of DIFFERENT WEIGHT by elapsed time is
// confounded — and held-versus-micro differ in weight by construction. CPatch's machinery read
// +0.085ms at 512 and NEGATIVE at 1024; that is a clock-state artifact with a resolution-
// dependent sign, not a measurement. Until every arm presents the same total load (pad the
// lighter one with dummy work), no held-versus-micro number from this file should be quoted.
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = +(process.env.N || 512);
const REPS = +(process.env.REPS || 24); // rounds; every arm runs once per round
const BATCH = +(process.env.BATCH || 0); // 0 = size it from a probe frame
// BALLAST equalises the LOAD every arm presents, which is the only way an elapsed-time
// comparison between arms of different weight means anything on a GPU that changes speed with
// load. Every arm draws the same ballast every frame, so it cancels in the paired difference —
// what it buys is a steady clock, not a number.
const BALLAST = +(process.env.BALLAST || 0);
const PAIRS = {
  near: [
    'M20 4 C31 4 36 9 36 20 C36 31 31 36 20 36 C9 36 4 31 4 20 C4 9 9 4 20 4 Z',
    'M20 5 C30 5 35 10 35 20 C35 30 30 35 20 35 C10 35 5 30 5 20 C5 10 10 5 20 5 Z',
  ],
  wide: [
    'M20 4 C31 4 36 9 36 20 C36 31 31 36 20 36 C9 36 4 31 4 20 C4 9 9 4 20 4 Z',
    'M20 8 C28 2 34 10 33 20 C32 30 28 34 20 33 C11 32 6 28 7 20 C8 10 12 2 20 8 Z',
  ],
  quad: [
    'M20 4 Q36 4 36 20 Q36 36 20 36 Q4 36 4 20 Q4 4 20 4 Z',
    'M20 7 Q33 3 34 20 Q35 33 20 34 Q7 35 6 20 Q5 7 20 7 Z',
  ],
};
const [A, B] = PAIRS[process.env.PAIR || 'near'] || PAIRS.near;
const svg = (d) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><path d="${d}" fill="#fff"/></svg>`;

// The configurations under test. Each is one renderer + one morph, built once and reused.
// THE DECOMPOSITION, as arms of one paired run rather than a subtraction between runs:
//   static      the CPatch STATIC path drawing pose A. No morph anywhere.
//   morph-held  a morph whose t never moves, so setT returns early and no per-frame machinery
//               runs at all — this is the morph's DRAW, and nothing else.
//   morph-move  the same morph with t moving every frame.
// morph-held minus static is the draw difference; morph-move minus morph-held is the machinery.
// Geometry is printed per arm because the two paths do NOT decompose the same shape the same
// way, and a ratio between different geometry is not a finding about morphing.
const ARMS =
  process.env.ARMS === 'engine'
    ? [
        { name: 'pack', opts: { gpuBlend: false, skipPaintUploads: false } },
        { name: 'blend', opts: { gpuBlend: true, skipPaintUploads: false } },
        { name: 'blend+noup', opts: { gpuBlend: true, skipPaintUploads: true } },
      ]
    : process.env.ARMS === 'engines'
      ? [
          // THE same held/move split on every morph engine. If the additive per-frame cost is CPatch's
          // own, Slug and LB show a small move-minus-held and CPatch a large one; if they all show it,
          // it belongs to shapeMorph and every engine has been paying it.
          // THREE arms per engine, because held-vs-move alone conflates two things. `micro` moves t by a
          // nanometre: setT runs in FULL, but the pose is the same one `held` draws. So
          //   micro - held = the per-frame MACHINERY, at a fixed pose
          //   move  - micro = how much the fill itself depends on WHICH pose
          // Without micro, LB read as FASTER when moving — not because its machinery is negative, but
          // because t=0.5 happens to be a costlier pose than the sweep's average.
          { name: 'slug-held', kind: 'morph', engine: 'slug', hold: true },
          { name: 'slug-micro', kind: 'morph', engine: 'slug', micro: true, vs: 'slug-held' },
          { name: 'slug-move', kind: 'morph', engine: 'slug', vs: 'slug-micro' },
          { name: 'lb-held', kind: 'morph', engine: 'lb', hold: true },
          { name: 'lb-micro', kind: 'morph', engine: 'lb', micro: true, vs: 'lb-held' },
          { name: 'lb-move', kind: 'morph', engine: 'lb', vs: 'lb-micro' },
          { name: 'cp-held', kind: 'morph', engine: 'cpatch', hold: true },
          { name: 'cp-micro', kind: 'morph', engine: 'cpatch', micro: true, vs: 'cp-held' },
          { name: 'cp-move', kind: 'morph', engine: 'cpatch', vs: 'cp-micro' },
        ]
      : process.env.ARMS === 'unit'
        ? [
            // Does parking the paint upload on the UNSHADOWED scratch unit actually pay? Same pose, same
            // work, the only difference being which unit it binds on and therefore whether the fill pass
            // has to re-bind all fifteen of its samplers on the next draw.
            { name: 'held', kind: 'morph', engine: 'cpatch', hold: true },
            {
              name: 'held+bump',
              kind: 'morph',
              engine: 'cpatch',
              hold: true,
              opts: { bumpEpoch: true },
              vs: 'held',
            },
            { name: 'micro', kind: 'morph', engine: 'cpatch', micro: true, vs: 'held' },
          ]
        : process.env.ARMS === 'slug'
          ? [
              // Slug's per-frame cost, split into pieces: price each piece by DUPLICATION, output-identical,
              // instead of guessing at the mechanism.
              { name: 'held', kind: 'morph', engine: 'slug', hold: true },
              { name: 'micro', kind: 'morph', engine: 'slug', micro: true, vs: 'held' },
              {
                name: 'micro+4crv',
                kind: 'morph',
                engine: 'slug',
                micro: true,
                dupCurve: 4,
                vs: 'micro',
              },
              {
                name: 'micro-gpu',
                kind: 'morph',
                engine: 'slug',
                micro: true,
                gpuPlanes: true,
                vs: 'micro',
              },
            ]
          : process.env.ARMS === 'passes'
            ? [
                // HOW THE TIMER'S ERROR SCALES WITH RENDER-TARGET PASSES. Slug's setT runs two (curve + meta);
                // dupCurveLerp adds more of exactly the same pass. Held runs none. If the timer's excess over
                // true elapsed time is a fixed charge PER PASS, gpu-minus-sync is linear in the count with a
                // zero intercept; if the first pass costs something the rest do not, there is an intercept.
                { name: 'p0-held', kind: 'morph', engine: 'slug', hold: true },
                { name: 'p2-micro', kind: 'morph', engine: 'slug', micro: true, vs: 'p0-held' },
                {
                  name: 'p3',
                  kind: 'morph',
                  engine: 'slug',
                  micro: true,
                  dupCurve: 1,
                  vs: 'p2-micro',
                },
                {
                  name: 'p4',
                  kind: 'morph',
                  engine: 'slug',
                  micro: true,
                  dupCurve: 2,
                  vs: 'p2-micro',
                },
                {
                  name: 'p6',
                  kind: 'morph',
                  engine: 'slug',
                  micro: true,
                  dupCurve: 4,
                  vs: 'p2-micro',
                },
              ]
            : process.env.ARMS === 'cpuplanes'
              ? [
                  // Does lerping CPatch's small paint plane on the CPU pay? It works by REMOVING a render-target
                  // pass, which is the one kind of change the GPU clock over-credits (by ~0.5ms a frame), so it is
                  // asked on sync, with ballast.
                  { name: 'cp-cpu-planes', kind: 'morph', engine: 'cpatch' },
                  {
                    name: 'cp-gpu-planes',
                    kind: 'morph',
                    engine: 'cpatch',
                    opts: { skipPaintUploads: false },
                    vs: 'cp-cpu-planes',
                  },
                ]
              : process.env.ARMS === 'cpdecomp'
                ? [
                    // WHERE CPatch's per-frame cost GOES, each piece isolated against the same idle baseline, on
                    // sync with ballast. held runs neither setT nor the blend; the middle two add exactly one thing
                    // each, output-identical; micro is everything.
                    { name: 'held', kind: 'morph', engine: 'cpatch', hold: true },
                    {
                      name: 'held+bump',
                      kind: 'morph',
                      engine: 'cpatch',
                      hold: true,
                      opts: { bumpEpoch: true },
                      vs: 'held',
                    },
                    {
                      name: 'held+blend',
                      kind: 'morph',
                      engine: 'cpatch',
                      hold: true,
                      opts: { forceBlend: true },
                      vs: 'held',
                    },
                    {
                      name: 'micro',
                      kind: 'morph',
                      engine: 'cpatch',
                      micro: true,
                      ping: 1,
                      vs: 'held',
                    },
                    // setT with its meta update removed. If the 0.140 is that write, this collapses toward held.
                    {
                      name: 'micro-nometa',
                      kind: 'morph',
                      engine: 'cpatch',
                      micro: true,
                      noMeta: true,
                      vs: 'held',
                    },
                    // The write moved off the texture the last frame is still reading. Output-IDENTICAL, unlike
                    // nometa: the same floats are written, just not on top of a live read.
                    {
                      name: 'micro-ping2',
                      kind: 'morph',
                      engine: 'cpatch',
                      micro: true,
                      ping: 2,
                      vs: 'micro',
                    },
                    {
                      name: 'micro-ping3',
                      kind: 'morph',
                      engine: 'cpatch',
                      micro: true,
                      ping: 3,
                      vs: 'micro',
                    },
                    {
                      name: 'micro-ping8',
                      kind: 'morph',
                      engine: 'cpatch',
                      micro: true,
                      ping: 8,
                      vs: 'micro',
                    },
                  ]
                : process.env.ARMS === 'blend'
                  ? [
                      // GPU BLEND vs CPU PACK-AND-UPLOAD. The timer over-credits dropping a pass by ~0.5ms/frame. The
                      // blend IS a pass, and a pass writing a texture the draw then samples is a read-after-write
                      // barrier. On sync, with ballast, does it still win?
                      { name: 'held', kind: 'morph', engine: 'cpatch', hold: true },
                      { name: 'move-blend', kind: 'morph', engine: 'cpatch', vs: 'held' },
                      {
                        name: 'move-pack',
                        kind: 'morph',
                        engine: 'cpatch',
                        opts: { gpuBlend: false },
                        vs: 'held',
                      },
                    ]
                  : process.env.ARMS === 'infill'
                    ? [
                        // Would evaluating the degree-2 blend IN THE FILL beat the pre-pass? blend3 pulls exactly the
                        // fetch traffic that would need — three coefficient fetches per curve instead of one — while
                        // rendering identically. If (blend3 - move) is under the pass's +0.187, the real thing wins.
                        { name: 'held', kind: 'morph', engine: 'cpatch', hold: true },
                        { name: 'move', kind: 'morph', engine: 'cpatch', vs: 'held' },
                        {
                          name: 'move-blend3',
                          kind: 'morph',
                          engine: 'cpatch',
                          defines: ['MANTLE_CPATCH_BLEND3'],
                          vs: 'move',
                        },
                      ]
                    : process.env.ARMS === 'many'
                      ? [
                          // SEVERAL morphs in one frame, which is the case the deferral exists for. Interleaving prepare
                          // and draw gives every bundle its own write-to-read transition; deferring every coefficient
                          // pass to the frame's first fill makes them share one.
                          {
                            name: 'n4-immediate',
                            kind: 'morph',
                            engine: 'cpatch',
                            morphs: 4,
                            opts: { deferBlends: false },
                          },
                          {
                            name: 'n4-deferred',
                            kind: 'morph',
                            engine: 'cpatch',
                            morphs: 4,
                            vs: 'n4-immediate',
                          },
                        ]
                      : process.env.ARMS === 'machinery'
                        ? [
                            // WHAT the per-frame machinery is, priced by DUPLICATION so every arm renders the same thing.
                            // An extra setT lands on the same final t; an extra prepareBundle finds the pose already
                            // current and re-runs the blend into the same rows. Delta over the base arm is one call.
                            { name: 'move', kind: 'morph' },
                            { name: 'move+setT', kind: 'morph', dupSetT: 1 },
                            { name: 'move+prep', kind: 'morph', dupPrep: 1 },
                          ]
                        : [
                            { name: 'static', kind: 'static' },
                            { name: 'morph-held', kind: 'morph', hold: true },
                            { name: 'morph-move', kind: 'morph' },
                          ];

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
globalThis.__MANTLE_DEBUG__ = true;   // createRenderer's fillDefines is a test hook, read only under it
import { importSvg, createBundle, createShapeMorph, createRenderer, loadShaders } from '/src/index.js';
import { noteExternalGlWrite as noteExternal } from '/src/core/glEpoch.js';
const S = ${N}, ROUNDS = ${REPS}, BALLAST = ${BALLAST};
const SYNC_EVERY = ${JSON.stringify(process.env.SYNCEVERY === '1')};
const ARMS = ${JSON.stringify(ARMS)};
const gl = document.getElementById('c').getContext('webgl2',
  { antialias: false, depth: true, premultipliedAlpha: true, preserveDrawingBuffer: false });
const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
const pct = (a, p) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

// ---- ballast: identical work in every arm, to pin the GPU's clock ------------------------------
let ballast = null;
if (BALLAST > 0) {
  const sh = (type, src) => { const o = gl.createShader(type); gl.shaderSource(o, src); gl.compileShader(o);
    if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error('ballast: ' + gl.getShaderInfoLog(o));
    return o; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER,
    '#version 300 es\\nlayout(location=0) in vec2 a; void main(){ gl_Position = vec4(a,0.0,1.0); }'));
  // Enough ALU that the fragment cost is real, and dependent on gl_FragCoord so it cannot be
  // hoisted or folded to a constant.
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER,
    '#version 300 es\\nprecision highp float; uniform float uK; out vec4 o; void main(){'
    + ' float v = uK + gl_FragCoord.x * 1e-4 + gl_FragCoord.y * 1e-4;'
    + ' for (int i = 0; i < 64; i++) v = fract(sin(v * 12.9898 + float(i)) * 43758.5453);'
    + ' o = vec4(v, v, v, 1.0); }'));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('ballast link: ' + gl.getProgramInfoLog(prog));
  const vao = gl.createVertexArray(), vb = gl.createBuffer();
  gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, vb);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  const uK = gl.getUniformLocation(prog, 'uK');
  let k = 0;
  ballast = () => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, S, S);
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.SCISSOR_TEST);
    gl.useProgram(prog); gl.bindVertexArray(vao);
    for (let i = 0; i < BALLAST; i++) { gl.uniform1f(uK, (k = (k + 1) & 1023) / 1024); gl.drawArrays(gl.TRIANGLES, 0, 3); }
    gl.bindVertexArray(null);
    noteExternal();
  };
}

// ---- build every arm up front, on the one context -------------------------------------------
const built = [];
for (const arm of ARMS) {
  const eng = arm.engine || 'cpatch';
  const r = createRenderer(gl, shaders,
    eng === 'cpatch' ? { cpatchFill: true, cpatchOpts: { interiorN: 8, ...(arm.opts || {}) }, aacFill: false, unifiedMorph: true,
                         ...(arm.defines ? { fillDefines: arm.defines } : {}) }
    : eng === 'lb' ? { aacFill: false, unifiedMorph: true }
    : { aacFill: false });
  r.setLoopBlinnFill(eng === 'slug' ? 'off' : 'on');
  let b, frame, morph = null, all = [];
  if (arm.kind === 'static') {
    b = createBundle(gl, await importSvg(${JSON.stringify(svg(A))}));
    if (r.prepareBundle) { try { r.prepareBundle(b); } catch {} }
    frame = () => { r.setViewport(S, S); r.beginFrame([0, 0, 0, 1]); r.drawBundle(b, {}); r.endFrame(); };
    frame();
    if (r.awaitLbReady) { try { await r.awaitLbReady(b, 20000); } catch {} }
  } else {
    const nM = arm.morphs || 1;
    for (let m = 0; m < nM; m++)
      all.push(createShapeMorph(gl, createBundle(gl, await importSvg(${JSON.stringify(svg(A))})),
                                    createBundle(gl, await importSvg(${JSON.stringify(svg(B))}))));
    morph = all[0];
    b = morph.bundle || morph;
    let k = 0;
    const dupSetT = arm.dupSetT | 0, dupPrep = arm.dupPrep | 0;
    frame = () => {
      k = (k + 1) & 1023;
      const t = arm.hold ? 0.5 : arm.micro ? 0.5 + 1e-9 * (k & 1) : 0.15 + 0.7 * (k / 1023);
      // Extra calls FIRST, at a t a nanometre away, so the last setT always lands on t and the
      // pose drawn is identical to the base arm's.
      for (let d = 0; d < dupSetT; d++) morph.setT(t + 1e-9 * (d + 1));
      morph.setT(t);
      if (r.prepareBundle) {
        for (let d = 0; d < dupPrep; d++) { try { r.prepareBundle(b); } catch {} }
        try { r.prepareBundle(b); } catch {}
      }
      r.setViewport(S, S); r.beginFrame([0, 0, 0, 1]); r.drawBundle(morph, {}); r.endFrame();
    };
    if (arm.dupCurve) b._morphSrc.dupCurveLerp = arm.dupCurve | 0;
    if (arm.gpuPlanes) b._morphSrc.gpuSmallPlanes = true;
    if (arm.noMeta) for (const mm of all) (mm.bundle || mm)._morphSrc.skipMetaLerp = true;
    if (arm.ping) for (const mm of all) (mm.bundle || mm)._morphSrc.metaPingPong = arm.ping;
    // Let the certificate land before this arm is ever timed.
    // DRIVE EVERY BUNDLE, EVERY ITERATION, and wait on undefined as well as 'pending'. A plan is
    // requested BY prepareBundle, so a bundle that has not been prepared yet reads undefined
    // and a loop that waits only on 'pending' exits before it has asked — which is how three of
    // four morphs silently stayed off the CPatch route while the arm reported success.
    for (const mm of all) mm.setT(0);
    if (eng === 'cpatch') {
      for (let i = 0; i < 1200; i++) {
        let pend = false;
        for (const mm of all) {
          const bb = mm.bundle || mm;
          if (r.prepareBundle) { try { r.prepareBundle(bb); } catch {} }
          const pl = bb._cpatchMorphPlan;
          if (pl === undefined || pl === 'pending') pend = true;
        }
        if (!pend) break;
        await sleep(25);
      }
    } else {
      for (const mm of all) if (r.prepareBundle) { try { r.prepareBundle(mm.bundle || mm); } catch {} }
    }
    frame();
    if (r.awaitLbReady) { try { await r.awaitLbReady(morph, 20000); } catch {} }
  }
  for (let i = 0; i < 40; i++) { frame(); if (r.precompileFills) { try { r.precompileFills(); } catch {} } await sleep(0); }
  built.push({ arm, r, morph, b, all, frame, gpu: [], cpu: [], wall: [], sync: [], draws: [], byPos: ARMS.map(() => []) });
}

// One batch size for EVERY arm — a per-arm batch would make the arms differ by more than the
// thing under test.
let batch = ${BATCH};
if (!batch) {
  const t0 = performance.now(); built[0].frame(); gl.finish();
  const one = performance.now() - t0;
  batch = Math.max(4, Math.min(240, Math.round(1.0 / Math.max(one, 0.002))));
}

const onePx = new Uint8Array(4);
const drawsOf = (e) => ((e.r.debugStats && e.r.debugStats.unifiedFillDraws) | 0)
                     + ((e.r.debugStats && e.r.debugStats.slugDraws) | 0)
                     + ((e.r.debugStats && e.r.debugStats.aacDraws) | 0);

const timeOne = async (e) => {
  // DRAIN AND WARM before the clock starts. Without this an arm inherits whatever the previous
  // one left in flight, and the effect is not uniform: the static arm read 0.007ms leading a
  // round and 0.065 elsewhere — a tenfold swing that is the harness, not the renderer. A few
  // untimed frames also put this arm's own caches in the state the timed ones will find.
  for (let w = 0; w < 3; w++) { e.frame(); if (ballast) ballast(); }
  gl.finish();
  // DRAWS, not just time. An arm whose frame never changes can have its draw skipped by a
  // redundancy gate, and then a near-zero reading is "it did nothing", not "it got faster".
  const d0 = drawsOf(e);
  let q = null;
  if (ext) { q = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, q); }
  // THREE CLOCKS, because moving work between them is exactly what these arms do and a GPU
  // number alone would score that as free. cpu = submit, taken BEFORE the finish so the GPU is
  // still running; wall = the whole batch including the wait, which is what a frame actually
  // costs. A change that only moves work from one clock to the other shows up in gpu and cpu and
  // NOT in wall.
  const tA = performance.now();
  for (let f = 0; f < batch; f++) {
    e.frame(); if (ballast) ballast();
    // SHALLOW PIPELINE — AND IT DOES NOT WORK. The intent was sound: batching frames before a
    // sync lets the GPU fall arbitrarily far behind, which makes write-after-read hazards look
    // worse than they are in a loop that presents every frame, so syncing each frame should
    // emulate the real depth. But a per-frame readPixels costs ~1.6ms and the effects here are
    // ~0.1ms, so it drowns them: two consecutive runs put the same three arms at -0.020/-0.175/
    // -0.045 and then +0.110/+0.120/+0.165. Kept only so the next person does not rebuild it.
    //
    // Measuring the shallow case honestly needs a loop that PRESENTS — rAF-driven, timed by frame
    // pacing or by how much work fits in a frame — not a sync bolted onto a batch.
    if (SYNC_EVERY) gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, onePx);
  }
  if (ext) gl.endQuery(ext.TIME_ELAPSED_EXT);
  const tB = performance.now();
  gl.finish();
  const tC = performance.now();
  // A REAL SYNC. gl.finish() is supposed to block until everything completes, and here it returns
  // in about the time the submit loop took — so either the GPU genuinely kept up, or finish is
  // not forcing what it claims. readPixels cannot be deferred: it has to produce bytes, so every
  // command before it must have run. If sync >> wall, finish was lying and wall is submit time.
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, onePx);
  const tD = performance.now();
  e.cpu.push((tB - tA) / batch);
  e.wall.push((tC - tA) / batch);
  e.sync.push((tD - tA) / batch);
  if (!q) return null;
  for (let p = 0; p < 2000 && !gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE); p++) await sleep(0);
  let v = null;
  if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) && !gl.getParameter(ext.GPU_DISJOINT_EXT))
    v = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6 / batch;
  gl.deleteQuery(q);
  e.draws.push((drawsOf(e) - d0) / batch);
  return v;
};

// ---- rounds, rotated ------------------------------------------------------------------------
const rounds = [];
for (let round = 0; round < ROUNDS; round++) {
  const one = {};
  for (let pos = 0; pos < built.length; pos++) {
    const e = built[(round + pos) % built.length];       // ROTATION: arm r % n leads round r
    const v = await timeOne(e);
    if (v != null) {
      e.gpu.push(v); e.byPos[pos].push(v);
      one[e.arm.name] = { gpu: v, cpu: e.cpu[e.cpu.length - 1], wall: e.wall[e.wall.length - 1], sync: e.sync[e.sync.length - 1] };
    }
    await sleep(1);
  }
  // A round only yields a difference if EVERY arm produced a sample in it.
  if (built.every((e) => one[e.arm.name] != null)) rounds.push(one);
}

window.__out = {
  curveWH: globalThis.__curveWH || '-',
  batch, timer: !!ext, rounds,
  arms: built.map((e) => ({ name: e.arm.name, gpu: median(e.gpu), lo: pct(e.gpu, 0.1), hi: pct(e.gpu, 0.9), n: e.gpu.length,
                            cpu: median(e.cpu), wall: median(e.wall), sync: median(e.sync),
                            byPos: e.byPos.map((a) => median(a)),
                            kind: (e.b._lbMeshes && e.b._lbMeshes[0]) ? (e.b._lbMeshes[0].kindMask | 0) : 0,
                            verts: (e.b._lbMeshes || []).reduce((a2, m) => a2 + (m ? (m.vertexCount | 0) : 0), 0),
                            meshes: (e.b._lbMeshes || []).filter(Boolean).length,
                            vs: e.arm.vs || null,
                            draws: median(e.draws),
                            reb: e.all && e.all.length > 1
                              ? e.all.map((mm) => ((mm.bundle || mm)._cpatchBuilt | 0)).join(',') : '-',
                            route: ((e.r.debugStats && e.r.debugStats.loopBlinnMorphRouteCount) | 0)
                                 + ((e.r.debugStats && e.r.debugStats.loopBlinnRouteCount) | 0),
                            cells: e.b._cpatchCells | 0,
                            // Curve BLOCKS behind the draw: what each fragment may have to walk.
                            blocks: e.b._cpatchMorphPlan && e.b._cpatchMorphPlan !== 'pending'
                              ? (e.b._cpatchMorphPlan.shapes || []).filter(Boolean)
                                  .reduce((a2, sh) => a2 + (sh.pack ? (sh.pack.curveBlocks | 0) : 0), 0)
                              : -1 })),
};
window.__ready = 1;
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(HTML);
    return;
  }
  try {
    const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
    const body = await import('fs').then((fs) => fs.readFileSync(p));
    const ct =
      p.endsWith('.js') || p.endsWith('.mjs')
        ? 'text/javascript'
        : p.endsWith('.json')
          ? 'application/json'
          : 'text/plain';
    res.writeHead(200, { 'Content-Type': ct });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('nope');
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const browser = await launchBrowser({
  headless: 'new',
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--use-angle=metal', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));
await page.goto(`http://localhost:${port}/`, { waitUntil: 'networkidle0' });
await page.waitForFunction('window.__ready === 1', { timeout: 540000 });
const o = await page.evaluate('window.__out');
await browser.close();
server.close();

const med = (a) => {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  return s[s.length >> 1];
};
console.log(
  `\nCPatch morph, PAIRED within one process, ${N}x${N}, batch ${o.batch}, ${o.rounds.length} complete rounds\n`,
);
console.log('  curve plane: ' + o.curveWH);
console.log(
  '  arm          |   gpu ms |   cpu ms |  wall ms |  sync ms |  gpu p10..p90    | draws/f',
);
for (const a of o.arms)
  console.log(
    `  ${a.name.padEnd(12)} | ${a.gpu.toFixed(3).padStart(8)} | ${a.cpu.toFixed(3).padStart(8)} | ` +
      `${a.wall.toFixed(3).padStart(8)} | ${a.sync.toFixed(3).padStart(8)} | ` +
      `${a.lo.toFixed(3)}..${a.hi.toFixed(3)}  | ${String(a.draws).padStart(7)} | ${a.reb || '-'}`,
  );

// ORDER EFFECT, reported rather than assumed away.
// THE ERROR ITSELF, per arm — the question this mode exists to answer.
console.log('\n  timer error (gpu minus sync), against the pass count in the arm name:');
for (const a of o.arms)
  console.log(
    `    ${a.name.padEnd(12)} gpu ${a.gpu.toFixed(3)}  sync ${a.sync.toFixed(3)}  ` +
      `error ${a.gpu - a.sync >= 0 ? '+' : ''}${(a.gpu - a.sync).toFixed(3)} ms   ratio ${(a.gpu / a.sync).toFixed(2)}x`,
  );
console.log(
  '\n  by position (median per slot — if these differ, order is confounding the result):',
);
for (const a of o.arms)
  console.log(
    `    ${a.name.padEnd(12)} ${a.byPos.map((v) => (v == null ? '  -  ' : v.toFixed(3))).join('  ')}`,
  );

// THE STATISTIC THAT MATTERS: differences taken inside a round, where drift is common mode.
// Each arm against its own baseline where it names one, otherwise against the first arm.
console.log('\n  paired differences (within-round):');
for (const a of o.arms) {
  const base = a.vs || (a.name === o.arms[0].name ? null : o.arms[0].name);
  if (!base) continue;
  const d = o.rounds.map((r) => r[a.name].gpu - r[base].gpu);
  const dc = o.rounds.map((r) => r[a.name].cpu - r[base].cpu);
  const dw = o.rounds.map((r) => r[a.name].wall - r[base].wall);
  const ds = o.rounds.map((r) => r[a.name].sync - r[base].sync);
  const wins = ds.filter((x) => x < 0).length;
  console.log(
    `    ${(a.name + ' - ' + base).padEnd(24)} gpu ${med(d) >= 0 ? '+' : ''}${med(d).toFixed(3)}   ` +
      `cpu ${med(dc) >= 0 ? '+' : ''}${med(dc).toFixed(3)}   wall ${med(dw) >= 0 ? '+' : ''}${med(dw).toFixed(3)}   ` +
      `sync ${med(ds) >= 0 ? '+' : ''}${med(ds).toFixed(3)} ms   sync faster in ${wins}/${ds.length} rounds`,
  );
}
function pctOf(a, p) {
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}
