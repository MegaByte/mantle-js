// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// aacFarFieldTelescopeSmoke — AAC paints nothing outside the ink, through the float32 emulation of the
// shipped fill shader (test/_glslEmu.mjs), under both AAC define sets and at scales 2^-20, 1 and 2^20.
//
// AAC's far field -- every zone right of the pixel -- is Δclamp(Yl) between the zone's ends, and a whole contour's
// Δ telescopes to zero outside the ink. Re-evaluating Yl at the y-clip's SOLVED t breaks that: where a piece meets the
// window at a flat tangent the solve's residual is ~1e-2, so the sum does not telescope and leaves stray coverage over
// rows the shape never reaches. So a clip end carries its known Yl (the window edge it was solved for).
//   (a) the stray pixels the cover-fan proof named -- lbAnnulusSdf's box corner (0.016 without it) and two tiger pixels
//       (0.0097 and 0.0158) -- read exactly 0, as the exact coverage does;
//   (b) the arc clip whose root quantized acos puts a hair outside its bracket: answering the bracket's MIDPOINT, half a
//       turn away, would paint 0.62 of a pixel that is 0.0095 covered; aacTrigSolve reads the exact coverage to 1e-3.
// The exact coverage is probes/fillperf/cellCoverage.mjs, the f64 box integral of the decoded outline.
//   node test/aacFarFieldTelescopeSmoke.mjs [--glsl path.frag.glsl]   (another shader text, to see it fail)
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { hasCxx, buildGlslEmu, fillShapes, scaleFillData, K_AAC, AAC_HARD } from './_glslEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!hasCxx()) {
  console.log('SKIP aacFarFieldTelescopeSmoke: no C++ compiler ($CXX, clang++, g++, c++)');
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
const glsl = gi > 0 ? readFileSync(process.argv[gi + 1], 'utf8') : null;
const SETS = [
  ['aac', AAC_HARD],
  ['aacStripe', ['MANTLE_AAC', 'MANTLE_HARD']],
];
const emus = SETS.map(([name, defines]) => [name, buildGlslEmu(ROOT, { defines, glsl })]);

// [asset, pixel center, pixel size, check]: 'zero' = every shape whose box holds the pixel reads 0 where the exact
// coverage is 0; 'exact' = every such shape reads the exact coverage to 1e-3
const CASES = [
  ['examples/smoke/lbAnnulusSdf__SVG.svg', [4.0279, 4.0485], 0.08594, 'zero'],
  ['examples/tiger.svg', [439.93, 498.22], 0.07514, 'zero'],
  ['examples/tiger.svg', [125.23, 350.78], 0.8405, 'zero'],
  [
    'examples/smoke/slugCurvedEdge__wrap_M_500_180_a_320_320_0_1.svg',
    [180.04930376297608, 183.78666666666666],
    213.33333333333334,
    'exact',
  ],
];
const loaded = new Map();
for (const [file, c0, e0, check] of CASES) {
  if (!loaded.has(file)) {
    const b = await importSvg(readFileSync(path.join(ROOT, file), 'utf8'), {
      preserveViewport: true,
    });
    const shapes = fillShapes(b, parseMetaBin, M);
    loaded.set(file, {
      shapes,
      band: new Float32Array(b.bands),
      curve: new Float32Array(b.curves),
    });
  }
  const { shapes, band, curve } = loaded.get(file);
  const c = [Math.fround(c0[0]), Math.fround(c0[1])];
  const hit = shapes.filter(
    (sh) =>
      c[0] >= sh.bb[0] - e0 &&
      c[0] <= sh.bb[2] + e0 &&
      c[1] >= sh.bb[1] - e0 &&
      c[1] <= sh.bb[3] + e0,
  );
  const exact = hit.map((sh) =>
    cellCoverage(decodeSegs(curve, sh.range.begin, sh.range.end), c, [e0, e0], sh.eo),
  );
  const judged = hit.filter((_, i) => check === 'exact' || exact[i] === 0);
  const ex = exact.filter((_, i) => check === 'exact' || exact[i] === 0);
  ok(judged.length > 0, `${file} (${c0}): ${judged.length} shape(s) to judge`);
  for (const S of [2 ** -20, 1, 2 ** 20]) {
    const sd = S === 1 ? { band, curve } : scaleFillData(band, curve, judged, S); // exact: a power of two
    const q = judged.map((sh) => ({
      k: K_AAC,
      GD: sh.GD,
      bb: sh.bb.map((v) => Math.fround(v * S)),
      eo: sh.eo,
      c: [Math.fround(c[0] * S), Math.fround(c[1] * S)],
      ePx: [e0 * S, e0 * S],
    }));
    for (const [name, emu] of emus) {
      const v = emu.run(sd.band, sd.curve, q);
      const bad = judged
        .map((sh, i) => ({ s: sh.s, v: v[i], x: ex[i] }))
        .filter((r) => (check === 'zero' ? r.v !== 0 : !(Math.abs(r.v - r.x) < 1e-3)));
      ok(
        bad.length === 0,
        `${name} @2^${Math.log2(S)}: ${check === 'zero' ? 'exactly 0 off the ink' : 'the exact coverage to 1e-3'}` +
          (bad.length
            ? ` -- ${bad.map((r) => `shape ${r.s} ${r.v} (exact ${r.x.toFixed(6)})`).join(', ')}`
            : ''),
      );
    }
  }
}
console.log(fail ? `AAC-FAR-FIELD FAIL (${fail})` : 'AAC-FAR-FIELD PASS');
process.exit(fail ? 1 : 0);
