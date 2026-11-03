// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _cdtRelayoutDiff — differential + perf gate for the flat-internals delaunay relayout.
//
// The committed golden (probes/_lbCdtGolden.mjs) covers 7 cases topping out at 82 triangles.
// That is nowhere near enough to trust a rewrite of the build's hot loop: it never grows the
// triangle/edge/cavity tables, never hits a large cavity, and never sees a degenerate cloud.
//
// So: run the PRE-CHANGE implementation (extracted from git as _cdtOld.tmp.js) and the new one
// over the same corpus and require exact equality — same triangle count, same order, same
// values. Order matters: cdt.js's tie-breaks depend on bookkeeping order (edge push/swap-pop,
// LIFO flood fill, firstE first-seen order), so an order difference means the relayout silently
// changed the mesh, even if both meshes are individually valid.
//
// Run with: node probes/_cdtRelayoutDiff.mjs   (CDT_BASE=<git-ref> to pick the baseline)
// The "old" side is extracted from git at run time, so this probe is self-contained and always
// compares against the committed baseline rather than a stale copy someone forgot to refresh.
import { execFileSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OLD_REF = process.env.CDT_BASE || 'HEAD';
const OLD_TMP = path.join(HERE, '../src/renderer/_cdtOld.tmp.js');
writeFileSync(
  OLD_TMP,
  execFileSync('git', ['show', `${OLD_REF}:js.kontek.mantle/src/renderer/cdt.js`], {
    cwd: path.join(HERE, '../..'),
    encoding: 'utf8',
  }),
);
const { constrainedTriangulate: fresh } = await import('../src/renderer/cdt.js');
const { constrainedTriangulate: old } = await import('../src/renderer/_cdtOld.tmp.js');
process.on('exit', () => {
  try {
    unlinkSync(OLD_TMP);
  } catch {
    /* already gone */
  }
});

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const loop = (base, n) => Array.from({ length: n }, (_, i) => [base + i, base + ((i + 1) % n)]);

// Contour-like: points along offset closed curves. This is the distribution the real LB build
// feeds in, and the one delaunay's walk-to-locate is tuned for.
function contour(seed, count, lobes) {
  const rnd = mulberry32(seed),
    pts = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const r = 40 + 14 * Math.sin(a * lobes) + rnd() * 0.7;
    pts.push([50 + r * Math.cos(a), 50 + r * Math.sin(a)]);
  }
  return { pts, cons: loop(0, count) };
}
function cloud(seed, count) {
  const rnd = mulberry32(seed);
  const pts = [
    [0, 0],
    [100, 0],
    [100, 100],
    [0, 100],
  ];
  for (let i = 0; i < count; i++) pts.push([1 + rnd() * 98, 1 + rnd() * 98]);
  return { pts, cons: loop(0, 4) };
}
// Degenerate-ish: many exactly-collinear and exactly-duplicate points — the cases the exact
// predicates exist for, and where a tie-break divergence would surface first.
function degenerate(seed) {
  const rnd = mulberry32(seed);
  const pts = [
    [0, 0],
    [60, 0],
    [60, 60],
    [0, 60],
  ];
  for (let i = 0; i < 30; i++) pts.push([i * 2, 30]); // exactly collinear
  for (let i = 0; i < 10; i++) pts.push([20, 20]); // exact duplicates
  for (let i = 0; i < 20; i++) {
    const v = Math.round(rnd() * 6) * 10;
    pts.push([v, Math.round(rnd() * 6) * 10]);
  }
  return { pts, cons: loop(0, 4) };
}

const corpus = [];
for (const n of [8, 32, 128, 512, 1200, 3000])
  for (const lobes of [3, 7])
    corpus.push([`contour-${n}-l${lobes}`, contour(n * 7 + lobes, n, lobes)]);
for (const n of [10, 60, 300, 900, 2500]) corpus.push([`cloud-${n}`, cloud(n + 5, n)]);
for (let s = 0; s < 6; s++) corpus.push([`degenerate-${s}`, degenerate(s)]);
corpus.push([
  'tiny-3',
  {
    pts: [
      [0, 0],
      [1, 0],
      [0, 1],
    ],
    cons: [],
  },
]);
corpus.push([
  'collinear-only',
  {
    pts: [
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
    ],
    cons: [],
  },
]);

const key = (r) => (r && r.tris ? r.tris.map((t) => t.join(',')).join(';') : 'null');

let fail = 0,
  maxTris = 0;
for (const [name, c] of corpus) {
  const a = old(
    c.pts.map((p) => [p[0], p[1]]),
    c.cons.map((e) => [e[0], e[1]]),
  );
  const b = fresh(
    c.pts.map((p) => [p[0], p[1]]),
    c.cons.map((e) => [e[0], e[1]]),
  );
  const ka = key(a),
    kb = key(b);
  maxTris = Math.max(maxTris, a && a.tris ? a.tris.length : 0);
  if (ka !== kb) {
    fail++;
    const na = a && a.tris ? a.tris.length : -1,
      nb = b && b.tris ? b.tris.length : -1;
    console.log(`  MISMATCH ${name}: old=${na}tri new=${nb}tri`);
    if (na === nb && na > 0) {
      let firstDiff = -1;
      for (let i = 0; i < na; i++)
        if (a.tris[i].join(',') !== b.tris[i].join(',')) {
          firstDiff = i;
          break;
        }
      console.log(
        `    same count, first differing triangle @${firstDiff}: old=[${a.tris[firstDiff]}] new=[${b.tris[firstDiff]}]`,
      );
    }
  }
}
console.log(
  `\ndifferential: ${corpus.length - fail}/${corpus.length} cases EXACT (order + values), largest ${maxTris} tris`,
);
if (fail) {
  console.log(`FAIL: ${fail} case(s) diverged — the relayout changed the mesh.`);
  process.exit(1);
}

// ---- perf, same corpus shape as probes/_wasmCdtBench.mjs so the numbers are comparable ----
const bench = (fn, c, reps = 5) => {
  for (let i = 0; i < 2; i++)
    fn(
      c.pts.map((p) => [p[0], p[1]]),
      c.cons.map((e) => [e[0], e[1]]),
    );
  let best = Infinity;
  for (let r = 0; r < reps; r++) {
    const pts = c.pts.map((p) => [p[0], p[1]]),
      cons = c.cons.map((e) => [e[0], e[1]]);
    const t0 = performance.now();
    fn(pts, cons);
    best = Math.min(best, performance.now() - t0);
  }
  return best;
};
console.log('\n  case            |    old |    new | speedup');
let gm = 0,
  gn = 0;
for (const name of [
  'contour-512-l3',
  'contour-1200-l3',
  'contour-3000-l7',
  'cloud-900',
  'cloud-2500',
]) {
  const c = corpus.find(([nm]) => nm === name)[1];
  const to = bench(old, c),
    tn = bench(fresh, c);
  gm += Math.log(to / tn);
  gn++;
  console.log(
    `  ${name.padEnd(15)} | ${to.toFixed(2).padStart(6)} | ${tn.toFixed(2).padStart(6)} |  ${(to / tn).toFixed(2)}x`,
  );
}
console.log(
  `\n  geomean speedup (full constrainedTriangulate, real Shewchuk predicates): ${Math.exp(gm / gn).toFixed(2)}x`,
);
console.log(
  '  NOTE: this is the WHOLE pipeline (delaunay + constraint recovery + Delaunay restore).',
);
console.log('  Only delaunay() was relaid out, and the robust predicates it calls are unchanged —');
console.log("  so this is the honest end-to-end number, not the isolated kernel's 3.0x.");
