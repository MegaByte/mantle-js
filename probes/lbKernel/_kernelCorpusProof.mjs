// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _kernelCorpusProof — that a chain of LB kernel builds is output-identical, proven through the whole-LB-pipeline
// emulator (test/_lbPipeEmu.mjs): the generated vertex AND fragment texts of a chain of builds, run over one corpus,
// every fragment compared BIT FOR BIT between consecutive builds and between the first and the last.
//
// The corpus, at CANVAS px (default 256), FINE derivatives:
//   12 static assets -- tiger, lbMemBudget, three stars, five arc assets, glyphs and the squircle, plus any
//   benchmark-corpus assets MANTLE_BENCH_NAMES names -- each in both stream layouts (wide, curve texture), with
//   and without a world matrix (rotate 25, scale 0.85), plus MANTLE_NO_BEZOUT where no mesh carries Bezout-tier data;
//   6 morph pairs in both layouts at t = 0.37 and 0.8 (the morph stream: pair packs, MANTLE_LB_MORPH, uMorphT).
// Every fragment of the draw is compared -- LB triangles and cover quads alike, since a vertex-stage change reaches
// both. A differing fragment count is a failure too (the vertex stage moved a triangle).
//
//   node probes/lbKernel/_kernelCorpusProof.mjs <label>=<vert.glsl>,<frag.glsl> ...     CANVAS=256 only=<substring>
//   (logs to stdout; the per-config table ends with one line per compared pair: fragments compared, differing)
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { lbScene, renderScene } from '../../test/_lbPipeScene.mjs';
import { benchNames, BENCH_UNSET } from '../../test/_assets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const N = +(process.env.CANVAS || 256);
const ONLY = process.env.ONLY || '';
// RESUME=<n>: skip the first n configurations (a run stopped between configurations picks up where it left off).
const RESUME = +(process.env.RESUME || 0);
// END=<n>: stop before configuration n (with RESUME, a slice of the corpus).
const END = process.env.END ? +process.env.END : Infinity;
const BUILDS = process.argv.slice(2).map((a) => {
  const [label, files] = a.split('=');
  const [v, f] = files.split(',');
  return { label, vt: readFileSync(v, 'utf8'), ft: readFileSync(f, 'utf8') };
});
if (BUILDS.length < 2) throw new Error('usage: <label>=<vert>,<frag> <label>=<vert>,<frag> ...');
console.warn = () => {};
const t0 = Date.now();
const lap = () => `${((Date.now() - t0) / 1000).toFixed(0)} s`;
const ex = (r) => path.join(ROOT, 'examples', r);
const STATIC = [
  ['tiger', ex('tiger.svg')],
  ['lbMemBudget', ex('smoke/lbMemBudget__SVG.svg')],
  ['star (engineDeclineIsolation)', ex('smoke/engineDeclineIsolation__STAR.svg')],
  ['star (lbAcuteCorner)', ex('smoke/lbAcuteCorner__STAR.svg')],
  ['star (noAaSelfCross)', ex('smoke/noAaSelfCross__wrap_STAR.svg')],
  ['lbArcCovSmall', ex('smoke/lbArcCovSmall__SVG.svg')],
  ['arcRebuildEquivariance', ex('smoke/arcRebuildEquivariance__ARC_SVG.svg')],
  ['noAaArcRow', ex('smoke/noAaArcRow__FIXTURE.svg')],
  ['lbRquadSeam', ex('smoke/lbRquadSeam__SVG.svg')],
  ['lbQuadSeam', ex('smoke/lbQuadSeam__SVG.svg')],
  ['glyphs', ex('smoke/entryPointRoute__GLYPHS.svg')],
  ['squircle', ex('smoke/lbCubicOverfill__wrap_SQUIRCLE.svg')],
  ...benchNames().map((n) => [n, ex(`_bench/${n}.svg`)]),
];
if (!benchNames().length) console.log(BENCH_UNSET);
const MORPH = [
  ['lbGpuMorph', 'lbGpuMorph__SRC.svg', 'lbGpuMorph__DST.svg'],
  ['lbMorphEvenOdd', 'lbMorphEvenOdd__SRC.svg', 'lbMorphEvenOdd__DST.svg'],
  ['loopBlinnMorph', 'loopBlinnMorph__SRC.svg', 'loopBlinnMorph__DST.svg'],
  ['morphGpuCurveLerp', 'morphGpuCurveLerp__SRC.svg', 'morphGpuCurveLerp__DST.svg'],
  [
    'morphIntervalSplit FLIP',
    'morphIntervalSplit__FLIP_SRC.svg',
    'morphIntervalSplit__FLIP_DST.svg',
  ],
  [
    'morphIntervalSplit STABLE',
    'morphIntervalSplit__STABLE_SRC.svg',
    'morphIntervalSplit__STABLE_DST.svg',
  ],
];
const th = (25 * Math.PI) / 180,
  sc0 = 0.85;
const ROT = [
  Math.cos(th) * sc0,
  Math.sin(th) * sc0,
  0,
  -Math.sin(th) * sc0,
  Math.cos(th) * sc0,
  0,
  0.05,
  -0.03,
  1,
];

// The configurations, lazily: [name, () => scene, extra defines].
const configs = [];
for (const [name, file] of STATIC) {
  if (!existsSync(file)) {
    console.log(`MISSING ${name}: ${path.relative(ROOT, file)}`);
    continue;
  }
  for (const layout of ['wide', 'curvetex'])
    for (const world of [null, ROT]) {
      configs.push({
        name: `${name} | ${layout}${world ? ' | world' : ''}`,
        make: async () => lbScene(readFileSync(file, 'utf8'), { N, layout, world }),
        defs: [],
      });
    }
  configs.push({
    name: `${name} | curvetex | NO_BEZOUT`,
    make: async () => lbScene(readFileSync(file, 'utf8'), { N, layout: 'curvetex' }),
    defs: ['MANTLE_NO_BEZOUT'],
    needNoBez: true,
  });
}
for (const [name, a, b] of MORPH)
  for (const layout of ['wide', 'curvetex'])
    for (const t of [0.37, 0.8]) {
      configs.push({
        name: `morph ${name} | ${layout} | t ${t}`,
        make: async () =>
          lbScene(readFileSync(ex('smoke/' + a), 'utf8'), {
            N,
            layout,
            morph: { svg: readFileSync(ex('smoke/' + b), 'utf8'), t },
          }),
        defs: [],
      });
    }

const f32 = new Float32Array(1),
  u32 = new Uint32Array(f32.buffer);
const bits = (x) => {
  f32[0] = x;
  return u32[0];
};
const pairs = [];
for (let k = 1; k < BUILDS.length; k++) pairs.push([k - 1, k]);
if (BUILDS.length > 2) pairs.push([0, BUILDS.length - 1]);
const tot = pairs.map(() => ({ frags: 0, lb: 0, diff: 0, cfgs: 0, bad: [] }));
const kindTot = {};
let cfgIdx = -1;
for (const cfg of configs) {
  if (ONLY && !cfg.name.includes(ONLY)) continue;
  if (++cfgIdx < RESUME) continue;
  if (cfgIdx >= END) break;
  let sc;
  try {
    sc = await cfg.make();
  } catch (e) {
    console.log(`SKIP ${cfg.name}: ${e.message}`);
    continue;
  }
  if (cfg.needNoBez) {
    const bez = sc.entries.some(
      (e) =>
        e.kind === 'lb' && sc.lb.packed[e.shapeIdx] && sc.lb.packed[e.shapeIdx].hasBezout !== false,
    );
    if (bez) continue;
  }
  const runs = BUILDS.map((b) => renderScene(sc, b.vt, b.ft, cfg.defs));
  const R0 = runs[0],
    ko = R0.vert.outOff[R0.vert.io.outs.findIndex((o) => o.name === 'vKind')];
  const lbOff = R0.vert.outOff[R0.vert.io.outs.findIndex((o) => o.name === 'vLB0')];
  const kindOf = (t) => Math.floor(R0.vOut[(t * 3 + 2) * R0.vert.outN + ko] + 1e-4);
  const kinds = {};
  let lbFrags = 0;
  for (let q = 0; q < R0.recs.length / 9; q++) {
    const t = R0.recs[q * 9] | 0,
      k = kindOf(t);
    if (k < 0) continue;
    lbFrags++;
    let key = `k${k}`;
    if (k === 12) key += `/bound${Math.round(R0.vOut[(t * 3 + 2) * R0.vert.outN + lbOff + 3])}`;
    kinds[key] = (kinds[key] || 0) + 1;
    kindTot[key] = (kindTot[key] || 0) + 1;
  }
  const line = [
    `#${cfgIdx} ${cfg.name.padEnd(52)} ${String(R0.recs.length / 9).padStart(7)} frags (${lbFrags} LB)${sc.morphSkipped ? ` [${sc.morphSkipped} shapes off this t]` : ''}`,
  ];
  pairs.forEach(([a, b], pi) => {
    const A = runs[a].recs,
      B = runs[b].recs;
    let d = 0;
    if (A.length !== B.length) d = -1;
    else
      for (let q = 0; q < A.length / 9 && d >= 0; q++)
        for (let c = 0; c < 8; c++)
          if (bits(A[q * 9 + c]) !== bits(B[q * 9 + c])) {
            d++;
            break;
          }
    // The vertex stage's outputs too (every varying and gl_Position of every vertex), where the two builds declare
    // the same outputs -- informational: an unread output may legitimately differ.
    const VA = runs[a],
      VB = runs[b];
    let vd = null;
    if (
      VA.vert.outN === VB.vert.outN &&
      VA.vert.io.outs.map((o) => o.name).join() === VB.vert.io.outs.map((o) => o.name).join()
    ) {
      vd = 0;
      for (let k = 0; k < VA.vOut.length; k++) if (bits(VA.vOut[k]) !== bits(VB.vOut[k])) vd++;
    }
    const T = tot[pi];
    T.cfgs++;
    T.frags += A.length / 9;
    T.lb += lbFrags;
    T.vdiff = (T.vdiff || 0) + (vd || 0);
    if (vd === null) T.vskip = (T.vskip || 0) + 1;
    if (d !== 0) {
      T.diff += Math.max(d, 1);
      T.bad.push(`${cfg.name}: ${d < 0 ? 'different fragment SETS' : d + ' fragments'}`);
    }
    line.push(
      `${BUILDS[a].label}->${BUILDS[b].label} ${d < 0 ? 'SET DIFFERS' : d}${vd ? ` (v ${vd})` : ''}`,
    );
  });
  console.log(
    line.join('  '),
    ` ${Object.entries(kinds)
      .map(([k, n]) => `${k}:${n}`)
      .join(' ')}   [${lap()}]`,
  );
}
console.log(
  '\nkinds over the corpus (fragments, first build):',
  Object.entries(kindTot)
    .sort()
    .map(([k, n]) => `${k} ${n}`)
    .join(', '),
);
pairs.forEach(([a, b], pi) => {
  const T = tot[pi];
  console.log(
    `${BUILDS[a].label} -> ${BUILDS[b].label}: ${T.cfgs} configurations, ${T.frags} fragments (${T.lb} LB), ${T.diff} differing; vertex-output floats differing ${T.vdiff || 0}${T.vskip ? ` (${T.vskip} configs with different output layouts)` : ''}${T.bad.length ? '\n   ' + T.bad.join('\n   ') : ''}`,
  );
});
console.log(`[${lap()}] done`);
