// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// turbulenceSpecSmoke — feTurbulence computes the Filter Effects 1 reference algorithm.
//
// feTurbulence.frag.glsl keeps the spec's structure (gradient lattice, s-curve, octaves, stitching) AND its tables (a
// sin() hash for the gradients would match no browser at any seed). It reads the spec's own tables -- the
// lattice selector and four channels of gradients that init(seed) derives with the spec's Park-Miller random() --
// built on the CPU (src/filterGraph/turbulenceLattice.js) and uploaded as one 256x3 RGBA32F texture.
//
// THE ORACLE, test/_turbulenceSpecOracle.mjs, IS A DIRECT FLOAT64 TRANSCRIPTION OF THE SPEC'S C CODE (setup_seed,
// random, init, noise2 with its 2 * BSize + 2 tables and uLatticeSelector[i + by0] indexing, turbulence with
// stitching), written independently of the module under test. Against it:
//   1. the module's tables: the selector exactly, the (pre-permuted, float32) gradients to the float32 rounding;
//   2. a FLOAT32 MODEL OF THE SHADER'S main()/noise2, operation for operation (Math.fround per operation), reading
//      the packed texels exactly as texelFetch does -- at every pixel of a grid, for both types, stitch on/off,
//      1 and 4 octaves, isotropic and anisotropic frequencies, a tile at the origin and one offset from it, and
//      seeds 0, 1, 42, -7, 3.9, -2.5, 2^31 - 1 and 2^32 (seed truncation and setup_seed's clamps);
//   3. points far from the canvas: negative coordinates, and v = point * freq below -4096, where the spec's C
//      truncation toward zero stops being floor;
//   4. the pixel mapping: pixel (i, j) of a canvas at px-per-user s is the user point (i + 0.5, j + 0.5) / s, y down
//      -- the pixel's CENTER, which is where Chrome's output sits closest to the spec (test/turbulenceChromeSmoke.mjs).
// The float32 model sits within 0.001 levels of the oracle on the grid (a sin() hash sits about 30 levels from it
// on average: fractalNoise, 2 octaves, straight channels). Chrome is the pixel reference in test/turbulenceChromeSmoke.mjs.
//
// Also pinned: it costs nothing when unused -- only feTurbulence.frag.glsl declares the lattice sampler, and only the
// feTurbulence handler imports the lattice builder, so no other program gains a sampler and no other path builds one.
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  turbulenceLattice,
  packLatticeTexels,
  turbulenceSetup,
} from '../src/filterGraph/turbulenceLattice.js';
import { specInit, specTurbulence, specColor } from './_turbulenceSpecOracle.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};

// ================= THE SHADER, ported to float32 (feTurbulence.frag.glsl) =================
const f = Math.fround;
function portLatticeCoord(v) {
  // latticeCoord()
  let fl = Math.floor(v);
  if (v < -4096 && fl !== v) fl = f(fl + 1);
  return [fl | 0, f(v - fl)];
}
const texel = (tex, m, row) => tex.subarray((row * 256 + m) * 4, (row * 256 + m) * 4 + 4);
function portNoise2(tex, v, stitching, st) {
  // noise2(), four channels
  let [bx0, rx0] = portLatticeCoord(v[0]);
  let [by0, ry0] = portLatticeCoord(v[1]);
  let bx1 = bx0 + 1,
    by1 = by0 + 1;
  if (stitching) {
    if (bx0 >= st[0]) bx0 -= st[2];
    if (bx1 >= st[0]) bx1 -= st[2];
    if (by0 >= st[1]) by0 -= st[3];
    if (by1 >= st[1]) by1 -= st[3];
  }
  bx0 &= 255;
  bx1 &= 255;
  by0 &= 255;
  by1 &= 255;
  const i = texel(tex, bx0, 0)[0] | 0,
    j = texel(tex, bx1, 0)[0] | 0;
  const b00 = (i + by0) & 255,
    b10 = (j + by0) & 255,
    b01 = (i + by1) & 255,
    b11 = (j + by1) & 255;
  const rx1 = f(rx0 - 1),
    ry1 = f(ry0 - 1);
  const sx = f(f(rx0 * rx0) * f(3 - f(2 * rx0)));
  const sy = f(f(ry0 * ry0) * f(3 - f(2 * ry0)));
  const dot = (rx, ry, m) => {
    const X = texel(tex, m, 1),
      Y = texel(tex, m, 2);
    return [0, 1, 2, 3].map((c) => f(f(rx * X[c]) + f(ry * Y[c])));
  };
  const lrp = (t, a, b) => a.map((x, c) => f(x + f(t * f(b[c] - x))));
  const a = lrp(sx, dot(rx0, ry0, b00), dot(rx1, ry0, b10));
  const b = lrp(sx, dot(rx0, ry1, b01), dot(rx1, ry1, b11));
  return lrp(sy, a, b);
}
// main()'s point: the pixel's canvas center in GL px (y up) → user space (y down).
const portPoint = (px, U) => [f(px[0] * U.userMap[0]), f(f(U.userMap[2] - px[1]) * U.userMap[1])];
// main() from the pixel's canvas center in GL px. U = the uniforms, float32 as uploaded. Returns straight color * 255.
function portMain(tex, px, U) {
  const point = portPoint(px, U);
  let v = [f(point[0] * U.baseFreq[0]), f(point[1] * U.baseFreq[1])];
  return portOctaves(tex, v, U);
}
function portOctaves(tex, v, U) {
  let sum = [0, 0, 0, 0],
    ratio = 1;
  let st = [U.stitchPos[0], U.stitchPos[1], U.stitchSize[0], U.stitchSize[1]];
  for (let o = 0; o < 6; o++) {
    if (o >= U.numOctaves) break;
    const n = portNoise2(tex, v, U.stitch, st);
    sum = sum.map((s, c) => f(s + f((U.kind === 0 ? Math.abs(n[c]) : n[c]) / ratio)));
    v = [f(v[0] * 2), f(v[1] * 2)];
    ratio = f(ratio * 2);
    st = st.map((x) => x * 2);
  }
  return sum.map((s) => 255 * Math.max(0, Math.min(1, U.kind === 0 ? s : f(f(s + 1) * 0.5))));
}
// The uniforms turbulence.js uploads, for a canvas of height H at px-per-user ws, with the subregion `sub` in GL px.
function uniforms(p, H, ws, sub) {
  const tile = [sub[0] / ws, (H - (sub[1] + sub[3])) / ws, sub[2] / ws, sub[3] / ws];
  const s = turbulenceSetup(p.bx, p.by, p.stitch, tile);
  return {
    tile,
    baseFreq: [f(s.fx), f(s.fy)],
    numOctaves: p.oct,
    kind: p.fractal ? 1 : 0,
    stitch: !!s.size,
    stitchPos: s.wrap || [0, 0],
    stitchSize: s.size || [0, 0],
    userMap: [f(1 / ws), f(1 / ws), H],
    fx: s.fx,
    fy: s.fy,
  };
}

// ================= 1. the tables =================
const SEEDS = [0, 1, 42, -7, 3.9, -2.5, 2147483647, 4294967296];
const specTrunc = (x) => Math.trunc(x); // "truncated, i.e. rounded to the closest integer value towards zero"
const tables = new Map();
for (const seed of SEEDS) {
  const spec = specInit(specTrunc(seed));
  const mine = turbulenceLattice(seed);
  const tex = packLatticeTexels(mine);
  let selOk = true,
    gradErr = 0,
    nan = 0;
  for (let m = 0; m < 256; m++) {
    if (mine.selector[m] !== spec.uLatticeSelector[m] || tex[m * 4] !== spec.uLatticeSelector[m])
      selOk = false;
    for (let c = 0; c < 4; c++) {
      const g = spec.fGradient[c][spec.uLatticeSelector[m]];
      if (!Number.isFinite(g[0]) || !Number.isFinite(g[1])) {
        nan++;
        continue;
      }
      gradErr = Math.max(
        gradErr,
        Math.abs(tex[(256 + m) * 4 + c] - g[0]),
        Math.abs(tex[(512 + m) * 4 + c] - g[1]),
      );
    }
  }
  tables.set(seed, { spec, tex });
  const msg = `seed ${seed}: selector ${selOk ? 'identical' : 'DIFFERS'}, packed gradients within ${gradErr.toExponential(1)} of the spec's${nan ? ` (${nan} zero-length gradients, NaN in the spec)` : ''}`;
  if (selOk && gradErr <= 6e-8 && !nan) ok(msg);
  else fail(msg);
}
// Seed semantics: truncation toward zero, then setup_seed maps <= 0 to -(s % (m - 1)) + 1.
{
  const same = (a, b) => {
    const x = turbulenceLattice(a).selector,
      y = turbulenceLattice(b).selector;
    return x.every((v, i) => v === y[i]);
  };
  if (same(0, 1) && same(3.9, 3) && same(-2.5, 3) && same(-2, 3) && !same(4, 3))
    ok('seeds 0 = 1, 3.9 = 3 and -2.5 = -2 = 3 (truncate, then setup_seed), 4 != 3');
  else fail('seed truncation / setup_seed equivalences do not hold');
}

// ================= 2. the shader port against the oracle, on a pixel grid =================
const H = 160,
  W = 160;
const FREQS = [
  [0.05, 0.05],
  [0.013, 0.071],
];
const TILES = [
  [0, 0, 160, 160],
  [37, 23, 90, 70],
]; // GL px: [x, y (from the bottom), w, h]
let worst = 0,
  worstAt = '',
  n = 0;
for (const seed of SEEDS)
  for (const fractal of [false, true])
    for (const stitch of [false, true])
      for (const oct of [1, 4])
        for (const [bx, by] of FREQS)
          for (const sub of stitch ? TILES : [TILES[0]]) {
            const { spec, tex } = tables.get(seed);
            const U = uniforms({ bx, by, stitch, oct, fractal }, H, 1, sub);
            for (let jj = 0; jj < H; jj += 7)
              for (let ii = 0; ii < W; ii += 7) {
                const px = [ii + 0.5, H - 1 - jj + 0.5]; // pixel (ii, jj) top-down → its GL center
                const got = portMain(tex, px, U);
                for (let c = 0; c < 4; c++) {
                  const want = specColor(
                    specTurbulence(
                      spec,
                      c,
                      [ii + 0.5, jj + 0.5],
                      bx,
                      by,
                      oct,
                      fractal,
                      stitch,
                      ...U.tile,
                    ),
                    fractal,
                  );
                  const e = Math.abs(got[c] - want);
                  n++;
                  if (!(e <= worst)) {
                    worst = e;
                    worstAt = `seed ${seed} ${fractal ? 'fractalNoise' : 'turbulence'} stitch ${stitch} oct ${oct} freq ${bx},${by} pixel (${ii},${jj}) ch ${c}: ${got[c].toFixed(3)} vs ${want.toFixed(3)}`;
                  }
                }
              }
          }
if (worst <= 0.05)
  ok(
    `shader port = spec at ${n} channel samples (both types, stitch on/off, 1 and 4 octaves, ${SEEDS.length} seeds): worst ${worst.toFixed(4)} levels`,
  );
else fail(`shader port differs from the spec by ${worst.toFixed(3)} levels at ${worstAt}`);

// ================= 3. far points: negative, and below -4096 cells =================
{
  const { spec, tex } = tables.get(42);
  let w3 = 0,
    at3 = '';
  for (const fractal of [false, true])
    for (const [x, y] of [
      [-37.25, -12.5],
      [-90000.3, 17.2],
      [12.75, -100001.9],
      [-123456.5, -98765.25],
      [5000.5, 8191.75],
    ]) {
      const U = uniforms({ bx: 0.05, by: 0.05, stitch: false, oct: 4, fractal }, H, 1, TILES[0]);
      const got = portOctaves(tex, [f(f(x) * U.baseFreq[0]), f(f(y) * U.baseFreq[1])], U);
      for (let c = 0; c < 4; c++) {
        const want = specColor(
          specTurbulence(spec, c, [x, y], 0.05, 0.05, 4, fractal, false, 0, 0, 0, 0),
          fractal,
        );
        // float32 point * freq carries ~1e-3 cell of rounding at 1e5 px; the noise is smooth, so a level is plenty.
        const e = Math.abs(got[c] - want);
        if (e > w3) {
          w3 = e;
          at3 = `(${x},${y}) ch ${c}: ${got[c].toFixed(2)} vs ${want.toFixed(2)}`;
        }
      }
    }
  if (w3 <= 1)
    ok(
      `far points (negative, and past -4096 cells where C truncation is ceil) agree within ${w3.toFixed(3)} levels`,
    );
  else fail(`far points differ by ${w3.toFixed(2)} levels at ${at3}`);
}

// ================= 4. the pixel mapping, at px-per-user 1 and 2.5 =================
{
  let bad = 0;
  for (const ws of [1, 2.5]) {
    const U = uniforms(
      { bx: 0.05, by: 0.05, stitch: false, oct: 1, fractal: true },
      H,
      ws,
      TILES[0],
    );
    for (const [i, j] of [
      [0, 0],
      [17, 3],
      [159, 159],
      [80, 41],
    ]) {
      const px = [i + 0.5, H - 1 - j + 0.5];
      const point = portPoint(px, U);
      if (Math.abs(point[0] - (i + 0.5) / ws) > 1e-5 || Math.abs(point[1] - (j + 0.5) / ws) > 1e-5)
        bad++;
    }
  }
  if (!bad)
    ok('pixel (i, j) samples the user point (i + 0.5, j + 0.5) / px-per-user, y down (its center)');
  else fail(`${bad} pixels map to the wrong user point`);
  // The port is only evidence about the shader while it computes the same point.
  const shader = readFileSync(path.join(ROOT, 'src/shaders/feTurbulence.frag.glsl'), 'utf8');
  if (shader.includes('vec2 point = vec2(px.x, uUserMap.z - px.y) * uUserMap.xy;'))
    ok('the shader computes the point the port does');
  else fail("feTurbulence.frag.glsl's point differs from the model's — update portPoint with it");
}

// ================= 5. nothing new where turbulence is not drawn =================
{
  const SH = path.join(ROOT, 'src/shaders');
  const decl = readdirSync(SH)
    .filter((x) => x.endsWith('.glsl'))
    .filter((x) => /\buLattice\b/.test(readFileSync(path.join(SH, x), 'utf8')));
  const gen = readdirSync(path.join(SH, 'generated'))
    .filter((x) => x.endsWith('.glsl'))
    .filter((x) => /\buLattice\b/.test(readFileSync(path.join(SH, 'generated', x), 'utf8')));
  if (decl.join() === 'feTurbulence.frag.glsl' && gen.join() === 'feTurbulence.frag.glsl')
    ok('only feTurbulence.frag.glsl (source and generated) declares the lattice sampler');
  else
    fail(
      `the lattice sampler is declared in: ${[...decl, ...gen.map((x) => 'generated/' + x)].join(', ')}`,
    );
  const importers = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'generated') walk(p);
      } else if (
        e.name.endsWith('.js') &&
        /turbulenceLattice\.js/.test(readFileSync(p, 'utf8')) &&
        !p.endsWith('turbulenceLattice.js')
      )
        importers.push(path.relative(ROOT, p));
    }
  };
  walk(path.join(ROOT, 'src'));
  if (importers.join() === 'src/filterGraph/primitives/turbulence.js')
    ok('only the feTurbulence handler builds lattice tables');
  else fail(`turbulenceLattice.js is imported by: ${importers.join(', ')}`);
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nturbulenceSpecSmoke: feTurbulence is the spec's algorithm, table for table");
