// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// aacHalfPixelScaleSmoke — AAC's pixel cell is half a pixel in em at every size.
//
// renderFillAAC forms the cell's half height as 0.5 / |px.y|, with no absolute floor. A floor such as max(|px.y|, 1e-12)
// caps em per pixel at 1e12; art drawn at 2^40 of a unit per pixel has 1.1e12, so the cell would be taken ~9% short in
// y: its stripe span and the window each stripe's walk is clipped to would not be the pixel's, and 141 pixel centers of
// the corpus's aacPointsRoute shapes would read differently at 2^40 than at 1 (the rest of the kernel is in pixel-local
// units already). The call site floors em per pixel at 1e-30, so px is finite and positive and needs no floor here.
//
// Through the float32 emulation of the shader, on a glyph-like cubic, a quad blob, an even-odd ring of arcs and a thin
// bar, their fill data scaled exactly (scaleFillData) with their em per pixel:
//   (a) AAC reads every pixel center the same at 2^40 and 2^44 as at 1 (and at 2^-20, where nothing binds);
//   (b) the mutation adding the floor is caught.
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { hasCxx, buildGlslEmu, fillShapes, scaleFillData, K_AAC, AAC_HARD } from './_glslEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!hasCxx()) {
  console.log('SKIP aacHalfPixelScaleSmoke: no C++ compiler ($CXX, clang++, g++, c++)');
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

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 140">
  <path fill-rule="evenodd" d="M10.3 5.2 C 45.1 0.4 62.2 20.3 55.4 40.1 Q 50.2 62.3 30.1 60.2 L 8.2 55.4 Z M20.3 20.1 L 40.2 25.3 L 30.1 45.4 Z"/>
  <path d="M80.2 10.1 C 120.3 2.2 135.4 30.3 120.2 50.4 Q 105.3 66.1 90.2 50.3 Q 62.1 30.2 80.2 10.1 Z"/>
  <path fill-rule="evenodd" d="M200.3 60.2 m -45.1 0 a 45.1 45.1 0 1 0 90.2 0 a 45.1 45.1 0 1 0 -90.2 0 Z M200.3 60.2 m -20.2 0 a 20.2 20.2 0 1 0 40.4 0 a 20.2 20.2 0 1 0 -40.4 0 Z"/>
  <path d="M10.1 120.2 H 280.3 V 120.9 H 10.1 Z"/>
</svg>`;
const b = await importSvg(SVG, { preserveViewport: true });
const shapes = fillShapes(b, parseMetaBin, M).map((s) => ({ ...s, tree: false }));
const band = new Float32Array(b.bands),
  curve = new Float32Array(b.curves);
// Pixels of 1, 4 and 12 units: AAC's cell only spans more than one stripe pair -- where the half-pixel decides which
// stripes it walks and the window it clips each to -- once the shape is a few pixels tall.
const qs = [];
for (const P of [1, 4, 12])
  for (const sh of shapes)
    for (let y = Math.floor(sh.bb[1] / P) - 1; y <= Math.ceil(sh.bb[3] / P) + 1; y++)
      for (let x = Math.floor(sh.bb[0] / P) - 1; x <= Math.ceil(sh.bb[2] / P) + 1; x++)
        qs.push({
          k: K_AAC,
          GD: sh.GD,
          bb: sh.bb,
          eo: sh.eo,
          c: [(x + 0.5) * P, (y + 0.5) * P],
          ePx: [P, P],
        });
ok(
  shapes.length === 4 && qs.length > 15000,
  `four shapes, ${qs.length} pixel centers over three pixel sizes`,
);
const LOGS = [40, 44, -20];
function differing(glsl) {
  const emu = buildGlslEmu(ROOT, { defines: AAC_HARD, glsl });
  const base = emu.run(band, curve, qs);
  return LOGS.map((lg) => {
    const S = Math.pow(2, lg),
      sc = scaleFillData(band, curve, shapes, S);
    const r = emu.run(
      sc.band,
      sc.curve,
      qs.map((q) => ({
        ...q,
        bb: q.bb.map((v) => Math.fround(v * S)),
        c: [Math.fround(q.c[0] * S), Math.fround(q.c[1] * S)],
        ePx: [q.ePx[0] * S, q.ePx[1] * S],
      })),
    );
    return r.reduce((n, v, i) => n + (v !== base[i] ? 1 : 0), 0);
  });
}
const GLSL = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');
const d = differing(GLSL);
ok(
  d.every((n) => n === 0),
  `(a) AAC reads every pixel center as at 1 at 2^${LOGS.join(', 2^')} (differing: ${d.join(' / ')})`,
);
{
  const from = 'float hy = 0.5 / abs(px.y);';
  if (!GLSL.includes(from)) ok(false, '(b) mutation hinge present: the half-pixel');
  else {
    const m = differing(GLSL.split(from).join('float hy = 0.5 / max(abs(px.y), 1e-12);'));
    ok(
      m.some((n) => n > 0),
      `(b) the 1e-12 floor added is caught (differing: ${m.join(' / ')})`,
    );
  }
}

if (fail) {
  console.error(`AAC-HALF-PIXEL-SCALE FAIL (${fail})`);
  process.exit(1);
}
console.log('AAC-HALF-PIXEL-SCALE PASS');
