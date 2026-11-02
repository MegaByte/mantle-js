// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// patternTransformPixelSmoke — a pattern's children are walked with the device pixel as it measures in pattern space
//.
//
// THE HAZARD. mantle.frag's vector-pattern block maps the fragment into the tile's own units (patternTransform's
// inverse). Walking every child there with the USER-space pixel (ePx, invPx) is wrong under a scaled patternTransform:
// the pixel is a different size in pattern space -- a quarter of it under scale(4) -- so each child's AA ramp, its
// stroke's reach and ramp and the tile-seam window would be 4x too wide (under a shrink, 4x too narrow: a hard, aliased edge).
//
// The children take the pattern-space pixel: the fwidth of the mapped derivatives for the ramps and the window, its
// reciprocal (or, in a rotated-map program, the map's inverse) for the fill kernel. With no patternTransform the user
// pixel is kept bit for bit.
//
// The whole fragment main() runs from the shipped text in float32 (test/_glslMainEmu.mjs). The same user-space picture is
// drawn three ways -- a pattern under scale(4), a pattern under scale(0.25), and its shapes drawn directly -- and each
// pattern pixel is held to the direct drawing's: a disc inside the tile, bands running across the tile seams (the wrap
// neighbours' window) and a butt-capped stroke child, at 2 px per user unit, in the Slug and AAC programs. The kernels
// are the same kernels on the same geometry up to a power-of-two scale, so the pixels agree to rounding.
import { readFileSync } from 'fs';
import { buildMainEmu, runMainEmu, hasMainEmu } from './_glslMainEmu.mjs';
import { prepareAsset, scenarios } from './_shaderIdentity.mjs';

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
if (!hasMainEmu()) {
  console.log('  SKIPPED: needs a C++ compiler and clang');
  process.exit(0);
}

const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${body}</svg>`;
// the user-space picture: a 32-unit tile holding a disc r 10.8 at its center, a band across its whole width and another
// down its whole height (so each meets itself across the tile seams: the wrap neighbours' window), and a butt-capped
// horizontal stroke 2 wide from x 4 to 28 at y 24. Everything is a PATH: a <circle> or <rect> element imports as an SDF
// primitive, which a pattern child is not.
const disc = (cx, cy, r) =>
  `<path d="M${cx - r} ${cy} A${r} ${r} 0 1 0 ${cx + r} ${cy} A${r} ${r} 0 1 0 ${cx - r} ${cy} Z"/>`;
const box = (x0, y0, x1, y1) => `<path d="M${x0} ${y0} H${x1} V${y1} H${x0} Z"/>`;
const pat = (k, T) => {
  const s = (v) => +(v / k).toPrecision(12);
  return (
    `<defs><pattern id="p" width="${s(32)}" height="${s(32)}" patternUnits="userSpaceOnUse"${T}>` +
    disc(s(16), s(16), s(10.8)) +
    box(0, s(6.3), s(32), s(9.1)) +
    box(s(3.3), 0, s(4.9), s(32)) +
    `<path d="M${s(4)} ${s(24)} H${s(28)}" stroke="#000" stroke-width="${s(2)}" fill="none"/></pattern></defs>` +
    '<rect x="0" y="0" width="64" height="64" fill="url(#p)"/>'
  );
};
let direct =
  box(0, 6.3, 64, 9.1) + box(0, 38.3, 64, 41.1) + box(3.3, 0, 4.9, 64) + box(35.3, 0, 36.9, 64);
for (let j = 0; j < 2; j++)
  for (let i = 0; i < 2; i++)
    direct +=
      disc(16 + 32 * i, 16 + 32 * j, 10.8) +
      `<path d="M${4 + 32 * i} ${24 + 32 * j} H${28 + 32 * i}" stroke="#000" stroke-width="2" fill="none"/>`;

const E = 0.5,
  N = 128; // 2 px per user unit, 64 units
/// Every pixel's alpha over [0, 64]^2: the given rows' coverages composited OVER (opaque black), as the pattern block
/// composites its children.
function alphas(emu, P, rows) {
  const U = scenarios(P)[0].U,
    out = new Float32Array(N * N);
  for (const s of rows) {
    const frags = [];
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        const v = new Map(
          Object.entries({
            vInst: s,
            vKind: -1,
            vOverrideTint: [1, 1, 1, 1],
            vOverrideMask: 0,
            vOverrideFill: [0, 0, 0, 0],
            vOverrideStroke: [0, 0, 0, 0],
            vOverrideStrokeWidth: 0,
            vInstBias: [0, 0, 0, 0],
            vEmCoord: [(i + 0.5) * E, (j + 0.5) * E],
          }),
        );
        frags.push({ varyings: v, dx: [E, 0], dy: [0, E], fc: [i + 0.5, j + 0.5] });
      }
    const r = runMainEmu(emu, P.T, U, frags);
    for (let k = 0; k < N * N; k++)
      if (!r[k * 5 + 4]) out[k] = r[k * 5 + 3] + out[k] * (1 - r[k * 5 + 3]);
  }
  return out;
}
const rowsOf = (P) => Array.from({ length: P.N }, (_, s) => s);
const genText = readFileSync(
  new URL('../src/shaders/generated/mantle.frag.glsl', import.meta.url),
  'utf8',
);
// The bar per program: AAC's area is exact, so the tile's two halves of a band sum to the direct band's coverage to rounding;
// Slug reads a band's end at the seam as two corner pixels, which it resolves to within a few levels -- 2.1/255 here
// with or without a patternTransform.
for (const [vn, defs, bar] of [
  ['slug', [], 3 / 255],
  ['aac', ['MANTLE_AAC', 'MANTLE_AAC_PAIR_BANDS'], 0.5 / 255],
]) {
  const emu = buildMainEmu(genText, defs);
  const Pd = await prepareAsset({ name: 'direct', svg: svg(direct) });
  const ref = alphas(emu, Pd, rowsOf(Pd));
  let edge = 0;
  for (const a of ref) if (a > 0.004 && a < 0.996) edge++;
  for (const [name, k, T] of [
    ['scale(4)', 4, ' patternTransform="scale(4)"'],
    ['scale(0.25)', 0.25, ' patternTransform="scale(0.25)"'],
    ['no patternTransform', 1, ''],
  ]) {
    const P = await prepareAsset({ name, svg: svg(pat(k, T)) });
    // the carrier: the rect's row (the only row the page draws; its children are rows the pattern block reads)
    const carrier = rowsOf(P).filter((s) => Math.abs(P.meta[s * 48 + 10 * 4 + 3] - 2) < 0.5); // MT_ATLAS .w == 2
    const got = alphas(emu, P, carrier);
    let worst = 0,
      at = -1,
      bad = 0;
    for (let q = 0; q < N * N; q++) {
      const d = Math.abs(got[q] - ref[q]);
      if (d > worst) {
        worst = d;
        at = q;
      }
      if (d > bar) bad++;
    }
    ok(
      carrier.length === 1 && edge > 500 && bad === 0,
      `${vn}, ${name}: ${bad} of ${N * N} pixels off the direct drawing by over ${(bar * 255).toFixed(1)}/255 (worst ${(worst * 255).toFixed(1)}/255` +
        `${at >= 0 ? ` at (${((at % N) + 0.5) * E}, ${(Math.floor(at / N) + 0.5) * E})` : ''}; ${edge} edge pixels in the reference)`,
    );
  }
}
console.log(fail ? `PATTERN-TRANSFORM-PIXEL FAIL (${fail})` : 'PATTERN-TRANSFORM-PIXEL PASS');
process.exit(fail ? 1 : 0);
