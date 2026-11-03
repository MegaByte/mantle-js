// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// aacClipRootSmoke — AAC's clip root is CERTIFIED, not counted, through the float32 emulation of the
// shipped fill shader (test/_glslEmu.mjs), under both AAC define sets and at scales 2^-20, 1 and 2^20.
//
// aacSolveC's cubic branch is a safeguarded Newton. Where a monotone piece meets the cell's window at its flat end
// (every piece boundary is a y-extremum) a fixed six steps do not converge, and the in-cell ramp is placed by an
// unconverged t: 0.0059-0.0103 of coverage on four tiger pixels whose exact coverage is ~1e-5 or less. So the solve
// runs inside its bracket until |C(t) - V| is within max(2^-20, one ulp of the magnitudes evalC sums), or the bracket
// is two adjacent floats, and from trip 8 on it only bisects, so it returns by trip 34.
//   (a) the four tiger pixels (shapes 16, 20, 87, 91) read the exact coverage to 5e-5 -- a six-step solve's error is 100x
//       that and more. (The four are within 1.4e-5; a power-basis zone antiderivative would leave 87 and 91 at 1.8e-4 and
//       1.2e-4 off.)
//   (b) over tiger at 128 px, every cubic clip solve returns before its loop runs out, within the proven 34 trips.
// The exact coverage is probes/fillperf/cellCoverage.mjs, the f64 box integral of the decoded outline.
//   node test/aacClipRootSmoke.mjs [--glsl path.frag.glsl]   (another shader text, e.g. a six-step one, to see (a) fail; (b) needs the bracketed loop)
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { hasCxx, buildGlslEmu, fillShapes, scaleFillData, K_AAC, AAC_HARD } from './_glslEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!hasCxx()) {
  console.log('SKIP aacClipRootSmoke: no C++ compiler ($CXX, clang++, g++, c++)');
  process.exit(0);
}
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const M = await import('../src/bundle/layout.js');
const { decodeSegs } = await import('../src/hitTest/curveGeom.js');
const { cellCoverage } = await import('../probes/fillperf/cellCoverage.mjs');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const gi = process.argv.indexOf('--glsl');
const TEXT = readFileSync(
  gi > 0 ? process.argv[gi + 1] : path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'),
  'utf8',
);
const SETS = [
  ['aac', AAC_HARD],
  ['aacStripe', ['MANTLE_AAC', 'MANTLE_HARD']],
];
const emus = SETS.map(([name, defines]) => [name, buildGlslEmu(ROOT, { defines, glsl: TEXT })]);

const b = await importSvg(readFileSync(path.join(ROOT, 'examples/tiger.svg'), 'utf8'), {
  preserveViewport: true,
});
const shapes = fillShapes(b, parseMetaBin, M),
  band = new Float32Array(b.bands),
  curve = new Float32Array(b.curves);

// (a) [shape, pixel center, pixel size]: the pixels a six-step solve leaves 0.0059-0.0103 on
const PIX = [
  [16, 53.9570198059082, 429.1509094238281, 2.0952393213907876],
  [20, 20.61348533630371, 382.9263000488281, 2.0271195620298386],
  [87, 228.51124572753906, 580.4335327148438, 0.2873789469401042],
  [91, 255.03289794921875, 580.9815063476562, 0.27148183186848956],
];
for (const S of [2 ** -20, 1, 2 ** 20]) {
  for (const [name, emu] of emus) {
    const rows = PIX.map(([si, x, y, e]) => {
      const sh = shapes.find((s) => s.s === si);
      const ex = cellCoverage(
        decodeSegs(curve, sh.range.begin, sh.range.end),
        [x, y],
        [e, e],
        sh.eo,
      );
      const sd = S === 1 ? { band, curve } : scaleFillData(band, curve, [sh], S); // exact: a power of two
      const v = emu.run(sd.band, sd.curve, [
        {
          k: K_AAC,
          GD: sh.GD,
          bb: sh.bb.map((w) => Math.fround(w * S)),
          eo: sh.eo,
          c: [Math.fround(x * S), Math.fround(y * S)],
          ePx: [e * S, e * S],
        },
      ])[0];
      return { si, v, ex };
    });
    const bad = rows.filter((r) => !(Math.abs(r.v - r.ex) < 5e-5));
    ok(
      bad.length === 0,
      `${name} @2^${Math.log2(S)}: tiger shapes 16, 20, 87, 91 read the exact coverage to 5e-5` +
        (bad.length
          ? ` -- ${bad.map((r) => `shape ${r.si} ${r.v.toFixed(6)} (exact ${r.ex.toExponential(2)})`).join(', ')}`
          : ''),
    );
  }
}

// (b) an instrumented copy: the most trips any solve of a fragment took, and whether any solve ran its loop out
const HOOK_LOOP = '  for (int k = 0; k < AAC_ROOT_STEPS; k++) {\n    float ft = evalC(C, t) - V;';
const HOOK_END = '  return 0.5 * (a + b);\n#endif';
const HOOK_RET = '  return aacFold(run, evenOdd);\n}';
const HOOK_MAIN = 'float renderFillAAC(vec2 c, vec2 px, ivec4 GD, bool evenOdd, vec4 shapeBB) {';
if (TEXT.split(HOOK_LOOP).length !== 2 || TEXT.split(HOOK_END).length !== 2) {
  ok(gi > 0, '(b) the certified loop is in the text');
} else {
  let inst = TEXT.replace(
    'float aacSolveC(vec4 C, float ta, float tb, float V) {',
    'float gTrips = 0.0, gOut = 0.0;\nfloat aacSolveC(vec4 C, float ta, float tb, float V) {',
  );
  inst = inst.replace(
    HOOK_LOOP,
    '  for (int k = 0; k < AAC_ROOT_STEPS; k++) {\n    gTrips = max(gTrips, float(k + 1));\n    float ft = evalC(C, t) - V;',
  );
  inst = inst.replace(
    HOOK_END,
    '  if (!(0.5 * (a + b) > a && 0.5 * (a + b) < b)) {} else gOut += 1.0;\n' + HOOK_END,
  );
  inst = inst.replace(HOOK_MAIN, HOOK_MAIN + '\n  gTrips = 0.0; gOut = 0.0;');
  const eT = buildGlslEmu(ROOT, {
    defines: ['MANTLE_AAC'],
    glsl: inst.replace(HOOK_RET, '  return gTrips;\n}'),
  });
  const eO = buildGlslEmu(ROOT, {
    defines: ['MANTLE_AAC'],
    glsl: inst.replace(HOOK_RET, '  return gOut;\n}'),
  });
  const N = 128,
    px = 900 / N;
  let trips = 0,
    out = 0,
    frags = 0;
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
    const t = eT.run(band, curve, qs),
      o = eO.run(band, curve, qs);
    for (let i = 0; i < qs.length; i++) {
      frags++;
      trips = Math.max(trips, t[i]);
      out += o[i];
    }
  }
  ok(frags > 50000 && trips > 0, `(b) tiger at ${N} px: ${frags} fragments, cubic clip solves ran`);
  ok(trips <= 34, `(b) the most trips any solve took is ${trips}, within the proven 34`);
  ok(out === 0, `(b) no solve ran its loop out (${out})`);
}
console.log(fail ? `AAC-CLIP-ROOT FAIL (${fail})` : 'AAC-CLIP-ROOT PASS');
process.exit(fail ? 1 : 0);
