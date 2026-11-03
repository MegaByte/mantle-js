// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// gwnKernelScaleSmoke — the GWN tree kernel's guards test for ZERO, so it reads the same at every scale.
//
// gwnSegEval and renderFillGWNSDF may carry no absolute guard in a scale-free position: a chord or tangent under 1e-10 em
// (`L2 < 1e-20`), a quad control triangle under 1e-20 em^2 (`abs(d) >= 1e-20`), a plane gradient under 1e-12
// (`gpx < 1e-12`, em per pixel for a line), a slab rank em-per-pixel floor (1e-12), a degenerate-arc floor on the
// larger radius (1e-9), or a pruning reach em-per-pixel cap (`max(px, 1e-6)`). With them, at 2^-40 a unit-sized quad
// loses its lune (a flipped region), at 2^40 a line's plane loses its candidate, and at 2^20 the reach reads 4.6% short.
//
// Through the float32 emulation of the shader (test/_glslEmu.mjs), on lines, a curved quad, a serpentine cubic (type-4
// pieces), a loop cubic (type-6 pieces), a circle and an ellipse 1000:1 (type-5 pieces), exactly scaled (scaleFillData)
// with their em per pixel:
//   (a) GWN winding-only and GWN + SDF read every pixel the same at 2^-48, 2^-40, 2^-20, 2^20 and 2^40 as at 1 (2^-48
//       is where the slab rank's 1e-12 floor binds hard enough to change a pixel), with the early
//       exits taken out (gwnWithoutExits: the grid and band tiers divide by the shape's bbox, a floor guarded
//       separately);
//   (b) with the early exits, the same at 2^20 and 2^40;
//   (c) mutations putting each absolute guard back are caught by (a) or (b).
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import {
  hasCxx,
  buildGlslEmu,
  fillShapes,
  scaleFillData,
  gwnWithoutExits,
  K_GWN,
  GWN_SDF,
  GWN_WIND,
} from './_glslEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!hasCxx()) {
  console.log('SKIP gwnKernelScaleSmoke: no C++ compiler ($CXX, clang++, g++, c++)');
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
const GLSL = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 220">
  <path d="M10.3 10.7 L 90.1 18.2 L 70.4 95.6 L 30.2 60.9 Z"/>
  <path d="M110.2 90.4 Q 150.7 -5.3 190.1 90.8 Q 150.3 60.2 110.2 90.4 Z"/>
  <path d="M210.4 20.3 C 290.2 20.1 220.6 100.7 300.3 99.2 L 300.3 110.1 L 210.4 110.1 Z"/>
  <path d="M320.1 20.2 C 420.6 120.4 300.2 120.8 400.3 20.6 Z"/>
  <path d="M60.3 160.2 m -45.1 0 a 45.1 45.1 0 1 0 90.2 0 a 45.1 45.1 0 1 0 -90.2 0 Z"/>
  <path d="M200.2 160.4 m -80.3 0 a 80.3 0.0803 0 1 0 160.6 0 a 80.3 0.0803 0 1 0 -160.6 0 Z M200.2 190.7 m -60.1 0 a 60.1 12.3 0 1 0 120.2 0 a 60.1 12.3 0 1 0 -120.2 0 Z"/>
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
{
  // the piece types the smoke claims to reach
  const types = new Set();
  for (const sh of shapes) {
    const g = sh.GD[1] * 4096 + sh.GD[0],
      h = (g + (sh.GD[2] + sh.GD[3] + 2) * 2) * 4;
    const refBase = band[h + 2] | 0,
      refCount = band[h + 3] | 0;
    for (let i = 0; i < refCount; i++)
      types.add(((band[(g + refBase + i) * 4 + 2] + 0.5) | 0) % 16);
  }
  ok(
    shapes.length === 6 &&
      shapes.every((s) => s.tree) &&
      [0, 1, 4, 5, 6].every((t) => types.has(t)),
    `six shapes with run trees; piece types ${[...types].sort().join(', ')} (need 0, 1, 4, 5, 6); ${qs.length} pixel centers`,
  );
}
function differing(glsl, defines, logs) {
  const emu = buildGlslEmu(ROOT, { defines, glsl });
  const base = emu.run(
    band,
    curve,
    qs.map((q) => ({ ...q, k: K_GWN })),
  );
  const out = [];
  for (const lg of logs) {
    const S = Math.pow(2, lg),
      sc = scaleFillData(band, curve, shapes, S);
    const r = emu.run(
      sc.band,
      sc.curve,
      qs.map((q) => ({
        ...q,
        k: K_GWN,
        bb: q.bb.map((v) => Math.fround(v * S)),
        c: [Math.fround(q.c[0] * S), Math.fround(q.c[1] * S)],
        ePx: [S, S],
      })),
    );
    let n = 0;
    r.forEach((v, i) => {
      if (v !== base[i]) n++;
    });
    out.push(n);
  }
  return out;
}
const ALL = [-48, -40, -20, 20, 40],
  BIG = [20, 40];
const run = (glsl) => ({
  windNo: differing(gwnWithoutExits(glsl), GWN_WIND, ALL),
  sdfNo: differing(gwnWithoutExits(glsl), GWN_SDF, ALL),
  wind: differing(glsl, GWN_WIND, BIG),
  sdf: differing(glsl, GWN_SDF, BIG),
});
const total = (r) => [...r.windNo, ...r.sdfNo, ...r.wind, ...r.sdf].reduce((a, v) => a + v, 0);
// ---- (a), (b) -------------------------------------------------------------------------------------------------------
{
  const r = run(GLSL);
  ok(
    r.windNo.every((n) => n === 0) && r.sdfNo.every((n) => n === 0),
    `(a) no early exits: every pixel reads as at 1 at 2^-48, 2^-40, 2^-20, 2^20, 2^40 (differing: winding ${r.windNo.join('/')}, SDF ${r.sdfNo.join('/')})`,
  );
  ok(
    r.wind.every((n) => n === 0) && r.sdf.every((n) => n === 0),
    `(b) with the early exits: the same at 2^20 and 2^40 (differing: winding ${r.wind.join('/')}, SDF ${r.sdf.join('/')})`,
  );
}
// ---- (c) ------------------------------------------------------------------------------------------------------------
{
  const muts = [
    [
      'a chord under 1e-10 em has no plane',
      'if (!(L2 > 0.0)) return wSeg;',
      'if (L2 < 1e-20) return wSeg;',
    ],
    [
      'a control triangle under 1e-20 em^2 has no implicit',
      'bool haveBary = d != 0.0;',
      'bool haveBary = abs(d) >= 1e-20;',
    ],
    [
      'a gradient under 1e-12 has no plane',
      'if (!(gpx > 0.0)) return wSeg;',
      'if (gpx < 1e-12) return wSeg;',
    ],
    [
      'the slab rank floors em per pixel at 1e-12',
      '/ min(1.0 / px.x, 1.0 / px.y);',
      '/ max(min(1.0 / px.x, 1.0 / px.y), 1e-12);',
    ],
    [
      'the degenerate arc test floors the radius at 1e-9',
      '<= 1e-4 * max(tc.z, tc.w))',
      '<= 1e-4 * max(max(tc.z, tc.w), 1e-9))',
    ],
    [
      'the reach caps em per pixel at 1e6',
      'vec2 emPerPx = 1.0 / px;',
      'vec2 emPerPx = 1.0 / max(px, vec2(1e-6));',
    ],
  ];
  for (const [name, from, to] of muts) {
    if (!GLSL.includes(from)) {
      ok(false, `(c) mutation hinge present: ${name}`);
      continue;
    }
    const r = run(GLSL.split(from).join(to));
    ok(
      total(r) > 0,
      `(c) mutation "${name}" is caught: differing winding ${r.windNo.join('/')} SDF ${r.sdfNo.join('/')}; with exits winding ${r.wind.join('/')} SDF ${r.sdf.join('/')}`,
    );
  }
}

if (fail) {
  console.error(`GWN-KERNEL-SCALE FAIL (${fail})`);
  process.exit(1);
}
console.log('GWN-KERNEL-SCALE PASS');
