// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _loopRootCensus — how many real cubics carry a double point the builder never splits?
//
// Loop-Blinn 2005 (p1000-loop.pdf, "2. The Loop"): the double point sits at the roots
// of H(t,s). "If one of the parameter values should lie in the interval [0,1], then
// the double point will cause a shading anomaly... We eliminate this possibility by
// subdividing the curve at the offending parameter value."
//
// cubicLoopParams returns non-null only when both roots are in span, so:
//   * 2 roots in [0,1] -> cubicLoop() true  -> lbFastMesh:178 declines to Slug
//   * 1 root  in [0,1] -> cubicLoopParams returns NULL -> no decline, no subdivision,
//                         and cubicKLMN takes its `else // loop` branch anyway.
// That second class is exactly the paper's case, and we neither split nor decline it.
//
// Counts both classes across real art.
import { readFileSync } from 'fs';
import path from 'path';
import { parsePathD } from '../src/svg/path.js';
import { SEG_CUBIC } from '../src/primitives/seg.js';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const pathDs = (svg) => {
  const o = [];
  const re = /<path\b[^>]*\bd\s*=\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(svg))) o.push(m[1]);
  return o;
};

// The paper's d1,d2,d3 and the roots of H, without cubicLoopParams' both-in-span gate.
function loopRoots(P) {
  const cr = (a, b) => a[0] * b[1] - a[1] * b[0];
  const C1 = [-3 * P[0][0] + 3 * P[1][0], -3 * P[0][1] + 3 * P[1][1]];
  const C2 = [3 * P[0][0] - 6 * P[1][0] + 3 * P[2][0], 3 * P[0][1] - 6 * P[1][1] + 3 * P[2][1]];
  const C3 = [
    -P[0][0] + 3 * P[1][0] - 3 * P[2][0] + P[3][0],
    -P[0][1] + 3 * P[1][1] - 3 * P[2][1] + P[3][1],
  ];
  const d1 = cr(C2, C3),
    d2 = cr(C3, C1),
    d3 = cr(C1, C2);
  const scale = Math.abs(d1) + Math.abs(d2) + Math.abs(d3) + 1e-12;
  if (Math.abs(d1) < 1e-7 * scale) return null; // cusp/degenerate territory
  const disc = 3 * d2 * d2 - 4 * d1 * d3;
  if (!(disc < 0)) return null; // serpentine, not a loop
  const r = Math.sqrt(4 * d1 * d3 - 3 * d2 * d2);
  return [(d2 + r) / (2 * d1), (d2 - r) / (2 * d1)];
}

const ASSETS = [
  'examples/tiger.svg',
  'examples/_concave_cubic.svg',
  'examples/_dash_cubic.svg',
  '../fixtures/svg/_cnstar.svg',
];
console.log('asset                cubics   loops   0-in-span   1-in-span*   2-in-span');
let tot1 = 0,
  tot2 = 0;
for (const rel of ASSETS) {
  let svg;
  try {
    svg = readFileSync(path.join(ROOT, rel), 'utf8');
  } catch {
    continue;
  }
  let cub = 0,
    loops = 0,
    c0 = 0,
    c1 = 0,
    c2 = 0;
  for (const d of pathDs(svg)) {
    let segs;
    try {
      segs = parsePathD(d);
    } catch {
      continue;
    }
    for (const s of segs || []) {
      if (!s || s.type !== SEG_CUBIC) continue;
      cub++;
      const rr = loopRoots([s.p1, s.p2, s.p3, s.p4]);
      if (!rr) continue;
      loops++;
      const inSpan = (v) => v > 1e-4 && v < 1 - 1e-4;
      const n = (inSpan(rr[0]) ? 1 : 0) + (inSpan(rr[1]) ? 1 : 0);
      if (n === 0) c0++;
      else if (n === 1) c1++;
      else c2++;
    }
  }
  tot1 += c1;
  tot2 += c2;
  console.log(
    `${path.basename(rel).padEnd(20)} ${String(cub).padStart(6)} ${String(loops).padStart(7)} ` +
      `${String(c0).padStart(11)} ${String(c1).padStart(12)} ${String(c2).padStart(11)}`,
  );
}
console.log(`\n* 1-in-span is the paper's case: it needs ONE subdivision and gets none.`);
console.log(`totals: 1-in-span ${tot1}, 2-in-span ${tot2} (2-in-span is what declines today)`);
