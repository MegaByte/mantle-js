// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// glslEmuFidelitySmoke — the CPU float32 emulation of the band and tree fill kernels (test/_glslEmu.mjs) answers what the
// geometry says, so a smoke that tests a kernel through it is testing the kernel and not the harness.
//
// Six shapes (lines, quads, cubics including a self-intersecting loop, native arcs, an even-odd hole, nested same-wound
// contours) imported with the GWN run tree, every pixel center within two pixels of the bbox. The arcs sit off the
// pixel lattice: GWN's lune test disagrees with its chord crossing at a pixel exactly ON a piece's chord, which an
// integer circle puts on its diagonals (guarded separately, gwnChordLuneSmoke); this smoke is about the harness.
//   (a) GWN winding-only and band-hard equal an independent f64 point-in-fill test at every pixel whose 2x2-pixel
//       neighborhood is all inside or all outside (16x16 supersampled);
//   (b) AAC's coverage is the exact area: mean |error| under 0.004 and max under 0.03 against a 32x32 supersampled
//       f64 winding reference (the reference's own error is ~1/1024 per pixel); GWN + SDF is an AA approximation of
//       it: mean under 0.02;
//   (c) scaleFillData, the exact rescale the scale-invariance smokes use, round-trips bit for bit (2 then 1/2), and
//       the kernels read the same at S = 2 as at 1 on every shape here.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  hasCxx,
  buildGlslEmu,
  fillShapes,
  scaleFillData,
  K_GWN,
  K_AAC,
  K_HARD,
  K_SLUG,
  GWN_SDF,
  GWN_WIND,
  AAC_HARD,
} from './_glslEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!hasCxx()) {
  console.log('SKIP glslEmuFidelitySmoke: no C++ compiler ($CXX, clang++, g++, c++)');
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
const { pointInFill } = await import('../src/hitTest/fillCoverage.js');
void readFileSync;

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">
  <path fill-rule="evenodd" d="M10 10 H110 V110 H10 Z M35 30 L90 45 L60 95 Z"/>
  <path d="M140 60 Q 190 -10 240 60 T 340 60 Q 300 130 240 110 Q 180 140 140 60 Z"/>
  <path d="M20 150 C 140 290 140 130 20 270 C 60 230 60 190 20 150 Z"/>
  <path d="M170 150 C 330 280 170 280 330 150 L 330 280 L 170 280 Z"/>
  <path d="M250.37 200.21 m -45.13 0 a 45.13 45.13 0 1 0 90.26 0 a 45.13 45.13 0 1 0 -90.26 0 Z M250.37 200.21 m -20 0 a 20 32 30 1 1 40 0 a 20 32 30 1 1 -40 0 Z"/>
  <path d="M345 170 H395 V290 H345 Z M355 180 H385 V280 H355 Z"/>
</svg>`;
const b = await importSvg(SVG, { preserveViewport: true, gwnTree: true });
const shapes = fillShapes(b, parseMetaBin, M);
const band = new Float32Array(b.bands),
  curve = new Float32Array(b.curves);
ok(shapes.length === 6, `six fill shapes (${shapes.length})`);
const eGS = buildGlslEmu(ROOT, { defines: GWN_SDF }),
  eGW = buildGlslEmu(ROOT, { defines: GWN_WIND }),
  eAH = buildGlslEmu(ROOT, { defines: AAC_HARD });

const queries = [],
  refs = [];
for (const sh of shapes) {
  const segs = decodeSegs(curve, sh.range.begin, sh.range.end);
  const inside = (x, y) => pointInFill(segs, x, y, sh.eo);
  for (let y = Math.floor(sh.bb[1]) - 2; y <= Math.ceil(sh.bb[3]) + 2; y++)
    for (let x = Math.floor(sh.bb[0]) - 2; x <= Math.ceil(sh.bb[2]) + 2; x++) {
      let a = 0,
        wide = 0;
      for (let j = 0; j < 32; j++)
        for (let i = 0; i < 32; i++) if (inside(x + (i + 0.5) / 32, y + (j + 0.5) / 32)) a++;
      for (let j = 0; j < 16; j++)
        for (let i = 0; i < 16; i++)
          if (inside(x - 0.5 + (i + 0.5) / 8, y - 0.5 + (j + 0.5) / 8)) wide++;
      queries.push({ GD: sh.GD, bb: sh.bb, eo: sh.eo, c: [x + 0.5, y + 0.5], ePx: [1, 1] });
      refs.push({
        area: a / 1024,
        hard: inside(x + 0.5, y + 0.5) ? 1 : 0,
        solid: wide === 0 || wide === 256,
      });
    }
}
const run = (emu, k, bnd = band, crv = curve, qs = queries) =>
  emu.run(
    bnd,
    crv,
    qs.map((q) => ({ ...q, k })),
  );
const gw = run(eGW, K_GWN),
  hd = run(eAH, K_HARD),
  aac = run(eAH, K_AAC),
  gs = run(eGS, K_GWN);

// ---- (a) ------------------------------------------------------------------------------------------------------------
{
  let n = 0,
    wrongGw = 0,
    wrongHd = 0;
  refs.forEach((r, i) => {
    if (!r.solid) return;
    n++;
    if (gw[i] !== r.hard) {
      wrongGw++;
      if (process.env.DEBUG && wrongGw < 30)
        console.log('   GWN wrong', queries[i].GD.join(','), queries[i].c.join(','), gw[i], r.hard);
    }
    if (hd[i] !== r.hard) wrongHd++;
  });
  ok(
    n > 20000 && wrongGw === 0 && wrongHd === 0,
    `(a) GWN winding and band-hard match the f64 point-in-fill test at ${n} settled pixels (wrong: GWN ${wrongGw}, band-hard ${wrongHd})`,
  );
}
// ---- (b) ------------------------------------------------------------------------------------------------------------
{
  let eA = 0,
    mA = 0,
    eG = 0;
  refs.forEach((r, i) => {
    const d = Math.abs(aac[i] - r.area);
    eA += d;
    mA = Math.max(mA, d);
    eG += Math.abs(gs[i] - r.area);
  });
  const n = refs.length;
  ok(
    eA / n < 0.004 && mA < 0.03,
    `(b) AAC is the area: mean |error| ${(eA / n).toFixed(5)}, max ${mA.toFixed(4)} over ${n} px`,
  );
  ok(eG / n < 0.02, `(b) GWN + SDF approximates it: mean |error| ${(eG / n).toFixed(5)}`);
  const sl = run(eAH, K_SLUG);
  let eS = 0;
  refs.forEach((r, i) => {
    eS += Math.abs(sl[i] - r.area);
  });
  ok(
    eS / n < 0.02,
    `(b) so does Slug's renderFill (the dual-ray blend): mean |error| ${(eS / n).toFixed(5)}`,
  );
}
// ---- (c) ------------------------------------------------------------------------------------------------------------
{
  const up = scaleFillData(band, curve, shapes, 2),
    back = scaleFillData(
      up.band,
      up.curve,
      shapes.map((s) => ({ ...s, bb: s.bb.map((v) => v * 2) })),
      0.5,
    );
  const same =
    back.band.every((v, i) => Object.is(v, band[i])) &&
    back.curve.every((v, i) => Object.is(v, curve[i]));
  const changed = up.band.some((v, i) => v !== band[i]) && up.curve.some((v, i) => v !== curve[i]);
  ok(same && changed, '(c) scaleFillData changes the data and round-trips it bit for bit');
  const qs = queries.map((q) => ({
    ...q,
    bb: q.bb.map((v) => v * 2),
    c: [q.c[0] * 2, q.c[1] * 2],
    ePx: [2, 2],
  }));
  const diffs = [
    [gw, run(eGW, K_GWN, up.band, up.curve, qs)],
    [hd, run(eAH, K_HARD, up.band, up.curve, qs)],
    [aac, run(eAH, K_AAC, up.band, up.curve, qs)],
    [gs, run(eGS, K_GWN, up.band, up.curve, qs)],
  ].map(([a, c]) => a.reduce((s, v, i) => s + (v !== c[i] ? 1 : 0), 0));
  ok(
    diffs.every((d) => d === 0),
    `(c) every kernel reads the same at S = 2 (differing pixels: GWN wind ${diffs[0]}, band-hard ${diffs[1]}, AAC ${diffs[2]}, GWN + SDF ${diffs[3]})`,
  );
}

if (fail) {
  console.error(`GLSL-EMU-FIDELITY FAIL (${fail})`);
  process.exit(1);
}
console.log('GLSL-EMU-FIDELITY PASS');
