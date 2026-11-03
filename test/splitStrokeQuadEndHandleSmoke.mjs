// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// splitStrokeQuadEndHandleSmoke — the split-stroke pass (incrementalStroke's) caps a quad at the end its control point
// sits on.
//
// THE HAZARD. A vertex stage that carries every segment as a cubic hull sends a QUAD's control point out
// degree-elevated -- P1 = q0 + (2/3)(q1 - q0), P2 = q2 + (2/3)(q1 - q2) -- and a fragment stage that rebuilds it from
// the START half, q1 = P0 + 1.5 (P1 - P0), is exact in neither step in float32. When q1 sits ON the end point the
// quad's end handle is zero and its end direction is the chord (the encoder's rule, and the direction
// incrementalStroke hands the neighbour); rebuilt, the handle comes back as the rounding residue of the two steps -- a
// vector of a few ulps of the coordinates, far over the 1e-9-of-the-span cut, pointing anywhere -- and the butt cap
// and join planes at that end are built on it. The start is exact either way (P1 - P0 is exactly zero there).
//
// The pass is the SHIPPED text of both stages in float32 (test/_glslEmu.mjs buildSplitStrokeEmu): strokeVertexSetup
// reads the segment incrementalStroke writes (encodeSeg's format) and strokeCoverage runs on the varyings it sets.
//
// (a) quads q0 -> q2 with q1 = q2, in 24 directions, at offsets 0, 100 and 3000 from the origin, at 2^-20, 1 and 2^20,
//     both ends butt-capped: pixels 0.3 .. 0.9 halfW behind the END plane along the chord are uncovered, and pixels
//     0.3 .. 0.6 halfW in front of it are covered (at a pixel 1/64 of a half-width);
// (b) the mirror, q1 = q0, holds at the START;
// (c) and the plane is where the chord puts it, not merely near: on the plane itself, 0.5 halfW to either side, the
//     coverage is 0.5 +- 0.02 at offsets 0 and 100 (a turn of 1e-3 rad moves it 0.03). At 3000 the float32 coordinates
//     alone move a pixel 1/64 of a half-width wide by more than that, so that offset is not asked.
import path from 'path';
import { fileURLToPath } from 'url';
import * as EMU from './_glslEmu.mjs';
import { encodeSeg, makeTexelBuffer } from '../src/svg/textures.js';
import { mkQuad } from '../src/svg/segment.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const SCALES = [2 ** -20, 1, 2 ** 20];
const lg = (S) => `2^${Math.round(Math.log2(S))}`;
const f = Math.fround;

if (!EMU.hasCxx() || !EMU.buildSplitStrokeEmu) {
  console.log(
    `  ${EMU.buildSplitStrokeEmu ? 'SKIPPED: no C++ compiler ($CXX, clang++, g++, c++) for the kernel emulation' : 'FAIL: test/_glslEmu.mjs has no buildSplitStrokeEmu'}`,
  );
  process.exit(EMU.buildSplitStrokeEmu ? 0 : 1);
}
const emu = EMU.buildSplitStrokeEmu(ROOT);

/// One quad per case, each in its own prim plane as incrementalStroke writes it (a free, butt-capped segment).
function cases(S, onEnd) {
  const out = [];
  for (const off of [0, 100, 3000])
    for (let k = 0; k < 24; k++) {
      const a = ((k + 0.37) * 2 * Math.PI) / 24,
        L = 1.7 + 0.1 * (k % 5);
      const q0 = [f((off + 0.113 * (k % 7)) * S), f((off - 0.271 * (k % 3)) * S)];
      const q2 = [f(q0[0] + L * Math.cos(a) * S), f(q0[1] + L * Math.sin(a) * S)];
      const q1 = onEnd ? q2 : q0;
      const buf = makeTexelBuffer();
      const base = encodeSeg(mkQuad(q0, q1, q2), buf, true, true, [0, 0], [0, 0], 0);
      const prim = new Float32Array(buf.floats.subarray(0, buf.count * 4));
      const d = [q2[0] - q0[0], q2[1] - q0[1]],
        l = Math.hypot(d[0], d[1]);
      out.push({ off, k, prim, base, q0, q2, T: [d[0] / l, d[1] / l], halfW: 0.05 * l });
    }
  return out;
}
/// Pixels about the tested end's plane: `depth` in half-widths past it (outward), `lat` across; want = covered.
function probes(cs, atEnd, depths, lats, want) {
  const qs = [],
    meta = [];
  for (const c of cs) {
    const V = atEnd ? c.q2 : c.q0,
      out = atEnd ? c.T : [-c.T[0], -c.T[1]],
      n = [-c.T[1], c.T[0]];
    for (const dp of depths)
      for (const lt of lats) {
        qs.push({
          base: c.base,
          c: [
            V[0] + (out[0] * dp + n[0] * lt) * c.halfW,
            V[1] + (out[1] * dp + n[1] * lt) * c.halfW,
          ],
          ePx: [c.halfW / 64, c.halfW / 64],
          halfW: c.halfW,
          cap: 0,
          join: 0,
        });
        meta.push({ c, dp, lt, want });
      }
  }
  return { qs, meta };
}
function run(cs, atEnd, depths, lats, want) {
  // one prim plane per case: run them one case at a time
  let n = 0,
    bad = 0,
    first = '';
  for (const c of cs) {
    const { qs, meta } = probes([c], atEnd, depths, lats, want);
    const cov = emu.run(c.prim, qs);
    for (let i = 0; i < qs.length; i++) {
      n++;
      const wrong =
        typeof want === 'number' ? Math.abs(cov[i] - want) > 0.02 : cov[i] > 0.5 !== want;
      if (wrong) {
        bad++;
        if (!first)
          first = `offset ${c.off} direction ${c.k} at ${meta[i].dp} halfW past the plane, ${meta[i].lt} across: coverage ${cov[i].toFixed(3)}`;
      }
    }
  }
  return { n, bad, first };
}

for (const S of SCALES) {
  const endCases = cases(S, true),
    startCases = cases(S, false);
  const behind = run(endCases, true, [0.3, 0.6, 0.9], [-0.7, 0, 0.7], false);
  const front = run(endCases, true, [-0.3, -0.6], [-0.6, 0, 0.6], true);
  ok(
    behind.bad === 0 && front.bad === 0,
    `(a) control point ON the end, at ${lg(S)}: ${behind.bad} of ${behind.n} pixels behind the end plane covered, ${front.bad} of ${front.n} in front of it uncovered${behind.first || front.first ? ' -- first ' + (behind.first || front.first) : ''}`,
  );
  const sb = run(startCases, false, [0.3, 0.6, 0.9], [-0.7, 0, 0.7], false);
  const sf = run(startCases, false, [-0.3, -0.6], [-0.6, 0, 0.6], true);
  ok(
    sb.bad === 0 && sf.bad === 0,
    `(b) control point ON the start, at ${lg(S)}: ${sb.bad} of ${sb.n} behind covered, ${sf.bad} of ${sf.n} in front uncovered`,
  );
  const on = run(
    endCases.filter((c) => c.off < 3000),
    true,
    [0],
    [-0.5, 0, 0.5],
    0.5,
  );
  ok(
    on.bad === 0,
    `(c) on the end plane itself, at ${lg(S)}: ${on.bad} of ${on.n} pixels off coverage 0.5 by more than 0.02${on.first ? ' -- first ' + on.first : ''}`,
  );
}

console.log(
  fail ? `SPLIT-STROKE-QUAD-END-HANDLE FAIL (${fail})` : 'SPLIT-STROKE-QUAD-END-HANDLE PASS',
);
process.exit(fail ? 1 : 0);
