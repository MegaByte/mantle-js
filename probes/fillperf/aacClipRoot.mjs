// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// aacClipRoot — AAC's clip root, certified, against six fixed Newton steps, at the tiger pixels where the six-step
// solve leaves 0.003-0.010 of coverage on pixels whose exact value is ~0 (shapes 16, 20, 87, 91), at 2^-20, 1 and 2^20
// (the fill data scaled exactly, test/_glslEmu.mjs scaleFillData), under both AAC define sets. Also the solve's own
// work: how many trips the certified loop took per solve over the tiger render (mean, max, and the slowest solve of
// each fragment -- a warp waits for its slowest lane), from an instrumented copy of the package text.
//   node probes/fillperf/aacClipRoot.mjs [--base old.frag.glsl] [--cand new.frag.glsl]
//   (defaults: HEAD's generated shader, and the working tree's)
import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../../src/svg/importer.js');
const { parseMetaBin } = await import('../../src/renderer/bundle.js');
const M = await import('../../src/bundle/layout.js');
const { buildGlslEmu, fillShapes, scaleFillData, K_AAC, AAC_HARD } =
  await import('../../test/_glslEmu.mjs');
const { decodeSegs } = await import('../../src/hitTest/curveGeom.js');
const { cellCoverage } = await import('./cellCoverage.mjs');

const argv = process.argv.slice(2);
const bi = argv.indexOf('--base');
const BASE =
  bi >= 0
    ? readFileSync(argv[bi + 1], 'utf8')
    : execFileSync('git', ['show', 'HEAD:./src/shaders/generated/mantle.frag.glsl'], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 64 << 20,
      });
const ci = argv.indexOf('--cand');
const CUR = readFileSync(
  ci >= 0 ? argv[ci + 1] : path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'),
  'utf8',
);
const SETS = [
  ['pair', AAC_HARD],
  ['stripe', ['MANTLE_AAC', 'MANTLE_HARD']],
];
const EMU = SETS.map(([n, d]) => [
  n,
  buildGlslEmu(ROOT, { defines: d, glsl: BASE }),
  buildGlslEmu(ROOT, { defines: d, glsl: CUR }),
]);

const b = await importSvg(readFileSync(path.join(ROOT, 'examples/tiger.svg'), 'utf8'), {
  preserveViewport: true,
});
const shapes = fillShapes(b, parseMetaBin, M),
  band = new Float32Array(b.bands),
  curve = new Float32Array(b.curves);
const PIX = [
  [16, 53.9570198059082, 429.1509094238281, 2.0952393213907876],
  [20, 20.61348533630371, 382.9263000488281, 2.0271195620298386],
  [87, 228.51124572753906, 580.4335327148438, 0.2873789469401042],
  [91, 255.03289794921875, 580.9815063476562, 0.27148183186848956],
];
console.log(
  'the named tiger pixels: AAC old (six Newton steps) -> certified, against the exact coverage',
);
for (const S of [2 ** -20, 1, 2 ** 20]) {
  for (const [si, x, y, e] of PIX) {
    const sh = shapes.find((s) => s.s === si),
      ex = cellCoverage(decodeSegs(curve, sh.range.begin, sh.range.end), [x, y], [e, e], sh.eo);
    const sd = S === 1 ? { band, curve } : scaleFillData(band, curve, [sh], S);
    const q = [
      {
        k: K_AAC,
        GD: sh.GD,
        bb: sh.bb.map((v) => Math.fround(v * S)),
        eo: sh.eo,
        c: [Math.fround(x * S), Math.fround(y * S)],
        ePx: [e * S, e * S],
      },
    ];
    console.log(
      `  2^${String(Math.log2(S)).padStart(3)} shape ${String(si).padStart(2)}: exact ${ex.toExponential(2)} | ` +
        EMU.map(
          ([n, o, c]) =>
            `${n} ${o.run(sd.band, sd.curve, q)[0].toFixed(6)} -> ${c.run(sd.band, sd.curve, q)[0].toExponential(2)}`,
        ).join(' | '),
    );
  }
}

// the certified loop's steps per solve, over tiger at 256 px: an instrumented copy counts them
const HOOK_LOOP = '  for (int k = 0; k < AAC_ROOT_STEPS; k++) {\n    float ft = evalC(C, t) - V;';
const HOOK_RET = '  return aacFold(run, evenOdd);\n}';
if (CUR.split(HOOK_LOOP).length !== 2) throw new Error('aacClipRoot: the solve loop hook moved');
let inst = CUR.replace(
  'float aacSolveC(vec4 C, float ta, float tb, float V) {',
  'float gSolves = 0.0, gSteps = 0.0, gMax = 0.0;\nfloat aacSolveC(vec4 C, float ta, float tb, float V) {',
);
inst = inst.replace(
  HOOK_LOOP,
  '  gSolves += 1.0;\n  for (int k = 0; k < AAC_ROOT_STEPS; k++) {\n    gSteps += 1.0; gMax = max(gMax, float(k + 1));\n    float ft = evalC(C, t) - V;',
);
const stat = (what) =>
  buildGlslEmu(ROOT, {
    defines: ['MANTLE_AAC'],
    glsl: inst
      .replace(HOOK_RET, `  return ${what};\n}`)
      .replace(
        'float renderFillAAC(vec2 c, vec2 px, ivec4 GD, bool evenOdd, vec4 shapeBB) {',
        'float renderFillAAC(vec2 c, vec2 px, ivec4 GD, bool evenOdd, vec4 shapeBB) {\n  gSolves = 0.0; gSteps = 0.0; gMax = 0.0;',
      ),
  });
const eS = stat('gSolves'),
  eK = stat('gSteps'),
  eM = stat('gMax');
const vb = [0, 0, 900, 900],
  N = 256,
  px = 900 / N;
let solves = 0,
  steps = 0,
  mx = 0,
  frags = 0;
const hist = new Array(97).fill(0); // fragments by the most steps any of their solves took
for (const sh of shapes) {
  const qs = [];
  for (
    let j = Math.max(0, Math.floor(sh.bb[1] / px) - 1);
    j <= Math.min(N - 1, Math.ceil(sh.bb[3] / px) + 1);
    j++
  )
    for (
      let i = Math.max(0, Math.floor(sh.bb[0] / px) - 1);
      i <= Math.min(N - 1, Math.ceil(sh.bb[2] / px) + 1);
      i++
    )
      qs.push({
        k: K_AAC,
        GD: sh.GD,
        bb: sh.bb,
        eo: sh.eo,
        c: [Math.fround((i + 0.5) * px), Math.fround((j + 0.5) * px)],
        ePx: [px, px],
      });
  if (!qs.length) continue;
  const a = eS.run(band, curve, qs),
    k = eK.run(band, curve, qs),
    m = eM.run(band, curve, qs);
  for (let i = 0; i < qs.length; i++) {
    frags++;
    solves += a[i];
    steps += k[i];
    mx = Math.max(mx, m[i]);
    if (a[i] > 0) hist[m[i]]++;
  }
}
void vb;
console.log(
  `tiger at ${N} px: ${frags} fragments, ${solves} cubic clip solves (${(solves / frags).toFixed(3)} a fragment), ` +
    `${(steps / Math.max(1, solves)).toFixed(2)} trips a solve (the fixed form: 6 Newton steps and a secant seed), at most ${mx} (the proven bound is 34)`,
);
{
  // a warp runs its slowest lane: the per-fragment worst solve, as percentiles over the fragments that solve at all
  const tot = hist.reduce((x, y) => x + y, 0);
  let acc = 0;
  const pct = {};
  for (let k = 0; k < hist.length; k++) {
    acc += hist[k];
    for (const p of [50, 90, 99, 99.9])
      if (pct[p] === undefined && acc >= (tot * p) / 100) pct[p] = k;
  }
  console.log(
    `  the most trips a fragment's solves took (${tot} fragments that solve): median ${pct[50]}, p90 ${pct[90]}, p99 ${pct[99]}, p99.9 ${pct[99.9]}`,
  );
}
