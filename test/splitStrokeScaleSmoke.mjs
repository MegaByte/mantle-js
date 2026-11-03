// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// splitStrokeScaleSmoke — the split-stroke pass (incrementalStroke's) covers a drawing scaled by a power of two exactly
// as it covers the drawing: no absolute pixel-size floor.
//
// THE HAZARD. A pixel size of max(0.5 * (ePx.x + ePx.y), 1e-6) in _strokeCoverage.glsl is an em length. Art whose
// pixel is under 1e-6 em (a stroke 0.1 of a unit wide at 2^-20, viewed at a few pixels to the unit) would have its
// pixel read as 1e-6: the hairline floor then takes the stroke for sub-pixel, draws it at half a pixel of 1e-6 and
// fades it by the ratio -- a butt-capped quad 64 pixels wide comes out at coverage 0.16 everywhere. The guard is a
// zero-derivative guard (1e-30), like the fill shader's twin of it, mantle.frag.glsl's `invPx`.
//
// THE PROPERTY, as test/strokeFloorsScaleSmoke.mjs states it: scaling every coordinate and the pixel by 2^k is exact in
// float32, and coverage is dimensionless, so with no length in a constant the coverage at 2^-20 and 2^20 is BIT FOR BIT
// the coverage at scale 1. Both stages of the pass run from their shipped text (test/_glslEmu.mjs buildSplitStrokeEmu).
//
// A line, a quad and a cubic -- butt, round and square capped -- on a grid of pixels 1/16 of a half-width wide about
// each end and across the body, and a hairline (a quarter pixel wide).
import path from 'path';
import { fileURLToPath } from 'url';
import * as EMU from './_glslEmu.mjs';
import { encodeSeg, makeTexelBuffer } from '../src/svg/textures.js';
import { mkLine, mkQuad, mkCubic } from '../src/svg/segment.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const f = Math.fround;
const lg = (S) => `2^${Math.round(Math.log2(S))}`;
if (!EMU.hasCxx() || !EMU.buildSplitStrokeEmu) {
  console.log(
    `  ${EMU.buildSplitStrokeEmu ? 'SKIPPED: no C++ compiler' : 'FAIL: test/_glslEmu.mjs has no buildSplitStrokeEmu'}`,
  );
  process.exit(EMU.buildSplitStrokeEmu ? 0 : 1);
}
const emu = EMU.buildSplitStrokeEmu(ROOT);

const SEGS = [
  ['line', (S) => mkLine([f(0.3) * S, f(0.2) * S], [f(1.9) * S, f(1.1) * S])],
  [
    'quad',
    (S) => mkQuad([f(0.3) * S, f(0.2) * S], [f(1.0) * S, f(1.6) * S], [f(1.9) * S, f(0.4) * S]),
  ],
  [
    'cubic',
    (S) =>
      mkCubic(
        [f(0.3) * S, f(0.2) * S],
        [f(0.4) * S, f(1.5) * S],
        [f(1.6) * S, f(-0.7) * S],
        [f(1.9) * S, f(0.9) * S],
      ),
  ],
];
/// Coverage of one segment at a pixel grid, at scale S (every coordinate and the pixel multiplied by S).
function coverage(seg, S, cap, halfW, px) {
  const buf = makeTexelBuffer();
  const s = seg(S);
  const base = encodeSeg(s, buf, true, true, [0, 0], [0, 0], 0);
  const prim = new Float32Array(buf.floats.subarray(0, buf.count * 4));
  const ends = [s.p1, s.type === 0 ? s.p2 : s.type === 1 ? s.p3 : s.p4];
  const mid = [(ends[0][0] + ends[1][0]) / 2, (ends[0][1] + ends[1][1]) / 2];
  const qs = [];
  for (const V of [...ends, mid])
    for (let j = -12; j <= 12; j++)
      for (let i = -12; i <= 12; i++) {
        // pixel centers on a grid of float32 values that scale exactly
        qs.push({
          base,
          c: [f(V[0] / S + i * 0.137 * halfW) * S, f(V[1] / S + j * 0.137 * halfW) * S],
          ePx: [f(px) * S, f(px) * S],
          halfW: f(halfW) * S,
          cap,
          join: 0,
        });
      }
  return emu.run(prim, qs);
}

for (const [name, seg] of SEGS)
  for (const cap of [0, 1, 2])
    for (const [halfW, px, tag] of [
      [0.08, 0.005, 'wide'],
      [0.002, 0.016, 'hairline'],
    ]) {
      const one = coverage(seg, 1, cap, halfW, px);
      for (const S of [2 ** -20, 2 ** 20]) {
        const at = coverage(seg, S, cap, halfW, px);
        let bad = 0,
          first = '';
        for (let i = 0; i < one.length; i++)
          if (at[i] !== one[i]) {
            bad++;
            if (!first) first = `${at[i].toFixed(4)} for ${one[i].toFixed(4)}`;
          }
        ok(
          bad === 0,
          `${name}, cap ${cap}, ${tag} at ${lg(S)}: ${bad} of ${one.length} pixels' coverage differs from scale 1's${first ? ' -- first ' + first : ''}`,
        );
      }
    }
console.log(fail ? `SPLIT-STROKE-SCALE FAIL (${fail})` : 'SPLIT-STROKE-SCALE PASS');
process.exit(fail ? 1 : 0);
