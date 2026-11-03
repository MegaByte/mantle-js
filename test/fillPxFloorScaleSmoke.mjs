// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// fillPxFloorScaleSmoke — the fill shader's pixels-per-em reciprocal is floored only against a zero derivative.
//
// mantle.frag.glsl forms ONE `invPx = 1 / max(fwidth(em), floor)` for every coverage kernel (Slug, AAC, GWN, band-hard,
// the clip and mask walks). With a floor of 1e-6 em per pixel, art drawn at 2^-20 of a unit-per-pixel size (an em per
// pixel of 9.5e-7) would have every kernel take its pixels 4.6% smaller than they are and widen every AA ramp by that
// much. aacPoints.vert.glsl (AAC's point route) and maskBake.frag.glsl form the same reciprocal. The floor is 1e-30,
// below every kernel's own float32 floor.
//
// Through the float32 emulation of the shader (test/_glslEmu.mjs), with the call site's reciprocal as the shader forms
// it, on a circle, a quad blob and a cubic shape exactly scaled (scaleFillData) with em per pixel scaled alike:
//   (a) invPx is exactly 2^20 at an em per pixel of 2^-20, and 2^24 at 2^-24;
//   (b) Slug, AAC and GWN + SDF read every pixel the same at 2^-20 and 2^-24 as at scale 1;
//   (c) the mutation flooring at 1e-6 is caught by (b);
//   (d) the AAC point route and the mask bake form the reciprocal with the same floor (text: not emulated).
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import {
  hasCxx,
  buildGlslEmu,
  fillShapes,
  scaleFillData,
  K_GWN,
  K_AAC,
  K_SLUG,
  K_INVPX,
  GWN_SDF,
  AAC_HARD,
} from './_glslEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!hasCxx()) {
  console.log('SKIP fillPxFloorScaleSmoke: no C++ compiler ($CXX, clang++, g++, c++)');
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
const read = (f) => readFileSync(path.join(ROOT, 'src/shaders', f), 'utf8');
const GLSL = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 120">
  <path d="M60 60 m -45.3 0 a 45.3 45.3 0 1 0 90.6 0 a 45.3 45.3 0 1 0 -90.6 0 Z"/>
  <path d="M120 60 Q 150 -10 180 60 T 190 110 Q 150 120 120 60 Z"/>
  <path fill-rule="evenodd" d="M200 20 C 290 0 300 100 240 110 C 190 115 180 40 200 20 Z M225 45 L 265 50 L 245 90 Z"/>
</svg>`;
const b = await importSvg(SVG, { preserveViewport: true, gwnTree: true });
const shapes = fillShapes(b, parseMetaBin, M);
const band = new Float32Array(b.bands),
  curve = new Float32Array(b.curves);
const qs = [];
for (const sh of shapes)
  for (let y = Math.floor(sh.bb[1]) - 2; y <= Math.ceil(sh.bb[3]) + 2; y++)
    for (let x = Math.floor(sh.bb[0]) - 2; x <= Math.ceil(sh.bb[2]) + 2; x++)
      qs.push({ GD: sh.GD, bb: sh.bb, eo: sh.eo, c: [x + 0.5, y + 0.5], ePx: [1, 1] });
ok(
  shapes.length === 3 && shapes.every((s) => s.tree) && qs.length > 15000,
  `three fill shapes with run trees, ${qs.length} pixel centers`,
);

const LOGS = [-20, -24];
const KERNELS = [
  ['Slug', AAC_HARD, K_SLUG],
  ['AAC', AAC_HARD, K_AAC],
  ['GWN + SDF', GWN_SDF, K_GWN],
];
function differing(glsl) {
  const out = {};
  for (const [name, defines, k] of KERNELS) {
    const emu = buildGlslEmu(ROOT, { defines, glsl });
    const base = emu.run(
      band,
      curve,
      qs.map((q) => ({ ...q, k })),
    );
    let n = 0;
    for (const lg of LOGS) {
      const S = Math.pow(2, lg),
        sc = scaleFillData(band, curve, shapes, S);
      const r = emu.run(
        sc.band,
        sc.curve,
        qs.map((q) => ({
          ...q,
          k,
          bb: q.bb.map((v) => Math.fround(v * S)),
          c: [q.c[0] * S, q.c[1] * S],
          ePx: [S, S],
        })),
      );
      r.forEach((v, i) => {
        if (v !== base[i]) n++;
      });
    }
    out[name] = n;
  }
  return out;
}
// ---- (a) ------------------------------------------------------------------------------------------------------------
{
  const emu = buildGlslEmu(ROOT, { defines: AAC_HARD });
  const r = emu.run(
    band,
    curve,
    LOGS.map((lg) => ({ ...qs[0], k: K_INVPX, ePx: [Math.pow(2, lg), Math.pow(2, lg)] })),
  );
  ok(
    r[0] === Math.pow(2, 20) && r[1] === Math.pow(2, 24),
    `(a) invPx is 2^20 and 2^24 (${r[0]}, ${r[1]})`,
  );
}
// ---- (b) ------------------------------------------------------------------------------------------------------------
{
  const d = differing(GLSL);
  ok(
    Object.values(d).every((n) => n === 0),
    `(b) every pixel reads the same at 2^-20 and 2^-24 as at 1: ${Object.entries(d)
      .map(([k, n]) => `${k} ${n} differ`)
      .join(', ')}`,
  );
}
// ---- (c) ------------------------------------------------------------------------------------------------------------
{
  const hinge = 'vec2 invPx = 1.0 / max(ePx, vec2(1e-30));';
  if (!GLSL.includes(hinge)) ok(false, "(c) mutation hinge present: the fill shader's invPx line");
  else {
    const d = differing(GLSL.split(hinge).join('vec2 invPx = 1.0 / max(ePx, vec2(1e-6));'));
    ok(
      Object.values(d).every((n) => n > 0),
      `(c) the 1e-6 floor restored is caught: ${Object.entries(d)
        .map(([k, n]) => `${k} ${n}`)
        .join(', ')} pixels differ`,
    );
  }
}
// ---- (d) ------------------------------------------------------------------------------------------------------------
{
  const code = (s) => s.replace(/\/\/[^\n]*/g, '');
  ok(
    /vec2 invPx = 1\.0 \/ max\(ePx, vec2\(1e-30\)\);/.test(code(read('mantle.frag.glsl'))),
    '(d) mantle.frag.glsl floors ePx at 1e-30',
  );
  ok(
    /vec2 invPx = 1\.0 \/ max\(ePx, vec2\(1e-30\)\);/.test(code(read('aacPoints.vert.glsl'))),
    '(d) aacPoints.vert.glsl floors ePx at 1e-30',
  );
  ok(
    /vec2 ePx\s*=\s*max\(emPerPixel, vec2\(1e-30\)\);/.test(code(read('maskBake.frag.glsl'))),
    '(d) maskBake.frag.glsl floors ePx at 1e-30',
  );
}

if (fail) {
  console.error(`FILL-PX-FLOOR-SCALE FAIL (${fail})`);
  process.exit(1);
}
console.log('FILL-PX-FLOOR-SCALE PASS');
