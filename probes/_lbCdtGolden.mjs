// _lbCdtGolden.mjs — emit CDT parity goldens (inputs + outputs) for the C# port.
// Each case: { name, pts:[[x,y]...], constraints:[[i,j]...], tris:[[i,j,k]...] }.
// The C# ConstrainedTriangulate must reproduce `tris` exactly (order + values),
// which requires JS-Map insertion-order iteration to be mirrored in C#.
import { writeFileSync } from 'fs';
import { constrainedTriangulate } from '../src/renderer/cdt.js';

// tiny seeded PRNG so the point cloud is deterministic across runs/machines
function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

const ring = (cx, cy, r, n, phase = 0) => Array.from({ length: n }, (_, i) => {
  const a = phase + i / n * Math.PI * 2;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
});
const loopConstraints = (base, n) => Array.from({ length: n }, (_, i) => [base + i, base + (i + 1) % n]);

const cases = [];
const add = (name, pts, constraints) => {
  const r = constrainedTriangulate(pts.map(p => [p[0], p[1]]), constraints.map(c => [c[0], c[1]]));
  cases.push({ name, pts, constraints, tris: r ? r.tris : null });
};

// 1. unit square, 4 boundary constraints
add('square', [[0, 0], [10, 0], [10, 10], [0, 10]], loopConstraints(0, 4));

// 2. square with a centered square hole (two loops)
add('square-hole',
  [[0, 0], [30, 0], [30, 30], [0, 30], [10, 10], [20, 10], [20, 20], [10, 20]],
  [...loopConstraints(0, 4), ...loopConstraints(4, 4)]);

// 3. edge recovery: a thin quad whose required diagonal-constraint crosses the
//    natural Delaunay diagonal (forces at least one flip)
add('edge-recovery',
  [[0, 0], [10, 1], [11, 9], [1, 10], [5, 5]],
  [[0, 1], [1, 2], [2, 3], [3, 0], [0, 2]]);

// 4. through-a-vertex: constraint [0,3] passes exactly through vertex 1 (collinear)
add('through-vertex',
  [[0, 0], [5, 0], [3, 4], [10, 0]],
  [[0, 3], [0, 2], [2, 3]]);

// 5. concave star (10 pts) with its boundary as constraints — recovery-heavy
{
  const pts = [], cons = [];
  for (let i = 0; i < 10; i++) {
    const a = i / 10 * Math.PI * 2, r = (i % 2 === 0) ? 12 : 5;
    pts.push([20 + r * Math.cos(a), 20 + r * Math.sin(a)]);
  }
  add('star-10', pts, loopConstraints(0, 10));
}

// 6. seeded point cloud (40 pts) inside a square boundary — Bowyer-Watson stress
{
  const rnd = mulberry32(12345);
  const pts = [[0, 0], [50, 0], [50, 50], [0, 50]];
  for (let i = 0; i < 40; i++) pts.push([2 + rnd() * 46, 2 + rnd() * 46]);
  add('cloud-40', pts, loopConstraints(0, 4));
}

// 7. two concentric rings (annulus-like) — nested-loop constraints
add('annulus',
  [...ring(0, 0, 12, 8, 0.1), ...ring(0, 0, 6, 8, 0.1)],
  [...loopConstraints(0, 8), ...loopConstraints(8, 8)]);

const out = { version: 1, cases };
writeFileSync(new URL('../../csharp_tests/lb-parity/goldens/cdt.json', import.meta.url), JSON.stringify(out));
console.log('emitted', cases.length, 'CDT cases;', cases.map(c => `${c.name}=${c.tris ? c.tris.length : 'null'}tri`).join(' '));
