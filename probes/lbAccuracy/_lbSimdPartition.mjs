// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _lbSimdPartition -- what reordering, PARTITIONING or de-diverging the heavy lanes could buy, on the lockstep SIMD model
// of _lbSimdCost, across both engines. Reads a fragment
// dump of _lbSimdCost (Loop-Blinn) or _cpSimdCost (CPatch): rows [entry, x, row, ops, kind, flavour, tri].
//
// Every variant keeps the model's packing -- 32 x 32 px tiles, eight 2 x 2 quads to a 32-lane group, a group within one
// tile and one draw entry (shape), a quad's helper lanes costed at its dearest lane -- and changes only which quads share
// a group, or how a quad splits:
//   asEmitted    the draw as submitted (= _lbSimdCost's lockstep)
//   partition@H  every primitive split along its cost class (heavy = ops > H), the heavy part submitted first: a quad the
//                split line crosses is shaded once per side, each with its own helper lanes (the partition's real cost).
//                The class is the fragment's own op count, so this is the IDEAL geometric partition at that threshold --
//                a partition built from geometry (a band around the arc) can only misclassify on top of it
//   idealEntry   every quad of a (tile, entry) sorted by cost: no reorder or partition within a shape does better
//   idealTile    sorted across the entries of a tile: the ceiling of separating shapes (it breaks paint order, so it
//                needs a depth claim to be exact)
//   floor        each group's MEAN lane cost instead of its dearest: no divergence left at all -- the ceiling of making
//                the heavy kernels' lanes do the same work
// Lockstep cost is ops x 32 per group, summed; every ratio is against asEmitted.
//
//   node probes/lbAccuracy/_lbSimdPartition.mjs frags.json [H,H,...]      (default H: the 50th/75th/90th ops percentiles)
import { readFileSync } from 'fs';
import path from 'path';

const frag = JSON.parse(readFileSync(process.argv[2], 'utf8'));
function quadsOf(fr, split) {
  const quads = new Map();
  for (const x of fr) {
    const cls = split ? split(x) : 0,
      qk = `${x[6]}:${cls}:${x[1] >> 1}:${x[2] >> 1}`;
    const q = quads.get(qk);
    if (q) {
      q.n++;
      q.sum += x[3];
      if (x[3] > q.c) q.c = x[3];
    } else
      quads.set(qk, {
        e: x[0],
        t: x[6],
        cls,
        qi: x[1] >> 1,
        qj: x[2] >> 1,
        c: x[3],
        sum: x[3],
        n: 1,
      });
  }
  return [...quads.values()];
}
function pack(arr, order, byTile = false) {
  arr.sort(order);
  let lock = 0,
    flo = 0,
    groups = 0,
    cur = null;
  const flush = () => {
    if (!cur) return;
    groups++;
    lock += cur.max;
    flo += cur.sum / cur.lanes;
    cur = null;
  };
  for (const q of arr) {
    const tile = byTile ? `${q.qi >> 4}:${q.qj >> 4}` : `${q.qi >> 4}:${q.qj >> 4}:${q.e}`;
    if (cur && (cur.tile !== tile || cur.n === 8)) flush();
    if (!cur) cur = { tile, n: 0, max: 0, sum: 0, lanes: 0 };
    cur.n++;
    cur.max = Math.max(cur.max, q.c);
    cur.sum += q.sum;
    cur.lanes += q.n;
  }
  flush();
  return { quads: arr.length, groups, lock: lock * 32, floor: flo * 32 };
}
const tileOf = (a, b) => (a.qj >> 4) - (b.qj >> 4) || (a.qi >> 4) - (b.qi >> 4);
const emitted = (a, b) =>
  tileOf(a, b) || a.e - b.e || a.cls - b.cls || a.t - b.t || a.qj - b.qj || a.qi - b.qi;
const ops = frag.map((x) => x[3]).sort((a, b) => a - b);
const pct = (p) => ops[Math.min(ops.length - 1, Math.floor(p * ops.length))];
const Hs = process.argv[3]
  ? process.argv[3].split(',').map(Number)
  : [pct(0.5), pct(0.75), pct(0.9)];
const out = [['asEmitted', pack(quadsOf(frag), emitted)]];
for (const H of Hs)
  out.push([
    `partition@${H}`,
    pack(
      quadsOf(frag, (x) => (x[3] > H ? 0 : 1)),
      emitted,
    ),
  ]);
out.push(['idealEntry', pack(quadsOf(frag), (a, b) => tileOf(a, b) || a.e - b.e || b.c - a.c)]);
out.push(['idealTile', pack(quadsOf(frag), (a, b) => tileOf(a, b) || b.c - a.c, true)]);
const base = out[0][1];
console.log(
  `${path.basename(process.argv[2])}: ${frag.length} fragments; ops per fragment p50 ${pct(0.5)} p75 ${pct(0.75)} p90 ${pct(0.9)} p99 ${pct(0.99)} max ${ops[ops.length - 1]}, mean ${(ops.reduce((a, b) => a + b, 0) / ops.length).toFixed(1)}`,
);
for (const [k, v] of out)
  console.log(
    `  ${k.padEnd(15)} quads ${String(v.quads).padStart(8)}  groups ${String(v.groups).padStart(7)}  lockstep ${(v.lock / 1e6).toFixed(2).padStart(8)} M  ${(v.lock / base.lock).toFixed(3)}x   floor ${(v.floor / base.lock).toFixed(3)}x`,
  );
