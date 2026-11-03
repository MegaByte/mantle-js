// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _lbSimdCost -- what the Loop-Blinn fill costs a GPU that shades in lockstep SIMD groups, from the shader text alone.
//
// No GPU. The unified fill draw runs through test/_lbPipeEmu.mjs in its ALU-counting mode (every fragment's own float
// operations, transcendentals weighted 4), and the fragments are then PACKED as a tiled GPU shades them: per 32 x 32 pixel
// tile, each draw entry's triangles in submission order, each triangle's covered 2 x 2 quads in raster order, eight
// consecutive quads (32 lanes) to a group, spanning the triangles of one entry and tile. A quad's uncovered pixels are
// helper lanes, costed at the quad's dearest real lane. A group runs in lockstep, so
//   lockstep    = its slowest quad's cost, and
//   serialized  = the sum, over the lbCoverage branches its lanes take (kind, and chain / ring flavour), of each
//                 branch's slowest -- a group whose lanes take two branches runs both,
// and the draw's cost is the sum over groups. The two bound what the hardware does.
//
// WHY. A mean operation count per fragment (_lbAluPerFrag) can under-predict a kernel change badly (1.13x on tiger and
// 1.02x on a star where the GPU measures 1.41x and 1.52-1.60x). A lane doing the exact cubic-chain or arc-ring work costs
// ~400 operations more than its neighbours, and its whole group waits for it. This lockstep model tracks the GPU on the
// same comparisons (tiger 512: 1.40x against 1.41x; the star 1.31-1.54x against 1.52-1.60x). Register pressure is not
// the cause (glslang -> spirv-opt SSA liveness: the program's peak is the stroke kernel's, 184 scalars).
//
//   node probes/lbAccuracy/_lbSimdCost.mjs [file.svg] [N=512] [OUT=frags.json]     one tree (HOOKS='__LB_X=false,...')
//   node probes/lbAccuracy/_lbSimdCost.mjs --compare base.json a.json [b.json ...]  ratios against a base run
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/// Pack fragments [entry, x, row, ops, kind, flavour, tri] into lockstep groups; returns totals in operations x lanes.
export function simdCost(frag) {
  const quads = new Map();
  for (const x of frag) {
    const qk = `${x[6]}:${x[1] >> 1}:${x[2] >> 1}`;
    const q = quads.get(qk);
    if (q) {
      if (x[3] > q.c) q.c = x[3];
    } else
      quads.set(qk, {
        e: x[0],
        t: x[6],
        qi: x[1] >> 1,
        qj: x[2] >> 1,
        c: x[3],
        b: `${x[4]}.${x[5]}`,
      });
  }
  const arr = [...quads.values()];
  arr.sort(
    (a, b) =>
      (a.qj >> 4) - (b.qj >> 4) ||
      (a.qi >> 4) - (b.qi >> 4) ||
      a.e - b.e ||
      a.t - b.t ||
      a.qj - b.qj ||
      a.qi - b.qi,
  );
  let lock = 0,
    ser = 0,
    groups = 0,
    cur = null;
  const flush = () => {
    if (!cur) return;
    groups++;
    lock += cur.max;
    let s = 0;
    for (const v of cur.per.values()) s += v;
    ser += s;
    cur = null;
  };
  for (const q of arr) {
    const tile = `${q.qi >> 4}:${q.qj >> 4}:${q.e}`;
    if (cur && (cur.tile !== tile || cur.n === 8)) flush();
    if (!cur) cur = { tile, n: 0, max: 0, per: new Map() };
    cur.n++;
    cur.max = Math.max(cur.max, q.c);
    cur.per.set(q.b, Math.max(cur.per.get(q.b) || 0, q.c));
  }
  flush();
  return {
    fragments: frag.length,
    quads: quads.size,
    groups,
    lockstep: lock * 32,
    serialized: ser * 32,
  };
}

const fmt = (c) =>
  `${c.fragments} fragments, ${c.quads} quads, ${c.groups} groups: lockstep ${(c.lockstep / 1e6).toFixed(2)} M, serialized ${(c.serialized / 1e6).toFixed(2)} M`;
const args = process.argv.slice(2);
if (args[0] === '--compare') {
  const [base, ...rest] = args
    .slice(1)
    .map((f) => [f, simdCost(JSON.parse(readFileSync(f, 'utf8')))]);
  console.log(`${path.basename(base[0])}: ${fmt(base[1])}`);
  for (const [f, c] of rest)
    console.log(
      `${path.basename(f)}: ${fmt(c)} -- ${(c.lockstep / base[1].lockstep).toFixed(3)}x / ${(c.serialized / base[1].serialized).toFixed(3)}x`,
    );
} else {
  const FILE = args[0] || path.join(ROOT, 'examples/tiger.svg'),
    N = +(args[1] || 512);
  const hooks = (process.env.HOOKS || '').split(',').filter(Boolean);
  if (hooks.length) {
    globalThis.__MANTLE_DEBUG__ = true;
    for (const h of hooks) {
      const [k, v] = h.split('=');
      globalThis[k] = v === 'false' ? false : v === 'true' ? true : +v;
    }
  }
  const { lbScene, renderScene } = await import(path.join(ROOT, 'test/_lbPipeScene.mjs'));
  const sc = await lbScene(readFileSync(FILE, 'utf8'), { N });
  const vt = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.vert.glsl'), 'utf8');
  const ft = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');
  const r = renderScene(sc, vt, ft, [], { alu: true });
  const o = (nm) => r.vert.outOff[r.vert.io.outs.findIndex((x) => x.name === nm)];
  const kO = o('vKind'),
    tO = o('vTC'),
    sO = o('vSeam');
  // flavour: an interior face's chain (1 straight or conic, 2 a cubic chain), a Bezout face's ring (3 one that carries its arc)
  const frag = [];
  for (let q = 0; q < r.recs.length / 9; q++) {
    const t = r.recs[q * 9] | 0,
      e = sc.entries[sc.entryOfTri[t]];
    if (!e || e.kind !== 'lb') continue;
    const f = r.recs[q * 9 + 8],
      b = (t * 3 + 2) * r.vert.outN,
      k = Math.round(r.vOut[b + kO]);
    const fl =
      k === 0 ? (r.vOut[b + tO] > 3.5 ? 2 : 1) : k === 4 ? (r.vOut[b + sO] > 9.5 ? 3 : 0) : 0;
    frag.push([
      sc.entryOfTri[t],
      r.recs[q * 9 + 1] | 0,
      r.recs[q * 9 + 2] | 0,
      (f % 65536) + 4 * Math.floor(f / 65536),
      k,
      fl,
      t,
    ]);
  }
  if (args[2]) writeFileSync(args[2], JSON.stringify(frag));
  console.log(
    `${path.basename(FILE)} @ ${N}${hooks.length ? ' ' + hooks.join(' ') : ''}: ${fmt(simdCost(frag))}`,
  );
}
